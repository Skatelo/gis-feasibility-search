// Real estate / construction / housing-market news for North Carolina.
//
// Primary source is Google News RSS — KEYLESS and reliable, so the strip works
// with no setup. If a newsdata.io key is present (NEWSDATA_API_KEY env var or an
// `x-newsdata-key` header), its articles (which include images) are merged in
// first. Both are fetched server-side so there's no browser CORS issue.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-newsdata-key, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const decode = (s = '') => s
  .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .trim();

const grab = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : '';
};

const toIso = (raw) => {
  if (!raw) return null;
  // newsdata gives "YYYY-MM-DD HH:MM:SS" (UTC, no zone); RSS gives RFC-822.
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

async function googleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } }); } catch { return []; }
  if (!r.ok) return [];
  const xml = await r.text();
  const items = xml.split('<item>').slice(1).map((s) => s.split('</item>')[0]);
  return items.map((b) => {
    const titleRaw = grab(b, 'title');
    const source = grab(b, 'source');
    const title = source && titleRaw.endsWith(` - ${source}`) ? titleRaw.slice(0, -(source.length + 3)) : titleRaw;
    return { title, link: grab(b, 'link'), source, sourceIcon: null, image: null, pubDate: toIso(grab(b, 'pubDate')), description: '' };
  }).filter((a) => a.title && a.link);
}

async function newsdata(key, query) {
  const url = `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}&language=en&q=${encodeURIComponent(query)}`;
  let r;
  try { r = await fetch(url); } catch { return []; }
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok || body?.status === 'error') return [];
  return (Array.isArray(body?.results) ? body.results : []).map((a) => ({
    title: a.title, link: a.link, source: a.source_name || a.source_id || '', sourceIcon: a.source_icon || null,
    image: a.image_url || null, pubDate: toIso(a.pubDate), description: a.description || '',
  })).filter((a) => a.title && a.link);
}

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const headers = event.headers || {};
  const key = process.env.NEWSDATA_API_KEY || headers['x-newsdata-key'] || headers['X-Newsdata-Key'] || (event.queryStringParameters || {}).key || '';

  const merged = [];
  const seen = new Set();
  const add = (arr) => {
    for (const a of arr) {
      const k = normTitle(a.title);
      if (k && !seen.has(k)) { seen.add(k); merged.push(a); }
    }
  };

  try {
    // newsdata first (its articles carry images) when a key is available.
    if (key) {
      add(await newsdata(key, 'North Carolina real estate'));
      if (merged.length < 6) add(await newsdata(key, 'real estate'));
    }
    // Google News RSS — keyless, NC-tailored, always available.
    const gn = await Promise.all([
      googleNews('North Carolina real estate'),
      googleNews('North Carolina housing market'),
      googleNews('North Carolina home construction'),
    ]);
    for (const arr of gn) add(arr);

    // Freshest first.
    merged.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
    const articles = merged.slice(0, 24);

    if (!articles.length) {
      return { statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'empty', message: 'No articles found.', articles: [] }) };
    }
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' },
      body: JSON.stringify({ articles }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'api-error', message: String((e && e.message) || e), articles: [] }) };
  }
};
