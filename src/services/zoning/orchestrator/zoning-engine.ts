// Registry-only live zoning orchestration.
// address -> geocode -> jurisdiction -> verified source -> parcel -> zoning.
// Discovery, crawling, browser automation, and AI are maintenance-only paths.

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
  type JurisdictionSourceRecord,
  type ParcelResult,
} from '../types';
import { resolveJurisdiction } from '../jurisdiction';
import { layerForRole } from '../arcgis';
import { selectAdapter, adapterForSourceType } from '../adapters';
import { fetchJson } from '../utils/http';
import { normalizeZoning } from '../normalization/zoning-normalizer';
import { computeConfidence } from '../confidence/confidence-calculator';
import { jurisdictionKey, CACHE_TTL } from '../registry';
import { inspectedFromRecord } from './record-mapper';
import { lookupParcel } from '../parcel';
import { queryZoningForParcel } from '../geometry';
import type { MultiPolygon, Polygon } from 'geojson';

export type LookupMode = 'fast' | 'verified' | 'deep';

export interface ZoningEngineDeps {
  geocoder: Geocoder;
  registry: SourceRegistry;
  jurisdictionResolver?: (address: GeocodedAddress, mode: LookupMode) => Promise<JurisdictionResult>;
  log?: Logger;
}

const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export class ZoningLookupEngine {
  private readonly geocoder: Geocoder;
  private readonly registry: SourceRegistry;
  private readonly jurisdictionResolver?: ZoningEngineDeps['jurisdictionResolver'];
  private readonly log: Logger;

  constructor(deps: ZoningEngineDeps) {
    this.geocoder = deps.geocoder;
    this.registry = deps.registry;
    this.jurisdictionResolver = deps.jurisdictionResolver;
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

    if (address.stateCode && !['NC', 'SC'].includes(address.stateCode.toUpperCase())) {
      return {
        ...baseResult(input),
        address,
        status: 'error',
        errors: [{ stage: 'input-validation', message: 'Address must be in North Carolina or South Carolina', recoverable: false }],
      };
    }

    // 2) Resolve jurisdiction (geometry-confirmed unless fast mode).
    const jurisdiction = await this.resolveJurisdictionCached(address, mode).catch((err) => {
      errors.push({ stage: 'jurisdiction-resolution', message: String(err), recoverable: true });
      return fallbackJurisdiction(address);
    });

    // 3) Resolve a previously verified GIS source. A miss remains a miss; live
    // requests never search, crawl, inspect viewers, or invoke AI.
    const ctx: AdapterContext = {
      fetchJson: (url, signal) => fetchJson(url, { signal }),
      log: this.log,
    };
    let inspected: InspectedZoningSource | null = null;
    let discoveredSource: DiscoveredSource | null = null;
    let sourceRecord: JurisdictionSourceRecord | null = null;
    try {
      const resolved = await this.resolveSource(jurisdiction);
      inspected = resolved.inspected;
      discoveredSource = resolved.discoveredSource;
      sourceRecord = resolved.record;
    } catch (err) {
      errors.push({ stage: 'registry', message: String(err instanceof Error ? err.message : err), recoverable: true });
    }

    // 4) Locate an official parcel and move the zoning query to an interior
    // point. Deep/verified lookups also intersect the full parcel polygon.
    let parcel: ParcelResult | null = null;
    if (sourceRecord?.parcelLayers[0] && input.includeParcel !== false) {
      try {
        parcel = await lookupParcel(
          sourceRecord.parcelLayers[0],
          {
            longitude: address.longitude,
            latitude: address.latitude,
            address: address.formattedAddress || input.address,
            parcelId: input.parcelId,
          },
          { timeoutMs: mode === 'fast' ? 3_500 : 5_000 },
        );
      } catch (err) {
        errors.push({ stage: 'parcel-query', message: String(err instanceof Error ? err.message : err), recoverable: true });
      }
    }

    // 5) Query zoning + overlays deterministically from the saved layer IDs.
    const wantOverlays = input.includeOverlays !== false;
    let normalized = normalizeZoning([], []);
    let zoningMatchQuality: 'parcel-polygon-intersect' | 'interior-point' | 'geocode-point' | 'none' = 'none';
    let coverageByCode = new Map<string, number>();
    if (inspected) {
      const adapter = adapterForSourceType(inspected.sourceType) ?? selectAdapter(inspected.source);
      if (!adapter) {
        errors.push({ stage: 'zoning-query', message: `no adapter for source type ${inspected.sourceType}`, recoverable: true });
      } else {
        try {
          const parcelGeometry = parcel?.geometry;
          if (parcelGeometry && (parcelGeometry.type === 'Polygon' || parcelGeometry.type === 'MultiPolygon')) {
            const parcelQuery = await queryZoningForParcel(
              inspected,
              parcelGeometry as Polygon | MultiPolygon,
              wantOverlays,
            );
            for (const message of parcelQuery.errors) {
              errors.push({ stage: 'geometry-processing', message, recoverable: true });
            }
            if (parcelQuery.matches.length > 0) {
              normalized = normalizeZoning(parcelQuery.matches, inspected.layers);
              coverageByCode = parcelQuery.coverageByCode;
              if (normalized.zoning.found) zoningMatchQuality = 'parcel-polygon-intersect';
            }
          }

          if (!normalized.zoning.found) {
            const queryPoint = parcel?.interiorPoint ?? { longitude: address.longitude, latitude: address.latitude };
            const matches = await adapter.query(
              inspected,
              {
                longitude: queryPoint.longitude,
                latitude: queryPoint.latitude,
                includeGeometry: input.includeGeometry,
                jurisdictionHint: jurisdiction.municipality ?? jurisdiction.county ?? undefined,
                roles: wantOverlays ? ['zoning', 'overlay'] : ['zoning'],
              },
              ctx,
            );
            normalized = normalizeZoning(matches, inspected.layers);
            if (normalized.zoning.found) zoningMatchQuality = parcel?.interiorPoint ? 'interior-point' : 'geocode-point';
          }
        } catch (err) {
          errors.push({ stage: 'zoning-query', message: String(err instanceof Error ? err.message : err), recoverable: true });
        }
      }
    }

    // 6) Confidence + status.
    const confidence = computeConfidence({
      address,
      jurisdiction,
      parcel,
      zoningFound: normalized.zoning.found,
      zoningMatchQuality,
      source: discoveredSource,
      sourceFromRegistry: !!sourceRecord,
    });
    const status = deriveStatus(
      normalized.zoning.found,
      confidence.overall,
      confidence.warnings.length,
      jurisdiction.jurisdictionType,
    );
    const primaryCoverage = normalized.zoning.code
      ? roundedCoverage(coverageByCode.get(normalized.zoning.code.toUpperCase()))
      : null;
    const additionalDistricts = normalized.zoning.additionalDistricts.map((district) => ({
      ...district,
      coveragePercent: district.code ? roundedCoverage(coverageByCode.get(district.code.toUpperCase())) : null,
    }));
    const resultParcel = parcel ? sanitizeParcel(parcel, input.includeGeometry === true) : null;

    return {
      input,
      address,
      jurisdiction,
      parcel: resultParcel,
      zoning: {
        ...normalized.zoning,
        jurisdiction: jurisdiction.zoningAuthority,
        jurisdictionType: jurisdiction.jurisdictionType,
        splitZoned: additionalDistricts.length > 0,
        coveragePercent: primaryCoverage,
        additionalDistricts,
      },
      overlays: normalized.overlays,
      source: inspected
        ? {
            sourceType: inspected.sourceType,
            official: discoveredSource?.official ?? true,
            agency: discoveredSource?.agency ?? sourceRecord?.agencyName ?? jurisdiction.zoningAuthority,
            serviceUrl: inspected.serviceUrl,
            layerUrl: layerForRole(inspected, 'zoning')?.layerUrl ?? null,
            metadataUrl: inspected.metadataUrl,
            discoveredFrom: discoveredSource?.discoveredFrom ?? ['registry'],
            accessedAt: new Date().toISOString(),
            lastValidatedAt: sourceRecord?.lastVerifiedAt ?? null,
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
    const result = this.jurisdictionResolver
      ? await this.jurisdictionResolver(address, mode)
      : await resolveJurisdiction(address, { boundaryLookup: mode !== 'fast' });
    await this.registry.cacheSet('jurisdiction', key, result, CACHE_TTL.jurisdiction);
    return result;
  }

  private async resolveSource(
    jurisdiction: JurisdictionResult,
  ): Promise<{
    inspected: InspectedZoningSource | null;
    discoveredSource: DiscoveredSource | null;
    record: JurisdictionSourceRecord | null;
  }> {
    const key = jurisdictionKey({
      country: 'US',
      stateCode: jurisdiction.stateCode,
      county: jurisdiction.county,
      municipality: jurisdiction.municipality,
      jurisdictionType: jurisdiction.jurisdictionType,
    });

    const record = await this.registry.get(key);
    if (!record) {
      this.log.info('verified source registry miss', { key });
      return { inspected: null, discoveredSource: null, record: null };
    }
    this.log.debug('verified source registry hit', { key, health: record.healthStatus });
    const queryable = record.zoningLayers.length > 0 && record.healthStatus !== 'broken';
    return {
      inspected: queryable ? inspectedFromRecord(record) : null,
      discoveredSource: queryable ? recordSource(record) : null,
      record,
    };
  }
}

// --- helpers ---------------------------------------------------------------

function recordSource(record: JurisdictionSourceRecord): DiscoveredSource {
  return {
    url: record.serviceUrl,
    sourceType: record.sourceType as DiscoveredSource['sourceType'],
    official: true,
    agency: record.agencyName,
    discoveredFrom: ['verified PostgreSQL source registry'],
  };
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

function deriveStatus(
  zoningFound: boolean,
  overall: number,
  warningCount: number,
  jurisdictionType: JurisdictionResult['jurisdictionType'],
): ZoningResultStatus {
  if (jurisdictionType === 'no-zoning') return 'no-zoning';
  if (!zoningFound) return 'manual-review-required';
  if (overall >= 85 && warningCount === 0) return 'verified';
  if (overall >= 65) return 'verified-with-warnings';
  return 'possible-match';
}

function roundedCoverage(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value * 10) / 10;
}

function sanitizeParcel(parcel: ParcelResult, includeGeometry: boolean): ParcelResult {
  const sanitized = { ...parcel };
  delete sanitized.rawAttributes;
  if (!includeGeometry) delete sanitized.geometry;
  return sanitized;
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
