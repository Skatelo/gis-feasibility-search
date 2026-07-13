import { resolveOfficialScZoning } from './lib/sc-zoning-discovery.js';
import { scZoningCoverage } from './lib/sc-zoning-manifest.js';

export const config = {
  path: '/.netlify/functions/sc-zoning',
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
    const entry = scZoningCoverage(body.county);
    const lng = Number(body.lng);
    const lat = Number(body.lat);
    if (!entry || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      return json(400, { success: false, error: 'A supported South Carolina county and coordinates are required' });
    }
    const data = await resolveOfficialScZoning({ county: entry.county, lng, lat });
    return json(200, { success: true, data, officialMapUrl: entry.officialMapUrl });
  } catch (error) {
    return json(502, { success: false, error: String(error?.message || error || 'Zoning lookup failed').slice(0, 300) });
  }
};
