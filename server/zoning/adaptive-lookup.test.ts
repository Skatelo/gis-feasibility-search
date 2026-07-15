import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoningLookupEngine } from '../../src/services/zoning/orchestrator';
import { createInMemoryRegistry, jurisdictionKey } from '../../src/services/zoning/registry';
import type { DiscoveredSource, GeocodedAddress, Geocoder, JurisdictionResult } from '../../src/services/zoning/types';
import { AdaptiveZoningLookupService } from './adaptive-lookup';

const address: GeocodedAddress = {
  inputAddress: '100 Main Street, Exampleville, NC 28000',
  formattedAddress: '100 Main St, Exampleville, NC 28000',
  latitude: 35.2,
  longitude: -80.8,
  state: 'North Carolina',
  stateCode: 'NC',
  county: 'Example County',
  municipality: 'Exampleville',
  postalCode: '28000',
  country: 'US',
  locationType: 'rooftop',
  provider: 'fixture',
  raw: {},
};

const jurisdiction: JurisdictionResult = {
  state: 'North Carolina', stateCode: 'NC', county: 'Example County', municipality: 'Exampleville',
  incorporated: true, zoningAuthority: 'City of Exampleville', jurisdictionType: 'municipal', confidence: 98, evidence: [],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('registry miss discovers, proves, saves, and reuses an official ArcGIS zoning source', async () => {
  const serviceUrl = 'https://gis.exampleville.gov/arcgis/rest/services/Planning/Current_Zoning/MapServer';
  const candidate: DiscoveredSource = {
    url: serviceUrl,
    sourceType: 'arcgis-mapserver',
    official: true,
    agency: 'City of Exampleville',
    officialPageUrl: 'https://exampleville.gov/planning/zoning-map',
    officialReason: 'Official government domain',
    discoveredFrom: ['fixture'],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/MapServer')) {
      return json({ layers: [{ id: 0, name: 'Current Zoning', geometryType: 'esriGeometryPolygon' }] });
    }
    if (url.pathname.endsWith('/MapServer/0')) {
      return json({
        id: 0,
        name: 'Current Zoning',
        description: 'Official current zoning districts',
        geometryType: 'esriGeometryPolygon',
        capabilities: 'Map,Query,Data',
        fields: [
          { name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'ZONE_CODE', alias: 'Zoning Code', type: 'esriFieldTypeString' },
          { name: 'ZONE_NAME', alias: 'Zoning Name', type: 'esriFieldTypeString' },
        ],
        drawingInfo: { renderer: { type: 'uniqueValue', field1: 'ZONE_CODE' } },
        spatialReference: { wkid: 4326 },
      });
    }
    if (url.pathname.endsWith('/MapServer/0/query')) {
      return json({ features: [{ attributes: { OBJECTID: 1, ZONE_CODE: 'R-3', ZONE_NAME: 'Residential' } }] });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    let discoveryCalls = 0;
    const registry = createInMemoryRegistry();
    const geocoder: Geocoder = {
      name: 'fixture', isConfigured: () => true,
      geocode: async () => address,
      reverseGeocode: async () => address,
    };
    const engine = new ZoningLookupEngine({ geocoder, registry, jurisdictionResolver: async () => jurisdiction });
    const adaptive = new AdaptiveZoningLookupService({
      engine,
      registry,
      config: {},
      discover: async () => { discoveryCalls += 1; return [candidate]; },
    });

    const first = await adaptive.lookup({ address: address.inputAddress, mode: 'verified' });
    assert.equal(first.result.zoning.code, 'R-3');
    assert.equal(first.result.status, 'verified');
    assert.equal(first.discoveryAttempted, true);
    assert.equal(discoveryCalls, 1);
    assert.ok(first.result.diagnostics.timings.discoveryMs >= 0);
    const key = jurisdictionKey({ country: 'US', stateCode: 'NC', county: jurisdiction.county, municipality: jurisdiction.municipality, jurisdictionType: 'municipal' });
    assert.equal((await registry.get(key))?.healthStatus, 'healthy');

    const second = await adaptive.lookup({ address: address.inputAddress, mode: 'verified' });
    assert.equal(second.result.zoning.code, 'R-3');
    assert.equal(second.discoveryAttempted, false);
    assert.equal(discoveryCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
