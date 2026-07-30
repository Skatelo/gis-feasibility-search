// SAME-ORIGIN IMAGE PROXY — needed for PDF export.
//
// html2canvas draws into a <canvas>, and a canvas that has loaded a cross-origin
// image without CORS headers becomes "tainted": reading pixels back out throws a
// SecurityError, so the export fails. Google's Static Maps and Street View
// endpoints do NOT send Access-Control-Allow-Origin, so their images cannot be
// captured directly.
//
// Serving them through this function makes them same-origin from the browser's
// point of view, so the canvas stays clean and the imagery appears in the PDF.
//
// The host allowlist keeps this from becoming an open relay.

const ALLOWED_HOSTS = new Set([
  'maps.googleapis.com',
  'maps.gstatic.com',
  'streetviewpixels-pa.googleapis.com',
]);

export const config = {
  path: '/.netlify/functions/img-proxy',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip'] },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: 'GET only' };

  const target = (event.queryStringParameters && event.queryStringParameters.url) || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { statusCode: 400, headers: CORS, body: 'A valid url parameter is required' };
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return { statusCode: 403, headers: CORS, body: 'Host not allowed' };
  }

  try {
    const res = await fetch(parsed.toString());
    if (!res.ok) return { statusCode: res.status, headers: CORS, body: `Upstream returned ${res.status}` };
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'content-type': res.headers.get('content-type') || 'image/png',
        // These images are deterministic for a coordinate; caching keeps repeat
        // exports fast and reduces Static Maps billing.
        'cache-control': 'public, max-age=86400',
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    return { statusCode: 502, headers: CORS, body: String(error?.message || 'Image fetch failed').slice(0, 200) };
  }
};
