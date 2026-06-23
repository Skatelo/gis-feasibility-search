// Current 30-year fixed mortgage rate (Freddie Mac PMMS via FRED series
// MORTGAGE30US). FRED's CSV endpoint sends no CORS header, so this serverless
// function fetches it server-side and returns the latest value as JSON with
// CORS — a live anchor for the report's Interest Rate & Financing section.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export const handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  try {
    const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US');
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    let rate = null;
    let date = null;
    for (let i = lines.length - 1; i > 0; i--) {
      const parts = lines[i].split(',');
      const r = parseFloat(parts[1]);
      if (Number.isFinite(r)) { rate = r; date = parts[0]; break; }
    }
    if (rate == null) throw new Error('no observation parsed');
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=21600' },
      body: JSON.stringify({ rate, date, series: 'MORTGAGE30US', source: 'Freddie Mac PMMS via FRED (fred.stlouisfed.org)' }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
