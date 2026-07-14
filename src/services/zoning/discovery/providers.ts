// Concrete discovery providers — the production wiring for the injected
// SearchProvider and PageFetcher. All are thin and portable: the Perplexity and
// Crawlee providers post to the app's same-origin Netlify proxies (which also
// work under `netlify dev`), and an HTTP fetcher covers direct server/test use.

import type { SearchProvider, PageFetcher, SearchResult } from './source-discovery.service';
import { fetchText } from '../utils/http';

// --- Perplexity Search API (raw search, returns ranked URLs) ---------------

export interface PerplexityProviderConfig {
  apiKey: string;
  endpoint?: string; // default: same-origin Netlify proxy
  fetchImpl?: typeof fetch;
  maxResultsPerQuery?: number;
  timeoutMs?: number;
}

interface PplxRaw {
  results?: unknown;
}

function flattenPplx(data: PplxRaw): SearchResult[] {
  const out: SearchResult[] = [];
  const push = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as { url?: unknown; title?: unknown; snippet?: unknown };
    if (typeof e.url === 'string' && e.url) {
      out.push({ url: e.url, title: typeof e.title === 'string' ? e.title : undefined, snippet: typeof e.snippet === 'string' ? e.snippet : undefined });
    }
  };
  const results = data.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (Array.isArray(item)) item.forEach(push);
      else if (item && typeof item === 'object' && Array.isArray((item as { results?: unknown }).results)) {
        (item as { results: unknown[] }).results.forEach(push);
      } else push(item);
    }
  }
  return out;
}

export function perplexitySearchProvider(config: PerplexityProviderConfig): SearchProvider {
  const endpoint = config.endpoint ?? '/.netlify/functions/perplexity';
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxResults = config.maxResultsPerQuery ?? 6;
  return async (queries, signal) => {
    const chunks: string[][] = [];
    for (let i = 0; i < queries.length; i += 5) chunks.push(queries.slice(i, i + 5));
    const responses = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ query: chunk.length === 1 ? chunk[0] : chunk, max_results: maxResults, country: 'US' }),
          signal,
        });
        if (!res.ok) throw new Error(`Perplexity HTTP ${res.status}`);
        return flattenPplx((await res.json()) as PplxRaw);
      }),
    );
    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
    }
    return merged;
  };
}

// --- Page fetchers ---------------------------------------------------------

/** Direct HTTP fetch — for server/test contexts and public government pages. */
export function httpPageFetcher(timeoutMs = 8000): PageFetcher {
  return async (url, signal) => {
    try {
      return await fetchText(url, { signal, timeoutMs, maxBytes: 4 * 1024 * 1024 });
    } catch {
      return '';
    }
  };
}

export interface CrawleeProviderConfig {
  endpoint?: string; // default: same-origin Netlify proxy
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface CrawleeRaw {
  data?: { results?: Array<{ content?: string; snippet?: string }> };
}

/** Crawlee-backed fetcher — the app's bounded scraper (handles JS-heavy GIS
 *  app pages and linked documents). Returns concatenated extracted page text. */
export function crawleePageFetcher(config: CrawleeProviderConfig = {}): PageFetcher {
  const endpoint = config.endpoint ?? '/.netlify/functions/crawlee';
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (url, signal) => {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [url], queries: ['zoning gis mapserver featureserver rest services'], maxPages: 3, maxDepth: 1 }),
        signal,
      });
      if (!res.ok) return '';
      const payload = (await res.json()) as CrawleeRaw;
      const results = payload.data?.results ?? [];
      return results.map((r) => r.content || r.snippet || '').join('\n\n');
    } catch {
      return '';
    }
  };
}
