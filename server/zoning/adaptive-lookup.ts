import { selectAdapter } from '../../src/services/zoning/adapters';
import {
  SourceDiscoveryService,
  httpPageFetcher,
  perplexitySearchProvider,
  searchOfficialArcgisPortal,
} from '../../src/services/zoning/discovery';
import { normalizeZoning } from '../../src/services/zoning/normalization/zoning-normalizer';
import { recordFromInspected } from '../../src/services/zoning/orchestrator/record-mapper';
import { fetchJson } from '../../src/services/zoning/utils/http';
import type {
  DiscoveredSource,
  GeocodedAddress,
  InspectedZoningSource,
  JurisdictionResult,
  Logger,
  SourceRegistry,
  UniversalZoningResult,
  ZoningLookupInput,
} from '../../src/services/zoning/types';
import type { ZoningLookupEngine } from '../../src/services/zoning/orchestrator';
import type { ZoningServerConfig } from './config';

export interface CheckedSource {
  url: string;
  official: boolean;
  stage: 'discovery' | 'inspection' | 'point_query';
  status: 'candidate' | 'rejected' | 'verified' | 'failed';
  reason?: string;
}

export interface AdaptiveLookupOutcome {
  result: UniversalZoningResult;
  sourcesChecked: CheckedSource[];
  discoveryAttempted: boolean;
  officialPageUrl: string | null;
  browserFallbackUsed?: boolean;
}

export type CandidateDiscovery = (
  jurisdiction: JurisdictionResult,
  signal: AbortSignal,
  useBrowser: boolean,
) => Promise<DiscoveredSource[]>;

interface AdaptiveLookupDependencies {
  engine: ZoningLookupEngine;
  registry: SourceRegistry;
  config: Pick<ZoningServerConfig, 'perplexityApiKey' | 'perplexitySearchEndpoint'>;
  log?: Logger;
  discover?: CandidateDiscovery;
}

const noopLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const INVALID_CODE = /^(?:n\/?a|none|unknown|unavailable|unresolved|not published|not found|unzoned|official map review|zoning code unresolved)$/i;

function uniqueOfficialSources(groups: DiscoveredSource[][]): DiscoveredSource[] {
  const sources = new Map<string, DiscoveredSource>();
  for (const source of groups.flat()) {
    if (!source.official || !/\/(?:MapServer|FeatureServer)\b/i.test(source.url)) continue;
    const key = source.url.replace(/\/$/, '').toLowerCase();
    const existing = sources.get(key);
    if (existing) {
      existing.discoveredFrom = [...new Set([...existing.discoveredFrom, ...source.discoveredFrom])];
      continue;
    }
    sources.set(key, source);
  }
  return [...sources.values()].slice(0, 12);
}

async function browserPageFetcher(url: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return '';
  const direct = await httpPageFetcher(5_000)(url, signal);
  if (/\/(?:MapServer|FeatureServer)\b/i.test(direct)) return direct;
  const { inspectDynamicViewer } = await import('./browser-discovery');
  const browserEvidence = await inspectDynamicViewer(url).catch(() => '');
  return `${direct}\n${browserEvidence}`;
}

function defaultDiscovery(config: AdaptiveLookupDependencies['config']): CandidateDiscovery {
  return async (jurisdiction, signal, useBrowser) => {
    const portalPromise = searchOfficialArcgisPortal(jurisdiction, { signal, maxResults: 12 });
    if (!config.perplexityApiKey) return uniqueOfficialSources([await portalPromise]);

    const search = perplexitySearchProvider({
      apiKey: config.perplexityApiKey,
      endpoint: config.perplexitySearchEndpoint,
      maxResultsPerQuery: 5,
      timeoutMs: 7_000,
    });
    const directDiscovery = new SourceDiscoveryService(search, httpPageFetcher(5_000));
    const directPromise = directDiscovery.discover(jurisdiction, {
      maxCandidatePages: 3,
      signal,
    });
    const directSources = uniqueOfficialSources(await Promise.all([portalPromise, directPromise]));
    if (directSources.length > 0 || !useBrowser || signal.aborted) return directSources;

    const browserDiscovery = new SourceDiscoveryService(search, (url) => browserPageFetcher(url, signal));
    const browserSources = (await browserDiscovery.discover(jurisdiction, {
      maxCandidatePages: 1,
      signal,
    })).map((source) => ({ ...source, browserFallback: true }));
    return uniqueOfficialSources([directSources, browserSources]);
  };
}

async function inspectAndProve(
  candidate: DiscoveredSource,
  address: GeocodedAddress,
  jurisdiction: JurisdictionResult,
  signal: AbortSignal,
  log: Logger,
): Promise<{ inspected: InspectedZoningSource; code: string } | null> {
  if (!candidate.official) return null;
  const adapter = selectAdapter(candidate);
  if (!adapter) return null;
  const inspected = await adapter.inspect(candidate, {
    signal,
    fetchJson: (url, requestSignal) => fetchJson(url, { signal: requestSignal }),
    log,
  });
  const eligibleLayers = inspected.layers.filter((layer) =>
    layer.role === 'zoning'
    && layer.supportsQuery
    && /polygon/i.test(layer.geometryType ?? '')
    && layer.roleConfidence >= 0.65
    && !!layer.fieldMapping.zoningCodeField,
  );
  if (eligibleLayers.length === 0) return null;
  const queryable: InspectedZoningSource = {
    ...inspected,
    layers: inspected.layers.filter((layer) => layer.role !== 'zoning' || eligibleLayers.includes(layer)),
  };
  const matches = await adapter.query(queryable, {
    longitude: address.longitude,
    latitude: address.latitude,
    jurisdictionHint: jurisdiction.zoningAuthority ?? jurisdiction.municipality ?? jurisdiction.county ?? undefined,
    roles: ['zoning'],
  }, {
    signal,
    fetchJson: (url, requestSignal) => fetchJson(url, { signal: requestSignal }),
    log,
  });
  const normalized = normalizeZoning(matches, queryable.layers).zoning;
  if (!normalized.found || !normalized.code || INVALID_CODE.test(normalized.code)) return null;
  const selectedLayer = queryable.layers.find((layer) => String(layer.id) === String(normalized.layerId));
  if (!selectedLayer) return null;
  return {
    inspected: {
      ...queryable,
      layers: queryable.layers.filter((layer) => layer.role !== 'zoning' || layer === selectedLayer),
    },
    code: normalized.code,
  };
}

export class AdaptiveZoningLookupService {
  private readonly engine: ZoningLookupEngine;
  private readonly registry: SourceRegistry;
  private readonly discover: CandidateDiscovery;
  private readonly log: Logger;

  constructor(dependencies: AdaptiveLookupDependencies) {
    this.engine = dependencies.engine;
    this.registry = dependencies.registry;
    this.discover = dependencies.discover ?? defaultDiscovery(dependencies.config);
    this.log = dependencies.log ?? noopLog;
  }

  async lookup(input: ZoningLookupInput): Promise<AdaptiveLookupOutcome> {
    const overallStartedAt = performance.now();
    const initial = await this.engine.lookup(input);
    if (initial.zoning.found || initial.status !== 'manual-review-required' || !initial.address) {
      return { result: initial, sourcesChecked: [], discoveryAttempted: false, officialPageUrl: initial.source?.metadataUrl ?? null, browserFallbackUsed: false };
    }

    const sourcesChecked: CheckedSource[] = [];
    const useBrowser = input.mode === 'deep';
    const totalBudgetMs = useBrowser ? 29_000 : 9_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Adaptive zoning lookup deadline exceeded')), totalBudgetMs);
    let discoveryMs: number;
    let inspectionMs = 0;
    let officialPageUrl: string | null = null;
    try {
      const discoveryStartedAt = performance.now();
      const candidates = await this.discover(initial.jurisdiction, controller.signal, useBrowser).catch((error) => {
        this.log.warn('official zoning discovery failed', { error: String(error) });
        return [];
      });
      discoveryMs = performance.now() - discoveryStartedAt;
      for (const candidate of candidates) {
        sourcesChecked.push({ url: candidate.url, official: candidate.official, stage: 'discovery', status: 'candidate', reason: candidate.officialReason });
      }

      for (let index = 0; index < candidates.length && !controller.signal.aborted; index += 3) {
        const batch = candidates.slice(index, index + 3);
        const inspectionStartedAt = performance.now();
        const proofs = await Promise.all(batch.map(async (candidate) => {
          try {
            const proof = await inspectAndProve(candidate, initial.address as GeocodedAddress, initial.jurisdiction, controller.signal, this.log);
            sourcesChecked.push({
              url: candidate.url,
              official: candidate.official,
              stage: proof ? 'point_query' : 'inspection',
              status: proof ? 'verified' : 'rejected',
              reason: proof ? `Official current-zoning polygon returned code ${proof.code}` : 'No current zoning code intersected the address point',
            });
            return proof ? { candidate, proof } : null;
          } catch (error) {
            sourcesChecked.push({ url: candidate.url, official: candidate.official, stage: 'inspection', status: 'failed', reason: String(error) });
            return null;
          }
        }));
        inspectionMs += performance.now() - inspectionStartedAt;
        const winner = proofs.find((proof) => proof !== null);
        if (!winner) continue;

        const record = recordFromInspected(initial.jurisdiction, winner.proof.inspected);
        record.lastSuccessfulQueryAt = new Date().toISOString();
        record.healthStatus = 'healthy';
        await this.registry.put(record);
        officialPageUrl = winner.candidate.officialPageUrl ?? winner.proof.inspected.metadataUrl;
        const verified = await this.engine.lookup({ ...input, forceRefresh: false });
        verified.diagnostics.timings.discoveryMs = Math.round(discoveryMs * 100) / 100;
        verified.diagnostics.timings.arcgisInspectionMs = Math.round(inspectionMs * 100) / 100;
        verified.diagnostics.timings.totalMs = Math.round((performance.now() - overallStartedAt) * 100) / 100;
        verified.diagnostics.registryHit = true;
        return { result: verified, sourcesChecked, discoveryAttempted: true, officialPageUrl, browserFallbackUsed: winner.candidate.browserFallback === true };
      }
    } finally {
      clearTimeout(timeout);
    }

    initial.diagnostics.timings.discoveryMs = Math.round(discoveryMs * 100) / 100;
    initial.diagnostics.timings.arcgisInspectionMs = Math.round(inspectionMs * 100) / 100;
    initial.diagnostics.timings.totalMs = Math.round((performance.now() - overallStartedAt) * 100) / 100;
    return { result: initial, sourcesChecked, discoveryAttempted: true, officialPageUrl, browserFallbackUsed: false };
  }
}
