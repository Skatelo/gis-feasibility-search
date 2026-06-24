// newsdata.io proxy — real estate / construction / housing-market news, biased
// to North Carolina with a national fallback. newsdata.io is server/key-oriented
// (and CORS-restricted), so this function holds/relays the key and returns a
// compact, CORS-enabled article list. The key comes from the NEWSDATA_API_KEY
// Netlify env var, or an `x-newsdata-key` header (the user's Settings key).
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-newsdata-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function newsdata(key, q) {
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}` +
    `&language=en&country=us&category=business&q=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d?.results) ? d.results : [];
}

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const headers = event.headers || {};
  const key = process.env.NEWSDATA_API_KEY ||
    headers['x-newsdata-key'] || headers['X-Newsdata-Key'] ||
    (event.queryStringParameters || {}).key || '';
  if (!key) {
    return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'newsdata key not configured', articles: [] }) };
  }

  try {
    // NC-tailored first; broaden to national real-estate news if too few.
    let results = await newsdata(key, 'North Carolina real estate housing construction');
    if (results.length < 4) {
      const more = await newsdata(key, 'real estate OR housing market OR construction OR homebuilding');
      const seen = new Set(results.map((a) => a.link));
      for (const a of more) if (a.link && !seen.has(a.link)) { results.push(a); seen.add(a.link); }
    }

    const articles = results
      .filter((a) => a && a.title && a.link)
      .slice(0, 24)
      .map((a) => ({
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
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e), articles: [] }) };
  }
};
