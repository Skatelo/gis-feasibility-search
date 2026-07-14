import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFieldMapping } from './field-detector';
import { classifyLayer } from './layer-classifier';
import { inspectArcgisService, layerForRole } from './service-inspector';
import { queryZoning } from './spatial-query';
import { serviceRoot, isLayerUrl, layerIdFromUrl } from './arcgis-client';
import type { ArcgisLayerMetadata } from './arcgis.types';
import type { DiscoveredSource } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';

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
