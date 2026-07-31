import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import { handler } from '../monid.js';

const source = await readFile(new URL('../../../src/services/monidSearch.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const monid = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const DEFAULT_OCTEN_PRICE = { type: 'PER_CALL', amount: 0.002, currency: 'USD' };
const OCTEN_ENDPOINTS = ['/search', '/broad-search', '/extract', '/embedding'];

function octenInspection(
  endpoint = '/search',
  price = DEFAULT_OCTEN_PRICE,
) {
  const schemas = {
    '/search': {
      query: { type: 'string' },
      count: { type: 'number' },
      exclude_domains: { type: 'array', items: { type: 'string' } },
      time_range: { type: 'string' },
      language: { type: 'array', items: { type: 'string' } },
      highlight: { type: 'object' },
    },
    '/broad-search': {
      query: { type: 'string' },
      max_queries: { type: 'number' },
      search_options: { type: 'object' },
    },
    '/extract': {
      urls: { type: 'array', items: { type: 'string' } },
      query: { type: 'string' },
      max_age_seconds: { type: 'number' },
      format: { type: 'string' },
      timeout: { type: 'number' },
    },
    '/embedding': {
      input: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      dimension: { type: 'number' },
    },
  };
  return {
    provider: 'octen',
    providerName: 'Octen',
    endpoint,
    description: `Octen ${endpoint} tool`,
    price,
    inputSchema: {
      type: 'object',
      properties: schemas[endpoint],
    },
  };
}

function octenDiscovery(price = DEFAULT_OCTEN_PRICE) {
  return {
    results: OCTEN_ENDPOINTS.map((endpoint) => octenInspection(endpoint, price)),
  };
}

function inspectedOctenRequest(init, price = DEFAULT_OCTEN_PRICE) {
  const body = init?.body ? JSON.parse(init.body) : {};
  return octenInspection(body.endpoint || '/search', price);
}

function completedSearch(
  query,
  suffix = '',
  actualCostUsd = 0.002,
  endpoint = '/search',
) {
  return {
    runId: `01HXYZ1234567890ABCDE${suffix || 'F'}`,
    provider: 'octen',
    endpoint,
    status: 'COMPLETED',
    output: {
      results: [{
        title: `Official result for ${query}`,
        url: `https://example.gov/research/${encodeURIComponent(query)}${suffix}`,
        highlights: [`Official evidence for ${query} with enough detail to exercise content coverage scoring.`],
        publishedDate: '2026-07-28T00:00:00.000Z',
      }],
    },
    billing: {
      actualCost: {
        value: Math.round(actualCostUsd * 1_000_000),
        unit: 'MICRO_DOLLAR',
        currency: 'USD',
      },
    },
    providerResponse: { httpStatus: 200 },
  };
}

test('Monid resolves Octen Search once but executes every repeated search fresh', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  let runs = 0;
  const fetchImpl = async (url, init) => {
    const request = new URL(String(url), 'http://localhost');
    const endpoint = request.searchParams.get('endpoint');
    calls.push({ endpoint, init, body: init.body ? JSON.parse(init.body) : null });
    if (endpoint === 'discover') return jsonResponse(octenDiscovery());
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    if (endpoint === 'run') {
      runs += 1;
      return jsonResponse(completedSearch(calls.at(-1).body.input.query, String(runs)));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const query = 'York County South Carolina current utility tap fees';
  const first = await monid.monidSearchBatchWithKey('monid-test-key', [query], { fetchImpl });
  const second = await monid.monidSearchBatchWithKey('monid-test-key', [query], { fetchImpl });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'discover').length, 0);
  assert.equal(calls.filter((call) => call.endpoint === 'inspect').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'run').length, 2);
  assert.notEqual(first[0].url, second[0].url, 'the repeated query used a fresh provider run');

  const run = calls.find((call) => call.endpoint === 'run');
  assert.equal(run.body.provider, 'octen');
  assert.equal(run.body.endpoint, '/search');
  assert.equal(run.body.input.query, query);
  assert.equal(run.body.input.count, 8);
  assert.ok(run.body.input.exclude_domains.includes('reddit.com'));
  assert.deepEqual(run.body.input.highlight, { format: 'markdown' });
  assert.ok(calls.every((call) => call.init.cache === 'no-store'));
  assert.ok(calls.every((call) => new Headers(call.init.headers).get('authorization') === 'Bearer monid-test-key'));
  assert.ok(calls.every((call) => new Headers(call.init.headers).get('x-monid-key') === 'monid-test-key'));
});

test('Monid key validation checks wallet and search readiness without a paid run', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    calls.push({ endpoint, init });
    if (endpoint === 'wallet') {
      return jsonResponse(
        { balance: { value: 2.85, currency: 'USD' } },
        200,
        { 'x-request-id': 'req-wallet-ready' },
      );
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery());
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey('monid-live-ready', { fetchImpl });

  assert.equal(result.valid, true);
  assert.equal(result.searchReady, true);
  assert.equal(result.balanceUsd, 2.85);
  assert.equal(result.provider, 'Octen');
  assert.equal(result.maxResultsPerQuery, 8);
  assert.equal(result.estimatedPriceUsd, 0.002);
  assert.equal(result.requestId, 'req-wallet-ready');
  assert.match(result.message, /Monid is connected to Octen/);
  assert.deepEqual(result.octenCapabilities, {
    search: true,
    'broad-search': true,
    extract: true,
    embedding: true,
  });
  assert.deepEqual(calls.map((call) => call.endpoint), [
    'wallet',
    'inspect',
    'inspect',
    'inspect',
    'inspect',
  ]);
  assert.doesNotMatch(calls.map((call) => call.endpoint).join(','), /run/);
});

test('Monid normalizes micro-dollar Octen prices before checking a $15 wallet', async () => {
  monid.resetMonidSearchToolCache();
  monid.resetMonidBudgetSession();
  const calls = [];
  const price = {
    type: 'PER_CALL',
    amount: 25_000,
    unit: 'MICRO_DOLLAR',
    currency: 'USD',
  };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, body });
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 15, currency: 'USD' } });
    }
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      return jsonResponse(completedSearch(body.input.query, '', 0.025));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const validation = await monid.validateMonidApiKey(
    'monid-micro-dollar-key',
    { fetchImpl, budgetMode: 'adaptive' },
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.searchReady, true);
  assert.equal(validation.balanceUsd, 15);
  assert.equal(validation.endpoint, '/search');
  assert.equal(validation.estimatedPriceUsd, 0.025);
  assert.match(validation.message, /estimated run cost: \$0\.025/i);

  monid.beginMonidBudgetSession('property:micro-dollar', 'adaptive');
  const results = await monid.monidSearchBatchWithKey(
    'monid-micro-dollar-key',
    ['York County South Carolina current permit fees'],
    { fetchImpl },
  );
  const snapshot = monid.getMonidBudgetSnapshot();
  assert.equal(results.length, 1);
  assert.equal(snapshot.walletBalanceUsd, 15);
  assert.equal(snapshot.actualSpentUsd, 0.025);
  assert.equal(calls.filter((call) => call.endpoint === 'run').length, 1);
  monid.resetMonidBudgetSession();
});

test('Monid browser requests preserve the fetch receiver', async () => {
  monid.resetMonidSearchToolCache();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function boundBrowserFetch(url, init) {
    assert.equal(this, globalThis, 'window.fetch must not be invoked with the request options as its receiver');
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    calls.push(endpoint);
    if (endpoint === 'wallet') return jsonResponse({ balance: { value: 1.25, currency: 'USD' } });
    if (endpoint === 'discover') return jsonResponse(octenDiscovery());
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    throw new Error(`Validation must not execute ${endpoint}`);
  };
  try {
    const result = await monid.validateMonidApiKey('monid-browser-key');
    assert.equal(result.searchReady, true);
    assert.deepEqual(calls, ['wallet', 'inspect', 'inspect', 'inspect', 'inspect']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Monid key validation surfaces authentication and wallet failures', async () => {
  monid.resetMonidSearchToolCache();
  const invalid = await monid.validateMonidApiKey('bad-key', {
    fetchImpl: async () => jsonResponse(
      { code: 401, message: 'Invalid API key' },
      401,
      { 'x-request-id': 'req-invalid-key' },
    ),
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.status, 401);
  assert.match(invalid.message, /rejected this API key/i);
  assert.match(invalid.message, /req-invalid-key/);

  const emptyWallet = await monid.validateMonidApiKey('valid-empty-wallet', {
    fetchImpl: async () => jsonResponse({ balance: { value: 0, currency: 'USD' } }),
  });
  assert.equal(emptyWallet.valid, true);
  assert.equal(emptyWallet.searchReady, false);
  assert.match(emptyWallet.message, /balance is \$0\.00/i);
});

test('Monid shrinks per-result searches to stay within the safety cap', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const price = { type: 'PER_RESULT', amount: 0.01, flatFee: 0, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, init, body });
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      return jsonResponse(completedSearch(body.input.query));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const results = await monid.monidSearchBatchWithKey(
    'monid-price-cap-key',
    ['current county permit fees'],
    { fetchImpl, maxResultsPerQuery: 8, maxPriceUsd: 0.05 },
  );

  assert.equal(results.length, 1);
  assert.deepEqual(calls.map((call) => call.endpoint), ['inspect', 'run']);
  assert.equal(calls.find((call) => call.endpoint === 'run').body.input.count, 5);
});

test('Monid validation accepts an affordable reduced result count', async () => {
  monid.resetMonidSearchToolCache();
  const price = { type: 'PER_RESULT', amount: 0.01, flatFee: 0, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'wallet') return jsonResponse({ balance: { value: 1, currency: 'USD' } });
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey('monid-adaptive-price-key', { fetchImpl });

  assert.equal(result.valid, true);
  assert.equal(result.searchReady, true);
  assert.equal(result.maxResultsPerQuery, 5);
  assert.equal(result.estimatedPriceUsd, 0.05);
  assert.match(result.message, /up to 5 results per query/i);
  assert.equal(result.budgetMode, 'adaptive');
  assert.equal(result.totalBudgetUsd, 1);
  assert.match(result.message, /soft target: \$0\.05/i);
  assert.match(result.message, /property research budget: \$1\.00/i);
});

test('Monid still rejects a per-call tool that exceeds the safety cap', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const price = { type: 'PER_CALL', amount: 0.06, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    calls.push(endpoint);
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    throw new Error(`The over-cap tool should not reach ${endpoint}`);
  };

  const results = await monid.monidSearchBatchWithKey(
    'monid-over-cap-key',
    ['current county permit fees'],
    { fetchImpl, maxResultsPerQuery: 8, maxPriceUsd: 0.05 },
  );

  assert.deepEqual(results, []);
  assert.deepEqual(calls, ['inspect', 'inspect']);
});

test('a transient Octen catalog failure is not cached', async () => {
  monid.resetMonidSearchToolCache();
  let unavailable = true;
  let discoveryCalls = 0;
  let inspectionCalls = 0;
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'discover') {
      discoveryCalls += 1;
      return unavailable
        ? jsonResponse({ error: 'temporary' }, 503)
        : jsonResponse(octenDiscovery());
    }
    if (endpoint === 'inspect') {
      inspectionCalls += 1;
      return unavailable
        ? jsonResponse({ error: 'temporary' }, 503)
        : jsonResponse(inspectedOctenRequest(init));
    }
    if (endpoint === 'run') {
      const input = JSON.parse(init.body).input;
      return jsonResponse(completedSearch(input.query));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const first = await monid.monidSearchBatchWithKey('monid-retry-key', ['county water rates'], { fetchImpl });
  unavailable = false;
  const second = await monid.monidSearchBatchWithKey('monid-retry-key', ['county water rates'], { fetchImpl });

  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.ok(discoveryCalls >= 1);
  assert.ok(inspectionCalls >= 2);
});

test('Adaptive validation accepts a provider above the initial address budget', async () => {
  monid.resetMonidSearchToolCache();
  const price = { type: 'PER_CALL', amount: 0.20, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 1, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey(
    'monid-no-fixed-ceiling-validation-key',
    { fetchImpl, budgetMode: 'adaptive' },
  );

  assert.equal(result.valid, true);
  assert.equal(result.searchReady, true);
  assert.equal(result.estimatedPriceUsd, 0.20);
  assert.equal(result.totalBudgetUsd, 1);
  assert.match(result.message, /no fixed provider ceiling/i);
  assert.match(result.message, /wallet is the final limit/i);
});

test('Adaptive validation still rejects a provider that exceeds the wallet balance', async () => {
  monid.resetMonidSearchToolCache();
  const price = { type: 'PER_CALL', amount: 1.20, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 1, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey(
    'monid-wallet-guardrail-key',
    { fetchImpl, budgetMode: 'adaptive' },
  );

  assert.equal(result.valid, true);
  assert.equal(result.searchReady, false);
  assert.match(result.message, /no Octen search run fits the available \$1\.00 wallet balance/i);
  assert.match(result.message, /least expensive published option/i);
});

test('validation falls back to affordable Broad Search when Search exceeds the wallet', async () => {
  monid.resetMonidSearchToolCache();
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 15, currency: 'USD' } });
    }
    if (endpoint === 'inspect') {
      const requested = JSON.parse(init.body).endpoint;
      const price = requested === '/search'
        ? { type: 'PER_CALL', amount: 20, currency: 'USD' }
        : { type: 'PER_CALL', amount: 0.02, currency: 'USD' };
      return jsonResponse(octenInspection(requested, price));
    }
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey(
    'monid-affordable-broad-key',
    { fetchImpl, budgetMode: 'adaptive' },
  );
  assert.equal(result.valid, true);
  assert.equal(result.searchReady, true);
  assert.equal(result.endpoint, '/broad-search');
  assert.equal(result.estimatedPriceUsd, 0.02);
});

test('Adaptive mode uses the available wallet without a fixed provider ceiling', async () => {
  monid.resetMonidSearchToolCache();
  monid.resetMonidBudgetSession();
  const calls = [];
  const price = { type: 'PER_CALL', amount: 0.20, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(endpoint);
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 1, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      return jsonResponse(completedSearch(body.input.query, '', 0.20));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  monid.beginMonidBudgetSession('property:adaptive', 'adaptive');
  const results = await monid.monidSearchBatchWithKey(
    'monid-adaptive-key',
    ['York County current water tap fees'],
    { fetchImpl },
  );
  const snapshot = monid.getMonidBudgetSnapshot();

  assert.equal(results.length, 1);
  assert.deepEqual(calls, ['wallet', 'inspect', 'inspect', 'run']);
  assert.equal(snapshot.mode, 'adaptive');
  assert.equal(snapshot.walletBalanceUsd, 1);
  assert.equal(snapshot.totalBudgetUsd, 1);
  assert.equal(snapshot.actualSpentUsd, 0.20);
  assert.equal(snapshot.estimatedSpentUsd, 0);
  assert.equal(snapshot.remainingUsd, 0.80);
  assert.equal(snapshot.runsCompleted, 1);
  assert.equal(snapshot.skippedQueries, 0);
  monid.resetMonidBudgetSession();
});

test('the wallet guardrail reserves concurrent runs and skips queries that do not fit', async () => {
  monid.resetMonidSearchToolCache();
  monid.resetMonidBudgetSession();
  const price = { type: 'PER_CALL', amount: 0.06, currency: 'USD' };
  let runCalls = 0;
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 0.12, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      runCalls += 1;
      return jsonResponse(completedSearch(body.input.query, String(runCalls), 0.06));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  monid.beginMonidBudgetSession('property:shared', 'adaptive');
  const results = await monid.monidSearchBatchWithKey(
    'monid-shared-budget-key',
    ['county water rates', 'county sewer tap fees', 'county building permit fees'],
    { fetchImpl },
  );
  const snapshot = monid.getMonidBudgetSnapshot();

  assert.equal(results.length, 2);
  assert.equal(runCalls, 2);
  assert.equal(snapshot.totalBudgetUsd, 0.12);
  assert.equal(snapshot.actualSpentUsd, 0.12);
  assert.equal(snapshot.remainingUsd, 0);
  assert.equal(snapshot.runsCompleted, 2);
  assert.equal(snapshot.skippedQueries, 1);
  monid.resetMonidBudgetSession();
});

test('async runs reconcile the documented dollar cost returned by GET /v1/runs/:runId', async () => {
  monid.resetMonidSearchToolCache();
  monid.resetMonidBudgetSession();
  const price = { type: 'PER_CALL', amount: 0.07, currency: 'USD' };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(endpoint);
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 0.10, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      return jsonResponse({
        runId: '01HXYZ1234567890ABCDEF',
        provider: 'exa',
        endpoint: '/search',
        status: 'RUNNING',
        price,
      }, 202);
    }
    if (endpoint === 'runs') {
      const completed = completedSearch('York County sewer tap fees');
      delete completed.billing;
      completed.cost = { value: 0.07, currency: 'USD' };
      return jsonResponse(completed);
    }
    throw new Error(`Unexpected endpoint: ${endpoint} ${body ? JSON.stringify(body) : ''}`);
  };

  monid.beginMonidBudgetSession('property:async-cost', 'adaptive');
  const results = await monid.monidSearchBatchWithKey(
    'monid-async-cost-key',
    ['York County sewer tap fees'],
    { fetchImpl },
  );
  const snapshot = monid.getMonidBudgetSnapshot();

  assert.equal(results.length, 1);
  assert.deepEqual(calls, ['wallet', 'inspect', 'inspect', 'run', 'runs']);
  assert.equal(snapshot.actualSpentUsd, 0.07);
  assert.equal(snapshot.estimatedSpentUsd, 0);
  assert.equal(snapshot.remainingUsd, 0.03);
  monid.resetMonidBudgetSession();
});

test('Economy rejects an expensive provider while Thorough can use it', async () => {
  const price = { type: 'PER_CALL', amount: 0.06, currency: 'USD' };
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    if (endpoint === 'wallet') {
      return jsonResponse({ balance: { value: 1, currency: 'USD' } });
    }
    if (endpoint === 'discover') return jsonResponse(octenDiscovery(price));
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init, price));
    if (endpoint === 'run') {
      return jsonResponse(completedSearch(body.input.query, '', 0.06));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  monid.resetMonidSearchToolCache();
  monid.resetMonidBudgetSession();
  monid.beginMonidBudgetSession('property:economy', 'economy');
  const economyResults = await monid.monidSearchBatchWithKey(
    'monid-mode-economy-key',
    ['county utility fees'],
    { fetchImpl },
  );
  assert.deepEqual(economyResults, []);
  assert.equal(monid.getMonidBudgetSnapshot().skippedQueries, 1);

  monid.resetMonidSearchToolCache();
  monid.beginMonidBudgetSession('property:thorough', 'thorough');
  const thoroughResults = await monid.monidSearchBatchWithKey(
    'monid-mode-thorough-key',
    ['county utility fees'],
    { fetchImpl },
  );
  const thoroughSnapshot = monid.getMonidBudgetSnapshot();
  assert.equal(thoroughResults.length, 1);
  assert.equal(thoroughSnapshot.totalBudgetUsd, 1);
  assert.equal(thoroughSnapshot.actualSpentUsd, 0.06);
  monid.resetMonidBudgetSession();
});

test('hard research uses Octen Broad Search with documented search options', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, body });
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    if (endpoint === 'run') {
      return jsonResponse({
        ...completedSearch(body.input.query, '', 0.002, '/broad-search'),
        output: {
          data: {
            search_results: [{
              query: 'York County official fee schedule',
              results: [{
                title: 'Official York County fee schedule',
                url: 'https://www.yorkcountygov.com/fees',
                highlight: 'Current county utility and permit fee evidence.',
                full_content: 'Full official fee schedule content used for the hard research pass.',
                time_published: '2026-06-01T00:00:00Z',
              }],
            }],
          },
        },
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const results = await monid.monidSearchBatchWithKey(
    'monid-octen-broad-key',
    ['York County South Carolina utility and permit fees'],
    {
      fetchImpl,
      strategy: 'broad',
      maxResultsPerQuery: 9,
      maxPriceUsd: 0.05,
    },
  );

  assert.equal(results.length, 1);
  assert.match(results[0].snippet, /Full official fee schedule content/);
  const run = calls.find((call) => call.endpoint === 'run');
  assert.equal(run.body.provider, 'octen');
  assert.equal(run.body.endpoint, '/broad-search');
  assert.equal(run.body.input.max_queries, 3);
  assert.equal(run.body.input.search_options.count, 8);
  assert.ok(run.body.input.search_options.exclude_domains.includes('reddit.com'));
  assert.deepEqual(run.body.input.search_options.language, ['en']);
});

test('Octen Extract reads selected pages with bounded fresh extraction settings', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ endpoint, body, init });
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    if (endpoint === 'run') {
      return jsonResponse({
        runId: '01HXYZ1234567890ABCDEE',
        provider: 'octen',
        endpoint: '/extract',
        status: 'COMPLETED',
        output: {
          data: {
            results: [{
              status: 'success',
              title: 'Official zoning ordinance',
              url: 'https://www.city.gov/zoning.pdf?utm_source=test',
              full_content: '# Zoning ordinance\nR-15 district standards and setbacks.',
              highlights: ['R-15 district standards'],
              time_published: '2025-11-12T00:00:00Z',
            }],
          },
        },
        billing: {
          actualCost: { value: 2000, unit: 'MICRO_DOLLAR', currency: 'USD' },
        },
        providerResponse: { httpStatus: 200 },
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const results = await monid.monidExtractUrlsWithKey(
    'monid-octen-extract-key',
    ['https://www.city.gov/zoning.pdf?utm_source=test'],
    '21 Magnolia Street York South Carolina zoning',
    { fetchImpl, maxPriceUsd: 0.05 },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.city.gov/zoning.pdf');
  assert.match(results[0].content, /R-15 district standards/);
  const run = calls.find((call) => call.endpoint === 'run');
  assert.equal(run.body.endpoint, '/extract');
  assert.equal(run.body.input.max_age_seconds, 300);
  assert.equal(run.body.input.format, 'markdown');
  assert.equal(run.body.input.include_images, false);
  assert.match(run.body.input.query, /21 Magnolia Street/);
  assert.ok(calls.every((call) => call.init.cache === 'no-store'));
});

test('noisy broad results use Octen Embedding for semantic reranking', async () => {
  monid.resetMonidSearchToolCache();
  const runBodies = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    const body = init.body ? JSON.parse(init.body) : null;
    if (endpoint === 'inspect') return jsonResponse(inspectedOctenRequest(init));
    if (endpoint === 'run') {
      runBodies.push(body);
      if (body.endpoint === '/broad-search') {
        return jsonResponse({
          ...completedSearch(body.input.query, '', 0.002, '/broad-search'),
          output: {
            data: {
              search_results: [{
                query: 'generated angle',
                results: Array.from({ length: 8 }, (_, index) => ({
                  title: `Document ${index + 1}`,
                  url: `https://example.gov/document-${index + 1}`,
                  highlight: 'General reference material without lexical overlap.',
                })),
              }],
            },
          },
        });
      }
      if (body.endpoint === '/embedding') {
        const length = body.input.input.length;
        return jsonResponse({
          runId: '01HXYZ1234567890ABCDEG',
          provider: 'octen',
          endpoint: '/embedding',
          status: 'COMPLETED',
          output: {
            data: {
              results: Array.from({ length }, (_, index) => ({
                index,
                embedding: index === 0 ? [1, 0] : [index / length, 1 - (index / length)],
              })),
            },
          },
          billing: {
            actualCost: { value: 2000, unit: 'MICRO_DOLLAR', currency: 'USD' },
          },
          providerResponse: { httpStatus: 200 },
        });
      }
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const results = await monid.monidSearchBatchWithKey(
    'monid-octen-embedding-key',
    ['York County South Carolina zoning utilities permit'],
    {
      fetchImpl,
      strategy: 'broad',
      semanticRerank: true,
      maxResultsPerQuery: 8,
      maxPriceUsd: 0.05,
    },
  );

  assert.equal(results.length, 8);
  assert.equal(results[0].title, 'Document 8');
  assert.deepEqual(runBodies.map((body) => body.endpoint), ['/broad-search', '/embedding']);
  const embedding = runBodies.find((body) => body.endpoint === '/embedding');
  assert.equal(embedding.input.model, 'octen-embedding-0.6b');
  assert.equal(embedding.input.dimension, 256);
  assert.equal(embedding.input.input.length, 9);
});

test('Monid normalizes nested search output and computes a transparent quality score', () => {
  const results = monid.normalizeMonidSearchOutput({
    data: {
      searchResults: [{
        title: 'York County fee schedule',
        link: 'https://www.yorkcountygov.com/fees?utm_source=test',
        content: 'York County fee schedule and current utility connection details published by the county.',
      }, {
        title: 'Duplicate',
        url: 'https://www.yorkcountygov.com/fees',
        snippet: 'duplicate',
      }],
    },
  });
  const summary = monid.summarizeSearchQuality(results, ['York County utility fees']);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.yorkcountygov.com/fees');
  assert.equal(summary.resultCount, 1);
  assert.equal(summary.validUrlRate, 1);
  assert.ok(summary.score > 0);
});

test('Broad Search escalation is driven by evidence quality', () => {
  const queries = ['York County South Carolina official utility tap fees'];
  const strongResults = Array.from({ length: 8 }, (_, index) => ({
    title: `York County official utility fee schedule ${index + 1}`,
    url: `https://department-${index + 1}.yorkcountygov.gov/fees`,
    snippet: `York County South Carolina official utility tap fee schedule with current water, sewer, permit, effective-date, and source details. ${'Evidence '.repeat(8)}`,
  }));
  const weakResults = strongResults.slice(0, 2).map((result) => ({
    ...result,
    snippet: 'Brief result without enough source detail.',
  }));

  assert.equal(monid.shouldEscalateToBroadSearch(strongResults, queries, true), false);
  assert.equal(monid.shouldEscalateToBroadSearch(weakResults, queries, false), true);
});

test('Monid Netlify proxy validates auth and forwards allowed endpoints with no-store', async () => {
  const missing = await handler({
    httpMethod: 'POST',
    headers: {},
    queryStringParameters: { endpoint: 'discover' },
    body: '{}',
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.headers['Cache-Control'], 'no-store');

  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init });
    return jsonResponse({ results: [] });
  };
  try {
    const discover = await handler({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer monid-proxy-key' },
      queryStringParameters: { endpoint: 'discover' },
      body: JSON.stringify({ query: 'web search', limit: 5 }),
    });
    const runs = await handler({
      httpMethod: 'GET',
      headers: { Authorization: 'Bearer monid-proxy-key' },
      queryStringParameters: { endpoint: 'runs', runId: '01HXYZ1234567890ABCDEF' },
    });
    const wallet = await handler({
      httpMethod: 'GET',
      headers: { 'x-monid-key': 'monid-proxy-key' },
      queryStringParameters: { endpoint: 'wallet' },
    });

    assert.equal(discover.statusCode, 200);
    assert.equal(runs.statusCode, 200);
    assert.equal(wallet.statusCode, 200);
    assert.equal(captured[0].url, 'https://api.monid.ai/v1/discover');
    assert.equal(captured[1].url, 'https://api.monid.ai/v1/runs/01HXYZ1234567890ABCDEF');
    assert.equal(captured[2].url, 'https://api.monid.ai/v1/wallet/balance');
    assert.equal(captured[0].init.headers.Authorization, 'Bearer monid-proxy-key');
    assert.equal(captured[2].init.headers.Authorization, 'Bearer monid-proxy-key');
    assert.equal(captured[0].init.cache, 'no-store');
    assert.equal(captured[1].init.cache, 'no-store');
    assert.equal(captured[2].init.cache, 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Monid proxy blocks unapproved endpoint and malformed run IDs', async () => {
  const unknown = await handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer test-key' },
    queryStringParameters: { endpoint: 'admin' },
    body: '{}',
  });
  const invalidRun = await handler({
    httpMethod: 'GET',
    headers: { authorization: 'Bearer test-key' },
    queryStringParameters: { endpoint: 'runs', runId: '../../wallet' },
  });

  assert.equal(unknown.statusCode, 400);
  assert.equal(invalidRun.statusCode, 400);
});

test('application wiring uses Octen for non-zoning research and preserves Gemini zoning', async () => {
  const feasibility = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../../../src/components/SettingsDrawer.tsx', import.meta.url), 'utf8');
  const zoning = await readFile(new URL('../../../src/services/geminiZoningSearch.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

  assert.match(source, /endpoint: '\/search'/);
  assert.match(source, /endpoint: '\/broad-search'/);
  assert.match(source, /endpoint: '\/extract'/);
  assert.match(source, /endpoint: '\/embedding'/);
  assert.match(feasibility, /strategy: 'broad'/);
  assert.match(feasibility, /strategy: 'search'/);
  assert.match(feasibility, /monidExtractUrlsWithKey/);
  assert.match(feasibility, /opts\?\.mode === 'hard'/);
  assert.match(feasibility, /Promise\.all\(\[\s*perplexitySearchBatch[\s\S]*monidSearchBatch/);
  assert.match(feasibility, /shouldEscalateToBroadSearch\(combined, queries, true\)/);
  assert.match(feasibility, /compactBroadResearchQuery\(queries\)/);
  assert.doesNotMatch(
    feasibility,
    /Promise\.all\(\[\s*crawleeScrapeBatch[\s\S]*octenExtractBatch/,
  );
  assert.match(settings, /monid: monidKey\.trim\(\)/);
  assert.match(settings, /validateMonidApiKey\(monidKey, \{ budgetMode: monidBudgetMode \}\)/);
  assert.match(source, /economy:\s*\{[\s\S]*adaptive:\s*\{[\s\S]*thorough:\s*\{/);
  assert.match(settings, /Object\.keys\(MONID_BUDGET_PROFILES\)/);
  assert.match(feasibility, /beginMonidBudgetSession\(sessionId, getMonidBudgetMode\(\)\)/);
  assert.match(settings, /'Test key'/);
  assert.match(vite, /https:\/\/api\.monid\.ai/);
  assert.match(vite, /\/v1\/wallet\/balance/);
  // Zoning stays on Gemini (never Monid/Octen) AND keeps a fallback model — a
  // single-model list previously left the zoning card blank whenever that one
  // model returned an unusable answer.
  assert.match(zoning, /GEMINI_ZONING_MODELS = \[[^\]]*'gemini-3-flash-preview'[^\]]*\]/);
  assert.match(zoning, /GEMINI_ZONING_MODELS = \[[^\]]*'gemini-3\.6-flash'[^\]]*\]/);
  assert.doesNotMatch(zoning, /monid|octen/i);
});
