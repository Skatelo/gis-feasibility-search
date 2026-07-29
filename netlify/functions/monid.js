const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

const POST_ENDPOINTS = new Set(['discover', 'inspect', 'run']);
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{20,32}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const headers = event.headers || {};
    const auth = headers.authorization || headers.Authorization || '';
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    if (!key) return json(401, { error: 'Missing Monid API key' });

    const endpoint = event.queryStringParameters?.endpoint || 'discover';
    let target;
    let method;
    let body;

    if (POST_ENDPOINTS.has(endpoint)) {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      target = `https://api.monid.ai/v1/${endpoint}`;
      method = 'POST';
      body = event.body || '{}';
    } else if (endpoint === 'runs') {
      if (event.httpMethod !== 'GET') return json(405, { error: 'GET required' });
      const runId = String(event.queryStringParameters?.runId || '').trim();
      if (!RUN_ID.test(runId)) return json(400, { error: 'Invalid Monid run ID' });
      target = `https://api.monid.ai/v1/runs/${encodeURIComponent(runId)}`;
      method = 'GET';
    } else {
      return json(400, { error: `Unknown Monid endpoint "${endpoint}"` });
    }

    const response = await fetch(target, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body } : {}),
    });
    const text = await response.text();
    return {
      statusCode: response.status,
      headers: { ...CORS, 'content-type': response.headers.get('content-type') || 'application/json' },
      body: text,
    };
  } catch (error) {
    return json(502, { error: String(error?.message || error) });
  }
};
