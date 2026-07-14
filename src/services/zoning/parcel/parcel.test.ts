import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupParcel, parcelInteriorPoint } from './parcel-engine';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('parcelInteriorPoint stays inside a concave parcel instead of using its centroid', () => {
  const parcel = {
    type: 'Polygon' as const,
    coordinates: [[[0, 0], [0, 4], [1, 4], [1, 1], [4, 1], [4, 0], [0, 0]]],
  };
  const interior = parcelInteriorPoint(parcel);
  assert.ok(interior.longitude >= 0 && interior.longitude <= 4);
  assert.ok(interior.latitude >= 0 && interior.latitude <= 4);
  assert.ok(interior.longitude <= 1 || interior.latitude <= 1, 'point must not land in the concavity');
});

test('parcel lookup retries with a bounded nearest search when the address point is in the road', async () => {
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (!url.searchParams.has('distance')) return jsonResponse({ features: [] });
    return jsonResponse({
      features: [{
        attributes: { PIN: 'P-100', SITE: '100 Test Road', ACRES: 0.5 },
        geometry: {
          rings: [[
            [-80.0002, 35.0], [-80.0002, 35.0004], [-79.9998, 35.0004],
            [-79.9998, 35.0], [-80.0002, 35.0],
          ]],
        },
      }],
    });
  };

  const result = await lookupParcel(
    {
      layerUrl: 'https://gis.example.gov/arcgis/rest/services/Parcels/MapServer/0',
      layerId: 0,
      parcelIdField: 'PIN',
      addressField: 'SITE',
      acreageField: 'ACRES',
      maxNearestMeters: 75,
    },
    { longitude: -80.0003, latitude: 35.0002, address: '100 Test Rd' },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.searchParams.get('distance'), '75');
  assert.equal(result?.parcelId, 'P-100');
  assert.equal(result?.matchMethod, 'nearest-parcel');
  assert.equal(result?.addressMatched, true);
  assert.ok((result?.distanceFromGeocodePointMeters ?? 1000) < 75);
  assert.ok(result?.interiorPoint);
});
