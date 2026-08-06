import test from 'node:test';
import assert from 'node:assert/strict';

import { createReportFusionAdapters } from './report-fusion-adapters.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

test('production research adapters call Perplexity, Context.dev Search/Extract, Crawlee, and Octen Extract through Monid', async () => {
  const requests = [];
  const crawls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), headers: init.headers, body });
    if (String(url) === 'https://api.perplexity.ai/search') {
      return response({ results: [{ title: 'Official ordinance', url: 'https://city.example/zoning', snippet: 'R-4 standards' }] });
    }
    if (String(url) === 'https://api.monid.ai/v1/inspect') {
      return response({ provider: body.provider, endpoint: body.endpoint, inputSchema: {} });
    }
    if (String(url) === 'https://api.monid.ai/v1/run') {
      if (body.provider === 'context.dev' && body.endpoint === '/web/scrape/markdown') {
        return response({
          status: 'COMPLETED',
          output: {
            title: 'Context extracted ordinance',
            url: body.input.queryParams.url,
            markdown: '# Context extracted ordinance\nOfficial text',
          },
        });
      }
      if (body.provider === 'context.dev') {
        return response({
          status: 'COMPLETED',
          output: { results: [{
            title: 'Fee schedule',
            url: 'https://county.example/fees',
            description: 'Permit fees',
            markdown: { code: 'SUCCESS', markdown: '# Fee schedule\nCurrent fees' },
          }] },
        });
      }
      return response({
        status: 'COMPLETED',
        output: { data: { results: [{
          status: 'success',
          title: 'Extracted page',
          url: 'https://city.example/zoning',
          highlights: ['Official extracted zoning text', 'R-4 development standards'],
        }] } },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const adapters = createReportFusionAdapters({
    fetchImpl,
    crawlSources: async (options) => {
      crawls.push(options);
      return { results: [{
        title: 'Crawled ordinance',
        url: options.urls[0],
        content: 'Crawlee body',
      }] };
    },
  });

  const perplexity = await adapters.perplexitySearch(['zoning query'], 'pplx-key');
  const context = await adapters.contextDevSearch(['fee query'], 'monid-key');
  const crawlee = await adapters.crawleeExtract(['https://city.example/zoning'], ['zoning query']);
  const contextExtract = await adapters.contextDevExtract(['https://city.example/zoning'], 'monid-key');
  const octen = await adapters.octenExtract(['https://city.example/zoning'], ['zoning query'], 'monid-key');

  assert.equal(perplexity[0].provider, 'Perplexity Search API');
  assert.equal(context[0].provider, 'Context.dev');
  assert.equal(crawlee[0].provider, 'Crawlee');
  assert.equal(contextExtract[0].provider, 'Context.dev Extract via Monid');
  assert.equal(octen[0].provider, 'Octen Extract via Monid');
  assert.match(octen[0].content, /R-4 development standards/);
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0].maxDepth, 1);

  const perplexityRequest = requests.find((request) => request.url.includes('perplexity'));
  assert.equal(perplexityRequest.headers.Authorization, ['Bearer', 'pplx-key'].join(' '));
  assert.deepEqual(perplexityRequest.body.query, ['zoning query']);
  assert.equal(perplexityRequest.body.web_search_options, undefined);
  assert.equal(perplexityRequest.body.search_context_size, undefined);
  assert.equal(requests.some((request) => request.url.includes('api.context.dev')), false);
  const contextInspect = requests.find((request) => request.url.endsWith('/inspect') && request.body.provider === 'context.dev' && request.body.endpoint === '/web/search');
  assert.deepEqual(contextInspect.body, { provider: 'context.dev', endpoint: '/web/search' });
  const contextRun = requests.find((request) => request.url.endsWith('/run') && request.body.provider === 'context.dev' && request.body.endpoint === '/web/search');
  assert.equal(contextRun.headers.Authorization, ['Bearer', 'monid-key'].join(' '));
  assert.equal(contextRun.body.input.body.markdownOptions.enabled, true);
  assert.equal(contextRun.body.input.body.tags, undefined);
  const contextExtractInspect = requests.find((request) => request.url.endsWith('/inspect') && request.body.provider === 'context.dev' && request.body.endpoint === '/web/scrape/markdown');
  assert.deepEqual(contextExtractInspect.body, { provider: 'context.dev', endpoint: '/web/scrape/markdown' });
  const contextExtractRun = requests.find((request) => request.url.endsWith('/run') && request.body.provider === 'context.dev' && request.body.endpoint === '/web/scrape/markdown');
  assert.equal(contextExtractRun.headers.Authorization, ['Bearer', 'monid-key'].join(' '));
  assert.equal(contextExtractRun.body.input.queryParams.url, 'https://city.example/zoning');
  const inspect = requests.find((request) => request.url.endsWith('/inspect') && request.body.provider === 'octen');
  assert.deepEqual(inspect.body, { provider: 'octen', endpoint: '/extract' });
  const run = requests.find((request) => request.url.endsWith('/run') && request.body.provider === 'octen');
  assert.equal(run.headers.Authorization, ['Bearer', 'monid-key'].join(' '));
  assert.equal(run.body.provider, 'octen');
  assert.equal(run.body.endpoint, '/extract');
  assert.deepEqual(run.body.input.urls, ['https://city.example/zoning']);
  assert.equal(run.body.input.format, 'markdown');
});

test('the adapter factory works with the production call shape and defaults fetch', async () => {
  const crawls = [];
  const adapters = createReportFusionAdapters({
    crawlSources: async (options) => {
      crawls.push(options);
      return { results: [{ title: 'Doc', url: options.urls[0], content: 'body' }] };
    },
  });
  assert.equal(typeof adapters.fetchImpl, 'function');
  assert.equal(typeof adapters.perplexitySearch, 'function');
  assert.equal(typeof adapters.contextDevSearch, 'function');
  assert.equal(typeof adapters.crawleeExtract, 'function');
  assert.equal(typeof adapters.contextDevExtract, 'function');
  assert.equal(typeof adapters.octenExtract, 'function');
  assert.equal(typeof adapters.geminiDraft, 'function');
  assert.equal(typeof adapters.deepSeekDraft, 'function');
  assert.equal(typeof adapters.geminiJudge, 'function');

  const crawled = await adapters.crawleeExtract(['https://city.example/ord.pdf'], ['zoning']);
  assert.equal(crawled[0].provider, 'Crawlee');
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0].maxDepth, 1);
});

test('the adapter factory rejects a completely empty configuration instead of crashing', () => {
  assert.throws(() => createReportFusionAdapters(), /crawl/i);
  assert.throws(() => createReportFusionAdapters({}), /crawl/i);
});

test('production model adapters draft with Gemini and DeepSeek then judge with Gemini', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: init.headers, body });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      const prompt = body.contents[0].parts[0].text;
      return response({ candidates: [{ content: { parts: [{ text: prompt.includes('FUSION JUDGE') ? '# FINAL' : '# GEMINI DRAFT' }] } }] });
    }
    if (String(url) === 'https://api.deepseek.com/chat/completions') {
      return response({ choices: [{ message: { content: '# DEEPSEEK DRAFT' } }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const adapters = createReportFusionAdapters({ fetchImpl, crawlSources: async () => ({ results: [] }) });

  assert.equal(await adapters.geminiDraft('grounded prompt', 'gem-key'), '# GEMINI DRAFT');
  assert.equal(await adapters.deepSeekDraft('grounded prompt', { deepSeek: 'ds-key' }), '# DEEPSEEK DRAFT');
  assert.equal(await adapters.geminiJudge({
    reportPrompt: 'report instructions',
    research: 'evidence',
    providerDiagnostics: { errors: {} },
    geminiDraft: '# GEMINI',
    deepSeekDraft: '# DEEPSEEK',
  }, 'gem-key'), '# FINAL');

  assert.equal(requests.filter((request) => request.url.includes('generativelanguage')).length, 2);
  assert.equal(requests.filter((request) => request.url.includes('deepseek.com')).length, 1);
  assert.equal(
    requests.find((request) => request.url.includes('deepseek.com')).headers.Authorization,
    ['Bearer', 'ds-key'].join(' '),
  );
  const judgeRequest = requests.filter((request) => request.url.includes('generativelanguage')).at(-1);
  assert.match(judgeRequest.body.contents[0].parts[0].text, /untrusted quoted data/i);
  assert.match(judgeRequest.body.contents[0].parts[0].text, /never follow instructions/i);
});
