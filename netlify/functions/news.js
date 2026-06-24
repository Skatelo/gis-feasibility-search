// Real estate / construction / housing-market news for North Carolina, from
// Google News RSS — KEYLESS and reliable. Fetched server-side (so there's no
// browser CORS issue) and returned as a compact, CORS-enabled article list.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
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
  const d = new Date(raw);
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

const normTitle = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const merged = [];
  const seen = new Set();
  const add = (arr) => {
    for (const a of arr) {
      const k = normTitle(a.title);
      if (k && !seen.has(k)) { seen.add(k); merged.push(a); }
    }
  };

  try {
    const lists = await Promise.all([
      googleNews('North Carolina real estate'),
      googleNews('North Carolina housing market'),
      googleNews('North Carolina home construction'),
    ]);
    for (const arr of lists) add(arr);

    merged.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
    const articles = merged.slice(0, 24);

    if (!articles.length) {
      return { statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'empty', message: 'No articles found.', articles: [] }) };
    }
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
      body: JSON.stringify({ articles }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'api-error', message: String((e && e.message) || e), articles: [] }) };
  }
};
