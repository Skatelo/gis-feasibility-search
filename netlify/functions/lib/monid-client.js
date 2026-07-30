// MONID CLIENT — https://monid.ai/docs
//
// Monid is a pay-per-use marketplace of data endpoints (Apify actors, PDL, …).
// Here it serves as TIER 2 of the extraction chain: when the Crawlee/Cheerio
// scrape returns nothing usable for a URL, a Monid web-scraping endpoint is run
// against it before falling through to the visual reader.
//
// Contract (verified against the docs):
//   POST /v1/discover  { query }                  → { items: [ { provider, endpoint, … } ] }
//   POST /v1/inspect   { provider, endpoint }     → full endpoint detail incl. input schema
//   POST /v1/run       { provider, endpoint, input }
//        • sync providers  → 200 with { status, output, providerResponse }
//        • async providers → 202 with { runId, status: "READY" }
//   GET  /v1/runs/:runId                          → poll until a terminal status
//
// Auth: `Authorization: Bearer monid_live_…` plus `x-workspace-id`.
// Terminal statuses: COMPLETED | FAILED | BLOCKED | STOPPED | TIMED_OUT.
// A run can be COMPLETED while providerResponse.httpStatus is 4xx — that means
// "ran fine, no data", which we treat as an empty result rather than an error.
//
// EVERY function here fails soft (returns null/[]), because this is one tier of a
// fallback chain: a Monid outage must never break a crawl.

const MONID_BASE = 'https://api.monid.ai';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT']);

/** Accept both the server name and the VITE_ variant, since the same key is
 *  often already present for local dev. */
function monidKey() {
  return String(process.env.MONID_API_KEY || process.env.VITE_MONID_API_KEY || '').trim();
}

export function monidConfigured() {
  return !!monidKey();
}

function monidHeaders() {
  const headers = {
    Authorization: `Bearer ${monidKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  // Verified optional: /v1/run succeeds without it on a single-workspace key.
  // Sent when configured so multi-workspace keys target the right one.
  const workspace = String(process.env.MONID_WORKSPACE_ID || process.env.VITE_MONID_WORKSPACE_ID || '').trim();
  if (workspace) headers['x-workspace-id'] = workspace;
  return headers;
}

async function monidFetch(path, { method = 'POST', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${MONID_BASE}${path}`, {
      method,
      headers: monidHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, payload };
  } catch (error) {
    return { status: 0, payload: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Search the catalog for endpoints matching a plain-language query. */
export async function monidDiscover(query, limit = 10) {
  if (!monidConfigured()) return [];
  const { status, payload } = await monidFetch('/v1/discover', { body: { query, limit } });
  if (status !== 200 || !payload) return [];
  const items = Array.isArray(payload.items) ? payload.items
    : Array.isArray(payload.results) ? payload.results
    : [];
  return items;
}

/** Full endpoint detail, including the input schema used to shape run input. */
export async function monidInspect(provider, endpoint) {
  if (!monidConfigured()) return null;
  const { status, payload } = await monidFetch('/v1/inspect', { body: { provider, endpoint } });
  return status === 200 ? payload : null;
}

/**
 * Execute an endpoint, transparently handling the sync (200) and async (202 +
 * poll) modes. Returns the provider `output`, or null when nothing usable came
 * back — including the normal "COMPLETED but provider returned 404" case.
 */
export async function monidRun(provider, endpoint, input = {}, { timeoutMs = 90000, pollMs = 4000 } = {}) {
  if (!monidConfigured()) return null;
  const started = Date.now();
  const first = await monidFetch('/v1/run', { body: { provider, endpoint, input }, timeoutMs: 30000 });

  // Sync provider: the run already finished and the HTTP status mirrors theirs.
  if (first.status !== 202) {
    const payload = first.payload;
    if (!payload) return null;
    if (payload.status && payload.status !== 'COMPLETED') return null;
    if (Number(payload?.providerResponse?.httpStatus || 200) >= 400) return null;
    return payload.output ?? null;
  }

  // Async provider: poll the run until it reaches a terminal status.
  const runId = first.payload?.runId;
  if (!runId) return null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const poll = await monidFetch(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'GET', body: undefined, timeoutMs: 15000 });
    const payload = poll.payload;
    if (!payload) continue;
    if (!TERMINAL.has(String(payload.status || ''))) continue;
    if (payload.status !== 'COMPLETED') return null;
    if (Number(payload?.providerResponse?.httpStatus || 200) >= 400) return null;
    return payload.output ?? null;
  }
  return null; // budget exhausted — the caller falls through to the next tier
}

// ---------------------------------------------------------------------------
// Web-scrape endpoint resolution
// ---------------------------------------------------------------------------

// Resolved once per warm container: discovery costs a round trip and the answer
// is stable. Env vars let an operator pin an exact endpoint and skip discovery.
let cachedEndpoint;

const URL_INPUT_KEYS = ['url', 'startUrls', 'start_urls', 'urls', 'links', 'website', 'websiteUrl', 'pageUrl', 'targetUrl'];

/** Extra options worth setting when the endpoint's schema exposes them. */
const PREFERRED_OPTIONS = {
  // Drop nav/header/footer/sidebar noise so the model sees the substance.
  useMainContentOnly: true,
  // Government viewers are JavaScript-heavy; give them a moment to paint.
  waitForMs: 2500,
};

/**
 * Shape the run input from the endpoint's real schema.
 *
 * VERIFIED against Monid's /v1/inspect: `input` is keyed by REQUEST SECTION —
 * e.g. context.dev's /web/scrape/markdown exposes `input.queryParams` with a
 * JSON Schema inside. A flat `{ url }` is rejected with
 * "queryParams.url: expected string, received undefined", so the URL must be
 * nested under its section.
 */
export function buildUrlInput(schema, url) {
  // Section-keyed schema (queryParams / body / pathParams / …).
  if (schema && typeof schema === 'object' && !schema.properties) {
    for (const [section, sectionSchema] of Object.entries(schema)) {
      const properties = sectionSchema?.properties;
      if (!properties || typeof properties !== 'object') continue;
      const inner = buildUrlInput(sectionSchema, url);
      if (inner && Object.keys(inner).length) return { [section]: inner };
    }
  }

  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!properties) return { url };

  const input = {};
  for (const key of URL_INPUT_KEYS) {
    const prop = properties[key];
    if (!prop) continue;
    const type = String(prop.type || '');
    if (type === 'array') {
      // Apify actors usually want [{ url }]; some want plain strings.
      input[key] = String(prop.items?.type || '') === 'string' ? [url] : [{ url }];
    } else {
      input[key] = url;
    }
    break;
  }
  if (!Object.keys(input).length) return { url };

  for (const [option, value] of Object.entries(PREFERRED_OPTIONS)) {
    if (properties[option]) input[option] = value;
  }
  return input;
}

/** Provider/endpoint (and its input schema) for a general web scrape. */
export async function resolveScrapeEndpoint() {
  if (cachedEndpoint !== undefined) return cachedEndpoint;
  if (!monidConfigured()) { cachedEndpoint = null; return cachedEndpoint; }

  // Default to the endpoint verified best for this job: context.dev's
  // /web/scrape/markdown returns LLM-ready markdown and handles JavaScript
  // rendering, anti-bot bypass, residential proxies and native PDF parsing
  // server-side — exactly the pages tier 1 fails on. Env vars override it.
  const pinnedProvider = String(process.env.MONID_SCRAPE_PROVIDER || 'context.dev').trim();
  const pinnedEndpoint = String(process.env.MONID_SCRAPE_ENDPOINT || '/web/scrape/markdown').trim();
  if (pinnedProvider && pinnedEndpoint) {
    const detail = await monidInspect(pinnedProvider, pinnedEndpoint);
    if (detail) {
      cachedEndpoint = { provider: pinnedProvider, endpoint: pinnedEndpoint, schema: detail.input ?? detail.inputSchema ?? null };
      return cachedEndpoint;
    }
    // Pinned endpoint unavailable — fall through to discovery.
  }

  const candidates = await monidDiscover('website content scraper extract page text markdown');
  for (const item of candidates.slice(0, 5)) {
    const provider = item?.provider || item?.providerSlug;
    const endpoint = item?.endpoint || item?.path;
    if (!provider || !endpoint) continue;
    // Skip obvious social/single-site actors — we need a general web scraper.
    if (/tweet|twitter|instagram|tiktok|facebook|linkedin|reddit|youtube/i.test(String(endpoint))) continue;
    const detail = await monidInspect(provider, endpoint);
    cachedEndpoint = { provider, endpoint, schema: detail?.input ?? detail?.inputSchema ?? null };
    return cachedEndpoint;
  }
  cachedEndpoint = null;
  return cachedEndpoint;
}

/** Pull readable text out of whatever shape the provider returned. */
export function textFromMonidOutput(output) {
  const seen = new Set();
  const parts = [];
  const KEYS = ['markdown', 'text', 'content', 'body', 'pageContent', 'html_text', 'textContent', 'description'];
  const walk = (value, depth = 0) => {
    if (value == null || depth > 4 || parts.join('\n').length > 40000) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (typeof value !== 'object') return;
    for (const key of KEYS) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim().length > 80 && !seen.has(candidate)) {
        seen.add(candidate);
        parts.push(candidate.trim());
      }
    }
    Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  walk(output);
  return parts.join('\n\n').trim();
}

/** TIER 2: scrape one URL through Monid. Returns text, or '' if unavailable. */
export async function monidScrapeUrl(url, { timeoutMs = 90000 } = {}) {
  if (!monidConfigured()) return '';
  try {
    const target = await resolveScrapeEndpoint();
    if (!target) return '';
    const input = buildUrlInput(target.schema, url);
    const output = await monidRun(target.provider, target.endpoint, input, { timeoutMs });
    return textFromMonidOutput(output);
  } catch {
    return '';
  }
}
