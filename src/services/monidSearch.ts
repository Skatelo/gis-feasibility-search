export interface MonidSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface MonidSearchOptions {
  maxResultsPerQuery?: number;
  maxTokensPerPage?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
  timeoutMs?: number;
  maxPriceUsd?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface MonidPrice {
  type?: 'PER_CALL' | 'PER_RESULT' | string;
  amount?: number;
  flatFee?: number | null;
  currency?: string;
}

interface MonidTool {
  provider: string;
  providerName?: string;
  endpoint: string;
  description?: string;
  summary?: string | null;
  inputSchema?: Record<string, unknown> | null;
  price?: MonidPrice;
}

interface MonidResponse<T = unknown> {
  status: number;
  payload: T | null;
  requestId?: string;
}

interface MonidRun {
  runId?: string;
  status?: string;
  output?: unknown;
  providerResponse?: {
    httpStatus?: number;
    error?: unknown;
  } | null;
}

const MONID_PROXY = '/.netlify/functions/monid';
const SEARCH_DISCOVERY_QUERY = 'web search with ranked URLs, semantic relevance, page text, highlights, and published dates';
const TOOL_METADATA_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PRICE_USD = 0.05;
const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args);
const NOISE_DOMAINS = [
  'reddit.com',
  'pinterest.com',
  'quora.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
];

let searchToolCache: {
  key: string;
  expiresAt: number;
  promise: Promise<MonidTool | null>;
} | null = null;

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function monidRequest<T>(
  endpoint: 'discover' | 'inspect' | 'run' | 'runs' | 'wallet',
  key: string,
  options: {
    body?: Record<string, unknown>;
    runId?: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<MonidResponse<T>> {
  const params = new URLSearchParams({ endpoint });
  if (options.runId) params.set('runId', options.runId);
  const isGet = endpoint === 'runs' || endpoint === 'wallet';
  const response = await options.fetchImpl(`${MONID_PROXY}?${params.toString()}`, {
    method: isGet ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'X-Monid-Key': key,
      ...(isGet ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(isGet ? {} : { body: JSON.stringify(options.body || {}) }),
    signal: requestSignal(options.signal, options.timeoutMs),
  });
  const text = await response.text();
  let payload: T | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as T;
    } catch {
      payload = null;
    }
  }
  return {
    status: response.status,
    payload,
    requestId: response.headers.get('x-request-id') || undefined,
  };
}

function monidPayloadMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  return String(value.message || value.error || '').trim();
}

function monidFailureMessage(status: number, payload: unknown, requestId?: string): string {
  const providerMessage = monidPayloadMessage(payload);
  let message: string;
  if (status === 401) {
    message = 'Monid rejected this API key. Use a current monid_live_ key from app.monid.ai/access/api-keys.';
  } else if (status === 402) {
    message = 'The Monid key is valid, but its workspace wallet has insufficient credit.';
  } else if (status === 403) {
    message = 'The Monid key is valid but is not attached to an active workspace.';
  } else if (status === 404) {
    message = 'The Monid proxy route is not deployed on this app version.';
  } else if (status === 429) {
    message = 'Monid is rate-limiting this workspace. Wait briefly and test the key again.';
  } else if (status >= 500) {
    message = 'Monid or the app proxy is temporarily unavailable.';
  } else {
    message = `Monid returned HTTP ${status}.`;
  }
  if (providerMessage && !message.toLowerCase().includes(providerMessage.toLowerCase())) {
    message += ` ${providerMessage}`;
  }
  return requestId ? `${message} Request ID: ${requestId}` : message;
}

function estimatedPrice(tool: MonidTool, maxResults: number): number {
  if (!tool.price || tool.price.amount == null) return Number.POSITIVE_INFINITY;
  if (tool.price.currency && tool.price.currency !== 'USD') return Number.POSITIVE_INFINITY;
  const amount = Number(tool.price.amount);
  const flatFee = Number(tool.price?.flatFee || 0);
  if (!Number.isFinite(amount) || !Number.isFinite(flatFee)) return Number.POSITIVE_INFINITY;
  return tool.price?.type === 'PER_RESULT'
    ? flatFee + amount * maxResults
    : amount;
}

function toolRank(tool: MonidTool, maxResults: number, maxPriceUsd: number): number {
  const provider = tool.provider.toLowerCase();
  const text = `${tool.endpoint} ${tool.description || ''} ${tool.summary || ''}`.toLowerCase();
  const cost = estimatedPrice(tool, maxResults);
  if (cost > maxPriceUsd) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (provider === 'exa') score += 120;
  if (provider === 'strale') score += 45;
  if (/\bweb search\b|\bsemantic search\b|\bsearch the web\b/.test(text)) score += 55;
  if (/highlight|full.?text|content|published/.test(text)) score += 20;
  if (/search/.test(tool.endpoint.toLowerCase())) score += 15;
  if (/twitter|linkedin|tiktok|instagram|amazon|people|company|image|video/.test(text)) score -= 100;
  if (provider === 'apify' || provider === 'browserbase') score -= 45;
  score -= Math.min(25, cost * 500);
  return score;
}

function schemaProperties(schema: Record<string, unknown> | null | undefined): Record<string, any> {
  const properties = schema && typeof schema.properties === 'object' && schema.properties
    ? schema.properties
    : {};
  return properties as Record<string, any>;
}

function queryFieldFor(tool: MonidTool): string | null {
  const properties = schemaProperties(tool.inputSchema);
  const candidates = ['query', 'q', 'searchQuery', 'search_query', 'searchTerm', 'search_term'];
  return candidates.find((name) => Object.prototype.hasOwnProperty.call(properties, name))
    || (tool.provider.toLowerCase() === 'exa' ? 'query' : null);
}

async function discoverSearchTool(
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'timeoutMs' | 'maxPriceUsd'>> & Pick<MonidSearchOptions, 'fetchImpl' | 'signal'>,
): Promise<MonidTool | null> {
  const fetchImpl = options.fetchImpl || browserFetch;
  const discovered = await monidRequest<{ results?: MonidTool[] }>('discover', key, {
    body: { query: SEARCH_DISCOVERY_QUERY, limit: 10 },
    timeoutMs: Math.min(options.timeoutMs, 10_000),
    fetchImpl,
    signal: options.signal,
  });
  if (discovered.status !== 200 || !Array.isArray(discovered.payload?.results)) {
    console.warn(monidFailureMessage(discovered.status, discovered.payload, discovered.requestId));
    return null;
  }

  const ranked = discovered.payload.results
    .map((tool) => ({ tool, score: toolRank(tool, options.maxResultsPerQuery, options.maxPriceUsd) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const inspected = await Promise.all(ranked.map(async ({ tool }) => {
    try {
      const response = await monidRequest<MonidTool>('inspect', key, {
        body: { provider: tool.provider, endpoint: tool.endpoint },
        timeoutMs: Math.min(options.timeoutMs, 8_000),
        fetchImpl,
        signal: options.signal,
      });
      return response.status === 200 && response.payload
        ? { ...tool, ...response.payload }
        : tool;
    } catch {
      return tool;
    }
  }));

  return inspected
    .map((tool) => ({
      tool,
      score: toolRank(tool, options.maxResultsPerQuery, options.maxPriceUsd),
    }))
    .filter(({ tool, score }) =>
      Number.isFinite(score)
      && !!queryFieldFor(tool)
      && estimatedPrice(tool, options.maxResultsPerQuery) <= options.maxPriceUsd)
    .sort((a, b) => b.score - a.score)[0]?.tool || null;
}

async function resolvedSearchTool(
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'timeoutMs' | 'maxPriceUsd'>> & Pick<MonidSearchOptions, 'fetchImpl' | 'signal'>,
): Promise<MonidTool | null> {
  const now = Date.now();
  const cacheKey = `${key}:${options.maxResultsPerQuery}:${options.maxPriceUsd}`;
  if (searchToolCache && searchToolCache.key === cacheKey && searchToolCache.expiresAt > now) {
    return searchToolCache.promise;
  }
  let promise: Promise<MonidTool | null>;
  promise = discoverSearchTool(key, options)
    .catch(() => null)
    .then((tool) => {
      if (!tool && searchToolCache?.promise === promise) searchToolCache = null;
      return tool;
    });
  searchToolCache = {
    key: cacheKey,
    expiresAt: now + TOOL_METADATA_TTL_MS,
    promise,
  };
  return promise;
}

export interface MonidKeyValidation {
  valid: boolean;
  searchReady: boolean;
  message: string;
  balanceUsd?: number;
  provider?: string;
  endpoint?: string;
  requestId?: string;
  status?: number;
}

/** Verifies authentication, wallet access, and an affordable web-search tool.
 *  Discovery and inspection do not execute a paid provider run. */
export async function validateMonidApiKey(
  key: string,
  options: Pick<MonidSearchOptions, 'fetchImpl' | 'signal' | 'timeoutMs' | 'maxPriceUsd'> = {},
): Promise<MonidKeyValidation> {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return {
      valid: false,
      searchReady: false,
      message: 'Enter a Monid API key before testing it.',
    };
  }

  const fetchImpl = options.fetchImpl || browserFetch;
  const timeoutMs = Math.min(20_000, Math.max(5_000, options.timeoutMs ?? 12_000));
  const maxPriceUsd = Math.min(0.25, Math.max(0.001, options.maxPriceUsd ?? DEFAULT_MAX_PRICE_USD));
  try {
    const wallet = await monidRequest<{
      balance?: { value?: number; currency?: string };
      code?: number;
      message?: string;
    }>('wallet', normalizedKey, {
      timeoutMs,
      fetchImpl,
      signal: options.signal,
    });
    if (wallet.status !== 200) {
      return {
        valid: false,
        searchReady: false,
        message: monidFailureMessage(wallet.status, wallet.payload, wallet.requestId),
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }

    const balanceUsd = Number(wallet.payload?.balance?.value);
    if (!Number.isFinite(balanceUsd)) {
      return {
        valid: true,
        searchReady: false,
        message: 'Monid authenticated the key but returned an unreadable wallet balance.',
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }
    if (balanceUsd <= 0) {
      return {
        valid: true,
        searchReady: false,
        balanceUsd,
        message: 'Monid authenticated the key, but the workspace wallet balance is $0.00. Add credit before searching.',
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }

    const tool = await resolvedSearchTool(normalizedKey, {
      maxResultsPerQuery: 8,
      timeoutMs,
      maxPriceUsd,
      fetchImpl,
      signal: options.signal,
    });
    if (!tool) {
      return {
        valid: true,
        searchReady: false,
        balanceUsd,
        message: `Monid authenticated the key and found a $${balanceUsd.toFixed(2)} balance, but no compatible web-search tool passed the $${maxPriceUsd.toFixed(2)} safety cap.`,
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }

    const provider = tool.providerName || tool.provider;
    return {
      valid: true,
      searchReady: true,
      balanceUsd,
      provider,
      endpoint: tool.endpoint,
      message: `Monid is connected. ${provider} ${tool.endpoint} is ready; wallet balance: $${balanceUsd.toFixed(2)}.`,
      requestId: wallet.requestId,
      status: wallet.status,
    };
  } catch (error) {
    return {
      valid: false,
      searchReady: false,
      message: `Could not reach the Monid proxy: ${String((error as Error)?.message || error)}`,
    };
  }
}

function firstSchemaField(properties: Record<string, any>, names: string[]): string | null {
  return names.find((name) => Object.prototype.hasOwnProperty.call(properties, name)) || null;
}

function recencyStart(recency: MonidSearchOptions['recency']): string | null {
  if (!recency) return null;
  const date = new Date();
  if (recency === 'day') date.setUTCDate(date.getUTCDate() - 1);
  if (recency === 'week') date.setUTCDate(date.getUTCDate() - 7);
  if (recency === 'month') date.setUTCMonth(date.getUTCMonth() - 1);
  if (recency === 'year') date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString();
}

function objectOption(schema: any, maxTokensPerPage: number): unknown {
  if (schema?.type === 'boolean') return true;
  const properties = schemaProperties(schema);
  const option: Record<string, unknown> = {};
  if ('maxCharacters' in properties) option.maxCharacters = Math.max(1000, maxTokensPerPage * 4);
  if ('max_characters' in properties) option.max_characters = Math.max(1000, maxTokensPerPage * 4);
  if ('maxTokens' in properties) option.maxTokens = maxTokensPerPage;
  if ('max_tokens' in properties) option.max_tokens = maxTokensPerPage;
  if ('highlightsPerUrl' in properties) option.highlightsPerUrl = 3;
  if ('numSentences' in properties) option.numSentences = 4;
  return Object.keys(option).length ? option : true;
}

function buildSearchInput(
  tool: MonidTool,
  query: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'maxTokensPerPage'>> & Pick<MonidSearchOptions, 'recency'>,
): Record<string, unknown> {
  const properties = schemaProperties(tool.inputSchema);
  const input: Record<string, unknown> = {};
  const queryField = queryFieldFor(tool) || 'query';
  input[queryField] = query.slice(0, 1000);

  const countField = firstSchemaField(properties, [
    'numResults',
    'num_results',
    'maxResults',
    'max_results',
    'limit',
    'count',
  ]);
  if (countField) input[countField] = options.maxResultsPerQuery;
  else if (tool.provider.toLowerCase() === 'exa') input.numResults = options.maxResultsPerQuery;

  const excludeField = firstSchemaField(properties, ['excludeDomains', 'exclude_domains']);
  if (excludeField) input[excludeField] = NOISE_DOMAINS;

  const startDate = recencyStart(options.recency);
  const startField = firstSchemaField(properties, ['startPublishedDate', 'start_published_date', 'publishedAfter']);
  if (startDate && startField) input[startField] = startDate;

  const contentsSchema = properties.contents;
  if (contentsSchema) {
    const contentProperties = schemaProperties(contentsSchema);
    const contents: Record<string, unknown> = {};
    if (contentProperties.highlights) {
      contents.highlights = objectOption(contentProperties.highlights, Math.min(800, options.maxTokensPerPage));
    }
    if (contentProperties.text) {
      contents.text = objectOption(contentProperties.text, options.maxTokensPerPage);
    }
    input.contents = Object.keys(contents).length ? contents : true;
  } else {
    const highlightsField = firstSchemaField(properties, ['highlights', 'includeHighlights', 'include_highlights']);
    if (highlightsField) input[highlightsField] = objectOption(properties[highlightsField], Math.min(800, options.maxTokensPerPage));
    const textField = firstSchemaField(properties, ['text', 'includeText', 'include_text', 'fullText', 'full_text']);
    if (textField) input[textField] = objectOption(properties[textField], options.maxTokensPerPage);
  }
  return input;
}

function providerSucceeded(run: MonidRun): boolean {
  const providerStatus = Number(run.providerResponse?.httpStatus ?? 200);
  return run.status !== 'FAILED' && providerStatus >= 200 && providerStatus < 300;
}

async function completedRun(
  initial: MonidResponse<MonidRun>,
  key: string,
  options: Required<Pick<MonidSearchOptions, 'timeoutMs'>> & Pick<MonidSearchOptions, 'fetchImpl' | 'signal'>,
): Promise<MonidRun | null> {
  if (initial.status === 200 && initial.payload && providerSucceeded(initial.payload)) {
    return initial.payload;
  }
  const runId = initial.payload?.runId;
  if (initial.status !== 202 || !runId) return null;

  const fetchImpl = options.fetchImpl || browserFetch;
  const delays = [500, 900, 1400, 2200, 3000];
  const deadline = Date.now() + Math.min(options.timeoutMs, 12_000);
  for (const delay of delays) {
    if (Date.now() + delay > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await monidRequest<MonidRun>('runs', key, {
      runId,
      timeoutMs: Math.max(1000, deadline - Date.now()),
      fetchImpl,
      signal: options.signal,
    });
    if (response.status !== 200 || !response.payload) continue;
    if (response.payload.status === 'COMPLETED') {
      return providerSucceeded(response.payload) ? response.payload : null;
    }
    if (response.payload.status === 'FAILED') return null;
  }
  return null;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return asText(object.text || object.content || object.snippet || object.value);
  }
  return '';
}

function candidateRows(value: unknown, depth = 0): unknown[] {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value)) {
    const direct = value.filter((entry) =>
      entry && typeof entry === 'object' && ['url', 'link', 'id'].some((key) => key in (entry as Record<string, unknown>)));
    return direct.length ? direct : value.flatMap((entry) => candidateRows(entry, depth + 1));
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const keys = ['results', 'searchResults', 'search_results', 'organic', 'documents', 'items', 'data', 'output'];
  for (const key of keys) {
    const rows = candidateRows(object[key], depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function normalizeMonidSearchOutput(output: unknown): MonidSearchResult[] {
  const rows = candidateRows(output);
  const seen = new Set<string>();
  const results: MonidSearchResult[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const rawUrl = asText(row.url || row.link || row.id);
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const url = canonicalUrl(rawUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    const snippet = [
      asText(row.highlights),
      asText(row.highlight),
      asText(row.snippet),
      asText(row.summary),
      asText(row.text),
      asText(row.content),
      asText(row.description),
    ].filter(Boolean).join('\n\n');
    const rawDate = asText(row.publishedDate || row.published_date || row.date || row.time_published);
    results.push({
      title: asText(row.title || row.name) || rawUrl,
      url,
      snippet,
      date: rawDate ? rawDate.slice(0, 10) : undefined,
    });
  }
  return results;
}

async function runSearch(
  tool: MonidTool,
  query: string,
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'maxTokensPerPage' | 'timeoutMs'>> & Pick<MonidSearchOptions, 'recency' | 'fetchImpl' | 'signal'>,
): Promise<MonidSearchResult[]> {
  const fetchImpl = options.fetchImpl || browserFetch;
  const initial = await monidRequest<MonidRun>('run', key, {
    body: {
      provider: tool.provider,
      endpoint: tool.endpoint,
      input: buildSearchInput(tool, query, options),
    },
    timeoutMs: options.timeoutMs,
    fetchImpl,
    signal: options.signal,
  });
  const run = await completedRun(initial, key, options);
  return run ? normalizeMonidSearchOutput(run.output) : [];
}

function interleave(groups: MonidSearchResult[][]): MonidSearchResult[] {
  const maxDepth = Math.max(0, ...groups.map((group) => group.length));
  const seen = new Set<string>();
  const merged: MonidSearchResult[] = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const group of groups) {
      const result = group[depth];
      if (!result || seen.has(result.url)) continue;
      seen.add(result.url);
      merged.push(result);
    }
  }
  return merged;
}

export async function monidSearchBatchWithKey(
  key: string,
  queries: string[],
  options: MonidSearchOptions = {},
): Promise<MonidSearchResult[]> {
  const normalizedKey = key.trim();
  const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
  if (!normalizedKey || !uniqueQueries.length) return [];

  const resolvedOptions = {
    maxResultsPerQuery: Math.min(20, Math.max(1, options.maxResultsPerQuery ?? 8)),
    maxTokensPerPage: Math.min(4000, Math.max(200, options.maxTokensPerPage ?? 1500)),
    timeoutMs: Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 15_000)),
    maxPriceUsd: Math.min(0.25, Math.max(0.001, options.maxPriceUsd ?? DEFAULT_MAX_PRICE_USD)),
    recency: options.recency,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  };
  const tool = await resolvedSearchTool(normalizedKey, resolvedOptions);
  if (!tool) return [];

  const groups: MonidSearchResult[][] = Array.from({ length: uniqueQueries.length }, () => []);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, uniqueQueries.length) }, async () => {
    while (cursor < uniqueQueries.length) {
      const index = cursor++;
      try {
        groups[index] = await runSearch(tool, uniqueQueries[index], normalizedKey, resolvedOptions);
      } catch {
        groups[index] = [];
      }
    }
  });
  await Promise.all(workers);
  return interleave(groups);
}

export interface SearchQualitySummary {
  score: number;
  resultCount: number;
  validUrlRate: number;
  officialSourceRate: number;
  contentCoverageRate: number;
  uniqueDomains: number;
}

export function summarizeSearchQuality(
  results: MonidSearchResult[],
  queries: string[],
): SearchQualitySummary {
  if (!results.length) {
    return {
      score: 0,
      resultCount: 0,
      validUrlRate: 0,
      officialSourceRate: 0,
      contentCoverageRate: 0,
      uniqueDomains: 0,
    };
  }
  const queryTokens = new Set(
    queries.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4),
  );
  let valid = 0;
  let official = 0;
  let content = 0;
  let overlap = 0;
  const domains = new Set<string>();
  for (const result of results) {
    try {
      const url = new URL(result.url);
      valid += 1;
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      domains.add(host);
      if (host.endsWith('.gov') || host.endsWith('.us') || host.includes('.gov.')) official += 1;
    } catch {
      // Invalid URLs remain in the denominator.
    }
    if (result.snippet.trim().length >= 120) content += 1;
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    if ([...queryTokens].some((token) => haystack.includes(token))) overlap += 1;
  }
  const validUrlRate = valid / results.length;
  const officialSourceRate = official / results.length;
  const contentCoverageRate = content / results.length;
  const overlapRate = queryTokens.size ? overlap / results.length : 1;
  const diversityRate = Math.min(1, domains.size / Math.min(6, results.length));
  const score = Math.round(100 * (
    validUrlRate * 0.2
    + officialSourceRate * 0.25
    + contentCoverageRate * 0.2
    + overlapRate * 0.2
    + diversityRate * 0.15
  ));
  return {
    score,
    resultCount: results.length,
    validUrlRate,
    officialSourceRate,
    contentCoverageRate,
    uniqueDomains: domains.size,
  };
}

export function resetMonidSearchToolCache(): void {
  searchToolCache = null;
}
