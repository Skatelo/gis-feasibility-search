import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../../src/data/sourcedEstimate.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const estimates = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const serviceSource = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');

test('normalizes exact published amounts and source-backed ranges', () => {
  assert.deepEqual(estimates.normalizeSourcedRange(2500, undefined, undefined), {
    low: 2500,
    high: 2500,
    midpoint: 2500,
  });
  assert.deepEqual(estimates.normalizeSourcedRange(undefined, 6000, 14000), {
    low: 6000,
    high: 14000,
    midpoint: 10000,
  });
});

test('corrects reversed bounds without inventing missing prices', () => {
  assert.deepEqual(estimates.normalizeSourcedRange(undefined, 9000, 3000), {
    low: 3000,
    high: 9000,
    midpoint: 6000,
  });
  assert.deepEqual(estimates.normalizeSourcedRange(undefined, undefined, 4200), {
    low: 4200,
    high: 4200,
    midpoint: 4200,
  });
  assert.equal(estimates.normalizeSourcedRange(0, 'not-a-number', -10), null);
});

test('estimate policy requires sources and excludes alternative utility scenarios from totals', () => {
  assert.match(serviceSource, /if \(sourceUrls\.length === 0\) return \{ low: 0, high: 0, verified: false \}/);
  assert.match(serviceSource, /estimated: true, sourceUrl: sourceUrls\[0\], sourceUrls/);
  assert.match(serviceSource, /filter\(\(line\) => !line\.scenario\)/);
  assert.match(serviceSource, /pricingStatus: rates \? 'estimated' : 'unavailable'/);
  assert.match(serviceSource, /for \(let round = 0; round < 3; round\+\+\)/);
  assert.match(serviceSource, /expandedUtilityQueries/);
  assert.match(serviceSource, /utilityResearchMissing/);
  assert.match(serviceSource, /coverageStatus: missing\.length === 0 \? 'complete' : 'partial'/);
  assert.match(serviceSource, /const responseGroups = responses\.map\(flattenPplxResults\)/);
  assert.match(serviceSource, /maxScrapeTargets: Math\.min\(12, Math\.max\(8, searchQueries\.length\)\)/);
  assert.match(serviceSource, /estimateTreesFromSatellitePixels/);
  assert.match(serviceSource, /treeCountMethod: vision\.method/);
  assert.match(serviceSource, /reportData\.geometryStatus === 'stale-hidden' \? undefined : reportData\.boundaryRings/);
  assert.match(serviceSource, /new Promise<null>\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), 45_000\)\)/);
  assert.doesNotMatch(serviceSource, /UTIL_ESTIMATE|TREE_RATE_FALLBACK|CLEARING_FALLBACK/);
});
