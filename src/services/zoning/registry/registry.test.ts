import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KvSourceRegistry,
  createInMemoryRegistry,
  jurisdictionKey,
} from './source-registry.repository';
import { InMemoryKVStore, WebStorageKVStore } from './kv-store';
import { SourceHealthService, metadataHash } from './source-health.service';
import { ENGINE_SCHEMA_VERSION, type JurisdictionSourceRecord } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';

function record(over: Partial<JurisdictionSourceRecord> = {}): JurisdictionSourceRecord {
  return {
    id: jurisdictionKey({ stateCode: 'NC', municipality: 'Raleigh', jurisdictionType: 'municipal' }),
    country: 'US',
    stateCode: 'NC',
    countyName: 'Wake County',
    municipalityName: 'Raleigh',
    jurisdictionType: 'municipal',
    agencyName: 'City of Raleigh',
    officialDomain: 'maps.wake.gov',
    sourceType: 'arcgis-mapserver',
    serviceUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer',
    zoningLayers: [
      {
        layerUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer/23',
        layerId: 23,
        layerName: 'Raleigh Zoning',
        role: 'zoning',
        fieldMapping: {
          zoningCodeField: 'ZONING',
          zoningDescriptionField: 'ZONE_TYPE_DECODE',
          jurisdictionField: null,
          overlayField: null,
          detectionConfidence: 0.9,
          reasons: [],
        },
        spatialReferenceWkid: 2264,
      },
    ],
    parcelLayers: [],
    boundaryLayers: [],
    lastVerifiedAt: new Date().toISOString(),
    healthStatus: 'healthy',
    schemaVersion: ENGINE_SCHEMA_VERSION,
    ...over,
  };
}

// --- Keys ------------------------------------------------------------------

test('jurisdictionKey is stable and distinguishes municipal vs county', () => {
  const a = jurisdictionKey({ stateCode: 'NC', municipality: 'Raleigh', county: 'Wake County', jurisdictionType: 'municipal' });
  const b = jurisdictionKey({ stateCode: 'NC', municipality: 'RALEIGH', county: 'Wake', jurisdictionType: 'municipal' });
  assert.equal(a, b, 'same jurisdiction must map to the same key');
  const county = jurisdictionKey({ stateCode: 'NC', county: 'Wake County', jurisdictionType: 'county' });
  assert.notEqual(a, county, 'municipal and county authorities are different records');
});

// --- Registry round-trip + invalidation ------------------------------------

test('registry stores and reuses a jurisdiction source record', async () => {
  const reg = createInMemoryRegistry();
  const rec = record();
  await reg.put(rec);
  const got = await reg.get(rec.id);
  assert.ok(got);
  assert.equal(got.serviceUrl, rec.serviceUrl);
  assert.equal(got.zoningLayers[0].fieldMapping.zoningCodeField, 'ZONING');
});

test('registry invalidates a record written by an older engine schema', async () => {
  const store = new InMemoryKVStore();
  const reg = new KvSourceRegistry(store);
  // Write a record directly with a stale schema version.
  await store.set(`jurisdiction-source:${record().id}`, {
    value: { ...record(), schemaVersion: ENGINE_SCHEMA_VERSION - 1 },
    expiresAt: null,
  });
  assert.equal(await reg.get(record().id), null);
});

test('generic cache honors TTL', async () => {
  const reg = createInMemoryRegistry();
  await reg.cacheSet('geocode', 'k', { lat: 1 }, 60_000);
  assert.deepEqual(await reg.cacheGet('geocode', 'k'), { lat: 1 });
  await reg.cacheSet('geocode', 'expired', { lat: 2 }, -1);
  assert.equal(await reg.cacheGet('geocode', 'expired'), null);
});

test('WebStorageKVStore round-trips through a storage shim', async () => {
  const backing = new Map<string, string>();
  const shim = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  };
  const reg = new KvSourceRegistry(new WebStorageKVStore(shim));
  await reg.put(record());
  const got = await reg.get(record().id);
  assert.ok(got);
  assert.equal(got.municipalityName, 'Raleigh');
});

// --- Health / hashing ------------------------------------------------------

test('metadataHash is stable and detects field/geometry drift', () => {
  const base = { fieldNames: ['OBJECTID', 'ZONING'], geometryType: 'esriGeometryPolygon', codeField: 'ZONING' };
  assert.equal(metadataHash(base), metadataHash({ ...base, fieldNames: ['ZONING', 'OBJECTID'] }), 'field order must not matter');
  assert.notEqual(metadataHash(base), metadataHash({ ...base, fieldNames: ['OBJECTID'] }), 'a removed field changes the hash');
  assert.notEqual(metadataHash(base), metadataHash({ ...base, geometryType: 'esriGeometryPoint' }));
});

test('live: health check reports a real registry record healthy', { skip: !LIVE }, async () => {
  const health = new SourceHealthService();
  const result = await health.check(record(), { timeoutMs: 12000 });
  assert.equal(result.status, 'healthy', JSON.stringify(result));
  assert.equal(result.layerExists, true);
  assert.equal(result.queryable, true);
});

test('live: health check flags a broken/moved layer', { skip: !LIVE }, async () => {
  const health = new SourceHealthService();
  const broken = record({
    zoningLayers: [
      {
        ...record().zoningLayers[0],
        layerUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer/9999',
        layerId: 9999,
      },
    ],
  });
  const result = await health.check(broken, { timeoutMs: 12000 });
  assert.equal(result.status, 'broken', JSON.stringify(result));
});
