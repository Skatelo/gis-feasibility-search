// RentCast proxy — RentCast's API doesn't send browser CORS headers, so calling
// it directly from the SPA fails. This serverless function forwards the request
// (with the user's own API key, passed per-call) and returns the JSON with CORS
// headers. The key is never stored server-side; it's only relayed for the call.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-rentcast-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const address = q.address || '';
  const headers = event.headers || {};
  const key = headers['x-rentcast-key'] || headers['X-Rentcast-Key'] || q.key || '';

  if (!address || !key) {
    return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'address and key are required' }) };
  }

  try {
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { 'X-Api-Key': key, accept: 'application/json' } });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'content-type': 'application/json' }, body: text || '[]' };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
