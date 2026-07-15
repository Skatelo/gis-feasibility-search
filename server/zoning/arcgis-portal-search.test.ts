import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOfficialArcgisPortal } from '../../src/services/zoning/discovery';
import type { JurisdictionResult } from '../../src/services/zoning/types';

const jurisdiction: JurisdictionResult = {
  state: 'North Carolina',
  stateCode: 'NC',
  county: 'Example County',
  municipality: 'Exampleville',
  incorporated: true,
  zoningAuthority: 'City of Exampleville',
  jurisdictionType: 'municipal',
  confidence: 95,
  evidence: [],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('ArcGIS portal discovery requires a matching government organization for hosted services', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/sharing/rest/search?')) {
      return json({ results: [{
        id: 'a'.repeat(32),
        title: 'Exampleville Current Zoning',
        type: 'Feature Service',
        url: 'https://services.arcgis.com/abc/arcgis/rest/services/Current_Zoning/FeatureServer',
        owner: 'ExamplevilleGIS',
        orgId: 'official-org',
        access: 'public',
        tags: ['zoning', 'planning'],
      }] });
    }
    if (url.includes('/sharing/rest/portals/official-org')) {
      return json({ name: 'City of Exampleville GIS', description: 'Official municipal government GIS portal' });
    }
    return new Response('not found', { status: 404 });
  };

  const sources = await searchOfficialArcgisPortal(jurisdiction, { fetchImpl });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].official, true);
  assert.match(sources[0].officialReason ?? '', /organization/i);
});

test('ArcGIS portal discovery rejects future land-use items even from an official organization', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/sharing/rest/search?')) {
      return json({ results: [{
        id: 'b'.repeat(32),
        title: 'Exampleville Future Land Use Zoning Plan',
        type: 'Map Service',
        url: 'https://services.arcgis.com/abc/arcgis/rest/services/Future_Land_Use/MapServer',
        owner: 'ExamplevilleGIS',
        orgId: 'official-org',
        access: 'public',
      }] });
    }
    return json({ name: 'City of Exampleville GIS' });
  };
  assert.deepEqual(await searchOfficialArcgisPortal(jurisdiction, { fetchImpl }), []);
});
