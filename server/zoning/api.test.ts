import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZoningLookupEngine } from '../../src/services/zoning/orchestrator';
import { createInMemoryRegistry } from '../../src/services/zoning/registry';
import type { GeocodedAddress, Geocoder, JurisdictionResult } from '../../src/services/zoning/types';
import { MemoryJsonCache, SingleFlightResultCache } from './cache';
import { buildZoningApi } from './api';
import type { ZoningRuntime } from './runtime';

const geocoded: GeocodedAddress = {
  inputAddress: '100 Test Road, Charlotte, NC 28202',
  formattedAddress: '100 Test Rd, Charlotte, NC 28202',
  latitude: 35.2271,
  longitude: -80.8431,
  state: 'North Carolina',
  stateCode: 'NC',
  county: 'Mecklenburg County',
  municipality: 'Charlotte',
  country: 'US',
  locationType: 'rooftop',
  provider: 'fixture',
  raw: {},
};

const jurisdiction: JurisdictionResult = {
  state: 'North Carolina',
  stateCode: 'NC',
  county: 'Mecklenburg County',
  municipality: 'Charlotte',
  incorporated: true,
  zoningAuthority: 'City of Charlotte',
  jurisdictionType: 'municipal',
  confidence: 98,
  evidence: [{ kind: 'boundary-intersection', detail: 'fixture boundary', confidence: 0.98 }],
};

function testRuntime(options: { failGeocode?: boolean } = {}) {
  let geocodeCalls = 0;
  const registry = createInMemoryRegistry();
  const cache = new MemoryJsonCache();
  const geocoder: Geocoder = {
    name: 'fixture',
    isConfigured: () => true,
    async geocode() {
      geocodeCalls += 1;
      if (options.failGeocode) throw new Error('fixture address not found');
      return geocoded;
    },
    async reverseGeocode() { return geocoded; },
  };
  const engine = new ZoningLookupEngine({
    geocoder,
    registry,
    jurisdictionResolver: async () => jurisdiction,
  });
  const runtime: ZoningRuntime = {
    config: {
      nodeEnv: 'test', host: '127.0.0.1', port: 8787, databaseSsl: false,
      corsOrigins: ['http://localhost:5173'],
    },
    engine,
    geocoder,
    registry,
    registryCache: cache,
    resultCache: new SingleFlightResultCache(cache),
    resolveJurisdiction: async () => jurisdiction,
    close: async () => undefined,
  };
  return { runtime, geocodeCalls: () => geocodeCalls };
}

test('API returns explicit manual review on a registry miss and caches the completed result', async () => {
  const fixture = testRuntime();
  const app = await buildZoningApi(fixture.runtime);
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/zoning/lookup',
      payload: { address: geocoded.inputAddress },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'manual_review');
    assert.equal(first.json().performance.cached, false);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/zoning/lookup',
      payload: { address: geocoded.inputAddress },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().performance.cached, true);
    assert.equal(fixture.geocodeCalls(), 1);
  } finally {
    await app.close();
  }
});

test('API rejects malformed lookup requests before any geocoder call', async () => {
  const fixture = testRuntime();
  const app = await buildZoningApi(fixture.runtime);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/zoning/lookup', payload: { address: 'x' } });
    assert.equal(response.statusCode, 400);
    assert.equal(fixture.geocodeCalls(), 0);
  } finally {
    await app.close();
  }
});

test('API distinguishes an un-geocodable address from a source registry miss', async () => {
  const fixture = testRuntime({ failGeocode: true });
  const app = await buildZoningApi(fixture.runtime);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/zoning/lookup',
      payload: { address: '99999 Missing Road, Charlotte, NC 28202' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'not_found');
    assert.match(response.json().reason, /geocode/i);
  } finally {
    await app.close();
  }
});
