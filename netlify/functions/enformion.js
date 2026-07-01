// Enformion Go proxy — skip tracing, property records, debt & eviction search.
// Enformion's API doesn't send browser CORS headers, so the SPA can't call it
// directly; this serverless function forwards the request with the user's own
// Enformion credentials (passed per-call via headers, never stored server-side).
//
// The client tells us WHICH host to use via x-enformion-host ('prod' | 'dev')
// and handles failover itself — keeping each function invocation to ONE
// upstream call so it never exceeds the serverless 10s execution limit.
// Without the header we try prod then dev (legacy behavior), retrying on ANY
// failure (400s included — some search types only exist on one host).
// Every response is HTTP 200 with an envelope { ok, status, host, data, error }
// so the client can show the real upstream status instead of a blind failure.
//
// ESM syntax because the project's package.json is "type": "module".

const HOSTS = { prod: 'https://api.enformion.com', dev: 'https://devapi.enformion.com' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-enformion-name, x-enformion-password, x-enformion-search-type, x-enformion-path, x-enformion-host',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_PATHS = new Set([
  '/Contact/Enrich',
  '/PersonSearch',
  '/BusinessV2Search',
  '/PropertyV2Search', // Property Search V2 — deeds, transactions, mortgages, liens (galaxy-search-type: PropertyV2)
  '/DebtSearch/V2',    // Debt Search V2 (PRO) — bankruptcies, liens, judgments (galaxy-search-type: DebtV2)
  '/EvictionSearch',   // Eviction Search (PRO) — tenant/eviction history (galaxy-search-type: Eviction)
]);

const json = (obj) => ({ statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(obj) });

/** Fetch with a hard per-request timeout so one slow host can't consume the
 *  whole serverless execution window. */
async function fetchWithAbort(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json({ ok: false, status: 405, error: 'POST only' });

  const h = event.headers || {};
  const hv = (name) => h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
  const apName = hv('x-enformion-name');
  const apPassword = hv('x-enformion-password');
  const searchType = hv('x-enformion-search-type');
  const path = hv('x-enformion-path');
  const hostPref = String(hv('x-enformion-host')).toLowerCase();

  if (!apName || !apPassword || !searchType || !ALLOWED_PATHS.has(path)) {
    return json({ ok: false, status: 400, error: 'Missing Enformion credentials / search-type, or unsupported path.' });
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'galaxy-ap-name': apName,
    'galaxy-ap-password': apPassword,
    'galaxy-search-type': searchType,
  };

  const order = hostPref === 'dev' ? ['dev'] : hostPref === 'prod' ? ['prod'] : ['prod', 'dev'];
  // Budgets leave ~2s headroom under Netlify's 10s synchronous-function limit
  // (cold start + response marshalling count against it too).
  const perCallMs = order.length === 1 ? 8000 : 3800;

  let last = { status: 0, host: '', text: '' };
  for (const key of order) {
    const host = HOSTS[key];
    try {
      const res = await fetchWithAbort(`${host}${path}`, { method: 'POST', headers, body: event.body || '{}' }, perCallMs);
      const text = await res.text();
      last = { status: res.status, host, text };
      if (res.ok) break; // success — use it
      // else: ANY failure → try the next host (some search types only exist on one host)
    } catch (e) {
      const msg = String((e && e.name === 'AbortError') ? `Timed out after ${perCallMs}ms` : (e && e.message) || e);
      last = { status: 0, host, text: msg };
    }
  }

  const ok = last.status >= 200 && last.status < 300;
  let data = null;
  try { data = last.text ? JSON.parse(last.text) : null; } catch { /* non-JSON (likely an error page) */ }
  return json({ ok, status: last.status, host: last.host, data, error: ok ? undefined : (data ? undefined : String(last.text).slice(0, 300)) });
};
