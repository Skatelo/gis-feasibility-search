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
  assert.equal(cleanCode('OFFICIAL MAP REVIEW'), null);
  assert.equal(cleanCode('MANUAL REVIEW'), null);
  assert.equal(cleanCode('NO ADOPTED DISTRICT'), null);
  assert.equal(cleanCode('LAND USE: residential'), null);
  assert.equal(cleanCode('Not published'), null);
  assert.equal(cleanCode('Unavailable'), null);
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

test('value-shape recovers the code when column names are misleading (Charlotte)', () => {
  // Real Charlotte layer: "zoneclass" holds the DESCRIPTION and "zonedes" holds
  // the CODE — the opposite of what the names suggest. The mapping (name-based)
  // points the code slot at zoneclass; value shape must correct it.
  const charlotte = layer(0, {
    fieldMapping: { zoningCodeField: 'zoneclass', zoningDescriptionField: 'zonedes', jurisdictionField: null, overlayField: null, detectionConfidence: 0.6, reasons: [] },
  });
  const { zoning } = normalizeZoning(
    // rezonedate (an epoch number under a "…zone…"-matching key) must NOT be
    // mistaken for the code.
    [match(0, { zoneclass: 'UPTOWN MIXED USE', zonedes: 'UC', spa: 'no', overlay: 'none', rezonedate: 1685592000000, objectid: 1 })],
    [charlotte],
  );
  assert.equal(zoning.code, 'UC', 'the code-shaped value must win over the prose and the date');
  assert.equal(zoning.description, 'UPTOWN MIXED USE');
});

test('value-shape prefers Charlotte N1-B over the mapped Neighborhood 1 district name', () => {
  const charlotte = layer(0, {
    fieldMapping: { zoningCodeField: 'zoneclass', zoningDescriptionField: 'zonedes', jurisdictionField: null, overlayField: null, detectionConfidence: 0.6, reasons: [] },
  });
  const { zoning } = normalizeZoning(
    [match(0, { zoneclass: 'NEIGHBORHOOD 1', zonedes: 'N1-B', overlay: 'none', rezonedate: 1685592000000 })],
    [charlotte],
  );
  assert.equal(zoning.code, 'N1-B');
  assert.equal(zoning.description, 'NEIGHBORHOOD 1');
});

test('a correctly-named code field is used as-is (no false swap)', () => {
  const { zoning } = normalizeZoning(
    [match(23, { ZONING: 'DX-40-SH', ZONE_TYPE: 'DX-', ZONE_TYPE_DECODE: 'Downtown Mixed Use', OBJECTID: 1 }, 'zoning')],
    [layer(23, { fieldMapping: { zoningCodeField: 'ZONING', zoningDescriptionField: 'ZONE_TYPE_DECODE', jurisdictionField: null, overlayField: null, detectionConfidence: 0.9, reasons: [] } })],
  );
  assert.equal(zoning.code, 'DX-40-SH');
  assert.equal(zoning.description, 'Downtown Mixed Use');
});

test('normalizeZoning reports not-found when no clean code is present', () => {
  const { zoning } = normalizeZoning([match(23, { ZONING: 'CITY' })], [layer(23)]);
  assert.equal(zoning.found, false);
  assert.equal(zoning.code, null);
});

test('normalizeZoning never promotes UI fallback text to a zoning district', () => {
  for (const value of ['OFFICIAL MAP REVIEW', 'MANUAL REVIEW', 'ZONING CODE UNRESOLVED', 'NO ADOPTED DISTRICT', 'LAND USE: residential', 'Not published', 'Unavailable']) {
    const { zoning } = normalizeZoning([match(23, { ZONING: value })], [layer(23)]);
    assert.equal(zoning.found, false, value);
    assert.equal(zoning.code, null, value);
  }
});
