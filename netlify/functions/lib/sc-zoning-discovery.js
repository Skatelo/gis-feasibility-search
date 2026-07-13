import { scZoningCoverage } from './sc-zoning-manifest.js';

const ITEM_ID_RE = /^[a-f0-9]{32}$/i;
const SERVICE_URL_RE = /https?:\\?\/\\?\/[^"'<>\s]+?(?:MapServer|FeatureServer)(?:\/\d+)?/gi;
const BASE_ZONING_RE = /\b(zoning|zone class|zoning district|base district)\b/i;
const EXCLUDED_LAYER_RE = /\b(future|proposed|rezon(?:e|ing)|case|request|overlay|historic|flood|school|tax|assessment|land use|comprehensive plan|enterprise|opportunity|evacuation|wind)\b/i;
const CODE_KEY_RE = /^(?:zoning|zone|zone_?class|zone_?code|zoning_?district|zoning_?code|zclass|zcode|zdist|newzone|code)$/i;
const LOOSE_CODE_KEY_RE = /zon|^zn|district|^class$|^code$/i;
const EXCLUDED_KEY_RE = /desc|name|jur|muni|city|county|town|date|case|owner|area|shape|objectid|globalid|url|link|land.?use/i;
const DESCRIPTION_KEY_RE = /desc|definition|decode|long.?name|^name$/i;
const PLACEHOLDER_RE = /^(?:city|county|etj|none|n\/?a|mun\.?|muni|municipal|municipality|split|unknown|not applicable)$/i;

const isBaseZoningName = (value) => BASE_ZONING_RE.test(String(value || '').replace(/[_-]+/g, ' '));
const isExcludedLayerName = (value) => EXCLUDED_LAYER_RE.test(String(value || '').replace(/[_-]+/g, ' '));

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanServiceUrl(value) {
  const url = String(value || '').replace(/\\\//g, '/').replace(/[),.;]+$/, '');
  const match = url.match(/^(https?:\/\/.*?(?:MapServer|FeatureServer))(?:\/\d+)?(?:[?#].*)?$/i);
  return match?.[1] || null;
}

function itemIdsInUrl(value) {
  const url = String(value || '');
  return dedupe([
    ...(url.match(/[?&](?:id|webmap)=([a-f0-9]{32})/gi) || []).map((part) => part.slice(part.indexOf('=') + 1)),
    ...(url.match(/\/(?:experience|items)\/([a-f0-9]{32})(?:\b|\/)/gi) || []).map((part) => (part.match(/[a-f0-9]{32}/i) || [])[0]),
  ].filter((id) => ITEM_ID_RE.test(String(id))));
}

function sharingRootForUrl(value) {
  try {
    const url = new URL(value);
    const portalIndex = url.pathname.toLowerCase().indexOf('/portal/');
    if (portalIndex >= 0) return `${url.origin}${url.pathname.slice(0, portalIndex + 7)}/sharing/rest`.replace(/\/+/g, '/').replace('https:/', 'https://').replace('http:/', 'http://');
    if (url.hostname.endsWith('.arcgis.com') || url.hostname === 'arcgis.com') {
      return `${url.origin}/sharing/rest`;
    }
  } catch { /* not a URL */ }
  return null;
}

function stringsInObject(value, found = []) {
  if (found.length >= 1000 || value == null) return found;
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringsInObject(entry, found));
  else if (typeof value === 'object') Object.values(value).forEach((entry) => stringsInObject(entry, found));
  return found;
}

async function request(url, fetcher, responseType = 'json', timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: responseType === 'json' ? 'application/json' : 'text/html,*/*;q=0.5' },
    });
    if (!response.ok) return null;
    return responseType === 'json' ? await response.json() : await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function referencesInData(data) {
  const strings = stringsInObject(data);
  const itemIds = strings.filter((value) => ITEM_ID_RE.test(value));
  const serviceUrls = strings.flatMap((value) => value.match(SERVICE_URL_RE) || []).map(cleanServiceUrl);
  const sharingRoots = strings.map(sharingRootForUrl);
  return { itemIds: dedupe(itemIds).slice(0, 30), serviceUrls: dedupe(serviceUrls), sharingRoots: dedupe(sharingRoots) };
}

async function inspectArcgisItem(root, itemId, fetcher) {
  const [item, data] = await Promise.all([
    request(`${root}/content/items/${itemId}?f=json`, fetcher),
    request(`${root}/content/items/${itemId}/data?f=json`, fetcher),
  ]);
  const refs = referencesInData([item, data]);
  const itemUrl = cleanServiceUrl(item?.url);
  return {
    itemIds: refs.itemIds.filter((id) => id.toLowerCase() !== itemId.toLowerCase()),
    serviceUrls: dedupe([itemUrl, ...refs.serviceUrls]),
    sharingRoots: refs.sharingRoots,
    orgId: typeof item?.orgId === 'string' ? item.orgId : null,
  };
}

async function inspectOfficialPage(url, fetcher) {
  const html = await request(url, fetcher, 'text', 5000);
  if (!html) return { itemIds: [], serviceUrls: [], sharingRoots: [] };
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* invalid seed */ }
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => {
      try { return new URL(match[1], url).href; } catch { return null; }
    })
    .filter((value) => value && (!origin || new URL(value).origin === origin))
    .slice(0, 8);
  if (/ArcGIS Web Application|\bjimu\b|Web AppBuilder/i.test(html)) {
    try { scripts.unshift(new URL('config.json', url).href); } catch { /* invalid seed */ }
  }
  const scriptBodies = await Promise.all(dedupe(scripts).slice(0, 9).map((scriptUrl) => request(scriptUrl, fetcher, 'text', 4000)));
  const source = [html, ...scriptBodies.filter(Boolean)].join('\n');
  const absoluteServices = (source.match(SERVICE_URL_RE) || []).map(cleanServiceUrl);
  const relativeServices = [...source.matchAll(/["']([^"']+?(?:MapServer|FeatureServer)(?:\/\d+)?)["']/gi)]
    .map((match) => {
      try { return cleanServiceUrl(new URL(match[1].replace(/\\\//g, '/'), url).href); } catch { return null; }
    });
  const serviceUrls = dedupe([...absoluteServices, ...relativeServices]);
  const urls = source.match(/https?:\\?\/\\?\/[^"'<>\s]+/gi) || [];
  const normalizedUrls = urls.map((value) => value.replace(/\\\//g, '/'));
  const embeddedItemIds = [...source.matchAll(/(?:itemId|webmap|webMap|item)\s*["']?\s*[:=]\s*["']([a-f0-9]{32})["']/gi)]
    .map((match) => match[1]);
  return {
    itemIds: dedupe([...itemIdsInUrl(url), ...normalizedUrls.flatMap(itemIdsInUrl), ...embeddedItemIds]),
    serviceUrls: dedupe(serviceUrls),
    sharingRoots: dedupe([sharingRootForUrl(url), ...normalizedUrls.map(sharingRootForUrl)]),
  };
}

async function officialOrgItems(root, county, orgId, fetcher) {
  let id = orgId;
  if (!id) {
    const portal = await request(`${root}/portals/self?f=json`, fetcher);
    id = typeof portal?.id === 'string' ? portal.id : null;
  }
  if (!id) return [];
  const query = encodeURIComponent(`orgid:${id} AND zoning AND (type:"Feature Service" OR type:"Map Service" OR type:"Web Map")`);
  const data = await request(`${root}/search?f=json&num=50&sortField=modified&sortOrder=desc&q=${query}`, fetcher);
  return (Array.isArray(data?.results) ? data.results : [])
    .filter((item) => isBaseZoningName(`${item?.title || ''} ${item?.tags || ''}`))
    .filter((item) => !isExcludedLayerName(item?.title))
    .filter((item) => !county || new RegExp(`${county}|zoning`, 'i').test(`${item?.title || ''} ${item?.description || ''}`))
    .map((item) => item?.id)
    .filter((id) => ITEM_ID_RE.test(String(id)))
    .slice(0, 20);
}

async function incorporatedPlaceAtPoint(lng, lat, fetcher) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'BASENAME,NAME',
    returnGeometry: 'false',
    f: 'json',
  });
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query?${params}`;
  const data = await request(url, fetcher);
  const attributes = data?.features?.[0]?.attributes;
  if (!attributes) return null;
  return String(attributes.BASENAME || attributes.NAME || '').replace(/\s+(city|town|village)$/i, '').trim() || null;
}

function compactName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function discoverOfficialMunicipalServices(municipality, county, fetcher = fetch) {
  if (!municipality) return [];
  const root = 'https://www.arcgis.com/sharing/rest';
  const query = encodeURIComponent(`${municipality} zoning`);
  const search = await request(`${root}/search?f=json&num=50&sortField=modified&sortOrder=desc&q=${query}`, fetcher);
  const placeToken = compactName(municipality);
  const countyToken = compactName(county);
  const candidates = (Array.isArray(search?.results) ? search.results : [])
    .filter((item) => !isExcludedLayerName(item?.title))
    .filter((item) => /^(?:Feature Service|Map Service|Web Map|Web Mapping Application|Web Experience|Hub Site Application)$/i.test(String(item?.type || '')))
    .slice(0, 20);

  const verified = await Promise.all(candidates.map(async (item) => {
    const ownerLooksOfficial = compactName(item?.owner).includes(placeToken);
    const portal = item?.orgId ? await request(`${root}/portals/${item.orgId}?f=json`, fetcher) : null;
    const organization = compactName(`${portal?.name || ''} ${portal?.description || ''}`);
    const officialOrganization = organization.includes(placeToken) || organization.includes(countyToken);
    return ownerLooksOfficial || officialOrganization ? item : null;
  }));

  const pending = verified.filter(Boolean).map((item) => item.id);
  const seen = new Set();
  const services = [];
  for (let depth = 0; depth < 3 && pending.length; depth++) {
    const batch = pending.splice(0, 20).filter((id) => !seen.has(id));
    batch.forEach((id) => seen.add(id));
    const inspections = await Promise.all(batch.map((id) => inspectArcgisItem(root, id, fetcher)));
    for (const result of inspections) {
      services.push(...result.serviceUrls);
      result.itemIds.forEach((id) => { if (!seen.has(id)) pending.push(id); });
    }
  }
  const serviceScore = (value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (/(?:\.gov|\.us)$/.test(host) ? 5 : 0)
        + (compactName(host).includes(placeToken) ? 3 : 0)
        + (isBaseZoningName(url.pathname) ? 2 : 0)
        - (host === 'utility.arcgis.com' ? 2 : 0);
    } catch { return 0; }
  };
  return dedupe(services.map(cleanServiceUrl)).filter(Boolean)
    .sort((left, right) => serviceScore(right) - serviceScore(left));
}

export async function discoverOfficialZoningServices(entry, fetcher = fetch) {
  const seeds = dedupe([entry?.officialMapUrl, entry?.alternateMapUrl]);
  const pages = await Promise.all(seeds.map((url) => inspectOfficialPage(url, fetcher)));
  const roots = dedupe([
    ...seeds.map(sharingRootForUrl),
    ...pages.flatMap((page) => page.sharingRoots),
  ]);
  if (roots.length === 0 && seeds.some((url) => /(?:arcgis\.com|experience\.arcgis\.com)/i.test(url))) {
    roots.push('https://www.arcgis.com/sharing/rest');
  }

  const pending = dedupe([...seeds.flatMap(itemIdsInUrl), ...pages.flatMap((page) => page.itemIds)]);
  const services = pages.flatMap((page) => page.serviceUrls);
  const seenItems = new Set();
  const orgIds = new Map();

  for (let depth = 0; depth < 3 && pending.length; depth++) {
    const batch = pending.splice(0, 20).filter((id) => !seenItems.has(id));
    batch.forEach((id) => seenItems.add(id));
    const inspections = await Promise.all(batch.flatMap((itemId) => roots.map(async (root) => ({
      root,
      result: await inspectArcgisItem(root, itemId, fetcher),
    }))));
    for (const { root, result } of inspections) {
      services.push(...result.serviceUrls);
      result.itemIds.forEach((id) => { if (!seenItems.has(id)) pending.push(id); });
      result.sharingRoots.forEach((candidate) => { if (!roots.includes(candidate)) roots.push(candidate); });
      if (result.orgId) orgIds.set(root, result.orgId);
    }
  }

  const orgItemGroups = await Promise.all(roots.slice(0, 4).map((root) =>
    officialOrgItems(root, entry?.county || '', orgIds.get(root), fetcher)));
  const orgItems = dedupe(orgItemGroups.flat());
  const orgInspections = await Promise.all(orgItems.slice(0, 20).flatMap((itemId) =>
    roots.slice(0, 4).map((root) => inspectArcgisItem(root, itemId, fetcher))));
  orgInspections.forEach((result) => services.push(...result.serviceUrls));

  return dedupe(services.map(cleanServiceUrl)).filter(Boolean).sort((left, right) => {
    const score = (url) => (isBaseZoningName(decodeURIComponent(url)) ? 1 : 0);
    return score(right) - score(left);
  }).slice(0, 40);
}

function candidateField(fields) {
  const available = Array.isArray(fields) ? fields : [];
  const scored = available
    .map((field) => ({ name: String(field?.name || ''), alias: String(field?.alias || '') }))
    .filter((field) => field.name)
    .map((field) => {
      const aliasCode = /zoning.*(?:abbrev|code|district|class)|(?:abbrev|code).*zoning/i.test(field.alias);
      const score = CODE_KEY_RE.test(field.name) ? 5
        : aliasCode ? 4
          : CODE_KEY_RE.test(field.alias) ? 3
            : !EXCLUDED_KEY_RE.test(`${field.name} ${field.alias}`) && LOOSE_CODE_KEY_RE.test(`${field.name} ${field.alias}`) ? 2 : 0;
      return { ...field, score };
    })
    .filter((field) => field.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.name;
}

function cleanCode(value) {
  const code = String(value ?? '').trim();
  if (!code || code.length > 40 || !/[A-Za-z]/.test(code) || PLACEHOLDER_RE.test(code)) return null;
  return code;
}

function zoningFromAttributes(attributes, preferredField) {
  if (!attributes || typeof attributes !== 'object') return null;
  const keys = Object.keys(attributes);
  const codeKeys = dedupe([
    preferredField,
    ...keys.filter((key) => CODE_KEY_RE.test(key)),
    ...keys.filter((key) => LOOSE_CODE_KEY_RE.test(key) && !EXCLUDED_KEY_RE.test(key)),
  ]);
  const code = codeKeys.map((key) => cleanCode(attributes[key])).find(Boolean);
  if (!code) return null;
  const jurisdictionPlaceholder = keys
    .filter((key) => /name|desc/i.test(key))
    .map((key) => String(attributes[key] ?? '').trim())
    .some((value) => /^(?:town|city|county)\s+of\b|\b(?:town|city)\s+limits\b/i.test(value));
  if (jurisdictionPlaceholder) return null;
  const description = keys
    .filter((key) => DESCRIPTION_KEY_RE.test(key))
    .map((key) => String(attributes[key] ?? '').trim())
    .find((value) => value && value !== code) || null;
  return { code, description };
}

async function serviceLayers(serviceUrl, fetcher) {
  const metadata = await request(`${serviceUrl}?f=json`, fetcher);
  if (!metadata || metadata.error) return [];
  if (/\/(?:MapServer|FeatureServer)\/\d+$/i.test(serviceUrl)) {
    return [{ url: serviceUrl, name: metadata.name || '', fields: metadata.fields || [] }];
  }
  const serviceName = decodeURIComponent(serviceUrl.split('/').slice(-2, -1)[0] || '');
  const layers = Array.isArray(metadata.layers) ? metadata.layers : [];
  return (await Promise.all(layers.map(async (layer) => {
    const name = String(layer?.name || '');
    const isCandidate = !isExcludedLayerName(name)
      && (isBaseZoningName(name) || isBaseZoningName(serviceName));
    if (!isCandidate || !Number.isInteger(layer?.id)) return null;
    const layerUrl = `${serviceUrl}/${layer.id}`;
    const layerMetadata = await request(`${layerUrl}?f=json`, fetcher);
    return { url: layerUrl, name, fields: layerMetadata?.fields || [] };
  }))).filter(Boolean);
}

async function queryLayer(layer, lng, lat, fetcher) {
  const field = candidateField(layer.fields);
  if (!field) return null;
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: '1=1',
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: '5',
    f: 'json',
  });
  const data = await request(`${layer.url}/query?${params}`, fetcher);
  const features = Array.isArray(data?.features) ? data.features : [];
  for (const feature of features) {
    const result = zoningFromAttributes(feature?.attributes, field);
    if (result) return { ...result, sourceUrl: layer.url, layerName: layer.name };
  }
  return null;
}

export async function resolveOfficialScZoning({ county, lng, lat, fetcher = fetch }) {
  const entry = scZoningCoverage(county);
  if (!entry || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return null;
  const [countyServices, municipality] = await Promise.all([
    discoverOfficialZoningServices(entry, fetcher),
    incorporatedPlaceAtPoint(Number(lng), Number(lat), fetcher),
  ]);
  const municipalServices = await discoverOfficialMunicipalServices(municipality, entry.county, fetcher);
  const services = dedupe([...municipalServices, ...countyServices]);
  if (!services.length) return null;
  const priority = services.filter((url) => isBaseZoningName(decodeURIComponent(url))).slice(0, 10);
  const secondary = services.filter((url) => !priority.includes(url)).slice(0, 10);
  for (const group of [priority, secondary]) {
    if (!group.length) continue;
    const layerGroups = await Promise.all(group.map((url) => serviceLayers(url, fetcher)));
    const layers = layerGroups.flat().slice(0, 24);
    const results = await Promise.all(layers.map((layer) => queryLayer(layer, Number(lng), Number(lat), fetcher)));
    const hit = results.find(Boolean);
    if (hit) {
      return {
        code: hit.code,
        description: hit.description,
        sourceUrl: hit.sourceUrl,
        officialMapUrl: entry.officialMapUrl,
        jurisdiction: municipality || `${entry.county} County`,
        discovery: 'official-arcgis-portal',
      };
    }
  }
  return null;
}
