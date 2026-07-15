import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZoningLookupEngine } from '../../src/services/zoning/orchestrator';
import { createInMemoryRegistry } from '../../src/services/zoning/registry';
import { AmbiguousAddressError, type GeocodedAddress, type Geocoder, type JurisdictionResult } from '../../src/services/zoning/types';
import { MemoryJsonCache, SingleFlightResultCache } from './cache';
import { buildZoningApi } from './api';
import type { ZoningRuntime } from './runtime';
import { ZoningMetrics } from './metrics';

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

function testRuntime(options: { failGeocode?: boolean; ambiguousGeocode?: boolean } = {}) {
  let geocodeCalls = 0;
  const registry = createInMemoryRegistry();
  const cache = new MemoryJsonCache();
  const geocoder: Geocoder = {
    name: 'fixture',
    isConfigured: () => true,
    async geocode() {
      geocodeCalls += 1;
      if (options.failGeocode) throw new Error('fixture address not found');
      if (options.ambiguousGeocode) throw new AmbiguousAddressError([
        { formattedAddress: '100 Test Rd, Charlotte, NC', latitude: 35.22, longitude: -80.84, provider: 'fixture' },
        { formattedAddress: '100 Test Rd, Concord, NC', latitude: 35.40, longitude: -80.58, provider: 'fixture' },
      ]);
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
    adaptiveLookup: async (input) => ({
      result: await engine.lookup(input),
      sourcesChecked: [],
      discoveryAttempted: false,
      officialPageUrl: null,
    }),
    metrics: new ZoningMetrics(),
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

test('adaptive API returns the documented unresolved shape with stage timings', async () => {
  const fixture = testRuntime();
  const app = await buildZoningApi(fixture.runtime);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/zoning/lookup',
      payload: { address: geocoded.inputAddress, fresh: true },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.success, false);
    assert.equal(body.verification.status, 'manual_review_required');
    assert.equal(body.performance.cache_hit, false);
    assert.equal(typeof body.performance.stages.geocode_ms, 'number');
    assert.equal(typeof body.performance.stages.total_ms, 'number');
  } finally {
    await app.close();
  }
});

test('adaptive API returns a verified official zoning contract without placeholder values', async () => {
  const fixture = testRuntime();
  fixture.runtime.adaptiveLookup = async (input) => {
    const result = await fixture.runtime.engine.lookup(input);
    result.status = 'verified';
    result.zoning = {
      found: true, code: 'UC', description: 'Urban Commercial', jurisdiction: 'City of Charlotte',
      jurisdictionType: 'municipal', layerName: 'Current Zoning', layerId: 4, splitZoned: false,
      coveragePercent: null, additionalDistricts: [], rawAttributes: { ZONING: 'UC' },
    };
    result.source = {
      sourceType: 'arcgis-mapserver', official: true, agency: 'City of Charlotte',
      serviceUrl: 'https://gis.charlottenc.gov/arcgis/rest/services/Planning/Zoning/MapServer',
      layerUrl: 'https://gis.charlottenc.gov/arcgis/rest/services/Planning/Zoning/MapServer/4',
      metadataUrl: 'https://gis.charlottenc.gov/arcgis/rest/services/Planning/Zoning/MapServer',
      discoveredFrom: ['fixture'], accessedAt: '2026-07-15T12:00:00.000Z',
    };
    result.confidence.overall = 96;
    result.diagnostics.registryHit = true;
    return {
      result,
      sourcesChecked: [],
      discoveryAttempted: false,
      officialPageUrl: 'https://www.charlottenc.gov/Growth-and-Development/Planning-and-Zoning',
    };
  };
  const app = await buildZoningApi(fixture.runtime);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/zoning/lookup', payload: { address: geocoded.inputAddress } });
    const body = response.json();
    assert.equal(body.success, true);
    assert.equal(body.zoning.code, 'UC');
    assert.equal(body.verification.status, 'verified_official');
    assert.equal(body.source.official, true);
    assert.match(body.source.page_url, /charlottenc\.gov/);
    assert.equal(body.performance.registry_hit, true);
  } finally {
    await app.close();
  }
});

test('adaptive API exposes strong duplicate address candidates instead of choosing one', async () => {
  const fixture = testRuntime({ ambiguousGeocode: true });
  const app = await buildZoningApi(fixture.runtime);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/zoning/lookup', payload: { address: '100 Test Road, NC' } });
    const body = response.json();
    assert.equal(body.success, false);
    assert.equal(body.candidate_matches.length, 2);
    assert.match(body.verification.warnings.join(' '), /multiple strong address matches/i);
  } finally {
    await app.close();
  }
});
