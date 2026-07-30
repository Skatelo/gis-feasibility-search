// EXTRACTION CHAIN — every caller of the Crawlee scraper funnels through here,
// so adding the tiers in this one place upgrades every existing use.
//
//   TIER 1  Crawlee/Cheerio   fast HTTP + PDF/DOCX/XLSX parsing (unchanged)
//   TIER 2  Monid             marketplace scrape endpoint     (https://monid.ai/docs)
//   TIER 3  Pixel read        Chromium screenshot → Gemini 3.6 vision
//                             (PixelRAG's idea: https://github.com/StarTrail-org/PixelRAG)
//
// Tiers 2 and 3 run ONLY for URLs tier 1 could not extract usable text from, so
// the common path costs exactly what it did before. Each tier is independently
// optional: no Monid key skips tier 2, no Gemini key skips tier 3, and any
// failure falls through instead of breaking the crawl.

import { crawlSources } from './lib/crawlee-scraper.js';
import { monidConfigured, monidScrapeUrl } from './lib/monid-client.js';
import { pixelReadConfigured, pixelReadUrl } from './lib/pixel-read.js';

export const config = {
  path: '/.netlify/functions/crawlee',
  rateLimit: {
    windowLimit: 20,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

/** Text short enough to be boilerplate/shell is treated as "not extracted". */
const MIN_USEFUL_CHARS = 200;

export function hasUsableText(result) {
  return String(result?.content || '').trim().length >= MIN_USEFUL_CHARS;
}

/** URLs that were requested but which tier 1 could not turn into usable text. */
export function unresolvedUrls(requested, results) {
  const resolved = new Set(
    (Array.isArray(results) ? results : [])
      .filter(hasUsableText)
      .map((result) => String(result.url)),
  );
  return [...new Set((Array.isArray(requested) ? requested : []).map((u) => String(u || '').trim()).filter(Boolean))]
    .filter((url) => !resolved.has(url));
}

export function inferKind(url) {
  const path = String(url).split('?')[0].toLowerCase();
  if (path.endsWith('.pdf')) return 'pdf';
  if (path.endsWith('.docx') || path.endsWith('.doc')) return 'docx';
  if (path.endsWith('.xlsx') || path.endsWith('.xls')) return 'xlsx';
  if (path.endsWith('.csv')) return 'csv';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.txt')) return 'text';
  return 'html';
}

/** Shape recovered text into the same result object tier 1 produces, so nothing
 *  downstream needs to change. `extractedVia` is additive metadata. */
export function toResult(url, content, extractedVia) {
  const text = String(content || '').trim();
  return {
    title: url,
    url,
    content: text,
    snippet: text.slice(0, 400),
    kind: inferKind(url),
    extractedVia,
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
    const queries = Array.isArray(body.queries) ? body.queries : [];
    // The browser may pass its own Gemini key so tier 3 works even when no
    // server-side key is configured.
    const geminiKey = String(body.geminiKey || '').trim();
    // Callers can opt out of the slow tiers for latency-sensitive work.
    const allowFallbacks = body.fallbacks !== false;

    const data = await crawlSources({
      urls,
      queries,
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      maxCharsPerPage: body.maxCharsPerPage,
    });
    if (!Array.isArray(data.results)) data.results = [];

    const tiers = { crawlee: data.results.filter(hasUsableText).length, monid: 0, pixel: 0 };
    let pending = allowFallbacks ? unresolvedUrls(urls, data.results) : [];

    // TIER 2 — Monid. Sequential and capped: these are paid, sometimes async runs.
    if (pending.length && monidConfigured()) {
      const recovered = new Set();
      for (const url of pending.slice(0, 4)) {
        const text = await monidScrapeUrl(url).catch(() => '');
        if (String(text).trim().length >= MIN_USEFUL_CHARS) {
          data.results.push(toResult(url, text, 'monid'));
          recovered.add(url);
          tiers.monid += 1;
        }
      }
      pending = pending.filter((url) => !recovered.has(url));
    }

    // TIER 3 — pixel read. Browser rendering is the slowest step, so cap it hard.
    if (pending.length && pixelReadConfigured(geminiKey)) {
      for (const url of pending.slice(0, 3)) {
        const text = await pixelReadUrl(url, { queries, geminiKey }).catch(() => '');
        if (String(text).trim().length >= MIN_USEFUL_CHARS) {
          data.results.push(toResult(url, text, 'pixel-read'));
          tiers.pixel += 1;
        }
      }
    }

    // Keep stats honest now that results can come from three sources.
    const stats = {
      ...(data.stats || {}),
      extracted: data.results.filter(hasUsableText).length,
      tiers,
    };
    return json(200, { success: true, data: { ...data, stats } });
  } catch (error) {
    const message = String(error?.message || error || 'Crawl failed');
    const status = /invalid|required|allowed|private/i.test(message) ? 400 : 502;
    return json(status, { success: false, error: message.slice(0, 500) });
  }
};
