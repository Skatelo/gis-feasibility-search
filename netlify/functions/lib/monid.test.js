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

function exaDiscovery(price = { type: 'PER_CALL', amount: 0.002, currency: 'USD' }) {
  return {
    results: [{
      provider: 'exa',
      providerName: 'Exa',
      endpoint: '/search',
      description: 'Semantic web search with ranked URLs, highlights, page text, and published dates',
      price,
    }],
  };
}

function exaInspection(price = { type: 'PER_CALL', amount: 0.002, currency: 'USD' }) {
  return {
    provider: 'exa',
    providerName: 'Exa',
    endpoint: '/search',
    description: 'Semantic web search with ranked URLs, highlights, page text, and published dates',
    price,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        numResults: { type: 'number' },
        excludeDomains: { type: 'array', items: { type: 'string' } },
        contents: {
          type: 'object',
          properties: {
            highlights: {
              type: 'object',
              properties: { maxCharacters: { type: 'number' } },
            },
            text: {
              type: 'object',
              properties: { maxCharacters: { type: 'number' } },
            },
          },
        },
      },
    },
  };
}

function completedSearch(query, suffix = '') {
  return {
    runId: `01HXYZ1234567890ABCDE${suffix || 'F'}`,
    provider: 'exa',
    endpoint: '/search',
    status: 'COMPLETED',
    output: {
      results: [{
        title: `Official result for ${query}`,
        url: `https://example.gov/research/${encodeURIComponent(query)}${suffix}`,
        highlights: [`Official evidence for ${query} with enough detail to exercise content coverage scoring.`],
        publishedDate: '2026-07-28T00:00:00.000Z',
      }],
    },
    providerResponse: { httpStatus: 200 },
  };
}

test('Monid search discovers and inspects once but executes every repeated search fresh', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  let runs = 0;
  const fetchImpl = async (url, init) => {
    const request = new URL(String(url), 'http://localhost');
    const endpoint = request.searchParams.get('endpoint');
    calls.push({ endpoint, init, body: init.body ? JSON.parse(init.body) : null });
    if (endpoint === 'discover') return jsonResponse(exaDiscovery());
    if (endpoint === 'inspect') return jsonResponse(exaInspection());
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
  assert.equal(calls.filter((call) => call.endpoint === 'discover').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'inspect').length, 1);
  assert.equal(calls.filter((call) => call.endpoint === 'run').length, 2);
  assert.notEqual(first[0].url, second[0].url, 'the repeated query used a fresh provider run');

  const run = calls.find((call) => call.endpoint === 'run');
  assert.equal(run.body.provider, 'exa');
  assert.equal(run.body.endpoint, '/search');
  assert.equal(run.body.input.query, query);
  assert.equal(run.body.input.numResults, 8);
  assert.ok(run.body.input.excludeDomains.includes('reddit.com'));
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
    if (endpoint === 'discover') return jsonResponse(exaDiscovery());
    if (endpoint === 'inspect') return jsonResponse(exaInspection());
    throw new Error(`Validation must not execute ${endpoint}`);
  };

  const result = await monid.validateMonidApiKey('monid-live-ready', { fetchImpl });

  assert.equal(result.valid, true);
  assert.equal(result.searchReady, true);
  assert.equal(result.balanceUsd, 2.85);
  assert.equal(result.provider, 'Exa');
  assert.equal(result.requestId, 'req-wallet-ready');
  assert.match(result.message, /Monid is connected/);
  assert.deepEqual(calls.map((call) => call.endpoint), ['wallet', 'discover', 'inspect']);
  assert.doesNotMatch(calls.map((call) => call.endpoint).join(','), /run/);
});

test('Monid browser requests preserve the fetch receiver', async () => {
  monid.resetMonidSearchToolCache();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function boundBrowserFetch(url) {
    assert.equal(this, globalThis, 'window.fetch must not be invoked with the request options as its receiver');
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    calls.push(endpoint);
    if (endpoint === 'wallet') return jsonResponse({ balance: { value: 1.25, currency: 'USD' } });
    if (endpoint === 'discover') return jsonResponse(exaDiscovery());
    if (endpoint === 'inspect') return jsonResponse(exaInspection());
    throw new Error(`Validation must not execute ${endpoint}`);
  };
  try {
    const result = await monid.validateMonidApiKey('monid-browser-key');
    assert.equal(result.searchReady, true);
    assert.deepEqual(calls, ['wallet', 'discover', 'inspect']);
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

test('Monid rejects a discovered tool whose estimated per-result cost exceeds the cap', async () => {
  monid.resetMonidSearchToolCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    calls.push({ endpoint, init });
    if (endpoint === 'discover') {
      return jsonResponse(exaDiscovery({ type: 'PER_RESULT', amount: 0.01, flatFee: 0, currency: 'USD' }));
    }
    throw new Error(`The expensive tool should not reach ${endpoint}`);
  };

  const results = await monid.monidSearchBatchWithKey(
    'monid-price-cap-key',
    ['current county permit fees'],
    { fetchImpl, maxResultsPerQuery: 8, maxPriceUsd: 0.05 },
  );

  assert.deepEqual(results, []);
  assert.deepEqual(calls.map((call) => call.endpoint), ['discover']);
});

test('a transient discovery failure is retried instead of being cached', async () => {
  monid.resetMonidSearchToolCache();
  let discoveryCalls = 0;
  const fetchImpl = async (url, init) => {
    const endpoint = new URL(String(url), 'http://localhost').searchParams.get('endpoint');
    if (endpoint === 'discover') {
      discoveryCalls += 1;
      return discoveryCalls === 1 ? jsonResponse({ error: 'temporary' }, 503) : jsonResponse(exaDiscovery());
    }
    if (endpoint === 'inspect') return jsonResponse(exaInspection());
    if (endpoint === 'run') {
      const input = JSON.parse(init.body).input;
      return jsonResponse(completedSearch(input.query));
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const first = await monid.monidSearchBatchWithKey('monid-retry-key', ['county water rates'], { fetchImpl });
  const second = await monid.monidSearchBatchWithKey('monid-retry-key', ['county water rates'], { fetchImpl });

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  assert.equal(discoveryCalls, 2);
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

test('application wiring removes Octen and preserves Gemini zoning', async () => {
  const feasibility = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../../../src/components/SettingsDrawer.tsx', import.meta.url), 'utf8');
  const zoning = await readFile(new URL('../../../src/services/geminiZoningSearch.ts', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(`${feasibility}\n${settings}\n${vite}`, /octen/i);
  assert.match(feasibility, /opts\?\.mode === 'hard'/);
  assert.match(feasibility, /Promise\.all\(\[\s*perplexitySearchBatch[\s\S]*monidSearchBatch/);
  assert.match(feasibility, /summarizeSearchQuality\(perplexityResults, queries\)/);
  assert.match(settings, /monid: monidKey\.trim\(\)/);
  assert.match(settings, /validateMonidApiKey\(monidKey\)/);
  assert.match(settings, /'Test key'/);
  assert.match(vite, /https:\/\/api\.monid\.ai/);
  assert.match(vite, /\/v1\/wallet\/balance/);
  assert.match(zoning, /GEMINI_ZONING_MODELS = \['gemini-3\.6-flash'\]/);
});
