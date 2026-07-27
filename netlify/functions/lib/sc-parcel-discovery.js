// SC PARCEL AUTO-DISCOVERY
//
// The statewide SCDOT parcel layer became token-gated, so any SC county without a
// hard-coded parcel endpoint lost owner + land details entirely. This finds the
// county's OWN official parcel layer the same way sc-zoning-discovery finds
// official zoning services:
//
//   1. search the public ArcGIS catalog for the county's parcel/cadastral items
//   2. VERIFY the publisher (org/owner/host must carry the county name) so a
//      random third-party copy can never be treated as authoritative
//   3. expand items into MapServer/FeatureServer URLs
//   4. PROBE each candidate at the parcel point and keep the first layer that
//      actually returns a parcel-shaped record (owner and/or parcel-id fields)
//
// Step 4 is what makes this safe: a layer only counts if it answers with a real
// parcel at the requested coordinate, so a mis-ranked candidate yields nothing
// rather than wrong data.

const ITEM_ID_RE = /^[a-f0-9]{32}$/i;
const SERVICE_URL_RE = /https?:\\?\/\\?\/[^"'<>\s]+?(?:MapServer|FeatureServer)(?:\/\d+)?/gi;
const PUBLIC_ARCGIS_ROOT = 'https://www.arcgis.com/sharing/rest';
const PUBLIC_ITEM_TYPE_RE = /^(?:Feature Service|Map Service|Web Map|Web Mapping Application|Web Experience|Experience Builder|Hub Site Application)$/i;

const PARCEL_NAME_RE = /\b(parcel|parcels|cadastral|cadastre|tax\s*map|property|properties|land\s*record)\b/i;
const EXCLUDED_NAME_RE = /\b(zoning|flood|school|voting|precinct|election|address\s*point|road|street|hydro|soil|wetland|future|proposed|draft|historic|permit|sales|sold|easement|utility|sewer|water|storm|annex)\b/i;

// A record only counts as a parcel if it carries a parcel identifier and/or owner.
const PARCEL_ID_KEY_RE = /(^|_)(pin|tms|apn|pid|parcel|taxmap|map_?number|parcel_?id|parcelno|parno)/i;
const OWNER_KEY_RE = /(owner|ownname|own_?name|taxpayer|deed_?holder|grantee)/i;
const ACRE_KEY_RE = /(acre|acreage|gis_?acres|calc_?acres|deeded_?acres)/i;
const ADDRESS_KEY_RE = /(situs|site_?add|prop_?add|phys_?add|location|address)/i;

const dedupe = (values) => [...new Set(values.filter(Boolean))];
const compactName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isParcelName = (value) => PARCEL_NAME_RE.test(String(value || '').replace(/[_-]+/g, ' '));
const isExcludedName = (value) => EXCLUDED_NAME_RE.test(String(value || '').replace(/[_-]+/g, ' '));

function cleanServiceUrl(value) {
  const url = String(value || '').replace(/\\\//g, '/').replace(/[),.;]+$/, '');
  const match = url.match(/^(https?:\/\/.*?(?:MapServer|FeatureServer))(?:\/\d+)?(?:[?#].*)?$/i);
  return match?.[1] || null;
}

async function request(url, fetcher, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    // ArcGIS answers 200 with an error body (e.g. 499 Token Required) — treat
    // that as a miss, which is exactly the bug that hid the SCDOT outage.
    if (data && data.error) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stringsInObject(value, found = []) {
  if (found.length >= 800 || value == null) return found;
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsInObject(entry, found));
  else if (typeof value === 'object') Object.values(value).forEach((entry) => stringsInObject(entry, found));
  return found;
}

/** Catalog items for this county that look like official parcel data AND are
 *  published by the county itself. */
async function verifiedParcelItemIds(county, fetcher) {
  const countyToken = compactName(county);
  if (countyToken.length < 3) return [];
  // Counties title their items inconsistently ("Charleston County Parcels",
  // "Parcels_Public", "Tax Parcels"), so several phrasings are searched and the
  // hits merged — a single quoted phrase missed roughly half the counties.
  const queries = [
    `"${county} County" AND (parcels OR cadastral OR "tax parcels")`,
    `${county} County parcels`,
    `${county} parcels GIS`,
  ];
  const searches = await Promise.all(queries.map((q) => request(
    `${PUBLIC_ARCGIS_ROOT}/search?f=json&num=50&sortField=modified&sortOrder=desc&q=${encodeURIComponent(q)}`,
    fetcher,
    8000,
  )));
  const seen = new Set();
  const candidates = [];
  for (const search of searches) {
    for (const item of (Array.isArray(search?.results) ? search.results : [])) {
      if (!item?.id || seen.has(item.id)) continue;
      if (!PUBLIC_ITEM_TYPE_RE.test(String(item?.type || ''))) continue;
      if (isExcludedName(item?.title)) continue;
      const context = `${item?.title || ''} ${item?.tags || ''} ${item?.description || ''}`;
      // Accept an explicit parcel/cadastral item, OR a county-branded map/viewer
      // ("Richland County Public Web Map", "York County Property Viewer") whose
      // parcel layer is nested inside. The point-probe still decides.
      const countyMapItem = new RegExp(`${county}\\s+county`, 'i').test(context)
        && /\b(map|viewer|gis|explorer|portal|one\s*map)\b/i.test(context);
      if (!isParcelName(context) && !countyMapItem) continue;
      seen.add(item.id);
      candidates.push(item);
    }
  }

  // Rank SC-affine items first so out-of-state namesakes never consume the
  // candidate budget ahead of the county's real layer.
  candidates.sort((a, b) =>
    stateAffinity(`${b?.title || ''} ${b?.description || ''} ${b?.url || ''} ${b?.owner || ''}`)
    - stateAffinity(`${a?.title || ''} ${a?.description || ''} ${a?.url || ''} ${a?.owner || ''}`));

  const verified = await Promise.all(candidates.slice(0, 30).map(async (searchItem) => {
    const item = await request(`${PUBLIC_ARCGIS_ROOT}/content/items/${searchItem.id}?f=json`, fetcher) || searchItem;
    const orgId = item?.orgId || searchItem?.orgId;
    const portal = orgId ? await request(`${PUBLIC_ARCGIS_ROOT}/portals/${orgId}?f=json`, fetcher) : null;
    const owner = compactName(item?.owner || searchItem?.owner || '');
    const organization = compactName(`${portal?.name || ''} ${portal?.urlKey || ''} ${portal?.description || ''}`);
    let host = '';
    try { host = new URL(item?.url || searchItem?.url || '').hostname.toLowerCase(); } catch { /* no direct URL */ }
    const hostToken = compactName(host);
    // Accept when the county name appears in the publisher (item owner or the
    // ArcGIS org), OR the service is hosted on a government domain. Recall
    // matters here because the point-probe below is the real guard: a layer is
    // only used if it returns a parcel-shaped record at the exact coordinate.
    const publisherMatches = owner.includes(countyToken) || organization.includes(countyToken) || hostToken.includes(countyToken);
    const governmentHost = /\.(gov|us)$/.test(host);
    return (publisherMatches || governmentHost) && ITEM_ID_RE.test(String(searchItem?.id)) ? searchItem.id : null;
  }));
  return dedupe(verified.filter(Boolean));
}

/** Expand catalog items into service URLs, FOLLOWING nested item references.
 *  Counties usually publish a Web Map or Web Experience ("Property Viewer",
 *  "Parcel Mapping") rather than a bare feature service, and the parcel layer
 *  lives one or two items deeper — a single-pass expansion misses them. */
async function servicesFromItems(itemIds, fetcher) {
  const services = [];
  const seen = new Set();
  let pending = [...itemIds];
  for (let depth = 0; depth < 3 && pending.length; depth++) {
    const batch = pending.filter((id) => !seen.has(id)).slice(0, 15);
    pending = pending.slice(batch.length);
    batch.forEach((id) => seen.add(id));
    const inspections = await Promise.all(batch.map(async (id) => {
      const [item, data] = await Promise.all([
        request(`${PUBLIC_ARCGIS_ROOT}/content/items/${id}?f=json`, fetcher),
        request(`${PUBLIC_ARCGIS_ROOT}/content/items/${id}/data?f=json`, fetcher),
      ]);
      const strings = stringsInObject([item, data]);
      const urls = strings.flatMap((value) => value.match(SERVICE_URL_RE) || []).map(cleanServiceUrl);
      const nestedIds = dedupe(strings.filter((value) => ITEM_ID_RE.test(value)))
        .filter((nested) => !seen.has(nested))
        .slice(0, 12);
      return { urls: dedupe([cleanServiceUrl(item?.url), ...urls]), nestedIds };
    }));
    for (const result of inspections) {
      services.push(...result.urls);
      pending.push(...result.nestedIds);
    }
    // Stop early once a parcel-looking service has surfaced.
    if (services.some((url) => isParcelName(url))) break;
  }
  return dedupe(services);
}

// County names like Union, Richland, York and Charleston exist in several
// states, so the catalog returns confident-looking decoys ("Union County NJ
// Parcels", Richland WI, York VA). A point query against those services simply
// returns nothing, so they cannot produce wrong data — but they must not crowd
// out the real SC service before it is probed, hence the ranking penalty.
const OTHER_STATE_RE = /\b(nj|new jersey|wi|wisconsin|va|virginia|pa|pennsylvania|nc|north carolina|ny|new york|ga|georgia|fl|florida|oh|ohio|il|illinois|tx|texas|mo|missouri|ky|kentucky|tn|tennessee|in|indiana|ia|iowa|ne|nebraska|nd|north dakota|sd|south dakota|mt|montana|az|arizona|or|oregon|wa|washington|me|maine)\b/i;
const SC_RE = /\b(sc|south carolina)\b/i;

function stateAffinity(text) {
  const value = String(text || '');
  if (SC_RE.test(value)) return 4;
  if (OTHER_STATE_RE.test(value)) return -6;
  return 0;
}

function scoreService(url, countyToken) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (/(?:\.gov|\.us)$/.test(host) ? 5 : 0)
      + (compactName(host).includes(countyToken) ? 4 : 0)
      + (isParcelName(parsed.pathname) ? 3 : 0)
      + (/FeatureServer/i.test(parsed.pathname) ? 1 : 0)
      + stateAffinity(`${host} ${parsed.pathname}`)
      - (host === 'utility.arcgis.com' ? 3 : 0);
  } catch { return 0; }
}

/** Does this attribute bag actually look like a parcel record? */
function parcelAttributeScore(attributes) {
  const keys = Object.keys(attributes || {});
  if (!keys.length) return 0;
  const hasValue = (re) => keys.some((k) => re.test(k) && String(attributes[k] ?? '').trim() !== '');
  return (hasValue(PARCEL_ID_KEY_RE) ? 2 : 0)
    + (hasValue(OWNER_KEY_RE) ? 2 : 0)
    + (hasValue(ACRE_KEY_RE) ? 1 : 0)
    + (hasValue(ADDRESS_KEY_RE) ? 1 : 0);
}

/** Candidate layer ids inside one service that plausibly hold parcels. */
async function parcelLayerIds(serviceUrl, fetcher) {
  const meta = await request(`${serviceUrl}?f=json`, fetcher);
  const layers = [
    ...(Array.isArray(meta?.layers) ? meta.layers : []),
    ...(Array.isArray(meta?.tables) ? meta.tables : []),
  ];
  const named = layers
    .filter((layer) => isParcelName(layer?.name) && !isExcludedName(layer?.name))
    .map((layer) => layer.id);
  if (named.length) return named.slice(0, 5);
  // A FeatureServer often exposes a single unnamed parcel layer at 0.
  return layers.length ? [layers[0].id] : [0];
}

/** Query one layer at the point and keep it only if it returns a parcel record. */
async function probeLayer(serviceUrl, layerId, lng, lat, fetcher) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'json',
  });
  const data = await request(`${serviceUrl}/${layerId}/query?${params}`, fetcher, 8000);
  const feature = data?.features?.[0];
  if (!feature?.attributes) return null;
  const score = parcelAttributeScore(feature.attributes);
  if (score < 2) return null; // not parcel-shaped — reject rather than guess
  return {
    serviceUrl,
    layerId,
    score,
    attributes: feature.attributes,
    rings: feature.geometry?.rings || null,
  };
}

/**
 * Find the county's official parcel record at a point. Returns null when nothing
 * verifiable is found — callers must treat that as "unavailable", never invent.
 */
export async function discoverScParcelAtPoint(county, lng, lat, fetcher = fetch) {
  const countyName = String(county || '').replace(/,\s*SC$/i, '').replace(/\s+County$/i, '').trim();
  if (!countyName || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const countyToken = compactName(countyName);

  const itemIds = await verifiedParcelItemIds(countyName, fetcher);
  if (!itemIds.length) return null;
  const services = (await servicesFromItems(itemIds, fetcher))
    .sort((a, b) => scoreService(b, countyToken) - scoreService(a, countyToken))
    .slice(0, 14);
  if (!services.length) return null;

  // Probe services in rank order and keep the richest parcel hit. Scanning
  // continues past a bare geometry-only match so a layer that actually carries
  // the OWNER wins over one that only has a PIN.
  let best = null;
  for (const serviceUrl of services) {
    const layerIds = await parcelLayerIds(serviceUrl, fetcher);
    const probes = await Promise.all(layerIds.map((id) => probeLayer(serviceUrl, id, lng, lat, fetcher).catch(() => null)));
    for (const hit of probes) {
      if (hit && (!best || hit.score > best.score)) best = hit;
    }
    if (best && best.score >= 5) break; // owner + id + acres/address: good enough
  }
  return best;
}

export const __testables = { parcelAttributeScore, scoreService, isParcelName, isExcludedName, cleanServiceUrl };
