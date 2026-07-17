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
    '12901 Lanecrest Road, Midland, NC 28107',
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
      address: '12901 Lanecrest Road, Midland, NC 28107',
      exact_match: true,
      comps: false,
    });
  }
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
      address: '12901 Lanecrest Road, Midland, NC 28107',
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
  assert.ok(component.indexOf('Mortgage &amp; Sales Transactions') < component.indexOf('Land Information'));
  assert.doesNotMatch(component, /Mortgage &amp; Transactions — Enformion/);
  assert.match(settings, /realEstateApi: realEstateApiKey\.trim\(\)/);
  assert.match(settings, /This is separate from RealtyAPI\.io below/);
  assert.match(service, /realEstateApi\?: string/);
  assert.match(service, /realtyApi\?: string/);
});
