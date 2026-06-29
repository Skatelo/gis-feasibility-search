// Enformion Go proxy — skip tracing (individuals & businesses). Enformion's API
// doesn't send browser CORS headers, so the SPA can't call it directly; this
// serverless function forwards the request with the user's own Enformion
// credentials (passed per-call via headers, never stored server-side) and
// returns the JSON with CORS headers.
//
// Generic: the caller supplies the endpoint path + galaxy-search-type, so one
// function serves Contact Enrich, Person Search, and Business Search.
//
// ESM syntax because the project's package.json is "type": "module".

const ENFORMION_HOST = 'https://devapi.enformion.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-enformion-name, x-enformion-password, x-enformion-search-type, x-enformion-path',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Only allow the known Enformion endpoints (no open proxy).
const ALLOWED_PATHS = new Set(['/Contact/Enrich', '/PersonSearch', '/BusinessV2Search']);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) };
  }

  const h = event.headers || {};
  const apName = h['x-enformion-name'] || h['X-Enformion-Name'] || '';
  const apPassword = h['x-enformion-password'] || h['X-Enformion-Password'] || '';
  const searchType = h['x-enformion-search-type'] || h['X-Enformion-Search-Type'] || '';
  const path = h['x-enformion-path'] || h['X-Enformion-Path'] || '';

  if (!apName || !apPassword || !searchType || !ALLOWED_PATHS.has(path)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Missing Enformion credentials / search-type, or unsupported path.' }),
    };
  }

  try {
    const res = await fetch(`${ENFORMION_HOST}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'galaxy-ap-name': apName,
        'galaxy-ap-password': apPassword,
        'galaxy-search-type': searchType,
      },
      body: event.body || '{}',
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: text || '{}',
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
