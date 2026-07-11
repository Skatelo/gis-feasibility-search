// Same-origin proxy for Perplexity chat completions. The browser supplies the
// user's key for this request only; the function does not store credentials.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    if (!/^Bearer\s+\S+/i.test(auth)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Perplexity API key required' }) };
    }
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
      body: event.body || '{}',
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: String(error?.message || error).slice(0, 300) }),
    };
  }
};
