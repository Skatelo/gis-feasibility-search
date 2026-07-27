// SCDOT STATEWIDE PARCEL ACCESS (token-authenticated)
//
// SCDOT secured the statewide SC_Parcels layer: every request now answers
// `499 Token Required`, and no public alias remains (verified — the GISMapping
// folder no longer lists it, and "Parcels2025" is a Data Store registration, not
// a service). Access requires an SCDOT ArcGIS Enterprise account.
//
//   Portal:  https://gis.scdot.org/portal
//   Token:   https://gis.scdot.org/portal/sharing/rest/generateToken
//
// Credentials live ONLY in Netlify environment variables and are used server-side
// here — they are never sent to the browser. Set:
//   SCDOT_USERNAME, SCDOT_PASSWORD      (or)   SCDOT_TOKEN for a long-lived token
//
// With no credentials configured this returns { configured: false } and the app
// silently falls back to county-layer auto-discovery.

const PORTAL_TOKEN_URL = 'https://gis.scdot.org/portal/sharing/rest/generateToken';
const SC_PARCELS_LAYER = 'https://smpesri.scdot.org/arcgis/rest/services/GISMapping/SC_Parcels/MapServer/0';
const PARCEL_FIELDS = 'T_Map_Number,County,L_Value,M_Value,Ownership,Mailing_Add,Mailing_City,Mailing_St,Mailing_Zip,Zoning,Land_Use,Acreage';

export const config = {
  path: '/.netlify/functions/sc-statewide-parcel',
  rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip'] },
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
};

const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

// Tokens are valid for ~60 min; cache in module scope so warm invocations reuse
// one instead of re-authenticating on every parcel lookup.
let cachedToken = null;
let cachedExpiry = 0;

async function getToken() {
  const staticToken = (process.env.SCDOT_TOKEN || '').trim();
  if (staticToken) return staticToken;

  const username = (process.env.SCDOT_USERNAME || '').trim();
  const password = (process.env.SCDOT_PASSWORD || '').trim();
  if (!username || !password) return null;

  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;

  const body = new URLSearchParams({
    username,
    password,
    client: 'referer',
    referer: (process.env.SCDOT_REFERER || 'https://gissearch.netlify.app').trim(),
    expiration: '60',
    f: 'json',
  });
  const res = await fetch(PORTAL_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!data?.token) {
    const detail = data?.error?.details?.join('; ') || data?.error?.message || 'token request failed';
    throw new Error(`SCDOT token error: ${detail}`);
  }
  cachedToken = data.token;
  cachedExpiry = Number(data.expires) || (now + 55 * 60_000);
  return cachedToken;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'POST only' });
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const lng = Number(body.lng);
    const lat = Number(body.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return json(400, { success: false, error: 'lng and lat are required' });
    }

    let token;
    try {
      token = await getToken();
    } catch (tokenError) {
      return json(200, { success: false, configured: true, error: String(tokenError.message || tokenError).slice(0, 200) });
    }
    if (!token) return json(200, { success: false, configured: false });

    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where: '1=1',
      outFields: PARCEL_FIELDS,
      returnGeometry: 'true',
      outSR: '4326',
      resultRecordCount: '1',
      f: 'json',
      token,
    });
    const res = await fetch(`${SC_PARCELS_LAYER}/query?${params}`, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (data?.error) {
      // A stale cached token is the usual cause — drop it so the next call re-auths.
      cachedToken = null;
      cachedExpiry = 0;
      return json(200, { success: false, configured: true, error: `SC_Parcels: ${data.error.message || data.error.code}` });
    }
    const feature = data?.features?.[0];
    if (!feature?.attributes) return json(200, { success: true, configured: true, data: null });

    return json(200, {
      success: true,
      configured: true,
      data: {
        attributes: feature.attributes,
        rings: feature.geometry?.rings || null,
        sourceUrl: SC_PARCELS_LAYER,
      },
    });
  } catch (error) {
    return json(502, { success: false, error: String(error?.message || error || 'SC parcel lookup failed').slice(0, 300) });
  }
};
