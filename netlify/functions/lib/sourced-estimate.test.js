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
  // The research loop is bounded by a named constant rather than a literal, so
  // the pass ceiling can be tuned in one place. Assert the shape and the value
  // separately: the loop must be driven by the constant, and the constant must
  // stay small — each pass costs two searches plus a scrape sweep that can
  // escalate to paid extraction and Chromium+vision reads.
  assert.match(serviceSource, /for \(let round = 0; round < UTILITIES_RESEARCH_PASSES; round\+\+\)/);
  const passes = Number(/UTILITIES_RESEARCH_PASSES = (\d+)/.exec(serviceSource)?.[1]);
  assert.ok(passes >= 1 && passes <= 3, `UTILITIES_RESEARCH_PASSES should stay between 1 and 3, got ${passes}`);
  // The final pass widens the query net, and that must key off the constant —
  // a hardcoded round index becomes dead code whenever the ceiling changes.
  assert.match(serviceSource, /input\.round >= UTILITIES_RESEARCH_PASSES - 1 \? 20 : 16/);
  assert.match(serviceSource, /expandedUtilityQueries/);
  assert.match(serviceSource, /utilityResearchMissing/);
  // Only the cost lines that APPLY are demanded: a city-water/city-sewer parcel
  // has no well or septic cost, so requiring them made the missing-set
  // un-emptiable, burned every research pass on fees that do not exist, and
  // reported "partial" on parcels that were complete.
  assert.match(serviceSource, /function applicableUtilitySpecs/);
  assert.match(serviceSource, /if \(spec\.prefix === 'well'\) return water !== 'available'/);
  assert.match(serviceSource, /if \(spec\.prefix === 'septic'\) return sewer !== 'available'/);
  // Broad fee-schedule queries pull in neighbouring counties' official
  // schedules, which carry real dollar figures and pass every other check.
  assert.match(serviceSource, /function foreignCountySource/);
  assert.match(serviceSource, /utilityResearchMissing\(o, evidencePool, baseCounty\)/);
  assert.match(serviceSource, /coverageStatus: missing\.length === 0 \? 'complete' : 'partial'/);
  assert.match(serviceSource, /const responseGroups = responses\.map\(flattenPplxResults\)/);
  assert.match(serviceSource, /maxScrapeTargets: Math\.min\(12, Math\.max\(8, searchQueries\.length\)\)/);
  assert.match(serviceSource, /estimateTreesFromSatellitePixels/);
  assert.match(serviceSource, /treeCountMethod: vision\.method/);
  assert.match(serviceSource, /reportData\.geometryStatus === 'stale-hidden' \? undefined : reportData\.boundaryRings/);
  assert.match(serviceSource, /new Promise<null>\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), 45_000\)\)/);
  assert.doesNotMatch(serviceSource, /UTIL_ESTIMATE|TREE_RATE_FALLBACK|CLEARING_FALLBACK/);
});
