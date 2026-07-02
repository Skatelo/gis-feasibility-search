// BLS OEWS proxy — api.bls.gov does not send CORS headers, so the browser
// cannot POST to it directly. This forwards the timeseries request server-side.
// Public BLS data only; no credentials involved.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };
  try {
    const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: event.body || '{}',
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'content-type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
