import { resolveOfficialNcZoning } from './lib/sc-zoning-discovery.js';
import { ncZoningCounty } from './lib/nc-zoning-manifest.js';

export const config = {
  path: '/.netlify/functions/nc-zoning',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip'],
  },
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
};

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'POST only' });
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const county = ncZoningCounty(body.county);
    const lng = Number(body.lng);
    const lat = Number(body.lat);
    if (!county || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      return json(400, { success: false, error: 'A supported North Carolina county and coordinates are required' });
    }
    const data = await resolveOfficialNcZoning({ county, lng, lat });
    return json(200, { success: true, data });
  } catch (error) {
    return json(502, { success: false, error: String(error?.message || error || 'Zoning lookup failed').slice(0, 300) });
  }
};
