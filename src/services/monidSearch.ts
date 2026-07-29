export interface MonidSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export type MonidBudgetMode = 'economy' | 'adaptive' | 'thorough';
export type MonidResearchStrategy = 'search' | 'broad';

export interface MonidBudgetProfile {
  label: string;
  softPerRunUsd: number;
  maxPerRunUsd: number;
  minimumBatchUsd: number;
  maxBatchUsd: number;
  walletFraction: number;
  concurrency: number;
  allowWalletEscalation: boolean;
}

export const MONID_BUDGET_PROFILES: Record<MonidBudgetMode, MonidBudgetProfile> = {
  economy: {
    label: 'Economy',
    softPerRunUsd: 0.03,
    maxPerRunUsd: 0.05,
    minimumBatchUsd: 0.05,
    maxBatchUsd: 0.10,
    walletFraction: 0.05,
    concurrency: 1,
    allowWalletEscalation: false,
  },
  adaptive: {
    label: 'Adaptive',
    softPerRunUsd: 0.05,
    maxPerRunUsd: 0.15,
    minimumBatchUsd: 0.10,
    maxBatchUsd: 0.35,
    walletFraction: 0.15,
    concurrency: 2,
    allowWalletEscalation: true,
  },
  thorough: {
    label: 'Thorough',
    softPerRunUsd: 0.10,
    maxPerRunUsd: 0.35,
    minimumBatchUsd: 0.20,
    maxBatchUsd: 0.75,
    walletFraction: 0.35,
    concurrency: 3,
    allowWalletEscalation: true,
  },
};

export interface MonidSearchOptions {
  maxResultsPerQuery?: number;
  maxTokensPerPage?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
  strategy?: MonidResearchStrategy;
  semanticRerank?: boolean;
  timeoutMs?: number;
  budgetMode?: MonidBudgetMode;
  /** Explicit compatibility override. Normal app searches use budgetMode. */
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

interface MonidSchemaNode {
  type?: string;
  properties?: Record<string, MonidSchemaNode>;
}

export type OctenToolRole = 'search' | 'broad-search' | 'extract' | 'embedding';

interface OctenToolSpec {
  endpoint: string;
  discoveryQuery: string;
}

const OCTEN_TOOL_SPECS: Record<OctenToolRole, OctenToolSpec> = {
  search: {
    endpoint: '/search',
    discoveryQuery: 'Octen web search',
  },
  'broad-search': {
    endpoint: '/broad-search',
    discoveryQuery: 'Octen broad search',
  },
  extract: {
    endpoint: '/extract',
    discoveryQuery: 'Octen URL content extract',
  },
  embedding: {
    endpoint: '/embedding',
    discoveryQuery: 'Octen text embedding',
  },
};

interface MonidResponse<T = unknown> {
  status: number;
  payload: T | null;
  requestId?: string;
}

interface MonidRun {
  runId?: string;
  status?: string;
  output?: unknown;
  cost?: MonidMoney | null;
  billing?: {
    actualCost?: MonidMoney | null;
    calculatedCost?: MonidMoney | null;
    reportedCost?: MonidMoney | null;
  } | null;
  resultCount?: number | null;
  providerResponse?: {
    httpStatus?: number;
    error?: unknown;
  } | null;
}

interface MonidMoney {
  value?: number | string;
  amount?: number | string;
  unit?: string;
  currency?: string;
}

export interface MonidBudgetSnapshot {
  sessionId: string;
  mode: MonidBudgetMode;
  walletBalanceUsd?: number;
  totalBudgetUsd: number;
  actualSpentUsd: number;
  estimatedSpentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  runsCompleted: number;
  skippedQueries: number;
}

export interface MonidExtractResult {
  title: string;
  url: string;
  content: string;
  snippet: string;
  date?: string;
}

interface MutableMonidBudgetSession {
  sessionId: string;
  mode: MonidBudgetMode;
  controller: AbortController;
  walletBalanceUsd?: number;
  walletPromise?: Promise<void>;
  totalBudgetUsd: number;
  actualSpentUsd: number;
  estimatedSpentUsd: number;
  reservedUsd: number;
  runsCompleted: number;
  skippedQueries: number;
}

const MONID_PROXY = '/.netlify/functions/monid';
const SEARCH_DISCOVERY_QUERY = 'web search with ranked URLs, semantic relevance, page text, highlights, and published dates';
const TOOL_METADATA_TTL_MS = 30 * 60 * 1000;
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
const octenToolCache = new Map<string, {
  expiresAt: number;
  promise: Promise<MonidTool | null>;
}>();
let activeBudgetSession: MutableMonidBudgetSession | null = null;
const budgetListeners = new Set<(snapshot: MonidBudgetSnapshot | null) => void>();

function budgetProfile(mode: MonidBudgetMode | undefined): MonidBudgetProfile {
  return MONID_BUDGET_PROFILES[mode || 'adaptive'] || MONID_BUDGET_PROFILES.adaptive;
}

function budgetForWallet(mode: MonidBudgetMode, balanceUsd: number | undefined): number {
  const profile = budgetProfile(mode);
  if (!Number.isFinite(balanceUsd)) return profile.minimumBatchUsd;
  const balance = Math.max(0, Number(balanceUsd));
  if (profile.allowWalletEscalation) return balance;
  return Math.min(
    balance,
    profile.maxBatchUsd,
    Math.max(profile.minimumBatchUsd, balance * profile.walletFraction),
  );
}

function sessionAccountedSpend(session: MutableMonidBudgetSession): number {
  return session.actualSpentUsd + session.estimatedSpentUsd;
}

function sessionWalletRemaining(session: MutableMonidBudgetSession): number {
  if (!Number.isFinite(session.walletBalanceUsd)) {
    return Math.max(
      0,
      session.totalBudgetUsd - sessionAccountedSpend(session) - session.reservedUsd,
    );
  }
  return Math.max(
    0,
    Number(session.walletBalanceUsd) - sessionAccountedSpend(session) - session.reservedUsd,
  );
}

function budgetSnapshot(session: MutableMonidBudgetSession | null): MonidBudgetSnapshot | null {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    walletBalanceUsd: session.walletBalanceUsd,
    totalBudgetUsd: session.totalBudgetUsd,
    actualSpentUsd: session.actualSpentUsd,
    estimatedSpentUsd: session.estimatedSpentUsd,
    reservedUsd: session.reservedUsd,
    remainingUsd: Math.max(
      0,
      session.totalBudgetUsd - sessionAccountedSpend(session) - session.reservedUsd,
    ),
    runsCompleted: session.runsCompleted,
    skippedQueries: session.skippedQueries,
  };
}

function emitBudgetSnapshot(session: MutableMonidBudgetSession | null): void {
  if (session && activeBudgetSession !== session) return;
  const snapshot = budgetSnapshot(session);
  for (const listener of budgetListeners) listener(snapshot);
}

export function beginMonidBudgetSession(sessionId: string, mode: MonidBudgetMode = 'adaptive'): void {
  activeBudgetSession?.controller.abort();
  activeBudgetSession = {
    sessionId,
    mode,
    controller: new AbortController(),
    totalBudgetUsd: budgetForWallet(mode, undefined),
    actualSpentUsd: 0,
    estimatedSpentUsd: 0,
    reservedUsd: 0,
    runsCompleted: 0,
    skippedQueries: 0,
  };
  emitBudgetSnapshot(activeBudgetSession);
}

export function getMonidBudgetSnapshot(): MonidBudgetSnapshot | null {
  return budgetSnapshot(activeBudgetSession);
}

export function subscribeMonidBudget(
  listener: (snapshot: MonidBudgetSnapshot | null) => void,
): () => void {
  budgetListeners.add(listener);
  return () => budgetListeners.delete(listener);
}

export function resetMonidBudgetSession(): void {
  activeBudgetSession?.controller.abort();
  activeBudgetSession = null;
  emitBudgetSnapshot(null);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first || second;
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

async function ensureSessionWallet(
  session: MutableMonidBudgetSession,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (session.walletPromise) return session.walletPromise;
  session.walletPromise = (async () => {
    try {
      const wallet = await monidRequest<{
        balance?: { value?: number; currency?: string };
      }>('wallet', key, {
        timeoutMs: Math.min(timeoutMs, 12_000),
        fetchImpl,
        signal,
      });
      const balanceUsd = Number(wallet.payload?.balance?.value);
      const currency = String(wallet.payload?.balance?.currency || 'USD').toUpperCase();
      if (wallet.status === 200 && currency === 'USD' && Number.isFinite(balanceUsd)) {
        session.walletBalanceUsd = Math.max(0, balanceUsd);
        session.totalBudgetUsd = budgetForWallet(session.mode, session.walletBalanceUsd);
      }
    } catch {
      // Keep the profile's conservative minimum when wallet telemetry is unavailable.
    } finally {
      emitBudgetSnapshot(session);
    }
  })();
  return session.walletPromise;
}

function estimatedPrice(tool: MonidTool, maxResults: number): number {
  if (!tool.price || tool.price.amount == null) return Number.POSITIVE_INFINITY;
  if (tool.price.currency && tool.price.currency.toUpperCase() !== 'USD') return Number.POSITIVE_INFINITY;
  const amount = Number(tool.price.amount);
  const flatFee = Number(tool.price?.flatFee || 0);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(flatFee) || flatFee < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return tool.price?.type?.toUpperCase() === 'PER_RESULT'
    ? flatFee + amount * maxResults
    : amount;
}

function affordableResultCount(tool: MonidTool, requestedResults: number, maxPriceUsd: number): number {
  const requested = Math.max(1, Math.floor(requestedResults));
  if (!tool.price || tool.price.amount == null) return 0;
  if (tool.price.currency && tool.price.currency.toUpperCase() !== 'USD') return 0;
  const amount = Number(tool.price.amount);
  const flatFee = Number(tool.price.flatFee || 0);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(flatFee) || flatFee < 0) return 0;
  if (tool.price.type?.toUpperCase() !== 'PER_RESULT') {
    return amount <= maxPriceUsd + 1e-9 ? requested : 0;
  }
  const remaining = maxPriceUsd - flatFee;
  if (remaining < -1e-9) return 0;
  if (amount === 0) return requested;
  return Math.min(requested, Math.max(0, Math.floor((remaining + 1e-9) / amount)));
}

function toolRelevance(tool: MonidTool): number {
  const provider = tool.provider.toLowerCase();
  const text = `${tool.endpoint} ${tool.description || ''} ${tool.summary || ''}`.toLowerCase();
  let score = 0;
  if (provider === 'exa') score += 120;
  if (provider === 'strale') score += 45;
  if (/\bweb search\b|\bsemantic search\b|\bsearch the web\b/.test(text)) score += 55;
  if (/highlight|full.?text|content|published/.test(text)) score += 20;
  if (/search/.test(tool.endpoint.toLowerCase())) score += 15;
  if (/twitter|linkedin|tiktok|instagram|amazon|people|company|image|video/.test(text)) score -= 100;
  if (provider === 'apify' || provider === 'browserbase') score -= 45;
  return score;
}

function toolRank(tool: MonidTool, maxResults: number, maxPriceUsd: number): number {
  const affordableResults = affordableResultCount(tool, maxResults, maxPriceUsd);
  if (affordableResults < 1) return Number.NEGATIVE_INFINITY;
  const cost = estimatedPrice(tool, affordableResults);
  let score = toolRelevance(tool);
  score += Math.min(12, affordableResults);
  score -= Math.min(25, cost * 500);
  return score;
}

function schemaProperties(schema: unknown): Record<string, MonidSchemaNode> {
  const candidate = schema && typeof schema === 'object'
    ? schema as MonidSchemaNode
    : null;
  const properties = candidate && typeof candidate.properties === 'object' && candidate.properties
    ? candidate.properties
    : {};
  return properties;
}

function queryFieldFor(tool: MonidTool): string | null {
  const properties = schemaProperties(tool.inputSchema);
  const candidates = ['query', 'q', 'searchQuery', 'search_query', 'searchTerm', 'search_term'];
  return candidates.find((name) => Object.prototype.hasOwnProperty.call(properties, name))
    || (['exa', 'octen'].includes(tool.provider.toLowerCase()) ? 'query' : null);
}

function normalizedToolEndpoint(endpoint: string): string {
  const withoutMethod = endpoint.trim().replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '');
  try {
    return new URL(withoutMethod, 'https://provider.invalid').pathname
      .replace(/\/+$/, '')
      .toLowerCase() || '/';
  } catch {
    return withoutMethod.split('?')[0].replace(/\/+$/, '').toLowerCase() || '/';
  }
}

function isOctenProvider(tool: MonidTool): boolean {
  return `${tool.provider} ${tool.providerName || ''}`.toLowerCase().includes('octen');
}

function isOctenToolForRole(tool: MonidTool, role: OctenToolRole): boolean {
  return isOctenProvider(tool)
    && normalizedToolEndpoint(tool.endpoint) === OCTEN_TOOL_SPECS[role].endpoint;
}

function inspectedTool(payload: unknown): MonidTool | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const candidate = value.tool && typeof value.tool === 'object'
    ? value.tool as Record<string, unknown>
    : value;
  if (typeof candidate.provider !== 'string' || typeof candidate.endpoint !== 'string') return null;
  return candidate as unknown as MonidTool;
}

async function discoverOctenTool(
  key: string,
  role: OctenToolRole,
  options: Pick<MonidSearchOptions, 'fetchImpl' | 'signal'> & { timeoutMs: number },
): Promise<MonidTool | null> {
  const fetchImpl = options.fetchImpl || browserFetch;
  const spec = OCTEN_TOOL_SPECS[role];

  try {
    const direct = await monidRequest<MonidTool>('inspect', key, {
      body: { provider: 'octen', endpoint: spec.endpoint },
      timeoutMs: Math.min(options.timeoutMs, 8_000),
      fetchImpl,
      signal: options.signal,
    });
    const directTool = inspectedTool(direct.payload);
    if (direct.status === 200 && directTool && isOctenToolForRole(directTool, role)) {
      return directTool;
    }
  } catch {
    // Catalog discovery below handles provider aliases and endpoint changes.
  }

  const discovered = await monidRequest<{ results?: MonidTool[] }>('discover', key, {
    body: { query: spec.discoveryQuery, limit: 20 },
    timeoutMs: Math.min(options.timeoutMs, 10_000),
    fetchImpl,
    signal: options.signal,
  });
  if (discovered.status !== 200 || !Array.isArray(discovered.payload?.results)) return null;

  const candidates = discovered.payload.results.filter((tool) => isOctenToolForRole(tool, role));
  for (const candidate of candidates) {
    try {
      const response = await monidRequest<MonidTool>('inspect', key, {
        body: { provider: candidate.provider, endpoint: candidate.endpoint },
        timeoutMs: Math.min(options.timeoutMs, 8_000),
        fetchImpl,
        signal: options.signal,
      });
      const metadata = inspectedTool(response.payload);
      if (response.status === 200 && metadata) {
        const merged = { ...candidate, ...metadata };
        if (isOctenToolForRole(merged, role)) return merged;
      }
    } catch {
      // Try the next exact Octen candidate.
    }
  }
  return null;
}

async function resolvedOctenTool(
  key: string,
  role: OctenToolRole,
  options: Pick<MonidSearchOptions, 'fetchImpl' | 'signal'> & { timeoutMs: number },
): Promise<MonidTool | null> {
  const now = Date.now();
  const cacheKey = `${key}:${role}`;
  const cached = octenToolCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise: Promise<MonidTool | null> = discoverOctenTool(key, role, options)
    .catch(() => null)
    .then((tool) => {
      if (!tool && octenToolCache.get(cacheKey)?.promise === promise) {
        octenToolCache.delete(cacheKey);
      }
      return tool;
    });
  octenToolCache.set(cacheKey, {
    expiresAt: now + TOOL_METADATA_TTL_MS,
    promise,
  });
  return promise;
}

async function discoverSearchTool(
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'timeoutMs' | 'maxPriceUsd'>> & Pick<MonidSearchOptions, 'fetchImpl' | 'signal'>,
): Promise<MonidTool | null> {
  const fetchImpl = options.fetchImpl || browserFetch;
  const discovered = await monidRequest<{ results?: MonidTool[] }>('discover', key, {
    body: { query: SEARCH_DISCOVERY_QUERY, limit: 20 },
    timeoutMs: Math.min(options.timeoutMs, 10_000),
    fetchImpl,
    signal: options.signal,
  });
  if (discovered.status !== 200 || !Array.isArray(discovered.payload?.results)) {
    console.warn(monidFailureMessage(discovered.status, discovered.payload, discovered.requestId));
    return null;
  }

  const ranked = discovered.payload.results
    .map((tool) => ({ tool, score: toolRelevance(tool) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

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
      && affordableResultCount(tool, options.maxResultsPerQuery, options.maxPriceUsd) > 0)
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
  const promise: Promise<MonidTool | null> = discoverSearchTool(key, options)
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

interface MonidToolSelection {
  tool: MonidTool;
  maxPriceUsd: number;
  role?: OctenToolRole;
}

async function resolveSearchToolWithinBudget(
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'timeoutMs'>>
    & Pick<MonidSearchOptions, 'fetchImpl' | 'signal' | 'strategy'>,
  softCapUsd: number,
  hardCapUsd: number,
): Promise<MonidToolSelection | null> {
  const boundedSoftCap = Math.max(0.001, softCapUsd);
  const boundedHardCap = Math.max(boundedSoftCap, hardCapUsd);
  const preferredRole: OctenToolRole = options.strategy === 'broad' ? 'broad-search' : 'search';
  const octenRoles: OctenToolRole[] = preferredRole === 'broad-search'
    ? ['broad-search', 'search']
    : ['search'];
  let octenCatalogMatched = false;

  for (const role of octenRoles) {
    const tool = await resolvedOctenTool(key, role, options);
    if (!tool) continue;
    octenCatalogMatched = true;
    const softResults = affordableResultCount(tool, options.maxResultsPerQuery, boundedSoftCap);
    if (softResults > 0) return { tool, maxPriceUsd: boundedSoftCap, role };
    const hardResults = affordableResultCount(tool, options.maxResultsPerQuery, boundedHardCap);
    if (hardResults > 0) return { tool, maxPriceUsd: boundedHardCap, role };
  }
  if (octenCatalogMatched) return null;

  // Keep a generic search fallback for temporary catalog outages. Octen remains
  // the deterministic first choice for every normal and broad research run.
  const softTool = await resolvedSearchTool(key, {
    ...options,
    maxPriceUsd: boundedSoftCap,
  });
  if (softTool) return { tool: softTool, maxPriceUsd: boundedSoftCap };
  if (boundedHardCap <= boundedSoftCap + 1e-9) return null;
  const hardTool = await resolvedSearchTool(key, {
    ...options,
    maxPriceUsd: boundedHardCap,
  });
  return hardTool ? { tool: hardTool, maxPriceUsd: boundedHardCap } : null;
}

export interface MonidKeyValidation {
  valid: boolean;
  searchReady: boolean;
  message: string;
  balanceUsd?: number;
  provider?: string;
  endpoint?: string;
  budgetMode?: MonidBudgetMode;
  totalBudgetUsd?: number;
  maxResultsPerQuery?: number;
  estimatedPriceUsd?: number;
  octenCapabilities?: Partial<Record<OctenToolRole, boolean>>;
  requestId?: string;
  status?: number;
}

/** Verifies authentication, wallet access, and the Octen tools used by the app.
 *  Discovery and inspection do not execute a paid provider run. */
export async function validateMonidApiKey(
  key: string,
  options: Pick<
    MonidSearchOptions,
    'fetchImpl' | 'signal' | 'timeoutMs' | 'maxPriceUsd' | 'budgetMode'
  > = {},
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
  const mode = options.budgetMode || 'adaptive';
  const profile = budgetProfile(mode);
  const explicitMaxPriceUsd = Number.isFinite(options.maxPriceUsd)
    ? Math.max(0.001, Number(options.maxPriceUsd))
    : null;
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

    const initialBudgetUsd = explicitMaxPriceUsd ?? budgetForWallet(mode, balanceUsd);
    const softCapUsd = explicitMaxPriceUsd
      ?? Math.min(initialBudgetUsd, profile.softPerRunUsd);
    const hardCapUsd = explicitMaxPriceUsd
      ?? (profile.allowWalletEscalation
        ? balanceUsd
        : Math.min(initialBudgetUsd, profile.maxPerRunUsd));
    const roles: OctenToolRole[] = ['search', 'broad-search', 'extract', 'embedding'];
    const resolvedTools = await Promise.all(roles.map((role) =>
      resolvedOctenTool(normalizedKey, role, {
        timeoutMs,
        fetchImpl,
        signal: options.signal,
      })));
    const octenCapabilities = Object.fromEntries(
      roles.map((role, index) => [role, !!resolvedTools[index]]),
    ) as Record<OctenToolRole, boolean>;
    const searchTool = resolvedTools[roles.indexOf('search')]
      || resolvedTools[roles.indexOf('broad-search')];
    if (!searchTool) {
      return {
        valid: true,
        searchReady: false,
        balanceUsd,
        budgetMode: mode,
        totalBudgetUsd: initialBudgetUsd,
        octenCapabilities,
        message: `Monid authenticated the key and found a $${balanceUsd.toFixed(2)} balance, but its tool catalog did not expose Octen Search or Broad Search.`,
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }

    const softResultCount = affordableResultCount(searchTool, 8, softCapUsd);
    const maxPriceUsd = softResultCount > 0 ? softCapUsd : hardCapUsd;
    const maxResultsPerQuery = affordableResultCount(searchTool, 8, maxPriceUsd);
    if (maxResultsPerQuery < 1) {
      return {
        valid: true,
        searchReady: false,
        balanceUsd,
        budgetMode: mode,
        totalBudgetUsd: initialBudgetUsd,
        octenCapabilities,
        message: profile.allowWalletEscalation
          ? `Monid authenticated the key and found Octen, but the selected Octen search run exceeds the available $${balanceUsd.toFixed(2)} wallet balance.`
          : `Monid authenticated the key and found Octen, but the selected Octen search run exceeds the ${profile.label} mode's $${hardCapUsd.toFixed(2)} per-run ceiling.`,
        requestId: wallet.requestId,
        status: wallet.status,
      };
    }

    const provider = searchTool.providerName || searchTool.provider;
    const estimatedPriceUsd = estimatedPrice(searchTool, maxResultsPerQuery);
    const totalBudgetUsd = explicitMaxPriceUsd ?? initialBudgetUsd;
    const readyLabels = roles
      .filter((role) => octenCapabilities[role])
      .map((role) => OCTEN_TOOL_SPECS[role].endpoint)
      .join(', ');
    const missingLabels = roles
      .filter((role) => !octenCapabilities[role])
      .map((role) => OCTEN_TOOL_SPECS[role].endpoint)
      .join(', ');
    return {
      valid: true,
      searchReady: true,
      balanceUsd,
      provider,
      endpoint: searchTool.endpoint,
      budgetMode: mode,
      totalBudgetUsd,
      maxResultsPerQuery,
      estimatedPriceUsd,
      octenCapabilities,
      message: `Monid is connected to Octen in ${profile.label} mode. Ready: ${readyLabels}. ${missingLabels ? `Not exposed by this workspace: ${missingLabels}. ` : ''}${provider} ${searchTool.endpoint} can return up to ${maxResultsPerQuery} results per query; estimated run cost: $${estimatedPriceUsd.toFixed(3)}. Soft target: $${softCapUsd.toFixed(2)}. ${profile.allowWalletEscalation ? 'No fixed provider ceiling; the available wallet is the final limit.' : `Per-run ceiling: $${hardCapUsd.toFixed(2)}.`} Property research budget: $${totalBudgetUsd.toFixed(2)}. Wallet balance: $${balanceUsd.toFixed(2)}.`,
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

function firstSchemaField(properties: Record<string, MonidSchemaNode>, names: string[]): string | null {
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

function objectOption(schema: MonidSchemaNode | undefined, maxTokensPerPage: number): unknown {
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

function buildOctenSearchInput(
  query: string,
  role: Extract<OctenToolRole, 'search' | 'broad-search'>,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'maxTokensPerPage'>>
    & Pick<MonidSearchOptions, 'recency'>,
): Record<string, unknown> {
  const searchOptions: Record<string, unknown> = {
    count: Math.min(100, options.maxResultsPerQuery),
    exclude_domains: NOISE_DOMAINS,
    language: ['en'],
    highlight: { format: 'markdown' },
  };
  if (options.recency) searchOptions.time_range = options.recency;

  if (role === 'broad-search') {
    return {
      query: query.slice(0, 500),
      max_queries: Math.min(5, Math.max(2, Math.ceil(options.maxResultsPerQuery / 3))),
      search_options: {
        ...searchOptions,
        count: Math.min(8, options.maxResultsPerQuery),
      },
    };
  }
  return {
    query: query.slice(0, 500),
    ...searchOptions,
  };
}

function buildSearchInput(
  tool: MonidTool,
  query: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'maxTokensPerPage'>>
    & Pick<MonidSearchOptions, 'recency'>,
  role?: OctenToolRole,
): Record<string, unknown> {
  if (role === 'search' || role === 'broad-search') {
    return buildOctenSearchInput(query, role, options);
  }

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
  if (initial.status === 200 && initial.payload) return initial.payload;
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
    if (response.payload.status === 'COMPLETED' || response.payload.status === 'FAILED') {
      return response.payload;
    }
  }
  return null;
}

function moneyToUsd(money: MonidMoney | null | undefined): number | null {
  if (!money) return null;
  if (money.currency && money.currency.toUpperCase() !== 'USD') return null;
  const rawValue = Number(money.value ?? money.amount);
  if (!Number.isFinite(rawValue) || rawValue < 0) return null;
  const unit = String(money.unit || 'DOLLAR').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (unit === 'MICRO_DOLLAR' || unit === 'MICRODOLLAR' || unit === 'MICRO_USD') {
    return rawValue / 1_000_000;
  }
  if (unit === 'CENT' || unit === 'CENTS' || unit === 'USD_CENT') {
    return rawValue / 100;
  }
  if (unit === 'DOLLAR' || unit === 'DOLLARS' || unit === 'USD') return rawValue;
  return null;
}

function actualRunCostUsd(run: MonidRun | null): number | null {
  return moneyToUsd(run?.cost) ?? moneyToUsd(run?.billing?.actualCost);
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
      asText(row.full_content),
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

interface MonidRunOutcome {
  results: MonidSearchResult[];
  actualCostUsd: number | null;
  estimatedCostUsd: number;
}

interface MonidRawRunOutcome {
  output: unknown;
  succeeded: boolean;
  actualCostUsd: number | null;
  estimatedCostUsd: number;
}

async function runMonidTool(
  tool: MonidTool,
  input: Record<string, unknown>,
  key: string,
  itemCount: number,
  options: Required<Pick<MonidSearchOptions, 'timeoutMs'>>
    & Pick<MonidSearchOptions, 'fetchImpl' | 'signal'>,
): Promise<MonidRawRunOutcome> {
  const fetchImpl = options.fetchImpl || browserFetch;
  const estimatedCostUsd = estimatedPrice(tool, itemCount);
  const initial = await monidRequest<MonidRun>('run', key, {
    body: {
      provider: tool.provider,
      endpoint: tool.endpoint,
      input,
    },
    timeoutMs: options.timeoutMs,
    fetchImpl,
    signal: options.signal,
  });
  const run = await completedRun(initial, key, options);
  return {
    output: run?.output,
    succeeded: !!run && providerSucceeded(run),
    actualCostUsd: actualRunCostUsd(run),
    estimatedCostUsd,
  };
}

async function runSearch(
  tool: MonidTool,
  query: string,
  key: string,
  options: Required<Pick<MonidSearchOptions, 'maxResultsPerQuery' | 'maxTokensPerPage' | 'timeoutMs'>> & Pick<MonidSearchOptions, 'recency' | 'fetchImpl' | 'signal'>,
  role?: OctenToolRole,
): Promise<MonidRunOutcome> {
  const outcome = await runMonidTool(
    tool,
    buildSearchInput(tool, query, options, role),
    key,
    options.maxResultsPerQuery,
    options,
  );
  return {
    results: outcome.succeeded ? normalizeMonidSearchOutput(outcome.output) : [],
    actualCostUsd: outcome.actualCostUsd,
    estimatedCostUsd: outcome.estimatedCostUsd,
  };
}

interface BudgetedToolRunOptions extends MonidSearchOptions {
  itemCount: number;
  buildInput: (allowedItemCount: number) => Record<string, unknown>;
}

async function runBudgetedTool(
  key: string,
  tool: MonidTool,
  options: BudgetedToolRunOptions,
): Promise<MonidRawRunOutcome | null> {
  const explicitMaxPriceUsd = Number.isFinite(options.maxPriceUsd)
    ? Math.max(0.001, Number(options.maxPriceUsd))
    : null;
  const session = explicitMaxPriceUsd == null ? activeBudgetSession : null;
  const mode = session?.mode || options.budgetMode || 'adaptive';
  const profile = budgetProfile(mode);
  const fetchImpl = options.fetchImpl || browserFetch;
  const timeoutMs = Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 20_000));
  const signal = combineSignals(options.signal, session?.controller.signal);
  if (signal?.aborted) return null;

  if (session) {
    await ensureSessionWallet(session, key, fetchImpl, timeoutMs, signal);
    if (signal?.aborted) return null;
  }
  const plannedAvailable = explicitMaxPriceUsd ?? (
    session
      ? Math.max(0, session.totalBudgetUsd - sessionAccountedSpend(session) - session.reservedUsd)
      : profile.minimumBatchUsd
  );
  const available = explicitMaxPriceUsd ?? (
    session && profile.allowWalletEscalation
      ? sessionWalletRemaining(session)
      : Math.min(profile.maxPerRunUsd, plannedAvailable)
  );
  const allowedItemCount = affordableResultCount(
    tool,
    Math.max(1, Math.floor(options.itemCount)),
    available,
  );
  if (allowedItemCount < 1) return null;

  const estimatedCostUsd = estimatedPrice(tool, allowedItemCount);
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) return null;
  if (session) {
    session.reservedUsd += estimatedCostUsd;
    emitBudgetSnapshot(session);
  }

  let outcome: MonidRawRunOutcome = {
    output: null,
    succeeded: false,
    actualCostUsd: null,
    estimatedCostUsd,
  };
  try {
    outcome = await runMonidTool(
      tool,
      options.buildInput(allowedItemCount),
      key,
      allowedItemCount,
      { timeoutMs, fetchImpl, signal },
    );
    return outcome;
  } catch {
    return outcome;
  } finally {
    if (session) {
      session.reservedUsd = Math.max(0, session.reservedUsd - estimatedCostUsd);
      if (outcome.actualCostUsd != null) session.actualSpentUsd += outcome.actualCostUsd;
      else session.estimatedSpentUsd += outcome.estimatedCostUsd;
      session.runsCompleted += 1;
      emitBudgetSnapshot(session);
    }
  }
}

function octenDataResults(output: unknown): Record<string, unknown>[] {
  if (!output || typeof output !== 'object') return [];
  const root = output as Record<string, unknown>;
  const data = root.data && typeof root.data === 'object'
    ? root.data as Record<string, unknown>
    : root;
  return Array.isArray(data.results)
    ? data.results.filter((entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object')
    : [];
}

export async function monidExtractUrlsWithKey(
  key: string,
  urls: string[],
  query = '',
  options: MonidSearchOptions = {},
): Promise<MonidExtractResult[]> {
  const normalizedKey = key.trim();
  const uniqueUrls = [...new Set(urls
    .map((url) => canonicalUrl(url.trim()))
    .filter((url) => /^https?:\/\//i.test(url)))]
    .slice(0, 20);
  if (!normalizedKey || !uniqueUrls.length) return [];

  const timeoutMs = Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 20_000));
  const fetchImpl = options.fetchImpl || browserFetch;
  const signal = combineSignals(options.signal, activeBudgetSession?.controller.signal);
  const tool = await resolvedOctenTool(normalizedKey, 'extract', {
    timeoutMs,
    fetchImpl,
    signal,
  });
  if (!tool || signal?.aborted) return [];

  const outcome = await runBudgetedTool(normalizedKey, tool, {
    ...options,
    timeoutMs,
    fetchImpl,
    signal,
    itemCount: uniqueUrls.length,
    buildInput: (allowedItemCount) => ({
      urls: uniqueUrls.slice(0, allowedItemCount),
      ...(query.trim() ? { query: query.trim().slice(0, 500) } : {}),
      max_age_seconds: 300,
      format: 'markdown',
      timeout: Math.min(25, Math.max(5, Math.floor(timeoutMs / 1000))),
      include_images: false,
      include_videos: false,
      include_audio: false,
    }),
  });
  if (!outcome?.succeeded) return [];

  const seen = new Set<string>();
  const results: MonidExtractResult[] = [];
  for (const row of octenDataResults(outcome.output)) {
    const rawUrl = asText(row.url);
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const url = canonicalUrl(rawUrl);
    if (seen.has(url)) continue;
    const status = asText(row.status).toLowerCase();
    if (status && !['success', 'completed', 'ok'].includes(status)) continue;
    const content = asText(row.full_content || row.content || row.markdown || row.text);
    const snippet = asText(row.highlights || row.highlight || row.snippet);
    if (!content && !snippet) continue;
    seen.add(url);
    const rawDate = asText(row.time_published || row.published_date || row.date);
    results.push({
      title: asText(row.title) || rawUrl,
      url,
      content,
      snippet,
      date: rawDate ? rawDate.slice(0, 10) : undefined,
    });
  }
  return results;
}

function queryTerms(queries: string[]): Set<string> {
  return new Set(
    queries.join(' ').toLowerCase().split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
}

function needsSemanticRerank(results: MonidSearchResult[], queries: string[]): boolean {
  if (results.length < 8) return false;
  const terms = queryTerms(queries);
  if (!terms.size) return false;
  const requiredOverlap = terms.size >= 5 ? 2 : 1;
  const weakResults = results.filter((result) => {
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    const overlap = [...terms].filter((term) => haystack.includes(term)).length;
    return overlap < requiredOverlap;
  }).length;
  const quality = summarizeSearchQuality(results, queries);
  return results.length > 12
    || weakResults >= Math.ceil(results.length / 3)
    || quality.score < 65;
}

function embeddingRows(output: unknown): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  for (const row of octenDataResults(output)) {
    const index = Number(row.index);
    if (!Number.isInteger(index) || !Array.isArray(row.embedding)) continue;
    const vector = row.embedding.map(Number);
    if (vector.length && vector.every(Number.isFinite)) rows.set(index, vector);
  }
  return rows;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export async function rerankMonidSearchResultsWithKey(
  key: string,
  results: MonidSearchResult[],
  queries: string[],
  options: MonidSearchOptions = {},
): Promise<MonidSearchResult[]> {
  if (!key.trim() || !needsSemanticRerank(results, queries)) return results;
  const timeoutMs = Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 15_000));
  const fetchImpl = options.fetchImpl || browserFetch;
  const signal = combineSignals(options.signal, activeBudgetSession?.controller.signal);
  const tool = await resolvedOctenTool(key.trim(), 'embedding', {
    timeoutMs,
    fetchImpl,
    signal,
  });
  if (!tool || signal?.aborted) return results;

  const candidates = results.slice(0, 20);
  const texts = [
    queries.join('\n').slice(0, 2000),
    ...candidates.map((result) =>
      `${result.title}\n${result.snippet}`.slice(0, 2500)),
  ];
  const outcome = await runBudgetedTool(key.trim(), tool, {
    ...options,
    timeoutMs,
    fetchImpl,
    signal,
    itemCount: texts.length,
    buildInput: (allowedItemCount) => ({
      input: texts.slice(0, allowedItemCount),
      model: 'octen-embedding-0.6b',
      dimension: 256,
    }),
  });
  if (!outcome?.succeeded) return results;

  const vectors = embeddingRows(outcome.output);
  const queryVector = vectors.get(0);
  if (!queryVector || vectors.size < 3) return results;
  const rerankedCount = Math.min(candidates.length, vectors.size - 1);
  const reranked = candidates.slice(0, rerankedCount)
    .map((result, index) => ({
      result,
      index,
      score: cosineSimilarity(queryVector, vectors.get(index + 1) || []),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ result }) => result);
  return [
    ...reranked,
    ...results.slice(rerankedCount),
  ];
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

  const explicitMaxPriceUsd = Number.isFinite(options.maxPriceUsd)
    ? Math.max(0.001, Number(options.maxPriceUsd))
    : null;
  const session = explicitMaxPriceUsd == null ? activeBudgetSession : null;
  const mode = session?.mode || options.budgetMode || 'adaptive';
  const profile = budgetProfile(mode);
  const fetchImpl = options.fetchImpl || browserFetch;
  const signal = combineSignals(options.signal, session?.controller.signal);
  const resolvedOptions = {
    maxResultsPerQuery: Math.min(20, Math.max(1, options.maxResultsPerQuery ?? 8)),
    maxTokensPerPage: Math.min(4000, Math.max(200, options.maxTokensPerPage ?? 1500)),
    timeoutMs: Math.min(30_000, Math.max(5_000, options.timeoutMs ?? 15_000)),
    recency: options.recency,
    strategy: options.strategy || 'search',
    fetchImpl,
    signal,
  };
  if (signal?.aborted) return [];
  if (session) {
    await ensureSessionWallet(
      session,
      normalizedKey,
      fetchImpl,
      resolvedOptions.timeoutMs,
      signal,
    );
    if (signal?.aborted) return [];
  }

  const plannedAvailableBeforeDiscovery = explicitMaxPriceUsd ?? (
    session
      ? Math.max(
        0,
        session.totalBudgetUsd - sessionAccountedSpend(session) - session.reservedUsd,
      )
      : profile.minimumBatchUsd
  );
  const availableBeforeDiscovery = explicitMaxPriceUsd ?? (
    session && profile.allowWalletEscalation
      ? sessionWalletRemaining(session)
      : plannedAvailableBeforeDiscovery
  );
  if (availableBeforeDiscovery < 0.001) {
    if (session) {
      session.skippedQueries += uniqueQueries.length;
      emitBudgetSnapshot(session);
    }
    return [];
  }
  const softCapUsd = explicitMaxPriceUsd
    ?? Math.min(profile.softPerRunUsd, availableBeforeDiscovery);
  const hardCapUsd = explicitMaxPriceUsd
    ?? (profile.allowWalletEscalation
      ? availableBeforeDiscovery
      : Math.min(profile.maxPerRunUsd, availableBeforeDiscovery));
  const selection = await resolveSearchToolWithinBudget(
    normalizedKey,
    resolvedOptions,
    softCapUsd,
    hardCapUsd,
  );
  if (!selection || signal?.aborted) {
    if (session && !signal?.aborted) {
      session.skippedQueries += uniqueQueries.length;
      emitBudgetSnapshot(session);
    }
    return [];
  }

  const availableAfterDiscovery = explicitMaxPriceUsd ?? (
    session
      ? Math.max(
        0,
        session.totalBudgetUsd - sessionAccountedSpend(session) - session.reservedUsd,
      )
      : profile.minimumBatchUsd
  );
  const { tool, role } = selection;
  const perRunCeilingUsd = explicitMaxPriceUsd
    ?? Math.min(
      selection.maxPriceUsd,
      session && profile.allowWalletEscalation
        ? sessionWalletRemaining(session)
        : availableAfterDiscovery,
    );
  const affordableMaxResults = affordableResultCount(
    tool,
    resolvedOptions.maxResultsPerQuery,
    perRunCeilingUsd,
  );
  if (affordableMaxResults < 1) {
    if (session) {
      session.skippedQueries += uniqueQueries.length;
      emitBudgetSnapshot(session);
    }
    return [];
  }
  const estimatedCostPerRunUsd = estimatedPrice(tool, affordableMaxResults);
  if (!Number.isFinite(estimatedCostPerRunUsd) || estimatedCostPerRunUsd < 0) return [];

  let allowedQueryCount = uniqueQueries.length;
  if (explicitMaxPriceUsd == null && estimatedCostPerRunUsd > 0) {
    allowedQueryCount = Math.min(
      uniqueQueries.length,
      Math.max(0, Math.floor((availableAfterDiscovery + 1e-9) / estimatedCostPerRunUsd)),
    );
  }
  if (allowedQueryCount < 1) {
    if (session) {
      session.skippedQueries += uniqueQueries.length;
      emitBudgetSnapshot(session);
    }
    return [];
  }

  const selectedQueries = uniqueQueries.slice(0, allowedQueryCount);
  const reservationUsd = session ? estimatedCostPerRunUsd * allowedQueryCount : 0;
  if (session) {
    session.reservedUsd += reservationUsd;
    session.skippedQueries += uniqueQueries.length - allowedQueryCount;
    emitBudgetSnapshot(session);
  }
  const runOptions = {
    ...resolvedOptions,
    maxResultsPerQuery: affordableMaxResults,
  };

  const outcomes: MonidRunOutcome[] = Array.from(
    { length: selectedQueries.length },
    () => ({
      results: [],
      actualCostUsd: null,
      estimatedCostUsd: estimatedCostPerRunUsd,
    }),
  );
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(
      explicitMaxPriceUsd == null ? profile.concurrency : 3,
      selectedQueries.length,
    ),
  }, async () => {
    while (cursor < selectedQueries.length) {
      const index = cursor++;
      try {
        outcomes[index] = await runSearch(
          tool,
          selectedQueries[index],
          normalizedKey,
          runOptions,
          role,
        );
      } catch {
        outcomes[index] = {
          results: [],
          actualCostUsd: null,
          estimatedCostUsd: estimatedCostPerRunUsd,
        };
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    if (session) {
      session.reservedUsd = Math.max(0, session.reservedUsd - reservationUsd);
      for (const outcome of outcomes) {
        if (outcome.actualCostUsd != null) {
          session.actualSpentUsd += outcome.actualCostUsd;
        } else {
          session.estimatedSpentUsd += outcome.estimatedCostUsd;
        }
      }
      session.runsCompleted += outcomes.length;
      emitBudgetSnapshot(session);
    }
  }
  const merged = interleave(outcomes.map((outcome) => outcome.results));
  if (!options.semanticRerank || resolvedOptions.strategy !== 'broad') return merged;
  return rerankMonidSearchResultsWithKey(
    normalizedKey,
    merged,
    selectedQueries,
    {
      ...options,
      timeoutMs: resolvedOptions.timeoutMs,
      fetchImpl,
      signal,
      budgetMode: mode,
    },
  );
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
  octenToolCache.clear();
}
