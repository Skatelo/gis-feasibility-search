import assert from 'node:assert/strict';
import test from 'node:test';

import { hasUsableText, unresolvedUrls, toResult, inferKind, looksBlocked, isUsefulText } from '../crawlee.js';
import { buildUrlInput, textFromMonidOutput, monidConfigured } from './monid-client.js';
import { pixelReadConfigured } from './pixel-read.js';

test('usable-text gate treats shells and boilerplate as not extracted', () => {
  assert.equal(hasUsableText({ content: 'x'.repeat(200) }), true);
  assert.equal(hasUsableText({ content: 'x'.repeat(199) }), false);
  assert.equal(hasUsableText({ content: '   ' }), false);
  assert.equal(hasUsableText({}), false);
  assert.equal(hasUsableText(null), false);
});

test('bot-challenge pages are rejected even though they pass the length gate', () => {
  // VERBATIM from a live Monid run against Schneider's qPublic (386 chars):
  // long enough to pass MIN_USEFUL_CHARS, but contains no real content.
  const blockPage = "# We're sorry...\n\nSorry for the Inconvenience, but the query you are trying to make looks very "
    + 'similar to an automated request made from a computer virus, spyware application or data mining software. '
    + 'To continue to protect our users, we are unable to process this request at this time. Please try again later.';
  assert.ok(blockPage.length > 200, 'fixture must be long enough to pass the length gate');
  assert.equal(looksBlocked(blockPage), true);
  assert.equal(isUsefulText(blockPage), false);
  assert.equal(hasUsableText({ content: blockPage }), false);
});

test('block detection does not reject long documents that merely mention a keyword', () => {
  const realDoc = `${'Zoning ordinance text. '.repeat(90)} The site is protected by Cloudflare.`;
  assert.ok(realDoc.length > 1500);
  assert.equal(looksBlocked(realDoc), false);
  assert.equal(isUsefulText(realDoc), true);
});

test('common challenge and shell pages are caught', () => {
  assert.equal(looksBlocked('Just a moment... enable JavaScript and cookies to continue'), true);
  assert.equal(looksBlocked('Access denied. Request blocked.'), true);
  assert.equal(looksBlocked('Please verify you are a human'), true);
  assert.equal(looksBlocked('Owner: SMITH JOHN, Parcel 123-45, 2.5 acres'), false);
});

test('only URLs without usable text fall through to the later tiers', () => {
  const requested = ['https://a.gov/one', 'https://b.gov/two', 'https://c.gov/three'];
  const results = [
    { url: 'https://a.gov/one', content: 'y'.repeat(500) }, // extracted
    { url: 'https://b.gov/two', content: 'too short' },     // shell → retry
  ];
  assert.deepEqual(unresolvedUrls(requested, results), ['https://b.gov/two', 'https://c.gov/three']);
});

test('unresolved URLs dedupe and tolerate junk input', () => {
  assert.deepEqual(unresolvedUrls(['https://a.gov', 'https://a.gov', '', null], []), ['https://a.gov']);
  assert.deepEqual(unresolvedUrls(null, null), []);
});

test('recovered text is shaped like a tier-1 result and tagged with its source', () => {
  const row = toResult('https://county.gov/parcel.pdf', '  Owner: SMITH JOHN  ', 'pixel-read');
  assert.equal(row.url, 'https://county.gov/parcel.pdf');
  assert.equal(row.content, 'Owner: SMITH JOHN');
  assert.equal(row.snippet, 'Owner: SMITH JOHN');
  assert.equal(row.kind, 'pdf');            // kind inferred, not guessed as html
  assert.equal(row.extractedVia, 'pixel-read');
});

test('document kind is inferred from the URL path, ignoring query strings', () => {
  assert.equal(inferKind('https://x.gov/a.PDF?v=2'), 'pdf');
  assert.equal(inferKind('https://x.gov/a.xlsx'), 'xlsx');
  assert.equal(inferKind('https://x.gov/a.docx'), 'docx');
  assert.equal(inferKind('https://x.gov/page'), 'html');
});

test('Monid run input adapts to the endpoint schema shape', () => {
  // Apify-style array of objects
  assert.deepEqual(
    buildUrlInput({ properties: { startUrls: { type: 'array', items: { type: 'object' } } } }, 'https://x.gov'),
    { startUrls: [{ url: 'https://x.gov' }] },
  );
  // Array of plain strings
  assert.deepEqual(
    buildUrlInput({ properties: { urls: { type: 'array', items: { type: 'string' } } } }, 'https://x.gov'),
    { urls: ['https://x.gov'] },
  );
  // Single string field
  assert.deepEqual(
    buildUrlInput({ properties: { url: { type: 'string' } } }, 'https://x.gov'),
    { url: 'https://x.gov' },
  );
  // Unknown schema falls back to the most common key rather than throwing
  assert.deepEqual(buildUrlInput(null, 'https://x.gov'), { url: 'https://x.gov' });
});

test('Monid output text extraction finds content at any nesting depth', () => {
  const output = [{ pageContent: 'A'.repeat(120), meta: { ignored: 'short' } }, { nested: { markdown: 'B'.repeat(120) } }];
  const text = textFromMonidOutput(output);
  assert.match(text, /A{120}/);
  assert.match(text, /B{120}/);
});

test('Monid output extraction ignores short strings and bad input', () => {
  assert.equal(textFromMonidOutput({ text: 'too short to be content' }), '');
  assert.equal(textFromMonidOutput(null), '');
  assert.equal(textFromMonidOutput('a string'), '');
});

test('tiers are independently optional so a missing key just skips that tier', () => {
  // No key argument and (in test env) no server key → tier 3 is skipped, not fatal.
  assert.equal(typeof pixelReadConfigured(''), 'boolean');
  assert.equal(pixelReadConfigured('some-key'), true);
  assert.equal(typeof monidConfigured(), 'boolean');
});
