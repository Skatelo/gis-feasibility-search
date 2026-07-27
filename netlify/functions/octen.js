// Octen Search API proxy — mirrors the Perplexity proxy so the browser can run
// live web search without a CORS-blocked direct call. The user's own API key is
// passed through and never stored.
//
// Octen authenticates with an `x-api-key` header (Bearer is also accepted). The
// client sends `Authorization: Bearer <key>`; we forward BOTH forms so either
// scheme works. Docs: https://docs.octen.ai/api-reference/search

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Endpoint allowlist. The client picks one with ?endpoint=… so a single proxy
// serves every Octen capability the app uses (ranked search, page/document
// extraction, and multi-query broad search) without opening an SSRF hole.
const OCTEN_ENDPOINTS = {
  search: 'https://api.octen.ai/search',
  extract: 'https://api.octen.ai/extract',
  'broad-search': 'https://api.octen.ai/broad-search',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };
  try {
    const headers = event.headers || {};
    const auth = headers.authorization || headers.Authorization || '';
    const explicitKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
    const key = (explicitKey || auth.replace(/^Bearer\s+/i, '')).trim();
    if (!key) {
      return { statusCode: 401, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 401, msg: 'Missing Octen API key' }) };
    }

    const requested = (event.queryStringParameters && event.queryStringParameters.endpoint) || 'search';
    const target = OCTEN_ENDPOINTS[requested];
    if (!target) {
      return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 400, msg: `Unknown Octen endpoint "${requested}"` }) };
    }

    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': key,
        Authorization: `Bearer ${key}`,
      },
      body: event.body || '{}',
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'content-type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
