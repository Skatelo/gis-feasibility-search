import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import { handler } from '../realestateapi-property.js';

const source = await readFile(new URL('../../../src/services/realEstateApiProperty.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const propertyApi = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const addressSource = await readFile(new URL('../../../src/services/carolinaAddress.ts', import.meta.url), 'utf8');
const addressCompiled = ts.transpileModule(addressSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const addressResolver = await import(`data:text/javascript;base64,${Buffer.from(addressCompiled).toString('base64')}`);

const FIXTURE = {
  data: {
    id: 8195564,
    lastSaleDate: '2025-02-14',
    lastSalePrice: '410000',
    openMortgageBalance: 250000,
    estimatedMortgageBalance: '242500',
    freeClear: false,
    propertyInfo: {
      address: {
        house: '12901',
        address: '12901 Lanecrest Rd',
        city: 'Midland',
        state: 'NC',
        zip: '28107',
        label: '12901 Lanecrest Rd, Midland, NC 28107',
      },
    },
    currentMortgages: [{
      amount: 250000,
      documentDate: '2025-02-14T00:00:00.000Z',
      recordingDate: '2025-02-18T00:00:00.000Z',
      lenderName: 'Example Community Bank',
      loanType: 'Purchase',
      interestRate: 6.25,
      interestRateType: 'Fixed Rate',
    }],
    mortgageHistory: [{
      mortgageId: 'mortgage-current',
      amount: 250000,
      documentDate: '2025-02-14T00:00:00.000Z',
      recordingDate: '2025-02-18T00:00:00.000Z',
      lenderName: 'Example Community Bank',
      loanType: 'Purchase',
      open: true,
    }, {
      mortgageId: 'mortgage-old',
      amount: 180000,
      recordingDate: '2018-03-02T00:00:00.000Z',
      lenderName: 'Earlier Bank',
      loanType: 'Refinance',
      open: false,
    }],
    lastSale: {
      saleDate: '2025-02-14',
      recordingDate: '2025-02-18',
      saleAmount: 410000,
      buyerNames: 'CURRENT BUYER',
      sellerNames: 'PRIOR SELLER',
      documentType: 'Warranty Deed',
      transactionType: 'Sale',
      armsLength: true,
    },
    saleHistory: [{
      saleDate: '2025-02-14T00:00:00.000Z',
      recordingDate: '2025-02-18T00:00:00.000Z',
      saleAmount: 410000,
      buyerNames: 'CURRENT BUYER',
      sellerNames: 'PRIOR SELLER',
      documentType: 'Warranty Deed',
      transactionType: 'Sale',
      armsLength: true,
    }, {
      saleDate: '2018-02-23T00:00:00.000Z',
      recordingDate: '2018-03-02T00:00:00.000Z',
      saleAmount: 0,
      buyerNames: 'FAMILY TRUST',
      sellerNames: 'PRIOR OWNER',
      documentType: 'Quit Claim Deed',
      transactionType: 'Transfer',
      armsLength: false,
    }],
  },
};

test('normalizes a full Carolina address and parses mortgage plus sale history', () => {
  assert.equal(
    propertyApi.normalizeRealEstateApiAddress('12901 Lanecrest Road, Midland, North Carolina 28107, United States'),
    '12901 Lanecrest Road, Midland NC 28107',
  );

  const result = propertyApi.parseRealEstatePropertyTransactions(
    FIXTURE,
    '12901 Lanecrest Road, Midland, NC 28107',
    '2026-07-16T12:00:00.000Z',
  );
  assert.equal(result.propertyId, '8195564');
  assert.equal(result.matchedAddress, '12901 Lanecrest Rd, Midland, NC 28107');
  assert.equal(result.mortgages.length, 2, 'current mortgage and matching history row are deduplicated');
  assert.equal(result.mortgages[0].open, true);
  assert.equal(result.mortgages[0].amount, 250000);
  assert.equal(result.sales.length, 2, 'lastSale and saleHistory duplicate are deduplicated');
  assert.equal(result.sales[0].amount, 410000);
  assert.equal(result.sales[1].transactionType, 'Transfer');
  assert.equal(result.sales[1].amount, undefined, 'zero-dollar transfers are not displayed as $0 sales');
  assert.equal(result.openMortgageBalance, 250000);
  assert.equal(result.freeClear, false);
});

test('accepts an exact-match property record when sparse REAPI data omits its address object', () => {
  const sparse = {
    statusCode: 200,
    data: {
      propertyId: 'sc-rural-42',
      lastSale: {
        saleDate: '2022-04-01',
        saleAmount: 127500,
        buyerNames: 'RURAL BUYER',
        sellerNames: 'RURAL SELLER',
      },
    },
  };
  const result = propertyApi.parseRealEstatePropertyTransactions(
    sparse,
    '116 Wright Sims Road, Union SC 29379',
  );

  assert.equal(result.propertyId, 'sc-rural-42');
  assert.equal(result.matchedAddress, '116 Wright Sims Road, Union SC 29379');
  assert.equal(result.sales[0].amount, 127500);
});

test('unwraps nested arrays and accepts a string property address', () => {
  const nested = {
    data: {
      data: [{
        id: 'nested-21',
        propertyInfo: { address: '21 Magnolia St, York, SC 29745' },
        saleHistory: [{ saleDate: '2020-06-15', saleAmount: 185000 }],
      }],
    },
  };
  const result = propertyApi.parseRealEstatePropertyTransactions(
    nested,
    '21 Magnolia Street, York, SC 29745',
  );

  assert.equal(result.propertyId, 'nested-21');
  assert.equal(result.matchedAddress, '21 Magnolia St, York, SC 29745');
  assert.equal(result.sales[0].amount, 185000);
});

test('rejects an empty successful envelope instead of claiming an address match', () => {
  assert.throws(
    () => propertyApi.parseRealEstatePropertyTransactions(
      { statusCode: 200, data: {} },
      '21 Magnolia Street, York, SC 29745',
    ),
    /no property record/i,
  );
});

test('resolves a street-only GIS address from the selected parcel point', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('address=')) {
      return new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      status: 'OK',
      results: [{
        formatted_address: '116 Wright Sims Road, Union, SC 29379, USA',
        types: ['street_address'],
        address_components: [
          { short_name: '116', long_name: '116', types: ['street_number'] },
          { short_name: 'Wright Sims Rd', long_name: 'Wright Sims Road', types: ['route'] },
          { short_name: 'Union', long_name: 'Union', types: ['locality'] },
          { short_name: 'SC', long_name: 'South Carolina', types: ['administrative_area_level_1'] },
          { short_name: '29379', long_name: '29379', types: ['postal_code'] },
        ],
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await addressResolver.resolveFullCarolinaPostalAddress({
    addresses: ['116 WRIGHT-SIMS ROAD'],
    coordinates: { lat: 34.79865, lng: -81.52509 },
    countyName: 'Union, SC',
    googleMapsKey: 'google-test-key',
    fetcher,
  });

  assert.equal(result, '116 Wright Sims Road, Union, SC 29379');
  assert.equal(calls.length, 2, 'forward geocode falls back to the exact parcel point');
  assert.match(calls[0].url, /Union%20County%2C%20SC/);
  assert.match(calls[1].url, /latlng=34\.79865,-81\.52509/);
  assert.ok(calls.every((call) => call.init.cache === 'no-store'));
});

test('rejects a conflicting exact-address response', () => {
  const wrongAddress = structuredClone(FIXTURE);
  wrongAddress.data.propertyInfo.address.house = '12909';
  wrongAddress.data.propertyInfo.address.label = '12909 Lanecrest Rd, Midland, NC 28107';
  assert.throws(
    () => propertyApi.parseRealEstatePropertyTransactions(wrongAddress, '12901 Lanecrest Road, Midland, NC 28107'),
    /different property/i,
  );
});

test('each button lookup makes a fresh no-store exact-match request', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await propertyApi.fetchRealEstatePropertyTransactions(
    '12901 Lanecrest Road, Midland, North Carolina 28107, United States',
    'test-key',
    fetcher,
  );
  await propertyApi.fetchRealEstatePropertyTransactions(
    '12901 Lanecrest Road, Midland, North Carolina 28107, United States',
    'test-key',
    fetcher,
  );

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, '/.netlify/functions/realestateapi-property');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(new Headers(call.init.headers).get('x-api-key'), 'test-key');
    assert.deepEqual(JSON.parse(call.init.body), {
      address: '12901 Lanecrest Road, Midland NC 28107',
      exact_match: true,
      comps: false,
    });
  }
});

test('retries a formatted-address miss with exact structured address parts', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    if (body.address) {
      return new Response(JSON.stringify({ statusMessage: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await propertyApi.fetchRealEstatePropertyTransactions(
    '12901 Lanecrest Road, Midland, NC 28107',
    'test-key',
    fetcher,
  );

  assert.equal(result.propertyId, '8195564');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).address, '12901 Lanecrest Road, Midland NC 28107');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    house: '12901',
    street: 'Lanecrest Road',
    city: 'Midland',
    state: 'NC',
    zip: '28107',
    exact_match: true,
    comps: false,
  });
  assert.ok(calls.every((call) => call.init.cache === 'no-store'));
});

test('retries when a successful formatted lookup contains no usable property record', async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    calls.push(init);
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.address ? { statusCode: 200, data: {} } : FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await propertyApi.fetchRealEstatePropertyTransactions(
    '12901 Lanecrest Road, Midland, NC 28107',
    'test-key',
    fetcher,
  );

  assert.equal(result.propertyId, '8195564');
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(calls[1].body).house, 'second request uses structured address fields');
});

test('Netlify proxy forwards only the exact address request and API key', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { 'x-api-key': 'server-test-key' },
      body: JSON.stringify({
        address: '12901 Lanecrest Road, Midland, NC 28107',
        exact_match: false,
        comps: true,
      }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(captured.url, 'https://api.realestateapi.com/v2/PropertyDetail');
    assert.equal(captured.init.headers['x-api-key'], 'server-test-key');
    assert.equal(captured.init.cache, 'no-store');
    assert.deepEqual(JSON.parse(captured.init.body), {
      address: '12901 Lanecrest Road, Midland NC 28107',
      exact_match: true,
      comps: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Netlify proxy forwards the structured-address retry without client overrides', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { 'x-api-key': 'server-test-key' },
      body: JSON.stringify({
        house: '12901',
        street: 'Lanecrest Road',
        city: 'Midland',
        state: 'NC',
        zip: '28107',
        exact_match: false,
        comps: true,
      }),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(captured.init.body), {
      house: '12901',
      street: 'Lanecrest Road',
      city: 'Midland',
      state: 'NC',
      zip: '28107',
      exact_match: true,
      comps: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('report wiring is on-demand, left-column, and separate from RealtyAPI comps', async () => {
  const component = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../../../src/components/SettingsDrawer.tsx', import.meta.url), 'utf8');
  const service = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
  const background = component.match(/const generateCostEstimates[\s\S]*?return Promise\.resolve\(null\);\s*\n  };/)?.[0] || '';

  assert.doesNotMatch(background, /fetchRealEstatePropertyTransactions|fetchPropertyTransactions/);
  assert.match(component, /Pull Mortgage &amp; Sales History/);
  assert.match(component, /await resolveFullCarolinaPostalAddress/);
  assert.ok(component.indexOf('Mortgage &amp; Sales Transactions') < component.indexOf('Land Information'));
  assert.doesNotMatch(component, /Mortgage &amp; Transactions — Enformion/);
  assert.match(settings, /realEstateApi: realEstateApiKey\.trim\(\)/);
  assert.match(settings, /This is separate from RealtyAPI\.io below/);
  assert.match(service, /realEstateApi\?: string/);
  assert.match(service, /realtyApi\?: string/);
  assert.match(component, /handleSearch\(address, county\)/);
});
