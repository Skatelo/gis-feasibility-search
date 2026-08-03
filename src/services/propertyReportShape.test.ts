import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPropertyReport } from './propertyReportShape';
import { utilityFinding } from './sc/utilityEvidence';

const base = { inputAddress: '123 Example Rd, Rock Hill, SC 29730', state: 'SC' as const };

test('the same shape serves NC and SC', () => {
  for (const state of ['NC', 'SC'] as const) {
    const r = buildPropertyReport({ ...base, state });
    assert.equal(r.state, state);
    assert.ok('parcel' in r && 'zoning' in r && 'utilities' in r);
  }
});

test('missing values are null, never a plausible default', () => {
  // A guessed acreage or fee is worse than a blank one — it looks like data.
  const r = buildPropertyReport(base);
  assert.equal(r.parcel.acreage, null);
  assert.equal(r.parcel.ownerName, null);
  assert.equal(r.parcel.marketValue, null);
  assert.equal(r.zoning.code, null);
  assert.equal(r.coordinates, null);
});

test('placeholder strings are treated as missing', () => {
  const r = buildPropertyReport({
    ...base,
    parcel: { ownerName: 'N/A', propertyAddress: 'null', legalDescription: '  ' },
  });
  assert.equal(r.parcel.ownerName, null);
  assert.equal(r.parcel.propertyAddress, null);
  assert.equal(r.parcel.legalDescription, null);
});

test('utility limits travel with the finding, not separately', () => {
  // Derived from the findings so a caller cannot forget to forward them.
  const r = buildPropertyReport({
    ...base,
    utilityFindings: [
      utilityFinding({ kind: 'sewer', insideServiceArea: true }),
      utilityFinding({ kind: 'water', distanceFt: 100 }),
    ],
  });
  assert.equal(r.utilities.sewer.status, 'inside-service-area');
  assert.ok(r.warnings.some((w) => /does not confirm an installed tap/i.test(w)));
  assert.ok(r.warnings.some((w) => /does not confirm a connection/i.test(w)));
});

test('a county answer inside a city is warned about, not presented as the city\'s', () => {
  const r = buildPropertyReport({
    ...base,
    municipality: 'Rock Hill',
    zoning: {
      code: 'RC-I', jurisdiction: 'York County', jurisdictionType: 'county',
      confidence: 'direct-spatial-match', municipalLayerMissing: true,
    },
  });
  assert.equal(r.zoning.jurisdictionType, 'county');
  assert.ok(r.warnings.some((w) => /only the county zoning layer answered/i.test(w)));
});

test('a public-record district is flagged as base-district only', () => {
  const r = buildPropertyReport({
    ...base,
    zoning: { code: 'DX-40', confidence: 'public-record' },
  });
  assert.ok(r.warnings.some((w) => /BASE district/i.test(w) && /suffix/i.test(w)));
});

test('no zoning at all is stated plainly rather than left blank', () => {
  const r = buildPropertyReport(base);
  assert.ok(r.warnings.some((w) => /No zoning district could be established/i.test(w)));
});

test('a verified GIS district carries no false-precision warning', () => {
  const r = buildPropertyReport({
    ...base,
    zoning: { code: 'RS-12', jurisdiction: 'Gastonia', jurisdictionType: 'city', confidence: 'direct-spatial-match' },
  });
  assert.equal(r.zoning.code, 'RS-12');
  assert.ok(!r.warnings.some((w) => /BASE district|not confirmed against an official GIS/i.test(w)));
});

test('warnings are de-duplicated', () => {
  const r = buildPropertyReport({
    ...base,
    utilityFindings: [
      utilityFinding({ kind: 'water', insideServiceArea: true }),
      utilityFinding({ kind: 'water', insideServiceArea: true }),
    ],
    extraWarnings: ['Verify zoning and permitted use with the controlling planning department.'],
  });
  assert.equal(r.warnings.length, new Set(r.warnings).size);
});

test('sources record who said it and when', () => {
  const at = '2026-08-03T13:00:00Z';
  const r = buildPropertyReport({
    ...base,
    sources: [{ agency: 'York County GIS', type: 'parcel', retrievedAt: at }],
  });
  assert.equal(r.sources[0].agency, 'York County GIS');
  assert.equal(r.sources[0].retrievedAt, at);
});
