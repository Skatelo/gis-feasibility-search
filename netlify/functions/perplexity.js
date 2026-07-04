// Perplexity Search API proxy — api.perplexity.ai does not send CORS headers,
// so the browser cannot POST to it directly. This forwards the search request
// server-side. The user's own API key is passed through in the Authorization
// header; nothing is stored.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };
  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const res = await fetch('https://api.perplexity.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
      body: event.body || '{}',
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'content-type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
