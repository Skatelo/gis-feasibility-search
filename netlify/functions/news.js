// newsdata.io proxy — real estate / construction / housing-market news, biased
// to North Carolina. newsdata.io is server/key-oriented (and CORS-restricted),
// so this function holds/relays the key and returns a compact, CORS-enabled
// article list. The key comes from the NEWSDATA_API_KEY Netlify env var, or an
// `x-newsdata-key` header (the user's Settings key).
//
// Free-tier-safe: simple keyword queries only (no AND/OR operators, no category
// filter — those error or over-restrict on the free plan). We try a few queries
// and merge until we have enough, surfacing the real newsdata error if all fail.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-newsdata-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const QUERIES = ['North Carolina real estate', 'real estate', 'housing market', 'construction'];

async function newsdata(key, q) {
  // /latest with a single keyword query, US English. No category/operators so it
  // works on the free plan.
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}&language=en&country=us&q=${encodeURIComponent(q)}`;
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    return { rows: [], error: String((e && e.message) || e) };
  }
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok || body?.status === 'error') {
    const msg = body?.results?.message || body?.message || `HTTP ${r.status}`;
    return { rows: [], error: msg };
  }
  return { rows: Array.isArray(body?.results) ? body.results : [] };
}

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const headers = event.headers || {};
  const key = process.env.NEWSDATA_API_KEY ||
    headers['x-newsdata-key'] || headers['X-Newsdata-Key'] ||
    (event.queryStringParameters || {}).key || '';
  if (!key) {
    return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'no-key', message: 'newsdata.io key not configured', articles: [] }) };
  }

  const results = [];
  const seen = new Set();
  let lastError = null;
  for (const q of QUERIES) {
    if (results.length >= 10) break;
    const { rows, error } = await newsdata(key, q);
    if (error) { lastError = error; continue; }
    for (const a of rows) {
      if (a && a.title && a.link && !seen.has(a.link)) {
        seen.add(a.link);
        results.push(a);
      }
    }
  }

  if (results.length === 0) {
    return {
      statusCode: lastError ? 502 : 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: lastError ? 'api-error' : 'empty', message: lastError || 'No articles returned.', articles: [] }),
    };
  }

  const articles = results.slice(0, 24).map((a) => ({
    title: a.title,
    link: a.link,
    image: a.image_url || null,
    source: a.source_name || a.source_id || '',
    sourceIcon: a.source_icon || null,
    pubDate: a.pubDate || null,
    description: a.description || '',
  }));

  return {
    statusCode: 200,
    headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' },
    body: JSON.stringify({ articles }),
  };
};
