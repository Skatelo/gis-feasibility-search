// Source discovery — finds the official structured GIS endpoint for a
// jurisdiction. Runs ONLY on a registry miss or forced refresh (the fast path
// never reaches here). Perplexity Search discovers candidate URLs; a page
// fetcher (Crawlee) opens non-REST candidates to extract the real service URLs;
// nothing here decides the final zoning code — it only locates sources.

import type { DiscoveredSource, JurisdictionResult, Logger } from '../types';
import { buildDiscoveryQueries } from './search-query-builder';
import { assessOfficialDomain } from './official-domain-detector';
import { extractEndpoints, endpointSourceType, toServiceRoot } from './arcgis-url-extractor';
import { isSafeUrl } from '../utils/url-security';

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

/** Injected search provider (Perplexity-backed in production, mock in tests). */
export type SearchProvider = (queries: string[], signal?: AbortSignal) => Promise<SearchResult[]>;

/** Injected page fetcher (Crawlee-backed in production). Returns page text, or
 *  '' when the page can't be read. Must never throw. */
export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<string>;

export interface DiscoveryOptions {
  allowThirdParty?: boolean;
  maxCandidatePages?: number;
  signal?: AbortSignal;
  log?: Logger;
}

const REST_URL_RE = /\/(?:MapServer|FeatureServer)\b/i;

function isDirectEndpoint(url: string): boolean {
  return REST_URL_RE.test(url) || /\/geoserver\/|service=wfs|\/wfs\b|\.geojson\b/i.test(url);
}

export class SourceDiscoveryService {
  private readonly search: SearchProvider;
  private readonly fetchPage: PageFetcher;

  constructor(search: SearchProvider, fetchPage: PageFetcher) {
    this.search = search;
    this.fetchPage = fetchPage;
  }

  async discover(jurisdiction: JurisdictionResult, options: DiscoveryOptions = {}): Promise<DiscoveredSource[]> {
    const { allowThirdParty = false, maxCandidatePages = 5, signal, log } = options;
    const queries = buildDiscoveryQueries(jurisdiction);
    if (queries.length === 0) return [];

    const results = await this.search(queries, signal).catch((err) => {
      log?.warn('discovery search failed', { error: String(err) });
      return [] as SearchResult[];
    });

    const jur = {
      municipality: jurisdiction.municipality,
      county: jurisdiction.county,
      stateCode: jurisdiction.stateCode,
    };
    const candidates = new Map<string, DiscoveredSource>();
    const record = (url: string, discoveredFrom: string) => {
      if (!isSafeUrl(url)) return;
      const root = REST_URL_RE.test(url) ? toServiceRoot(url) : url;
      const assessment = assessOfficialDomain(root, jur);
      if (!assessment.official && !allowThirdParty) return;
      const existing = candidates.get(root);
      if (existing) {
        if (!existing.discoveredFrom.includes(discoveredFrom)) existing.discoveredFrom.push(discoveredFrom);
        return;
      }
      candidates.set(root, {
        url: root,
        sourceType: endpointSourceType(root),
        official: assessment.official,
        agency: jurisdiction.zoningAuthority,
        discoveredFrom: [discoveredFrom],
      });
    };

    // Direct REST/WFS/GeoJSON URLs straight from the search results.
    const pagesToCrawl: SearchResult[] = [];
    for (const r of results) {
      if (!isSafeUrl(r.url)) continue;
      if (isDirectEndpoint(r.url)) record(r.url, r.url);
      else pagesToCrawl.push(r);
    }

    // Crawl official-looking result pages to extract embedded service URLs.
    const officialPages = pagesToCrawl
      .filter((r) => allowThirdParty || assessOfficialDomain(r.url, jur).official)
      .slice(0, maxCandidatePages);
    const crawled = await Promise.allSettled(
      officialPages.map(async (page) => {
        const text = await this.fetchPage(page.url, signal).catch(() => '');
        return { page, endpoints: text ? extractEndpoints(text) : null };
      }),
    );
    for (const c of crawled) {
      if (c.status !== 'fulfilled' || !c.value.endpoints) continue;
      const { page, endpoints } = c.value;
      for (const url of [...endpoints.arcgisServices, ...endpoints.wfsEndpoints, ...endpoints.geojsonEndpoints]) {
        record(url, page.url);
      }
    }

    // Rank: official first, then ArcGIS services, then by how many searches
    // surfaced them.
    return [...candidates.values()].sort((a, b) => {
      if (a.official !== b.official) return a.official ? -1 : 1;
      const aRest = REST_URL_RE.test(a.url) ? 1 : 0;
      const bRest = REST_URL_RE.test(b.url) ? 1 : 0;
      if (aRest !== bRest) return bRest - aRest;
      return b.discoveredFrom.length - a.discoveredFrom.length;
    });
  }
}
