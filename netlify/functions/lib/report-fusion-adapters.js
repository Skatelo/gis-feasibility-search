import { NOISE_DOMAINS } from './report-fusion.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/search';
const MONID_BASE = 'https://api.monid.ai';
const GEMINI_MODEL = 'gemini-3.6-flash';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash-0731';

function authorization(key) {
  return ['Bearer', String(key || '').trim()].join(' ');
}

async function fetchJson(fetchImpl, url, { method = 'POST', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.error || text || `HTTP ${response.status}`;
      throw new Error(`${new URL(url).hostname} HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function flattenPerplexity(payload) {
  const output = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value?.results && Array.isArray(value.results)) { value.results.forEach(walk); return; }
    if (!value || typeof value.url !== 'string') return;
    output.push({
      provider: 'Perplexity Search API',
      title: String(value.title || value.url),
      url: value.url,
      content: String(value.snippet || value.description || ''),
      date: value.date ? String(value.date) : undefined,
    });
  };
  walk(payload?.results || []);
  return output;
}

function contextSources(payload) {
  return (Array.isArray(payload?.results) ? payload.results : []).flatMap((result) => {
    if (!result?.url) return [];
    const markdown = result?.markdown?.code === 'SUCCESS' ? result.markdown.markdown : '';
    return [{
      provider: 'Context.dev',
      title: String(result.title || result.url),
      url: String(result.url),
      content: String(markdown || result.description || ''),
    }];
  });
}

function contextExtractSource(payload, fallbackUrl) {
  const data = payload?.data ?? payload?.body ?? payload;
  const markdownValue = data?.markdown;
  const markdown = typeof markdownValue === 'string'
    ? markdownValue
    : markdownValue?.markdown || data?.content || data?.text || '';
  if (!String(markdown).trim()) return null;
  return {
    provider: 'Context.dev Extract via Monid',
    title: String(data?.title || fallbackUrl),
    url: String(data?.url || fallbackUrl),
    content: String(markdown).trim(),
  };
}

function octenRows(output) {
  const root = output?.data && typeof output.data === 'object' ? output.data : output;
  return Array.isArray(root?.results) ? root.results : [];
}

function octenSources(output) {
  return octenRows(output).flatMap((row) => {
    const url = String(row?.url || '').trim();
    const status = String(row?.status || '').toLowerCase();
    const highlights = Array.isArray(row?.highlights) ? row.highlights.filter(Boolean).join('\n\n') : '';
    const content = String(row?.full_content || row?.content || row?.markdown || row?.text || row?.snippet || highlights || '').trim();
    if (!/^https?:\/\//i.test(url) || !content || (status && !['success', 'completed', 'ok'].includes(status))) return [];
    return [{
      provider: 'Octen Extract via Monid',
      title: String(row.title || url),
      url,
      content,
      date: row.time_published || row.published_date || row.date || undefined,
    }];
  });
}

function modelText(payload) {
  const gemini = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(gemini)) return gemini.map((part) => part?.text || '').join('').trim();
  return String(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '').trim();
}

async function geminiGenerate(fetchImpl, prompt, key, { temperature = 0.35, maxOutputTokens = 32_000 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const payload = await fetchJson(fetchImpl, url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    },
    timeoutMs: 180_000,
  });
  const text = modelText(payload);
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

async function completedMonidRun(fetchImpl, key, initial) {
  if (!initial?.runId) return initial;
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const run = await fetchJson(fetchImpl, `${MONID_BASE}/v1/runs/${encodeURIComponent(initial.runId)}`, {
      method: 'GET',
      headers: { Authorization: authorization(key), Accept: 'application/json' },
      timeoutMs: 15_000,
    });
    if (['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT'].includes(String(run?.status || ''))) return run;
  }
  throw new Error('Monid provider run timed out.');
}

export function createReportFusionAdapters({ fetchImpl = globalThis.fetch, crawlSources }) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (typeof crawlSources !== 'function') throw new Error('The Crawlee extractor is required.');

  return {
    async perplexitySearch(queries, key) {
      const chunks = [];
      for (let index = 0; index < queries.length; index += 5) chunks.push(queries.slice(index, index + 5));
      const settled = await Promise.allSettled(chunks.map((chunk) => fetchJson(fetchImpl, PERPLEXITY_URL, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
        body: {
          query: chunk,
          max_results: 8,
          max_tokens_per_page: 1600,
          country: 'US',
          search_domain_filter: NOISE_DOMAINS.map((domain) => `-${domain}`),
          web_search_options: { search_context_size: 'high' },
        },
        timeoutMs: 30_000,
      })));
      const sources = settled.flatMap((result) => result.status === 'fulfilled' ? flattenPerplexity(result.value) : []);
      if (!sources.length && settled.some((result) => result.status === 'rejected')) {
        throw settled.find((result) => result.status === 'rejected').reason;
      }
      return sources;
    },

    async contextDevSearch(queries, key) {
      const selected = queries.slice(0, 4);
      await fetchJson(fetchImpl, `${MONID_BASE}/v1/inspect`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
        body: { provider: 'context.dev', endpoint: '/web/search' },
        timeoutMs: 15_000,
      });
      const settled = await Promise.allSettled(selected.map(async (query) => {
        const initial = await fetchJson(fetchImpl, `${MONID_BASE}/v1/run`, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
          body: {
            provider: 'context.dev',
            endpoint: '/web/search',
            input: {
              body: {
                query: String(query).slice(0, 500),
                numResults: 10,
                country: 'us',
                queryFanout: true,
                markdownOptions: {
                  enabled: true,
                  includeLinks: true,
                  includeImages: false,
                  useMainContentOnly: true,
                  timeoutMS: 20_000,
                },
                timeoutMS: 30_000,
              },
            },
          },
          timeoutMs: 35_000,
        });
        const run = await completedMonidRun(fetchImpl, key, initial);
        if (String(run?.status || 'COMPLETED') !== 'COMPLETED') {
          throw new Error(`Context.dev via Monid ended with status ${run?.status || 'unknown'}.`);
        }
        if (Number(run?.providerResponse?.httpStatus || 200) >= 400) {
          throw new Error(`Context.dev provider HTTP ${run.providerResponse.httpStatus}.`);
        }
        return run?.output;
      }));
      const sources = settled.flatMap((result) => result.status === 'fulfilled' ? contextSources(result.value) : []);
      if (!sources.length && settled.some((result) => result.status === 'rejected')) {
        throw settled.find((result) => result.status === 'rejected').reason;
      }
      return sources;
    },

    async crawleeExtract(urls, queries) {
      if (!urls.length) return [];
      const result = await crawlSources({
        urls: urls.slice(0, 12),
        queries,
        maxPages: Math.min(18, Math.max(8, urls.length + 4)),
        maxDepth: 1,
        maxCharsPerPage: 14_000,
      });
      return (result?.results || []).map((source) => ({ ...source, provider: 'Crawlee' }));
    },

    async contextDevExtract(urls, key) {
      const selected = urls.slice(0, 8);
      if (!selected.length) return [];
      await fetchJson(fetchImpl, `${MONID_BASE}/v1/inspect`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
        body: { provider: 'context.dev', endpoint: '/web/scrape/markdown' },
        timeoutMs: 15_000,
      });
      const settled = await Promise.allSettled(selected.map(async (url) => {
        const initial = await fetchJson(fetchImpl, `${MONID_BASE}/v1/run`, {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
          body: {
            provider: 'context.dev',
            endpoint: '/web/scrape/markdown',
            input: { queryParams: { url } },
          },
          timeoutMs: 35_000,
        });
        const run = await completedMonidRun(fetchImpl, key, initial);
        if (String(run?.status || 'COMPLETED') !== 'COMPLETED') {
          throw new Error(`Context.dev Extract via Monid ended with status ${run?.status || 'unknown'}.`);
        }
        if (Number(run?.providerResponse?.httpStatus || 200) >= 400) {
          throw new Error(`Context.dev Extract provider HTTP ${run.providerResponse.httpStatus}.`);
        }
        return contextExtractSource(run?.output, url);
      }));
      const sources = settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
      if (!sources.length && settled.some((result) => result.status === 'rejected')) {
        throw settled.find((result) => result.status === 'rejected').reason;
      }
      return sources;
    },

    async octenExtract(urls, queries, key) {
      if (!urls.length) return [];
      await fetchJson(fetchImpl, `${MONID_BASE}/v1/inspect`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
        body: { provider: 'octen', endpoint: '/extract' },
        timeoutMs: 15_000,
      });
      const initial = await fetchJson(fetchImpl, `${MONID_BASE}/v1/run`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization(key) },
        body: {
          provider: 'octen',
          endpoint: '/extract',
          input: {
            urls: urls.slice(0, 12),
            query: queries.join('\n').slice(0, 500),
            max_age_seconds: 300,
            format: 'markdown',
            timeout: 25,
            include_images: false,
            include_videos: false,
            include_audio: false,
          },
        },
        timeoutMs: 35_000,
      });
      const run = await completedMonidRun(fetchImpl, key, initial);
      if (String(run?.status || 'COMPLETED') !== 'COMPLETED') {
        throw new Error(`Octen Extract ended with status ${run?.status || 'unknown'}.`);
      }
      if (Number(run?.providerResponse?.httpStatus || 200) >= 400) {
        throw new Error(`Octen Extract provider HTTP ${run.providerResponse.httpStatus}.`);
      }
      return octenSources(run?.output);
    },

    async geminiDraft(prompt, key) {
      return geminiGenerate(fetchImpl, `${prompt}\n\nPrepare your strongest complete report draft. Follow all exact numbered headings and cite evidence URLs inline.`, key);
    },

    async deepSeekDraft(prompt, credentials) {
      const nativeKey = String(credentials?.deepSeek || '').trim();
      const routedKey = String(credentials?.openRouter || '').trim();
      const useOpenRouter = !nativeKey;
      const url = useOpenRouter ? OPENROUTER_URL : DEEPSEEK_URL;
      const key = useOpenRouter ? routedKey : nativeKey;
      const body = {
        model: useOpenRouter ? OPENROUTER_MODEL : 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: 'You are the independent second analyst in a land-feasibility fusion system. Produce a complete evidence-grounded draft and challenge unsupported assumptions.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.35,
        max_tokens: 16_000,
        ...(useOpenRouter
          ? { reasoning: { enabled: false }, provider: { sort: 'throughput', allow_fallbacks: true } }
          : { thinking: { type: 'disabled' } }),
      };
      const payload = await fetchJson(fetchImpl, url, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: authorization(key),
          ...(useOpenRouter ? { 'HTTP-Referer': 'https://gis-feasibility-search.netlify.app', 'X-Title': 'GIS Feasibility Search' } : {}),
        },
        body,
        timeoutMs: 180_000,
      });
      const text = modelText(payload);
      if (!text) throw new Error('DeepSeek returned an empty response.');
      return text;
    },

    async geminiJudge(payload, key) {
      const judgePrompt = `FUSION JUDGE\n\nYou are the senior adjudicator. Reconcile the independent Gemini and DeepSeek reports into one final executive-grade land feasibility report. Preserve the exact 25 numbered headings from the report instructions. Resolve disagreements using the supplied research evidence; never average conflicting facts. Cite URLs inline. Do not mention models, provider diagnostics, or this fusion workflow in the final report. If a provider failed, do not claim its lane verified anything. Output markdown only.\n\nREPORT INSTRUCTIONS\n${payload.reportPrompt}\n\nRESEARCH EVIDENCE\n${payload.research}\n\nPROVIDER DIAGNOSTICS\n${JSON.stringify(payload.providerDiagnostics)}\n\nGEMINI DRAFT\n${payload.geminiDraft}\n\nDEEPSEEK DRAFT\n${payload.deepSeekDraft}`;
      return geminiGenerate(fetchImpl, judgePrompt, key, { temperature: 0.2, maxOutputTokens: 32_000 });
    },
  };
}
