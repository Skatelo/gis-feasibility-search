import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../../src/data/ncZoning.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const zoning = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const serviceSource = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
const componentSource = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');

test('state-qualified NC and SC county names resolve to their zoning services', () => {
  assert.equal(zoning.normalizeCountyKey('Mecklenburg, NC'), 'mecklenburg');
  assert.equal(zoning.normalizeCountyKey('Greenville, SC'), 'greenville,_sc');
  assert.equal(zoning.normalizeCountyKey('Union, NC'), 'union');
  assert.equal(zoning.normalizeCountyKey('Union, SC'), 'union,_sc');
  assert.match(zoning.getZoningServices('Mecklenburg, NC')[0].url, /CityofCharlotteZoning/);
  assert.match(zoning.getZoningServices('Greenville, SC')[0].url, /Greenville_Base/);
});

test('official NC and SC identify responses produce district codes', () => {
  const northCarolina = zoning.extractZoning([{
    layerName: 'City of Charlotte Zoning',
    attributes: {
      'Zone Description': 'UC',
      'Zone Class': 'UPTOWN MIXED USE',
      Overlay: 'none',
    },
  }]);
  const southCarolina = zoning.extractZoning([{
    layerName: 'Zoning',
    attributes: {
      ZONING: 'MX-D',
      JCODE: 'City of Greenville',
      'SHAPE.STArea()': '685180.732056',
    },
  }]);

  assert.deepEqual(northCarolina, { code: 'UC', description: 'UPTOWN MIXED USE' });
  assert.deepEqual(southCarolina, { code: 'MX-D', description: null });
});

test('zoning output is resolved only by the Perplexity+Crawlee fusion path', () => {
  const stage = serviceSource.slice(
    serviceSource.indexOf('// STAGE 3 - zoning.'),
    serviceSource.indexOf('// STAGE 4'),
  );
  const resolver = serviceSource.slice(
    serviceSource.indexOf('export async function fetchZoningViaWebSearch'),
    serviceSource.indexOf('async function fetchDrivingDistancesViaSDK'),
  );

  assert.doesNotMatch(stage, /fetchCountyZoningCode|gisZoning|pointZoning/);
  assert.match(stage, /if \(aiZoning\)/);
  assert.match(resolver, /if \(!perplexityKey \|\| \(!deepSeekKey && !geminiApiKey\)\)/);
  assert.match(resolver, /mode: 'hard'/);
  assert.match(resolver, /Promise\.all/);
  assert.match(resolver, /MODEL EXPERT DRAFTS/);
  assert.doesNotMatch(resolver, /model: 'sonar'|google_search/);
  assert.match(serviceSource, /method: 'POST',\s+cache: 'no-store',/);
  assert.match(componentSource, /data\.gridics && data\.zoningVerificationStatus === 'official-research'/);
  assert.match(componentSource, /Development allowances are unavailable until the fusion lookup verifies/);
});
