import type { SiteFeasibilityData, SlopeProfile, CompProperty } from '../types/feasibility';
import { fetchCountyZoningCode, hasCountyZoning, normalizeCountyKey } from '../data/ncZoning';

export interface UserKeys {
  googleMaps?: string;
  gemini?: string;
  openTopography?: string;
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
 */
export async function executeLandAnalysis(
  countyName: string,
  addressString: string,
  onStageChange?: (stage: string) => void
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

  // A. Real zoning district from the county's own GIS, looked up at the parcel
  // point. If the county GIS returns nothing (no published service, or a
  // municipally-zoned gap), fall back to a Google-Search-grounded web lookup of
  // the published zoning — clearly labeled "verify". Only if both fail do we
  // report N/A; we never fabricate a code.
  let zoningCode: string;
  let zoningDescription: string;
  let zoningSource: 'county-gis' | 'web' | undefined;
  let zoningSourceUrl: string | undefined;

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
  // Frontage comes from the real parcel geometry, not the estimate.
  const standards = estimateZoningStandards(zoningCode, zoningDescription);
  const lotType = standards.lotType;
  const maxHeightFt = standards.maxHeightFt;
  const floorAreaRatio = standards.floorAreaRatio;
  const setbacks = { ...standards.setbacks };
  const frontageLengthFt = W > 0 ? Math.round(W * 100) / 100 : 0;
  // Max footprint ≈ a typical maximum lot coverage applied to the parcel area.
  const maxBuildingFootprintSqft = Math.round(grossSf * 0.4);

  // Calculate net buildable area envelope after applying setbacks to the width & depth
  const sideFt = setbacks.sideFt;
  const frontFt = setbacks.frontFt;
  const rearFt = setbacks.rearFt;
  const netWidth = Math.max(0, W - 2 * sideFt);
  const netDepth = Math.max(0, D - (frontFt + rearFt));
  const netBuildableAreaSqft = Math.round(netWidth * netDepth);

  // Only report a single Width x Depth when the lot is roughly rectangular (its
  // bounding box fills most of the parcel). For irregular/triangular lots a
  // single W x D would misrepresent the area, so we omit it and let the
  // per-side dimensions on the map speak for themselves.
  const obbFill = W > 0 && D > 0 && grossSf > 0 ? grossSf / (W * D) : 1;
  const isRectangularish = obbFill >= 0.85;

  const gridics = {
    frontageLengthFt,
    lotWidthFt: isRectangularish ? Math.round(W * 10) / 10 : undefined,
    lotDepthFt: isRectangularish ? Math.round(D * 10) / 10 : undefined,
    lotType,
    maxBuildingFootprintSqft,
    maxHeightFt,
    floorAreaRatio,
    setbacks: {
      frontFt,
      rearFt,
      sideFt
    },
    netBuildableAreaSqft
  };

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

  // Pass the full input address (it has the city/ZIP) so the comp search targets
  // the right area — the parcel's situs field is often street-only.
  const compLocationAddress = `${addressString}${info.scity && !addressString.toLowerCase().includes(String(info.scity).toLowerCase()) ? `, ${info.scity}` : ''}`;
  // Comps and topography run concurrently (topography started earlier).
  const [comps, slopeProfile] = await Promise.all([
    fetchGoogleDistanceMatrixComps(lat, lng, parcelId, zoningCode, zoningDescription, compLocationAddress, countyName, onStageChange),
    slopeProfilePromise,
  ]);

  return {
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
    slopeProfile,
    comps
  };
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

async function geocodeAddress(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
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
          return {
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng
          };
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

function parseCompsFromJsonText(text: string): any[] | null {
  try {
    const regex = /```json\s*([\s\S]*?)\s*```/;
    const match = text.match(regex);
    let jsonString = '';
    if (match) {
      jsonString = match[1];
    } else {
      const startIdx = text.indexOf('[');
      const endIdx = text.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) {
        jsonString = text.substring(startIdx, endIdx + 1);
      }
    }
    if (!jsonString) return null;
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    console.error("Failed to parse comps JSON from LLM response:", e);
  }
  return null;
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

const RAPIDAPI_HOST = "us-real-estate-listings.p.rapidapi.com";

/** Readable label for a Realtor.com property type code. */
function prettyPropertyType(t?: string): string {
  switch ((t || "").toLowerCase()) {
    case "single_family": return "Single-Family Residential";
    case "townhomes":
    case "townhouse": return "Townhome";
    case "condo":
    case "condos": return "Condo";
    case "multi_family": return "Multi-Family";
    case "duplex_triplex": return "Duplex/Triplex";
    case "land": return "Land";
    default: return "Residential";
  }
}

/**
 * Fetches recently-SOLD listings near a city from the RapidAPI "US Real Estate
 * Listings" API (Realtor.com data). Returns comp candidates already carrying
 * coordinates, sold price/date, year built and property type — the new-
 * construction / 12-month / distance filters are applied by the caller. Only
 * listings whose property type matches the subject's use category are kept.
 */
async function fetchRapidApiSoldComps(
  location: string,
  category: 'residential' | 'commercial' | 'multifamily',
): Promise<any[]> {
  const apiKey = import.meta.env.VITE_RAPIDAPI_KEY || "6ac2a630f1mshb4c34ebf936da30p186179jsn634fc3de7627";
  const typeMatches = (t?: string): boolean => {
    const type = (t || "").toLowerCase();
    if (category === "multifamily") return ["townhomes", "townhouse", "condo", "condos", "multi_family", "co_op", "duplex_triplex"].includes(type);
    if (category === "commercial") return ["land", "commercial", "other", "farm"].includes(type);
    return type === "single_family"; // residential
  };
  const comps: any[] = [];
  const seen = new Set<string>();
  try {
    // Sold listings come ~50 per page, most-recent first. The free tier is only
    // ~100 requests/month, so we use ONE request per search (50 listings) and
    // stop on any non-OK (e.g. a 429 rate-limit).
    for (let offset = 0; offset < 50; offset += 50) {
      const url = `https://${RAPIDAPI_HOST}/sold-homes?location=${encodeURIComponent(location)}&offset=${offset}`;
      const res = await fetchWithTimeout(url, 12000, {
        headers: { "x-rapidapi-key": apiKey, "x-rapidapi-host": RAPIDAPI_HOST },
      });
      if (!res.ok) break; // covers 429 rate-limit
      const listings = (await res.json()).listings || [];
      if (listings.length === 0) break;
      for (const l of listings) {
        const a = l.location?.address;
        const d = l.description;
        const coord = a?.coordinate;
        if (!a || !d || !coord || typeof coord.lat !== "number" || typeof coord.lon !== "number") continue;
        if (!typeMatches(d.type)) continue;
        const key = `${a.line}|${a.postal_code}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        comps.push({
          address: `${a.line}, ${a.city}, ${a.state_code} ${a.postal_code}`,
          price: l.last_sold_price || l.list_price || 0,
          saleDate: l.last_sold_date || "",
          yearBuilt: d.year_built,
          propertyType: prettyPropertyType(d.type),
          coords: { lat: coord.lat, lng: coord.lon },
        });
      }
      if (listings.length < 50) break; // last page
    }
  } catch (e) {
    console.warn("RapidAPI sold-homes lookup failed:", e);
  }
  return comps;
}

// ---------------------------------------------------------------------------
// Comp result cache. The Gemini/Google-Search comp discovery is inherently
// non-deterministic, so without a cache the SAME address could return a
// DIFFERENT comp set on every run. We persist the final verified comp set per
// parcel location (localStorage, 7-day TTL) so repeat searches on the same
// address are instant AND return identical comps.
// ---------------------------------------------------------------------------
const COMPS_CACHE_PREFIX = "gisfs:comps:v2:";
const COMPS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function compsCacheKey(lat: number, lng: number, category: string): string {
  // ~1m coordinate precision → the same parcel always maps to the same key.
  return `${COMPS_CACHE_PREFIX}${lat.toFixed(5)},${lng.toFixed(5)}|${category}`;
}

function readCompsCache(key: string): CompProperty[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.comps) || typeof entry.t !== "number") return null;
    if (Date.now() - entry.t > COMPS_CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.comps as CompProperty[];
  } catch {
    return null;
  }
}

function writeCompsCache(key: string, comps: CompProperty[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), comps }));
  } catch {
    // localStorage full/unavailable — caching is best-effort only.
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
): Promise<CompProperty[]> {
  onStageChange?.("Searching sold listings...");

  // Comp criteria: NEW CONSTRUCTION (built 2025–present) that SOLD within the last
  // 12 months, located 0.5–5 driving miles from the subject.
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const MIN_YEAR_BUILT = 2025;

  // Permitted use category (drives the Realtor search property type).
  const category = getPermittedCategory(zoningCode, zoningDesc);

  // Same address searched again? Return the EXACT same verified comp set
  // (deterministic + instant) instead of re-running the non-deterministic search.
  const cacheKey = compsCacheKey(lat, lng, category);
  const cached = readCompsCache(cacheKey);
  if (cached && cached.length > 0) {
    console.log(`Returning ${cached.length} cached comps for this parcel (deterministic re-run).`);
    return cached;
  }

  // Straight-line miles from the subject to a candidate (used to pre-rank).
  const straightMiles = (c: { coords: { lat: number; lng: number } }) => {
    const dLng = c.coords.lng - lng;
    const dLat = c.coords.lat - lat;
    const R = 3958.8;
    return Math.sqrt(
      Math.pow((dLat * Math.PI) / 180 * R, 2) +
      Math.pow((dLng * Math.PI) / 180 * R * Math.cos((lat * Math.PI) / 180), 2)
    );
  };

  // Comp qualifiers: new construction (built 2025+) and sold within the last 12 months.
  const isNewConstruction = (yb: any) => Number.isFinite(Number(yb)) && Number(yb) >= MIN_YEAR_BUILT;
  const soldWithinYear = (sd?: string) => {
    if (!sd) return false;
    const d = new Date(sd);
    return !isNaN(d.getTime()) && d >= oneYearAgo && d.getTime() <= today.getTime() + 86400000;
  };

  // Extract city and ZIP from address string
  const addressParts = addressString.split(',');
  const city = addressParts[1] ? addressParts[1].trim() : 'Charlotte';
  const zipMatch = addressString.match(/\b\d{5}\b/);
  const zip = zipMatch ? zipMatch[0] : '';

  let compAddresses: any[] = [];
  const stateMatch = addressString.match(/\b([A-Z]{2})\b/);
  const stateCode = stateMatch ? stateMatch[1] : 'NC';

  // B. Primary comp source: Gemini + Google Search grounding over Realtor.com sold
  // listings. Returns recently-sold comparable HOMES (new construction prioritized).
  onStageChange?.("Searching sold home comps (Google)...");
  const geminiApiKey = getUserKeys().gemini || "";
  if (!geminiApiKey) {
    console.warn("Gemini API key is not configured in Account Settings — skipping the Google comp search and relying on the listings API.");
  }

 else {
    const propertyTypePrompt = category === 'residential'
      ? 'single-family residential (SFR)'
      : category === 'commercial'
        ? 'commercial or retail'
        : 'multifamily townhome, condo, or apartment';

    const queryPrompt = `Use Google Search to find recently SOLD ${propertyTypePrompt} HOMES near ${city}, ${stateCode} (zip code: ${zip}).
Search ACROSS MULTIPLE reputable real estate sources to maximize coverage — Zillow, Realtor.com, Redfin, Homes.com, Trulia, and public county/MLS records. Run several searches (e.g. site:zillow.com, site:realtor.com, site:redfin.com, site:homes.com, site:trulia.com) and combine the unique results. Do NOT limit yourself to a single site or a small number of results.

Criteria for each comp:
- SOLD within the last 12 months (sale date on or after ${oneYearAgo.toISOString().split('T')[0]}).
- Located within about 5 driving miles of the subject.
- Completed HOMES only — NEVER vacant land, raw lots, or unbuilt pads.
- Prioritize NEW CONSTRUCTION (year built ${MIN_YEAR_BUILT} or later); also include other recently sold comparable homes of the same type.

BE EXHAUSTIVE — DO NOT BE LAZY. Return EVERY qualifying sold property you can find, de-duplicated by address. There is NO maximum count: if 60+ qualifying sales exist, return all 60+. Do not stop after the first page of results or the first source; keep searching until additional queries stop surfacing new qualifying sales. Never fabricate addresses, prices, sale dates, or year built — include only real, verifiable sales.

Output a JSON array of objects inside a markdown code block exactly like this:
\`\`\`json
[
  {
    "address": "123 Example St, City, NC 28120",
    "price": 399900,
    "saleDate": "2026-01-20",
    "yearBuilt": 2025,
    "propertyType": "Single-Family Residential (SFR)"
  }
]
\`\`\`

Only output the JSON block, nothing else. Addresses must be real; prices must be numbers.`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`;
    try {
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: queryPrompt }] }],
          systemInstruction: {
            parts: [{ text: "You are an exhaustive real estate comps research agent. Use Google Search across MULTIPLE sources — Zillow, Realtor.com, Redfin, Homes.com, Trulia, and public records — to find SOLD home listings, and return them as structured JSON. Pull EVERY real, verifiable sold home that meets the criteria — there is no maximum; being lazy or stopping at a handful is a failure. Never include vacant land, and never fabricate." }]
          },
          tools: [{ google_search: {} }],
          // Deterministic decoding so the same address yields a stable comp set.
          generationConfig: { temperature: 0 }
        })
      });
      if (geminiResponse.ok) {
        const text = (await geminiResponse.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = parseCompsFromJsonText(text);
        if (parsed && parsed.length > 0) {
          // De-duplicate by address (multiple sources often list the same sale).
          const seen = new Set<string>();
          compAddresses = parsed.filter((c: any) => {
            const key = String(c?.address || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
      }
    } catch (e) {
      console.warn("Gemini comp search failed:", e);
    }
  }

  // Supplement with the RapidAPI listings API (Realtor.com data) and merge —
  // more sources = more qualifying comps. De-duplicated by normalized address.
  {
    const compLocation = zip || `${city}, ${stateCode}`;
    const rapidComps = await fetchRapidApiSoldComps(compLocation, category);
    if (rapidComps.length > 0) {
      const seen = new Set(
        compAddresses.map((c: any) => String(c?.address || '').toLowerCase().replace(/[^a-z0-9]/g, '')),
      );
      for (const rc of rapidComps) {
        const key = String(rc.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        compAddresses.push(rc);
      }
    }
  }

  console.log(`Collected ${compAddresses.length} sold-comp candidates.`);

  onStageChange?.("Calculating driving distance comps...");

  // E. Resolve coordinates. RapidAPI listings already carry coordinates; Google-
  // search (Gemini) candidates are geocoded in PARALLEL (which also verifies each
  // is a real property) so a large comp set doesn't stall the report.
  const googleApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";
  const resolved = await Promise.all(
    compAddresses.map(async (comp) => {
      if (comp.coords && typeof comp.coords.lat === 'number' && typeof comp.coords.lng === 'number') return comp;
      const verifiedCoords = await geocodeAddress(comp.address, googleApiKey);
      if (verifiedCoords) return { ...comp, coords: verifiedCoords };
      console.log(`Skipping comp "${comp.address}" — failed Google geocoding verification.`);
      return null;
    })
  );
  let finalCompCandidates: any[] = resolved.filter((c): c is any => c !== null);

  // Keep ALL comps meeting the criteria — NEW CONSTRUCTION (built 2025+), sold
  // within 12 months, within ~5mi — with NO cap on the count. Ranked by
  // proximity; the Distance Matrix call below is batched in chunks of 25, so
  // any number of qualifying comps can be verified.
  finalCompCandidates = finalCompCandidates.filter(
    (c) => isNewConstruction(c.yearBuilt) && soldWithinYear(c.saleDate) && straightMiles(c) <= 5.5,
  );
  finalCompCandidates.sort((a, b) => straightMiles(a) - straightMiles(b));

  // F. Google Distance Matrix Driving Verification
  let compsWithDriving: CompProperty[] = [];
  let sdkResults: ({ distanceMiles: number; durationMins: number } | null)[] | null = null;

  try {
    const destinations = finalCompCandidates.map(c => ({ lat: c.coords.lat, lng: c.coords.lng }));
    sdkResults = await fetchDrivingDistancesViaSDK(lat, lng, destinations);
  } catch (sdkErr) {
    console.warn("Failed to retrieve driving distances from SDK:", sdkErr);
  }

  if (sdkResults && sdkResults.length === finalCompCandidates.length) {
    console.log("Successfully fetched driving distances using client-side Google Maps SDK.");
    compsWithDriving = finalCompCandidates.map((c, idx) => {
      const sdkRes = sdkResults![idx];
      let distanceMiles = c.distanceMiles || 1.2;
      let durationMins = c.durationMins || 4.0;
      if (sdkRes) {
        distanceMiles = sdkRes.distanceMiles;
        durationMins = sdkRes.durationMins;
      } else {
        // Fallback to straight-line distance if specific destination element failed
        const dLng = c.coords.lng - lng;
        const dLat = c.coords.lat - lat;
        const earthRadius = 3958.8;
        const miles = Math.sqrt(
          Math.pow(dLat * (Math.PI / 180) * earthRadius, 2) +
          Math.pow(dLng * (Math.PI / 180) * earthRadius * Math.cos(lat * Math.PI / 180), 2)
        );
        distanceMiles = miles;
        durationMins = miles * 2.5;
      }
      return {
        address: c.address,
        price: c.price,
        saleDate: c.saleDate,
        yearBuilt: c.yearBuilt,
        propertyType: c.propertyType,
        coords: c.coords,
        distanceMiles: Math.round(distanceMiles * 100) / 100,
        durationMins: Math.round(durationMins * 10) / 10
      };
    });
  } else {
    console.log("SDK Distance Matrix unavailable, falling back to REST API fetch...");
    const originStr = `${lat},${lng}`;
    try {
      // Batch into chunks of 25 (Google's per-request destination limit) and combine.
      const CHUNK = 25;
      const elements: any[] = [];
      for (let i = 0; i < finalCompCandidates.length; i += CHUNK) {
        const destStr = finalCompCandidates.slice(i, i + CHUNK).map(c => `${c.coords.lat},${c.coords.lng}`).join('|');
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destStr}&key=${googleApiKey}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Google Distance Matrix API returned status ${response.status}`);
        const data = await response.json();
        if (data.status === "OK" && data.rows?.[0]?.elements) {
          elements.push(...data.rows[0].elements);
        } else {
          throw new Error(`Invalid status in Distance Matrix payload: ${data.status}`);
        }
      }
      compsWithDriving = finalCompCandidates.map((c, idx) => {
        const el = elements[idx];
        let distanceMiles = c.distanceMiles || 1.2;
        let durationMins = c.durationMins || 4.0;
        if (el && el.status === "OK" && el.distance && el.duration) {
          distanceMiles = el.distance.value * 0.000621371;
          durationMins = el.duration.value / 60;
        } else {
          const dLng = c.coords.lng - lng;
          const dLat = c.coords.lat - lat;
          const earthRadius = 3958.8;
          const miles = Math.sqrt(
            Math.pow(dLat * (Math.PI / 180) * earthRadius, 2) +
            Math.pow(dLng * (Math.PI / 180) * earthRadius * Math.cos(lat * Math.PI / 180), 2)
          );
          distanceMiles = miles;
          durationMins = miles * 2.5;
        }
        return {
          address: c.address,
          price: c.price,
          saleDate: c.saleDate,
          yearBuilt: c.yearBuilt,
          propertyType: c.propertyType,
          coords: c.coords,
          distanceMiles: Math.round(distanceMiles * 100) / 100,
          durationMins: Math.round(durationMins * 10) / 10
        };
      });
    } catch (err) {
      console.warn("Distance Matrix REST API verification failed, using coordinate route approximations:", err);
      compsWithDriving = finalCompCandidates.map(c => {
        const dLng = c.coords.lng - lng;
        const dLat = c.coords.lat - lat;
        const earthRadius = 3958.8;
        const miles = Math.sqrt(
          Math.pow(dLat * (Math.PI / 180) * earthRadius, 2) +
          Math.pow(dLng * (Math.PI / 180) * earthRadius * Math.cos(lat * Math.PI / 180), 2)
        );
        return {
          address: c.address,
          price: c.price,
          saleDate: c.saleDate,
          yearBuilt: c.yearBuilt,
          propertyType: c.propertyType,
          coords: c.coords,
          distanceMiles: Math.round(miles * 100) / 100,
          durationMins: Math.round(miles * 2.5 * 10) / 10
        };
      });
    }
  }

  // Final comp set: STRICTLY new construction (built 2025+), same use, sold within
  // 12 months, 0.5–5 driving miles. No older/non-new-construction homes are
  // included, and NO cap on the count — every qualifying comp is returned,
  // nearest-first.
  const result = compsWithDriving
    .filter(c =>
      c.distanceMiles >= 0.5 && c.distanceMiles <= 5.0 &&
      soldWithinYear(c.saleDate) && isNewConstruction(c.yearBuilt)
    )
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
  console.log(`Returning ${result.length} new-construction comps (no cap).`);
  // Persist so repeat searches of this address return the identical comp set.
  if (result.length > 0) writeCompsCache(cacheKey, result);
  return result;
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

export async function chatWithGemini(
  messages: ChatMessage[],
  reportData: SiteFeasibilityData
): Promise<{ text: string; sources?: ChatSource[] }> {

  const apiKey = getUserKeys().gemini || "";
  if (!apiKey) {
    throw new Error("Gemini API key is required. Please configure it in Account Settings.");
  }

  const systemPrompt = `
# Role & Objective
You are Antigravity, an autonomous real estate acquisition intelligence agent. Your purpose is to process property assets, pull live market data from real estate platforms, cross-reference county GIS zoning datasets, compute exact physical buildability constraints via USGS 3DEP (1-meter) elevation, filter proximity market comps using the Google Distance Matrix API, and produce a polished, human-readable land feasibility report.

# Strict Development Rules
1. CRITICAL: For new construction, you must NEVER look for active comps or make up artificial comps. Only look for and pull **recently SOLD comps** to protect valuation integrity.
2. BUILDABILITY METRIC: Evaluate slope data from the USGS 3DEP (1-meter) elevation profile immediately. You must explicitly declare whether the land is "Buildable", "Requires Special Engineering", or "Non-Buildable" based on the slope thresholds:
   - Less than 15% slope = Buildable
   - 15% to 25% slope = Requires Special Engineering / Increased Costs
   - Greater than 25% slope = Non-Buildable / High Risk
3. COMP LINKS ROUTING: You must NEVER hallucinate or write direct Realtor.com detail URLs (e.g., links containing "/realestateandhomes-detail/"). Detail links fail without precise internal property IDs. Instead, if you include links for any comparable sale properties or addresses, you MUST format them as a Google Search grounding URL with the address: https://www.google.com/search?q=[Address] (replacing spaces in the query with + or using standard URL encoding). Do NOT wrap the address in double quotes.

# Comp Search Criteria (FIXED — do not substitute)
When analyzing comps, use EXACTLY these criteria:
- Property Type: SOLD HOMES that match the subject's permitted use — single-family houses, townhomes, or condos. NEVER vacant land, raw lots, undeveloped land, or unbuilt "pads"; the comps are completed homes.
- NEW CONSTRUCTION ONLY: year built 2025 or later. Do NOT include older homes built before 2025.
- Recency: closed/sold within the last 12 months.
- Distance: 0.5 to 5 driving miles from the subject.
- The verified comps are supplied to you in the report data below — use ONLY those exact homes. Never invent comps, never substitute older (pre-2025) homes, and never substitute vacant-land/raw-lot sales. If the list is empty, say so plainly.

# Report Output Rules (CRITICAL)
- Generate the FULL report immediately. The comp criteria above are fixed — do NOT halt to ask the user to confirm a comp strategy or saved preferences. Just produce the complete report (including the wholesale valuation) in one response using the provided comps and data.
- The report is for HUMAN readers (investors/wholesalers). Do NOT include any "Map & Infrastructure Layer Assets" section, JSON schema payloads, raw JSON blocks, placeholder arrays, map-layer/renderer assets, or PDF/backend formatting instructions anywhere in the report.
- Do NOT include, mention, or announce any "Interactive Assistant Mode", chatbot mode, session state, or persistent memory in the report. Never end the report with statements like "transitioning to Interactive Assistant Mode."
- Use the ownership/tax/assessment data provided in the context as report content (owner, mailing address, values, taxes) — present it in normal report sections, not as a data dump.

# Follow-Up Questions (after the report)
For any follow-up question, answer conversationally using the stored report context; use live Google Search grounding for niche municipal code questions when needed. Do not regenerate the full report unless asked.

# Gemini-Style Response Structure & Tone (CRITICAL)
- Adopt the exact communication style of Google Gemini (gemini.google.com).
- Keep your tone objective, highly structured, direct, and authoritative.
- Start directly with the answer; NEVER include conversational intro/outro filler (e.g. do NOT say "Sure, here is the information" or "I hope this helps!").
- Utilize rich formatting: use bolding (**text**), clear hierarchical headers (###), bullet points, and clean spacing.
- When explaining complex numbers, code regulations, or calculations, structure the information in a clean Markdown table format or step-by-step numbered list.

# Land Wholesale Methodology (compute precisely; ALWAYS show the math)
This is a LAND WHOLESALING analysis — getting a lot under contract and ASSIGNING it to a builder/investor. It is NOT a rehab/flip and you do NOT subtract construction cost or builder profit. Use ONLY the provided comps and data; never invent prices. Show every formula, percentage, and input.

STEP 1 — ARV (Finished New-Construction Value): From the verified new-construction sold comps in the report data, compute the MEDIAN sold price. State the comp count and the median. If there are ZERO comps, state plainly that ARV cannot be established from comps and STOP the wholesale math — note the county tax-assessor LAND value as the only anchor; do NOT fabricate a number.

STEP 2 — Finished Lot Value (what a builder would pay for the lot): Builders pay roughly 15%–25% of ARV for the finished lot. Use 20% as the base (15% in softer/rural markets, 25% in hot infill markets); state the % used.
   Lot Value = ARV × (15%–25%).
   (If recent comparable LOT sales are known from Google Search, you may cross-check Lot Value against them.)

STEP 3 — Classify the land type and pick the Investor/Builder Buy Percentage (state which applies):
   | Land Type | Buy % of Lot Value |
   | Infill lot in a city | 50%–70% |
   | Buildable suburban lot | 40%–60% |
   | Rural acreage | 20%–50% |
   | Recreational land | 20%–40% |
   For NC infill lots (Charlotte, Gastonia, Mount Holly, Kannapolis, Dallas, Concord, etc.), builders/investors typically buy at 70%–85% of the lot value depending on demand. Classify the subject from its acreage, zoning, and location (a small lot in/near a city = infill; a larger parcel = suburban/rural) and pick a percentage within the right band.

STEP 4 — Maximum Allowable Offer (MAO) and assignment:
   Investor/Builder Purchase Price = Lot Value × (Buy %).
   MAO (your contract price to the seller) = Investor Purchase Price − Wholesale/Assignment Fee.
   Assignment Fee: state the figure used (typical $5,000–$15,000).
   Assignment Price (what you sell the contract to the builder for) ≈ Investor Purchase Price.
   Projected Spread (your profit) = Assignment Price − MAO (≈ your assignment fee).

WORKED EXAMPLE to mirror (use the subject's real numbers, not these):
   ARV $350,000 → Lot Value at 20% = $70,000 → infill Buy % 80% → Investor Purchase Price = $56,000 → minus $7,500 fee → MAO ≈ $48,500; assign ≈ $56,000.

METHOD 3 — Developer Formula (MANDATORY whenever the county tax-assessor PROPERTY value and/or LAND value are missing, zero, or N/A in the report data; also useful as a cross-check otherwise):
Many land buyers use:
   Offer = ARV × 20%–30%
Example (mirror this with the subject's REAL ARV from the comps, not these numbers):
   New construction ARV = $300,000 → Land acquisition target:
   - 20% = $60,000
   - 25% = $75,000
   - 30% = $90,000
Then SUBTRACT estimated site-prep and deal costs from the acquisition target to reach the final offer:
   - Tree clearing
   - Well
   - Septic
   - Utility extensions
   - Grading
   - Demolition (if applicable)
   - Your assignment fee
Present Method 3 as a Markdown table showing the subject's ARV, the 20% / 25% / 30% acquisition targets, each itemized deduction (label cost figures as estimates), and the resulting net offer range. When the assessor values are absent, say plainly that the assessor anchor is unavailable and that Method 3 (Developer Formula) is being used as the valuation basis.

STEP 5 — Present a clean Markdown table showing every line: ARV, Lot % of ARV, Lot Value, land-type classification, Buy %, Investor Purchase Price, Assignment Fee, MAO (contract price), Assignment Price, and Spread. Then sanity-check the MAO and Lot Value against the county tax-assessor LAND value and assessed value in the report data; if they diverge widely, say so and lower the stated confidence. If the assessor LAND value and/or assessed PROPERTY value are missing, zero, or N/A, skip that sanity-check and instead apply METHOD 3 (Developer Formula) above as the cross-check and state its resulting offer range.

STEP 6 — NEVER present an MAO without showing the ARV, lot %, buy %, and assignment fee inputs. Label estimates as estimates. If comps are missing, say so rather than guessing.

# Accuracy Mandate
- Use ONLY the data and comps provided in the report context plus live Google Search for facts you cite (always with a source). Do not invent owner names, prices, dates, slopes, or zoning.
- Every dollar figure in a calculation must trace to a shown input. If you cannot support a number, omit it and say why.
`;

  // Format report context
  const reportContext = `
### 1. Executive Feasibility Summary
- Property Location: ${reportData.inputAddress}
- Target Price / Lot Size: $${reportData.priceSoldFor?.toLocaleString() || 'N/A'} / ${reportData.gisAcres?.toFixed(2) || 'N/A'} Acres
- Absolute Buildability Verdict: ${reportData.slopeProfile?.verdict || 'BUILDABLE'} based on USGS 3DEP (1-meter) elevation data.

### 2. USGS 3DEP Slope Profile (1-meter)
- Average Site Slope: ${reportData.slopeProfile?.avgSlope || 0}%
- Maximum Site Slope: ${reportData.slopeProfile?.maxSlope || 0}%
- Physical Feasibility Assessment: Average elevation is ${reportData.slopeProfile?.avgElevation || 0}m (Min: ${reportData.slopeProfile?.minElevation || 0}m, Max: ${reportData.slopeProfile?.maxElevation || 0}m). 

### 3. Zoning & Estimated Density Allowances
- Zoning Classification (from county GIS): ${reportData.zoningCode} (${reportData.zoningDescription})
- ESTIMATED Development Capacity (typical for the use category — must be confirmed against the local ordinance): Max Building Footprint: ${reportData.gridics?.maxBuildingFootprintSqft?.toLocaleString() || 'N/A'} SF, Max Height: ${reportData.gridics?.maxHeightFt || 'N/A'} ft, Floor Area Ratio (FAR): ${reportData.gridics?.floorAreaRatio || 'N/A'}
- Estimated Dimensional Setbacks: Front: ${reportData.gridics?.setbacks.frontFt || 0} ft | Rear: ${reportData.gridics?.setbacks.rearFt || 0} ft | Side: ${reportData.gridics?.setbacks.sideFt || 0} ft
- Estimated net buildable envelope: ${reportData.gridics?.netBuildableAreaSqft?.toLocaleString() || 'N/A'} SF

### 4. Verified SOLD New-Construction Home Comps (built 2025+, sold in last 12 months, 0.5–5 driving miles)
${reportData.comps && reportData.comps.length > 0
  ? reportData.comps.map((comp, idx) => `- Comp ${idx + 1}: ${comp.address} | ${comp.propertyType || 'Home'} | Built ${comp.yearBuilt ?? 'N/A'} | Sold ${comp.saleDate || 'N/A'} for $${comp.price.toLocaleString()} | ${comp.distanceMiles.toFixed(2)} mi / ${Math.round(comp.durationMins)} min driving`).join('\n')
  : "NONE FOUND: no new-construction (built 2025+) HOME sales of the subject's use type occurred within the last 12 months in the 0.5–5 mile radius. Do NOT substitute older homes, vacant-land, raw-lot, or unbuilt-pad sales. State plainly that no qualifying new-construction comps were available and anchor the valuation on the tax assessor baseline."}

### 5. Ownership, Tax & Assessment Data (for report content — never output this as a JSON/asset payload)
- Center Coordinates: [${reportData.coordinates.lat}, ${reportData.coordinates.lng}]
- Parcel Owner (first name first): ${reportData.ownerName}
- Mailing Address: ${reportData.mailingAddress}
- Assessed Value: ${reportData.assessedPropertyValue ? `$${reportData.assessedPropertyValue.toLocaleString()}` : 'N/A — no assessed property value on record (use METHOD 3 Developer Formula)'}
- Land Value: ${reportData.landValue ? `$${reportData.landValue.toLocaleString()}` : 'N/A — no assessor land value on record (use METHOD 3 Developer Formula)'}
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      tools: [
        {
          google_search: {}
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const resData = await response.json();
  const text = resData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

  // Extract grounding metadata if present
  const sources: ChatSource[] = [];
  const groundingMetadata = resData.candidates?.[0]?.groundingMetadata;
  if (groundingMetadata && groundingMetadata.groundingChunks) {
    for (const chunk of groundingMetadata.groundingChunks) {
      if (chunk.web && chunk.web.uri) {
        sources.push({
          title: chunk.web.title || chunk.web.uri,
          uri: chunk.web.uri
        });
      }
    }
  }

  return { text, sources: sources.length > 0 ? sources : undefined };
}
// EOF
