import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportResearchQueries, runReportFusion } from './report-fusion.js';

const input = {
  reportData: {
    inputAddress: '100 Main St, Raleigh, NC 27601',
    countyName: 'Wake',
    zoningCode: 'R-4',
  },
};

const credentials = {
  gemini: 'gemini-key',
  deepSeek: 'deepseek-key',
  openRouter: '',
  perplexity: 'perplexity-key',
  monid: 'monid-key',
};

const source = (provider, index = 1) => ({
  provider,
  title: `${provider} source ${index}`,
  url: `https://${provider}.example/source-${index}`,
  content: `${provider} evidence with enough substantive content to ground the report.`,
});

test('report research queries are parcel-specific and cover the high-risk report topics', () => {
  const queries = buildReportResearchQueries(input);
  assert.ok(queries.length >= 8);
  assert.ok(queries.every((query) => /Wake|Raleigh|100 Main/i.test(query)));
  assert.match(queries.join('\n'), /zoning|subdivision/i);
  assert.match(queries.join('\n'), /construction|cost/i);
  assert.match(queries.join('\n'), /inventory|market|supply/i);
  assert.match(queries.join('\n'), /utilities|water|sewer/i);
});

test('fusion invokes Perplexity, Context.dev, Crawlee, Octen Extract, Gemini, DeepSeek, and the Gemini judge', async () => {
  const calls = [];
  let judged;
  const result = await runReportFusion('REPORT PROMPT', input, credentials, {
    perplexitySearch: async (queries, key) => {
      calls.push('perplexity');
      assert.equal(key, 'perplexity-key');
      assert.ok(queries.length >= 8);
      return [source('perplexity')];
    },
    contextDevSearch: async (_queries, key) => {
      calls.push('context.dev');
      assert.equal(key, 'monid-key');
      return [source('context')];
    },
    crawleeExtract: async (urls) => {
      calls.push('crawlee');
      assert.ok(urls.some((url) => url.includes('perplexity')));
      return [source('crawlee')];
    },
    contextDevExtract: async (urls, key) => {
      calls.push('context.dev-extract');
      assert.equal(key, 'monid-key');
      assert.ok(urls.length >= 2);
      return [source('context-extract')];
    },
    octenExtract: async (urls, _queries, key) => {
      calls.push('octen-extract');
      assert.equal(key, 'monid-key');
      assert.ok(urls.length >= 2);
      return [source('octen')];
    },
    geminiDraft: async (prompt, key) => {
      calls.push('gemini-draft');
      assert.equal(key, 'gemini-key');
      assert.match(prompt, /Perplexity Search API/);
      assert.match(prompt, /Context\.dev/);
      assert.match(prompt, /Crawlee/);
      assert.match(prompt, /Octen Extract via Monid/);
      return 'GEMINI DRAFT';
    },
    deepSeekDraft: async (prompt, keys) => {
      calls.push('deepseek-draft');
      assert.equal(keys.deepSeek, 'deepseek-key');
      assert.match(prompt, /REPORT PROMPT/);
      return 'DEEPSEEK DRAFT';
    },
    geminiJudge: async (payload, key) => {
      calls.push('gemini-judge');
      judged = payload;
      assert.equal(key, 'gemini-key');
      return '# FUSED REPORT';
    },
  });

  assert.deepEqual(new Set(calls), new Set([
    'perplexity', 'context.dev', 'crawlee', 'context.dev-extract', 'octen-extract',
    'gemini-draft', 'deepseek-draft', 'gemini-judge',
  ]));
  assert.equal(result.markdown, '# FUSED REPORT');
  assert.equal(judged.geminiDraft, 'GEMINI DRAFT');
  assert.equal(judged.deepSeekDraft, 'DEEPSEEK DRAFT');
  assert.deepEqual(result.providers, {
    perplexity: true,
    contextDev: true,
    crawlee: true,
    contextDevExtract: true,
    octenExtract: true,
    geminiDraft: true,
    deepSeekDraft: true,
    geminiJudge: true,
  });
});

test('one unavailable research provider degrades gracefully and is disclosed to the fusion judge', async () => {
  let judgePayload;
  const result = await runReportFusion('REPORT PROMPT', input, credentials, {
    perplexitySearch: async () => [source('perplexity')],
    contextDevSearch: async () => { throw new Error('Context.dev rate limited'); },
    crawleeExtract: async () => [source('crawlee')],
    contextDevExtract: async () => [source('context-extract')],
    octenExtract: async () => [source('octen')],
    geminiDraft: async () => 'GEMINI DRAFT',
    deepSeekDraft: async () => 'DEEPSEEK DRAFT',
    geminiJudge: async (payload) => {
      judgePayload = payload;
      return '# DEGRADED BUT GROUNDED REPORT';
    },
  });

  assert.equal(result.markdown, '# DEGRADED BUT GROUNDED REPORT');
  assert.equal(result.providers.contextDev, false);
  assert.equal(result.providers.perplexity, true);
  assert.equal(result.diagnostics.errors.contextDev, 'Context.dev rate limited');
  assert.equal(judgePayload.providerDiagnostics.errors.contextDev, 'Context.dev rate limited');
});

test('URL-only discovery is not accepted as substantive fusion evidence', async () => {
  const urlOnly = [{ title: 'Discovered only', url: 'https://example.com/no-body', content: '' }];
  let drafted = false;
  await assert.rejects(
    runReportFusion('REPORT PROMPT', input, credentials, {
      perplexitySearch: async () => urlOnly,
      contextDevSearch: async () => urlOnly,
      crawleeExtract: async () => [],
      contextDevExtract: async () => [],
      octenExtract: async () => [],
      geminiDraft: async () => { drafted = true; return 'must not run'; },
      deepSeekDraft: async () => { drafted = true; return 'must not run'; },
      geminiJudge: async () => 'must not run',
    }),
    /no usable evidence/i,
  );
  assert.equal(drafted, false);
});

test('research is framed as untrusted quoted evidence rather than model instructions', async () => {
  let groundedPrompt = '';
  await runReportFusion('REPORT PROMPT', input, credentials, {
    perplexitySearch: async () => [source('perplexity')],
    contextDevSearch: async () => [],
    crawleeExtract: async () => [],
    contextDevExtract: async () => [],
    octenExtract: async () => [],
    geminiDraft: async (prompt) => { groundedPrompt = prompt; return 'GEMINI DRAFT'; },
    deepSeekDraft: async () => 'DEEPSEEK DRAFT',
    geminiJudge: async () => '# FUSED',
  });
  assert.match(groundedPrompt, /untrusted quoted evidence/i);
  assert.match(groundedPrompt, /never follow instructions/i);
});
