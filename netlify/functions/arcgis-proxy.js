// SAME-ORIGIN ARCGIS PROXY — the fix for county GIS servers without CORS.
//
// Many government ArcGIS servers serve public data happily but send no
// Access-Control-Allow-Origin header. A browser therefore refuses to read the
// response, the client-side fetch rejects with an opaque TypeError, and the app
// concludes "no official GIS polygon was found at this parcel point" — even
// though the service returned the district perfectly.
//
// Gaston County (gis.gastoncountync.gov) is exactly this case: an identify at
// 1992 Garland Ave returns RS-12 server-side, but the browser never sees it.
//
// Routing the same request through this function makes it same-origin, so the
// answer comes back. The host allowlist keeps it from becoming an open relay.

import { isAllowedArcgisHost, isArcgisRestPath } from './lib/arcgis-host.js';

export const config = {
  path: '/.netlify/functions/arcgis-proxy',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip'] },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'content-type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
};

const UPSTREAM_TIMEOUT_MS = 15_000;

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };
  }

  const target = (event.queryStringParameters && event.queryStringParameters.url) || '';
  if (!isAllowedArcgisHost(target) || !isArcgisRestPath(target)) {
    return {
      statusCode: 403,
      headers: CORS,
      body: JSON.stringify({ error: 'Only https ArcGIS REST endpoints on public-sector or Esri hosts are allowed' }),
    };
  }

  try {
    const res = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await res.text();
    // Pass the upstream status through so the caller can tell "layer said no"
    // from "server is down" instead of seeing every failure as an empty result.
    return {
      statusCode: res.ok ? 200 : res.status,
      headers: { ...CORS, 'content-type': res.headers.get('content-type') || CORS['content-type'] },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: String(error?.message || 'ArcGIS request failed').slice(0, 200) }),
    };
  }
};
