import { scZoningCoverage } from './sc-zoning-manifest.js';

const ITEM_ID_RE = /^[a-f0-9]{32}$/i;
const SERVICE_URL_RE = /https?:\\?\/\\?\/[^"'<>\s]+?(?:MapServer|FeatureServer)(?:\/\d+)?/gi;
const BASE_ZONING_RE = /\b(zoning|zone class|zoning district|base district)\b/i;
const EXCLUDED_LAYER_RE = /\b(future|proposed|draft|original|rezon(?:e|ing)|case|request|overlay|historic|flood|school|tax|assessment|land use|comprehensive plan|enterprise|opportunity|evacuation|wind|summar(?:y|ize)|comparison|footprint|construction|enforcement|subdistrict|canvass|lowest|cool down)\b/i;
const CODE_KEY_RE = /^(?:zoning|zone|zone_?class|zone_?code|zoning_?district|zoning_?code|zclass|zcode|zdist|newzone|udo(?:_?label)?|code)$/i;
const LOOSE_CODE_KEY_RE = /zon|^zn|district|^class$|^code$/i;
const EXCLUDED_KEY_RE = /desc|name|jur|muni|city|county|town|date|case|owner|area|shape|objectid|globalid|url|link|land.?use/i;
const DESCRIPTION_KEY_RE = /desc|definition|decode|long.?name|zone_?gen|udo_?legend|^(?:code|giscode|zoning|zone|district)_?name$|^name$/i;
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
    if (url.hostname === 'experience.arcgis.com') return 'https://www.arcgis.com/sharing/rest';
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
  if (!data) return undefined;
  const attributes = data?.features?.[0]?.attributes;
  if (!attributes) return null;
  return String(attributes.BASENAME || attributes.NAME || '').replace(/\s+(city|town|village)$/i, '').trim() || null;
}

function compactName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PUBLIC_ARCGIS_ROOT = 'https://www.arcgis.com/sharing/rest';
const PUBLIC_ITEM_TYPE_RE = /^(?:Feature Service|Map Service|Web Map|Web Mapping Application|Web Experience|Experience Builder|Hub Site Application)$/i;

async function verifiedArcgisCatalogItemIds(
  jurisdiction,
  county,
  fetcher,
  jurisdictionKind = 'municipality',
) {
  if (!jurisdiction) return [];
  const isCounty = jurisdictionKind === 'county';
  const subject = isCounty ? `"${county} County"` : `"${jurisdiction}"`;
  // ArcGIS full-text search treats a loose state name as an OR-like term and
  // can crowd the actual local zoning item out of the first page. The exact
  // jurisdiction plus AND zoning is both faster and more precise; publisher
  // verification and the point intersection provide state-level safety.
  const query = encodeURIComponent(`${subject} AND zoning`);
  const search = await request(`${PUBLIC_ARCGIS_ROOT}/search?f=json&num=50&sortField=modified&sortOrder=desc&q=${query}`, fetcher);
  const jurisdictionToken = compactName(jurisdiction);
  const publisherTokens = [jurisdictionToken].filter((token) => token.length >= 3);
  const candidates = (Array.isArray(search?.results) ? search.results : [])
    .filter((item) => PUBLIC_ITEM_TYPE_RE.test(String(item?.type || '')))
    .filter((item) => !isExcludedLayerName(item?.title))
    .filter((item) => isBaseZoningName(`${item?.title || ''} ${item?.tags || ''} ${item?.description || ''}`))
    .slice(0, 20);

  const verified = await Promise.all(candidates.map(async (searchItem) => {
    const item = await request(`${PUBLIC_ARCGIS_ROOT}/content/items/${searchItem.id}?f=json`, fetcher) || searchItem;
    const orgId = item?.orgId || searchItem?.orgId;
    const portal = orgId ? await request(`${PUBLIC_ARCGIS_ROOT}/portals/${orgId}?f=json`, fetcher) : null;
    const context = compactName(`${item?.title || searchItem?.title || ''} ${item?.tags || searchItem?.tags || ''} ${item?.description || searchItem?.description || ''}`);
    const owner = compactName(item?.owner || searchItem?.owner || '');
    const organization = compactName(`${portal?.name || ''} ${portal?.urlKey || ''} ${portal?.description || ''}`);
    let serviceHost = '';
    try { serviceHost = compactName(new URL(item?.url || searchItem?.url || '').hostname); } catch { /* item has no direct URL */ }
    const contextMatches = jurisdictionToken.length >= 3 && context.includes(jurisdictionToken);
    const publisherMatches = publisherTokens.some((token) => owner.includes(token) || organization.includes(token));
    const officialPublisher = publisherTokens.some((token) => organization.includes(token) || serviceHost.includes(token));
    return publisherMatches && officialPublisher && (contextMatches || isBaseZoningName(context))
      && ITEM_ID_RE.test(String(searchItem?.id)) ? searchItem.id : null;
  }));
  return dedupe(verified.filter(Boolean));
}

async function servicesFromPublicItems(itemIds, fetcher) {
  const pending = [...itemIds];
  const seen = new Set();
  const services = [];
  for (let depth = 0; depth < 3 && pending.length; depth++) {
    const batch = pending.splice(0, 20).filter((id) => !seen.has(id));
    batch.forEach((id) => seen.add(id));
    const inspections = await Promise.all(batch.map((id) => inspectArcgisItem(PUBLIC_ARCGIS_ROOT, id, fetcher)));
    for (const result of inspections) {
      services.push(...result.serviceUrls);
      result.itemIds.forEach((id) => { if (!seen.has(id)) pending.push(id); });
    }
  }
  return services;
}

export async function discoverOfficialMunicipalServices(
  municipality,
  county,
  fetcher = fetch,
  jurisdictionKind = 'municipality',
) {
  if (!municipality) return [];
  const itemIds = await verifiedArcgisCatalogItemIds(
    municipality,
    county,
    fetcher,
    jurisdictionKind,
  );
  const services = await servicesFromPublicItems(itemIds, fetcher);
  const placeToken = compactName(municipality);
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
  const configuredServices = Array.isArray(entry?.zoningServices)
    ? entry.zoningServices.map(cleanServiceUrl).filter(Boolean)
    : [];
  if (configuredServices.length) return dedupe(configuredServices);

  const seeds = dedupe([entry?.officialMapUrl, entry?.alternateMapUrl]);
  const pages = await Promise.all(seeds.map((url) => inspectOfficialPage(url, fetcher)));
  const roots = dedupe([
    ...seeds.map(sharingRootForUrl),
    ...pages.flatMap((page) => page.sharingRoots),
  ]);
  if (seeds.some((url) => /(?:^|\.)arcgis\.com(?:\/|$)/i.test(String(url)))
    && !roots.includes(PUBLIC_ARCGIS_ROOT)) {
    roots.push('https://www.arcgis.com/sharing/rest');
  }

  const configuredItemIds = Array.isArray(entry?.arcgisItemIds) ? entry.arcgisItemIds.filter((id) => ITEM_ID_RE.test(String(id))) : [];
  if (configuredItemIds.length && !roots.includes(PUBLIC_ARCGIS_ROOT)) roots.push(PUBLIC_ARCGIS_ROOT);
  const pending = dedupe([...configuredItemIds, ...seeds.flatMap(itemIdsInUrl), ...pages.flatMap((page) => page.itemIds)]);
  const services = [
    ...pages.flatMap((page) => page.serviceUrls),
  ];
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

  const hasNamedZoningService = services.some((url) => isBaseZoningName(decodeURIComponent(url)));
  if (!hasNamedZoningService) {
    const catalogItems = await verifiedArcgisCatalogItemIds(entry?.county, entry?.county, fetcher, 'county');
    services.push(...await servicesFromPublicItems(catalogItems, fetcher));
  }

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
      const score = CODE_KEY_RE.test(field.name) || /^fbcode$/i.test(field.name) ? 5
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

function combinedZoningLabel(value) {
  const label = String(value ?? '').trim();
  const match = label.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)*?)-([A-Z][A-Za-z]+(?:\s.+)?)$/);
  const code = cleanCode(match?.[1]);
  return code ? { code, description: match[2].trim() } : null;
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
  const combined = !code
    ? keys.filter((key) => /^(?:zoning|zone|district)_?name$/i.test(key))
      .map((key) => combinedZoningLabel(attributes[key]))
      .find(Boolean)
    : null;
  const resolvedCode = code || combined?.code;
  if (!resolvedCode) return null;
  const jurisdictionPlaceholder = keys
    .filter((key) => /name|desc/i.test(key))
    .map((key) => String(attributes[key] ?? '').trim())
    .some((value) => /^(?:town|city|county)\s+of\b|\b(?:town|city)\s+limits\b/i.test(value));
  if (jurisdictionPlaceholder) return null;
  const publishedDescription = keys
    .filter((key) => DESCRIPTION_KEY_RE.test(key))
    .map((key) => String(attributes[key] ?? '').trim())
    .find((value) => value && value !== resolvedCode) || null;
  const description = combined?.description || publishedDescription;
  return { code: resolvedCode, description };
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

function normalizeParcelId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeStreetAddress(value) {
  return String(value || '')
    .split(',')[0]
    .toUpperCase()
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bHIGHWAY\b/g, 'HWY')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function chooseWmsZoningFeature(features, config, address, parcelId) {
  const candidates = (Array.isArray(features) ? features : [])
    .map((feature) => feature?.properties || {})
    .map((properties) => ({
      properties,
      code: cleanCode(properties?.[config.codeField]),
      secondaryCode: cleanCode(properties?.[config.secondaryCodeField]),
      parcelId: normalizeParcelId(properties?.[config.parcelField]),
      address: normalizeStreetAddress(properties?.[config.addressField]),
    }))
    .filter((candidate) => candidate.code);
  if (!candidates.length) return null;

  const expectedParcel = normalizeParcelId(parcelId);
  const parcelMatch = expectedParcel
    ? candidates.find((candidate) => candidate.parcelId === expectedParcel)
    : null;
  if (parcelMatch) return parcelMatch;

  const expectedAddress = normalizeStreetAddress(address);
  const addressMatch = expectedAddress
    ? candidates.find((candidate) => candidate.address === expectedAddress)
    : null;
  if (addressMatch) return addressMatch;

  // Address geocoders commonly return a road-centerline point a few feet from
  // the parcel. Accept nearby official parcels only when every clicked feature
  // agrees on the same base district; mixed districts remain unresolved.
  const codes = [...new Set(candidates.map((candidate) => candidate.code))];
  return codes.length === 1 ? candidates[0] : null;
}

async function queryOfficialWmsAtPoint(config, lng, lat, address, parcelId, fetcher) {
  if (!config?.url || !config?.layer || !config?.codeField) return null;
  const passes = [
    { delta: 0.0015, size: 151 },
    { delta: 0.002, size: 101 },
  ];
  for (const { delta, size } of passes) {
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetFeatureInfo',
      LAYERS: config.layer,
      QUERY_LAYERS: config.layer,
      STYLES: '',
      SRS: 'EPSG:4326',
      BBOX: `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`,
      WIDTH: String(size),
      HEIGHT: String(size),
      X: String(Math.floor(size / 2)),
      Y: String(Math.floor(size / 2)),
      INFO_FORMAT: 'application/json',
      FEATURE_COUNT: '50',
    });
    const data = await request(`${config.url}?${params}`, fetcher);
    const hit = chooseWmsZoningFeature(data?.features, config, address, parcelId);
    if (hit) {
      return {
        code: hit.code,
        description: hit.secondaryCode ? `Secondary zoning overlay: ${hit.secondaryCode}` : null,
        sourceUrl: config.url,
      };
    }
  }
  return null;
}

export async function resolveOfficialScZoning({ county, lng, lat, address = '', parcelId = '', fetcher = fetch }) {
  const entry = scZoningCoverage(county);
  if (!entry || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return null;
  const [countyServices, municipality, wmsHit] = await Promise.all([
    discoverOfficialZoningServices(entry, fetcher),
    incorporatedPlaceAtPoint(Number(lng), Number(lat), fetcher),
    queryOfficialWmsAtPoint(entry.zoningWms, Number(lng), Number(lat), address, parcelId, fetcher),
  ]);
  if (wmsHit && municipality === null) {
    return {
      ...wmsHit,
      officialMapUrl: entry.officialMapUrl,
      jurisdiction: `${entry.county} County`,
      discovery: 'official-wms-point',
    };
  }
  const municipalServices = await discoverOfficialMunicipalServices(municipality, entry.county, fetcher);
  const services = dedupe([...municipalServices, ...countyServices]);
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
  if (wmsHit) {
    return {
      ...wmsHit,
      officialMapUrl: entry.officialMapUrl,
      jurisdiction: municipality || `${entry.county} County`,
      discovery: 'official-wms-point',
    };
  }
  if (municipality === null && entry.noCountywideZoningSource) {
    return {
      code: 'NO ADOPTED DISTRICT',
      description: 'This parcel is outside incorporated municipal limits, and the official county code does not establish a county zoning district here',
      sourceUrl: entry.noCountywideZoningSource,
      officialMapUrl: entry.officialMapUrl,
      jurisdiction: `Unincorporated ${entry.county} County`,
      discovery: 'official-no-countywide-district',
    };
  }
  return null;
}

/**
 * Resolves North Carolina county and municipal zoning from publisher-verified
 * ArcGIS catalog items. NC has no single statewide zoning layer, so the Census
 * place at the property point determines which municipal catalog is queried
 * before the county catalog is tried.
 */
export async function resolveOfficialNcZoning({ county, lng, lat, fetcher = fetch }) {
  if (!county || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return null;
  const municipality = await incorporatedPlaceAtPoint(Number(lng), Number(lat), fetcher);
  const jurisdictions = [
    ...(municipality ? [{ jurisdiction: municipality, kind: 'municipality' }] : []),
    { jurisdiction: county, kind: 'county' },
  ];
  const discovered = await Promise.all(jurisdictions.map(async ({ jurisdiction, kind }) => ({
    jurisdiction,
    services: await discoverOfficialMunicipalServices(
      jurisdiction,
      county,
      fetcher,
      kind,
    ),
  })));

  for (const group of discovered) {
    const services = dedupe(group.services);
    const priority = services.filter((url) => isBaseZoningName(decodeURIComponent(url))).slice(0, 10);
    const secondary = services.filter((url) => !priority.includes(url)).slice(0, 10);
    for (const candidates of [priority, secondary]) {
      if (!candidates.length) continue;
      const layerGroups = await Promise.all(candidates.map((url) => serviceLayers(url, fetcher)));
      const layers = layerGroups.flat().slice(0, 24);
      const results = await Promise.all(layers.map((layer) => queryLayer(layer, Number(lng), Number(lat), fetcher)));
      const hit = results.find(Boolean);
      if (hit) {
        return {
          code: hit.code,
          description: hit.description,
          sourceUrl: hit.sourceUrl,
          officialMapUrl: hit.sourceUrl,
          jurisdiction: municipality || (group.jurisdiction === county ? `${county} County` : group.jurisdiction),
          discovery: 'official-arcgis-catalog',
        };
      }
    }
  }
  return null;
}
