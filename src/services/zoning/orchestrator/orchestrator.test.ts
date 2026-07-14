import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordFromInspected, inspectedFromRecord } from './record-mapper';
import { ZoningLookupEngine } from './zoning-engine';
import { CensusGeocoder } from '../geocoding';
import { createInMemoryRegistry } from '../registry';
import { SourceDiscoveryService, type SearchResult } from '../discovery';
import type { InspectedZoningSource, JurisdictionResult } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';

const jur: JurisdictionResult = {
  state: 'NC', stateCode: 'NC', county: 'Wake County', municipality: 'Raleigh', incorporated: true,
  zoningAuthority: 'Raleigh', jurisdictionType: 'municipal', confidence: 92, evidence: [],
};

const inspected: InspectedZoningSource = {
  source: { url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer', sourceType: 'arcgis-mapserver', official: true, agency: 'Wake', discoveredFrom: ['test'] },
  serviceUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer',
  sourceType: 'arcgis-mapserver',
  metadataUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer',
  accessedAt: new Date().toISOString(),
  layers: [
    {
      id: 23, name: 'Raleigh Zoning', role: 'zoning', roleConfidence: 0.9, geometryType: 'esriGeometryPolygon',
      supportsQuery: true, displayField: 'ZONING', objectIdField: 'OBJECTID',
      fields: [{ name: 'ZONING', alias: 'Zoning', type: 'esriFieldTypeString' }], maxRecordCount: 1000, spatialReferenceWkid: 2264,
      layerUrl: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer/23',
      fieldMapping: { zoningCodeField: 'ZONING', zoningDescriptionField: 'ZONE_TYPE_DECODE', jurisdictionField: null, overlayField: null, detectionConfidence: 0.9, reasons: [] },
      reasons: [],
    },
  ],
};

test('record <-> inspected source round-trips the queryable layer', () => {
  const record = recordFromInspected(jur, inspected);
  assert.equal(record.municipalityName, 'Raleigh');
  assert.equal(record.zoningLayers.length, 1);
  assert.equal(record.zoningLayers[0].fieldMapping.zoningCodeField, 'ZONING');
  assert.ok(record.metadataHash);

  const rebuilt = inspectedFromRecord(record);
  assert.equal(rebuilt.serviceUrl, inspected.serviceUrl);
  assert.equal(rebuilt.layers[0].layerUrl, inspected.layers[0].layerUrl);
  assert.equal(rebuilt.layers[0].fieldMapping.zoningCodeField, 'ZONING');
  assert.equal(rebuilt.layers[0].supportsQuery, true);
});

test('invalid input yields an error result, not a throw', async () => {
  const engine = new ZoningLookupEngine({
    geocoder: new CensusGeocoder(),
    registry: createInMemoryRegistry(),
    discovery: new SourceDiscoveryService(async () => [], async () => ''),
  });
  const r = await engine.lookup({ address: '' });
  assert.equal(r.status, 'error');
  assert.equal(r.errors[0].stage, 'input-validation');
});

test('live: full discover-once -> save -> reuse loop resolves a real district', { skip: !LIVE }, async () => {
  let searchCalls = 0;
  // Deterministic "search" standing in for Perplexity: returns the real Wake
  // service so the whole discover -> inspect -> save -> query loop runs live.
  const search = async (): Promise<SearchResult[]> => {
    searchCalls++;
    return [{ url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer' }];
  };
  const registry = createInMemoryRegistry();
  const engine = new ZoningLookupEngine({
    geocoder: new CensusGeocoder(),
    registry,
    discovery: new SourceDiscoveryService(search, async () => ''),
  });

  const r1 = await engine.lookup({ address: '227 Fayetteville St, Raleigh, NC', includeOverlays: false });
  assert.equal(r1.zoning.code, 'DX-40-SH', JSON.stringify({ code: r1.zoning.code, status: r1.status, errors: r1.errors }));
  assert.ok(['verified', 'verified-with-warnings'].includes(r1.status), `status ${r1.status}`);
  assert.match(r1.jurisdiction.zoningAuthority ?? '', /Raleigh/i);
  assert.ok(r1.source?.official);
  assert.equal(searchCalls, 1, 'first lookup performs discovery');

  // Second lookup in the same jurisdiction must reuse the registry — no new
  // discovery, same deterministic result.
  const r2 = await engine.lookup({ address: '227 Fayetteville St, Raleigh, NC', includeOverlays: false });
  assert.equal(r2.zoning.code, 'DX-40-SH');
  assert.equal(searchCalls, 1, 'second lookup reuses the cached source (no rediscovery)');
  assert.ok(r2.confidence.reasons.some((x) => /registry/i.test(x)), 'second lookup should be registry-sourced');
});
