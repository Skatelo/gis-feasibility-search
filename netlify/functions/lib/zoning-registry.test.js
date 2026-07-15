import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { resolveOfficialNcZoning, resolveOfficialScZoning } from './sc-zoning-discovery.js';
import { NC_ZONING_COUNTIES } from './nc-zoning-manifest.js';
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
const appSource = await readFile(new URL('../../../src/App.tsx', import.meta.url), 'utf8');
const officialLookupSource = await readFile(new URL('../../../src/services/officialZoningLookup.ts', import.meta.url), 'utf8');
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
  assert.match(zoning.getZoningServices('Oconee, SC')[0].url, /ZoningMap/);
  assert.match(zoning.getZoningServices('Sumter, SC')[0].url, /UDO_Zoning/);
  assert.match(zoning.getZoningServices('Anderson, SC')[1].url, /cityofandersonsc\.com/);
  assert.equal(zoning.getZoningServices('Berkeley, SC').length, 4);
  assert.match(zoning.getZoningServices('Orangeburg, SC')[0].url, /Main_Public_Tax_Parcel_Map/);
  assert.equal(zoning.getZoningServices('Beaufort, SC').length, 2);
  assert.match(zoning.getZoningServices('Horry, SC')[0].url, /Public\/Zoning/);
  assert.equal(zoning.getZoningServices('Lexington, SC').length, 4);
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

test('North Carolina zoning routing manifest covers all 100 counties', () => {
  assert.equal(NC_ZONING_COUNTIES.length, 100);
  assert.equal(new Set(NC_ZONING_COUNTIES).size, 100);
  assert.ok(NC_ZONING_COUNTIES.includes('Wake'));
  assert.ok(NC_ZONING_COUNTIES.includes('New Hanover'));
  assert.ok(NC_ZONING_COUNTIES.includes('Yancey'));
});

test('official ArcGIS app discovery resolves a base zoning district at the parcel point', async () => {
  const requests = [];
  const itemId = 'bf76cad67d1a48449fb7f9a316c4185e';
  const service = 'https://services.example.gov/arcgis/rest/services/Planning/Official_Zoning/FeatureServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url.includes(`/content/items/${itemId}/data`)) {
      return json({ operationalLayers: [{ title: 'Adopted zoning', url: service }] });
    }
    if (url.includes(`/content/items/${itemId}?`)) {
      return json({ id: itemId, orgId: 'official-org' });
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
    if (/^https:\/\/hamptoncountysc\.maps\.arcgis\.com\/apps\//.test(url)) {
      return new Response('<html><body>Official county map</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return json({});
  };

  const result = await resolveOfficialScZoning({ county: 'Hampton', lng: -80.6692, lat: 32.835, fetcher });
  assert.equal(result.code, 'R-2');
  assert.equal(result.description, 'Single-family residential');
  assert.equal(result.discovery, 'official-arcgis-portal');
  assert.match(result.sourceUrl, /Official_Zoning\/FeatureServer\/1$/);
  const query = requests.find((request) => request.url.includes('/1/query?'));
  assert.ok(query);
  assert.match(query.url, /geometry=-80\.6692%2C32\.835/);
  assert.doesNotMatch(query.url, /resultRecordCount=/, 'legacy county ArcGIS servers reject pagination parameters');
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
        { id: itemId, title: 'Town of Fairfax Zoning', type: 'Web Map', owner: 'TownOfFairfaxSC', tags: ['zoning'] },
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
  assert.ok(requests.some((request) => request.url.includes(`/content/items/${itemId}?`)), 'item metadata supplies the missing organization id');
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
});

test('incorporated NC parcels resolve a district from the official municipal ArcGIS catalog', async () => {
  const requests = [];
  const itemId = '55555555555555555555555555555555';
  const derivedItemId = '66666666666666666666666666666666';
  const service = 'https://maps.raleighnc.gov/arcgis/rest/services/Planning/Zoning/MapServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url.includes('Places_CouSub_ConCity_SubMCD')) {
      return json({ features: [{ attributes: { BASENAME: 'Raleigh' } }] });
    }
    if (url.includes('/sharing/rest/search?')) {
      return json({ results: [
        { id: derivedItemId, title: 'Zoning districts within a heat analysis area', type: 'Feature Service', owner: 'RaleighGIS', tags: ['zoning'] },
        { id: itemId, title: 'City of Raleigh Zoning Map', type: 'Web Map', owner: 'RaleighGIS', tags: ['zoning'] },
      ] });
    }
    if (url.includes('/portals/raleigh-org?')) return json({ name: 'City of Raleigh, North Carolina', urlKey: 'raleigh' });
    if (url.includes(`/content/items/${itemId}/data`)) return json({ operationalLayers: [{ title: 'Zoning districts', url: service }] });
    if (url.includes(`/content/items/${itemId}?`)) return json({ id: itemId, owner: 'RaleighGIS', orgId: 'raleigh-org', tags: ['zoning'] });
    if (url === `${service}?f=json`) return json({ layers: [{ id: 0, name: 'Zoning Districts' }] });
    if (url === `${service}/0?f=json`) return json({ fields: [
      { name: 'UDO', alias: 'Current zoning code' },
      { name: 'ZONE_GEN', alias: 'Zoning description' },
    ] });
    if (url.startsWith(`${service}/0/query?`)) {
      return json({ features: [{ attributes: { UDO: 'R-10', ZONE_GEN: 'Residential-10' } }] });
    }
    return json({});
  };

  const result = await resolveOfficialNcZoning({ county: 'Wake', lng: -78.6382, lat: 35.7796, fetcher });
  assert.equal(result.code, 'R-10');
  assert.equal(result.description, 'Residential-10');
  assert.equal(result.jurisdiction, 'Raleigh');
  assert.equal(result.discovery, 'official-arcgis-catalog');
  assert.match(result.sourceUrl, /Planning\/Zoning\/MapServer\/0$/);
  assert.ok(requests.some((request) => request.url.includes('%22Raleigh%22%20AND%20zoning')));
  assert.ok(!requests.some((request) => request.url.includes(derivedItemId)));
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
});

test('NC counties without a static service use the fresh server-side point resolver', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      success: true,
      data: {
        code: 'R-15',
        description: 'Residential district',
        sourceUrl: 'https://official.example.gov/arcgis/rest/services/Zoning/MapServer/0',
        jurisdiction: 'Burlington',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await zoning.fetchCountyZoningCode(
      'Alamance, NC',
      -79.4378,
      36.0957,
      { address: '100 Example St, Burlington, NC', parcelId: '12345' },
    );
    assert.equal(result.code, 'R-15');
    assert.equal(result.jurisdiction, 'Burlington');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/.netlify/functions/nc-zoning');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.match(requests[0].options.body, /100 Example St/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-ArcGIS county portals fall back to a publisher-verified ArcGIS catalog item', async () => {
  const requests = [];
  const itemId = '33333333333333333333333333333333';
  const thirdPartyId = '44444444444444444444444444444444';
  const service = 'https://services.arcgis.com/official/arcgis/rest/services/Allendale_County_Zoning/FeatureServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url === 'https://www.allendalecounty.com/') return new Response('<html><body>County GIS</body></html>', { status: 200 });
    if (url.includes('Places_CouSub_ConCity_SubMCD')) return json({ features: [] });
    if (url.includes('/sharing/rest/search?')) return json({ results: [
      { id: itemId, title: 'Allendale County Zoning', type: 'Web Map', owner: 'AllendaleCountyGIS', tags: ['South Carolina', 'zoning'] },
      { id: thirdPartyId, title: 'Allendale County Zoning', type: 'Web Map', owner: 'UniversityLab', tags: ['South Carolina', 'zoning'] },
    ] });
    if (url.includes(`/content/items/${itemId}/data`)) return json({ operationalLayers: [{ title: 'Adopted zoning', url: service }] });
    if (url.includes(`/content/items/${itemId}?`)) return json({ id: itemId, owner: 'AllendaleCountyGIS', orgId: 'allendale-org', tags: ['South Carolina', 'zoning'] });
    if (url.includes(`/content/items/${thirdPartyId}?`)) return json({ id: thirdPartyId, owner: 'UniversityLab', orgId: 'university-org', tags: ['South Carolina', 'zoning'] });
    if (url.includes('/portals/allendale-org?')) return json({ name: 'Allendale County GIS', urlKey: 'allendalecountysc' });
    if (url.includes('/portals/university-org?')) return json({ name: 'University Lab', urlKey: 'university' });
    if (url === `${service}?f=json`) return json({ layers: [{ id: 0, name: 'Zoning Districts' }] });
    if (url === `${service}/0?f=json`) return json({ fields: [{ name: 'ZONE_CODE', alias: 'Zoning code' }] });
    if (url.startsWith(`${service}/0/query?`)) return json({ features: [{ attributes: { ZONE_CODE: 'C-1' } }] });
    return json({});
  };

  const result = await resolveOfficialScZoning({ county: 'Allendale', lng: -81.308, lat: 33.007, fetcher });
  assert.equal(result.code, 'C-1');
  assert.equal(result.discovery, 'official-arcgis-portal');
  assert.ok(!requests.some((request) => request.url.includes(`/content/items/${thirdPartyId}/data`)));
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
});

test('Richland official WMS resolves the parcel district instead of map review', async () => {
  const requests = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value, options = {}) => {
    const url = String(value);
    requests.push({ url, options });
    if (url.includes('Places_CouSub_ConCity_SubMCD')) return json({ features: [] });
    if (url.startsWith('https://a.richlandmaps.com/geoserver/wms?')) {
      return json({ features: [
        { properties: { tms: 'R18913-01-03', situs_addr: '1749 PINCUSHION RD', zoning_pri: 'RT', zoning_sec: null } },
        { properties: { tms: 'R18816-01-04', situs_addr: '1747 PINCUSHION RD', zoning_pri: 'RT', zoning_sec: null } },
      ] });
    }
    if (url === 'https://richlandmaps.com/apps/dataviewer/') {
      return new Response('<html><body>Richland County Dataviewer</body></html>', { status: 200 });
    }
    return json({});
  };

  const result = await resolveOfficialScZoning({
    county: 'Richland',
    lng: -80.902991275234,
    lat: 33.917673846451,
    address: '1761 Pincushion Rd, Columbia, SC 29209',
    fetcher,
  });
  assert.equal(result.code, 'RT');
  assert.equal(result.discovery, 'official-wms-point');
  assert.equal(result.jurisdiction, 'Richland County');
  assert.match(result.sourceUrl, /richlandmaps\.com\/geoserver\/wms$/);
  const wmsRequest = requests.find((request) => request.url.includes('GetFeatureInfo'));
  assert.ok(wmsRequest);
  assert.match(wmsRequest.url, /QUERY_LAYERS=postgisworkspace%3Arcgeo_zoning_wgs84/);
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));
});

test('unincorporated Union returns the official no-district result, never map review', async () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value) => {
    const url = String(value);
    if (url.includes('Places_CouSub_ConCity_SubMCD')) return json({ features: [] });
    if (url.includes('qpublic.schneidercorp.com')) return new Response('<html><body>Union property map</body></html>', { status: 200 });
    return json({});
  };
  const result = await resolveOfficialScZoning({
    county: 'Union',
    lng: -81.524699942265,
    lat: 34.798728189004,
    address: '116 Wright Sims Road, Union, SC 29379',
    parcelId: '049-00-00-112-000',
    fetcher,
  });
  assert.equal(result.code, 'NO ADOPTED DISTRICT');
  assert.equal(result.discovery, 'official-no-countywide-district');
  assert.match(result.sourceUrl, /library\.municode\.com\/sc\/union_county/);
  assert.doesNotMatch(result.code, /map review/i);
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

test('combined official zoning labels are split into a code and description', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes('/FeatureServer/33/query?')) {
      return new Response(JSON.stringify({ features: [
        { attributes: { ZONINGNAME: 'NA-Area inside City Limits' } },
        { attributes: { ZONINGNAME: 'CG-Commercial General' } },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await zoning.fetchCountyZoningCode('Orangeburg, SC', -80.5600, 33.4760);
    assert.equal(result.code, 'CG');
    assert.equal(result.description, 'Commercial General');
    assert.match(result.sourceUrl, /Main_Public_Tax_Parcel_Map/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server resolver parses combined labels from an official county layer', async () => {
  const service = 'https://services2.arcgis.com/bUKn95BqgpYYTnx3/arcgis/rest/services/Main_Public_Tax_Parcel_Map_WFL1/FeatureServer';
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetcher = async (value) => {
    const url = String(value);
    if (url.includes('Places_CouSub_ConCity_SubMCD')) return json({ features: [] });
    if (url === `${service}?f=json`) return json({ layers: [{ id: 33, name: 'Zoning' }] });
    if (url === `${service}/33?f=json`) return json({ fields: [
      { name: 'ZONING', alias: 'ZONING' },
      { name: 'ZONINGNAME', alias: 'ZONINGNAME' },
    ] });
    if (url.startsWith(`${service}/33/query?`)) return json({ features: [
      { attributes: { ZONING: null, ZONINGNAME: 'CG-Commercial General' } },
    ] });
    return json({});
  };

  const result = await resolveOfficialScZoning({ county: 'Orangeburg', lng: -80.5600, lat: 33.4760, fetcher });
  assert.equal(result.code, 'CG');
  assert.equal(result.description, 'Commercial General');
  assert.match(result.sourceUrl, /FeatureServer\/33$/);
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

test('property zoning streams a fresh official district and enriches the existing allowances card', () => {
  const stage = serviceSource.slice(
    serviceSource.indexOf('// STAGE 3 - zoning.'),
    serviceSource.indexOf('// STAGE 4'),
  );

  assert.match(serviceSource, /countyName = `\$\{countyBaseName\(countyName\)\}, \$\{selectedState\}`/);
  assert.match(serviceSource, /addressString\.match\(\/\(\?:,\|\\s\)/);
  assert.match(stage, /lookupOfficialZoning\(/);
  assert.match(stage, /fetchCountyZoningCode\(/);
  assert.match(stage, /allowServerDiscovery: true/);
  assert.match(stage, /zoningLookupAddress/);
  assert.match(stage, /matchMethod: 'parcel-gis'/);
  assert.match(stage, /fetchZoningViaWebSearch\(/);
  assert.match(stage, /skipDirectLookup: !!officialZoning/);
  assert.match(stage, /emitZoning\(\)/);
  assert.match(stage, /zoningStandardsStatus = 'resolving'/);
  assert.match(stage, /cleanCode\(result\.code\) \|\| ''/);
  assert.match(stage, /zoningSetbackNotes/);
  assert.match(stage, /zoningRestrictions/);
  assert.doesNotMatch(stage, /zoningCode = 'MANUAL REVIEW'/);
  assert.doesNotMatch(stage, /OFFICIAL MAP REVIEW|ZONING CODE UNRESOLVED/);
  assert.doesNotMatch(serviceSource, /code: 'OFFICIAL MAP REVIEW'/);
  assert.match(officialLookupSource, /fresh: true/);
  assert.match(componentSource, /Zoning & Allowances/);
  assert.match(componentSource, /Reading adopted setback and allowance rules/);
  assert.match(componentSource, /Setback rules and exceptions/);
  assert.match(componentSource, /Published zoning restrictions/);
  assert.match(componentSource, /STANDARDS:[\s\S]*LOADING/);
  assert.doesNotMatch(appSource, /ZoningAdmin|zoning-admin|Zoning Sources/);
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
