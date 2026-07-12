import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../../src/data/ncZoning.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const zoning = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const evidenceSource = await readFile(new URL('../../../src/data/zoningEvidence.ts', import.meta.url), 'utf8');
const evidenceCompiled = ts.transpileModule(evidenceSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const evidence = await import(`data:text/javascript;base64,${Buffer.from(evidenceCompiled).toString('base64')}`);
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

test('listing zoning evidence distinguishes one-provider reports from corroboration', () => {
  assert.equal(evidence.zoningListingProvider('https://www.zillow.com/homedetails/example'), 'zillow.com');
  assert.equal(evidence.listingZoningEvidenceTier(['https://www.zillow.com/a']), 'reported');
  assert.equal(evidence.listingZoningEvidenceTier([
    'https://www.zillow.com/a',
    'https://www.redfin.com/a',
  ]), 'corroborated');
  assert.equal(evidence.listingZoningEvidenceTier([
    'https://www.zillow.com/a',
    'https://photos.zillow.com/b',
  ]), 'reported');
  assert.equal(evidence.listingZoningEvidenceTier(['https://example.com/a']), null);
});

test('zoning output uses iterative DeepSeek research without the fusion models', () => {
  const stage = serviceSource.slice(
    serviceSource.indexOf('// STAGE 3 - zoning.'),
    serviceSource.indexOf('// STAGE 4'),
  );
  const resolver = serviceSource.slice(
    serviceSource.indexOf('export async function fetchZoningViaWebSearch'),
    serviceSource.indexOf('async function fetchDrivingDistancesViaSDK'),
  );

  assert.doesNotMatch(stage, /fetchCountyZoningCode|gisZoning|pointZoning/);
  assert.match(stage, /if \(deepSeekZoning\)/);
  assert.match(resolver, /if \(!perplexityKey \|\| !deepSeekKey\)/);
  assert.match(resolver, /mode: 'hard'/);
  assert.match(resolver, /for \(let round = 0; round < 4; round\+\+\)/);
  assert.match(resolver, /zoningQueriesForRound/);
  assert.match(resolver, /bestListingResult/);
  assert.match(serviceSource, /site:zillow\.com[\s\S]*site:realtor\.com[\s\S]*site:redfin\.com/);
  assert.doesNotMatch(resolver, /zoningExpertViaGemini|Promise\.all|MODEL EXPERT DRAFTS|model: 'sonar'|google_search/);
  assert.match(serviceSource, /method: 'POST',\s+cache: 'no-store',/);
  assert.match(componentSource, /CORROBORATED: PROPERTY LISTINGS/);
  assert.match(componentSource, /REPORTED: PROPERTY LISTING/);
  assert.match(componentSource, /data\.gridics && data\.zoningVerificationStatus !== 'unavailable'/);
});
