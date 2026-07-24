import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ParcelIdentityAmbiguityError,
  chooseUniqueTopParcelCandidate,
  normalizeParcelIdentity,
  parseParcelLookupInput,
  parcelIdentitiesMatch,
  selectExactParcelFeature,
} from './parcel-identity';

test('normalizes county parcel punctuation without changing identity', () => {
  assert.equal(normalizeParcelIdentity('049-00-00-112 000'), '0490000112000');
  assert.equal(normalizeParcelIdentity(' 123.45/AB '), '12345AB');
});

test('parses an optional county and state qualifier for duplicate parcel IDs', () => {
  assert.deepEqual(
    parseParcelLookupInput('049-00-00-112 000, Union County, SC'),
    {
      parcelId: '049-00-00-112 000',
      countyHint: 'Union',
      stateHint: 'SC',
    },
  );
  assert.deepEqual(parseParcelLookupInput('56120014450000'), {
    parcelId: '56120014450000',
  });
});

test('selects the exact parcel instead of the first adjacent point result', () => {
  const features = [
    { properties: { parno: 'ADJACENT-001', ownname: 'Wrong Owner' } },
    { properties: { parno: '049-00-00-112 000', ownname: 'PARKER REGINA G' } },
  ];
  const selected = selectExactParcelFeature(
    features,
    ['0490000112000'],
    (feature) => [feature.properties.parno],
    true,
  );
  assert.equal(selected?.properties.ownname, 'PARKER REGINA G');
});

test('rejects point results when none match the requested parcel ID', () => {
  const features = [
    { properties: { parno: 'ADJACENT-001', ownname: 'Wrong Owner' } },
  ];
  assert.equal(
    selectExactParcelFeature(features, ['SUBJECT-999'], (feature) => [feature.properties.parno]),
    null,
  );
});

test('allows only South Carolina trailing-zero display suffixes when enabled', () => {
  assert.equal(parcelIdentitiesMatch('049-00-00-112', '049-00-00-112 000'), false);
  assert.equal(parcelIdentitiesMatch('049-00-00-112', '049-00-00-112 000', true), true);
  assert.equal(parcelIdentitiesMatch('049-00-00-112', '049-00-00-112 123', true), false);
  const selected = selectExactParcelFeature(
    [{ properties: { parno: '049-00-00-112' } }],
    ['049-00-00-112 000'],
    (feature) => [feature.properties.parno],
    true,
  );
  assert.equal(selected?.properties.parno, '049-00-00-112');
});

test('fails closed when the strongest parcel ID exists in multiple states', () => {
  assert.throws(
    () => chooseUniqueTopParcelCandidate('123-456', [
      { quality: 4, state: 'NC', county: 'Union, NC', parcelId: '123-456' },
      { quality: 4, state: 'SC', county: 'Union, SC', parcelId: '123-456' },
    ]),
    ParcelIdentityAmbiguityError,
  );
});

test('lower-ranked matches in another jurisdiction remain ambiguous', () => {
  assert.throws(
    () => chooseUniqueTopParcelCandidate('123-456', [
      { quality: 4, state: 'SC', county: 'York, SC', parcelId: '123-456' },
      { quality: 2, state: 'NC', county: 'Mecklenburg, NC', parcelId: '123456' },
    ]),
    ParcelIdentityAmbiguityError,
  );
});

test('keeps the strongest duplicate of one parcel identity', () => {
  const chosen = chooseUniqueTopParcelCandidate('123-456', [
    { quality: 2, state: 'SC', county: 'York, SC', parcelId: '123-456' },
    { quality: 4, state: 'SC', county: 'York, SC', parcelId: '123-456' },
  ]);
  assert.equal(chosen?.state, 'SC');
  assert.equal(chosen?.county, 'York, SC');
  assert.equal(chosen?.quality, 4);
});
