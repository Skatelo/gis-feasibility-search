import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFieldMapping } from './field-detector';
import { classifyLayer } from './layer-classifier';
import { inspectArcgisService, layerForRole } from './service-inspector';
import { queryZoning } from './spatial-query';
import { serviceRoot, isLayerUrl, layerIdFromUrl, layerSupportsQuery, queryLayerAtPoint } from './arcgis-client';
import type { ArcgisLayerMetadata } from './arcgis.types';
import type { DiscoveredSource } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function layer(over: Partial<ArcgisLayerMetadata>): ArcgisLayerMetadata {
  return {
    id: 0,
    name: 'Layer',
    type: 'Feature Layer',
    geometryType: 'esriGeometryPolygon',
    fields: [],
    ...over,
  };
}

// --- URL helpers -----------------------------------------------------------

test('serviceRoot strips layer id and query', () => {
  assert.equal(
    serviceRoot('https://x.gov/rest/services/Zoning/MapServer/7/query?f=json'),
    'https://x.gov/rest/services/Zoning/MapServer',
  );
  assert.equal(serviceRoot('https://x.gov/rest/services/Zoning/MapServer'), 'https://x.gov/rest/services/Zoning/MapServer');
});

test('isLayerUrl / layerIdFromUrl', () => {
  assert.equal(isLayerUrl('https://x.gov/rest/services/Z/MapServer/12'), true);
  assert.equal(isLayerUrl('https://x.gov/rest/services/Z/MapServer'), false);
  assert.equal(layerIdFromUrl('https://x.gov/rest/services/Z/FeatureServer/3'), 3);
});

// --- Field detection -------------------------------------------------------

test('field detector picks a strong zoning-code field over noise', () => {
  const m = detectFieldMapping(
    layer({
      displayField: 'ZONE_CODE',
      fields: [
        { name: 'OBJECTID', type: 'esriFieldTypeOID' },
        { name: 'ZONE_CODE', type: 'esriFieldTypeString', alias: 'Zoning Code' },
        { name: 'ZONE_DESC', type: 'esriFieldTypeString', alias: 'Description' },
        { name: 'SHAPE_Area', type: 'esriFieldTypeDouble' },
      ],
      drawingInfo: { renderer: { type: 'uniqueValue', field1: 'ZONE_CODE' } },
    }),
  );
  assert.equal(m.zoningCodeField, 'ZONE_CODE');
  assert.equal(m.zoningDescriptionField, 'ZONE_DESC');
  assert.ok(m.detectionConfidence >= 0.8, `confidence ${m.detectionConfidence}`);
});

test('field detector never returns an id/area/owner field as the code', () => {
  const m = detectFieldMapping(
    layer({
      fields: [
        { name: 'OBJECTID', type: 'esriFieldTypeOID' },
        { name: 'OWNER', type: 'esriFieldTypeString' },
        { name: 'SHAPE_Length', type: 'esriFieldTypeDouble' },
      ],
    }),
  );
  assert.equal(m.zoningCodeField, null);
});

// --- Layer classification (keep zoning / FLU / overlay separate) -----------

test('classifier keeps current zoning, future land use, and overlays distinct', () => {
  assert.equal(classifyLayer(layer({ name: 'Zoning Districts' })).role, 'zoning');
  assert.equal(classifyLayer(layer({ name: 'Future Land Use' })).role, 'future-land-use');
  assert.equal(classifyLayer(layer({ name: 'Zoning Overlay Districts' })).role, 'overlay');
  assert.equal(classifyLayer(layer({ name: 'Comprehensive Plan' })).role, 'comprehensive-plan');
  assert.equal(classifyLayer(layer({ name: 'Tax Parcels' })).role, 'parcel');
  assert.equal(classifyLayer(layer({ name: 'Municipal Limits' })).role, 'municipal-boundary');
  assert.equal(classifyLayer(layer({ name: 'Special Flood Hazard Areas' })).role, 'floodplain');
});

test('classifier does not call a Future Land Use layer zoning even with a code field', () => {
  const c = classifyLayer(
    layer({
      name: 'Future Land Use',
      displayField: 'ZONE',
      fields: [{ name: 'ZONE', type: 'esriFieldTypeString', alias: 'Zone' }],
      drawingInfo: { renderer: { field1: 'ZONE' } },
    }),
  );
  assert.equal(c.role, 'future-land-use');
});

test('point query retries as form-encoded POST when a server rejects GET length', async () => {
  const calls: Array<{ method: string; body: string }> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    if (calls.length === 1) return jsonResponse({ error: 'URI too long' }, 414);
    return jsonResponse({ features: [{ attributes: { ZONE: 'R-1' } }] });
  };
  const response = await queryLayerAtPoint(
    'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer/0',
    0,
    -80.8,
    35.2,
    { outFields: 'ZONE' },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[1]?.method, 'POST');
  assert.match(calls[1]?.body ?? '', /geometry=-80\.8%2C35\.2/);
  assert.equal(response.features?.[0]?.attributes?.ZONE, 'R-1');
});

test('point query retries POST when ArcGIS returns HTTP 200 with a query error body', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    if (methods.length === 1) return jsonResponse({ error: { code: 400, message: 'Failed to execute query.', details: [] } });
    return jsonResponse({ features: [{ attributes: { ZONING: 'N1-B' } }] });
  };
  const response = await queryLayerAtPoint(
    'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer/0',
    0,
    -80.7853,
    35.2648,
  );
  assert.deepEqual(methods, ['GET', 'POST']);
  assert.equal(response.features?.[0]?.attributes?.ZONING, 'N1-B');
});

test('point query keeps WGS84 input and requests a configured output projection', async () => {
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return jsonResponse({ features: [] });
  };
  await queryLayerAtPoint('https://gis.example.gov/rest/services/Z/FeatureServer/4', 4, -81, 34.9, { outSR: 2264 });
  const requested = new URL(requestedUrl);
  assert.equal(requested.searchParams.get('inSR'), '4326');
  assert.equal(requested.searchParams.get('outSR'), '2264');
  assert.equal(requested.pathname.endsWith('/FeatureServer/4/query'), true);
});

test('ArcGIS token errors and query-disabled metadata are explicit', async () => {
  globalThis.fetch = async () => jsonResponse({ error: { code: 499, message: 'Token Required' } });
  await assert.rejects(
    queryLayerAtPoint('https://gis.example.gov/rest/services/Z/MapServer/0', 0, -81, 35),
    /Token Required/,
  );
  assert.equal(layerSupportsQuery(layer({ capabilities: 'Map' })), false);
  assert.equal(layerSupportsQuery(layer({ capabilities: 'Map,Query,Data' })), true);
});

test('ArcGIS timeout aborts a slow government request', async () => {
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
  });
  await assert.rejects(
    queryLayerAtPoint('https://gis.example.gov/rest/services/Z/MapServer/0', 0, -81, 35, { timeoutMs: 15 }),
    /timed out|timeout/i,
  );
});

// --- Live: inspect a real service and query a point ------------------------

test('live: inspect a real ArcGIS zoning service and query a point', { skip: !LIVE }, async () => {
  const source: DiscoveredSource = {
    url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer',
    sourceType: 'arcgis-mapserver',
    official: true,
    agency: 'Wake County',
    discoveredFrom: ['test'],
  };
  const inspected = await inspectArcgisService(source, { timeoutMs: 12000 });
  const zoningLayer = layerForRole(inspected, 'zoning');
  assert.ok(zoningLayer, 'expected a zoning-role layer to be classified');
  assert.ok(zoningLayer.fieldMapping.zoningCodeField, 'expected a detected zoning-code field');

  // Downtown Raleigh point; this is a multi-jurisdiction county service (a
  // separate zoning layer per town), so the governing municipality is passed as
  // a hint to target "Raleigh Zoning".
  const matches = await queryZoning(
    inspected,
    { longitude: -78.63917, latitude: 35.77736 },
    { timeoutMs: 12000, jurisdiction: 'Raleigh' },
  );
  assert.ok(matches.length > 0, 'expected at least one zoning polygon match');
  const zoningMatch = matches.find((m) => m.layerRole === 'zoning');
  assert.ok(zoningMatch, 'expected a base-zoning match');
  assert.match(zoningMatch.layerName, /Raleigh/i);
  // Use the winning layer's own detected code field (layers vary in schema).
  const codeField =
    inspected.layers.find((l) => l.id === zoningMatch.layerId)?.fieldMapping.zoningCodeField ??
    (zoningLayer.fieldMapping.zoningCodeField as string);
  const code = String(zoningMatch.attributes[codeField] ?? '').trim();
  assert.ok(code.length > 0 && code.length < 40, `expected a real district code, got "${code}"`);
});
