import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence } from './confidence-calculator';
import type { GeocodedAddress, JurisdictionResult, DiscoveredSource } from '../types';

const rooftop: GeocodedAddress = {
  inputAddress: 'x', formattedAddress: 'x', latitude: 35, longitude: -80, locationType: 'rooftop', provider: 'google', raw: null,
};
const strongJur: JurisdictionResult = {
  state: 'NC', stateCode: 'NC', county: 'Wake County', municipality: 'Raleigh', incorporated: true,
  zoningAuthority: 'Raleigh', jurisdictionType: 'municipal', confidence: 92, evidence: [],
};
const officialRest: DiscoveredSource = {
  url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer', sourceType: 'arcgis-mapserver', official: true, agency: 'Wake', discoveredFrom: [],
};

test('official GIS + strong jurisdiction + polygon match => high confidence', () => {
  const c = computeConfidence({ address: rooftop, jurisdiction: strongJur, parcel: null, zoningFound: true, zoningMatchQuality: 'geocode-point', source: officialRest });
  assert.ok(c.overall >= 80, `overall ${c.overall}`);
  assert.equal(c.warnings.length, 0);
});

test('weak jurisdiction caps overall confidence', () => {
  const weakJur: JurisdictionResult = { ...strongJur, confidence: 40, jurisdictionType: 'unknown' };
  const c = computeConfidence({ address: rooftop, jurisdiction: weakJur, parcel: null, zoningFound: true, zoningMatchQuality: 'geocode-point', source: officialRest });
  assert.ok(c.overall <= 65, `overall ${c.overall}`);
  assert.ok(c.warnings.some((w) => /jurisdiction/i.test(w)));
});

test('unofficial source caps confidence and warns', () => {
  const thirdParty: DiscoveredSource = { ...officialRest, official: false, sourceType: 'html-lookup' };
  const c = computeConfidence({ address: rooftop, jurisdiction: strongJur, parcel: null, zoningFound: true, zoningMatchQuality: 'geocode-point', source: thirdParty });
  assert.ok(c.overall <= 60);
  assert.ok(c.warnings.some((w) => /official/i.test(w)));
});

test('no zoning found caps confidence low and warns', () => {
  const c = computeConfidence({ address: rooftop, jurisdiction: strongJur, parcel: null, zoningFound: false, zoningMatchQuality: 'none', source: officialRest });
  assert.ok(c.overall <= 40);
  assert.equal(c.zoningMatch, 0);
});

test('parcel-polygon intersection scores highest for the zoning factor', () => {
  const c = computeConfidence({ address: rooftop, jurisdiction: strongJur, parcel: { parcelId: '1', sourceUrl: 'x', matchMethod: 'contains-geocode-point' }, zoningFound: true, zoningMatchQuality: 'parcel-polygon-intersect', source: officialRest });
  assert.ok(c.zoningMatch >= 95);
  assert.ok(c.parcelMatch >= 85);
});
