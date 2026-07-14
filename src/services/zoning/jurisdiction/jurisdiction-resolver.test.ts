import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJurisdiction } from './jurisdiction-resolver';
import { CensusGeocoder } from '../geocoding/census-geocoder';
import type { GeocodedAddress } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';

function fakeGeocoded(over: Partial<GeocodedAddress>): GeocodedAddress {
  return {
    inputAddress: 'x',
    formattedAddress: 'x',
    latitude: 35,
    longitude: -80,
    stateCode: 'NC',
    state: 'North Carolina',
    county: 'Mecklenburg County',
    provider: 'test',
    raw: null,
    ...over,
  };
}

test('offline: geocoder-only resolution is capped at medium confidence', async () => {
  const j = await resolveJurisdiction(fakeGeocoded({ municipality: 'Charlotte' }), { boundaryLookup: false });
  assert.equal(j.jurisdictionType, 'municipal');
  assert.equal(j.zoningAuthority, 'Charlotte');
  assert.ok(j.confidence <= 65, `expected medium confidence, got ${j.confidence}`);
  assert.ok(j.evidence.some((e) => e.kind === 'geocoder-field'));
});

test('offline: no municipality + county falls back to county authority', async () => {
  const j = await resolveJurisdiction(
    fakeGeocoded({ municipality: undefined, county: 'Watauga County' }),
    { boundaryLookup: false },
  );
  assert.equal(j.jurisdictionType, 'county');
  assert.equal(j.zoningAuthority, 'Watauga County');
});

test('offline: missing state code caps confidence low', async () => {
  const j = await resolveJurisdiction(
    fakeGeocoded({ stateCode: undefined, municipality: 'Nowhere' }),
    { boundaryLookup: false },
  );
  assert.ok(j.confidence <= 30);
});

test('live: municipal address resolves to municipal authority with high confidence', { skip: !LIVE }, async () => {
  const geo = await new CensusGeocoder().geocode('634 Kentbrook Dr, Charlotte, NC 28213');
  const j = await resolveJurisdiction(geo);
  assert.equal(j.stateCode, 'NC');
  assert.match(j.county ?? '', /Mecklenburg/i);
  assert.equal(j.incorporated, true);
  assert.equal(j.jurisdictionType, 'municipal');
  assert.match(j.zoningAuthority ?? '', /Charlotte/i);
  assert.ok(j.confidence >= 85, `confidence ${j.confidence}`);
  assert.ok(j.evidence.some((e) => e.kind === 'boundary-intersection'));
});

test('live: unincorporated point resolves to county authority', { skip: !LIVE }, async () => {
  const geo = await new CensusGeocoder().reverseGeocode(36.13, -81.75);
  const j = await resolveJurisdiction(geo);
  assert.equal(j.incorporated, false);
  assert.equal(j.jurisdictionType, 'county');
  assert.match(j.zoningAuthority ?? '', /Watauga County/i);
});
