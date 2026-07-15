import type { DiscoveredSource, JurisdictionResult } from '../types';
import { assessOfficialDomain } from './official-domain-detector';
import { endpointSourceType, extractEndpoints, toServiceRoot } from './arcgis-url-extractor';
import { isSafeUrl } from '../utils/url-security';

interface ArcgisItem {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  owner?: string;
  orgId?: string;
  access?: string;
  description?: string;
  snippet?: string;
  tags?: string[];
}

interface ArcgisSearchResponse {
  results?: ArcgisItem[];
}

interface ArcgisOrganization {
  name?: string;
  description?: string;
  urlKey?: string;
  customBaseUrl?: string;
}

export interface ArcgisPortalSearchOptions {
  fetchImpl?: typeof fetch;
  portalUrl?: string;
  maxResults?: number;
  signal?: AbortSignal;
}

const REJECT_DATASET = /future\s+land\s+use|comprehensive\s+plan|proposed|historic(?:al)?\s+zoning/i;

function compact(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9]/g, '');
}

function authorityName(jurisdiction: JurisdictionResult): string {
  return jurisdiction.municipality ?? jurisdiction.county?.replace(/\s+county$/i, '') ?? '';
}

function organizationMatches(org: ArcgisOrganization, jurisdiction: JurisdictionResult): boolean {
  const local = compact(authorityName(jurisdiction));
  if (local.length < 3) return false;
  const text = compact(`${org.name ?? ''} ${org.description ?? ''} ${org.urlKey ?? ''} ${org.customBaseUrl ?? ''}`);
  if (!text.includes(local)) return false;
  if (jurisdiction.jurisdictionType === 'municipal') {
    return /(city|town|village|municipal|planning|government|gov|gis)/.test(text);
  }
  return /(county|government|gov|planning|gis)/.test(text);
}

function itemLooksCurrentZoning(item: ArcgisItem): boolean {
  const text = `${item.title ?? ''} ${item.snippet ?? ''} ${(item.tags ?? []).join(' ')}`;
  return /zoning|zone\s+district/i.test(text) && !REJECT_DATASET.test(text);
}

async function readJson<T>(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<T | null> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null) as Promise<T | null>;
}

function searchQueries(jurisdiction: JurisdictionResult): string[] {
  const state = jurisdiction.stateCode ?? '';
  const county = jurisdiction.county?.replace(/\s+county$/i, '') ?? '';
  const municipality = jurisdiction.municipality ?? '';
  const places = [...new Set([municipality, county].filter(Boolean))];
  return places.map((place) => `(${place} ${state} zoning) AND (type:"Feature Service" OR type:"Map Service" OR type:"Web Map") AND access:public`);
}

/** Search ArcGIS Online directly, then prove that hosted items belong to an
 * organization matching the controlling government. ArcGIS-hosted URLs are
 * never treated as official from their hostname alone. */
export async function searchOfficialArcgisPortal(
  jurisdiction: JurisdictionResult,
  options: ArcgisPortalSearchOptions = {},
): Promise<DiscoveredSource[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const portal = (options.portalUrl ?? 'https://www.arcgis.com').replace(/\/$/, '');
  const maxResults = Math.min(Math.max(options.maxResults ?? 12, 1), 25);
  const searches = await Promise.all(searchQueries(jurisdiction).map(async (query) => {
    const params = new URLSearchParams({ f: 'json', q: query, num: String(maxResults), sortField: 'relevance' });
    return readJson<ArcgisSearchResponse>(fetchImpl, `${portal}/sharing/rest/search?${params}`, options.signal);
  }));
  const items = searches.flatMap((result) => result?.results ?? []).filter(itemLooksCurrentZoning);
  const organizations = new Map<string, ArcgisOrganization | null>();
  const candidates = new Map<string, DiscoveredSource>();

  for (const item of items.slice(0, maxResults)) {
    if (!item.id || item.access !== 'public') continue;
    const directAssessment = item.url ? assessOfficialDomain(item.url, {
      municipality: jurisdiction.municipality,
      county: jurisdiction.county,
      stateCode: jurisdiction.stateCode,
    }) : null;
    let organization: ArcgisOrganization | null = null;
    if (item.orgId) {
      if (!organizations.has(item.orgId)) {
        organizations.set(item.orgId, await readJson<ArcgisOrganization>(
          fetchImpl,
          `${portal}/sharing/rest/portals/${encodeURIComponent(item.orgId)}?f=json`,
          options.signal,
        ));
      }
      organization = organizations.get(item.orgId) ?? null;
    }
    const officialOrganization = organization ? organizationMatches(organization, jurisdiction) : false;
    if (!directAssessment?.official && !officialOrganization) continue;

    const urls: string[] = [];
    if (item.url && /\/(?:MapServer|FeatureServer)\b/i.test(item.url)) urls.push(item.url);
    if (/web map/i.test(item.type ?? '')) {
      const data = await readJson<unknown>(fetchImpl, `${portal}/sharing/rest/content/items/${item.id}/data?f=json`, options.signal);
      if (data) urls.push(...extractEndpoints(JSON.stringify(data)).arcgisServices);
    }

    for (const rawUrl of urls) {
      if (!isSafeUrl(rawUrl)) continue;
      const url = toServiceRoot(rawUrl);
      if (candidates.has(url)) continue;
      candidates.set(url, {
        url,
        sourceType: endpointSourceType(url),
        official: true,
        agency: organization?.name ?? jurisdiction.zoningAuthority,
        publisher: organization?.name ?? item.owner ?? null,
        officialPageUrl: `${portal}/home/item.html?id=${item.id}`,
        officialReason: directAssessment?.official
          ? directAssessment.reason
          : `ArcGIS organization ${organization?.name ?? item.orgId} matches the controlling jurisdiction`,
        discoveryConfidence: directAssessment?.score ?? 0.85,
        discoveredFrom: [`${portal}/home/item.html?id=${item.id}`],
      });
    }
  }
  return [...candidates.values()];
}
