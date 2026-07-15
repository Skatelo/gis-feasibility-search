import type { UniversalZoningResult } from './zoning/types';

export interface OfficialZoningLookupInput {
  address: string;
  latitude: number;
  longitude: number;
  parcelId?: string;
}

export interface OfficialZoningLookupResult {
  status: 'verified' | 'no_zoning' | 'manual_review' | 'not_found' | 'error';
  code: string | null;
  description: string | null;
  jurisdiction: string | null;
  sourceUrl: string | null;
  sources: string[];
  splitZoned: boolean;
  additionalDistricts: Array<{ code: string | null; coveragePercent: number | null }>;
  confidence: number;
  reason?: string;
}

interface ApiZoningResult {
  success?: boolean;
  status?: string;
  reason?: string;
  jurisdiction?: { zoningAuthority?: string | null; authority?: string | null };
  baseZoning?: {
    localCode?: string | null;
    localName?: string | null;
    additionalDistricts?: Array<{ code?: string | null; coveragePercent?: number | null }>;
  } | null;
  parcel?: { splitZoned?: boolean } | null;
  confidence?: { score?: number };
  sources?: Array<{ layerUrl?: string | null }>;
  zoning?: {
    code?: string | null;
    name?: string | null;
    split_zoned?: boolean;
    additional_districts?: Array<{ code?: string | null; coveragePercent?: number | null; coverage_percent?: number | null }>;
  } | null;
  source?: { layer_url?: string | null; service_url?: string | null; authority?: string | null };
  verification?: { status?: string; confidence?: number; warnings?: string[] };
}

type LocalEngine = Awaited<ReturnType<typeof buildLocalEngine>>;
let localEnginePromise: Promise<LocalEngine> | null = null;

async function buildLocalEngine() {
  const [{ createZoningEngine }, { createInMemoryRegistry, seedInitialSourceRecords }] = await Promise.all([
    import('./zoning'),
    import('./zoning/registry'),
  ]);
  const registry = createInMemoryRegistry();
  await seedInitialSourceRecords(registry);
  return createZoningEngine({ registry });
}

function localEngine(): Promise<LocalEngine> {
  localEnginePromise ??= buildLocalEngine();
  return localEnginePromise;
}

function normalizeStatus(status: string): OfficialZoningLookupResult['status'] {
  if (status === 'verified' || status === 'verified-with-warnings' || status === 'possible-match' || status === 'verified_official' || status === 'official_but_ambiguous') return 'verified';
  if (status === 'no_zoning' || status === 'no-zoning') return 'no_zoning';
  if (status === 'manual_review' || status === 'manual-review-required') return 'manual_review';
  if (status === 'not_found' || status === 'not-found') return 'not_found';
  return 'error';
}

function fromApi(result: ApiZoningResult): OfficialZoningLookupResult {
  if (typeof result.success === 'boolean') {
    const sourceUrl = result.source?.layer_url ?? result.source?.service_url ?? null;
    const status = normalizeStatus(result.verification?.status ?? (result.success ? 'verified_official' : 'manual_review_required'));
    return {
      status,
      code: result.zoning?.code ?? null,
      description: result.zoning?.name ?? null,
      jurisdiction: result.source?.authority ?? result.jurisdiction?.authority ?? null,
      sourceUrl,
      sources: sourceUrl ? [sourceUrl] : [],
      splitZoned: result.zoning?.split_zoned === true,
      additionalDistricts: (result.zoning?.additional_districts ?? []).map((district) => ({
        code: district.code ?? null,
        coveragePercent: district.coveragePercent ?? district.coverage_percent ?? null,
      })),
      confidence: Number(result.verification?.confidence ?? 0),
      reason: result.verification?.warnings?.join(' '),
    };
  }
  const layerUrls = (result.sources ?? []).map((source) => source.layerUrl).filter((url): url is string => !!url);
  return {
    status: normalizeStatus(result.status ?? ''),
    code: result.baseZoning?.localCode ?? null,
    description: result.baseZoning?.localName ?? null,
    jurisdiction: result.jurisdiction?.zoningAuthority ?? null,
    sourceUrl: layerUrls[0] ?? null,
    sources: layerUrls,
    splitZoned: result.parcel?.splitZoned === true,
    additionalDistricts: (result.baseZoning?.additionalDistricts ?? []).map((district) => ({
      code: district.code ?? null,
      coveragePercent: district.coveragePercent ?? null,
    })),
    confidence: Number(result.confidence?.score ?? 0),
    reason: result.reason,
  };
}

function fromLocal(result: UniversalZoningResult): OfficialZoningLookupResult {
  const sourceUrl = result.source?.layerUrl ?? null;
  return {
    status: normalizeStatus(result.status),
    code: result.zoning.code,
    description: result.zoning.description,
    jurisdiction: result.source?.agency ?? result.jurisdiction.zoningAuthority,
    sourceUrl,
    sources: sourceUrl ? [sourceUrl] : [],
    splitZoned: result.zoning.splitZoned,
    additionalDistricts: result.zoning.additionalDistricts.map((district) => ({
      code: district.code,
      coveragePercent: district.coveragePercent,
    })),
    confidence: result.confidence.overall,
    reason: result.errors[0]?.message,
  };
}

async function apiLookup(input: OfficialZoningLookupInput): Promise<OfficialZoningLookupResult | null> {
  const configured = String(import.meta.env.VITE_ZONING_API_URL ?? '').trim();
  if (!configured) return null;
  const baseUrl = configured.replace(/\/$/, '');
  let response = await fetch(`${baseUrl}/api/zoning/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      address: input.address,
      fresh: true,
      include_third_party_comparison: false,
    }),
  });
  if (response.status === 404) {
    response = await fetch(`${baseUrl}/v1/zoning/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        address: input.address,
        parcelId: input.parcelId,
        includeParcel: true,
        includeOverlays: true,
        includeGeometry: false,
      }),
    });
  }
  if (!response.ok) throw new Error(`Official zoning API returned HTTP ${response.status}`);
  return fromApi(await response.json() as ApiZoningResult);
}

/** Normal-search zoning path. The server may discover official URLs on a
 * registry miss; no AI model is allowed to choose or invent the zoning code. */
export async function lookupOfficialZoning(input: OfficialZoningLookupInput): Promise<OfficialZoningLookupResult> {
  const api = await apiLookup(input).catch(() => null);
  if (api && (api.status === 'verified' || api.status === 'no_zoning')) return api;

  const engine = await localEngine();
  const local = await engine.lookup({
    address: input.address,
    latitude: input.latitude,
    longitude: input.longitude,
    parcelId: input.parcelId,
    includeParcel: true,
    includeOverlays: true,
    includeGeometry: false,
    discoverSources: false,
    allowThirdParty: false,
    mode: 'verified',
  });
  return fromLocal(local);
}
