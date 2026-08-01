// COUNTY GIS ZONING LAYER SWEEP
//
// Only 16 of 100 NC counties had a registered zoning layer; the other 84 fell
// through to Gemini web research, which is why zoning was inconsistent. This
// sweep discovers each county's (and each municipality's) OFFICIAL zoning layer
// and verifies it with a live point query before recording it.
//
// Verification is the point. A discovered service is not accepted because its
// name looks right — it must return a real district code at a real point inside
// that jurisdiction, and its extent must overlap the jurisdiction. Anything
// unverified is left out, so the app keeps its honest "no official layer" path
// rather than pointing at a service that does not actually answer.
//
// RESUMABLE: results are merged into the manifest on every batch, so the sweep
// can be run repeatedly (or interrupted) without losing work or repeating
// jurisdictions that already verified.
//
//   npm run zoning:sweep -- --state NC --limit 20
//   npm run zoning:sweep -- --state SC --municipalities
//   npm run zoning:sweep -- --recheck        (re-verify existing entries)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverOfficialMunicipalServices,
  serviceLayers,
  candidateField,
  zoningFromAttributes,
  isBaseZoningName,
} from '../netlify/functions/lib/sc-zoning-discovery.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(root, 'src', 'data', 'zoning-layer-manifest.json');

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? '');
};
const has = (name) => argv.includes(`--${name}`);
const STATE = (arg('state', 'NC') || 'NC').toUpperCase();
const LIMIT = Number(arg('limit', '0')) || Infinity;
const ONLY = arg('only', '');
const DO_MUNICIPALITIES = has('municipalities');
const RECHECK = has('recheck');
const CONCURRENCY = Number(arg('concurrency', '4')) || 4;

// --- census helpers ---------------------------------------------------------
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const STATE_FIPS = { NC: '37', SC: '45' };

async function getJson(url, timeoutMs = 20000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Counties with an interior point, straight from the Census — no hand-kept
 *  coordinate table to drift out of date. */
async function censusCounties(stateCode) {
  const params = new URLSearchParams({
    where: `STATE='${STATE_FIPS[stateCode]}'`,
    outFields: 'NAME,STATE,COUNTY,CENTLAT,CENTLON,BASENAME',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await getJson(`${TIGER}/State_County/MapServer/1/query?${params}`);
  return (data?.features || []).map((f) => ({
    name: String(f.attributes.BASENAME || f.attributes.NAME || '').replace(/\s+County$/i, ''),
    lat: Number(f.attributes.CENTLAT),
    lng: Number(f.attributes.CENTLON),
    countyFips: String(f.attributes.COUNTY || ''),
  })).filter((c) => c.name && Number.isFinite(c.lat) && Number.isFinite(c.lng));
}

/** Incorporated places, with an interior point, for municipal zoning layers. */
async function censusPlaces(stateCode) {
  const params = new URLSearchParams({
    where: `STATE='${STATE_FIPS[stateCode]}'`,
    outFields: 'BASENAME,NAME,CENTLAT,CENTLON',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await getJson(`${TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/0/query?${params}`, 40000);
  return (data?.features || []).map((f) => ({
    name: String(f.attributes.BASENAME || '').trim(),
    lat: Number(f.attributes.CENTLAT),
    lng: Number(f.attributes.CENTLON),
  })).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

// --- verification -----------------------------------------------------------

/** A bare published code — same rule the runtime normalizer uses. */
const isBareCode = (v) => /^[A-Z0-9]{1,6}(?:[-/.][A-Z0-9]{1,6}){0,3}$/.test(String(v || '').trim())
  && /[A-Z]/.test(String(v || ''));

const ZONING_KEYISH = /zon|zone|district|dist|class|type|code|category/i;
const NON_CODE_KEY = /date|objectid|globalid|_id$|shape|url|link|area|acre|status|user|source|effective/i;

/** Values that are code-SHAPED but mean "nothing here". Without this the sweep
 *  records Henderson as "NO" and Burke as "Base District: None & Overlays:
 *  RD-O" — a manifest entry that is worse than no entry, because the app would
 *  trust it over the honest fallback. */
const PLACEHOLDER_CODE = /^(no|none|n\/?a|null|yes|tbd|unknown|unzoned|not zoned|city|county|etj|blank|other|various|see map)$/i;

function acceptableCode(value) {
  const s = String(value || '').trim();
  if (!s || PLACEHOLDER_CODE.test(s)) return false;
  // Must be a bare published code, not a sentence describing one.
  return isBareCode(s);
}

/** Is `code` an abbreviation of `name`? "STVL" of "STATESVILLE", "TROUTM" of
 *  "TROUTMAN" — i.e. its letters appear in order within the name. */
function isAbbreviationOf(code, name) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
  const n = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length < 4 || !n) return false; // 2-3 char codes are usually real districts
  let i = 0;
  for (const ch of n) if (ch === c[i]) i += 1;
  return i === c.length;
}

/**
 * A county layer often stores the MUNICIPALITY as the zoning value for parcels
 * inside a town — Iredell's county layer says ZONING "STVL" with JURISDIC
 * "STATESVILLE", meaning "this parcel is Statesville's, see their layer", where
 * the real district is CB. That placeholder is bare-code shaped, so it passes
 * every other check and would be displayed as the zoning code.
 */
function isJurisdictionPlaceholder(code, attributes) {
  for (const [key, raw] of Object.entries(attributes || {})) {
    // True jurisdiction columns only — not ZDISPLAY, which holds the zoning
    // code's display form on municipal layers.
    if (!/jurisdic|jurisdiction|municipal(?:ity)?|^city$|_city$|^town$|_town$|place_?name/i.test(key)) continue;
    if (isAbbreviationOf(code, raw)) return true;
    // Also reject when the value simply IS the jurisdiction name.
    if (String(code).toUpperCase().trim() === String(raw ?? '').toUpperCase().trim()) return true;
  }
  return false;
}

/**
 * Some layers put the district NAME in the column that looks like the code and
 * the code somewhere else — Charlotte's `zoneclass` holds "UPTOWN MIXED USE"
 * while `zonedes` holds "UC". Field NAMES cannot be trusted, so when the chosen
 * field yields something that is not code-shaped, scan the attributes for a
 * value that is. Mirrors the runtime value-shape rule, so the manifest records
 * the field the app will actually read.
 */
function bestCodeField(attributes, preferred) {
  if (isBareCode(attributes?.[preferred])) return preferred;
  for (const [key, raw] of Object.entries(attributes || {})) {
    if (!ZONING_KEYISH.test(key) || NON_CODE_KEY.test(key)) continue;
    if (isBareCode(raw)) return key;
  }
  return preferred;
}

/** Query a layer at a point and return the district, or null. Uses the same
 *  field-detection the runtime uses, so a layer that verifies here behaves the
 *  same in the app. */
async function districtAtPoint(layer, lng, lat) {
  const field = candidateField(layer.fields);
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: '1=1',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await getJson(`${layer.url}/query?${params}`);
  for (const feature of data?.features || []) {
    const attributes = feature?.attributes;
    const corrected = bestCodeField(attributes, field);
    const hit = zoningFromAttributes(attributes, corrected);
    if (hit?.code && acceptableCode(hit.code) && !isJurisdictionPlaceholder(hit.code, attributes)) {
      return { code: hit.code, description: hit.description || null, field: corrected || null };
    }
  }
  return null;
}

/**
 * Services we already know about, straight from the app's own config. The
 * ArcGIS.com catalog only indexes ArcGIS ONLINE items, so it cannot see a
 * self-hosted county server — Guilford and Gaston both run their own and were
 * invisible to catalog-only discovery even though they work today. Seeding from
 * config means the sweep can never "lose" a county that already resolves.
 */
function configuredServices(countyName) {
  const key = countyName.toLowerCase().replace(/[^a-z]/g, '_');
  const src = readFileSync(join(root, 'src', 'data', 'ncZoning.ts'), 'utf8');
  const row = new RegExp(`^\\s{4}${key}:\\s*\\{([^}]*)\\}`, 'm').exec(src);
  if (!row) return [];
  return [...row[1].matchAll(/"(https:\/\/[^"]+(?:MapServer|FeatureServer))"/g)].map((m) => m[1]);
}

/**
 * County GIS is very often self-hosted on a predictable hostname. Probing these
 * finds the servers the catalog misses, at the cost of a few cheap 404s.
 */
function hostCandidates(countyName, stateCode) {
  const slug = countyName.toLowerCase().replace(/[^a-z]/g, '');
  const st = stateCode.toLowerCase();
  const hosts = [
    `gis.${slug}county${st}.gov`,
    `maps.${slug}county${st}.gov`,
    `gis.${slug}countync.gov`,
    `gis.${slug}county.org`,
    `gis.${slug}county.us`,
    `maps.${slug}county.us`,
    `gis.co.${slug}.${st}.us`,
    `maps.co.${slug}.${st}.us`,
  ];
  const paths = ['/arcgis/rest/services', '/publicgis/rest/services', '/server/rest/services', '/arcgisservices/rest/services'];
  return hosts.flatMap((host) => paths.map((path) => `https://${host}${path}`));
}

/** Expand a services ROOT into the zoning services it contains. */
async function servicesUnderRoot(rootUrl) {
  const meta = await getJson(`${rootUrl}?f=json`, 8000);
  if (!meta) return [];
  const direct = (meta.services || [])
    .filter((s) => isBaseZoningName(s?.name || ''))
    .map((s) => `${rootUrl}/${String(s.name).split('/').pop()}/${s.type}`);
  const folders = await Promise.all((meta.folders || [])
    .filter((f) => isBaseZoningName(f) || /plan|land|develop/i.test(f))
    .slice(0, 4)
    .map(async (folder) => {
      const sub = await getJson(`${rootUrl}/${folder}?f=json`, 8000);
      return (sub?.services || [])
        .filter((s) => isBaseZoningName(s?.name || ''))
        .map((s) => `${rootUrl}/${String(s.name).split('/').pop()}/${s.type}`);
    }));
  return [...direct, ...folders.flat()];
}

async function verifyJurisdiction({ jurisdiction, county, lng, lat, kind, extraPoints = [] }) {
  const seeded = kind === 'county' ? configuredServices(county) : [];
  const probed = kind === 'county'
    ? (await Promise.all(hostCandidates(county, STATE).map(servicesUnderRoot))).flat()
    : [];
  const discovered = await discoverOfficialMunicipalServices(jurisdiction, county, fetch, kind);
  // Known-good first, then self-hosted probes, then the catalog.
  const services = [...new Set([...seeded, ...probed, ...discovered])];

  for (const serviceUrl of services.slice(0, 8)) {
    let layers = [];
    try { layers = await serviceLayers(serviceUrl, fetch); } catch { continue; }
    // A big county service lists dozens of OVERLAY layers (airport, watershed,
    // historic, PUD) ahead of the base district layer — Wake's base zoning sits
    // below ~15 overlays. Rank base districts first so the real layer is reached.
    const overlayish = /overlay|watershed|airport|historic|pud|planned unit|conservation|activity center|corridor|special use|flood/i;
    const ranked = layers
      .filter((l) => isBaseZoningName(l.name) || isBaseZoningName(serviceUrl))
      .map((l) => ({
        l,
        score: (overlayish.test(l.name) ? -5 : 0)
          + (/^\s*(county\s+)?zoning\s*$/i.test(l.name) ? 4 : 0)
          + (/zoning/i.test(l.name) ? 2 : 0)
          + (/district/i.test(l.name) ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map(({ l }) => l)
      .slice(0, 25);
    for (const layer of ranked) {
      // Try every supplied point. A county centroid can easily land inside a
      // city (where COUNTY zoning does not apply) or on unzoned land, so one
      // miss is not proof the layer is useless.
      // The app is served over https, so an http layer is blocked as mixed
      // content in the browser and refused by the ArcGIS proxy. Recording one
      // would look like coverage the user cannot actually use.
      if (!String(layer.url).startsWith('https://')) continue;
      for (const point of [{ lng, lat }, ...(extraPoints || [])]) {
        const hit = await districtAtPoint(layer, point.lng, point.lat);
        if (hit) {
          return {
            jurisdiction,
            kind,
            layerUrl: layer.url,
            layerName: layer.name,
            codeField: hit.field,
            verifiedAt: new Date().toISOString().slice(0, 10),
            // The proof: this exact point returned this district.
            sample: { lng: point.lng, lat: point.lat, code: hit.code, description: hit.description },
          };
        }
      }
    }
  }
  return null;
}

// --- manifest ---------------------------------------------------------------
function loadManifest() {
  if (!existsSync(MANIFEST)) return { generated: null, counties: {} };
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { return { generated: null, counties: {} }; }
}

function saveManifest(manifest) {
  manifest.generated = new Date().toISOString();
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function pooled(items, worker, concurrency) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await worker(item));
    }
  }));
  return results;
}

// --- run --------------------------------------------------------------------
const manifest = loadManifest();
manifest.counties[STATE] = manifest.counties[STATE] || {};
const bucket = manifest.counties[STATE];

const counties = await censusCounties(STATE);
if (!counties.length) {
  console.error(`Could not load ${STATE} counties from the Census.`);
  process.exit(1);
}

// Places are needed for municipal sweeps, and also give county verification a
// few extra in-county points to try when the centroid lands somewhere unzoned.
const allPlaces = await censusPlaces(STATE);
const placesNear = (county, n = 3) => allPlaces
  .map((p) => ({ p, d: (p.lat - county.lat) ** 2 + (p.lng - county.lng) ** 2 }))
  .sort((a, b) => a.d - b.d)
  .slice(0, n)
  .map(({ p }) => ({ lng: p.lng, lat: p.lat }));

const targets = counties
  .filter((c) => (ONLY ? c.name.toLowerCase() === ONLY.toLowerCase() : true))
  .filter((c) => RECHECK || !bucket[c.name]?.county)
  .slice(0, LIMIT);

console.log(`${STATE}: ${counties.length} counties, ${targets.length} to sweep (county level)\n`);

let found = 0;
let done = 0;
await pooled(targets, async (county) => {
  const entry = bucket[county.name] || {};
  const hit = await verifyJurisdiction({
    jurisdiction: county.name,
    county: county.name,
    lng: county.lng,
    lat: county.lat,
    kind: 'county',
    extraPoints: placesNear(county),
  });
  done += 1;
  if (hit) {
    entry.county = hit;
    bucket[county.name] = entry;
    found += 1;
    console.log(`[${done}/${targets.length}] ${county.name.padEnd(14)} ${hit.sample.code.padEnd(10)} ${hit.layerName}`);
  } else {
    entry.county = entry.county || null;
    entry.countyCheckedAt = new Date().toISOString().slice(0, 10);
    bucket[county.name] = entry;
    console.log(`[${done}/${targets.length}] ${county.name.padEnd(14)} — no verifiable county zoning layer`);
  }
  if (done % 5 === 0) saveManifest(manifest);
}, CONCURRENCY);

saveManifest(manifest);
console.log(`\nCounty layers verified this run: ${found}/${targets.length}`);

if (DO_MUNICIPALITIES) {
  const places = allPlaces;
  const pending = places.filter((p) => RECHECK || !Object.values(bucket).some(
    (c) => (c.municipalities || []).some((m) => m.jurisdiction === p.name),
  )).slice(0, LIMIT);
  console.log(`\n${STATE}: ${places.length} incorporated places, ${pending.length} to sweep\n`);

  let mFound = 0;
  let mDone = 0;
  await pooled(pending, async (place) => {
    // Attribute the place to the nearest county centroid — good enough to file
    // it under, and the point query is what actually proves the layer.
    const county = counties.reduce((best, c) => {
      const d = (c.lat - place.lat) ** 2 + (c.lng - place.lng) ** 2;
      return d < best.d ? { c, d } : best;
    }, { c: counties[0], d: Infinity }).c;

    const hit = await verifyJurisdiction({
      jurisdiction: place.name,
      county: county.name,
      lng: place.lng,
      lat: place.lat,
      kind: 'municipality',
    });
    mDone += 1;
    if (hit) {
      const entry = bucket[county.name] || {};
      entry.municipalities = entry.municipalities || [];
      if (!entry.municipalities.some((m) => m.jurisdiction === hit.jurisdiction)) entry.municipalities.push(hit);
      bucket[county.name] = entry;
      mFound += 1;
      console.log(`[${mDone}/${pending.length}] ${place.name.padEnd(20)} (${county.name}) ${hit.sample.code.padEnd(10)} ${hit.layerName}`);
    }
    if (mDone % 10 === 0) saveManifest(manifest);
  }, CONCURRENCY);

  saveManifest(manifest);
  console.log(`\nMunicipal layers verified this run: ${mFound}/${pending.length}`);
}

const verifiedCounties = Object.values(bucket).filter((c) => c.county).length;
const verifiedMunis = Object.values(bucket).reduce((n, c) => n + (c.municipalities?.length || 0), 0);
console.log(`\n${STATE} manifest totals: ${verifiedCounties} county layers, ${verifiedMunis} municipal layers`);
console.log(`Written to ${MANIFEST}`);
