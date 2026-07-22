import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCompBuildingType,
  compAddressIdentity,
  compAddressMatchKey,
  compCoverageTypesForAllowedTypes,
  compSearchFamiliesForAllowedTypes,
  getRollingCompDateWindow,
  isFinalCompTypeAllowed,
  zoningAllowedBuildingTypes,
} from './comp-types';

test('comp date window follows the current day and calendar years', () => {
  assert.deepEqual(getRollingCompDateWindow(new Date(2027, 6, 13, 12, 0, 0)), {
    asOfDate: '2027-07-13',
    soldSinceDate: '2026-07-13',
    minYearBuilt: 2026,
    maxYearBuilt: 2027,
  });
});

test('rolling date window safely clamps leap day in the prior year', () => {
  assert.equal(
    getRollingCompDateWindow(new Date(2028, 1, 29, 12, 0, 0)).soldSinceDate,
    '2027-02-28',
  );
});

test('comp address identity preserves attached-home and condo unit numbers', () => {
  assert.deepEqual(compAddressIdentity('100 Main Street Unit 2, York, SC 29745'), {
    streetCore: '100mainst',
    unit: '2',
  });
  assert.deepEqual(compAddressIdentity('100 Main Street, Unit 3, York, SC 29745'), {
    streetCore: '100mainst',
    unit: '3',
  });
  assert.notEqual(
    compAddressMatchKey('100 Main St #2, York, SC 29745'),
    compAddressMatchKey('100 Main St #3, York, SC 29745'),
  );
  assert.equal(
    compAddressMatchKey('100 Main St Apt 2, York, SC 29745'),
    compAddressMatchKey('100 Main St #2, York, SC 29745'),
  );
  assert.equal(
    compAddressMatchKey('100 Main St Unit #2, York, SC 29745'),
    compAddressMatchKey('100 Main St #2, York, SC 29745'),
  );
});

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

test('broad multifamily permission audits every concrete two-to-four-unit form', () => {
  assert.deepEqual(compCoverageTypesForAllowedTypes(['multi-family']), [
    'duplex',
    'triplex',
    'quadplex',
    'multi-family',
  ]);
});

test('generic multifamily permission accepts source-backed 2-4 unit subtypes', () => {
  assert.equal(isFinalCompTypeAllowed('duplex', ['multi-family']), true);
  assert.equal(isFinalCompTypeAllowed('triplex', ['duplex']), false);
  assert.equal(isFinalCompTypeAllowed('unknown', ['single-family']), false);
});
