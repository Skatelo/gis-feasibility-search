// Same-origin proxy for RealEstateAPI.com Property Detail.
// A user key may be relayed per request, or REALESTATEAPI_KEY may be configured
// as a server-side Netlify environment variable. Nothing is cached.

const UPSTREAM = 'https://api.realestateapi.com/v2/PropertyDetail';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, max-age=0',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function fetchWithAbort(url, init, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const address = String(input.address || '').replace(/\s+/g, ' ').trim();
  if (!address || !/\b(?:NC|SC)\b/i.test(address)) {
    return json(400, { error: 'A full North Carolina or South Carolina address is required.' });
  }

  const requestHeaders = event.headers || {};
  const key = requestHeaders['x-api-key']
    || requestHeaders['X-Api-Key']
    || process.env.REALESTATEAPI_KEY
    || '';
  if (!key) {
    return json(401, { error: 'RealEstateAPI key is not configured. Add it in Account Settings or set REALESTATEAPI_KEY on Netlify.' });
  }

  try {
    const response = await fetchWithAbort(UPSTREAM, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({
        address,
        exact_match: true,
        comps: false,
      }),
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: { ...CORS, 'content-type': response.headers.get('content-type') || 'application/json' },
      body: body || '{}',
    };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return json(timedOut ? 504 : 502, {
      error: timedOut
        ? 'RealEstateAPI timed out. Retry the on-demand lookup.'
        : String((error && error.message) || error),
    });
  }
};
