// Enformion Go proxy — skip tracing (individuals & businesses). Enformion's API
// doesn't send browser CORS headers, so the SPA can't call it directly; this
// serverless function forwards the request with the user's own Enformion
// credentials (passed per-call via headers, never stored server-side).
//
// It tries the PRODUCTION host first, then the dev/sandbox host, so it works
// regardless of which the account is provisioned on, and ALWAYS returns HTTP 200
// with an envelope { ok, status, host, data } so the client can show the real
// upstream status (auth vs. not-found vs. no-match) instead of a blind failure.
//
// ESM syntax because the project's package.json is "type": "module".

const HOSTS = ['https://api.enformion.com', 'https://devapi.enformion.com'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-enformion-name, x-enformion-password, x-enformion-search-type, x-enformion-path',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_PATHS = new Set(['/Contact/Enrich', '/PersonSearch', '/BusinessV2Search']);

const json = (obj) => ({ statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(obj) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json({ ok: false, status: 405, error: 'POST only' });

  const h = event.headers || {};
  const apName = h['x-enformion-name'] || h['X-Enformion-Name'] || '';
  const apPassword = h['x-enformion-password'] || h['X-Enformion-Password'] || '';
  const searchType = h['x-enformion-search-type'] || h['X-Enformion-Search-Type'] || '';
  const path = h['x-enformion-path'] || h['X-Enformion-Path'] || '';

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

  let last = { status: 0, host: '', text: '' };
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { method: 'POST', headers, body: event.body || '{}' });
      const text = await res.text();
      last = { status: res.status, host, text };
      if (res.ok) break;                 // success — use it
      if (![401, 403, 404].includes(res.status)) break; // a real (non-auth/route) error → don't retry the other host
      // else: auth/route failure on this host → try the next host
    } catch (e) {
      last = { status: 0, host, text: String((e && e.message) || e) };
    }
  }

  const ok = last.status >= 200 && last.status < 300;
  let data = null;
  try { data = last.text ? JSON.parse(last.text) : null; } catch { /* non-JSON (likely an error page) */ }
  return json({ ok, status: last.status, host: last.host, data, error: ok ? undefined : (data ? undefined : String(last.text).slice(0, 300)) });
};
