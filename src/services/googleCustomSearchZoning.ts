export interface GoogleCustomSearchCredentials {
  apiKey: string;
  engineId: string;
}

export interface GoogleCustomSearchItem {
  title: string;
  link: string;
  snippet: string;
  displayLink?: string;
}

export interface GoogleCustomSearchEvidence {
  fullAddress: string;
  queries: string[];
  items: GoogleCustomSearchItem[];
  urls: string[];
  evidenceBlock: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const CUSTOM_SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanResultUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Keep the exact street/city/ZIP supplied by the address search, expand the
 * Carolina abbreviation, and include the country in every zoning query. */
export function normalizeFullAddressForZoning(value: string): string {
  const compact = String(value || '').replace(/\s+/g, ' ').trim().replace(/,+$/, '');
  if (!compact) return '';
  const withoutCountry = compact
    .replace(/,?\s*(?:United States(?: of America)?|USA|U\.S\.A\.|US)\.?$/i, '')
    .replace(/,+$/, '')
    .trim();
  const expandedState = withoutCountry
    .replace(/(?:,\s*|\s+)NC\b(?=\s+\d{5}(?:-\d{4})?(?:,|$)|,|$)/i, ', North Carolina')
    .replace(/(?:,\s*|\s+)SC\b(?=\s+\d{5}(?:-\d{4})?(?:,|$)|,|$)/i, ', South Carolina');
  return `${expandedState}, United States`;
}

/** Every query contains the same complete address. The first query intentionally
 * matches the natural-language lookup requested for the zoning code. */
export function buildZoningCustomSearchQueries(fullAddress: string): string[] {
  const address = normalizeFullAddressForZoning(fullAddress);
  if (!address) return [];
  return [
    `What is ${address} zoning code`,
    `What are the zoning setbacks, restrictions, and allowances for ${address}`,
  ];
}

async function runCustomSearch(
  query: string,
  credentials: GoogleCustomSearchCredentials,
  fetcher: FetchLike,
): Promise<GoogleCustomSearchItem[]> {
  const url = new URL(CUSTOM_SEARCH_ENDPOINT);
  url.searchParams.set('key', credentials.apiKey);
  url.searchParams.set('cx', credentials.engineId);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  url.searchParams.set('gl', 'us');
  url.searchParams.set('hl', 'en');

  const response = await fetcher(url, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Google Custom Search JSON API returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  return (Array.isArray(payload?.items) ? payload.items : [])
    .map((item: any): GoogleCustomSearchItem | null => {
      const link = cleanResultUrl(item?.link);
      if (!link) return null;
      return {
        title: cleanText(item?.title, 240),
        link,
        snippet: cleanText(item?.snippet, 800),
        displayLink: cleanText(item?.displayLink, 160) || undefined,
      };
    })
    .filter((item: GoogleCustomSearchItem | null): item is GoogleCustomSearchItem => !!item);
}

export async function fetchGoogleCustomSearchZoningEvidence(
  address: string,
  credentials: GoogleCustomSearchCredentials,
  fetcher: FetchLike = fetch,
): Promise<GoogleCustomSearchEvidence> {
  const fullAddress = normalizeFullAddressForZoning(address);
  const apiKey = credentials.apiKey.trim();
  const engineId = credentials.engineId.trim();
  if (!fullAddress) throw new Error('A full property address is required for zoning search.');
  if (!apiKey || !engineId) {
    throw new Error('Google Custom Search API key and Programmable Search Engine ID are required for zoning search.');
  }

  const queries = buildZoningCustomSearchQueries(fullAddress);
  const settled = await Promise.allSettled(
    queries.map((query) => runCustomSearch(query, { apiKey, engineId }, fetcher)),
  );
  const successful = settled
    .filter((result): result is PromiseFulfilledResult<GoogleCustomSearchItem[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value);
  if (!successful.length && settled.every((result) => result.status === 'rejected')) {
    const firstError = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw firstError?.reason instanceof Error
      ? firstError.reason
      : new Error('Google Custom Search JSON API did not return zoning evidence.');
  }

  const byUrl = new Map<string, GoogleCustomSearchItem>();
  for (const item of successful) if (!byUrl.has(item.link)) byUrl.set(item.link, item);
  const items = [...byUrl.values()].slice(0, 20);
  const urls = items.map((item) => item.link);
  const evidenceBlock = items.map((item, index) => [
    `[${index + 1}] ${item.title || item.displayLink || 'Google result'}`,
    `URL: ${item.link}`,
    `Snippet: ${item.snippet || 'No snippet returned.'}`,
  ].join('\n')).join('\n\n');

  return { fullAddress, queries, items, urls, evidenceBlock };
}
