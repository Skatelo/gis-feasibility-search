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

test('zoning uses official GIS first and grounded Gemini 3.5 Flash for research', () => {
  const stage = serviceSource.slice(
    serviceSource.indexOf('// STAGE 3 - zoning.'),
    serviceSource.indexOf('// STAGE 4'),
  );
  const resolver = serviceSource.slice(
    serviceSource.indexOf('export async function fetchZoningViaWebSearch'),
    serviceSource.indexOf('async function fetchDrivingDistancesViaSDK'),
  );

  assert.match(stage, /if \(geminiZoning\)/);
  assert.match(stage, /zoningSetbackNotes/);
  assert.match(stage, /zoningRestrictions/);
  assert.match(resolver, /fetchCountyZoningCode/);
  assert.match(serviceSource, /const GEMINI_ZONING_MODEL = 'gemini-3\.5-flash'/);
  assert.match(serviceSource, /tools: \[\{ google_search: \{\} \}\]/);
  assert.match(resolver, /return bestOfficialResult \|\| officialGisFallback \|\| bestListingResult/);
  assert.match(resolver, /completeSetbacks[\s\S]*standards\?\.restrictions/);
  assert.match(resolver, /mode: 'hard'/);
  assert.match(resolver, /for \(let round = 0; round < 3; round\+\+\)/);
  assert.match(resolver, /zoningQueriesForRound/);
  assert.match(resolver, /bestListingResult/);
  assert.match(serviceSource, /site:zillow\.com[\s\S]*site:realtor\.com[\s\S]*site:redfin\.com/);
  assert.doesNotMatch(resolver, /zoningExpertViaDeepSeek|deepSeekKey|model: 'sonar'/);
  assert.match(serviceSource, /method: 'POST',\s+cache: 'no-store',/);
  assert.match(componentSource, /CORROBORATED: PROPERTY LISTINGS/);
  assert.match(componentSource, /REPORTED: PROPERTY LISTING/);
  assert.match(componentSource, /Setback rules and exceptions/);
  assert.match(componentSource, /Published zoning restrictions/);
  assert.match(componentSource, /data\.gridics && data\.zoningVerificationStatus !== 'unavailable'/);
});

test('comps use RealtyAPI records filtered by zoning while retaining Gemini Vision photos', () => {
  const pipeline = serviceSource.slice(
    serviceSource.indexOf('export async function fetchGoogleDistanceMatrixComps'),
    serviceSource.indexOf('/** A grounded (Google-Search) Gemini text call'),
  );

  assert.match(pipeline, /fetchRealtyApiSoldComps/);
  assert.match(pipeline, /getPermittedCategory\(zoningCode, zoningDesc\)/);
  assert.match(pipeline, /selectExteriorComps\(result, getBackgroundGeminiKey\(\)\)/);
  assert.doesNotMatch(pipeline, /fetchGoogleMlsComps|runGeminiCompQuery|google_search|ENABLE_GOOGLE_MLS_COMPS/);
  assert.match(serviceSource, /matchesZoningUse\(c\.propertyType, category\)/);
});
