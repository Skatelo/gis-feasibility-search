import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZoning, cleanCode } from './zoning-normalizer';
import type { InspectedLayer, RawZoningMatch } from '../types';

function layer(id: number, over: Partial<InspectedLayer> = {}): InspectedLayer {
  return {
    id,
    name: `Layer ${id}`,
    role: 'zoning',
    roleConfidence: 1,
    geometryType: 'esriGeometryPolygon',
    supportsQuery: true,
    displayField: null,
    objectIdField: 'OBJECTID',
    fields: [],
    maxRecordCount: null,
    spatialReferenceWkid: null,
    layerUrl: `https://x.gov/rest/services/Z/MapServer/${id}`,
    fieldMapping: { zoningCodeField: 'ZONING', zoningDescriptionField: 'ZONE_DESC', jurisdictionField: null, overlayField: null, detectionConfidence: 0.9, reasons: [] },
    ...over,
    reasons: over.reasons ?? [],
  };
}

function match(layerId: number, attrs: Record<string, unknown>, role: RawZoningMatch['layerRole'] = 'zoning'): RawZoningMatch {
  return { layerId, layerName: `Layer ${layerId}`, layerRole: role, attributes: attrs, sourceUrl: `https://x.gov/rest/services/Z/MapServer/${layerId}` };
}

test('cleanCode rejects placeholders and blanks', () => {
  assert.equal(cleanCode('R-1'), 'R-1');
  assert.equal(cleanCode('  DX-40-SH '), 'DX-40-SH');
  assert.equal(cleanCode('CITY'), null);
  assert.equal(cleanCode('UNZONED'), null);
  assert.equal(cleanCode(''), null);
  assert.equal(cleanCode(null), null);
});

test('normalizeZoning picks the primary district and reads the mapped fields', () => {
  const { zoning } = normalizeZoning([match(23, { ZONING: 'DX-40-SH', ZONE_DESC: 'Downtown Mixed Use' })], [layer(23)]);
  assert.equal(zoning.found, true);
  assert.equal(zoning.code, 'DX-40-SH');
  assert.equal(zoning.description, 'Downtown Mixed Use');
  assert.equal(zoning.splitZoned, false);
});

test('normalizeZoning flags split zoning on two distinct base districts', () => {
  const { zoning } = normalizeZoning(
    [match(23, { ZONING: 'R-1' }), match(24, { ZONING: 'C-2' })],
    [layer(23), layer(24)],
  );
  assert.equal(zoning.splitZoned, true);
  assert.equal(zoning.code, 'R-1');
  assert.equal(zoning.additionalDistricts.length, 1);
  assert.equal(zoning.additionalDistricts[0].code, 'C-2');
});

test('overlays are kept separate from base zoning', () => {
  const overlayLayer = layer(5, { role: 'overlay', name: 'Historic Overlay', fieldMapping: { zoningCodeField: 'OVL', zoningDescriptionField: null, jurisdictionField: null, overlayField: 'OVL', detectionConfidence: 0.6, reasons: [] } });
  const { zoning, overlays } = normalizeZoning(
    [match(23, { ZONING: 'R-1' }), match(5, { OVL: 'H-1' }, 'overlay')],
    [layer(23), overlayLayer],
  );
  assert.equal(zoning.splitZoned, false, 'an overlay must not make a parcel split-zoned');
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].code, 'H-1');
});

test('normalizeZoning reports not-found when no clean code is present', () => {
  const { zoning } = normalizeZoning([match(23, { ZONING: 'CITY' })], [layer(23)]);
  assert.equal(zoning.found, false);
  assert.equal(zoning.code, null);
});
