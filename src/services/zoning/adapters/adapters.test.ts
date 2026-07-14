import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeoJsonAdapter } from './geojson.adapter';
import { ArcgisAdapter } from './arcgis.adapter';
import { selectAdapter, adapterForSourceType } from './adapter-registry';
import type { AdapterContext, DiscoveredSource } from '../types';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

function ctxReturning(fc: unknown): AdapterContext {
  return { fetchJson: async () => fc as never, log: noopLog };
}

const geojsonSource: DiscoveredSource = {
  url: 'https://data.example.gov/zoning.geojson',
  sourceType: 'geojson',
  official: true,
  agency: 'Example City',
  discoveredFrom: ['test'],
};

const featureCollection = {
  type: 'FeatureCollection',
  features: [
    { properties: { ZONE: 'R-1', ZONE_DESC: 'Single Family Residential', rezonedate: 1685592000000 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] } },
    { properties: { ZONE: 'C-2', ZONE_DESC: 'General Commercial', rezonedate: 1685592000000 }, geometry: { type: 'Polygon', coordinates: [[[2, 0], [2, 2], [4, 2], [4, 0], [2, 0]]] } },
  ],
};

test('selectAdapter routes by source family', () => {
  assert.ok(selectAdapter({ ...geojsonSource, url: 'https://x.gov/rest/services/Z/MapServer' }) instanceof ArcgisAdapter);
  assert.ok(selectAdapter(geojsonSource) instanceof GeoJsonAdapter);
  assert.ok(adapterForSourceType('arcgis-featureserver') instanceof ArcgisAdapter);
  assert.ok(adapterForSourceType('geojson') instanceof GeoJsonAdapter);
});

test('GeoJSON adapter detects the code field from sampled property values', async () => {
  const adapter = new GeoJsonAdapter();
  const inspected = await adapter.inspect(geojsonSource, ctxReturning(featureCollection));
  assert.equal(inspected.sourceType, 'geojson');
  assert.equal(inspected.layers[0].role, 'zoning');
  assert.equal(inspected.layers[0].fieldMapping.zoningCodeField, 'ZONE', 'value shape picks ZONE, not the rezonedate number');
  assert.equal(inspected.layers[0].fieldMapping.zoningDescriptionField, 'ZONE_DESC');
});

test('GeoJSON adapter point-in-polygon returns the containing feature only', async () => {
  const adapter = new GeoJsonAdapter();
  const ctx = ctxReturning(featureCollection);
  const inspected = await adapter.inspect(geojsonSource, ctx);

  const r1 = await adapter.query(inspected, { longitude: 1, latitude: 1 }, ctx);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].attributes.ZONE, 'R-1');

  const c2 = await adapter.query(inspected, { longitude: 3, latitude: 1 }, ctx);
  assert.equal(c2[0].attributes.ZONE, 'C-2');

  const none = await adapter.query(inspected, { longitude: 9, latitude: 9 }, ctx);
  assert.equal(none.length, 0);
});

test('GeoJSON adapter health check reflects feature availability', async () => {
  const adapter = new GeoJsonAdapter();
  const ctx = ctxReturning(featureCollection);
  const inspected = await adapter.inspect(geojsonSource, ctx);
  const health = await adapter.healthCheck(inspected, ctx);
  assert.equal(health.status, 'healthy');
});
