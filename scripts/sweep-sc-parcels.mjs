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

// ---------------------------------------------------------------------------
// HOST SEEDING FROM SEARCH
// Guessing hostnames from the county name only finds the counties that happen
// to follow a common pattern; it found none of the smaller ones. Searching for
// each county's actual GIS site supplies the real hosts to crawl.
// ---------------------------------------------------------------------------

const PERPLEXITY_KEY = (() => {
  try {
    const env = readFileSync(join(root, '.env.local'), 'utf8');
    return (env.match(/^VITE_PERPLEXITY_API_KEY=(.+)$/m) || [])[1]?.trim() || '';
  } catch { return ''; }
})();

/** Parcel aggregators and listing sites are never an authoritative county source. */
const AGGREGATOR_RE = /zillow|realtor|redfin|trulia|netronline|publicrecords|propertyshark|landwatch|land\.com|loopnet|county-?taxes\.net|usgs|wikipedia|facebook|linkedin|youtube/i;

function officialCountyHost(hostname, countyName) {
  const host = hostname.toLowerCase();
  if (AGGREGATOR_RE.test(host)) return false;
  const token = countyName.toLowerCase().replace(/[^a-z]/g, '');
  const compactHost = host.replace(/[^a-z0-9]/g, '');
  // Either the host names the county, or it is a public-sector domain.
  return compactHost.includes(token) || /\.(gov|us)$/.test(host);
}

async function searchHosts(countyName) {
  if (!PERPLEXITY_KEY) return { roots: [], services: [] };
  const queries = [
    `${countyName} County SC GIS parcel map`,
    `${countyName} County South Carolina property viewer assessor GIS`,
    `${countyName} County SC ArcGIS REST services parcels`,
    `${countyName} County South Carolina open data parcels download`,
  ];
  const res = await fetch('https://api.perplexity.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PERPLEXITY_KEY}` },
    body: JSON.stringify({ query: queries, max_results: 10, max_tokens_per_page: 800, country: 'US' }),
    signal: AbortSignal.timeout(60000),
  }).catch(() => null);
  if (!res?.ok) return { roots: [], services: [] };
  const j = await res.json();
  const groups = Array.isArray(j.results) && j.results[0]?.results ? j.results.map((g) => g.results) : [j.results || []];
  const rows = [];
  for (const g of groups) for (const r of g || []) rows.push(r);

  const roots = new Set();
  const services = new Set();
  // The official county pages themselves — the viewer miner starts from these.
  const pages = new Set();
  for (const r of rows) {
    try { if (officialCountyHost(new URL(r.url).hostname, countyName)) pages.add(r.url); } catch { /* skip */ }
  }
  for (const r of rows) {
    const text = `${r.url || ''} ${r.snippet || r.content || ''}`;
    // A REST endpoint quoted anywhere in the page text is the strongest signal.
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+?\/(?:MapServer|FeatureServer)\b/gi)) {
      const u = m[0];
      try { if (officialCountyHost(new URL(u).hostname, countyName)) services.add(u); } catch { /* skip */ }
    }
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+?\/(?:arcgis|server|hosting|agstserver|gisweb|portal)\/rest\/services/gi)) {
      const u = m[0];
      try { if (officialCountyHost(new URL(u).hostname, countyName)) roots.add(u); } catch { /* skip */ }
    }
    // Derive REST roots from any official county host the search surfaced.
    try {
      const host = new URL(r.url).hostname;
      if (!officialCountyHost(host, countyName)) continue;
      for (const path of ['/arcgis/rest/services', '/server/rest/services', '/hosting/rest/services', '/agstserver/rest/services', '/gisweb/rest/services', '/portal/rest/services']) {
        roots.add(`https://${host}${path}`);
      }
    } catch { /* not a url */ }
  }
  return { roots: [...roots], services: [...services], pages: [...pages] };
}

// ---------------------------------------------------------------------------
// VIEWER MINING (spec section 10)
// Most remaining counties expose no browsable REST directory — the service is
// only referenced inside their map viewer. Fetching the county GIS page,
// following it to the viewer, and reading the viewer's config recovers the
// endpoint. This is how Orangeburg was found for the existing manifest.
// ---------------------------------------------------------------------------

const ITEM_ID_RE = /[a-f0-9]{32}/i;

async function fetchText(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; parcel-discovery/1.0)' },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch { return ''; }
}

/** Pull every service URL, ArcGIS item id and viewer link out of a page. */
function minePage(html, baseUrl) {
  const services = new Set();
  const itemIds = new Set();
  const links = new Set();
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>)\\]+?\/(?:MapServer|FeatureServer)(?:\/\d+)?/gi)) {
    services.add(m[0].replace(/\/\d+$/, ''));
  }
  for (const m of html.matchAll(/(?:id|webmap|itemId|appid)["'=:\s]+([a-f0-9]{32})/gi)) itemIds.add(m[1]);
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1];
    if (!/gis|map|parcel|property|viewer|arcgis/i.test(href)) continue;
    try { links.add(new URL(href, baseUrl).toString()); } catch { /* skip */ }
  }
  return { services: [...services], itemIds: [...itemIds], links: [...links] };
}

/** Resolve an ArcGIS Online item (web map or app) into its operational layers. */
async function servicesFromItem(itemId) {
  const out = new Set();
  const data = await getJson(`${AGOL}/content/items/${itemId}/data?f=json`, 12000);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.url === 'string' && /\/(?:MapServer|FeatureServer)/i.test(node.url)) {
      out.add(node.url.replace(/\/\d+$/, ''));
    }
    if (typeof node.itemId === 'string' && ITEM_ID_RE.test(node.itemId)) out.add(`item:${node.itemId}`);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(data);
  // An app config points at a web map; follow it one level.
  for (const entry of [...out]) {
    if (!entry.startsWith('item:')) continue;
    out.delete(entry);
    const nested = await getJson(`${AGOL}/content/items/${entry.slice(5)}/data?f=json`, 12000);
    walk(nested);
  }
  const item = await getJson(`${AGOL}/content/items/${itemId}?f=json`, 10000);
  if (item?.url && /\/(?:MapServer|FeatureServer)/i.test(item.url)) out.add(item.url.replace(/\/\d+$/, ''));
  return [...out].filter((u) => !u.startsWith('item:'));
}

/** Follow a county's GIS pages into its viewer and mine the config files. */
async function mineCountyViewers(countyName, seedUrls) {
  const found = new Set();
  const visited = new Set();
  let frontier = seedUrls.slice(0, 6);

  for (let depth = 0; depth < 2 && frontier.length; depth += 1) {
    const next = new Set();
    const pages = await pooled(frontier.slice(0, 8), async (url) => {
      if (visited.has(url)) return null;
      visited.add(url);
      const html = await fetchText(url);
      return html ? { url, mined: minePage(html, url) } : null;
    }, 4);

    for (const page of pages.filter(Boolean)) {
      for (const s of page.mined.services) {
        try { if (officialCountyHost(new URL(s).hostname, countyName)) found.add(s); } catch { /* skip */ }
      }
      for (const id of page.mined.itemIds.slice(0, 4)) {
        for (const s of await servicesFromItem(id)) found.add(s);
      }
      for (const link of page.mined.links.slice(0, 6)) next.add(link);
    }
    frontier = [...next];
  }

  // Viewer apps keep their layer list in a sidecar config file.
  const configs = [...visited].slice(0, 4).flatMap((u) => {
    const base = u.replace(/\/[^/]*$/, '');
    return ['config.json', 'appconfig.json', 'env.js', 'runtime-config.json'].map((f) => `${base}/${f}`);
  });
  const configTexts = await pooled(configs, (u) => fetchText(u, 8000), 4);
  for (const text of configTexts) {
    if (!text) continue;
    for (const s of minePage(text, '').services) {
      try { if (officialCountyHost(new URL(s).hostname, countyName)) found.add(s); } catch { /* skip */ }
    }
  }
  return [...found];
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
  // Real hosts from search first — pattern-guessed hostnames only find counties
  // that happen to follow a common naming convention and found none of the
  // smaller ones. Then the guessed patterns, then the Esri catalog.
  const seeded = await searchHosts(name);
  const roots = [...new Set([...seeded.roots, ...hostCandidates(name)])];
  const crawled = (await pooled(roots, async (r) => crawlArcGisDirectory(r), 6)).flat();
  const fromAgol = await agolServices(name);
  const direct = seeded.services.map((u) => u.replace(/\/\d+$/, ''));
  // Section 10: when no REST directory is browsable, mine the county's own GIS
  // pages and viewer configs. Only runs if the cheaper routes found nothing.
  let mined = [];
  const cheap = [...new Set([...direct, ...crawled, ...fromAgol])].filter((u) => PARCELISH.test(u));
  if (!cheap.length) {
    mined = await mineCountyViewers(name, seeded.pages ?? []);
    if (mined.length) console.log(`    ${name}: viewer mining surfaced ${mined.length} service(s)`);
  }
  const services = [...new Set([...cheap, ...mined])].filter((u) => PARCELISH.test(u) || mined.includes(u));

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
    // Viewer mining reaches MUNICIPAL services too. Anderson resolved to
    // gis.cityofandersonsc.com with 14,121 parcels against a county of ~80,000
    // — a city subset that would silently answer "no parcel" for most of the
    // county. Record it, but never as full county coverage.
    const cityScoped = /cityof|\/city_|_city\b|city_parcels/i.test(`${hit.serviceUrl} ${hit.layerName}`);
    found += 1;
    store.counties[name] = {
      ...(cityScoped ? { scope: 'municipal-subset', scopeNote: 'Municipal service found via viewer mining — covers a city, not the whole county. Countywide layer still needed.' } : {}),
      parcel: { serviceUrl: hit.serviceUrl, layerId: hit.layerId, serviceType: /FeatureServer/i.test(hit.serviceUrl) ? 'FeatureServer' : 'MapServer' },
      layerName: hit.layerName, idField: hit.idField, ownerField: hit.ownerField,
      featureCount: hit.featureCount, sample: hit.sample,
      status: cityScoped ? 'partially-verified' : 'verified',
      verifiedAt: new Date().toISOString().slice(0, 10),
    };
    console.log(`[${done}/${targets.length}] ${name.padEnd(14)} ${cityScoped ? 'CITY' : 'OK  '} ${String(hit.featureCount).padStart(7)} parcels  id=${hit.idField} owner=${hit.ownerField || '-'}  ${hit.layerName}${cityScoped ? '  (municipal subset, not countywide)' : ''}`);
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
