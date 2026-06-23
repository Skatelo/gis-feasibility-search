// County housing-market stats (Realtor.com metrics republished on FRED, keyed by
// county FIPS). FRED's CSV sends no browser CORS header, so this function fetches
// the series server-side and returns the latest value + 3-month and 1-year-ago
// points (for trend) as JSON with CORS — a live anchor for the report's Market
// Saturation & Absorption section.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// FRED Realtor.com county series prefixes (suffix = 5-digit county FIPS).
const SERIES = {
  medianDaysOnMarket: 'MEDDAYONMAR',
  activeListings: 'ACTLISCOU',
  medianListPrice: 'MEDLISPRI',
  newListings: 'NEWLISCOU',
  priceReduced: 'MEDLISPRIPERSQUFEE', // unused fallback guard (skipped if 404)
};

async function fredSeries(id) {
  try {
    const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split(/\r?\n/);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const [d, v] = lines[i].split(',');
      const n = parseFloat(v);
      if (Number.isFinite(n)) rows.push([d, n]);
    }
    if (!rows.length) return null;
    const at = (back) => (rows[rows.length - 1 - back] ? rows[rows.length - 1 - back][1] : null);
    const last = rows[rows.length - 1];
    return { value: last[1], date: last[0], prev3: at(3), prevYear: at(12) };
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fips = (event.queryStringParameters || {}).fips || '';
  if (!/^\d{5}$/.test(fips)) {
    return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'fips (5 digits) required' }) };
  }
  try {
    const wanted = ['medianDaysOnMarket', 'activeListings', 'medianListPrice', 'newListings'];
    const entries = await Promise.all(wanted.map(async (k) => [k, await fredSeries(SERIES[k] + fips)]));
    const out = { fips };
    for (const [k, v] of entries) out[k] = v;
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=43200' },
      body: JSON.stringify(out),
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
