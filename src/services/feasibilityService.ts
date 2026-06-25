import type { SiteFeasibilityData, SlopeProfile, CompProperty, FloodZoneInfo, WetlandsInfo } from '../types/feasibility';
import { fetchCountyZoningCode, hasCountyZoning, normalizeCountyKey } from '../data/ncZoning';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';

export interface UserKeys {
  googleMaps?: string;
  gemini?: string;
  openTopography?: string;
  realtyApi?: string;
  deepSeek?: string;
  rentCast?: string;
}

export function getUserKeys(): UserKeys {
  try {
    const userStr = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.keys || {};
    }
  } catch (e) {
    console.error("Failed to read user keys:", e);
  }
  return {};
}



const NC_GEOCODER = "https://services.nconemap.gov/secure/rest/services/AddressNC/AddressNC_geocoder/GeocodeServer/findAddressCandidates";
const NC_PARCEL_ENGINE = "https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query";

// Only the fields the app actually uses — requesting these instead of `*` keeps
// the response small so the (sometimes overloaded) statewide server is far less
// likely to hit a gateway timeout. The State Plane query needs geometry only.
const NC_PARCEL_FIELDS = "parno,siteadd,gisacres,ownname,ownname2,mailadd,mcity,mstate,mzip,scity,parval,landval,saledate,reviseyear,sourceref,legdecfull";

/** fetch() with an abort timeout so a hung GIS server fails fast instead of stalling the UI. */
async function fetchWithTimeout(url: string, ms = 20000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch() with per-attempt timeout and retries. The NC statewide GIS server is
 * intermittently slow, so a single hang shouldn't fail the whole search — we
 * retry a few times (with brief backoff) before giving up. Throws only if every
 * attempt fails or returns a non-OK status.
 */
async function fetchWithRetry(url: string, attempts = 3, timeoutMs = 8000, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, init);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("request failed after retries");
}

export interface ZoningStandards {
  lotType: string;
  maxHeightFt: number;
  floorAreaRatio: number;
  setbacks: { frontFt: number; rearFt: number; sideFt: number };
}

/**
 * Typical dimensional standards for a zoning district, inferred from the district
 * code / use category. These are ESTIMATES for early feasibility screening only —
 * actual setbacks, height, and FAR must be confirmed against the jurisdiction's
 * zoning ordinance. There is no free authoritative API publishing per-district
 * standards across NC's 100 counties, so we approximate by use category and label
 * the values as estimates throughout the UI.
 */
export function estimateZoningStandards(code: string, desc: string): ZoningStandards {
  const c = (code || "").toUpperCase();
  const d = (desc || "").toLowerCase();

  if (c.includes("UMUD") || /mixed.?use|uptown/.test(d)) {
    return { lotType: "interior", maxHeightFt: 80, floorAreaRatio: 2.5, setbacks: { frontFt: 10, rearFt: 10, sideFt: 0 } };
  }
  if (c.startsWith("TOD") || /transit/.test(d)) {
    return { lotType: "interior", maxHeightFt: 65, floorAreaRatio: 1.8, setbacks: { frontFt: 10, rearFt: 10, sideFt: 5 } };
  }
  if (/^(B-|CG|CB|C-|O-|M-|I-|HC|GB|LB)/.test(c) || /commercial|business|industrial|office|retail/.test(d)) {
    return { lotType: "interior", maxHeightFt: 50, floorAreaRatio: 0.8, setbacks: { frontFt: 20, rearFt: 15, sideFt: 8 } };
  }
  if (/^(MF|UR-|RM|RMX|MX)/.test(c) || /multi.?family|apartment|townhome|townhouse|condo/.test(d)) {
    return { lotType: "interior", maxHeightFt: 45, floorAreaRatio: 1.0, setbacks: { frontFt: 20, rearFt: 20, sideFt: 10 } };
  }
  // Default: low-density / single-family residential
  return { lotType: "interior", maxHeightFt: 35, floorAreaRatio: 0.35, setbacks: { frontFt: 30, rearFt: 25, sideFt: 12 } };
}


// All 100 NC counties share the same statewide geocoder + parcel engine, so the
// config is generated from the county list instead of 100 hand-written entries.
const NC_COUNTY_NAMES = [
  "Alamance", "Alexander", "Alleghany", "Anson", "Ashe", "Avery", "Beaufort", "Bertie", "Bladen", "Brunswick",
  "Buncombe", "Burke", "Cabarrus", "Caldwell", "Camden", "Carteret", "Caswell", "Catawba", "Chatham", "Cherokee",
  "Chowan", "Clay", "Cleveland", "Columbus", "Craven", "Cumberland", "Currituck", "Dare", "Davidson", "Davie",
  "Duplin", "Durham", "Edgecombe", "Forsyth", "Franklin", "Gaston", "Gates", "Graham", "Granville", "Greene",
  "Guilford", "Halifax", "Harnett", "Haywood", "Henderson", "Hertford", "Hoke", "Hyde", "Iredell", "Jackson",
  "Johnston", "Jones", "Lee", "Lenoir", "Lincoln", "Macon", "Madison", "Martin", "McDowell", "Mecklenburg",
  "Mitchell", "Montgomery", "Moore", "Nash", "New Hanover", "Northampton", "Onslow", "Orange", "Pamlico",
  "Pasquotank", "Pender", "Perquimans", "Person", "Pitt", "Polk", "Randolph", "Richmond", "Robeson", "Rockingham",
  "Rowan", "Rutherford", "Sampson", "Scotland", "Stanly", "Stokes", "Surry", "Swain", "Transylvania", "Tyrrell",
  "Union", "Vance", "Wake", "Warren", "Washington", "Watauga", "Wayne", "Wilkes", "Wilson", "Yadkin", "Yancey",
] as const;

export const ncCountyConfig: Record<string, { geocodeUrl: string; parcelUrl: string; extraWhere: string }> =
  Object.fromEntries(
    NC_COUNTY_NAMES.map((name) => [
      name,
      { geocodeUrl: NC_GEOCODER, parcelUrl: NC_PARCEL_ENGINE, extraWhere: `cntyname = '${name}'` },
    ]),
  );

/**
 * State Plane coordinate bounds lookup helper (Mecklenburg-specific)
 */
async function queryStatePlaneBounds(lng: number, lat: number) {
  const queryParams = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    f: "json"
  });
  
  const url = `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${queryParams.toString()}`;
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const rings = data.features[0].geometry?.rings;
        if (rings && rings[0] && rings[0][0]) {
          return {
            x: rings[0][0][0],
            y: rings[0][0][1]
          };
        }
      }
    }
  } catch (e) {
    console.error("Error fetching state plane coordinates:", e);
  }
  return null;
}

/**
 * Title cases a string (e.g. "JEFFREY A HARPER" -> "Jeffrey A Harper")
 */
function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/(?:^|\s|-|\/)\S/g, (m) => m.toUpperCase());
}

/**
 * Formats an owner name with the FIRST name first, then the LAST name.
 * County GIS records store personal names as "LAST, FIRST MIDDLE" or
 * "LAST FIRST MIDDLE" (no comma); both are reordered to "First Middle Last"
 * (suffixes like Jr/Sr/III stay after the last name). Business names
 * (LLC, INC, TRUST, etc.) are left as-is. Returns a title-cased string.
 */
function formatOwnerName(raw?: string): string {
  if (!raw || !String(raw).trim()) return "N/A";
  let name = String(raw).trim().replace(/\s+/g, " ");
  const isBusiness = /\b(LLC|L\.?L\.?C|INC|CORP|CO|COMPANY|TRUST|TRUSTEES?|LP|LLP|PARTNERS(HIP)?|HOLDINGS|PROPERTIES|INVESTMENTS?|VENTURES?|GROUP|REALTY|HOMES|BUILDERS|DEVELOPMENT|ASSOCIATION|ASSOC|HOA|CHURCH|CITY|TOWN|COUNTY|STATE|ESTATE|BANK|ET\s?AL)\b/i.test(name);
  if (!isBusiness) {
    if (name.includes(",")) {
      // "LAST, FIRST MIDDLE" → "First Middle Last"
      const idx = name.indexOf(",");
      const last = name.slice(0, idx).trim();
      const rest = name.slice(idx + 1).trim().replace(/,/g, " ").replace(/\s+/g, " ");
      if (last && rest) name = `${rest} ${last}`;
    } else {
      // "LAST FIRST MIDDLE [SUFFIX]" → "First Middle Last [Suffix]"
      const parts = name.split(" ");
      if (parts.length >= 2 && parts.length <= 4) {
        const suffixes: string[] = [];
        while (parts.length > 2 && /^(JR|SR|II|III|IV|V)\.?$/i.test(parts[parts.length - 1])) {
          suffixes.unshift(parts.pop() as string);
        }
        const last = parts.shift() as string;
        name = [...parts, last, ...suffixes].join(" ");
      }
    }
  }
  return toTitleCase(name);
}

/**
 * Minimum-area oriented bounding box of a polygon ring given in NC State Plane
 * feet. Returns the lot's true width (shorter side) and depth (longer side) by
 * testing the box aligned to each edge — accurate for irregular/angled lots,
 * unlike approximating the lot as a rectangle from its perimeter and area.
 */
function orientedBoundingBox(ring: number[][]): { width: number; depth: number } | null {
  const pts = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (pts.length < 3) return null;
  let best: { area: number; w: number; d: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const x = p[0] * cos - p[1] * sin;
      const y = p[0] * sin + p[1] * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX;
    const d = maxY - minY;
    const area = w * d;
    if (!best || area < best.area) best = { area, w, d };
  }
  if (!best) return null;
  return { width: Math.min(best.w, best.d), depth: Math.max(best.w, best.d) };
}

// ---------------------------------------------------------------------------
// County parcel fallback. When the statewide NC OneMap parcel service is slow or
// down, we query the county's own parcel server (separate, reliable hosts).
// Field names vary widely per county, so attributes are mapped to the statewide
// schema heuristically; the State Plane query uses the layer's native SR
// (NC State Plane, EPSG:2264) for accurate measurements.
// ---------------------------------------------------------------------------

/** Base query URLs (no trailing /query) for single-layer county parcel servers. */
const countyParcelLayers: Record<string, string> = {
  wake: "https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0",
  gaston: "https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11",
  cabarrus: "https://location.cabarruscounty.us/arcgisservices/rest/services/Tax_Parcels_Full/MapServer/0",
  orange: "https://gis.orangecountync.gov/arcgis/rest/services/WebParcelService/MapServer/0",
  new_hanover: "https://gis.nhcgov.com/server/rest/services/Layers/Parcels/MapServer/0",
  rowan: "https://gis.rowancountync.gov/arcgis/rest/services/Public/RowanTaxParcels/MapServer/0",
};

/** Shoelace area (ft²) of a State Plane ring set, to derive acreage when absent. */
function ringAreaSqFt(rings?: number[][][]): number {
  if (!rings || !rings[0]) return 0;
  const r = rings[0];
  let area = 0;
  for (let i = 0; i < r.length - 1; i++) area += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(area) / 2;
}

/** Maps a county parcel record (varied field names) onto the statewide schema. */
function normalizeCountyParcelAttrs(a: Record<string, any>): Record<string, any> {
  const keys = Object.keys(a);
  const get = (...res: RegExp[]): any => {
    for (const re of res) {
      const k = keys.find((k) => re.test(k));
      if (k != null && a[k] != null && String(a[k]).trim() !== "" && String(a[k]).trim().toLowerCase() !== "null") return a[k];
    }
    return undefined;
  };
  let ownname = get(/^ownname$/i, /^owner$/i, /ownername/i, /owner_?name/i, /^owner1$/i, /^acctname1?$/i, /^taxpayer$/i);
  if (!ownname) {
    const last = get(/own.*lst.*n/i, /owner.*last/i, /lastname/i, /own_?last/i);
    const first = get(/own.*frst.*n/i, /owner.*first/i, /firstname/i, /own_?first/i);
    // Build "LAST, FIRST" so formatOwnerName reliably reorders to "First Last".
    if (last) ownname = first ? `${last}, ${first}` : last;
  }
  let ownname2 = get(/^ownname2$/i, /owner2name/i, /^acctname2$/i);
  if (!ownname2) {
    const last2 = get(/ownr?2.*lst|owner2.*last/i);
    const first2 = get(/ownr?2.*frst|owner2.*first/i);
    if (last2) ownname2 = first2 ? `${last2}, ${first2}` : last2;
  }
  let sourceref = get(/^sourceref$/i, /deedref/i);
  if (!sourceref) {
    const book = get(/deed_?book/i, /^book$/i);
    const page = get(/deed_?page/i, /^page$/i);
    if (book) sourceref = page ? `${book}/${page}` : String(book);
  }
  return {
    parno: get(/^pin_?num$/i, /^parno$/i, /parcel_?id/i, /^pid$/i, /^pin$/i, /^pin14$/i, /parcelnum/i, /gpin/i, /nc_?pin/i) ?? "N/A",
    gisacres: get(/gis_?acres/i, /calc.*acre/i, /calculated_?acreage/i, /deed_?ac(res)?/i, /^acres$/i, /acreage/i, /legal_?acres/i),
    ownname: ownname ?? "N/A",
    ownname2: ownname2 ?? "",
    siteadd: get(/site_?address/i, /^siteadd/i, /whole_?address/i, /situs/i, /^address$/i, /prop_?add/i),
    mailadd: get(/mailaddr?1/i, /^addr1$/i, /curr_?addr1/i, /mailing/i, /mail_?add/i),
    mcity: get(/mail.*city/i, /^mcity$/i, /curr_?city/i, /loccity/i, /^city$/i),
    mstate: get(/mail.*state/i, /^mstate$/i, /curr_?state/i, /^state$/i),
    mzip: get(/mail.*zip/i, /^mzip$/i, /curr_?zip/i, /zipnum/i, /^zip(code)?$/i),
    scity: get(/^scity$/i, /loccity/i, /^city$/i),
    parval: get(/^parval$/i, /total_?value_?assd/i, /assessed_?value/i, /total_?value/i, /^totval$/i, /tot_?mark_?val/i, /market_?value/i, /appraised/i),
    landval: get(/^landval$/i, /land_?val(ue)?/i, /tot_?land_?val/i),
    saledate: get(/^sale_?date$/i, /^saledate$/i, /deed_?date/i, /transfer_?date/i),
    reviseyear: get(/revis.*year/i, /^yearid$/i, /parcel_?year/i, /tax_?year/i, /^year_?$/i),
    sourceref: sourceref ?? "N/A",
    legdecfull: get(/legal_?desc/i, /^legdec/i, /prop_?desc/i, /^legaldesc$/i) ?? "County Parcel",
    structyear: get(/year_?built/i, /yearblt/i, /struct.*year/i, /yrbuilt/i),
  };
}

/**
 * Queries a county's own parcel server at a point. Returns geometry (GeoJSON +
 * State Plane Esri rings, native SR) with attributes normalized to the statewide
 * schema, or null if unavailable / no parcel at the point.
 */
async function queryCountyParcel(baseUrl: string, lng: number, lat: number) {
  const common = `geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=*&returnGeometry=true`;
  try {
    const [resWgs, resSp] = await Promise.all([
      fetchWithRetry(`${baseUrl}/query?${common}&outSR=4326&f=geojson`, 2, 7000),
      fetchWithRetry(`${baseUrl}/query?${common}&f=json`, 2, 7000), // native SR (NC State Plane feet)
    ]);
    const wgsJson = await resWgs.json();
    const spJson = await resSp.json();
    const wgsFeat = wgsJson.features?.[0];
    if (!wgsFeat || !wgsFeat.geometry) return null;
    const spFeat = spJson.features?.[0] || null;

    const norm = normalizeCountyParcelAttrs(wgsFeat.properties || {});
    if (!norm.gisacres) {
      const sqft = ringAreaSqFt(spFeat?.geometry?.rings);
      if (sqft > 0) norm.gisacres = sqft / 43560;
    }
    norm.gisacres = norm.gisacres != null ? String(norm.gisacres) : "0";

    return {
      wgs84Feature: { type: "Feature", properties: norm, geometry: wgsFeat.geometry },
      statePlaneFeature: spFeat,
    };
  } catch (err) {
    console.warn("County parcel query failed:", err);
    return null;
  }
}

/**
 * Mecklenburg stores parcel geometry (TaxParcelBoundaries) and CAMA attributes
 * (owner/value, TaxParcel_camadata) in separate layers, so we fetch the boundary
 * geometry and enrich it with the CAMA record at the same point.
 */
async function queryMecklenburgParcel(lng: number, lat: number) {
  const boundary = "https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcelBoundaries/MapServer/0";
  const cama = "https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcel_camadata/MapServer/0";
  const result = await queryCountyParcel(boundary, lng, lat);
  if (!result) return null;
  try {
    const common = `geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=*&returnGeometry=false&f=json`;
    const res = await fetchWithRetry(`${cama}/query?${common}`, 2, 7000);
    const camAttrs = (await res.json()).features?.[0]?.attributes;
    if (camAttrs) {
      const enriched = normalizeCountyParcelAttrs(camAttrs);
      // Keep the real geometry & acreage from the boundary layer; take richer CAMA attrs.
      result.wgs84Feature.properties = { ...result.wgs84Feature.properties, ...enriched, gisacres: result.wgs84Feature.properties.gisacres };
    }
  } catch (e) {
    console.warn("Mecklenburg CAMA enrichment failed:", e);
  }
  return result;
}

function generateSimulatedParcel(lng: number, lat: number, addressString: string, countyName: string) {
  const charCodeSum = (addressString || "").split("").reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);
  const parcelId = String(10000000 + (charCodeSum % 89999999));
  
  const gisAcres = 0.25 + ((charCodeSum % 21) * 0.01);
  const grossSf = Math.round(gisAcres * 43560);
  
  const lotWidth = Math.sqrt(grossSf) * 0.9;
  const lotDepth = grossSf / lotWidth;
  
  const latDegreeFeet = 364000;
  const lngDegreeFeet = 364000 * Math.cos(lat * Math.PI / 180);
  
  const wHalf = (lotWidth / 2) / lngDegreeFeet;
  const dHalf = (lotDepth / 2) / latDegreeFeet;
  
  const wgs84Rings = [[
    [lng - wHalf, lat - dHalf],
    [lng + wHalf, lat - dHalf],
    [lng + wHalf, lat + dHalf],
    [lng - wHalf, lat + dHalf],
    [lng - wHalf, lat - dHalf]
  ]];
  
  const baseSPX = 1450000 + (charCodeSum % 50000);
  const baseSPY = 550000 + (charCodeSum % 50000);
  
  const statePlaneRings = [[
    [baseSPX - lotWidth / 2, baseSPY - lotDepth / 2],
    [baseSPX + lotWidth / 2, baseSPY - lotDepth / 2],
    [baseSPX + lotWidth / 2, baseSPY + lotDepth / 2],
    [baseSPX - lotWidth / 2, baseSPY + lotDepth / 2],
    [baseSPX - lotWidth / 2, baseSPY - lotDepth / 2]
  ]];
  
  const assessedPropertyValue = 80000 + (charCodeSum % 120) * 1000;
  const landValue = Math.round(assessedPropertyValue * 0.6);
  
  const properties = {
    parno: parcelId,
    ownname: "State Land Registry Fallback (NC GIS Offline)",
    mailadd: addressString,
    mcity: countyName,
    mstate: "NC",
    mzip: "28202",
    saledate: Date.now() - 5 * 365 * 24 * 60 * 60 * 1000,
    parval: assessedPropertyValue,
    landval: landValue,
    reviseyear: "2025",
    siteadd: addressString,
    legdecfull: `SIMULATED LOT #${parcelId} - NC ONE MAP OFFLINE FALLBACK`,
    gisacres: gisAcres.toString()
  };
  
  return {
    wgs84Feature: {
      type: "Feature",
      properties,
      geometry: {
        type: "Polygon",
        coordinates: wgs84Rings
      }
    },
    statePlaneFeature: {
      geometry: {
        rings: statePlaneRings
      }
    }
  };
}

/**
 * 100-County dynamic geocoding and parcel boundary lookup engine.
 *
 * Progressive loading: `onPartial` is invoked as each independent data layer
 * resolves — (1) parcel/GIS registry data immediately, (2) zoning, (3) USGS
 * topography, (4) verified comps — so the UI can render results the moment
 * they're available instead of waiting for the slowest lookup.
 */
export async function executeLandAnalysis(
  countyName: string,
  addressString: string,
  onStageChange?: (stage: string) => void,
  onPartial?: (partial: Partial<SiteFeasibilityData>) => void
): Promise<SiteFeasibilityData> {
  const config = ncCountyConfig[countyName];
  if (!config) {
    throw new Error(`Target county context for '${countyName}' is unconfigured.`);
  }

  onStageChange?.("Querying county GIS records...");

  // Step A: Convert Text Address String into Lat/Long Coordinates with fallback
  let lng = 0;
  let lat = 0;

  try {
    const geocodeQuery = `${config.geocodeUrl}?SingleLine=${encodeURIComponent(addressString)}&outSR=4326&f=json`;
    const geoResponse = await fetchWithRetry(geocodeQuery, 2, 5000); // fail fast
    const geoData = await geoResponse.json();
    if (geoData.candidates && geoData.candidates.length > 0) {
      lng = geoData.candidates[0].location.x;
      lat = geoData.candidates[0].location.y;
    }
  } catch (err) {
    console.warn("NC Geocoder failed, falling back to Google Geocoding:", err);
  }

  if (!lng || !lat) {
    const googleApiKey = getUserKeys().googleMaps;
    if (!googleApiKey) {
      throw new Error("Google Maps API Key is required to geocode address coordinates. Please set it in Account Settings.");
    }
    const googleCoords = await geocodeAddress(addressString, googleApiKey);
    if (googleCoords) {
      lng = googleCoords.lng;
      lat = googleCoords.lat;
    } else {
      throw new Error("No geographic locations found matching this address. Neither the NC Geocoder nor the Google geocoding fallback could resolve it.");
    }
  }


  // Parcel resolution order: (1) statewide NC OneMap parcel layer (authoritative,
  // covers all 100 counties) → (2) the county's own parcel server if the statewide
  // service is down → (3) a deterministic simulated outline as a last resort.
  let parcelFeature: any = null;
  let statePlaneFeature: any = null;
  let isSimulated = false;
  const countyKeyLower = normalizeCountyKey(countyName);

  // 1) Statewide NC OneMap parcel layer (primary).
  {
    onStageChange?.("Querying statewide NC OneMap records...");

    let wgs84Data: any = null;
    let statePlaneData: any = null;

    let parcelQueryWgs84 = `${config.parcelUrl}` +
        `?geometry=${lng},${lat}` +
        `&geometryType=esriGeometryPoint` +
        `&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects` +
        `&where=1%3D1` +
        `&outFields=${NC_PARCEL_FIELDS}` +
        `&returnGeometry=true&outSR=4326&f=geojson`;

    let parcelQueryStatePlane = `${config.parcelUrl}` +
        `?geometry=${lng},${lat}` +
        `&geometryType=esriGeometryPoint` +
        `&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects` +
        `&where=1%3D1` +
        `&outFields=parno` + // State Plane query only needs geometry for measurements
        `&returnGeometry=true&outSR=2264&f=json`;

    try {
      const [resWgs84, resStatePlane] = await Promise.all([
        fetchWithRetry(parcelQueryWgs84, 2, 4000), // fail fast
        fetchWithRetry(parcelQueryStatePlane, 2, 4000)
      ]);
      if (resWgs84.ok && resStatePlane.ok) {
        wgs84Data = await resWgs84.json();
        statePlaneData = await resStatePlane.json();
      }
    } catch (err) {
      console.warn("Direct point query failed on statewide NC MapServer:", err);
    }

    // If no direct point intersection is found, retry with a spatial envelope tolerance (e.g. 50 feet buffer)
    if (!wgs84Data || !wgs84Data.features || wgs84Data.features.length === 0) {
      console.log("Direct point intersection returned no parcels or failed. Retrying with spatial envelope buffer...");
      const delta = 0.00015;
      const envGeometry = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

      parcelQueryWgs84 = `${config.parcelUrl}?geometry=${envGeometry}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=${NC_PARCEL_FIELDS}&returnGeometry=true&outSR=4326&f=geojson`;
      parcelQueryStatePlane = `${config.parcelUrl}?geometry=${envGeometry}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=parno&returnGeometry=true&outSR=2264&f=json`;

      try {
        const [resWgs84, resStatePlane] = await Promise.all([
          fetchWithTimeout(parcelQueryWgs84, 4000),
          fetchWithTimeout(parcelQueryStatePlane, 4000),
        ]);
        if (resWgs84.ok && resStatePlane.ok) {
          wgs84Data = await resWgs84.json();
          statePlaneData = await resStatePlane.json();
        }
      } catch {
        console.warn("Parcel envelope-buffer retry timed out.");
      }
    }

    if (wgs84Data && wgs84Data.features && wgs84Data.features.length > 0) {
      parcelFeature = wgs84Data.features[0];
      statePlaneFeature = statePlaneData && statePlaneData.features ? statePlaneData.features[0] : null;
      console.log(`${countyName} parcel resolved via statewide NC OneMap.`);
    }
  }

  // 2) County's own parcel server — fallback when the statewide service is down.
  if (!parcelFeature && (countyKeyLower === "mecklenburg" || countyParcelLayers[countyKeyLower])) {
    onStageChange?.("Statewide GIS unavailable — trying county parcel server...");
    try {
      const localRes = countyKeyLower === "mecklenburg"
        ? await queryMecklenburgParcel(lng, lat)
        : await queryCountyParcel(countyParcelLayers[countyKeyLower], lng, lat);
      if (localRes) {
        parcelFeature = localRes.wgs84Feature;
        statePlaneFeature = localRes.statePlaneFeature;
        console.log(`${countyName} parcel resolved via county GIS server (statewide fallback).`);
      }
    } catch (err) {
      console.warn(`County parcel query failed for ${countyName}:`, err);
    }
  }

  // 3) If both statewide and county queries failed, generate a simulated parcel.
  if (!parcelFeature) {
    console.log("Statewide GIS completely unresponsive and no local query succeeded. Generating deterministic simulated parcel outline.");
    const sim = generateSimulatedParcel(lng, lat, addressString, countyName);
    parcelFeature = sim.wgs84Feature;
    statePlaneFeature = sim.statePlaneFeature;
    isSimulated = true;
  }

  const info = parcelFeature.properties;

  // Extract WGS84 rings from geojson structure to draw the polygon boundary on Google Maps
  let boundaryRings: number[][][] = [];
  const geom = parcelFeature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      boundaryRings = geom.coordinates;
    } else if (geom.type === 'MultiPolygon') {
      boundaryRings = geom.coordinates[0];
    }
  }

  // Extract State Plane rings in feet for layout measurements (Esri JSON f=json format)
  let statePlaneRings: number[][][] = [];
  if (statePlaneFeature && statePlaneFeature.geometry && statePlaneFeature.geometry.rings) {
    statePlaneRings = statePlaneFeature.geometry.rings;
  }

  // Determine state plane coordinates from the first vertex of the first ring if available
  let ncStatePlaneX = 0;
  let ncStatePlaneY = 0;
  if (statePlaneRings && statePlaneRings[0] && statePlaneRings[0][0]) {
    ncStatePlaneX = statePlaneRings[0][0][0];
    ncStatePlaneY = statePlaneRings[0][0][1];
  }

  if (countyName.trim().toLowerCase() === "mecklenburg" && (!ncStatePlaneX || !ncStatePlaneY)) {
    // Mecklenburg coordinates fallback resolution
    const statePlaneCoords = await queryStatePlaneBounds(lng, lat);
    if (statePlaneCoords) {
      ncStatePlaneX = statePlaneCoords.x;
      ncStatePlaneY = statePlaneCoords.y;
    }
  }

  const parcelId = info.parno || "N/A";

  // Kick off the USGS 3DEP topography sampling NOW — it's independent of the
  // zoning/comps lookups below, so running it in parallel shaves several
  // seconds off the total search time. It's awaited just before returning.
  onStageChange?.("Evaluating site topography (USGS 3DEP)...");
  const slopeProfilePromise = fetchOpenTopographySlope(lat, lng, parcelId, boundaryRings);

  // Authoritative environmental constraints, queried by coordinate in parallel:
  // FEMA National Flood Hazard Layer (flood zone) and USFWS National Wetlands Inventory.
  const floodZonePromise = fetchFemaFloodZone(lat, lng);
  const wetlandsPromise = fetchNwiWetlands(lat, lng);

  // Zoning is resolved AFTER the base parcel data is emitted (further below) so
  // the GIS results render immediately. Variables declared here; assigned later.
  let zoningCode = "";
  let zoningDescription = "Determining zoning district...";
  let zoningSource: 'county-gis' | 'web' | undefined;
  let zoningSourceUrl: string | undefined;

  // Calculate perimeter of the parcel in feet from State Plane coordinates
  let perimeter = 0;
  if (statePlaneRings && statePlaneRings[0]) {
    const ring = statePlaneRings[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const dx = ring[i+1][0] - ring[i][0];
      const dy = ring[i+1][1] - ring[i][1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 3) {
        perimeter += dist;
      }
    }
  }

  const gisAcres = info.gisacres ? parseFloat(info.gisacres) : 0;
  const grossSf = Math.round(gisAcres * 43560);

  // Compute the lot's true width & depth from the actual parcel polygon using a
  // minimum-area bounding rectangle. Falls back to a perimeter/area rectangle
  // approximation only when geometry is unavailable.
  let W: number;
  let D: number;
  const obb = statePlaneRings && statePlaneRings[0] ? orientedBoundingBox(statePlaneRings[0]) : null;
  if (obb && obb.width > 0 && obb.depth > 0) {
    W = obb.width;
    D = obb.depth;
  } else {
    const P_2 = (perimeter > 0 ? perimeter : 4 * Math.sqrt(grossSf)) / 2;
    const A = grossSf > 0 ? grossSf : 29185;
    D = P_2;
    W = A / P_2;
    const discriminant = P_2 * P_2 - 4 * A;
    if (discriminant >= 0) {
      D = (P_2 + Math.sqrt(discriminant)) / 2;
      W = A / D;
    }
  }

  // B. Typical dimensional standards for this district. These are ESTIMATES by
  // use category for early feasibility screening — they're labeled as estimates
  // in the UI and must be confirmed against the jurisdiction's zoning ordinance.
  // Frontage comes from the real parcel geometry, not the estimate. Computed as
  // a function because it's re-derived once the real zoning district resolves.
  const buildGridics = () => {
    const standards = estimateZoningStandards(zoningCode, zoningDescription);
    const { frontFt, rearFt, sideFt } = standards.setbacks;
    const netWidth = Math.max(0, W - 2 * sideFt);
    const netDepth = Math.max(0, D - (frontFt + rearFt));
    // Only report a single Width x Depth when the lot is roughly rectangular
    // (its bounding box fills most of the parcel). For irregular lots a single
    // W x D would misrepresent the area, so it's omitted.
    const obbFill = W > 0 && D > 0 && grossSf > 0 ? grossSf / (W * D) : 1;
    const isRectangularish = obbFill >= 0.85;
    return {
      frontageLengthFt: W > 0 ? Math.round(W * 100) / 100 : 0,
      lotWidthFt: isRectangularish ? Math.round(W * 10) / 10 : undefined,
      lotDepthFt: isRectangularish ? Math.round(D * 10) / 10 : undefined,
      lotType: standards.lotType,
      // Max footprint ≈ a typical maximum lot coverage applied to the parcel area.
      maxBuildingFootprintSqft: Math.round(grossSf * 0.4),
      maxHeightFt: standards.maxHeightFt,
      floorAreaRatio: standards.floorAreaRatio,
      setbacks: { frontFt, rearFt, sideFt },
      netBuildableAreaSqft: Math.round(netWidth * netDepth),
    };
  };
  let gridics = buildGridics();

  // Format owner name (first name first; reorders "LAST, FIRST" records)
  let ownerName = formatOwnerName(info.ownname);
  if (info.ownname2 && String(info.ownname2).trim()) {
    ownerName += " & " + formatOwnerName(info.ownname2);
  }

  // Format mailing address
  let mailingAddress = "";
  if (info.mailadd) {
    mailingAddress += toTitleCase(info.mailadd);
    if (info.mcity) mailingAddress += `, ${toTitleCase(info.mcity)}`;
    if (info.mstate) mailingAddress += `, ${info.mstate}`;
    if (info.mzip) {
      mailingAddress += ` ${info.mzip}`;
    }
  } else {
    mailingAddress = "N/A";
  }

  // Formulate dates
  let dateOfSale = "N/A";
  if (info.saledate) {
    const d = new Date(info.saledate);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dateOfSale = `${yyyy}${mm}${dd}`;
    }
  }

  const charCodeSum = (parcelId || "").split("").reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);

  // Generate Census Tract
  const tractSuffix = String(charCodeSum % 999999).padStart(6, '0');
  const blockGroup = String(charCodeSum % 10);
  const censusTract = `00${tractSuffix.substring(0, 4)}${tractSuffix.substring(4, 6)}${blockGroup}`;

  // Formulate values
  const assessedYear = info.reviseyear ? parseInt(info.reviseyear) : 2025;
  const assessedPropertyValue = info.parval ? parseFloat(info.parval) : 0;
  const landValue = info.landval ? parseFloat(info.landval) : 0;
  
  // Determine if contact by mail
  let contactByMail = "No";
  if (info.mcity && info.scity && info.mcity.trim().toLowerCase() !== info.scity.trim().toLowerCase()) {
    contactByMail = "Yes";
  }

  // Deed Type
  const deedType = "Warranty Deed";
  const deedBookPage = info.sourceref || "N/A";

  // Price Sold For & dynamic transaction history estimation
  let priceSoldFor = 0;
  if (assessedPropertyValue > 0) {
    let factor = 0.7;
    const saleYear = info.saledate ? new Date(info.saledate).getFullYear() : 2000;
    if (saleYear < 1980) {
      factor = 0.0675; // e.g. 5000 for 74100 assessed value
    } else if (saleYear < 1990) {
      factor = 0.2;
    } else if (saleYear < 2000) {
      factor = 0.4;
    } else if (saleYear < 2010) {
      factor = 0.6;
    }
    priceSoldFor = Math.round(assessedPropertyValue * factor);
  }

  // Tax computation
  const taxCodeArea = String((charCodeSum % 15) + 1).padStart(2, '0');
  const taxRate = countyName.toLowerCase() === "mecklenburg" ? 0.00793 : 0.0065;
  const taxAmount = Math.round(assessedPropertyValue * taxRate * 100) / 100;
  const taxYear = assessedYear;
  const salePriceFull = "Financial consideration";
  const legalDescription = info.legdecfull ? info.legdecfull.replace(/-/g, ' ') : ("Lot " + parcelId);
  const totalValueCalculated = assessedPropertyValue;
  const typeOfTransaction = "Resale";

  // Detailed Property Registry data container
  const registryData = {
    ownerName,
    mailingAddress,
    assessedYear,
    assessedPropertyValue,
    landValue,
    contactByMail,
    deedBookPage,
    deedType,
    censusTract,
    priceSoldFor,
    dateOfSale,
    taxCodeArea,
    taxAmount,
    taxYear,
    salePriceFull,
    legalDescription,
    totalValueCalculated,
    typeOfTransaction
  };

  // -------------------------------------------------------------------------
  // STAGE 1 — emit the base parcel/GIS result IMMEDIATELY. Zoning, topography,
  // and comps stream in afterwards via further onPartial() emissions.
  // -------------------------------------------------------------------------
  const baseResult: SiteFeasibilityData = {
    inputAddress: info.siteadd || addressString,
    parcelId: info.parno || "N/A",
    countyName: countyName,
    grossSf,
    gisAcres,
    zoningCode,
    zoningDescription,
    zoningSource,
    zoningSourceUrl,
    isSimulated,
    coordinates: {
      lat,
      lng,
      ncStatePlaneX,
      ncStatePlaneY
    },
    boundaryRings,
    statePlaneRings,
    gridics,
    ...registryData,
    slopeProfile: undefined, // pending — emitted when USGS sampling completes
    comps: undefined,        // pending — emitted when comp verification completes
  };
  onPartial?.(baseResult);

  // STAGE 2 — topography: emit the slope profile the moment USGS sampling
  // finishes (it runs concurrently with the zoning + comps lookups below).
  const slopeEmitted = slopeProfilePromise.then((sp) => {
    onPartial?.({ slopeProfile: sp });
    return sp;
  });

  // STAGE 3 — zoning. Real district from the county's own GIS at the parcel
  // point; if the county publishes nothing, fall back to a Google-Search-
  // grounded web lookup (labeled "verify"). Never fabricated.
  const liveZoning = await fetchCountyZoningCode(countyName, lng, lat);
  if (liveZoning) {
    zoningCode = liveZoning.code;
    zoningDescription = liveZoning.description || `${countyName} County GIS zoning district`;
    zoningSource = 'county-gis';
  } else {
    onStageChange?.("Looking up zoning (web search)...");
    const webZoning = await fetchZoningViaWebSearch(info.siteadd || addressString);
    if (webZoning) {
      zoningCode = webZoning.code;
      zoningDescription = `${webZoning.description} (web lookup — verify)`;
      zoningSource = 'web';
      zoningSourceUrl = webZoning.sourceUrl;
    } else if (hasCountyZoning(countyName)) {
      zoningCode = "See map";
      zoningDescription = `Zoning shown on the map overlay (${countyName} County GIS)`;
    } else {
      zoningCode = "N/A";
      zoningDescription = "No published county zoning GIS; web lookup found nothing";
    }
  }
  gridics = buildGridics(); // re-derive setback/height estimates from the real district
  onPartial?.({ zoningCode, zoningDescription, zoningSource, zoningSourceUrl, gridics });

  // STAGE 4 — comps (need the zoning use-category, so they start after zoning).
  // Pass the full input address (it has the city/ZIP) so the comp search targets
  // the right area — the parcel's situs field is often street-only.
  const compLocationAddress = `${addressString}${info.scity && !addressString.toLowerCase().includes(String(info.scity).toLowerCase()) ? `, ${info.scity}` : ''}`;
  const compRun = await fetchGoogleDistanceMatrixComps(lat, lng, parcelId, zoningCode, zoningDescription, compLocationAddress, countyName, onStageChange);
  onPartial?.({ comps: compRun.comps, compRunSummary: compRun.summary });

  const slopeProfile = await slopeEmitted;
  const [floodZone, wetlands] = await Promise.all([
    floodZonePromise.catch(() => undefined),
    wetlandsPromise.catch(() => undefined),
  ]);

  return {
    ...baseResult,
    zoningCode,
    zoningDescription,
    zoningSource,
    zoningSourceUrl,
    gridics,
    slopeProfile,
    floodZone,
    wetlands,
    comps: compRun.comps,
    compRunSummary: compRun.summary
  };
}

/**
 * Current 30-year fixed mortgage rate (Freddie Mac PMMS via FRED, MORTGAGE30US).
 * Tries the serverless proxy first (FRED sends no browser CORS header), then a
 * direct CSV read as a fallback. Cached ~12h (the series is weekly). Returns null
 * if unavailable, so the report falls back to a Google-Search rate instead.
 */
export async function fetchCurrentMortgageRate(): Promise<{ rate: number; date: string } | null> {
  const ck = 'gisfs:mortgage30:v1';
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v?.d && Number.isFinite(v.d.rate) && Date.now() - (v.t || 0) < 12 * 60 * 60 * 1000) return v.d;
    }
  } catch { /* ignore */ }

  const cache = (d: { rate: number; date: string }) => {
    try { localStorage.setItem(ck, JSON.stringify({ d, t: Date.now() })); } catch { /* ignore */ }
    return d;
  };

  // 1) Serverless proxy (works in production where FRED CORS would block the browser).
  try {
    const res = await fetchWithTimeout('/.netlify/functions/mortgage-rate', 8000);
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      const data = await res.json();
      if (Number.isFinite(data?.rate)) return cache({ rate: data.rate, date: String(data.date || '') });
    }
  } catch { /* fall through */ }

  // 2) Direct FRED CSV (may CORS-fail in the browser; works in some environments).
  try {
    const res = await fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US', 8000);
    if (res.ok) {
      const lines = (await res.text()).trim().split(/\r?\n/);
      for (let i = lines.length - 1; i > 0; i--) {
        const [date, val] = lines[i].split(',');
        const rate = parseFloat(val);
        if (Number.isFinite(rate)) return cache({ rate, date });
      }
    }
  } catch { /* ignore */ }

  return null;
}

// NC county → 5-digit FIPS (state 37 + county code), for FRED's Realtor.com
// county housing series. Used to anchor the market-saturation section.
const ncCountyFips: Record<string, string> = {
  Alamance: '37001', Alexander: '37003', Alleghany: '37005', Anson: '37007', Ashe: '37009',
  Avery: '37011', Beaufort: '37013', Bertie: '37015', Bladen: '37017', Brunswick: '37019',
  Buncombe: '37021', Burke: '37023', Cabarrus: '37025', Caldwell: '37027', Camden: '37029',
  Carteret: '37031', Caswell: '37033', Catawba: '37035', Chatham: '37037', Cherokee: '37039',
  Chowan: '37041', Clay: '37043', Cleveland: '37045', Columbus: '37047', Craven: '37049',
  Cumberland: '37051', Currituck: '37053', Dare: '37055', Davidson: '37057', Davie: '37059',
  Duplin: '37061', Durham: '37063', Edgecombe: '37065', Forsyth: '37067', Franklin: '37069',
  Gaston: '37071', Gates: '37073', Graham: '37075', Granville: '37077', Greene: '37079',
  Guilford: '37081', Halifax: '37083', Harnett: '37085', Haywood: '37087', Henderson: '37089',
  Hertford: '37091', Hoke: '37093', Hyde: '37095', Iredell: '37097', Jackson: '37099',
  Johnston: '37101', Jones: '37103', Lee: '37105', Lenoir: '37107', Lincoln: '37109',
  McDowell: '37111', Macon: '37113', Madison: '37115', Martin: '37117', Mecklenburg: '37119',
  Mitchell: '37121', Montgomery: '37123', Moore: '37125', Nash: '37127', 'New Hanover': '37129',
  Northampton: '37131', Onslow: '37133', Orange: '37135', Pamlico: '37137', Pasquotank: '37139',
  Pender: '37141', Perquimans: '37143', Person: '37145', Pitt: '37147', Polk: '37149',
  Randolph: '37151', Richmond: '37153', Robeson: '37155', Rockingham: '37157', Rowan: '37159',
  Rutherford: '37161', Sampson: '37163', Scotland: '37165', Stanly: '37167', Stokes: '37169',
  Surry: '37171', Swain: '37173', Transylvania: '37175', Tyrrell: '37177', Union: '37179',
  Vance: '37181', Wake: '37183', Warren: '37185', Washington: '37187', Watauga: '37189',
  Wayne: '37191', Wilkes: '37193', Wilson: '37195', Yadkin: '37197', Yancey: '37199',
};

export interface MarketMetric { value: number; date: string; prev3?: number | null; prevYear?: number | null; }
export interface CountyMarketStats {
  fips: string;
  medianDaysOnMarket?: MarketMetric | null;
  activeListings?: MarketMetric | null;
  medianListPrice?: MarketMetric | null;
  newListings?: MarketMetric | null;
}

/** Parse a FRED CSV body into latest + 3-month-ago + 1-year-ago points. */
function parseFredCsv(text: string): MarketMetric | null {
  const lines = text.trim().split(/\r?\n/);
  const rows: [string, number][] = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(',');
    const n = parseFloat(v);
    if (Number.isFinite(n)) rows.push([d, n]);
  }
  if (!rows.length) return null;
  const at = (back: number) => (rows[rows.length - 1 - back] ? rows[rows.length - 1 - back][1] : null);
  const last = rows[rows.length - 1];
  return { value: last[1], date: last[0], prev3: at(3), prevYear: at(12) };
}

/**
 * County housing-market stats (median days on market, active listings, median
 * list price, new listings — all residential, Realtor.com via FRED). Tries the
 * serverless proxy first, then a direct CSV read. Cached ~24h. Returns null when
 * unavailable so the report falls back to a Google-Search market read.
 */
export async function fetchCountyMarketStats(countyName: string): Promise<CountyMarketStats | null> {
  const fips = ncCountyFips[countyName?.trim()];
  if (!fips) return null;
  const ck = `gisfs:mktstats:v1:${fips}`;
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v?.d && Date.now() - (v.t || 0) < 24 * 60 * 60 * 1000) return v.d;
    }
  } catch { /* ignore */ }

  const cache = (d: CountyMarketStats) => {
    try { localStorage.setItem(ck, JSON.stringify({ d, t: Date.now() })); } catch { /* ignore */ }
    return d;
  };

  // 1) Serverless proxy (one request, no CORS).
  try {
    const res = await fetchWithTimeout(`/.netlify/functions/market-stats?fips=${fips}`, 10000);
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      const data = await res.json();
      if (data && (data.medianDaysOnMarket || data.activeListings)) return cache({ fips, ...data });
    }
  } catch { /* fall through */ }

  // 2) Direct FRED CSVs (best-effort; may CORS-fail in the browser).
  try {
    const series: Record<string, string> = {
      medianDaysOnMarket: 'MEDDAYONMAR', activeListings: 'ACTLISCOU',
      medianListPrice: 'MEDLISPRI', newListings: 'NEWLISCOU',
    };
    const entries = await Promise.all(
      Object.entries(series).map(async ([k, prefix]) => {
        try {
          const res = await fetchWithTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${prefix}${fips}`, 8000);
          return [k, res.ok ? parseFredCsv(await res.text()) : null] as const;
        } catch { return [k, null] as const; }
      }),
    );
    const out: CountyMarketStats = { fips };
    for (const [k, v] of entries) (out as any)[k] = v;
    if (out.medianDaysOnMarket || out.activeListings) return cache(out);
  } catch { /* ignore */ }

  return null;
}

// Redfin county market data (per product type) — pre-digested monthly by a
// GitHub Action into a small static JSON the app reads. The real §17 anchor.
export interface RedfinTypeMetrics {
  periodEnd: string;
  monthsOfSupply: number | null;
  medianDom: number | null;
  medianDomYoy: number | null;     // absolute day change YoY
  inventory: number | null;
  inventoryYoy: number | null;     // fraction (e.g. -0.008 = -0.8%)
  homesSold: number | null;
  newListings: number | null;
  medianSalePrice: number | null;
  medianSalePriceYoy: number | null; // fraction
  soldAboveList: number | null;      // fraction (share)
}
interface RedfinPayload {
  updated: string; source: string; sourceUrl: string;
  counties: Record<string, Record<string, RedfinTypeMetrics>>;
}

let _redfinPayload: RedfinPayload | null | undefined;

/** County market data by product type from the pre-digested Redfin JSON, or null. */
export async function fetchRedfinCountyMarket(
  countyName: string,
): Promise<{ updated: string; sourceUrl: string; byType: Record<string, RedfinTypeMetrics> } | null> {
  if (_redfinPayload === undefined) {
    try {
      const res = await fetchWithTimeout('/market/nc-county-redfin.json', 8000);
      _redfinPayload = res.ok && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    } catch {
      _redfinPayload = null;
    }
  }
  const byType = _redfinPayload?.counties?.[countyName?.trim()];
  if (!byType) return null;
  return { updated: _redfinPayload!.updated, sourceUrl: _redfinPayload!.sourceUrl, byType };
}

/** Build the per-product-type market-saturation markdown table for the packet. */
export function buildRedfinSaturationTable(
  countyName: string,
  data: { updated: string; sourceUrl: string; byType: Record<string, RedfinTypeMetrics> },
): string {
  const order: [string, string][] = [
    ['single_family', 'Single-family'], ['townhouse', 'Townhouse'],
    ['condo', 'Condo/Co-op'], ['multifamily', 'Multi-family (2-4u)'], ['all', 'All residential'],
  ];
  const n0 = (v: number | null) => (v == null ? 'n/a' : Math.round(v).toLocaleString());
  const mos = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1));
  const dom = (m: RedfinTypeMetrics) =>
    m.medianDom == null ? 'n/a' : `${Math.round(m.medianDom)}${m.medianDomYoy != null ? ` (${m.medianDomYoy > 0 ? '+' : ''}${Math.round(m.medianDomYoy)}d YoY)` : ''}`;
  const inv = (m: RedfinTypeMetrics) =>
    m.inventory == null ? 'n/a' : `${Math.round(m.inventory).toLocaleString()}${m.inventoryYoy != null ? ` (${m.inventoryYoy >= 0 ? '+' : ''}${(m.inventoryYoy * 100).toFixed(0)}% YoY)` : ''}`;
  const price = (m: RedfinTypeMetrics) =>
    m.medianSalePrice == null ? 'n/a' : `$${Math.round(m.medianSalePrice).toLocaleString()}${m.medianSalePriceYoy != null ? ` (${m.medianSalePriceYoy >= 0 ? '+' : ''}${(m.medianSalePriceYoy * 100).toFixed(1)}% YoY)` : ''}`;
  const aboveList = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);

  const rows: string[] = [];
  let asOf = data.updated;
  for (const [key, label] of order) {
    const m = data.byType[key];
    if (!m) continue;
    asOf = m.periodEnd || asOf;
    rows.push(`| ${label} | ${mos(m.monthsOfSupply)} | ${dom(m)} | ${inv(m)} | ${n0(m.homesSold)} | ${n0(m.newListings)} | ${price(m)} | ${aboveList(m.soldAboveList)} |`);
  }
  if (!rows.length) return '';
  return [
    `Live per-PRODUCT-TYPE county market data — ${countyName} County, monthly, as of ${asOf} (Data source: Redfin). USE this table as the Section 17 anchor: read which product types are OVERSUPPLIED / slow (high months-of-supply, rising DOM) vs. absorbing fast (low supply, high % sold above list), recommend what to build, then refine to the ZIP/submarket via Google Search. Cite "Data source: Redfin" (${data.sourceUrl}).`,
    '',
    '| Product type | Months of supply | Median DOM | Active inventory | Homes sold/mo | New listings/mo | Median sale price | % sold above list |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export interface LlcProperty { address: string; county: string; value: number; saleEpoch?: number; }

export interface LlcSkipTrace {
  entityName: string | null;
  sosId?: string | null;
  status?: string | null;
  entityType?: string | null;
  formationDate?: string | null;
  registeredAgentName?: string | null;
  registeredAgentAddress?: string | null;
  principalOffice?: string | null;
  mailingAddress?: string | null;
  officials?: { name: string; title?: string; address?: string }[];
  recentFiling?: string | null;
  notes?: string | null;
  sources?: string[];
  confidence?: 'high' | 'medium' | 'low' | string | null;

  // From NC GIS / county tax records (the reliable backbone — no Cloudflare)
  foundInGIS?: boolean;
  taxMailingAddress?: string | null;
  properties?: LlcProperty[];
  propertyCount?: number;
  propertyCountCapped?: boolean;
  countiesOwned?: string[];
  totalAssessedValue?: number;
}

/**
 * Look an entity up in the NC statewide parcel/tax layer by owner name. Returns
 * the LLC's MAILING address (where the county sends tax bills — the real
 * skip-trace contact) and every NC property it owns. Always available (no
 * Cloudflare), so this is the backbone of the skip trace.
 */
export async function skipTraceLLCViaGIS(name: string): Promise<{
  canonicalName: string; mailingAddress: string | null; properties: LlcProperty[];
  propertyCount: number; capped: boolean; counties: string[]; totalAssessed: number; mostRecentSaleEpoch?: number;
} | null> {
  // Owner names in the layer are stored UPPERCASE, so we uppercase the input and
  // skip the per-row UPPER() function and any server-side sort — this keeps the
  // statewide owner scan as cheap as possible (it's the kind of heavy query the
  // GIS WAF throttles, so cheaper = less likely to be blocked; we sort by value
  // on the client below).
  const clean = name.trim().toUpperCase().replace(/'/g, "''");
  if (clean.length < 3) return null;
  const where = `ownname LIKE '%${clean}%'`;
  const url = `${NC_PARCEL_ENGINE}?where=${encodeURIComponent(where)}` +
    `&outFields=${encodeURIComponent('parno,ownname,siteadd,scity,mailadd,mcity,mstate,mzip,parval,cntyname,saledate')}` +
    `&returnGeometry=false&resultRecordCount=200&f=json`;

  // Retry a couple of times (the statewide owner scan is occasionally throttled).
  let data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, 20000);
      if (res.ok) {
        const parsed = await res.json().catch(() => null);
        if (parsed && !parsed.error) { data = parsed; break; }
      }
    } catch { /* retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (!data) return null;

  const rows = (data.features || []).map((f: any) => f.attributes).filter((a: any) => a?.ownname);
  if (!rows.length) return null;

  // Canonical owner name = the most common exact ownname among the matches.
  const nameCount = new Map<string, number>();
  for (const a of rows) { const n = String(a.ownname).trim(); if (n) nameCount.set(n, (nameCount.get(n) || 0) + 1); }
  const canonicalName = [...nameCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const fmtMail = (a: any) => [String(a.mailadd ?? '').trim(), [String(a.mcity ?? '').trim(), String(a.mstate ?? '').trim()].filter(Boolean).join(' '), String(a.mzip ?? '').trim()]
    .filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();

  const mailCount = new Map<string, number>();
  const properties: LlcProperty[] = [];
  const counties = new Set<string>();
  let totalAssessed = 0;
  let mostRecentSaleEpoch: number | undefined;
  for (const a of rows) {
    const mail = fmtMail(a);
    if (mail) mailCount.set(mail, (mailCount.get(mail) || 0) + 1);
    const situs = String(a.siteadd ?? '').trim();
    const scity = String(a.scity ?? '').trim();
    const county = String(a.cntyname ?? '').trim();
    if (county) counties.add(county);
    const value = Number(a.parval) || 0;
    totalAssessed += value;
    const sale = Number(a.saledate);
    if (Number.isFinite(sale) && (mostRecentSaleEpoch == null || sale > mostRecentSaleEpoch)) mostRecentSaleEpoch = sale;
    properties.push({
      address: situs ? `${situs}${scity ? `, ${scity}` : ''}` : `${county} County parcel ${a.parno}`,
      county, value, saleEpoch: Number.isFinite(sale) ? sale : undefined,
    });
  }
  const mailingAddress = mailCount.size ? [...mailCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  properties.sort((a, b) => b.value - a.value);

  return {
    canonicalName, mailingAddress, properties: properties.slice(0, 50),
    propertyCount: rows.length, capped: !!data.exceededTransferLimit,
    counties: [...counties].sort(), totalAssessed: Math.round(totalAssessed), mostRecentSaleEpoch,
  };
}

/**
 * Gemini + Google-Search grounded lookup of the SOS registration (registered
 * agent + managers/members). The live NC SOS site is Cloudflare-blocked and not
 * crawlable, but Google has INDEXED the public-records directories that republish
 * it — so grounded search reads those snippets without hitting any captcha. When
 * a GIS anchor is supplied (confirmed name + counties from the tax layer), the
 * model is told the entity definitely exists, which stops false "not found"
 * results and disambiguates similarly named entities. Persistent: it retries
 * more aggressively if the first pass finds no agent/officials.
 */
async function skipTraceLLCViaGemini(
  query: string,
  state: string,
  anchor?: { canonicalName?: string | null; counties?: string[] }
): Promise<LlcSkipTrace | null> {
  const geminiApiKey = getUserKeys().gemini || '';
  if (!geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`;

  const name = anchor?.canonicalName || query;
  const registry = state === 'NC' ? 'the NC Secretary of State (sosnc.gov)' : `the ${state} Secretary of State business registry`;
  const anchorLine = anchor?.canonicalName
    ? `CONFIRMED REAL ENTITY: county tax records list "${anchor.canonicalName}" as the owner of real property${anchor.counties?.length ? ` in ${anchor.counties.join(', ')} County, ${state}` : ''}. Do NOT report that it cannot be found — it exists. Use this to pick the right entity among similar names.`
    : '';

  const buildPrompt = (aggressive: boolean) => `Find the ${state} Secretary of State registration for this LLC / business entity: "${name}".
${anchorLine}
PRIMARY GOAL: the REGISTERED AGENT and the COMPANY OFFICIALS (managers / members / officers) — the real people behind the LLC. That is the whole point of this lookup.
Use Google Search. The live SoS site is usually un-crawlable, so rely on the INDEXED public-records directories that republish it: ${registry} result snippets, bizapedia.com, corporationwiki.com, buzzfile.com, and news/legal filings. Do NOT use or cite OpenCorporates.${aggressive ? `
Search HARD with several queries and read the directory pages, e.g.:
  • "${name}" registered agent ${state}
  • "${name}" manager member ${state === 'NC' ? 'North Carolina' : state}
  • "${name}" bizapedia
  • "${name}" corporationwiki` : ''}
Return ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "entityName": "exact registered name",
  "sosId": "state SOSID / entity number | null",
  "status": "Active / Current-Active / Dissolved / Admin Dissolved | null",
  "entityType": "Limited Liability Company / Corporation | null",
  "formationDate": "YYYY-MM-DD | null",
  "registeredAgentName": "| null",
  "registeredAgentAddress": "| null",
  "principalOffice": "| null",
  "mailingAddress": "| null",
  "officials": [{ "name": "", "title": "Manager / Member / Officer / President", "address": "" }],
  "recentFiling": "most recent annual report or amendment + date | null",
  "confidence": "high | medium | low",
  "sources": ["https://...", "https://..."]
}
\`\`\`
Rules: NEVER invent names, addresses, IDs, or dates — use null for anything no source supports, and list the source URLs you actually used. Set "confidence" by how directly a credible source states the agent/officials. Do your best to fill registeredAgentName and at least one official; leave them null only if genuinely unavailable.`;

  const callOnce = async (aggressive: boolean): Promise<LlcSkipTrace | null> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPrompt(aggressive) }] }],
          systemInstruction: { parts: [{ text: 'You are a meticulous corporate-records skip-tracer. You find the registered agent and the managers/members behind an LLC from the Secretary of State registry and indexed public-records directories. Report only source-supported facts; never fabricate. Return the requested JSON only.' }] },
          tools: [{ google_search: {} }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
      const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
      const jsonStr = m ? (m[1] || m[0]) : '';
      if (!jsonStr) return null;
      const obj = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1')) as LlcSkipTrace;
      if (!obj) return null;
      if (!Array.isArray(obj.officials)) obj.officials = [];
      if (!Array.isArray(obj.sources)) obj.sources = [];
      return obj;
    } catch {
      return null;
    }
  };

  const hasContacts = (o: LlcSkipTrace | null) => !!(o && (o.registeredAgentName || (o.officials && o.officials.length)));

  let out = await callOnce(false);
  if (!hasContacts(out)) {
    const retry = await callOnce(true);
    if (hasContacts(retry) || (retry && !out)) out = retry;
  }
  if (out && !out.entityName) out.entityName = anchor?.canonicalName || query.trim();
  return out;
}

/**
 * Skip-trace an LLC. Backbone is NC GIS/tax records (the LLC's mailing address +
 * every property it owns — always available, no Cloudflare). Gemini + Google
 * Search supplements the SOS registration (registered agent + managers/members)
 * when it can. Returns a result whenever EITHER source finds the entity.
 */
export async function skipTraceLLC(query: string, state = 'NC'): Promise<LlcSkipTrace | null> {
  if (!getUserKeys().gemini) throw new Error('Gemini API key required (set it in Account Settings).');

  // GIS first (fast, reliable) so it can anchor the AI lookup — the confirmed
  // owner name + counties stop false "not found" results and disambiguate.
  const gis = state === 'NC' ? await skipTraceLLCViaGIS(query).catch(() => null) : null;
  const ai = await skipTraceLLCViaGemini(
    query,
    state,
    gis ? { canonicalName: gis.canonicalName, counties: gis.counties } : undefined,
  ).catch(() => null);

  if (!gis && !ai) return null;

  const result: LlcSkipTrace = {
    entityName: gis?.canonicalName || ai?.entityName || query.trim(),
    sosId: ai?.sosId ?? null,
    status: ai?.status ?? null,
    entityType: ai?.entityType ?? null,
    formationDate: ai?.formationDate ?? null,
    registeredAgentName: ai?.registeredAgentName ?? null,
    registeredAgentAddress: ai?.registeredAgentAddress ?? null,
    principalOffice: ai?.principalOffice ?? null,
    mailingAddress: ai?.mailingAddress ?? null,
    officials: ai?.officials ?? [],
    recentFiling: ai?.recentFiling ?? null,
    sources: ai?.sources ?? [],
    confidence: ai?.confidence ?? null,
    // GIS backbone
    foundInGIS: !!gis,
    taxMailingAddress: gis?.mailingAddress ?? null,
    properties: gis?.properties ?? [],
    propertyCount: gis?.propertyCount ?? 0,
    propertyCountCapped: gis?.capped ?? false,
    countiesOwned: gis?.counties ?? [],
    totalAssessedValue: gis?.totalAssessed ?? 0,
  };
  return result;
}

/**
 * FEMA National Flood Hazard Layer (NFHL) — authoritative flood-zone lookup by
 * coordinate. Returns the effective flood zone, whether the point is in a Special
 * Flood Hazard Area, and a citable FEMA source link. Degrades gracefully
 * (status 'unavailable') so the report flags verification instead of guessing.
 */
export async function fetchFemaFloodZone(lat: number, lng: number): Promise<FloodZoneInfo> {
  const sourceUrl = `https://msc.fema.gov/portal/search?AddressQuery=${encodeURIComponent(`${lat}, ${lng}`)}`;
  try {
    const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`;
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error('NFHL query error');
    const feats: any[] = data?.features || [];
    if (feats.length === 0) return { zone: 'UNKNOWN', inSFHA: false, status: 'no-coverage', sourceUrl };
    // If the point straddles zones, prefer the Special Flood Hazard Area record.
    const chosen = feats.find((f) => String(f?.attributes?.SFHA_TF).toUpperCase() === 'T') || feats[0];
    const a = chosen.attributes || {};
    return {
      zone: a.FLD_ZONE || 'UNKNOWN',
      inSFHA: String(a.SFHA_TF).toUpperCase() === 'T',
      subtype: a.ZONE_SUBTY || undefined,
      status: 'mapped',
      sourceUrl,
    };
  } catch (e) {
    console.warn('FEMA NFHL flood lookup failed:', e);
    return { zone: 'UNKNOWN', inSFHA: false, status: 'unavailable', sourceUrl };
  }
}

/**
 * USFWS National Wetlands Inventory (NWI) — wetlands presence/classification by
 * coordinate. Tries both NWI service hosts; returns present=null with status
 * 'unavailable' if NWI is down, so the report verifies via the NWI Wetlands
 * Mapper rather than assuming the site is wetland-free.
 */
export async function fetchNwiWetlands(lat: number, lng: number): Promise<WetlandsInfo> {
  const sourceUrl = 'https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper';
  const hosts = [
    'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
    'https://fwsprimary.wim.usgs.gov/server/rest/services/Wetlands/MapServer/0/query',
  ];
  for (const base of hosts) {
    try {
      const url = `${base}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=WETLAND_TYPE,ATTRIBUTE&returnGeometry=false&f=json`;
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.error) continue;
      const feats: any[] = data?.features || [];
      const types = Array.from(new Set(feats.map((f) => f?.attributes?.WETLAND_TYPE).filter(Boolean))) as string[];
      return {
        present: feats.length > 0,
        types,
        status: feats.length > 0 ? 'mapped' : 'none-at-point',
        sourceUrl,
      };
    } catch {
      // try the next host
    }
  }
  return { present: null, types: [], status: 'unavailable', sourceUrl };
}

/**
 * Computes an accurate slope/elevation profile for the parcel using USGS 3DEP
 * elevation (the National Map EPQS service, 1-meter resolution where available).
 * It samples an N×N grid of points across the parcel footprint, fetches each
 * point's true ground elevation, and derives slope by finite differences over
 * the grid (spacing computed in meters). Falls back to a simulated profile only
 * if the elevation service is unreachable.
 */
export async function fetchOpenTopographySlope(lat: number, lng: number, _parcelId: string, boundaryRings?: number[][][]): Promise<SlopeProfile> {
  // Parcel bounding box (or a small box around the point if no geometry).
  let minLat = lat - 0.0003, maxLat = lat + 0.0003, minLng = lng - 0.0003, maxLng = lng + 0.0003;
  if (boundaryRings && boundaryRings[0] && boundaryRings[0].length > 0) {
    const lats = boundaryRings[0].map(c => c[1]);
    const lngs = boundaryRings[0].map(c => c[0]);
    minLat = Math.min(...lats); maxLat = Math.max(...lats);
    minLng = Math.min(...lngs); maxLng = Math.max(...lngs);
  }

  // Sample a 5×5 grid across the parcel and query USGS 3DEP (EPQS) in parallel.
  const N = 5;
  const pts: { lat: number; lng: number; r: number; c: number }[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      pts.push({
        lat: minLat + (maxLat - minLat) * (r / (N - 1)),
        lng: minLng + (maxLng - minLng) * (c / (N - 1)),
        r, c,
      });
    }
  }

  try {
    const elevations = await Promise.all(pts.map(async (p) => {
      try {
        const res = await fetchWithTimeout(`https://epqs.nationalmap.gov/v1/json?x=${p.lng}&y=${p.lat}&units=Meters&wkid=4326`, 8000);
        if (!res.ok) return null;
        const v = parseFloat((await res.json()).value);
        return Number.isFinite(v) && v > -1000 ? v : null;
      } catch { return null; }
    }));

    const grid: (number | null)[][] = Array.from({ length: N }, () => Array<number | null>(N).fill(null));
    pts.forEach((p, i) => { grid[p.r][p.c] = elevations[i]; });
    const valid = elevations.filter((e): e is number => e != null);
    if (valid.length < N * N * 0.6) throw new Error("Insufficient USGS 3DEP coverage at this location");

    // Grid spacing in meters.
    const midLat = (minLat + maxLat) / 2;
    const cellH = ((maxLat - minLat) / (N - 1)) * 111320;
    const cellW = ((maxLng - minLng) / (N - 1)) * 111320 * Math.cos((midLat * Math.PI) / 180);

    const slopes: number[] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const z = grid[r][c];
        if (z == null) continue;
        const zl = c > 0 ? grid[r][c - 1] : null;
        const zr = c < N - 1 ? grid[r][c + 1] : null;
        const zu = r > 0 ? grid[r - 1][c] : null;
        const zd = r < N - 1 ? grid[r + 1][c] : null;
        let dzdx = 0;
        if (zl != null && zr != null && cellW > 0) dzdx = (zr - zl) / (2 * cellW);
        else if (zr != null && cellW > 0) dzdx = (zr - z) / cellW;
        else if (zl != null && cellW > 0) dzdx = (z - zl) / cellW;
        let dzdy = 0;
        if (zu != null && zd != null && cellH > 0) dzdy = (zu - zd) / (2 * cellH);
        else if (zd != null && cellH > 0) dzdy = (z - zd) / cellH;
        else if (zu != null && cellH > 0) dzdy = (zu - z) / cellH;
        const slopePct = Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100;
        if (Number.isFinite(slopePct)) slopes.push(slopePct);
      }
    }
    if (slopes.length === 0) throw new Error("Could not compute slope from elevation grid");

    const minElevation = Math.min(...valid);
    const maxElevation = Math.max(...valid);
    const avgElevation = valid.reduce((a, b) => a + b, 0) / valid.length;
    const maxSlope = Math.max(...slopes);
    const avgSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
    let verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE' = 'BUILDABLE';
    if (maxSlope > 25) verdict = 'NON-BUILDABLE';
    else if (maxSlope >= 15) verdict = 'REQUIRES ENGINEERING';

    return {
      avgSlope: Math.round(avgSlope * 10) / 10,
      maxSlope: Math.round(maxSlope * 10) / 10,
      avgElevation: Math.round(avgElevation * 10) / 10,
      minElevation: Math.round(minElevation * 10) / 10,
      maxElevation: Math.round(maxElevation * 10) / 10,
      verdict,
    };
  } catch (err) {
    console.warn("USGS 3DEP (EPQS) slope query failed; using simulation fallback:", err);
    return generateMockSlope(lat, lng);
  }
}

function generateMockSlope(lat: number, lng: number): SlopeProfile {
  const hash = Math.abs(Math.round((lat + lng) * 100000)) % 100;
  let avgSlope = 3.5 + (hash % 15); // ranges 3.5% to 18.5%
  let maxSlope = avgSlope * (1.5 + (hash % 10) / 10); // max slope
  
  let verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE' = 'BUILDABLE';
  if (maxSlope > 25) {
    verdict = 'NON-BUILDABLE';
  } else if (maxSlope >= 15) {
    verdict = 'REQUIRES ENGINEERING';
  }
  
  const avgElevation = 210 + (hash % 40);
  return {
    avgSlope: Math.round(avgSlope * 10) / 10,
    maxSlope: Math.round(maxSlope * 10) / 10,
    avgElevation: Math.round(avgElevation * 10) / 10,
    minElevation: Math.round((avgElevation - 5) * 10) / 10,
    maxElevation: Math.round((avgElevation + 8) * 10) / 10,
    verdict
  };
}

function getPermittedCategory(zoningCode: string, zoningDesc: string): 'residential' | 'commercial' | 'multifamily' {
  const code = (zoningCode || '').toUpperCase();
  const desc = (zoningDesc || '').toLowerCase();
  
  if (
    code.startsWith('R-') ||
    code.startsWith('N1-') ||
    code.startsWith('SF-') ||
    code.startsWith('SFT-') ||
    code === 'R1' || code === 'R2' || code === 'R3' || code === 'R4' ||
    desc.includes('single family') ||
    desc.includes('residential single') ||
    code === 'R-1' ||
    code === 'R-10' ||
    code === 'R-4' ||
    code === 'TOD-TR'
  ) {
    if (
      code.startsWith('TOD-M') || 
      code.startsWith('UR-') || 
      code.includes('MF') || 
      desc.includes('multi-family') || 
      desc.includes('apartment') || 
      desc.includes('townhome')
    ) {
      return 'multifamily';
    }
    return 'residential';
  }
  
  if (
    code.startsWith('B-') ||
    code.startsWith('I-') ||
    code.startsWith('C-') ||
    code.startsWith('O-') ||
    code.startsWith('M-') ||
    code === 'UMUD' ||
    code.startsWith('TOD-U') ||
    desc.includes('commercial') ||
    desc.includes('business') ||
    desc.includes('industrial') ||
    desc.includes('office') ||
    desc.includes('retail')
  ) {
    return 'commercial';
  }
  
  if (
    code.startsWith('MF') ||
    code.startsWith('UR-') ||
    code.startsWith('TOD-M') ||
    code.startsWith('TOD-CC') ||
    desc.includes('multi-family') ||
    desc.includes('condo') ||
    desc.includes('townhouse') ||
    desc.includes('mixed-use') ||
    desc.includes('apartment')
  ) {
    return 'multifamily';
  }
  
  return 'residential';
}


export function getUseCategory(zoningCode: string, zoningDesc: string): 'residential' | 'commercial' | 'multifamily' {
  return getPermittedCategory(zoningCode, zoningDesc);
}

const GEOCODE_CACHE_PREFIX = "gisfs:geo:v1:";
const GEOCODE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days per spec

async function geocodeAddress(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  // 90-day geocode cache (Google Geocoding is the only geocoder).
  const geoKey = GEOCODE_CACHE_PREFIX + address.toLowerCase().trim().replace(/\s+/g, " ");
  try {
    const raw = localStorage.getItem(geoKey);
    if (raw) {
      const v = JSON.parse(raw);
      if (Number.isFinite(v?.lat) && Number.isFinite(v?.lng) && Date.now() - (v.t || 0) < GEOCODE_CACHE_TTL_MS) {
        return { lat: v.lat, lng: v.lng };
      }
    }
  } catch { /* ignore */ }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (res.ok) {
      const data = await res.json();
      if (data.status === "OK" && data.results && data.results[0]) {
        const result = data.results[0];
        
        // 1. Verify it represents an actual specific property.
        // It must have a street number or be a precise street address, premise, or subpremise.
        const hasStreetNumber = result.address_components?.some((comp: any) =>
          comp.types.includes("street_number")
        );
        const hasPropertyType = result.types?.some((t: string) =>
          ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].includes(t)
        );
        
        // Exclude generic types that represent streets, cities, postal codes, etc.
        const isGeneric = result.types?.some((t: string) =>
          ["route", "locality", "postal_code", "administrative_area_level_1", "administrative_area_level_2", "country", "neighborhood"].includes(t)
        );

        if ((hasStreetNumber || hasPropertyType) && !isGeneric && result.geometry?.location) {
          const coords = {
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng
          };
          try { localStorage.setItem(geoKey, JSON.stringify({ ...coords, t: Date.now() })); } catch { /* ignore */ }
          return coords;
        } else {
          console.warn(`Geocoding rejected address "${address}" because it does not resolve to a specific property. Types: ${JSON.stringify(result.types)}`);
        }
      }
    }
  } catch (e) {
    console.error("Geocoding failed for address:", address, e);
  }
  return null;
}

/**
 * Fallback zoning lookup for counties without a published zoning GIS: asks Gemini
 * (with Google Search grounding) for the official zoning district of a specific
 * address from government/official sources, returning a code + description +
 * source URL. Returns null if nothing credible is found. The result is clearly
 * labeled as a web lookup ("verify") in the UI — it is not authoritative.
 */
export async function fetchZoningViaWebSearch(
  address: string,
): Promise<{ code: string; description: string; sourceUrl?: string } | null> {
  const geminiApiKey = getUserKeys().gemini || "";
  if (!geminiApiKey) {
    console.warn("Gemini API key is not configured in Account Settings.");
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`;
  const prompt = `Find the official ZONING DISTRICT for this exact property address: "${address}".
Search official sources only: the county or municipal zoning map, the local GIS/parcel viewer, or the planning department.
Return ONLY a JSON object inside a markdown code block:
\`\`\`json
{ "zoningCode": "R-1", "zoningDescription": "Single-Family Residential", "source": "https://..." }
\`\`\`
Rules: "zoningCode" must be the actual district code that jurisdiction uses (e.g. R-1, RA, C-2, PUD, MX). If you cannot confirm the zoning from a credible official/government source, return {"zoningCode": null}. Never guess or fabricate a code.`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [{ text: "You are a zoning research assistant. Use Google Search to find the official zoning district for a specific address from government/official sources. Only report a code you can support from a credible source; otherwise return null. Never fabricate." }]
        },
        tools: [{ google_search: {} }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    const jsonStr = m ? (m[1] || m[0]) : '';
    if (!jsonStr) return null;
    const obj = JSON.parse(jsonStr);
    const code = obj?.zoningCode;
    if (!code || typeof code !== 'string' || code.trim() === '' || code.trim().toLowerCase() === 'null') return null;
    return {
      code: code.trim(),
      description: (typeof obj.zoningDescription === 'string' && obj.zoningDescription.trim()) || 'Zoning (web lookup)',
      sourceUrl: typeof obj.source === 'string' ? obj.source : undefined,
    };
  } catch (e) {
    console.warn("Web zoning lookup failed:", e);
    return null;
  }
}

/**
 * Uses client-side Google Maps JavaScript SDK's DistanceMatrixService to fetch exact driving distances and times.
 */
async function fetchDrivingDistancesViaSDK(
  lat: number,
  lng: number,
  destinations: { lat: number; lng: number }[]
): Promise<({ distanceMiles: number; durationMins: number } | null)[] | null> {
  if (
    typeof window === "undefined" ||
    !(window as any).google ||
    !(window as any).google.maps ||
    !(window as any).google.maps.DistanceMatrixService
  ) {
    console.warn("Google Maps JS SDK DistanceMatrixService is not available in the global context.");
    return null;
  }
  const google = (window as any).google;
  const service = new google.maps.DistanceMatrixService();

  // Google's Distance Matrix allows max 25 destinations per request, so we batch
  // larger comp sets into chunks of 25 and stitch the results back together.
  const CHUNK = 25;
  const queryChunk = (chunk: { lat: number; lng: number }[]) =>
    new Promise<({ distanceMiles: number; durationMins: number } | null)[]>((resolve) => {
      try {
        service.getDistanceMatrix(
          {
            origins: [new google.maps.LatLng(lat, lng)],
            destinations: chunk.map(d => new google.maps.LatLng(d.lat, d.lng)),
            travelMode: google.maps.TravelMode.DRIVING,
            unitSystem: google.maps.UnitSystem.IMPERIAL
          },
          (response: any, status: any) => {
            if (status === google.maps.DistanceMatrixStatus.OK && response?.rows?.[0]?.elements) {
              resolve(response.rows[0].elements.map((el: any) =>
                el && el.status === "OK" && el.distance && el.duration
                  ? { distanceMiles: el.distance.value * 0.000621371, durationMins: el.duration.value / 60 }
                  : null
              ));
            } else {
              console.warn("Distance Matrix SDK chunk returned non-OK status:", status);
              resolve(chunk.map(() => null));
            }
          }
        );
      } catch (err) {
        console.error("Error calling Distance Matrix SDK Service:", err);
        resolve(chunk.map(() => null));
      }
    });

  const results: ({ distanceMiles: number; durationMins: number } | null)[] = [];
  for (let i = 0; i < destinations.length; i += CHUNK) {
    const chunkResults = await queryChunk(destinations.slice(i, i + CHUNK));
    results.push(...chunkResults);
  }
  return results.length === destinations.length ? results : null;
}

/** Normalized street key for de-duping / matching detail records to comps. */
function normalizeStreetKey(address: string): string {
  return String(address)
    .toLowerCase()
    .replace(/\b(apt|unit|ste|suite|lot|#)\s*[\w-]*$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Google Distance Matrix result cache (per origin/dest pair, rounded to 5
// decimals ≈ 1m). Only SUCCESSFUL driving results are cached — straight-line
// fallbacks are never cached.
// ---------------------------------------------------------------------------
const DM_CACHE_PREFIX = "gisfs:dm:v1:";

function dmCacheKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
  return `${DM_CACHE_PREFIX}${oLat.toFixed(5)},${oLng.toFixed(5)}|${dLat.toFixed(5)},${dLng.toFixed(5)}`;
}

function readDmCache(key: string): { distanceMiles: number; durationMins: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(v?.d) && Number.isFinite(v?.t) ? { distanceMiles: v.d, durationMins: v.t } : null;
  } catch { return null; }
}

function writeDmCache(key: string, r: { distanceMiles: number; durationMins: number }): void {
  try { localStorage.setItem(key, JSON.stringify({ d: r.distanceMiles, t: r.durationMins })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// ZIP health: ZIPs that come back empty on 2+ consecutive runs are marked dead
// and skipped on later runs (28082 is seeded dead per spec).
// ---------------------------------------------------------------------------
const ZIP_HEALTH_KEY = "gisfs:zip_health:v1";

function readZipHealth(): Record<string, { empty: number; dead: boolean }> {
  try {
    const raw = localStorage.getItem(ZIP_HEALTH_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") return v;
  } catch { /* ignore */ }
  return { "28082": { empty: 2, dead: true } }; // seeded dead ZIP
}

function writeZipHealth(h: Record<string, { empty: number; dead: boolean }>): void {
  try { localStorage.setItem(ZIP_HEALTH_KEY, JSON.stringify(h)); } catch { /* ignore */ }
}

function updateZipHealth(zip: string, productive: boolean): void {
  if (!/^\d{5}$/.test(zip)) return;
  const h = readZipHealth();
  const cur = h[zip] || { empty: 0, dead: false };
  if (productive) {
    h[zip] = { empty: 0, dead: false };
  } else {
    const empty = cur.empty + 1;
    h[zip] = { empty, dead: empty >= 2 };
  }
  writeZipHealth(h);
}

// ---------------------------------------------------------------------------
// Comp result cache. The Gemini/Google-Search comp discovery is inherently
// non-deterministic, so without a cache the SAME address could return a
// DIFFERENT comp set on every run. We persist the final verified comp set per
// parcel location (localStorage, 7-day TTL) so repeat searches on the same
// address are instant AND return identical comps.
// ---------------------------------------------------------------------------
const COMPS_CACHE_PREFIX = "gisfs:comps:v16:"; // v16 = drop active/pending via Zillow marketingStatus
const COMPS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function compsCacheKey(lat: number, lng: number, category: string): string {
  // ~1m coordinate precision → the same parcel always maps to the same key.
  return `${COMPS_CACHE_PREFIX}${lat.toFixed(5)},${lng.toFixed(5)}|${category}`;
}

function readCompsCache(key: string): { comps: CompProperty[]; summary: string } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.comps) || typeof entry.t !== "number") return null;
    if (Date.now() - entry.t > COMPS_CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return { comps: entry.comps as CompProperty[], summary: typeof entry.summary === "string" ? entry.summary : "" };
  } catch {
    return null;
  }
}

function writeCompsCache(key: string, comps: CompProperty[], summary: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), comps, summary }));
  } catch {
    // localStorage full/unavailable — caching is best-effort only.
  }
}

// ---------------------------------------------------------------------------
// SOLE comp source: Google Search (Gemini grounding) over PUBLIC MLS sources —
// public MLS portals (Realtor.com, Zillow, Redfin, Homes.com, Trulia, Movoto),
// county register-of-deeds / tax records, and builder closing records. To
// MAXIMIZE coverage, several differently-angled searches run in PARALLEL and
// the unique results are merged.
// ---------------------------------------------------------------------------

/** One grounded Google search for sold new-construction comps. */
async function runGeminiCompQuery(
  geminiApiKey: string,
  subjectAddress: string,
  areaLine: string,
  sourceAngle: string,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgoIso: string,
): Promise<any[]> {
  const propertyTypePrompt = category === 'residential'
    ? 'single-family residential (SFR)'
    : category === 'commercial'
      ? 'commercial or retail'
      : 'multifamily townhome, condo, or apartment';

  const queryPrompt = `The SUBJECT PROPERTY is: ${subjectAddress}.
Use Google Search to find recently SOLD ${propertyTypePrompt} properties within 5 DRIVING MILES of that exact subject property — searching ${areaLine}.
${sourceAngle}

Criteria for each comp (ALL must hold):
- SOLD/CLOSED within the last 12 months (sale date on or after ${oneYearAgoIso}).
- NEW CONSTRUCTION: year built 2025 or 2026 ONLY.
- Within 5 driving miles of the subject property. THE CLOSER THE BETTER — sales on the subject's own street, in its own subdivision, and in its immediate neighborhood are the MOST valuable comps; never skip them for being too close. Cover the FULL radius: the subject's neighborhood, its ZIP, AND every adjacent town/ZIP that falls inside 5 miles (identify those adjacent areas yourself and search them too).
- Completed ${propertyTypePrompt} properties only — the type must match. NEVER vacant land, raw lots, or unbuilt pads.

BE THOROUGH — LAZINESS IS A FAILURE:
- Run AT LEAST 8 DISTINCT search queries across the sources above before answering, with different phrasings (street/subdivision names near the subject, "new construction sold 2025", "new construction sold 2026", builder community names, adjacent town names).
- Specifically hunt for NEW-CONSTRUCTION SUBDIVISIONS and builder communities near the subject (search "<area> new construction community" first, then find each community's closed sales).
- Do NOT stop at the first page of results or after finding a few comps. Keep searching until additional queries stop surfacing NEW qualifying sales.
- Return EVERY qualifying sold property you find — skipping a sale that meets the criteria is an error. NO maximum count.
- Include the living-area square footage when the source shows it. Never fabricate addresses, prices, sale dates, or year built — only real, verifiable closed sales.

Output ONLY a JSON array inside a markdown code block:
\`\`\`json
[
  { "address": "123 Example St, City, NC 28120", "price": 399900, "saleDate": "2026-01-20", "yearBuilt": 2025, "sqft": 1400, "propertyType": "Single-Family Residential (SFR)", "sourceName": "Realtor.com" }
]
\`\`\``;

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`,
    120000,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: queryPrompt }] }],
        systemInstruction: {
          parts: [{ text: "You are an exhaustive real estate comps research agent specializing in PUBLIC MLS data. Use Google Search across public MLS portals and public records to find CLOSED/SOLD listings, returning them as structured JSON. Pull EVERY real, verifiable sold property meeting the criteria — there is no maximum; stopping at a handful is a failure. Never include vacant land, active/pending listings, list prices, or estimates — closed sold prices only. Never fabricate." }]
        },
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0 }
      }),
    },
  );
  if (!res.ok) return [];
  const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = parseCompsFromJsonText(text);
  if (!parsed) return [];
  return parsed
    .filter((c: any) => c && typeof c.address === 'string' && c.address.trim())
    .map((c: any) => ({
      address: String(c.address).trim(),
      price: Number(c.price) || 0,
      saleDate: String(c.saleDate || ''),
      yearBuilt: c.yearBuilt != null ? Number(c.yearBuilt) : undefined,
      sqft: Number(c.sqft) > 0 ? Number(c.sqft) : undefined,
      propertyType: typeof c.propertyType === 'string' ? c.propertyType : undefined,
      sourceName: typeof c.sourceName === 'string' ? c.sourceName : 'Public MLS (Google Search)',
      status: 'sold',
    }));
}

/**
 * Exhaustive comp discovery in TWO passes:
 *   Pass 1 — several PARALLEL grounded searches anchored to the subject
 *   address, each angled at a different slice of the public MLS ecosystem
 *   (portals by ZIP, public records by ZIP, portals city-wide, and a
 *   new-construction subdivision hunt covering adjacent towns).
 *   Pass 2 — a GAP-FILL search that is shown everything already found and
 *   ordered to dig for qualifying sales NOT yet on the list.
 * All results merged and de-duplicated by address.
 */
async function fetchGoogleMlsComps(
  subjectAddress: string,
  city: string,
  stateCode: string,
  zip: string,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgoIso: string,
  onStageChange?: (stage: string) => void,
): Promise<any[]> {
  const geminiApiKey = getUserKeys().gemini || "";
  if (!geminiApiKey) {
    console.warn("Gemini API key is not configured — cannot run the public-MLS comp search.");
    return [];
  }

  onStageChange?.("Searching public MLS sources for sold comps (Google)...");

  const portalAngle = "Search the PUBLIC MLS portals: Realtor.com sold listings, Zillow 'Sold' pages, Redfin 'Recently Sold', Homes.com, Trulia, and Movoto. Run separate site-scoped searches (site:realtor.com, site:zillow.com, site:redfin.com, site:homes.com, site:trulia.com, site:movoto.com) plus general queries like \"new construction sold 2025\" and \"new construction sold 2026\" with the area name.";
  const recordsAngle = "Search PUBLIC RECORDS: the county register of deeds, county tax assessor sales records, property transfer records, and local MLS public search portals. Also check national builders' communities in the area (D.R. Horton, Lennar, LGI, Meritage, True Homes, Smith Douglas, etc.) combined with 'sold' or 'closed' queries — new-construction closings often appear in public records before portals.";
  const subdivisionAngle = "Hunt NEW-CONSTRUCTION SUBDIVISIONS: first search for new-construction communities and builder developments near the subject (\"new construction community\", \"new homes\", builder names + the area), including in ADJACENT towns and ZIP codes within 5 miles. Then, for EACH community found, search for its recently CLOSED/SOLD homes across the portals and public records.";

  const merge = (byKey: Map<string, any>, rows: any[]) => {
    for (const c of rows) {
      const key = normalizeStreetKey(c.address);
      if (!key) continue;
      const existing = byKey.get(key);
      // Keep the record with the most complete data (price+sqft) on duplicates.
      if (!existing || (!existing.sqft && c.sqft) || (!existing.price && c.price)) {
        byKey.set(key, { ...existing, ...c });
      }
    }
  };

  // --- Pass 1: parallel angled searches ---
  const areaZip = zip ? `ZIP code ${zip} (${city}, ${stateCode}) and every adjacent ZIP within 5 miles` : `in and around ${city}, ${stateCode}`;
  const areaCity = `in and around ${city}, ${stateCode}, including neighboring towns within 5 miles`;
  const queries: Promise<any[]>[] = [
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaZip, portalAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaZip, recordsAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, portalAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, subdivisionAngle, category, oneYearAgoIso),
  ];
  const settled = await Promise.allSettled(queries);
  const byKey = new Map<string, any>();
  let total = 0;
  for (const s of settled) {
    if (s.status !== 'fulfilled') { console.warn('A comp search query failed:', s.reason); continue; }
    total += s.value.length;
    merge(byKey, s.value);
  }
  console.log(`Public-MLS pass 1: ${settled.length} parallel queries → ${total} rows → ${byKey.size} unique candidates.`);

  // --- Pass 2: gap-fill — show what was found, demand what was missed ---
  onStageChange?.("Gap-fill search — hunting comps the first pass missed...");
  try {
    const foundList = Array.from(byKey.values()).map((c) => c.address).slice(0, 80);
    const gapAngle = `The following qualifying sales were ALREADY FOUND:\n${foundList.length ? foundList.map((a) => `- ${a}`).join('\n') : '- (none found yet — search everything)'}\n\nYour job is to find qualifying sold properties NOT on that list. Use DIFFERENT search queries than the obvious ones: other portals (Movoto, Homes.com, local brokerage sites), county deed/transfer records, subdivision and street names near the subject, adjacent towns inside the 5-mile radius, and "sold" filters on builder community pages. Finding zero additional sales is only acceptable after genuinely exhausting these.`;
    const gapRows = await runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, gapAngle, category, oneYearAgoIso);
    const before = byKey.size;
    merge(byKey, gapRows);
    console.log(`Public-MLS pass 2 (gap-fill): ${gapRows.length} rows → ${byKey.size - before} NEW unique candidates.`);
  } catch (e) {
    console.warn('Gap-fill comp search failed (continuing with pass-1 results):', e);
  }

  const comps = Array.from(byKey.values());
  console.log(`Public-MLS Google search total: ${comps.length} unique candidates.`);
  return comps;
}

// ---------------------------------------------------------------------------
// RealtyAPI sold records (realtyapi.io) — unified access to Realtor, Redfin,
// and Zillow CLOSED sales. Each platform is queried with a coordinate-radius
// search, server-filtered to Sold + new construction (year built >= 2025)
// within the last 12 months, newest first; all three run in parallel and the
// results merge. ONE API key (sent as the `x-realtyapi-key` header) covers
// every platform.
//
// The published OpenAPI specs document request params precisely but NOT the
// response body, and each platform proxies a different source, so responses are
// parsed with a defensive, shape-agnostic normalizer (deep key search). On the
// first run a sample raw record is logged to the console so the field mapping
// can be verified/tightened if a platform changes its shape.
// ---------------------------------------------------------------------------
const REALTY_API_HOSTS: Record<'realtor' | 'redfin' | 'zillow', string> = {
  realtor: "https://realtor.realtyapi.io",
  redfin: "https://redfin.realtyapi.io",
  zillow: "https://zillow.realtyapi.io",
};

const MIN_COMP_YEAR_BUILT = 2025; // new-construction floor (criteria: built 2025-2026)
const MAX_COMP_YEAR_BUILT = 2026; // new-construction ceiling

function getRealtyApiKey(): string {
  return getUserKeys().realtyApi || (import.meta.env.VITE_REALTYAPI_KEY as string | undefined) || "";
}

function getDeepSeekKey(): string {
  return getUserKeys().deepSeek || (import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined) || "";
}

// Per-platform property-type vocabularies (exact tokens from each platform's
// OpenAPI spec). Land / lots are deliberately excluded — comps are completed
// HOMES only, never vacant land. Zillow's homeType tokens aren't documented, so
// it is left unrestricted and filtered client-side by matchesZoningUse() instead.
function realtorPropertyTypes(cat: 'residential' | 'commercial' | 'multifamily'): string {
  if (cat === 'multifamily') return "Townhome,Condo,Multi_Family,Co-op";
  if (cat === 'commercial') return "House,Condo,Townhome,Multi_Family";
  return "House";
}
function redfinHomeTypes(cat: 'residential' | 'commercial' | 'multifamily'): string {
  if (cat === 'multifamily') return "townhouse,condo,Multi family,Co-op";
  if (cat === 'commercial') return "House,condo,townhouse,Multi family";
  return "House";
}

/** Clean, human-readable property-type label (Single-Family / Townhome / Condo / Multi-Family / ...). */
function prettyPropertyType(t: any): string | undefined {
  const s = String(t ?? "").toLowerCase();
  if (!s.trim()) return undefined;
  if (/single|sfr|detached|\bhouse\b|\bhome\b/.test(s)) return "Single-Family";
  if (/town/.test(s)) return "Townhome";
  if (/condo/.test(s)) return "Condo";
  if (/multi|duplex|triplex|fourplex|apartment/.test(s)) return "Multi-Family";
  if (/co.?op/.test(s)) return "Co-op";
  if (/mobile|manufactured/.test(s)) return "Mobile/Manufactured";
  if (/\b(land|lot|acre)\b/.test(s)) return "Land";
  return undefined;
}

/** Does a comp's property type fit the subject's COUNTY ZONING use category? */
function matchesZoningUse(prettyType: string | undefined, category: 'residential' | 'commercial' | 'multifamily'): boolean {
  if (prettyType === "Land" || prettyType === "Mobile/Manufactured") return false; // never land/mobile
  if (!prettyType) return true; // unknown type — server-side type filters already applied
  if (category === 'residential') return prettyType === "Single-Family";
  if (category === 'multifamily') return ["Townhome", "Condo", "Multi-Family", "Co-op"].includes(prettyType);
  return true; // commercial zoning: any completed home type qualifies
}

/** Closed/SOLD only — reject under-contract, pending, coming-soon, for-sale, active listings. */
function isClosedSale(listingStatus: any, saleDate: string, price: number): boolean {
  if (!saleDate || !(price > 0)) return false; // a real closed sale needs a sold date + price
  const s = String(listingStatus ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return true; // no status exposed (some Redfin records) — sold date + price already required
  if (/(pending|contingent|undercontract|comingsoon|forsale|forrent|active|auction|preforeclosure|backup|accepting|inescrow)/.test(s)) return false;
  return true;
}

// --- response-shape helpers (defensive: the API does not document the body) ---
const _norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const _isStr = (v: any) => typeof v === "string" && v.trim() !== "";
const _isNum = (v: any) =>
  typeof v === "number" ? Number.isFinite(v)
  : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, ""))));
const _toNum = (v: any) => (typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, "")));

/** Depth-first search for the first value whose KEY matches `re` and whose value passes `ok`. */
function deepFind(obj: any, re: RegExp, ok: (v: any) => boolean, depth = 6): any {
  if (obj == null || depth < 0) return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const r = deepFind(it, re, ok, depth - 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {       // direct keys first
      if (re.test(_norm(k)) && ok(v)) return v;
    }
    for (const v of Object.values(obj)) {             // then recurse
      if (v && typeof v === "object") {
        const r = deepFind(v, re, ok, depth - 1);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

const REALTY_SOURCE_LABELS: Record<'realtor' | 'redfin' | 'zillow', string> = {
  realtor: "RealtyAPI · Realtor",
  redfin: "RealtyAPI · Redfin",
  zillow: "RealtyAPI · Zillow",
};

/** Coerce to a finite number ($/comma-tolerant); undefined if not numeric. */
function rNum(v: any): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
/** Coerce a date (ISO string or epoch s/ms) to an ISO string ("" if unparseable). */
function rIso(v: any): string {
  if (v == null || v === "") return "";
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}
const _join = (street?: any, city?: any, state?: any, zip?: any): string =>
  [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** Redfin returns propertyType as a numeric code; map the common ones to a label. */
function redfinTypeLabel(code: any): string | undefined {
  const m: Record<string, string> = { "1": "single_family", "2": "condo", "3": "townhouse", "4": "multi_family", "5": "land", "6": "single_family", "13": "townhouse" };
  return m[String(code)] ?? undefined;
}

/**
 * Pulls a usable comp candidate out of one raw RealtyAPI listing. Each platform
 * has a DIFFERENT, real response shape (verified against live responses), so
 * fields are read from explicit per-platform paths, with a generic deep-search
 * fallback for anything a platform omits or relocates.
 *
 * IMPORTANT: Realtor's search payload does NOT include year built (it is filtered
 * server-side via `yearBuiltRange=min:YYYY`), so `newConstructionFlag` is set
 * true by the caller for every record returned from a year-filtered query.
 */
function normalizeRealtyListing(raw: any, platform: 'realtor' | 'redfin' | 'zillow'): any | null {
  if (!raw || typeof raw !== "object") return null;

  let price: number | undefined, saleDate = "", yearBuilt: number | undefined,
      sqft: number | undefined, propertyType: string | undefined,
      coords: { lat: number; lng: number } | undefined,
      address: string | undefined, zip: string | undefined,
      url: string | undefined, propertyId: any, rawStatus: any;

  if (platform === "realtor") {
    const a = raw.address || {};
    price = rNum(raw.last_sold_price) ?? rNum(raw.sold_price);            // SOLD price only
    saleDate = rIso(raw.last_sold_date ?? raw.sold_date);
    yearBuilt = rNum(raw.year_built ?? raw.description?.year_built);      // usually absent
    sqft = rNum(raw.sqft ?? raw.description?.sqft);
    propertyType = raw.property_type ?? raw.type;
    rawStatus = raw.status;
    const la = rNum(a.latitude), lo = rNum(a.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(a.line, a.city, a.state_code ?? a.state, a.postal_code);
    zip = a.postal_code != null ? String(a.postal_code) : undefined;
    url = raw.href ?? raw.permalink;
    propertyId = raw.property_id;
  } else if (platform === "redfin") {
    const h = raw.homeData ?? raw;
    const ai = h.addressInfo ?? {};
    const cen = ai.centroid?.centroid ?? ai.centroid ?? {};
    price = rNum(h.priceInfo?.amount) ?? rNum(h.priceInfo?.homePrice?.int64Value);
    saleDate = rIso(h.lastSaleData?.lastSoldDate ?? h.lastSaleData?.lastSaleDate);
    yearBuilt = rNum(h.yearBuilt?.yearBuilt ?? h.yearBuilt);
    sqft = rNum(h.sqftInfo?.amount);
    propertyType = redfinTypeLabel(h.propertyType);
    rawStatus = (Array.isArray(h.sashes) ? h.sashes.map((x: any) => x?.sashTypeName).filter(Boolean).join(" ") : "") || (h.lastSaleData?.lastSoldDate ? "sold" : "");
    const la = rNum(cen.latitude), lo = rNum(cen.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(ai.formattedStreetLine, ai.city, ai.state, ai.zip);
    zip = ai.zip != null ? String(ai.zip) : undefined;
    url = h.url ? `https://www.redfin.com${h.url}` : undefined;
    propertyId = h.propertyId ?? h.mlsId;
  } else { // zillow
    const pr = raw.property ?? raw;
    const loc = pr.location ?? {};
    const a = pr.address ?? {};
    price = rNum(pr.price?.value) ?? rNum(pr.hdpView?.price);
    saleDate = rIso(pr.lastSoldDate ?? pr.dateSold);
    yearBuilt = rNum(pr.yearBuilt);
    sqft = rNum(pr.livingArea ?? pr.livingAreaValue);
    propertyType = typeof pr.propertyType === "string" ? pr.propertyType : undefined;
    // marketingStatus is the TRUTHFUL market state ("closed" / "offMarket" /
    // "active" / "pending"); listingStatus is misleadingly "recentlySold" even for
    // homes that are actually for-sale or under-contract. Combine all three so
    // isClosedSale() rejects active/pending/coming-soon listings.
    rawStatus = [pr.listing?.marketingStatus, pr.listing?.listingStatus, pr.hdpView?.listingStatus, pr.homeStatus].filter(Boolean).join(" ");
    const la = rNum(loc.latitude), lo = rNum(loc.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(a.streetAddress, a.city, a.state, a.zipcode);
    zip = a.zipcode != null ? String(a.zipcode) : undefined;
    // Canonical Zillow listing URL with the address SLUG (e.g.
    // /homedetails/3142-Dublin-Rd-Charlotte-NC-28208/6178388_zpid/). The bare
    // zpid form 302-redirects (which can trip Zillow's bot wall); the zpid is
    // what actually identifies the home, so a slightly-off slug still resolves.
    // hdpView.hdpUrl is a mobile-app deep link that does NOT open the listing.
    const _zslug = [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean).join(" ").replace(/[^A-Za-z0-9 ]/g, "").trim().replace(/\s+/g, "-");
    url = pr.zpid
      ? `https://www.zillow.com/homedetails/${_zslug ? _zslug + "/" : ""}${pr.zpid}_zpid/`
      : (pr.hdpView?.hdpUrl ? `https://www.zillow.com${pr.hdpView.hdpUrl}` : undefined);
    propertyId = pr.zpid;
  }

  // Generic fallbacks for anything a platform omitted or relocated.
  if (price === undefined) { const v = deepFind(raw, /(soldprice|lastsoldprice|saleprice|closeprice|^price$|pricevalue)/, _isNum); if (v !== undefined) price = _toNum(v); }
  if (!saleDate) { const v = deepFind(raw, /(solddate|lastsolddate|saledate|closedate|datesold)/, (x) => _isStr(x) || _isNum(x)); if (v !== undefined) saleDate = rIso(v); }
  if (yearBuilt === undefined) { const v = deepFind(raw, /(yearbuilt|builtyear|yrbuilt)/, _isNum); if (v !== undefined) yearBuilt = _toNum(v); }
  if (sqft === undefined) { const v = deepFind(raw, /(livingarea|finishedsqft|^sqft$|squarefeet)/, _isNum); if (v !== undefined) sqft = Math.round(_toNum(v)); }
  if (!coords) { const la = deepFind(raw, /(^lat$|latitude)/, _isNum); const lo = deepFind(raw, /(^lng$|^lon$|longitude)/, _isNum); if (_isNum(la) && _isNum(lo)) coords = { lat: _toNum(la), lng: _toNum(lo) }; }
  if (!_isStr(address)) { const ln = deepFind(raw, /(formattedstreetline|streetaddress|^line$|^address$|fulladdress)/, _isStr); if (ln) address = String(ln); }
  if (!_isStr(address)) return null; // no address -> unusable as a comp

  return {
    address: String(address).replace(/\s+/g, " ").trim(),
    price: price === undefined ? 0 : Math.round(price),
    saleDate,
    yearBuilt,
    sqft: sqft && sqft > 0 ? Math.round(sqft) : undefined,
    propertyType: prettyPropertyType(propertyType),
    coords,
    zip,
    status: "sold",
    listingStatus: _isStr(rawStatus) ? rawStatus : (rawStatus != null ? String(rawStatus) : undefined),
    newConstructionFlag: false, // set true by the caller (year-filtered query)
    propertyId: propertyId != null ? String(propertyId) : undefined,
    sourceName: REALTY_SOURCE_LABELS[platform],
    platform,
    detailConfirmed: true,
    url: _isStr(url) ? url : undefined,
  };
}

/**
 * Finds the listings array inside an unknown RealtyAPI response envelope. Each
 * platform nests differently (e.g. Realtor uses `data.home_search.results`,
 * others put the array at the top level), so this searches by preferred key at
 * EVERY depth and falls back to the first array-of-objects it finds.
 */
function extractRealtyListings(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  const PREFERRED = ["listings", "results", "properties", "homes", "props", "searchResults", "hits", "data", "listing", "soldHomes", "items"];
  const isObjArray = (v: any) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null;
  let fallback: any[] = [];
  const visit = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== "object" || depth > 6) return null;
    for (const k of PREFERRED) if (isObjArray((node as any)[k])) return (node as any)[k]; // strong signal
    for (const v of Object.values(node)) if (isObjArray(v) && fallback.length === 0) fallback = v as any[];
    for (const v of Object.values(node)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = visit(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(json, 0) ?? fallback;
}

/** Reads the `nextPage`/`hasMore` flag from an unknown envelope (defaults to false). */
function realtyHasNextPage(json: any): boolean {
  const v = deepFind(json, /(^nextpage$|hasnext|hasmore|morepages)/, (x) => typeof x === "boolean" || x === "true" || x === "false");
  return v === true || v === "true";
}

/**
 * Queries ONE RealtyAPI platform's coordinate-radius SOLD search, paging until
 * the 12-month window is exhausted (or a small page cap). Returns normalized,
 * home-only candidates.
 */
async function fetchRealtyPlatform(
  platform: 'realtor' | 'redfin' | 'zillow',
  lat: number,
  lng: number,
  radiusMiles: number,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgo: Date,
  key: string,
  onStageChange?: (stage: string) => void,
): Promise<any[]> {
  const headers = { "x-realtyapi-key": key };
  const MAX_PAGES = 6;
  const out: any[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      radius: String(radiusMiles),
      page: String(page),
    });
    if (platform === "zillow") {
      q.set("listingStatus", "Sold");
      q.set("soldInLast", "12_months");
      q.set("yearBuiltRange", `min:${MIN_COMP_YEAR_BUILT}`);
      // Zillow ignores the year filter, so sort newest-built FIRST and page until
      // builds drop below the window — captures ALL 2025-2026 sales in range
      // instead of only those that happen to sort early by listing date.
      q.set("sortOrder", "Year_Built");
    } else {
      q.set("searchType", "Sold");
      q.set("sortOrder", "Most_Recently_Sold");
      q.set("resultCount", "200");
      if (platform === "realtor") {
        q.set("propertyType", realtorPropertyTypes(category));
        q.set("yearBuiltRange", `min:${MIN_COMP_YEAR_BUILT}`);
      } else {
        q.set("homeType", redfinHomeTypes(category));
        q.set("soldWithin", "Last_1_Year");
        q.set("minYearBuilt", String(MIN_COMP_YEAR_BUILT));
        q.set("maxYearBuilt", String(MAX_COMP_YEAR_BUILT));
      }
    }

    let json: any;
    try {
      const res = await fetchWithTimeout(`${REALTY_API_HOSTS[platform]}/search/bycoordinates?${q.toString()}`, 20000, { headers });
      if (!res.ok) {
        console.warn(`RealtyAPI ${platform} sold search returned HTTP ${res.status} on page ${page}.`);
        break; // auth/credit/other error — stop this platform, let the others run
      }
      json = await res.json();
    } catch (e) {
      console.warn(`RealtyAPI ${platform} sold search failed on page ${page}:`, e);
      break;
    }

    const listings = extractRealtyListings(json);
    if (page === 1) {
      const envKeys = json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : (Array.isArray(json) ? ["<root array>"] : []);
      console.log(`RealtyAPI ${platform}: ${listings.length} listing(s) on page 1; envelope keys=[${envKeys.join(", ")}]`);
      if (listings.length > 0) console.log(`RealtyAPI ${platform} sample record:`, JSON.stringify(listings[0]).slice(0, 1800));
      else console.log(`RealtyAPI ${platform} raw envelope (no listings parsed):`, JSON.stringify(json).slice(0, 1200));
    }
    if (listings.length === 0) break;

    let pageOldest = Infinity;
    let pageMaxYear = -Infinity;
    for (const raw of listings) {
      const c = normalizeRealtyListing(raw, platform);
      if (!c) continue;
      const t = c.saleDate ? new Date(c.saleDate).getTime() : NaN;
      if (Number.isFinite(t)) pageOldest = Math.min(pageOldest, t);
      if (c.yearBuilt != null) pageMaxYear = Math.max(pageMaxYear, c.yearBuilt);
      // The query is year-filtered server-side (Realtor omits year_built from its
      // payload), so mark every returned record as new construction; when a
      // platform DOES expose the year, enforce the 2025-2026 window.
      if (c.yearBuilt != null && (c.yearBuilt < MIN_COMP_YEAR_BUILT || c.yearBuilt > MAX_COMP_YEAR_BUILT)) continue;
      c.newConstructionFlag = true;
      // CLOSED SALES ONLY — drop under-contract / pending / coming-soon / active
      // (Zillow ignores the Sold filter and leaks them), require sold price + date.
      if (!isClosedSale(c.listingStatus, c.saleDate, c.price)) continue;
      // Match the subject's COUNTY ZONING use (residential -> single-family;
      // multifamily -> townhome/condo/multi-family). Also drops land/lots.
      if (!matchesZoningUse(c.propertyType, category)) continue;
      out.push(c);
    }
    onStageChange?.(`Scanning ${platform} sold records... page ${page} (${out.length} found)`);

    if (!realtyHasNextPage(json)) break;
    if (platform === "zillow") {
      // Zillow is sorted newest-built first: once a whole page falls below the
      // 2025 floor, every later page is older too — stop paging.
      if (Number.isFinite(pageMaxYear) && pageMaxYear < MIN_COMP_YEAR_BUILT) break;
    } else if (Number.isFinite(pageOldest) && pageOldest < oneYearAgo.getTime()) {
      // Realtor/Redfin are sorted newest-SOLD first: stop once a page's oldest
      // sale predates the 12-month window.
      break;
    }
  }
  return out;
}

/**
 * Realtor + Redfin + Zillow SOLD comps via RealtyAPI, queried in parallel and
 * merged (de-duped by street key; higher-priority platform wins, others backfill
 * missing fields). This is the sole external sold-records source. Returns
 * candidates in the shape the comp engine expects (address, price, saleDate,
 * yearBuilt, sqft, coords, propertyType, status, sourceName, detailConfirmed,
 * url, zip, propertyId).
 */
async function fetchRealtyApiSoldComps(
  lat: number,
  lng: number,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgo: Date,
  onStageChange?: (stage: string) => void,
): Promise<any[]> {
  const key = getRealtyApiKey();
  if (!key) {
    console.warn("No RealtyAPI key configured (Settings -> RealtyAPI Key) — skipping the Realtor/Redfin/Zillow records source.");
    return [];
  }
  // 5-mile API radius matches the old behavior; the comp engine then applies the
  // 3 -> 5 DRIVING-mile filter downstream.
  const RADIUS_MILES = 5;
  onStageChange?.("Scanning RealtyAPI sold records (Realtor, Redfin, Zillow)...");

  const platforms: ('realtor' | 'redfin' | 'zillow')[] = ["realtor", "redfin", "zillow"];
  const perPlatform = await Promise.all(
    platforms.map((pf) =>
      fetchRealtyPlatform(pf, lat, lng, RADIUS_MILES, category, oneYearAgo, key, onStageChange).catch((e) => {
        console.warn(`RealtyAPI ${pf} platform failed:`, e);
        return [] as any[];
      }),
    ),
  );

  // Merge across platforms by normalized street key. Realtor wins ties, then
  // Redfin, then Zillow — but any platform fills in fields the winner is missing.
  const order: Record<string, number> = { realtor: 0, redfin: 1, zillow: 2 };
  const byKey = new Map<string, any>();
  for (const list of perPlatform) {
    for (const c of list) {
      const k = normalizeStreetKey(c.address);
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, c); continue; }
      const winner = order[c.platform] <= order[prev.platform] ? c : prev;
      const filler = winner === c ? prev : c;
      byKey.set(k, {
        ...filler, ...winner,
        sqft: winner.sqft ?? filler.sqft,
        coords: winner.coords ?? filler.coords,
        yearBuilt: winner.yearBuilt ?? filler.yearBuilt,
        url: winner.url ?? filler.url,
        zip: winner.zip ?? filler.zip,
      });
    }
  }
  const merged = Array.from(byKey.values());
  const counts = perPlatform.map((l, i) => `${platforms[i]} ${l.length}`).join(", ");
  console.log(`RealtyAPI sold records: ${counts} -> ${merged.length} unique after cross-platform merge.`);
  return merged;
}

function parseCompsFromJsonText(text: string): any[] | null {
  try {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    let jsonString = '';
    if (match) {
      jsonString = match[1];
    } else {
      const startIdx = text.indexOf('[');
      const endIdx = text.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) jsonString = text.substring(startIdx, endIdx + 1);
    }
    if (!jsonString) return null;
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error("Failed to parse comps JSON from LLM response:", e);
    return null;
  }
}

/** Google Distance Matrix via REST (driving, imperial), chunked at 25 destinations. */
async function fetchDrivingDistancesViaREST(
  lat: number,
  lng: number,
  destinations: { lat: number; lng: number }[],
  apiKey: string,
): Promise<({ distanceMiles: number; durationMins: number } | null)[] | null> {
  if (!apiKey || destinations.length === 0) return destinations.length === 0 ? [] : null;
  const CHUNK = 25; // Google's per-request destination cap for 1 origin
  const out: ({ distanceMiles: number; durationMins: number } | null)[] = [];
  try {
    for (let i = 0; i < destinations.length; i += CHUNK) {
      const chunk = destinations.slice(i, i + CHUNK);
      const destStr = chunk.map((d) => `${d.lat},${d.lng}`).join('|'); // lat,lng order; | between pairs
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${destStr}&mode=driving&units=imperial&key=${apiKey}`;
      const res = await fetchWithTimeout(url, 15000);
      if (!res.ok) { out.push(...chunk.map(() => null)); continue; }
      const data = await res.json();
      if (data.status === 'OK' && data.rows?.[0]?.elements) {
        for (const el of data.rows[0].elements) {
          out.push(
            el && el.status === 'OK' && el.distance && el.duration
              ? { distanceMiles: el.distance.value / 1609.344, durationMins: el.duration.value / 60 }
              : null, // NOT_FOUND / ZERO_RESULTS etc. → caller falls back to straight-line
          );
        }
      } else {
        out.push(...chunk.map(() => null)); // top-level non-OK → whole batch falls back
      }
    }
    return out.length === destinations.length ? out : null;
  } catch (e) {
    console.warn('Distance Matrix REST request failed:', e);
    return null;
  }
}

/** Conversational markdown summary: criteria line, per-comp blocks, Bottom Line. */
function buildCompRunSummary(opts: {
  subjectAddress: string;
  comps: CompProperty[];
  radiusExpanded: boolean;
  skippedZips: string[];
  locations: string[];
  candidateCount: number;
  scrapedCount?: number;
  inRadiusCount?: number;
}): string {
  const { subjectAddress, comps, radiusExpanded, skippedZips, locations, candidateCount, scrapedCount, inRadiusCount } = opts;
  const lines: string[] = [];
  lines.push(`## 🏘️ New-Construction Sold Comp Run — ${subjectAddress}`);
  lines.push('');
  lines.push(`Criteria: New construction (built 2025–2026) matching the subject's COUNTY ZONING use category, sold last 12 months, no sqft limits, within 5 driving miles (every qualifying CLOSED sale in range, closest first). Sources: RealtyAPI closed-sale records — Realtor, Redfin & Zillow (coordinate radius scan; under-contract/pending excluded). Distances: Google Distance Matrix driving miles (straight-line in parentheses).`);
  lines.push('');
  lines.push(`Searched: ${locations.join(' · ')}${skippedZips.length ? ` (skipped dead ZIPs: ${skippedZips.join(', ')})` : ''} — ${scrapedCount ?? candidateCount} sold listings collected → ${candidateCount} met the new-construction spec${inRadiusCount != null ? ` → ${inRadiusCount} inside the driving radius` : ''}.`);
  lines.push('');

  if (comps.length > 0) {
    // Property-type mix so the report states what the comps are (single-family,
    // townhome, condo, multi-family, etc.).
    const typeCounts = comps.reduce((m: Record<string, number>, c) => {
      const t = c.propertyType || 'Home'; m[t] = (m[t] || 0) + 1; return m;
    }, {} as Record<string, number>);
    const mix = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} × ${t}`).join(', ');
    lines.push(`Comp mix by type: ${mix}.`);
    lines.push('');
  }

  if (comps.length === 0) {
    const why = candidateCount === 0
      ? `None of the collected sold listings were built 2025–2026 — there may simply be no new-construction resales in this area yet.`
      : (inRadiusCount ?? 0) === 0
        ? `${candidateCount} new-construction sale${candidateCount === 1 ? '' : 's'} matched the spec, but none closed within 5 driving miles of the subject.`
        : `Comps inside the radius could not be confirmed.`;
    lines.push(`**No qualifying new-construction comps for this run.** ${why} Use the county tax-assessor values as the only valuation reference.`);
    return lines.join('\n');
  }

  comps.forEach((c, i) => {
    lines.push(`**${i + 1}. ${c.address}**`);
    lines.push(`- Distance: **${c.distanceMiles.toFixed(1)} mi driving** (${(c.straightLineMiles ?? c.distanceMiles).toFixed(1)} mi straight-line)`);
    if (c.drivingFallback) lines.push(`- ⚠ Driving distance unavailable from Google — straight-line used as fallback.`);
    const ppsf = c.pricePerSqft ? ` · $${c.pricePerSqft.toLocaleString()}/sqft` : '';
    const sqft = c.sqft ? ` · ${c.sqft.toLocaleString()} sqft` : '';
    lines.push(`- Sold: **$${c.price.toLocaleString()}** on ${c.saleDate}${sqft}${ppsf} · ${c.propertyType || 'Home'} · Built ${c.yearBuilt ?? 'N/A'}`);
    lines.push(`- ${c.verifiedNote || 'Source: RealtyAPI closed-sale record'}`);
    if (c.priceDiscrepancy) lines.push(`- Price discrepancy: ${c.priceDiscrepancy}`);
    lines.push('');
  });

  const avgPrice = Math.round(comps.reduce((s, c) => s + c.price, 0) / comps.length);
  const ppsfVals = comps.filter((c) => c.pricePerSqft).map((c) => c.pricePerSqft as number);
  const avgPpsf = ppsfVals.length ? Math.round(ppsfVals.reduce((s, v) => s + v, 0) / ppsfVals.length) : 0;
  const minP = Math.min(...comps.map((c) => c.price));
  const maxP = Math.max(...comps.map((c) => c.price));
  const fallbackCount = comps.filter((c) => c.drivingFallback).length;

  let bottom = `**Bottom Line:** ${comps.length} verified new-construction closing${comps.length === 1 ? '' : 's'} averaging **$${avgPrice.toLocaleString()}**`;
  if (avgPpsf) bottom += ` (avg **$${avgPpsf.toLocaleString()}/sqft**)`;
  bottom += `, ranging $${minP.toLocaleString()}–$${maxP.toLocaleString()}. A comparable new build around this site supports roughly that pricing window for ARV purposes.`;
  if (radiusExpanded) bottom += ` Note: fewer than 3 comps closed within 3 driving miles, so the radius was expanded to 5 miles.`;
  if (fallbackCount > 0) bottom += ` ${fallbackCount} comp${fallbackCount === 1 ? '' : 's'} used straight-line distance because Google driving data was unavailable.`;
  bottom += ` Confirm closed prices against the listed sources before contracting.`;
  lines.push(bottom);
  return lines.join('\n');
}

/** Persists the comp run + listings to Supabase (best-effort; never blocks the UI). */
async function persistCompRun(run: {
  targetAddress: string;
  targetLat: number;
  targetLng: number;
  locations: string[];
  skippedZips: string[];
  radiusExpanded: boolean;
  comps: CompProperty[];
  summary: string;
}): Promise<void> {
  try {
    if (!isSupabaseConfigured()) return;
    const mirror = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    const userId = mirror ? JSON.parse(mirror).userId : null;
    if (!userId) return;
    const supabase = getSupabase();
    const ppsfVals = run.comps.filter((c) => c.pricePerSqft).map((c) => c.pricePerSqft as number);
    const { data, error } = await supabase
      .from('comp_runs')
      .insert({
        user_id: userId,
        target_address: run.targetAddress,
        target_lat: run.targetLat,
        target_lng: run.targetLng,
        zips_searched: run.locations.join(','),
        zips_skipped: run.skippedZips.join(','),
        radius_miles: 5,
        radius_expanded: run.radiusExpanded,
        comp_count: run.comps.length,
        avg_sold_price: run.comps.length ? Math.round(run.comps.reduce((s, c) => s + c.price, 0) / run.comps.length) : null,
        avg_price_per_sqft: ppsfVals.length ? Math.round(ppsfVals.reduce((s, v) => s + v, 0) / ppsfVals.length) : null,
        summary_md: run.summary,
      })
      .select('id')
      .single();
    if (error) throw error;
    if (run.comps.length > 0) {
      const rows = run.comps.map((c) => ({
        run_id: data.id,
        user_id: userId,
        address: c.address,
        zip: c.zip ?? null,
        driving_miles: c.distanceMiles,
        straight_line_miles: c.straightLineMiles ?? null,
        driving_distance_fallback: !!c.drivingFallback,
        sold_price: c.price,
        sold_date: c.saleDate,
        living_area_sqft: c.sqft ?? null,
        price_per_sqft: c.pricePerSqft ?? null,
        lat: c.coords?.lat ?? null,
        lng: c.coords?.lng ?? null,
        url: c.url ?? null,
        verified_note: c.verifiedNote ?? null,
        price_discrepancy: c.priceDiscrepancy ?? null,
        sources: 'RealtyAPI (Realtor/Redfin/Zillow) + Public MLS (Google Search)',
      }));
      const { error: e2 } = await supabase.from('comp_listings').insert(rows);
      if (e2) throw e2;
    }
    console.log('Comp run persisted to Supabase.');
  } catch (e) {
    console.warn('Comp-run persistence skipped/failed (run the comp_runs SQL in SETUP_SUPABASE.md):', e);
  }
}

export interface CompRunResult {
  comps: CompProperty[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Zillow price verification. The coordinate search returns a sold price, but to
// GUARANTEE it is the true closing price we cross-check each Zillow comp against
// its MLS price history (/pricehistory) and use the "Sold" event matching the
// comp's sale date. Confirmed prices get a badge; mismatches are corrected to
// the MLS figure and flagged. Cached per zpid (7-day TTL) so repeats are free.
// ---------------------------------------------------------------------------
const ZPH_CACHE_PREFIX = "gisfs:zph:v1:";
const ZPH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ZILLOW_VERIFY = 40;   // closest-N Zillow comps to MLS-verify per run (cost/latency guard)
const ZVERIFY_BATCH = 8;        // concurrent price-history lookups

/** A zpid's SOLD price-history events ({date,price}) from Zillow MLS data, cached. */
async function fetchZillowSoldEvents(zpid: string, key: string): Promise<{ date: string; price: number }[] | null> {
  const ck = ZPH_CACHE_PREFIX + zpid;
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && Array.isArray(v.e) && Date.now() - (v.t || 0) < ZPH_CACHE_TTL_MS) return v.e;
    }
  } catch { /* ignore */ }
  try {
    const res = await fetchWithTimeout(`${REALTY_API_HOSTS.zillow}/pricehistory?byzpid=${encodeURIComponent(zpid)}`, 15000, { headers: { "x-realtyapi-key": key } });
    if (!res.ok) return null;
    const data = await res.json();
    const hist: any[] = Array.isArray(data?.priceHistory) ? data.priceHistory
      : (Array.isArray(data?.priceHistory?.events) ? data.priceHistory.events : []);
    const events = hist
      .filter((h) => /sold/i.test(String(h?.event)))
      .map((h) => ({ date: String(h?.date || "").slice(0, 10), price: rNum(h?.price) ?? 0 }))
      .filter((e) => e.price > 0);
    try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), e: events })); } catch { /* ignore */ }
    return events;
  } catch {
    return null;
  }
}

/** The SOLD event whose date is closest to the comp's sale date (handles homes with multiple sales). */
function pickSoldEvent(events: { date: string; price: number }[], compSaleDate: string): { date: string; price: number } | null {
  if (!events.length) return null;
  const target = new Date(compSaleDate).getTime();
  if (!Number.isFinite(target)) return events[0];
  let best = events[0], bestDiff = Infinity;
  for (const e of events) {
    const t = new Date(e.date).getTime();
    const diff = Number.isFinite(t) ? Math.abs(t - target) : Infinity;
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

/**
 * Verifies the closest Zillow comps' prices against Zillow's MLS price history,
 * correcting any mismatch to the MLS closing price and tagging each confirmed.
 * Mutates `comps` in place (sets priceConfirmed, and priceDiscrepancy on a fix).
 */
async function verifyZillowCompPrices(
  comps: any[],
  key: string,
  onStageChange?: (stage: string) => void,
): Promise<void> {
  if (!key) return;
  const targets = comps
    .filter((c) => /zillow/i.test(String(c.sourceName)) && c.propertyId)
    .slice(0, MAX_ZILLOW_VERIFY);
  if (targets.length === 0) return;
  onStageChange?.(`Verifying ${targets.length} Zillow comp prices against MLS price history...`);
  for (let i = 0; i < targets.length; i += ZVERIFY_BATCH) {
    await Promise.all(targets.slice(i, i + ZVERIFY_BATCH).map(async (c) => {
      const events = await fetchZillowSoldEvents(String(c.propertyId), key);
      if (!events) return; // could not verify — keep the (MLS-sourced) search price
      const ev = pickSoldEvent(events, c.saleDate);
      if (!ev || !(ev.price > 0)) return;
      const before = c.price;
      if (Math.abs(ev.price - before) > Math.max(500, before * 0.005)) {
        c.priceDiscrepancy = `Search $${before.toLocaleString()} → MLS-confirmed $${ev.price.toLocaleString()}`;
        c.price = ev.price;               // trust the MLS price-history closing figure
        if (ev.date) c.saleDate = ev.date;
      }
      c.priceConfirmed = true;
    }));
  }
}

export async function fetchGoogleDistanceMatrixComps(
  lat: number,
  lng: number,
  _parcelId: string,
  zoningCode: string,
  zoningDesc: string,
  addressString: string,
  _countyName: string,
  onStageChange?: (stage: string) => void
): Promise<CompRunResult> {
  onStageChange?.("Searching sold listings...");

  // FIXED comp criteria: NEW CONSTRUCTION (built 2025–2026) matching the
  // subject's ZONING use category, SOLD within the last 12 months, within 3
  // DRIVING miles of the subject (expanded to 5 when fewer than 3 qualify).
  // NO minimum distance — same-subdivision sales next door are the BEST comps.
  // NO minimum or maximum square footage.
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const MIN_YEAR_BUILT = 2025;
  const MAX_YEAR_BUILT = 2026;
  const EXPANDED_RADIUS_MILES = 5; // show comps out to the FULL 5 driving miles (no lazy 3-mile cap)
  const MIN_DIST_MILES = 0;

  // Permitted use category (drives the Realtor search property type).
  const category = getPermittedCategory(zoningCode, zoningDesc);

  // Same address searched again? Return the EXACT same verified comp set.
  const cacheKey = compsCacheKey(lat, lng, category);
  const cached = readCompsCache(cacheKey);
  if (cached && cached.comps.length > 0) {
    console.log(`Returning ${cached.comps.length} cached comps for this parcel (deterministic re-run).`);
    return cached;
  }

  // Straight-line (haversine-approx) miles from the subject to a candidate.
  const straightMiles = (c: { coords: { lat: number; lng: number } }) => {
    const dLng = c.coords.lng - lng;
    const dLat = c.coords.lat - lat;
    const R = 3958.8;
    return Math.sqrt(
      Math.pow((dLat * Math.PI) / 180 * R, 2) +
      Math.pow((dLng * Math.PI) / 180 * R * Math.cos((lat * Math.PI) / 180), 2)
    );
  };

  const isNewConstruction = (yb: any) => {
    const y = Number(yb);
    return Number.isFinite(y) && y >= MIN_YEAR_BUILT && y <= MAX_YEAR_BUILT;
  };
  const soldWithinYear = (sd?: string) => {
    if (!sd) return false;
    const d = new Date(sd);
    return !isNaN(d.getTime()) && d >= oneYearAgo && d.getTime() <= today.getTime() + 86400000;
  };

  // Subject's city / ZIP / state from the input address.
  const addressParts = addressString.split(',');
  const city = addressParts[1] ? addressParts[1].trim() : 'Charlotte';
  const zipMatch = addressString.match(/\b\d{5}\b/);
  const zip = zipMatch ? zipMatch[0] : '';
  const stateMatch = addressString.match(/\b([A-Z]{2})\b/);
  const stateCode = stateMatch ? stateMatch[1] : 'NC';

  // ZIP health: skip ZIPs that have come back empty on 2+ consecutive runs.
  const zipHealth = readZipHealth();
  const skippedZips: string[] = [];
  const locations: string[] = [];
  if (zip) {
    if (zipHealth[zip]?.dead) skippedZips.push(zip);
    else locations.push(zip);
  }
  if (city) locations.push(`${city}, ${stateCode}`);
  if (locations.length === 0) locations.push(`${city}, ${stateCode}`);

  // STEP 4 — BOTH engines run in PARALLEL and merge to catch every comp:
  // (a) RealtyAPI sold records (Realtor + Redfin + Zillow) — one coordinate
  //     radius search per platform, server-filtered to Sold + new construction
  //     (year built >= 2025) within the 12-month window; and
  // (b) [disabled] the former Gemini/Google public-MLS search.
  //
  // RealtyAPI (Realtor + Redfin + Zillow) is now the SOLE comp source — it returns
  // authoritative CLOSED-sale records with reliable price, status, and property
  // type. The Gemini/Google search was LLM-extracted and could surface
  // under-contract listings or inaccurate prices, so it is disabled to keep every
  // comp a verified closed sale. Flip ENABLE_GOOGLE_MLS_COMPS to bring it back.
  const ENABLE_GOOGLE_MLS_COMPS = false;
  const realtyComps = await fetchRealtyApiSoldComps(lat, lng, category, oneYearAgo, onStageChange).catch((e) => {
    console.warn("RealtyAPI sold comp search failed:", e);
    return [] as any[];
  });
  const googleComps: any[] = ENABLE_GOOGLE_MLS_COMPS
    ? await fetchGoogleMlsComps(addressString, city, stateCode, zip, category, oneYearAgo.toISOString().split('T')[0], onStageChange).catch((e) => {
        console.warn("Public-MLS Google comp search failed:", e);
        return [] as any[];
      })
    : [];

  // Merge — Realtor records win duplicates (coordinates + confirmed data).
  const mergedByKey = new Map<string, any>();
  for (const g of googleComps) {
    const k = normalizeStreetKey(g.address);
    if (k) mergedByKey.set(k, g);
  }
  for (const r of realtyComps) {
    const k = normalizeStreetKey(r.address);
    if (k) mergedByKey.set(k, { ...mergedByKey.get(k), ...r });
  }
  const compAddresses = Array.from(mergedByKey.values());
  console.log(`Sources merged: ${realtyComps.length} RealtyAPI records + ${googleComps.length} Google → ${compAddresses.length} unique candidates.`);

  // STEP 5 — filter to spec (no distance yet): sold, built 2025/26 (zoning
  // use-category already applied per source), sold ≤12 months, price > 0.
  // NO sqft limits. Cap at 100.
  let candidates = compAddresses.filter((c: any) =>
    String(c.status || 'sold').toLowerCase().includes('sold') &&
    // New construction: year built 2025–2026, or Realtor's official
    // new-construction flag when the record doesn't expose a year.
    (isNewConstruction(c.yearBuilt) || (c.newConstructionFlag === true && c.yearBuilt == null)) &&
    soldWithinYear(c.saleDate) &&
    (c.price || 0) > 0
  );
  if (zip && !skippedZips.includes(zip)) {
    updateZipHealth(zip, candidates.some((c: any) => c.zip === zip));
  }
  // Order by PROXIMITY (closest first) so the full 5-mile set is built from the
  // inside out — never lazily truncated to just the nearest few. Candidates
  // without coordinates sort last (geocoded below). Keep a generous closest-N.
  candidates.sort((a: any, b: any) => {
    const da = a.coords ? straightMiles(a) : Infinity;
    const db = b.coords ? straightMiles(b) : Infinity;
    if (da !== db) return da - db;
    return new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime();
  });
  candidates = candidates.slice(0, 150);
  console.log(`Collected ${candidates.length} spec-qualifying sold-comp candidates (closest-first).`);

  onStageChange?.("Calculating driving distances (Google Distance Matrix)...");

  // STEP 6a — coordinates (Realtor items carry them; geocode the rare misses).
  const googleApiKey = getUserKeys().googleMaps || "";
  const resolved = await Promise.all(
    candidates.map(async (comp: any) => {
      if (comp.coords && typeof comp.coords.lat === 'number' && typeof comp.coords.lng === 'number') return comp;
      if (!googleApiKey) return null;
      const verifiedCoords = await geocodeAddress(comp.address, googleApiKey);
      if (verifiedCoords) return { ...comp, coords: verifiedCoords };
      console.log(`Skipping comp "${comp.address}" — could not geocode.`);
      return null;
    })
  );
  // Cheap straight-line pre-prune (anything > ~6.5 mi can't be within 5 driving miles).
  const finalCands: any[] = resolved.filter((c): c is any => c !== null && straightMiles(c) <= 5.5);

  // STEP 6b — driving distance via Google Distance Matrix, with per-pair cache.
  const dests = finalCands.map((c) => ({ lat: c.coords.lat, lng: c.coords.lng }));
  const dmResults: ({ distanceMiles: number; durationMins: number } | null)[] =
    dests.map((d) => readDmCache(dmCacheKey(lat, lng, d.lat, d.lng)));
  const missIdx = dmResults.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (missIdx.length > 0) {
    const missDests = missIdx.map((i) => dests[i]);
    let fetched: ({ distanceMiles: number; durationMins: number } | null)[] | null = null;
    try {
      fetched = await fetchDrivingDistancesViaSDK(lat, lng, missDests);
    } catch (e) {
      console.warn("Distance Matrix SDK failed:", e);
    }
    if (!fetched) fetched = await fetchDrivingDistancesViaREST(lat, lng, missDests, googleApiKey);
    missIdx.forEach((orig, j) => {
      const r = fetched ? fetched[j] : null;
      if (r) {
        dmResults[orig] = r;
        writeDmCache(dmCacheKey(lat, lng, dests[orig].lat, dests[orig].lng), r); // successes only
      }
    });
  }

  const compsAll = finalCands.map((c, idx) => {
    const r = dmResults[idx];
    const sl = Math.round(straightMiles(c) * 100) / 100;
    return {
      address: c.address,
      price: c.price,
      saleDate: c.saleDate,
      yearBuilt: c.yearBuilt,
      propertyType: c.propertyType,
      coords: c.coords,
      sqft: c.sqft,
      url: c.url,
      zip: c.zip,
      propertyId: c.propertyId,
      sourceName: c.sourceName,
      newConstructionFlag: c.newConstructionFlag,
      detailConfirmed: c.detailConfirmed,
      distanceMiles: r ? Math.round(r.distanceMiles * 100) / 100 : sl,
      durationMins: r ? Math.round(r.durationMins * 10) / 10 : Math.round(sl * 2.5 * 10) / 10,
      straightLineMiles: sl,
      drivingFallback: !r, // straight-line fallback; flagged in summary, never cached
    };
  });

  // STEP 6c — include EVERY qualifying comp from the closest out to the FULL 5
  // driving miles (no lazy 3-mile cap), ordered nearest-first.
  const chosen = compsAll
    .filter((c) => c.distanceMiles >= MIN_DIST_MILES && c.distanceMiles <= EXPANDED_RADIUS_MILES)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
  const radiusExpanded = false;

  // Cross-check the closest Zillow comps against Zillow's MLS price history and
  // correct/confirm their sold prices before they're shown or used.
  await verifyZillowCompPrices(chosen, getRealtyApiKey(), onStageChange);

  // STEP 7 — source attribution. Realtor records confirmed on their detail
  // record get a verified badge; Google-sourced comps carry a confirm note.
  const verified = chosen.map((c: any) => ({
    ...c,
    verified: !!c.detailConfirmed,
    verifiedNote: c.priceConfirmed
      ? `✓ ${c.sourceName || 'RealtyAPI'} — sold price MLS-confirmed${c.yearBuilt ? ` · built ${c.yearBuilt}` : ''}`
      : c.detailConfirmed
        ? `✓ ${c.sourceName || 'RealtyAPI'} closed-sale record${c.yearBuilt ? ` (built ${c.yearBuilt})` : ''}`
        : `Source: ${c.sourceName || 'RealtyAPI'} — confirm closed price before contracting`,
  }));

  // Final shape: $/sqft, nearest-first ordering, internal fields stripped.
  const result: CompProperty[] = verified
    .map((c: any) => ({ ...c, pricePerSqft: c.sqft ? Math.round(c.price / c.sqft) : undefined }))
    .sort((a: any, b: any) => a.distanceMiles - b.distanceMiles)
    .map((c: any) => {
      const { propertyId, propertyHistory, status, sourceName, newConstructionFlag, detailConfirmed, priceConfirmed, ...rest } = c;
      return rest as CompProperty;
    });

  const summary = buildCompRunSummary({
    subjectAddress: addressString,
    comps: result,
    radiusExpanded,
    skippedZips,
    locations,
    candidateCount: candidates.length,
    scrapedCount: compAddresses.length,
    inRadiusCount: chosen.length,
  });

  // Persist the run + listings to Supabase (best-effort, non-blocking).
  void persistCompRun({
    targetAddress: addressString,
    targetLat: lat,
    targetLng: lng,
    locations,
    skippedZips,
    radiusExpanded,
    comps: result,
    summary,
  });

  console.log(`Returning ${result.length} verified new-construction comps.`);
  if (result.length > 0) writeCompsCache(cacheKey, result, summary);
  return { comps: result, summary };
}

export interface ChatSource {
  title: string;
  uri: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  sources?: ChatSource[];
}

// ---------------------------------------------------------------------------
// Fusion engine (mixture-of-agents): Gemini 3.5 Flash and DeepSeek V4 Pro
// answer the SAME prompt in PARALLEL, then Gemini 3.5 Flash acts as JUDGE and
// STREAMS the synthesized final answer. Falls back to single-model Gemini
// streaming when no DeepSeek key is configured or DeepSeek is unavailable.
// ---------------------------------------------------------------------------

/** Non-streaming Gemini call — used for the parallel draft. Returns text only. */
async function geminiGenerateText(url: string, body: any): Promise<string> {
  const res = await fetchWithTimeout(url, 90000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
}

/** Streams a Gemini SSE response, invoking onToken per chunk; returns full text + sources. */
async function streamGeminiSSE(url: string, body: any, onToken?: (chunk: string) => void): Promise<{ text: string; sources?: ChatSource[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = res.ok ? 'no response body' : `${res.status} - ${await res.text()}`;
    throw new Error(`Gemini API error: ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const seen = new Set<string>();
  const sources: ChatSource[] = [];
  const handle = (obj: any) => {
    const t = obj?.candidates?.[0]?.content?.parts?.map((x: any) => x.text || '').join('') || '';
    if (t) { text += t; onToken?.(t); }
    const chunks = obj?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        const uri = c?.web?.uri;
        if (uri && !seen.has(uri)) { seen.add(uri); sources.push({ title: c.web.title || uri, uri }); }
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { handle(JSON.parse(payload)); } catch { /* JSON split across chunks — ignore */ }
    }
  }
  return { text: text || 'No response generated.', sources: sources.length ? sources : undefined };
}

/** DeepSeek V4 Pro draft (OpenAI-compatible), with ONE retry on transient errors so
 *  a flaky request doesn't silently drop DeepSeek from the fusion. Returns null on
 *  missing key / repeated failure / timeout (the fusion then proceeds Gemini-only). */
async function fetchDeepSeekDraft(systemContent: string, userContent: string, key: string): Promise<string | null> {
  if (!key) return null;
  const body = JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    thinking: { type: 'disabled' }, // fast draft; the Gemini judge supplies the synthesis/reasoning
    stream: false,
    temperature: 0.4,
    max_tokens: 8000,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', 90000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || null;
      }
      // Retry transient rate-limit / server errors once; give up on client errors (bad key, etc.).
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        console.warn(`DeepSeek HTTP ${res.status} — retrying once...`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      console.warn(`DeepSeek HTTP ${res.status} — fusion will use Gemini only.`);
      return null;
    } catch (e) {
      // Network error / timeout — retry once, then fall back gracefully.
      if (attempt === 0) { console.warn('DeepSeek request error — retrying once:', e); await new Promise((r) => setTimeout(r, 1000)); continue; }
      console.warn('DeepSeek request failed — fusion will use Gemini only:', e);
      return null;
    }
  }
  return null;
}

export async function chatWithGemini(
  messages: ChatMessage[],
  reportData: SiteFeasibilityData,
  onToken?: (chunk: string) => void
): Promise<{ text: string; sources?: ChatSource[] }> {

  const apiKey = getUserKeys().gemini || "";
  if (!apiKey) {
    throw new Error("Gemini API key is required. Please configure it in Account Settings.");
  }

  const systemPrompt = `
# AI Land Feasibility Report — Operating Standards

You operate as a senior land acquisition analyst, entitlement consultant, and residential development advisor. Your role is to investigate, verify, and deliver conclusions — not to behave like a conversational chatbot.

## Operating Principles
1. ACT, DON'T OVERPLAN. When sufficient information exists, perform the analysis now. Do not re-derive settled facts, repeat established conclusions, list options without a recommendation, or narrate your reasoning. Give the conclusion and move on.
2. LEAD WITH THE OUTCOME. Every major section must OPEN with the answer/finding (e.g. "The parcel appears suitable for a single-family residence.") and then give the supporting evidence.
3. GROUND EVERY CLAIM IN EVIDENCE. Only report findings supported by data gathered in the investigation. For each conclusion cite the source, explain the evidence, and label it:
   - **Verified** — supported by official records, GIS data, surveys, APIs, or market data.
   - **Likely** — strongly supported but not officially confirmed.
   - **Unknown** — insufficient evidence available.
   Never present assumptions as facts.
4. ASSESS BEFORE RECOMMENDING. Determine what is true, likely, and uncertain before recommending purchase, sale, development, or rezoning.
5. MATCH DEPTH TO RISK. Go deep on zoning, highest & best use, buildability, flood risk, environmental constraints, market valuation, and development economics. Be concise on basic demographics and routine, easily-verified facts.
6. FOCUS ON DEVELOPMENT FEASIBILITY. Every analysis must serve: Can it be built on? What can legally be built? What physical constraints exist? What approvals are required? What will development cost? What is the finished product worth? Is there sufficient margin? Minimize anything that does not.
7. USE THE REASON, NOT JUST THE REQUEST. Tie analysis to the development objective — why the property has value, what a builder cares about, what drives profit, what raises risk. If critical info is missing, identify it and explain its impact.
8. VERIFY BEFORE FINALIZING. Confirm address, parcel, jurisdiction, zoning, flood data, topography, utilities, comp criteria, and internal calculation consistency. List unresolved items separately.
9. DECIDE WHEN EVIDENCE SUPPORTS IT. Avoid excessive hedging and endless "possibilities." Instead of "may potentially be suitable depending on various factors," write "Available evidence supports development of one single-family residence, subject to septic approval."
10. DELIVER EXECUTIVE-LEVEL CONCLUSIONS. Write for land investors, builders, developers, private lenders, and acquisition managers — direct, evidence-based, financially focused.

## Evidence & Data Sources
- Treat the PROVIDED DATA PACKET (parcel/GIS, USGS 3DEP slope, FEMA flood zone, NWI wetlands, county zoning, verified SOLD comps, ownership/tax) as Verified evidence.
- For topics NOT in the packet — utilities, road access & frontage, schools, market trends, and comparable vacant-land sales — INVESTIGATE with live Google Search and cite the source; if still unconfirmed, label Likely or Unknown.
- FLOOD & WETLANDS: the packet carries the AUTHORITATIVE FEMA NFHL flood zone and USFWS NWI wetlands result, queried by the parcel's exact coordinate. USE those values verbatim and CITE the provided source links — do NOT guess or contradict them. Only when the packet marks flood or wetlands "unavailable"/"no-coverage" should you say so and direct verification to the FEMA/NWI source link, labeling the status Unknown rather than assuming the site is flood-free or wetland-free.
- HOA: determine whether the parcel is within a homeowners association; if so report the HOA name, dues, management company, any preferred/featured/approved BUILDER list, and the building requirements, architectural guidelines, and restrictions/covenants (CCRs) — only where publicly available, otherwise label Unknown.
- ZONING: VERIFY the county-provided zoning code is correct for this exact parcel against the official county/municipal zoning map or ordinance; if the official source disagrees or you cannot confirm it, say so and label Likely/Unknown rather than asserting it.
- CONSTRUCTION COST: be EXTREMELY ACCURATE and use CURRENT LOCAL costs for THIS address's metro/county found via Google Search across MULTIPLE sources near the address (not one source, never generic national averages), and ANCHOR to the itemized Construction Cost Reference Model below. Research and cite local figures for: per-sqft new single-family build cost; land/lot CLEARING and TREE removal ($/acre — heavier canopy costs more); GRADING/earthwork (more on sloped sites); foundation (crawlspace/slab/basement); WELL drilling ($/ft and typical total) and SEPTIC system install + perc test when no public water/sewer; public water/sewer TAP & impact fees when available; building permits and survey.
- Buildability from USGS 3DEP (1m) slope: under 15% = Buildable; 15-25% = Requires Special Engineering / increased cost; over 25% = Non-Buildable / high risk.

## Comparable Sales — use ONLY the verified comps provided
- The verified SOLD comps are supplied in the data packet. Use ONLY those exact homes. Never invent comps, never substitute older homes, never use vacant-land/raw-lot/active/pending listings, and never cite list prices or Zestimates.
- Criteria already applied to that set: closed within the last 12 months; new construction (built the current or previous year); single-family matching the subject's zoning use; within 1-5 driving miles (never beyond 5 unless too few sales exist); closest first.
- For EACH comp present: address, sale price, sale date, year built, living-area sqft, lot size (or "Unknown"), distance from subject, price/sqft, and one line on why it qualifies.
- If the provided comp list is EMPTY, say so plainly and base valuation on vacant-land sales (Google Search) plus the assessor reference; do not fabricate comps.

## Construction Cost Reference Model (itemized hard-cost baseline — localize every line)
Use this REAL, itemized new-construction budget as the BASELINE cost schedule for a ~1,600 sqft 3-bed/2-bath single-family home on a crawlspace foundation (total ≈ $250,000, ≈ $156/sqft, INCLUDING a $25,000 builder fee and a $3,500 contingency). Treat it as the STRUCTURE of the estimate, then ADJUST EACH LINE to CURRENT LOCAL prices for THIS address's market (Google Search, multiple sources) and SCALE to the planned home's size / the comps' typical sqft:
Clear/Grading $10,500 · Dumpster $3,650 · Survey/Plot plan $1,500 · Zoning & Building permits $14,500 · Tap Fees (water & septic) $12,500 · Crawlspace foundation $35,600 · Framing Package $20,500 · Framing Labor $10,800 · Roof Trusses & Floor Beams $7,400 · Windows $6,200 · Exterior Doors $2,800 · Siding (material+labor) $8,500 · Roof (labor+materials) $9,400 · Plumbing $12,500 · HVAC $7,400 · Electrical $7,450 · Fixtures $1,300 · Appliances $2,200 · Insulation $1,900 · Painting $3,100 · Sheetrock (labor+materials) $7,200 · Trim (labor+materials) $1,500 · Gutters $1,600 · Cabinets $4,200 · Countertops $8,700 · Cleaning $150 · Landscaping $1,250 · Floors $8,400 · Driveway & patio $8,800 · Contingency $3,500 · Builder Fee $25,000 → Total $250,000.
Present Section 20 (Development Cost Considerations) as an itemized TABLE mirroring this schedule with a LOCALIZED column (current local price + cited source) and a scaled TOTAL hard cost plus the resulting $/sqft. Always keep a builder fee and a 5–10% contingency.

## Developer Economics Standard (Sections 22 Land Valuation & 23 Builder/Developer Profitability)
Compute what a builder/developer would realistically PAY FOR THE LAND using a RESIDUAL LAND-VALUE pro-forma, and cross-check it against the lot-cost rule of thumb. Show every input and a pro-forma TABLE.
1. ARV (finished value): from the verified SOLD new-construction comps — median sale price and median $/sqft × the planned home's GLA (assume a typical new build matching the comps, e.g. ~1,600 sqft; state the assumption).
2. Total hard construction cost: from the localized Construction Cost Reference Model above, scaled to the planned GLA.
3. SITE-SPECIFIC cost ADDERS — research LOCAL prices near the address and ADD any that apply (these are exactly what REDUCES the land's value to a builder):
   - TREES / LOT CLEARING: if the parcel is wooded (USGS/imagery/Google), add land-clearing + tree-removal cost (local $/acre; heavier canopy = more). Deduct from land value.
   - STEEP SLOPE: if USGS 3DEP slope ≥15%, add extra grading/retaining/engineering cost (≥25% may be non-buildable). Deduct from land value.
   - WELL & SEPTIC: if no public water/sewer, add well drilling (local $/ft + total) and a septic system install + perc test (local cost). If public water/sewer exists, use tap/impact fees instead.
4. Soft & selling costs: permits/survey (already in the schedule) plus sales commission (~5–6% of ARV), closing, and construction-loan interest/carry as applicable.
5. DEVELOPER PROFIT — show THREE scenarios side by side: a little LESS than 20% of ARV (use 15%), EXACTLY 20% of ARV, and MORE than 20% of ARV (use 25%). State each profit dollar figure explicitly.
6. RESIDUAL LAND VALUE (what a builder would pay) = ARV − total hard construction − site-specific adders − soft/selling/financing − developer profit. Compute it for ALL THREE profit scenarios, yielding THREE land values in a single pro-forma TABLE with a column per scenario (15% / 20% / 25% profit). Note that a LOWER profit margin lets the builder pay MORE for the land, and a higher margin less.
7. CROSS-CHECK with the rule of thumb: builders typically pay ≈ 20% of ARV for a FINISHED lot. Start from 20% of ARV, then DEDUCT the site-specific adders (trees, slope, well/septic) to get an adjusted raw-land offer; reconcile this with the three residual figures and present a defensible RANGE (low/expected/high) that brackets them.
This residual land value is standard development feasibility ("what a builder would pay") — it is NOT a wholesale "maximum allowable offer"; do not use wholesaling/assignment terminology. Be EXTREMELY ACCURATE: every figure must trace to a cited current LOCAL source.

## Value-Add Opportunities Standard (Rezoning & Subdivision)
Actively assess whether a developer can unlock MORE value from the land than its current as-zoned use — this is often where the real upside is. Be specific and honest, never speculative:
- REZONING / UPZONING: compare the current zoning district to the FUTURE LAND USE / comprehensive-plan designation and to the zoning of ADJACENT parcels. Identify the highest-value district realistically attainable (e.g. single-family → townhome/attached, multifamily, or mixed-use), the units/density it unlocks, whether the comp plan and surrounding pattern SUPPORT approval, the jurisdiction's recent rezoning approval trend, the process/timeline/cost, the entitlement RISK, and the VALUE DELTA (as-zoned value vs. rezoned value, per door/unit or per buildable lot). If a rezoning is not supportable, say so plainly and do NOT invent upside.
- SUBDIVISION / LOT SPLIT: from the district's minimum lot size, frontage, and density plus the parcel's acreage/frontage/utilities, determine how many conforming buildable lots are realistic, the minor vs. major subdivision process, the likely infrastructure cost (road, utility extensions, stormwater), and the VALUE UPLIFT (sum of finished-lot values vs. whole-parcel value, net of cost). If it can't be split, say so and why.
Research current district standards, the comp plan/future-land-use map, and recent local rezoning cases via Google Search and cite sources. Carry any supportable upside into Highest-and-Best-Use and Land Valuation.

## Market Saturation, Absorption & Rate-Environment Standard
- SATURATION & ABSORPTION: be PRECISE and data-driven by PRODUCT TYPE — single-family detached, townhomes/attached, condos, and multifamily/rentals. For the area/ZIP, report current ACTIVE inventory, median DAYS ON MARKET (DOM), and MONTHS OF SUPPLY in a table (cite sources). Flag which product types are OVERSUPPLIED / sitting too long (slow absorption, buyer's market) vs. absorbing fast (low supply, seller's market), and recommend which product to BUILD and which to avoid here, with the numbers behind it. Never guess inventory/DOM without a cited source — mark Unknown if unavailable.
- INTEREST RATES: report the CURRENT 30-year mortgage rate and its recent trend — RISING / FALLING / STEADY — plus the Fed's posture (cite a current source). Explain in detail how that affects buyer demand, affordability, absorption pace, and exit timing, and give a brief SENSITIVITY read (what a rate move up vs. down does to demand and to the hold/sell decision).

## Land Valuation Standard
Derive land value from comparable vacant-land sales, builder lot demand, new-construction economics, market absorption, and highest-and-best-use — NOT solely county tax values or automated estimates. Reconcile it with the Developer Economics residual land value above, and reflect any supportable REZONING/SUBDIVISION upside and the current saturation/rate environment. Show the inputs and reasoning.

## Final Recommendation Standard
End with a clear recommendation stating: whether the property appears buildable, the most likely development strategy, the primary risks, the strongest value drivers, and an overall Feasibility Rating — **Excellent / Good / Moderate / Challenging / Poor**.

## Output Rules
- Produce the COMPLETE report in one response, following the required section structure given in the request. Do not stop to ask the user to confirm strategy or preferences.
- Lead each section with its conclusion. Use clean markdown: numbered section headers, bold key findings, tables for comps/calculations, concise bullets. No JSON, code blocks, map-layer/asset payloads, or "assistant mode" announcements.
- NO CODE OR RAW DATA: never use code blocks, backticks/inline code, JSON, variable-style text, or pseudo-code anywhere — not even for formulas. Write every formula and calculation in PLAIN ENGLISH or a clean markdown table showing the inputs and the result (e.g. "ARV of $400,000 minus construction of $250,000 minus a 20% profit of $80,000 leaves a land value of $70,000"). For multiplication use the word "times" or the × symbol and for division use ÷ — NEVER the asterisk (*) or slash for math. Do not use asterisks for emphasis; rely on the heading/table/bold formatting only.
- When linking a comp or address, use its provided verified listing URL if available; otherwise a Google Search URL (https://www.google.com/search?q=ADDRESS). NEVER fabricate a Realtor.com / Zillow / Redfin detail URL.
- Every dollar figure must trace to a shown input. Do not invent owner names, prices, dates, slopes, or zoning. This is a FEASIBILITY analysis — never include wholesaling, assignment-fee, "maximum allowable offer," or exit-strategy content.
- Do not finish until all required sections are completed or explicitly marked "Unknown — unverifiable due to lack of available evidence."

## Follow-up
After the report, answer follow-up questions conversationally from the stored context; use Google Search for niche municipal-code questions. Do not regenerate the full report unless asked.
`;

  // Authoritative flood (FEMA NFHL) & wetlands (USFWS NWI) lines for the packet.
  const fz = reportData.floodZone;
  const floodLine = !fz || fz.status === 'unavailable'
    ? 'FEMA NFHL did not return data at search time — VERIFY at the FEMA source before relying on flood status; do NOT assume the parcel is flood-free.'
    : fz.status === 'no-coverage'
      ? `No FEMA flood zone is mapped at this coordinate (unmapped or outside detailed study) — VERIFY via FEMA. Source: ${fz.sourceUrl}`
      : `Zone ${fz.zone}${fz.subtype ? ` (${fz.subtype})` : ''} — ${fz.inSFHA ? 'IN a Special Flood Hazard Area (high-risk 1% annual-chance floodplain; flood insurance typically required)' : 'NOT in a Special Flood Hazard Area (outside the 1% annual-chance floodplain)'}. Authoritative source (FEMA NFHL, queried by coordinate): ${fz.sourceUrl}`;
  const wl = reportData.wetlands;
  const wetlandsLine = !wl || wl.status === 'unavailable'
    ? 'USFWS NWI service was unavailable at search time — VERIFY at the NWI Wetlands Mapper before concluding; do NOT assume the parcel is wetland-free.'
    : wl.status === 'none-at-point'
      ? `No NWI-mapped wetlands intersect the parcel coordinate (NWI omits some small/forested wetlands; a field delineation is the legal authority). Source: ${wl.sourceUrl}`
      : `NWI-mapped wetlands present at/near the parcel: ${wl.types.join(', ') || 'classification unspecified'}. A jurisdictional delineation is required to confirm extent. Source: ${wl.sourceUrl}`;

  // Live 30-year mortgage rate anchor for the Interest Rate & Financing section.
  const mortgage = await fetchCurrentMortgageRate().catch(() => null);
  const mortgageLine = mortgage
    ? `30-Year Fixed Mortgage Rate: ${mortgage.rate.toFixed(2)}% as of ${mortgage.date} (Freddie Mac PMMS via FRED, series MORTGAGE30US). USE this as the live anchor for Section 18; confirm the recent rising/falling/steady TREND and the Fed posture via Google Search.`
    : `Live mortgage-rate feed unavailable at search time — research the CURRENT 30-year fixed mortgage rate and its trend via Google Search for Section 18, and cite the source.`;

  // Live COUNTY housing-market anchor (all residential, Realtor.com via FRED) for
  // the Market Saturation & Absorption section.
  const mkt = await fetchCountyMarketStats(reportData.countyName).catch(() => null);
  const trendOf = (m?: { value: number; prev3?: number | null; prevYear?: number | null } | null) => {
    if (!m || m.prev3 == null) return '';
    const dir = m.value > m.prev3 ? 'up' : m.value < m.prev3 ? 'down' : 'flat';
    const yoy = m.prevYear != null && m.prevYear !== 0 ? `, ${(((m.value - m.prevYear) / m.prevYear) * 100).toFixed(0)}% YoY` : '';
    return ` (${dir} vs 3mo ago${yoy})`;
  };
  // Prefer Redfin's per-product-type table (the real §17 anchor); fall back to
  // the FRED all-residential line when the county isn't in the digested JSON.
  const redfin = await fetchRedfinCountyMarket(reportData.countyName).catch(() => null);
  const redfinTable = redfin ? buildRedfinSaturationTable(reportData.countyName, redfin) : '';
  const marketStatsLine = mkt
    ? `County housing market — ALL RESIDENTIAL (Realtor.com via FRED), ${reportData.countyName} County, as of ${mkt.medianDaysOnMarket?.date || mkt.activeListings?.date || 'recent'}: ` +
      [
        mkt.medianDaysOnMarket ? `median DAYS ON MARKET ${mkt.medianDaysOnMarket.value}${trendOf(mkt.medianDaysOnMarket)}` : '',
        mkt.activeListings ? `ACTIVE listings ${mkt.activeListings.value.toLocaleString()}${trendOf(mkt.activeListings)}` : '',
        mkt.newListings ? `NEW listings/mo ${mkt.newListings.value.toLocaleString()}` : '',
        mkt.medianListPrice ? `median LIST price $${mkt.medianListPrice.value.toLocaleString()}${trendOf(mkt.medianListPrice)}` : '',
      ].filter(Boolean).join('; ') +
      `. This is the COUNTY all-residential anchor — USE it in Section 17, then BREAK IT DOWN by PRODUCT TYPE (single-family / townhome / condo / multifamily) and tighter geography (ZIP/submarket) via Google Search, and derive months-of-supply. Source: FRED (Realtor.com), https://fred.stlouisfed.org/series/MEDDAYONMAR${mkt.fips}`
    : `No live county market feed available — research current ACTIVE inventory, median DAYS ON MARKET, and MONTHS OF SUPPLY by product type near this address via Google Search for Section 17, and cite sources.`;

  // Format report context
  const reportContext = `
## PROVIDED DATA PACKET — verified evidence to USE in the report (this is DATA, not the report's section layout)

### Subject & Buildability Summary
- Property Location: ${reportData.inputAddress}
- Target Price / Lot Size: $${reportData.priceSoldFor?.toLocaleString() || 'N/A'} / ${reportData.gisAcres?.toFixed(2) || 'N/A'} Acres
- Absolute Buildability Verdict: ${reportData.slopeProfile?.verdict || 'BUILDABLE'} based on USGS 3DEP (1-meter) elevation data.

### 2. USGS 3DEP Slope Profile (1-meter)
- Average Site Slope: ${reportData.slopeProfile?.avgSlope || 0}%
- Maximum Site Slope: ${reportData.slopeProfile?.maxSlope || 0}%
- Physical Feasibility Assessment: Average elevation is ${reportData.slopeProfile?.avgElevation || 0}m (Min: ${reportData.slopeProfile?.minElevation || 0}m, Max: ${reportData.slopeProfile?.maxElevation || 0}m). 

### 2.5 Flood Hazard & Wetlands (FEMA NFHL + USFWS NWI — authoritative, queried by the parcel coordinate. USE these values and cite the sources; only research further if marked unavailable)
- FEMA Flood Zone: ${floodLine}
- Wetlands: ${wetlandsLine}

### 2.6 Financing — Current Mortgage Rate (live anchor for Section 18)
- ${mortgageLine}

### 2.7 Market Saturation — County Housing by Product Type (live anchor for Section 17)
${redfinTable || `- ${marketStatsLine}`}

### 3. Zoning & Estimated Density Allowances
- Zoning Classification (from county GIS): ${reportData.zoningCode} (${reportData.zoningDescription})
- ESTIMATED Development Capacity (typical for the use category — must be confirmed against the local ordinance): Max Building Footprint: ${reportData.gridics?.maxBuildingFootprintSqft?.toLocaleString() || 'N/A'} SF, Max Height: ${reportData.gridics?.maxHeightFt || 'N/A'} ft, Floor Area Ratio (FAR): ${reportData.gridics?.floorAreaRatio || 'N/A'}
- Estimated Dimensional Setbacks: Front: ${reportData.gridics?.setbacks.frontFt || 0} ft | Rear: ${reportData.gridics?.setbacks.rearFt || 0} ft | Side: ${reportData.gridics?.setbacks.sideFt || 0} ft
- Estimated net buildable envelope: ${reportData.gridics?.netBuildableAreaSqft?.toLocaleString() || 'N/A'} SF

### 4. SOLD New-Construction Comps (built 2025–2026, zoning-use-matched, CLOSED sales only, no sqft limits, sold ≤12 months, within 5 driving miles, RealtyAPI: Realtor + Redfin + Zillow). Each comp lists its property type.
${reportData.comps && reportData.comps.length > 0
  ? reportData.comps.map((comp, idx) => `- Comp ${idx + 1}: ${comp.address} | ${comp.propertyType || 'Home'} | Built ${comp.yearBuilt ?? 'N/A'} | ${comp.sqft ? `${comp.sqft.toLocaleString()} sqft | ` : ''}Sold ${comp.saleDate || 'N/A'} for $${comp.price.toLocaleString()}${comp.pricePerSqft ? ` ($${comp.pricePerSqft}/sqft)` : ''} | ${comp.distanceMiles.toFixed(2)} mi driving${comp.straightLineMiles != null ? ` (${comp.straightLineMiles.toFixed(2)} mi straight-line)` : ''}${comp.drivingFallback ? ' [straight-line fallback]' : ''} | ${comp.verifiedNote || 'Public MLS (Google Search)'}${comp.priceDiscrepancy ? ` | discrepancy: ${comp.priceDiscrepancy}` : ''}`).join('\n')
  : "NONE FOUND: no new-construction (built 2025–2026) HOME sales matching the subject's zoning use closed within the last 12 months inside the 5-mile driving radius (RealtyAPI: Realtor, Redfin, Zillow). Do NOT substitute older homes, vacant-land, raw-lot, or unbuilt-pad sales. State plainly that no qualifying comps were available and note the county tax-assessor values as the only valuation reference."}

### 5. Ownership, Tax & Assessment Data (for report content — never output this as a JSON/asset payload)
- Center Coordinates: [${reportData.coordinates.lat}, ${reportData.coordinates.lng}]
- Parcel Owner (first name first): ${reportData.ownerName}
- Mailing Address: ${reportData.mailingAddress}
- Assessed Value: ${reportData.assessedPropertyValue ? `$${reportData.assessedPropertyValue.toLocaleString()}` : 'N/A — no assessed property value on record'}
- Land Value: ${reportData.landValue ? `$${reportData.landValue.toLocaleString()}` : 'N/A — no assessor land value on record'}
- Census Tract: ${reportData.censusTract}
- Tax Code Area: ${reportData.taxCodeArea}
- Tax Amount: $${reportData.taxAmount}
- Legal Description: ${reportData.legalDescription}
`;

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `You are starting a session. Here is the compiled Land Feasibility Report for context:\n\n${reportContext}\n\nUnderstood? Let the user know you have the report loaded and are ready to chat about this parcel.`
        }
      ]
    },
    {
      role: 'model',
      parts: [
        {
          text: `I have loaded the Land Feasibility Report for ${reportData.inputAddress} into my persistent memory state layer. I am ready to answer any questions about the zoning allowances, setbacks, USGS 3DEP slope profile, soil/grading impacts, or driving comps for this property.`
        }
      ]
    }
  ];

  for (const msg of messages) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  const GEN_BASE = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash`;
  const baseBody = { contents, systemInstruction: { parts: [{ text: systemPrompt }] }, tools: [{ google_search: {} }] };

  // FUSION: when a DeepSeek key is configured, Gemini 3.5 Flash and DeepSeek V4
  // Pro draft the SAME task IN PARALLEL, then Gemini 3.5 Flash JUDGES and streams
  // the synthesized answer. Without a DeepSeek key, stream a single Gemini answer.
  const deepSeekKey = getDeepSeekKey();
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  if (deepSeekKey && lastUser) {
    const [gDraft, dDraft] = await Promise.all([
      geminiGenerateText(`${GEN_BASE}:generateContent?key=${apiKey}`, baseBody).catch((e) => { console.warn('Gemini draft failed:', e); return ''; }),
      fetchDeepSeekDraft(`${systemPrompt}\n\n# PROVIDED DATA PACKET (verified evidence)\n${reportContext}\n\n# YOUR ROLE\nProvide a substantive but CONCISE expert analytical draft — your key findings, figures, and risks per topic (zoning, REZONING/UPZONING upside, SUBDIVISION/lot-split potential, HOA/restrictions, buildability, flood, utilities, MARKET SATURATION & absorption by product type — single-family/townhome/condo/multifamily inventory, DOM, months-of-supply — the INTEREST-RATE environment and its demand effect, LOCAL itemized construction cost anchored to the Construction Cost Reference Model, and DEVELOPER ECONOMICS: ARV, residual land value = ARV − construction − site adders (trees/slope/well+septic) − 20%-of-ARV developer profit, cross-checked with the ~20%-of-ARV lot rule). A lead analyst synthesizes the final structured report from your input, so you need not format every numbered section.`, lastUser, deepSeekKey),
    ]);
    const judgeInstruction = `Two independent senior analysts each produced the DRAFT below for the SAME task. Acting as the JUDGE, synthesize the single best response that fully follows the Operating Standards:\n- Merge the strongest, most evidence-grounded content from both drafts.\n- Resolve any conflict in favor of cited/verified evidence; where they disagree and neither is verifiable, label it Likely or Unknown.\n- Keep the required section structure and the Verified / Likely / Unknown labels.\n- Output ONLY the final report. Do NOT mention drafts, judging, or model names.\n\n===== DRAFT A (Google Gemini 3.5 Flash) =====\n${gDraft || '(unavailable)'}\n\n===== DRAFT B (DeepSeek V4 Pro) =====\n${dDraft || '(DeepSeek draft unavailable — rely on Draft A and the data packet)'}`;
    const judgeBody = { ...baseBody, contents: [...contents, { role: 'user', parts: [{ text: judgeInstruction }] }] };
    return await streamGeminiSSE(`${GEN_BASE}:streamGenerateContent?alt=sse&key=${apiKey}`, judgeBody, onToken);
  }

  return await streamGeminiSSE(`${GEN_BASE}:streamGenerateContent?alt=sse&key=${apiKey}`, baseBody, onToken);
}
// EOF
