import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { resolveOfficialScZoning } from './sc-zoning-discovery.js';
import { SC_ZONING_COVERAGE } from './sc-zoning-manifest.js';

const source = await readFile(new URL('../../../src/data/ncZoning.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const zoning = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const evidenceSource = await readFile(new URL('../../../src/data/zoningEvidence.ts', import.meta.url), 'utf8');
const evidenceCompiled = ts.transpileModule(evidenceSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const evidence = await import(`data:text/javascript;base64,${Buffer.from(evidenceCompiled).toString('base64')}`);
const serviceSource = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
const componentSource = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
const perplexityProxySource = await readFile(new URL('../perplexity.js', import.meta.url), 'utf8');
const viteSource = await readFile(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

test('state-qualified NC and SC county names resolve to their zoning services', () => {
  assert.equal(zoning.normalizeCountyKey('Mecklenburg, NC'), 'mecklenburg');
  assert.equal(zoning.normalizeCountyKey('Greenville, SC'), 'greenville,_sc');
  assert.equal(zoning.normalizeCountyKey('Union, NC'), 'union');
  assert.equal(zoning.normalizeCountyKey('Union, SC'), 'union,_sc');
  assert.match(zoning.getZoningServices('Mecklenburg, NC')[0].url, /CityofCharlotteZoning/);
  assert.match(zoning.getZoningServices('Greenville, SC')[0].url, /Greenville_Base/);
  assert.match(zoning.getZoningServices('Greenville')[0].url, /Greenville_Base/);
  assert.match(zoning.getZoningServices('Colleton, SC')[0].url, /Colleton_County_Zoning/);
  assert.match(zoning.getZoningServices('Dorchester, SC')[0].url, /Zoning_PUBLIC/);
  assert.match(zoning.getZoningServices('York, SC')[0].url, /York%20County%20Zoning/);
  assert.equal(zoning.getRenderableZoningServices('York, SC').length, 0);
  assert.equal(zoning.getRenderableZoningServices('Colleton, SC').length, 1);
});

test('South Carolina zoning routing manifest covers all 46 counties', () => {
  assert.equal(SC_ZONING_COVERAGE.length, 46);
  assert.equal(new Set(SC_ZONING_COVERAGE.map((entry) => entry.county)).size, 46);
  assert.equal(new Set(SC_ZONING_COVERAGE.map((entry) => entry.fips)).size, 46);
  assert.ok(SC_ZONING_COVERAGE.every((entry) => /^45\d{3}$/.test(entry.fips)));
  assert.ok(SC_ZONING_COVERAGE.every((entry) => /^https?:\/\//.test(entry.officialMapUrl)));
  assert.deepEqual(
    SC_ZONING_COVERAGE.map((entry) => entry.county).sort(),
    [
      'Abbeville', 'Aiken', 'Allendale', 'Anderson', 'Bamberg', 'Barnwell', 'Beaufort', 'Berkeley', 'Calhoun', 'Charleston',
      'Cherokee', 'Chester', 'Chesterfield', 'Clarendon', 'Colleton', 'Darlington', 'Dillon', 'Dorchester', 'Edgefield', 'Fairfield',
      'Florence', 'Georgetown', 'Greenville', 'Greenwood', 'Hampton', 'Horry', 'Jasper', 'Kershaw', 'Lancaster', 'Laurens',
      'Lee', 'Lexington', 'Marion', 'Marlboro', 'McCormick', 'Newberry', 'Oconee', 'Orangeburg', 'Pickens', 'Richland',
      'Saluda', 'Spartanburg', 'Sumter', 'Union', 'Williamsburg', 'York',
    ].sort(),
  );
});

test('official ArcGIS app discovery resolves a base zoning district at the parcel point', async () => {
  const requests = [];
  const service = 'https://services.example.gov/arcgis/rest/services/Planning/Official_Zoning/FeatureServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url.includes('/content/items/dcd2d7443dc9448ea910b9788a2c6b05/data')) {
      return json({ operationalLayers: [{ title: 'Adopted zoning', url: service }] });
    }
    if (url.includes('/content/items/dcd2d7443dc9448ea910b9788a2c6b05?')) {
      return json({ id: 'dcd2d7443dc9448ea910b9788a2c6b05', orgId: 'official-org' });
    }
    if (url.includes('/search?')) return json({ results: [] });
    if (url === `${service}?f=json`) {
      return json({ layers: [
        { id: 0, name: 'Future Land Use' },
        { id: 1, name: 'Base Zoning Districts' },
      ] });
    }
    if (url === `${service}/1?f=json`) {
      return json({ fields: [
        { name: 'OBJECTID', alias: 'OBJECTID' },
        { name: 'ZONE', alias: 'Zoning district' },
        { name: 'ZONE_DESC', alias: 'District description' },
      ] });
    }
    if (url.startsWith(`${service}/1/query?`)) {
      return json({ features: [{ attributes: { ZONE: 'R-2', ZONE_DESC: 'Single-family residential' } }] });
    }
    if (/^https:\/\/colletoncounty\.maps\.arcgis\.com\/apps\//.test(url)) {
      return new Response('<html><body>Official county map</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return json({});
  };

  const result = await resolveOfficialScZoning({ county: 'Colleton', lng: -80.6692, lat: 32.835, fetcher });
  assert.equal(result.code, 'R-2');
  assert.equal(result.description, 'Single-family residential');
  assert.equal(result.discovery, 'official-arcgis-portal');
  assert.match(result.sourceUrl, /Official_Zoning\/FeatureServer\/1$/);
  const query = requests.find((request) => request.url.includes('/1/query?'));
  assert.ok(query);
  assert.match(query.url, /geometry=-80\.6692%2C32\.835/);
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
  assert.ok(!requests.some((request) => request.url.includes('/0/query?')), 'future land use must not be queried as zoning');
});

test('incorporated SC parcels discover zoning only from a matching official municipal ArcGIS organization', async () => {
  const requests = [];
  const itemId = '11111111111111111111111111111111';
  const service = 'https://services.arcgis.com/official/arcgis/rest/services/Fairfax_Zoning/FeatureServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url.includes('Places_CouSub_ConCity_SubMCD')) {
      return json({ features: [{ attributes: { BASENAME: 'Fairfax' } }] });
    }
    if (url.includes('/sharing/rest/search?')) {
      return json({ results: [
        { id: itemId, title: 'Town of Fairfax Zoning', type: 'Web Map', owner: 'TownOfFairfaxSC', orgId: 'fairfax-org', tags: ['zoning'] },
        { id: '22222222222222222222222222222222', title: 'Fairfax Future Land Use', type: 'Web Map', owner: 'random', orgId: 'random-org', tags: ['zoning'] },
      ] });
    }
    if (url.includes('/portals/fairfax-org?')) return json({ name: 'Town of Fairfax, South Carolina' });
    if (url.includes(`/content/items/${itemId}/data`)) return json({ operationalLayers: [{ url: service }] });
    if (url.includes(`/content/items/${itemId}?`)) return json({ id: itemId, orgId: 'fairfax-org', extent: [[-82, 32], [-80, 34]] });
    if (url === `${service}?f=json`) return json({ layers: [{ id: 0, name: 'Zoning Districts' }] });
    if (url === `${service}/0?f=json`) return json({ fields: [{ name: 'ZONING', alias: 'Zoning' }] });
    if (url.startsWith(`${service}/0/query?`)) return json({ features: [{ attributes: { ZONING: 'R-10' } }] });
    if (url === 'https://www.allendalecounty.com/') return new Response('<html><body>County GIS</body></html>', { status: 200 });
    return json({});
  };

  const result = await resolveOfficialScZoning({ county: 'Allendale', lng: -81.236, lat: 32.959, fetcher });
  assert.equal(result.code, 'R-10');
  assert.equal(result.jurisdiction, 'Fairfax');
  assert.ok(!requests.some((request) => request.url.includes('22222222222222222222222222222222')));
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
});

test('official SC FeatureServers are queried at the exact property point', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ features: [{ attributes: { zone: 'RUD' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await zoning.fetchCountyZoningCode('York, SC', -81.1848, 34.9740);
    assert.equal(result.code, 'RUD');
    assert.match(result.sourceUrl, /York%20County%20Zoning/);
    const countyRequest = requests.find((request) => /York%20County%20Zoning/.test(request.url));
    assert.ok(countyRequest);
    assert.match(countyRequest.url, /FeatureServer\/0\/query\?/);
    assert.match(countyRequest.url, /geometry=-81\.1848%2C34\.974/);
    assert.ok(requests.every((request) => request.options.cache === 'no-store'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('official NC and SC identify responses produce district codes', () => {
  const northCarolina = zoning.extractZoning([{
    layerName: 'City of Charlotte Zoning',
    attributes: {
      'Zone Description': 'UC',
      'Zone Class': 'UPTOWN MIXED USE',
      Overlay: 'none',
    },
  }]);
  const southCarolina = zoning.extractZoning([{
    layerName: 'Zoning',
    attributes: {
      ZONING: 'MX-D',
      JCODE: 'City of Greenville',
      'SHAPE.STArea()': '685180.732056',
    },
  }]);

  assert.deepEqual(northCarolina, { code: 'UC', description: 'UPTOWN MIXED USE' });
  assert.deepEqual(southCarolina, { code: 'MX-D', description: null });
});

test('listing zoning evidence distinguishes one-provider reports from corroboration', () => {
  assert.equal(evidence.zoningListingProvider('https://www.zillow.com/homedetails/example'), 'zillow.com');
  assert.equal(evidence.listingZoningEvidenceTier(['https://www.zillow.com/a']), 'reported');
  assert.equal(evidence.listingZoningEvidenceTier([
    'https://www.zillow.com/a',
    'https://www.redfin.com/a',
  ]), 'corroborated');
  assert.equal(evidence.listingZoningEvidenceTier([
    'https://www.zillow.com/a',
    'https://photos.zillow.com/b',
  ]), 'reported');
  assert.equal(evidence.listingZoningEvidenceTier(['https://example.com/a']), null);
});

test('zoning uses official GIS first and grounded Gemini 3.5 Flash for research', () => {
  const stage = serviceSource.slice(
    serviceSource.indexOf('// STAGE 3 - zoning.'),
    serviceSource.indexOf('// STAGE 4'),
  );
  const resolver = serviceSource.slice(
    serviceSource.indexOf('export async function fetchZoningViaWebSearch'),
    serviceSource.indexOf('async function fetchDrivingDistancesViaSDK'),
  );

  assert.match(stage, /if \(geminiZoning\)/);
  assert.match(serviceSource, /countyName = `\$\{countyBaseName\(countyName\)\}, \$\{selectedState\}`/);
  assert.match(serviceSource, /addressString\.match\(\/\(\?:,\|\\s\)/);
  assert.match(stage, /zoningSetbackNotes/);
  assert.match(stage, /zoningRestrictions/);
  assert.match(resolver, /fetchCountyZoningCode/);
  assert.match(serviceSource, /const GEMINI_ZONING_MODEL = 'gemini-3\.5-flash'/);
  assert.match(serviceSource, /tools: \[\{ google_search: \{\} \}\]/);
  assert.match(resolver, /return bestOfficialResult[\s\S]*officialGisFallback[\s\S]*bestListingResult[\s\S]*statewideHintFallback[\s\S]*planningFallback[\s\S]*reviewFallback/);
  assert.match(resolver, /completeSetbacks[\s\S]*standards\?\.restrictions/);
  assert.match(serviceSource, /ZONING_FAST_SEARCH_BUDGET[\s\S]*mode: 'perplexity'/);
  assert.match(serviceSource, /ZONING_HARD_FALLBACK_BUDGET[\s\S]*mode: 'hard'/);
  assert.match(resolver, /const maxRounds = 2/);
  assert.match(resolver, /zoningResearchStartedAt[\s\S]*> 20000/);
  assert.match(resolver, /setTimeout\(\(\) => resolve\(null\), 12000\)/);
  assert.match(resolver, /onQuickResult/);
  assert.match(resolver, /zoningQueriesForRound/);
  assert.match(resolver, /municipality: incorporatedPlace/);
  assert.match(resolver, /seedUrls: hints\.officialMapUrl/);
  assert.match(resolver, /bestListingResult/);
  assert.match(resolver, /statewideHintFallback/);
  assert.match(resolver, /planningFallback/);
  assert.match(resolver, /noAdoptedDistrictFallback/);
  assert.match(serviceSource, /SC_NO_COUNTYWIDE_ZONING_SOURCES[\s\S]*Union:[\s\S]*library\.municode\.com\/sc\/union_county/);
  assert.match(resolver, /incorporatedPlaceAtPoint[\s\S]*code: 'NO ADOPTED DISTRICT'/);
  assert.match(resolver, /code: 'OFFICIAL MAP REVIEW'/);
  assert.match(serviceSource, /site:zillow\.com[\s\S]*site:realtor\.com[\s\S]*site:redfin\.com/);
  assert.doesNotMatch(resolver, /zoningExpertViaDeepSeek|deepSeekKey|model: 'sonar'/);
  assert.doesNotMatch(serviceSource, /NOT PUBLISHED|"UNZONED"/);
  assert.match(serviceSource, /method: 'POST',\s+cache: 'no-store',/);
  assert.match(componentSource, /CORROBORATED: PROPERTY LISTINGS/);
  assert.match(componentSource, /REPORTED: PROPERTY LISTING/);
  assert.match(componentSource, /Setback rules and exceptions/);
  assert.match(componentSource, /Published zoning restrictions/);
  assert.match(componentSource, /STANDARDS:[\s\S]*REVIEW REQUIRED/);
  assert.doesNotMatch(componentSource, /Zoning \(not published\)/);
});

test('Perplexity uses the direct Search API without an agent dispatch model', () => {
  assert.match(perplexityProxySource, /api\.perplexity\.ai\/search/);
  assert.doesNotMatch(perplexityProxySource, /\/v1\/agent/);
  assert.match(viteSource, /rewrite: \(\) => '\/search'/);
  assert.doesNotMatch(viteSource, /\/v1\/agent/);
  assert.match(serviceSource, /perplexitySearchRequest/);
  assert.match(serviceSource, /flattenPplxResults/);
  assert.doesNotMatch(serviceSource, /AGENT_SEARCH_MODEL|perplexityAgentRequest|agentSearchResultGroups/);
});

test('comps use RealtyAPI records filtered by zoning while retaining Gemini Vision photos', () => {
  const pipeline = serviceSource.slice(
    serviceSource.indexOf('export async function fetchGoogleDistanceMatrixComps'),
    serviceSource.indexOf('/** A grounded (Google-Search) Gemini text call'),
  );

  assert.match(pipeline, /fetchRealtyApiSoldComps/);
  assert.match(pipeline, /getPermittedCategory\(zoningCode, zoningDesc\)/);
  assert.match(pipeline, /selectExteriorComps\(result, getBackgroundGeminiKey\(\)\)/);
  assert.doesNotMatch(pipeline, /fetchGoogleMlsComps|runGeminiCompQuery|google_search|ENABLE_GOOGLE_MLS_COMPS/);
  assert.match(serviceSource, /matchesZoningUse\(c\.propertyType, category\)/);
});
