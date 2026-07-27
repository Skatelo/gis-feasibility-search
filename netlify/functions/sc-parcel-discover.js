// Endpoint for SC parcel auto-discovery. Runs server-side because county ArcGIS
// hosts are inconsistent about CORS and the crawl is too heavy for the browser.

import { discoverScParcelAtPoint } from './lib/sc-parcel-discovery.js';

export const config = {
  path: '/.netlify/functions/sc-parcel-discover',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip'] },
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
};

const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'POST only' });
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const county = String(body.county || '').slice(0, 80);
    const lng = Number(body.lng);
    const lat = Number(body.lat);
    if (!county || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      return json(400, { success: false, error: 'county, lng and lat are required' });
    }
    const found = await discoverScParcelAtPoint(county, lng, lat);
    return json(200, { success: true, data: found });
  } catch (error) {
    return json(502, { success: false, error: String(error?.message || error || 'Parcel discovery failed').slice(0, 300) });
  }
};
