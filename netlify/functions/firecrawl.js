// Firecrawl API proxy. Keeps FIRECRAWL_API_KEY server-side when configured,
// while still allowing a user's saved browser key to pass through via
// Authorization. Only search and scrape are exposed.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-firecrawl-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const allowedEndpoints = new Set(['search', 'scrape']);

function bearerFrom(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  try {
    const parsed = event.body ? JSON.parse(event.body) : {};
    const endpoint = String(event.queryStringParameters?.endpoint || parsed.endpoint || parsed.action || '').trim().toLowerCase();
    if (!allowedEndpoints.has(endpoint)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'endpoint must be search or scrape' }) };
    }

    const headerKey = bearerFrom(event.headers) || event.headers['x-firecrawl-key'] || event.headers['X-Firecrawl-Key'] || '';
    const apiKey = String(headerKey || process.env.FIRECRAWL_API_KEY || '').trim();
    if (!apiKey) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing Firecrawl API key' }) };
    }

    const { endpoint: _endpoint, action: _action, apiKey: _apiKey, ...payload } = parsed;
    const res = await fetch(`https://api.firecrawl.dev/v2/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'content-type': 'application/json' }, body: text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
