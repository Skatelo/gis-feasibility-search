import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompBuildingType,
  compSearchFamiliesForAllowedTypes,
  isFinalCompTypeAllowed,
  zoningAllowedBuildingTypes,
} from './comp-types';

test('zoning use text exposes every supported residential sale form', () => {
  const types = zoningAllowedBuildingTypes([
    'Single-family detached dwellings',
    'Manufactured homes permitted by right',
    'Townhouses and condominium dwellings',
    'Duplex, triplex, and four-family dwellings',
    'Apartments with five or more units',
    'Multiple principal residential structures on one lot',
  ], 'MX-R', 'Mixed residential district');

  assert.deepEqual(types, [
    'single-family',
    'mobile',
    'townhouse',
    'condo',
    'duplex',
    'triplex',
    'quadplex',
    'multi-family',
    'multi-structure',
  ]);
});

test('prohibited wording cannot create a permitted comp category', () => {
  const types = zoningAllowedBuildingTypes(
    ['Single-family detached dwelling'],
    'R-10',
    'Residential district',
    ['Mobile homes prohibited', 'More than one principal residential building shall not be allowed'],
  );

  assert.deepEqual(types, ['single-family']);
});

test('mobile homes are not swallowed by the generic word home', () => {
  const result = classifyCompBuildingType({ propertyType: 'manufactured_home' });
  assert.equal(result.type, 'mobile');
});

test('published unit counts create exact small-multifamily labels', () => {
  assert.equal(classifyCompBuildingType({ propertyType: 'multi_family', unitCount: 2 }).type, 'duplex');
  assert.equal(classifyCompBuildingType({ propertyType: 'multi_family', unitCount: 3 }).type, 'triplex');
  assert.equal(classifyCompBuildingType({ propertyType: 'multi_family', unitCount: 4 }).type, 'quadplex');
  assert.equal(classifyCompBuildingType({ propertyType: 'multi_family', unitCount: 8 }).type, 'multi-family');
});

test('source remarks and structure counts classify ambiguous records', () => {
  assert.equal(classifyCompBuildingType({
    propertyType: 'multi_family',
    sourceText: 'This well-maintained two family home offers two separate units.',
  }).type, 'duplex');
  assert.equal(classifyCompBuildingType({
    propertyType: 'single_family',
    structureCount: 3,
  }).type, 'multi-structure');
});

test('source search filters collapse exact zoning types without losing coverage', () => {
  assert.deepEqual(
    compSearchFamiliesForAllowedTypes(['single-family', 'duplex', 'triplex', 'quadplex', 'multi-structure']),
    ['single-family', 'multi-family'],
  );
});

test('generic multifamily permission accepts source-backed 2-4 unit subtypes', () => {
  assert.equal(isFinalCompTypeAllowed('duplex', ['multi-family']), true);
  assert.equal(isFinalCompTypeAllowed('triplex', ['duplex']), false);
  assert.equal(isFinalCompTypeAllowed('unknown', ['single-family']), false);
});
