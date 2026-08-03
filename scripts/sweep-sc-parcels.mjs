// SOUTH CAROLINA COUNTY PARCEL DISCOVERY + VALIDATION SWEEP
//
// Finds each county's OWN parcel service and proves it works before recording
// it. Nothing is accepted on the strength of a promising name: a candidate must
// pass metadata, count, sample and spatial tests at a real point inside that
// county, and the returned parcel must fall inside South Carolina.
//
// That last guard is not theoretical — a Washington DC service matching
// "Georgetown" passed every other check.
//
//   npm run sweep:sc-parcels -- --only Kershaw
//   npm run sweep:sc-parcels -- --limit 8 --concurrency 3
//   npm run sweep:sc-parcels -- --recheck        (re-validate existing entries)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src', 'services', 'sc', 'sc-parcel-discovery.json');

const argv = process.argv.slice(2);
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? ''); };
const has = (n) => argv.includes(`--${n}`);
const ONLY = arg('only', '');
const LIMIT = Number(arg('limit', '0')) || Infinity;
const CONCURRENCY = Number(arg('concurrency', '3')) || 3;
const RECHECK = has('recheck');

const SC_BOUNDS = { minLng: -83.4, maxLng: -78.4, minLat: 32.0, maxLat: 35.3 };
const insideSC = (lng, lat) => lng >= SC_BOUNDS.minLng && lng <= SC_BOUNDS.maxLng
  && lat >= SC_BOUNDS.minLat && lat <= SC_BOUNDS.maxLat;

async function getJson(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 1. RECURSIVE ARCGIS DIRECTORY CRAWLER
// ---------------------------------------------------------------------------

const SKIP_FOLDERS = new Set(['system', 'utilities', 'hosted']);

async function crawlArcGisDirectory(rootUrl, folder = '', depth = 0, seen = new Set()) {
  if (depth > 2) return [];
  const directoryUrl = folder ? `${rootUrl}/${encodeURIComponent(folder)}` : rootUrl;
  if (seen.has(directoryUrl)) return [];
  seen.add(directoryUrl);

  const data = await getJson(`${directoryUrl}?f=pjson`, 10000);
  if (!data) return [];

  const serviceUrls = [];
  for (const service of data.services ?? []) {
    if (!service?.name || !service?.type) continue;
    const path = String(service.name).split('/').map(encodeURIComponent).join('/');
    serviceUrls.push(`${rootUrl}/${path}/${service.type}`);
  }
  // Folders are crawled with a small concurrency cap so a county server is
  // never hit with a burst.
  const folders = (data.folders ?? []).filter((f) => !SKIP_FOLDERS.has(String(f).toLowerCase()));
  const groups = await pooled(folders.slice(0, 12), (sub) => crawlArcGisDirectory(rootUrl, sub, depth + 1, seen), 3);
  return [...new Set([...serviceUrls, ...groups.flat()])];
}

/** Hostname patterns SC counties actually use for self-hosted ArcGIS. */
function hostCandidates(countyName) {
  const slug = countyName.toLowerCase().replace(/[^a-z]/g, '');
  const domains = [
    `${slug}countysc.gov`, `${slug}countysc.org`, `${slug}county.org`,
    `${slug}countysc.net`, `${slug}county.net`, `${slug}countysc.com`,
    `co.${slug}.sc.us`, `${slug}sc.gov`, `${slug}countygov.org`,
  ];
  const hosts = domains.flatMap((d) => [`gis.${d}`, `maps.${d}`, `propertyviewer.${d}`, `gisportal.${d}`, `arcgis.${d}`, `www.${d}`]);
  const paths = ['/arcgis/rest/services', '/server/rest/services', '/hosting/rest/services', '/agstserver/rest/services', '/gisweb/rest/services', '/portal/rest/services'];
  return hosts.flatMap((h) => paths.map((p) => `https://${h}${p}`));
}

/** ArcGIS Online catalog, publisher-checked, for counties hosting on Esri. */
const AGOL = 'https://www.arcgis.com/sharing/rest';
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function agolServices(countyName) {
  const q = encodeURIComponent(`"${countyName} County" AND (parcels OR parcel OR "tax parcel") AND "South Carolina"`);
  const search = await getJson(`${AGOL}/search?f=json&num=25&q=${q}`);
  const token = compact(countyName);
  const urls = [];
  for (const item of search?.results ?? []) {
    const type = String(item?.type || '');
    if (!/Feature Service|Map Service/i.test(type)) continue;
    const context = compact(`${item.title} ${item.snippet} ${(item.tags || []).join(' ')}`);
    // Publisher check: the item must actually name this county somewhere.
    if (!context.includes(token)) continue;
    if (item.url) urls.push(String(item.url));
  }
  // Web maps often point at the real service even when the layer is not indexed.
  const webmaps = await getJson(`${AGOL}/search?f=json&num=10&q=${encodeURIComponent(`"${countyName} County" South Carolina parcels`)}&filter=${encodeURIComponent('type:"Web Map"')}`);
  for (const item of (webmaps?.results ?? []).slice(0, 5)) {
    const data = await getJson(`${AGOL}/content/items/${item.id}/data?f=json`);
    for (const layer of data?.operationalLayers ?? []) {
      if (layer?.url) urls.push(String(layer.url).replace(/\/\d+$/, ''));
    }
  }
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------
// 2. PARCEL LAYER SCORING
// ---------------------------------------------------------------------------

const NEGATIVE_TERMS = ['archive', 'archived', 'historic', 'old', 'backup', 'test', 'development', 'sample', 'draft'];

function scoreParcelCandidate({ serviceName = '', layerName = '', geometryType, capabilities, fields = [] }) {
  const text = [serviceName, layerName, ...fields.flatMap((f) => [f.name, f.alias ?? ''])].join(' ').toLowerCase();
  let score = 0;
  if (text.includes('tax parcel')) score += 150;
  if (text.includes('parcels')) score += 120;
  if (text.includes('parcel')) score += 100;
  if (text.includes('cadastral')) score += 90;
  if (/\btms\b/.test(text)) score += 45;
  if (text.includes('assessor')) score += 35;
  if (text.includes('property')) score += 25;
  if (geometryType === 'esriGeometryPolygon') score += 50;
  if (String(capabilities || '').toLowerCase().includes('query')) score += 40;
  for (const term of NEGATIVE_TERMS) if (text.includes(term)) score -= 80;
  return score;
}

// ---------------------------------------------------------------------------
// 3. VALIDATION — metadata, count, sample, spatial
// ---------------------------------------------------------------------------

// Widened against real SC layers: Charleston's identifier is PID, which a
// pin|parcel_id pattern silently misses — the layer then looked unusable even
// though it holds 197k parcels.
const ID_RE = /^(tms|pid|pin|parcel_?(id|no|num)|parcelid|parcelno|taxmapid|tax_?map|taxmap|map_?(number|no)|account)/i;
const OWNER_RE = /^(owner|owner_?name|owner1|ownernme1|ownername|taxpayer|grantee)/i;

async function validateLayer(serviceUrl, layerId, point) {
  const out = { serviceUrl, layerId, ok: false, reason: '' };

  // (a) metadata
  const meta = await getJson(`${serviceUrl}/${layerId}?f=pjson`);
  if (!meta || meta.error) { out.reason = `metadata ${meta?.error?.message || 'unreachable'}`; return out; }
  if (meta.type && meta.type !== 'Feature Layer') { out.reason = `type=${meta.type}`; return out; }
  if (meta.geometryType !== 'esriGeometryPolygon') { out.reason = `geometry=${meta.geometryType}`; return out; }
  if (!/query/i.test(meta.capabilities || '')) { out.reason = 'no query capability'; return out; }
  const fields = (meta.fields || []).map((f) => ({ name: String(f.name), alias: String(f.alias || '') }));
  if (!fields.length) { out.reason = 'no fields'; return out; }
  out.layerName = meta.name || '';
  out.fields = fields.map((f) => f.name);
  out.idField = out.fields.find((f) => ID_RE.test(f)) || null;
  out.ownerField = out.fields.find((f) => OWNER_RE.test(f)) || null;
  out.score = scoreParcelCandidate({ serviceName: serviceUrl, layerName: out.layerName, geometryType: meta.geometryType, capabilities: meta.capabilities, fields });

  // (b) count — an empty layer is not a parcel source
  const count = await getJson(`${serviceUrl}/${layerId}/query?where=1%3D1&returnCountOnly=true&f=json`);
  const n = count?.count;
  if (!Number.isFinite(n) || n <= 0) { out.reason = `count=${n ?? 'none'}`; return out; }
  out.featureCount = n;

  // (c) sample — attributes must actually carry a parcel identifier
  const sample = await getJson(`${serviceUrl}/${layerId}/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=3&f=json`);
  const first = sample?.features?.[0]?.attributes;
  if (!first) { out.reason = 'sample returned nothing'; return out; }
  if (!out.idField) { out.reason = 'no parcel-id field'; return out; }

  // (d) spatial — a real point inside the county must return a polygon, and
  // that polygon must sit inside South Carolina.
  // A county centroid can land on a road, a lake or an unmapped gap, so a single
  // miss is not proof the layer is unusable — try a few nearby points first.
  const OFFSETS = [[0, 0], [0.02, 0.02], [-0.02, -0.02], [0.05, -0.03], [-0.05, 0.03]];
  let feature = null;
  for (const [dLng, dLat] of OFFSETS) {
    const p = new URLSearchParams({
      f: 'json', geometry: `${point.lng + dLng},${point.lat + dLat}`, geometryType: 'esriGeometryPoint',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*',
      returnGeometry: 'true', outSR: '4326', resultRecordCount: '1',
    });
    const hit = await getJson(`${serviceUrl}/${layerId}/query?${p}`, 15000);
    feature = hit?.features?.[0] ?? null;
    if (feature) { point = { lng: point.lng + dLng, lat: point.lat + dLat }; break; }
  }
  if (!feature) { out.reason = 'no parcel at the county point or nearby'; return out; }
  const ring = feature.geometry?.rings?.[0]?.[0];
  if (Array.isArray(ring) && !insideSC(ring[0], ring[1])) {
    out.reason = `parcel outside SC (${ring[0].toFixed(2)},${ring[1].toFixed(2)}) — another state's namesake county`;
    return out;
  }
  out.ok = true;
  out.sample = {
    lng: point.lng, lat: point.lat,
    parcelId: String(feature.attributes?.[out.idField] ?? '').trim() || null,
    owner: out.ownerField ? String(feature.attributes?.[out.ownerField] ?? '').trim() || null : null,
  };
  return out;
}

// ---------------------------------------------------------------------------
// county points + orchestration
// ---------------------------------------------------------------------------

const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';

async function scCountyPoints() {
  const params = new URLSearchParams({
    where: "STATE='45'", outFields: 'BASENAME,CENTLAT,CENTLON', returnGeometry: 'false', f: 'json',
  });
  const data = await getJson(`${TIGER}/State_County/MapServer/1/query?${params}`, 25000);
  const out = {};
  for (const f of data?.features ?? []) {
    const name = String(f.attributes.BASENAME || '').trim();
    const lat = Number(f.attributes.CENTLAT);
    const lng = Number(f.attributes.CENTLON);
    if (name && Number.isFinite(lat) && Number.isFinite(lng)) out[name] = { lng, lat };
  }
  return out;
}

async function pooled(items, worker, concurrency) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) results.push(await worker(queue.shift()));
  }));
  return results;
}

const PARCELISH = /parcel|cadastr|tax|property|assessor|landrecord/i;

async function discoverCounty(name, point) {
  // Known-good hosts first, then the catalog. Cheap probes before expensive.
  const roots = hostCandidates(name);
  const crawled = (await pooled(roots, async (r) => crawlArcGisDirectory(r), 6)).flat();
  const fromAgol = await agolServices(name);
  const services = [...new Set([...crawled, ...fromAgol])].filter((u) => PARCELISH.test(u));

  const ranked = services
    .map((u) => ({ u, s: scoreParcelCandidate({ serviceName: u }) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map(({ u }) => u);

  for (const serviceUrl of ranked) {
    const meta = await getJson(`${serviceUrl}?f=pjson`, 10000);
    if (!meta || meta.error) continue;
    const layers = (meta.layers ?? []).filter((l) => Number.isInteger(l?.id) && PARCELISH.test(String(l.name || '')));
    const ordered = layers
      .map((l) => ({ l, s: scoreParcelCandidate({ serviceName: serviceUrl, layerName: String(l.name || '') }) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6);
    for (const { l } of ordered) {
      const result = await validateLayer(serviceUrl, l.id, point);
      if (result.ok) return result;
    }
    // FeatureServers often expose layer 0 without listing a parcel-ish name.
    if (!layers.length) {
      const result = await validateLayer(serviceUrl, 0, point);
      if (result.ok) return result;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

const NEEDS = ['Abbeville', 'Aiken', 'Allendale', 'Anderson', 'Bamberg', 'Barnwell',
  'Cherokee', 'Chester', 'Chesterfield', 'Clarendon', 'Dillon', 'Edgefield',
  'Fairfield', 'Greenwood', 'Kershaw', 'Marion', 'Marlboro', 'McCormick',
  'Newberry', 'Sumter', 'Union', 'Williamsburg'];

const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { generated: null, counties: {} };
const points = await scCountyPoints();
if (!Object.keys(points).length) { console.error('Could not load SC county points from the Census.'); process.exit(1); }

const targets = NEEDS
  .filter((n) => (ONLY ? n.toLowerCase() === ONLY.toLowerCase() : true))
  .filter((n) => RECHECK || !store.counties[n]?.parcel)
  .slice(0, LIMIT);

console.log(`SC parcel sweep: ${targets.length} counties\n`);
let found = 0;
let done = 0;

await pooled(targets, async (name) => {
  const point = points[name];
  if (!point) { console.log(`${name.padEnd(14)} no Census point`); return; }
  const hit = await discoverCounty(name, point).catch(() => null);
  done += 1;
  if (hit) {
    found += 1;
    store.counties[name] = {
      parcel: { serviceUrl: hit.serviceUrl, layerId: hit.layerId, serviceType: /FeatureServer/i.test(hit.serviceUrl) ? 'FeatureServer' : 'MapServer' },
      layerName: hit.layerName, idField: hit.idField, ownerField: hit.ownerField,
      featureCount: hit.featureCount, sample: hit.sample,
      status: 'verified', verifiedAt: new Date().toISOString().slice(0, 10),
    };
    console.log(`[${done}/${targets.length}] ${name.padEnd(14)} OK  ${String(hit.featureCount).padStart(7)} parcels  id=${hit.idField} owner=${hit.ownerField || '-'}  ${hit.layerName}`);
  } else {
    store.counties[name] = { ...(store.counties[name] || {}), status: 'not-found', checkedAt: new Date().toISOString().slice(0, 10) };
    console.log(`[${done}/${targets.length}] ${name.padEnd(14)} —   no verifiable public parcel layer`);
  }
  store.generated = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(store, null, 2)}\n`);
}, CONCURRENCY);

const verified = Object.values(store.counties).filter((c) => c.parcel).length;
console.log(`\nverified this run: ${found}/${targets.length}   ·   total in discovery file: ${verified}`);
console.log(`written to ${OUT}`);
