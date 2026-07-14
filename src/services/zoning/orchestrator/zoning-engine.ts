// The universal zoning lookup engine — orchestrates the discover-once / verify /
// cache / reuse runtime loop.
//
//   address -> geocode -> jurisdiction -> registry.get(key)
//     HIT  -> query the recorded ArcGIS layers directly (fast path)
//     MISS -> discover -> inspect -> save record -> query (then all later
//             lookups in this jurisdiction reuse the record)
//
// Deterministic GIS queries decide the zoning code; search/AI only locate the
// source. One failed stage never fails the whole lookup — errors are collected.

import {
  ZoningLookupInputSchema,
  type ZoningLookupInput,
  type UniversalZoningResult,
  type GeocodedAddress,
  type JurisdictionResult,
  type InspectedZoningSource,
  type DiscoveredSource,
  type StageError,
  type ZoningResultStatus,
  type Geocoder,
  type SourceRegistry,
  type Logger,
  type AdapterContext,
} from '../types';
import { resolveJurisdiction } from '../jurisdiction';
import { layerForRole } from '../arcgis';
import { selectAdapter, adapterForSourceType } from '../adapters';
import { fetchJson } from '../utils/http';
import { normalizeZoning } from '../normalization/zoning-normalizer';
import { computeConfidence } from '../confidence/confidence-calculator';
import { jurisdictionKey, CACHE_TTL } from '../registry';
import type { SourceDiscoveryService } from '../discovery';
import { recordFromInspected, inspectedFromRecord } from './record-mapper';

export type LookupMode = 'fast' | 'verified' | 'deep';

export interface ZoningEngineDeps {
  geocoder: Geocoder;
  registry: SourceRegistry;
  discovery: SourceDiscoveryService;
  log?: Logger;
}

const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export class ZoningLookupEngine {
  private readonly geocoder: Geocoder;
  private readonly registry: SourceRegistry;
  private readonly discovery: SourceDiscoveryService;
  private readonly log: Logger;

  constructor(deps: ZoningEngineDeps) {
    this.geocoder = deps.geocoder;
    this.registry = deps.registry;
    this.discovery = deps.discovery;
    this.log = deps.log ?? noopLog;
  }

  async lookup(rawInput: ZoningLookupInput): Promise<UniversalZoningResult> {
    const errors: StageError[] = [];
    const parsed = ZoningLookupInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return errorResult(rawInput, 'input-validation', parsed.error.issues.map((i) => i.message).join('; '));
    }
    const input = parsed.data;
    const mode: LookupMode = input.mode ?? 'verified';

    // 1) Geocode (or use supplied coordinates).
    let address: GeocodedAddress | null = null;
    try {
      address = await this.geocode(input);
    } catch (err) {
      errors.push({ stage: 'geocoding', message: String(err instanceof Error ? err.message : err), recoverable: false });
    }
    if (!address) {
      return {
        ...baseResult(input),
        errors,
        status: 'not-found',
      };
    }

    // 2) Resolve jurisdiction (geometry-confirmed unless fast mode).
    const jurisdiction = await this.resolveJurisdictionCached(address, mode).catch((err) => {
      errors.push({ stage: 'jurisdiction-resolution', message: String(err), recoverable: true });
      return fallbackJurisdiction(address);
    });

    // 3) Resolve the GIS source: registry first, discovery on miss.
    const ctx: AdapterContext = {
      fetchJson: (url, signal) => fetchJson(url, { signal }),
      log: this.log,
    };
    let inspected: InspectedZoningSource | null = null;
    let discoveredSource: DiscoveredSource | null = null;
    let fromRegistry = false;
    try {
      const resolved = await this.resolveSource(jurisdiction, input, errors, ctx);
      inspected = resolved.inspected;
      discoveredSource = resolved.discoveredSource;
      fromRegistry = resolved.fromRegistry;
    } catch (err) {
      errors.push({ stage: 'source-discovery', message: String(err instanceof Error ? err.message : err), recoverable: true });
    }

    // 4) Query zoning + overlays deterministically, via the source's adapter.
    const wantOverlays = input.includeOverlays !== false;
    let normalized = normalizeZoning([], []);
    if (inspected) {
      const adapter = adapterForSourceType(inspected.sourceType) ?? selectAdapter(inspected.source);
      if (!adapter) {
        errors.push({ stage: 'zoning-query', message: `no adapter for source type ${inspected.sourceType}`, recoverable: true });
      } else {
        try {
          const matches = await adapter.query(
            inspected,
            {
              longitude: address.longitude,
              latitude: address.latitude,
              includeGeometry: input.includeGeometry,
              jurisdictionHint: jurisdiction.municipality ?? jurisdiction.county ?? undefined,
              roles: wantOverlays ? ['zoning', 'overlay'] : ['zoning'],
            },
            ctx,
          );
          normalized = normalizeZoning(matches, inspected.layers);
        } catch (err) {
          errors.push({ stage: 'zoning-query', message: String(err instanceof Error ? err.message : err), recoverable: true });
        }
      }
    }

    // 5) Confidence + status.
    const confidence = computeConfidence({
      address,
      jurisdiction,
      parcel: null,
      zoningFound: normalized.zoning.found,
      zoningMatchQuality: normalized.zoning.found ? 'geocode-point' : 'none',
      source: discoveredSource,
      sourceFromRegistry: fromRegistry,
    });
    const status = deriveStatus(normalized.zoning.found, !!inspected, confidence.overall, confidence.warnings.length);

    return {
      input,
      address,
      jurisdiction,
      parcel: null,
      zoning: {
        ...normalized.zoning,
        jurisdiction: jurisdiction.zoningAuthority,
        jurisdictionType: jurisdiction.jurisdictionType,
        coveragePercent: normalized.zoning.found && !normalized.zoning.splitZoned ? 100 : null,
      },
      overlays: normalized.overlays,
      source: inspected
        ? {
            sourceType: inspected.sourceType,
            official: discoveredSource?.official ?? true,
            agency: jurisdiction.zoningAuthority,
            serviceUrl: inspected.serviceUrl,
            layerUrl: layerForRole(inspected, 'zoning')?.layerUrl ?? null,
            metadataUrl: inspected.metadataUrl,
            discoveredFrom: discoveredSource?.discoveredFrom ?? ['registry'],
            accessedAt: inspected.accessedAt,
          }
        : null,
      confidence,
      status,
      errors,
      rawSources: normalized.zoning.rawAttributes ? [normalized.zoning.rawAttributes] : [],
    };
  }

  // --- stages --------------------------------------------------------------

  private async geocode(input: ZoningLookupInput): Promise<GeocodedAddress> {
    if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
      const reversed = await this.geocoder
        .reverseGeocode(input.latitude, input.longitude)
        .catch(() => null);
      return (
        reversed ?? {
          inputAddress: input.address,
          formattedAddress: input.address,
          latitude: input.latitude,
          longitude: input.longitude,
          provider: 'input',
          raw: null,
        }
      );
    }
    const cacheKey = input.address.trim().toLowerCase();
    if (!input.forceRefresh) {
      const cached = await this.registry.cacheGet<GeocodedAddress>('geocode', cacheKey);
      if (cached) return cached;
    }
    const result = await this.geocoder.geocode(input.address);
    await this.registry.cacheSet('geocode', cacheKey, result, CACHE_TTL.geocoding);
    return result;
  }

  private async resolveJurisdictionCached(address: GeocodedAddress, mode: LookupMode): Promise<JurisdictionResult> {
    const key = `${address.latitude.toFixed(5)},${address.longitude.toFixed(5)}`;
    const cached = await this.registry.cacheGet<JurisdictionResult>('jurisdiction', key);
    if (cached) return cached;
    const result = await resolveJurisdiction(address, { boundaryLookup: mode !== 'fast' });
    await this.registry.cacheSet('jurisdiction', key, result, CACHE_TTL.jurisdiction);
    return result;
  }

  private async resolveSource(
    jurisdiction: JurisdictionResult,
    input: ZoningLookupInput,
    errors: StageError[],
    ctx: AdapterContext,
  ): Promise<{ inspected: InspectedZoningSource | null; discoveredSource: DiscoveredSource | null; fromRegistry: boolean }> {
    const key = jurisdictionKey({
      country: 'US',
      stateCode: jurisdiction.stateCode,
      county: jurisdiction.county,
      municipality: jurisdiction.municipality,
      jurisdictionType: jurisdiction.jurisdictionType,
    });

    // Registry-first (fast path).
    if (!input.forceRefresh) {
      const record = await this.registry.get(key).catch(() => null);
      if (record && record.zoningLayers.length > 0) {
        this.log.debug('registry hit', { key });
        return { inspected: inspectedFromRecord(record), discoveredSource: recordSource(record.serviceUrl), fromRegistry: true };
      }
    }

    // Discovery (slow path) — only on miss / forced refresh. Each candidate is
    // inspected via the adapter that handles its source family (ArcGIS, GeoJSON,
    // …); the first that yields a base-zoning layer is saved and reused.
    if (input.discoverSources === false) {
      return { inspected: null, discoveredSource: null, fromRegistry: false };
    }
    const candidates = await this.discovery.discover(jurisdiction, {
      allowThirdParty: input.allowThirdParty,
      log: this.log,
    });
    for (const candidate of candidates.slice(0, 5)) {
      const adapter = selectAdapter(candidate);
      if (!adapter) continue;
      try {
        const inspected = await adapter.inspect(candidate, ctx);
        if (layerForRole(inspected, 'zoning')) {
          const record = recordFromInspected(jurisdiction, inspected);
          await this.registry.put(record).catch((err) => errors.push({ stage: 'registry', message: String(err), recoverable: true }));
          this.log.info('discovered + saved source', { key, service: inspected.serviceUrl });
          return { inspected, discoveredSource: candidate, fromRegistry: false };
        }
      } catch (err) {
        errors.push({ stage: 'source-inspection', message: `${candidate.url}: ${String(err instanceof Error ? err.message : err)}`, recoverable: true });
      }
    }
    return { inspected: null, discoveredSource: candidates[0] ?? null, fromRegistry: false };
  }
}

// --- helpers ---------------------------------------------------------------

function recordSource(serviceUrl: string): DiscoveredSource {
  return { url: serviceUrl, sourceType: /\/FeatureServer\b/i.test(serviceUrl) ? 'arcgis-featureserver' : 'arcgis-mapserver', official: true, agency: null, discoveredFrom: ['registry'] };
}

function fallbackJurisdiction(address: GeocodedAddress): JurisdictionResult {
  return {
    state: address.state ?? null,
    stateCode: address.stateCode ?? null,
    county: address.county ?? null,
    municipality: address.municipality ?? null,
    incorporated: null,
    zoningAuthority: address.municipality ?? address.county ?? null,
    jurisdictionType: 'unknown',
    confidence: 20,
    evidence: [],
  };
}

function deriveStatus(zoningFound: boolean, hasSource: boolean, overall: number, warningCount: number): ZoningResultStatus {
  if (!zoningFound) return hasSource ? 'manual-review-required' : 'not-found';
  if (overall >= 85 && warningCount === 0) return 'verified';
  if (overall >= 65) return 'verified-with-warnings';
  return 'possible-match';
}

function baseResult(input: ZoningLookupInput): UniversalZoningResult {
  return {
    input,
    address: null,
    jurisdiction: {
      state: null, stateCode: null, county: null, municipality: null, incorporated: null,
      zoningAuthority: null, jurisdictionType: 'unknown', confidence: 0, evidence: [],
    },
    parcel: null,
    zoning: { found: false, code: null, description: null, jurisdiction: null, jurisdictionType: null, layerName: null, layerId: null, splitZoned: false, coveragePercent: null, additionalDistricts: [], rawAttributes: null },
    overlays: [],
    source: null,
    confidence: { overall: 0, addressMatch: 0, jurisdictionMatch: 0, parcelMatch: 0, zoningMatch: 0, sourceAuthority: 0, reasons: [], warnings: [] },
    status: 'error',
    errors: [],
    rawSources: [],
  };
}

function errorResult(input: ZoningLookupInput, stage: StageError['stage'], message: string): UniversalZoningResult {
  return { ...baseResult(input), status: 'error', errors: [{ stage, message, recoverable: false }] };
}
