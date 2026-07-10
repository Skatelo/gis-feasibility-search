import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import { CheerioCrawler } from '@crawlee/cheerio';
import { Configuration, NonRetryableError } from '@crawlee/core';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import readXlsxFile from 'read-excel-file/node';

const DEFAULT_MAX_PAGES = 12;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_CHARS = 14_000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const DOCUMENT_EXT_RE = /\.(?:pdf|docx|xlsx|csv|txt|json|xml)(?:$|[?#])/i;
const RELEVANT_LINK_RE = /\b(zoning|ordinance|code|fee|permit|planning|parcel|gis|utility|utilities|water|sewer|setback|district|schedule|rate|standard|development|document|download|application|form)\b/i;
const BLOCKED_HOST_RE = /(^|\.)(?:localhost|localhost\.localdomain|local|internal|home|lan)$/i;

export function cleanText(value, maxChars = DEFAULT_MAX_CHARS) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return normalized.startsWith('2001:db8:');
}

export function validateUrlSyntax(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new NonRetryableError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new NonRetryableError('Only HTTP(S) URLs are allowed');
  if (url.username || url.password) throw new NonRetryableError('Credentialed URLs are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || BLOCKED_HOST_RE.test(hostname) || hostname === '169.254.169.254') {
    throw new NonRetryableError('Private hosts are not allowed');
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new NonRetryableError('Private addresses are not allowed');
  url.hash = '';
  return url;
}

export async function assertPublicUrl(value, allowPrivateHosts = false) {
  const url = validateUrlSyntax(value);
  if (allowPrivateHosts) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return url;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new NonRetryableError('URL resolves to a private address');
  }
  return url;
}

function documentKind(url, mimeType) {
  const pathname = new URL(url).pathname.toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('html') || mime.includes('xhtml')) return '';
  if (mime.includes('pdf') || pathname.endsWith('.pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || pathname.endsWith('.docx')) return 'docx';
  if (mime.includes('spreadsheetml') || pathname.endsWith('.xlsx')) return 'xlsx';
  if (mime.includes('json') || pathname.endsWith('.json')) return 'json';
  if (mime.includes('csv') || pathname.endsWith('.csv')) return 'csv';
  if (mime.startsWith('text/') || mime.includes('xml') || /\.(?:txt|xml)$/.test(pathname)) return 'text';
  return '';
}

export async function extractDocumentText(buffer, kind, maxChars = DEFAULT_MAX_CHARS, queryTerms = []) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new NonRetryableError('Document exceeds the 12 MB extraction limit');

  if (kind === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return selectRelevantExcerpt(cleanText(result.text, 300_000), queryTerms, maxChars);
    } finally {
      await parser.destroy();
    }
  }
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return selectRelevantExcerpt(cleanText(result.value, 300_000), queryTerms, maxChars);
  }
  if (kind === 'xlsx') {
    const sheets = await readXlsxFile(buffer);
    const text = cleanText(sheets.map((sheet) => [
      `[Sheet: ${sheet.sheet}]`,
      ...sheet.data.map((row) => row.map((cell) => cell == null ? '' : String(cell)).join('\t')),
    ].join('\n')).join('\n\n'), 300_000);
    return selectRelevantExcerpt(text, queryTerms, maxChars);
  }
  if (kind === 'json') {
    const raw = buffer.toString('utf8');
    try { return cleanText(JSON.stringify(JSON.parse(raw), null, 2), maxChars); } catch { return cleanText(raw, maxChars); }
  }
  return selectRelevantExcerpt(cleanText(buffer.toString('utf8'), 300_000), queryTerms, maxChars);
}

function selectRelevantExcerpt(text, queryTerms, maxChars) {
  if (text.length <= maxChars) return text;
  const domainTerms = ['zoning', 'ordinance', 'setback', 'permit', 'fee', 'utility', 'water', 'sewer', 'parcel', 'district', 'development'];
  const stopTerms = new Set(['south', 'north', 'carolina', 'county', 'city', 'current', 'official', 'local', 'search']);
  const prioritizedDomainTerms = domainTerms.filter((term) => queryTerms.some((queryTerm) => queryTerm.includes(term)));
  const specificQueryTerms = queryTerms.filter((term) => term.length >= 4 && !stopTerms.has(term) && !prioritizedDomainTerms.includes(term));
  const needles = [...new Set([...prioritizedDomainTerms, ...specificQueryTerms, ...domainTerms])];
  const lower = text.toLowerCase();
  const ranges = [];
  for (const needle of needles) {
    let from = 0;
    for (let count = 0; count < 2; count++) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const range = [Math.max(0, index - 450), Math.min(text.length, index + 950)];
      if (!ranges.some(([start, end]) => range[0] <= end && range[1] >= start)) ranges.push(range);
      from = index + needle.length;
    }
  }
  let excerpt = text.slice(0, Math.min(700, maxChars));
  for (const [start, end] of ranges) {
    if (excerpt.length >= maxChars) break;
    excerpt += `\n\n...\n\n${text.slice(start, end)}`;
  }
  return cleanText(excerpt, maxChars);
}

function extractHtmlText($, maxChars, queryTerms) {
  $('script,style,noscript,svg,canvas,nav,footer,form,iframe,[role="navigation"],.nav,#nav,.menu,#menu,.sidebar,#sidebar,.breadcrumbs,.breadcrumb').remove();
  const rootSelectors = ['main', '[role="main"]', 'article', '#main-content', '.main-content', '#content', '.content', '#main', '.main'];
  const root = rootSelectors.map((selector) => $(selector).first()).find((candidate) => candidate.length) || $('body');
  root.find('br').replaceWith('\n');
  root.find('h1,h2,h3,h4,h5,h6,p,li,tr,section,div').each((_, element) => {
    $(element).append('\n');
  });
  const fullText = cleanText(root.text(), 300_000);
  return selectRelevantExcerpt(fullText, queryTerms, maxChars);
}

function titleFromUrl(url) {
  const filename = decodeURIComponent(path.basename(new URL(url).pathname || ''));
  return filename || new URL(url).hostname;
}

function shouldFollowLink(href, anchorText, sourceUrl, queryTerms) {
  let target;
  try { target = validateUrlSyntax(new URL(href, sourceUrl).href); } catch { return false; }
  const source = new URL(sourceUrl);
  if (target.origin !== source.origin) return false;
  const haystack = `${target.pathname} ${target.search} ${anchorText}`.toLowerCase();
  return DOCUMENT_EXT_RE.test(target.href)
    || RELEVANT_LINK_RE.test(haystack)
    || queryTerms.some((term) => term.length >= 4 && haystack.includes(term));
}

function dedupeUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    try {
      const url = validateUrlSyntax(value).href;
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    } catch { /* invalid or unsafe URL */ }
  }
  return urls;
}

function discoverPageLinks($, sourceUrl) {
  const links = [];
  $('a[href],script[src]').each((_, element) => {
    const value = $(element).attr('href') || $(element).attr('src');
    if (!value) return;
    try { links.push(new URL(value, sourceUrl).href); } catch { /* malformed link */ }
  });
  return dedupeUrls(links).slice(0, 300);
}

function discoverGisEndpoints($, sourceUrl) {
  const html = $.html() || '';
  const candidates = html.match(/https?:\\?\/\\?\/[^"'<>\s]+?(?:MapServer|FeatureServer)(?:\/\d+)?/gi) || [];
  return dedupeUrls(candidates.map((value) => value.replace(/\\\//g, '/')))
    .filter((value) => /^https:/i.test(value) && value !== sourceUrl)
    .slice(0, 100);
}

export async function crawlSources({
  urls,
  queries = [],
  maxPages = DEFAULT_MAX_PAGES,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxCharsPerPage = DEFAULT_MAX_CHARS,
  allowPrivateHosts = false,
} = {}) {
  const startedAt = Date.now();
  const seeds = dedupeUrls(Array.isArray(urls) ? urls.slice(0, 24) : []).slice(0, 12);
  if (!seeds.length) throw new NonRetryableError('At least one valid public URL is required');

  const pageLimit = Math.min(24, Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES));
  const depthLimit = Math.min(2, Math.max(0, Number(maxDepth) || 0));
  const charLimit = Math.min(30_000, Math.max(2_000, Number(maxCharsPerPage) || DEFAULT_MAX_CHARS));
  const queryTerms = [...new Set((Array.isArray(queries) ? queries.slice(0, 20) : [])
    .flatMap((query) => String(query).slice(0, 500).toLowerCase().match(/[a-z0-9]{4,}/g) || []))].slice(0, 40);
  const results = [];
  const errors = [];
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });

  const crawler = new CheerioCrawler({
    minConcurrency: 1,
    maxConcurrency: Math.min(6, pageLimit),
    maxRequestsPerCrawl: pageLimit,
    maxRequestRetries: 1,
    navigationTimeoutSecs: 8,
    requestHandlerTimeoutSecs: 12,
    respectRobotsTxtFile: true,
    additionalMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
      'application/octet-stream',
    ],
    preNavigationHooks: [async ({ request }, gotOptions) => {
      await assertPublicUrl(request.url, allowPrivateHosts);
      gotOptions.timeout = { request: 8_000 };
      gotOptions.maxRedirects = 4;
      gotOptions.headers = {
        ...gotOptions.headers,
        'user-agent': 'LandFeasibilityResearchBot/1.0 (+https://github.com/Skatelo/gis-feasibility-search)',
        accept: 'text/html,application/xhtml+xml,application/pdf,application/json,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;q=0.9,*/*;q=0.5',
      };
      const beforeRedirect = gotOptions.hooks?.beforeRedirect || [];
      gotOptions.hooks = {
        ...gotOptions.hooks,
        beforeRedirect: [
          ...beforeRedirect,
          async (updatedOptions) => { await assertPublicUrl(updatedOptions.url.toString(), allowPrivateHosts); },
        ],
      };
    }],
    async requestHandler({ request, body, contentType, $, enqueueLinks, response, json }) {
      const loadedUrl = request.loadedUrl || request.url;
      const mime = contentType?.type || response?.headers?.['content-type'] || '';
      const kind = documentKind(loadedUrl, mime);
      const byteLength = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(String(body || ''));
      if (byteLength > MAX_DOWNLOAD_BYTES) throw new NonRetryableError('Response exceeds the 12 MB extraction limit');

      let content = '';
      let title = titleFromUrl(loadedUrl);
      const resultKind = kind || 'html';
      if (kind) {
        const documentBuffer = kind === 'json' && json && typeof json === 'object'
          ? Buffer.from(JSON.stringify(json))
          : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        content = await extractDocumentText(documentBuffer, kind, charLimit, queryTerms);
      } else {
        if (!/html|xhtml/i.test(String(mime))) return;
        title = cleanText($('title').first().text() || $('h1').first().text() || title, 300);
        const links = discoverPageLinks($, loadedUrl);
        const endpoints = discoverGisEndpoints($, loadedUrl);
        const depth = Number(request.userData?.depth || 0);
        if (depth < depthLimit) {
          const anchorTextByUrl = new Map();
          $('a[href]').each((_, element) => {
            try {
              const absolute = new URL($(element).attr('href'), loadedUrl).href;
              anchorTextByUrl.set(absolute, cleanText($(element).text(), 300));
            } catch { /* ignore malformed links */ }
          });
          await enqueueLinks({
            selector: 'a[href]',
            strategy: 'same-origin',
            limit: Math.min(10, pageLimit),
            transformRequestFunction(next) {
              const anchor = anchorTextByUrl.get(next.url) || '';
              if (!shouldFollowLink(next.url, anchor, loadedUrl, queryTerms)) return false;
              next.userData = { ...next.userData, depth: depth + 1 };
              return next;
            },
          });
        }
        content = extractHtmlText($, charLimit, queryTerms);
        request.userData.discoveredLinks = links;
        request.userData.discoveredEndpoints = endpoints;
      }

      if (content.length >= (kind ? 20 : 80)) {
        results.push({
          title,
          url: loadedUrl,
          content,
          snippet: content.slice(0, 1_500),
          kind: resultKind,
          contentType: String(mime),
          date: response?.headers?.['last-modified'] || undefined,
          links: request.userData?.discoveredLinks || [],
          endpoints: request.userData?.discoveredEndpoints || [],
        });
      }
    },
    failedRequestHandler({ request }, error) {
      errors.push({ url: request.url, error: cleanText(error?.message || String(error), 300) });
    },
  }, config);

  await crawler.run(seeds.map((url) => ({ url, userData: { depth: 0 } })));
  const seen = new Set();
  const uniqueResults = results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });

  return {
    results: uniqueResults,
    errors,
    stats: {
      requested: seeds.length,
      extracted: uniqueResults.length,
      documents: uniqueResults.filter((result) => result.kind !== 'html').length,
      elapsedMs: Date.now() - startedAt,
    },
  };
}
