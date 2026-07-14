import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInGeometry, boundingBox, polygonArea, ringArea } from './point-in-polygon';
import type { GeoJSONGeometry } from '../types';

const square: GeoJSONGeometry = { type: 'Polygon', coordinates: [[[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]]] };
const squareWithHole: GeoJSONGeometry = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]],
    [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]], // hole
  ],
};
const multi: GeoJSONGeometry = {
  type: 'MultiPolygon',
  coordinates: [
    [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    [[[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]],
  ],
};

test('point-in-polygon: inside, outside, and boundary behavior', () => {
  assert.equal(pointInGeometry(2, 2, square), true);
  assert.equal(pointInGeometry(5, 5, square), false);
  assert.equal(pointInGeometry(-1, 2, square), false);
});

test('point-in-polygon respects holes', () => {
  assert.equal(pointInGeometry(0.5, 0.5, squareWithHole), true, 'in the ring, outside the hole');
  assert.equal(pointInGeometry(2, 2, squareWithHole), false, 'inside the hole is outside the polygon');
});

test('point-in-polygon handles MultiPolygon', () => {
  assert.equal(pointInGeometry(0.5, 0.5, multi), true);
  assert.equal(pointInGeometry(5.5, 5.5, multi), true);
  assert.equal(pointInGeometry(3, 3, multi), false);
});

test('boundingBox and area', () => {
  const bb = boundingBox(square);
  assert.deepEqual(bb, { minLng: 0, minLat: 0, maxLng: 4, maxLat: 4 });
  assert.equal(ringArea([[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]]), 16);
  assert.equal(polygonArea(square), 16);
  assert.equal(polygonArea(squareWithHole), 12, 'outer 16 minus hole 4');
});

test('null / non-polygon geometry is safe', () => {
  assert.equal(pointInGeometry(0, 0, null), false);
  assert.equal(pointInGeometry(0, 0, { type: 'Point', coordinates: [0, 0] }), false);
  assert.equal(boundingBox(null), null);
});
