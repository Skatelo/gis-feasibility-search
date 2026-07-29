import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

async function loadEnvironment() {
  const loaded = {};
  for (const name of ['.env', '.env.local']) {
    try {
      const text = await readFile(join(root, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        loaded[match[1]] = value;
      }
    } catch {
      // Optional environment file.
    }
  }
  return { ...loaded, ...process.env };
}

async function loadMonidClient() {
  const source = await readFile(join(root, 'src', 'services', 'monidSearch.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

function directMonidFetch(url, init = {}) {
  const request = new URL(String(url), 'http://localhost');
  const endpoint = request.searchParams.get('endpoint');
  let target;
  if (endpoint === 'discover' || endpoint === 'inspect' || endpoint === 'run') {
    target = `https://api.monid.ai/v1/${endpoint}`;
  } else if (endpoint === 'runs') {
    const runId = request.searchParams.get('runId') || '';
    target = `https://api.monid.ai/v1/runs/${encodeURIComponent(runId)}`;
  } else {
    throw new Error(`Unsupported Monid endpoint: ${endpoint}`);
  }
  return fetch(target, init);
}

function flattenPerplexity(data) {
  const rows = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    if (typeof value.url === 'string') {
      rows.push({
        title: String(value.title || value.url),
        url: value.url,
        snippet: String(value.snippet || ''),
        date: value.date ? String(value.date) : undefined,
      });
      return;
    }
    visit(value.results);
  };
  visit(data?.results);
  return rows;
}

async function perplexitySearch(key, query) {
  const response = await fetch('https://api.perplexity.ai/search', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      country: 'US',
      max_results: 8,
      max_tokens_per_page: 1500,
      search_domain_filter: [
        '-reddit.com',
        '-pinterest.com',
        '-quora.com',
        '-x.com',
        '-facebook.com',
        '-instagram.com',
        '-tiktok.com',
        '-youtube.com',
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Perplexity HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  return flattenPerplexity(await response.json());
}

const CASES = [
  {
    name: 'SC exact parcel',
    query: '116 Wright Sims Road, Union, South Carolina 29379 parcel 049-00-00-112 000 official assessor owner acreage',
    expectedTerms: ['049-00-00-112', 'regina', '2.87'],
    preferredDomains: ['unioncountysc.gov', 'qpublic.net', 'qpaybill.com'],
  },
  {
    name: 'SC utility fees',
    query: 'York County South Carolina current residential water sewer tap connection fees official fee schedule',
    expectedTerms: ['water', 'sewer', 'fee'],
    preferredDomains: ['yorkcountygov.com', 'cityofyork.net'],
  },
  {
    name: 'NC permit fees',
    query: 'Mecklenburg County North Carolina current residential building permit fee schedule official',
    expectedTerms: ['building', 'permit', 'fee'],
    preferredDomains: ['mecknc.gov', 'charlottenc.gov'],
  },
  {
    name: 'SC septic permit',
    query: 'South Carolina current residential onsite wastewater septic system permit fee official',
    expectedTerms: ['septic', 'permit', 'fee'],
    preferredDomains: ['des.sc.gov', 'scdhec.gov'],
  },
  {
    name: 'NC erosion rules',
    query: 'North Carolina residential land clearing erosion control permit requirements official',
    expectedTerms: ['erosion', 'permit', 'land'],
    preferredDomains: ['deq.nc.gov', 'nc.gov'],
  },
];

function evidenceScore(results, searchQuality, benchmarkCase) {
  const text = results.map((result) => `${result.title} ${result.snippet} ${result.url}`).join(' ').toLowerCase();
  const expectedTermRate = benchmarkCase.expectedTerms.filter((term) => text.includes(term.toLowerCase())).length
    / benchmarkCase.expectedTerms.length;
  const preferredDomainRate = benchmarkCase.preferredDomains.some((domain) =>
    results.some((result) => {
      try {
        return new URL(result.url).hostname.toLowerCase().endsWith(domain);
      } catch {
        return false;
      }
    })) ? 1 : 0;
  return {
    expectedTermRate,
    preferredDomainRate,
    score: Math.round(searchQuality.score * 0.65 + expectedTermRate * 20 + preferredDomainRate * 15),
  };
}

async function timed(provider, benchmarkCase, run, quality) {
  const started = performance.now();
  try {
    const results = await run();
    const latencyMs = Math.round(performance.now() - started);
    const searchQuality = quality(results, [benchmarkCase.query]);
    const evidence = evidenceScore(results, searchQuality, benchmarkCase);
    return {
      case: benchmarkCase.name,
      provider,
      latencyMs,
      resultCount: results.length,
      qualityScore: searchQuality.score,
      evidenceScore: evidence.score,
      officialRate: Number(searchQuality.officialSourceRate.toFixed(2)),
      domains: searchQuality.uniqueDomains,
      expectedTermRate: Number(evidence.expectedTermRate.toFixed(2)),
      preferredDomainFound: evidence.preferredDomainRate === 1,
      topUrls: results.slice(0, 3).map((result) => result.url),
      error: '',
    };
  } catch (error) {
    return {
      case: benchmarkCase.name,
      provider,
      latencyMs: Math.round(performance.now() - started),
      resultCount: 0,
      qualityScore: 0,
      evidenceScore: 0,
      officialRate: 0,
      domains: 0,
      expectedTermRate: 0,
      preferredDomainFound: false,
      topUrls: [],
      error: String(error?.message || error),
    };
  }
}

function mean(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const env = await loadEnvironment();
const perplexityKey = env.PERPLEXITY_API_KEY || env.VITE_PERPLEXITY_API_KEY || '';
const monidKey = env.MONID_API_KEY || env.VITE_MONID_API_KEY || '';

if (!args.has('--allow-paid')) {
  console.log('Search-provider benchmark is ready but did not make paid API calls.');
  console.log('Run `npm run benchmark:search -- --allow-paid` after both API keys are configured.');
  process.exit(0);
}

if (!perplexityKey || !monidKey) {
  const missing = [
    !perplexityKey ? 'VITE_PERPLEXITY_API_KEY' : '',
    !monidKey ? 'VITE_MONID_API_KEY' : '',
  ].filter(Boolean);
  console.error(`Cannot compare both providers. Missing: ${missing.join(', ')}`);
  process.exit(2);
}

const monid = await loadMonidClient();
monid.resetMonidSearchToolCache();
const rows = [];

for (const benchmarkCase of CASES) {
  const [perplexity, monidResult] = await Promise.all([
    timed('Perplexity', benchmarkCase, () => perplexitySearch(perplexityKey, benchmarkCase.query), monid.summarizeSearchQuality),
    timed('Monid', benchmarkCase, () => monid.monidSearchBatchWithKey(monidKey, [benchmarkCase.query], {
      fetchImpl: directMonidFetch,
      maxResultsPerQuery: 8,
      maxTokensPerPage: 1500,
      maxPriceUsd: 0.05,
      timeoutMs: 30_000,
    }), monid.summarizeSearchQuality),
  ]);
  rows.push(perplexity, monidResult);
}

const summaries = ['Perplexity', 'Monid'].map((provider) => {
  const providerRows = rows.filter((row) => row.provider === provider && !row.error);
  const warmRows = provider === 'Monid' ? providerRows.slice(1) : providerRows;
  return {
    provider,
    completed: providerRows.length,
    medianLatencyMs: median(providerRows.map((row) => row.latencyMs)),
    warmMedianLatencyMs: median(warmRows.map((row) => row.latencyMs)),
    meanEvidenceScore: mean(providerRows.map((row) => row.evidenceScore)),
    meanQualityScore: mean(providerRows.map((row) => row.qualityScore)),
    meanResultCount: mean(providerRows.map((row) => row.resultCount)),
  };
});

const payload = {
  date: new Date().toISOString(),
  methodology: 'Concurrent calls; first Monid case includes tool discovery. Evidence score is a reproducible source-quality proxy, not a legal or factual truth guarantee.',
  cases: rows,
  summary: summaries,
};

if (args.has('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Search provider comparison - ${payload.date}`);
  console.log(payload.methodology);
  console.table(rows.map((row) => ({
    case: row.case,
    provider: row.provider,
    ms: row.latencyMs,
    results: row.resultCount,
    quality: row.qualityScore,
    evidence: row.evidenceScore,
    official: row.officialRate,
    domains: row.domains,
    target: row.expectedTermRate,
    preferred: row.preferredDomainFound ? 'yes' : 'no',
    error: row.error,
  })));
  console.table(summaries);
}
