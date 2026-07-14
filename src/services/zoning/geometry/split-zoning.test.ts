import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { queryZoningForParcel } from './split-zoning';
import type { InspectedZoningSource } from '../types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('full parcel POST query reports both zoning districts and their coverage', async () => {
  let method = '';
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    method = init?.method ?? 'GET';
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      features: [
        {
          attributes: { ZONE: 'R-3' },
          geometry: { rings: [[[0, 0], [0, 1], [0.5, 1], [0.5, 0], [0, 0]]] },
        },
        {
          attributes: { ZONE: 'C-1' },
          geometry: { rings: [[[0.5, 0], [0.5, 1], [1, 1], [1, 0], [0.5, 0]]] },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const source: InspectedZoningSource = {
    source: {
      url: 'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer',
      sourceType: 'arcgis-mapserver',
      official: true,
      agency: 'Example County',
      discoveredFrom: ['reviewed registry'],
    },
    serviceUrl: 'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer',
    sourceType: 'arcgis-mapserver',
    metadataUrl: null,
    accessedAt: '2026-07-14T00:00:00.000Z',
    layers: [{
      id: 0,
      name: 'Current Zoning',
      role: 'zoning',
      roleConfidence: 1,
      geometryType: 'esriGeometryPolygon',
      supportsQuery: true,
      displayField: 'ZONE',
      objectIdField: 'OBJECTID',
      fields: [{ name: 'ZONE', alias: 'Zoning code', type: 'esriFieldTypeString' }],
      maxRecordCount: 1000,
      spatialReferenceWkid: 4326,
      layerUrl: 'https://gis.example.gov/arcgis/rest/services/Zoning/MapServer/0',
      fieldMapping: {
        zoningCodeField: 'ZONE',
        zoningDescriptionField: null,
        jurisdictionField: null,
        overlayField: null,
        detectionConfidence: 1,
        reasons: ['fixture'],
      },
      reasons: ['fixture'],
    }],
  };

  const result = await queryZoningForParcel(source, {
    type: 'Polygon',
    coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
  });

  assert.equal(method, 'POST');
  assert.match(requestBody, /geometryType=esriGeometryPolygon/);
  assert.equal(result.matches.length, 2);
  assert.ok((result.coverageByCode.get('R-3') ?? 0) > 49);
  assert.ok((result.coverageByCode.get('C-1') ?? 0) > 49);
  assert.ok((result.coverageByCode.get('R-3') ?? 100) < 51);
  assert.equal(result.errors.length, 0);
});
