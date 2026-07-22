import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const feasibilitySource = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
const finderSource = await readFile(new URL('../../../src/services/propertyFinderService.ts', import.meta.url), 'utf8');
const loadingSource = await readFile(new URL('../../../src/loading.css', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../../../src/main.tsx', import.meta.url), 'utf8');

function sourceBlock(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing source block start: ${start}`);
  assert.notEqual(to, -1, `Missing source block end: ${end}`);
  return source.slice(from, to);
}

test('every Gemini Vision path requests detailed media analysis', () => {
  const compVision = sourceBlock(feasibilitySource, 'async function geminiPickExteriorIndex', 'export async function fetchGoogleDistanceMatrixComps');
  const treeVision = sourceBlock(feasibilitySource, 'async function countTreesFromSatellite', 'interface TreeRates');
  const attachmentVision = sourceBlock(feasibilitySource, 'export async function chatWithGemini', '// EOF');
  const finderVision = sourceBlock(finderSource, 'export async function geminiVisionAnalyze', '// Scoring engine');

  for (const block of [compVision, treeVision, attachmentVision, finderVision]) {
    assert.match(block, /gemini-3\.6-flash|GEMINI_VISION_MODEL/);
    assert.match(block, /mediaResolution: 'MEDIA_RESOLUTION_HIGH'/);
  }

  assert.match(compVision, /thinkingLevel: 'high'/);
  assert.match(compVision, /slice\(0, 6\)/);
  assert.match(treeVision, /thinkingLevel: 'low'/);
  assert.match(treeVision, /4-by-4 grid/);
  assert.match(attachmentVision, /thinkingLevel: 'high'/);
  assert.match(attachmentVision, /hasVisualAttachments/);
  assert.match(finderVision, /thinkingLevel: 'high'/);
  assert.match(finderVision, /maxOutputTokens: 8192/);
  assert.doesNotMatch(`${feasibilitySource}\n${finderSource}`, /gemini-3-flash-preview/);
});

test('essential loading feedback overrides the desktop reduced-motion freeze', () => {
  assert.match(mainSource, /import '\.\/loading\.css'/);
  assert.match(loadingSource, /\.spinner[\s\S]*animation: app-loader-spin/);
  assert.match(loadingSource, /transform-box: fill-box/);
  assert.match(loadingSource, /@keyframes app-loader-sweep/);
  assert.match(loadingSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*app-loader-essential-pulse[\s\S]*!important/);
});
