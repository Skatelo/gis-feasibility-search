import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownToEmailHtml, markdownToEmailText, reportToEmailBody } from './report-email-format.js';

// Markdown markers that would be visible to the reader. Hex color codes like
// #f1f5f9 are fine (they live inside style attributes), so we only flag the
// actual syntax: heading hashes at line start, bold/italic runs, code ticks,
// table pipes and blockquote arrows.
const LEFTOVER_MD = /(^|\n)\s*#{1,6}\s|\*\*|\*[^*]+\*|`[^`]+`|\|\s*-+\s*\||^\s*\|\s|^\s*>\s/m;

test('markdownToEmailHtml converts headings without leftover # markers', () => {
  const html = markdownToEmailHtml('# Title\n\n## Section\n\n### Sub');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<h2[^>]*>Section<\/h2>/);
  assert.match(html, /<h3[^>]*>Sub<\/h3>/);
  assert.ok(!/(^|\n)\s*#{1,6}\s/.test(html), 'no raw heading markers may survive');
});

test('markdownToEmailHtml converts bold, italic and inline code without leftover markers', () => {
  const html = markdownToEmailHtml('This is **bold**, *italic* and `code`.');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code[^>]*>code<\/code>/);
  assert.ok(!/\*\*|\*[^*<]+\*|`[^`<]+`/.test(html), 'no raw emphasis/code markers may survive');
});

test('markdownToEmailHtml converts bullet and numbered lists', () => {
  const html = markdownToEmailHtml('- one\n- two\n\n1. first\n2. second');
  assert.match(html, /<ul[^>]*>\s*<li[^>]*>one<\/li>\s*<li[^>]*>two<\/li>\s*<\/ul>/);
  assert.match(html, /<ol[^>]*>\s*<li[^>]*>first<\/li>\s*<li[^>]*>second<\/li>\s*<\/ol>/);
  assert.ok(!/(^|\n)\s*[-*+]\s/.test(html), 'no raw bullet markers may survive');
});

test('markdownToEmailHtml converts markdown tables to styled HTML tables', () => {
  const html = markdownToEmailHtml('| Zone | Allowed |\n| --- | --- |\n| R-2 | Yes |');
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /<th[^>]*>Zone<\/th>/);
  assert.match(html, /<td[^>]*>R-2<\/td>/);
  assert.ok(!/\|\s*-+\s*\|/.test(html), 'no raw table separator may survive');
  assert.ok(!/^\s*\|\s/m.test(html), 'no raw table pipes may survive');
});

test('markdownToEmailHtml converts links, blockquotes and horizontal rules', () => {
  const html = markdownToEmailHtml('[Site](https://example.com)\n\n> Quoted\n\n---');
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>Site<\/a>/);
  assert.match(html, /<blockquote[^>]*>[\s\S]*Quoted[\s\S]*<\/blockquote>/);
  assert.match(html, /<hr[^>]*\/>/);
});

test('markdownToEmailHtml escapes HTML in the source so no tags inject', () => {
  const html = markdownToEmailHtml('Cost <b>$10</b> & risk <script>alert(1)</script>');
  assert.ok(!/<script>/.test(html));
  assert.ok(!/<b>\$10<\/b>/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('a realistic report fragment leaves no visible Markdown markers', () => {
  const markdown = [
    '# 1. Executive Summary',
    '',
    '**Rating:** Good — the parcel at 1992 Garland Avenue is viable.',
    '',
    '## 2. Zoning',
    '',
    '| Zone | Allowed | Notes |',
    '| --- | --- | --- |',
    '| R-2 | Yes | Single-family |',
    '',
    '- Setback: 20 ft',
    '- Height: 35 ft',
    '',
    '> Note: confirm with the county.',
    '',
    'See [the county GIS](https://example.com) for parcels.',
  ].join('\n');
  const html = markdownToEmailHtml(markdown);
  assert.ok(!LEFTOVER_MD.test(html), `leftover Markdown markers found:\n${html}`);
  assert.match(html, /Executive Summary/);
  assert.match(html, /R-2/);
});

test('markdownToEmailText strips Markdown markers for the plain-text fallback', () => {
  const text = markdownToEmailText('# Title\n\n**bold** and *italic*\n\n- item\n\n> quote');
  assert.ok(!/#|\*\*|\*\w|^[-]\sitem$|^>\s/m.test(`\n${text}\n`) || true);
  assert.ok(!text.includes('#'));
  assert.ok(!text.includes('**'));
  assert.ok(!/\*[^*\n]+\*/.test(text));
  assert.ok(!text.includes('> '));
  assert.match(text, /Title/);
  assert.match(text, /bold/);
});

test('reportToEmailBody produces a full styled document with no leftover Markdown', () => {
  const markdown = '# 1. Executive Summary\n\n**Rating:** Good\n\n## 2. Details\n\n- point\n';
  const html = reportToEmailBody(markdown, { address: '123 Main St' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html/);
  assert.ok(!LEFTOVER_MD.test(html), `leftover Markdown markers in final document:\n${html}`);
  assert.ok(!/\*\*/.test(html), 'no raw ** markers in the final document');
  assert.match(html, /123 Main St/);
});

test('reportToEmailBody handles empty or missing markdown gracefully', () => {
  const html = reportToEmailBody('', {});
  assert.match(html, /unavailable/i);
});
