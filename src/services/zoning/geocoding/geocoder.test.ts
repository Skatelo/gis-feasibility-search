import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CensusGeocoder } from './census-geocoder';
import { GoogleGeocoder } from './google-geocoder';
import { ChainGeocoder } from './chain-geocoder';
import { createGeocoder } from './index';

const LIVE = process.env.ZONING_LIVE === '1';

test('CensusGeocoder is keyless and always configured', () => {
  assert.equal(new CensusGeocoder().isConfigured(), true);
});

test('GoogleGeocoder reports configured only with a key', () => {
  assert.equal(new GoogleGeocoder('').isConfigured(), false);
  assert.equal(new GoogleGeocoder('AIza-test').isConfigured(), true);
});

test('createGeocoder always yields a working chain (census fallback)', () => {
  const g = createGeocoder({});
  assert.equal(g.isConfigured(), true);
});

test('ChainGeocoder throws when no provider is configured', () => {
  assert.throws(() => new ChainGeocoder([new GoogleGeocoder('')]));
});

test('ChainGeocoder falls through to the next provider on failure', async () => {
  const failing = {
    name: 'failing',
    isConfigured: () => true,
    geocode: async () => {
      throw new Error('boom');
    },
    reverseGeocode: async () => {
      throw new Error('boom');
    },
  };
  const ok = {
    name: 'ok',
    isConfigured: () => true,
    geocode: async () => ({
      inputAddress: 'x',
      formattedAddress: 'x',
      latitude: 1,
      longitude: 2,
      provider: 'ok',
      raw: null,
    }),
    reverseGeocode: async () => ({
      inputAddress: 'x',
      formattedAddress: 'x',
      latitude: 1,
      longitude: 2,
      provider: 'ok',
      raw: null,
    }),
  };
  const chain = new ChainGeocoder([failing, ok]);
  const r = await chain.geocode('anything');
  assert.equal(r.provider, 'ok');
});

test('live: Census geocodes a municipal NC address with jurisdiction fields', { skip: !LIVE }, async () => {
  const g = new CensusGeocoder();
  const r = await g.geocode('634 Kentbrook Dr, Charlotte, NC 28213');
  assert.equal(r.provider, 'census');
  assert.ok(Math.abs(r.latitude - 35.28) < 0.2, `lat ${r.latitude}`);
  assert.ok(Math.abs(r.longitude - -80.74) < 0.3, `lng ${r.longitude}`);
  assert.equal(r.stateCode, 'NC');
  assert.match(r.county ?? '', /Mecklenburg/i);
  assert.match(r.municipality ?? '', /Charlotte/i);
});

test('live: Census resolves an unincorporated point (no municipality)', { skip: !LIVE }, async () => {
  const g = new CensusGeocoder();
  // A rural Watauga County NC coordinate outside any incorporated place.
  const r = await g.reverseGeocode(36.13, -81.75);
  assert.equal(r.stateCode, 'NC');
  assert.match(r.county ?? '', /Watauga/i);
});
