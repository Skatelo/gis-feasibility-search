import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrlSyntax, isSafeUrl, isPrivateAddress, UnsafeUrlError } from '../utils/url-security';
import { assessOfficialDomain } from './official-domain-detector';
import { extractEndpoints, endpointSourceType } from './arcgis-url-extractor';
import { buildDiscoveryQueries } from './search-query-builder';
import { SourceDiscoveryService, type SearchResult } from './source-discovery.service';
import type { JurisdictionResult } from '../types';

const LIVE = process.env.ZONING_LIVE === '1';

// --- URL security (SSRF) ---------------------------------------------------

test('url-security rejects private, loopback, metadata, and non-http targets', () => {
  assert.ok(isPrivateAddress('10.0.0.1'));
  assert.ok(isPrivateAddress('192.168.1.1'));
  assert.ok(isPrivateAddress('127.0.0.1'));
  assert.ok(isPrivateAddress('169.254.169.254'));
  assert.ok(!isPrivateAddress('8.8.8.8'));
  assert.throws(() => validateUrlSyntax('http://localhost/x'), UnsafeUrlError);
  assert.throws(() => validateUrlSyntax('http://169.254.169.254/latest/meta-data'), UnsafeUrlError);
  assert.throws(() => validateUrlSyntax('file:///etc/passwd'), UnsafeUrlError);
  assert.throws(() => validateUrlSyntax('http://user:pass@example.gov/'), UnsafeUrlError);
  assert.ok(isSafeUrl('https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer'));
});

test('url-security allowlist restricts hosts', () => {
  assert.ok(isSafeUrl('https://gis.wakegov.com/x', { allowlist: ['wakegov.com'] }));
  assert.throws(() => validateUrlSyntax('https://evil.com/x', { allowlist: ['wakegov.com'] }), UnsafeUrlError);
});

// --- Official-domain detection ---------------------------------------------

test('official-domain detector scores gov high and third-party low', () => {
  assert.ok(assessOfficialDomain('https://maps.raleighnc.gov/x').official);
  assert.ok(assessOfficialDomain('https://gis.co.wake.nc.us/x').official);
  assert.equal(assessOfficialDomain('https://www.zillow.com/x').official, false);
  const esri = assessOfficialDomain('https://services.arcgis.com/abc/arcgis/rest/services/Zoning/FeatureServer', {
    municipality: 'Cary',
  });
  assert.ok(esri.score > 0 && esri.score <= 0.6); // possibly-official, must be verified
});

// --- Endpoint extraction ---------------------------------------------------

test('extractor pulls MapServer/FeatureServer URLs from HTML and escaped JSON', () => {
  const html = `
    <script>var svc = "https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer/23";</script>
    <a href="https://gis.example.gov/server/rest/services/Parcels/FeatureServer">parcels</a>
    config: {"url":"https:\\/\\/services1.arcgis.com\\/abc\\/arcgis\\/rest\\/services\\/Overlays\\/MapServer"}
    <link href="https://data.example.gov/zoning.geojson">
  `;
  const e = extractEndpoints(html);
  assert.ok(e.arcgisServices.some((u) => /Planning\/Zoning\/MapServer$/.test(u)), JSON.stringify(e.arcgisServices));
  assert.ok(e.arcgisServices.some((u) => /Parcels\/FeatureServer$/.test(u)));
  assert.ok(e.arcgisServices.some((u) => /Overlays\/MapServer$/.test(u)));
  assert.ok(e.geojsonEndpoints.some((u) => /zoning\.geojson$/.test(u)));
  assert.equal(endpointSourceType('https://x.gov/rest/services/Z/FeatureServer'), 'arcgis-featureserver');
});

// --- Query builder ---------------------------------------------------------

test('query builder targets the governing authority and state', () => {
  const jur: JurisdictionResult = {
    state: 'North Carolina', stateCode: 'NC', county: 'Wake County', municipality: 'Raleigh',
    incorporated: true, zoningAuthority: 'Raleigh', jurisdictionType: 'municipal', confidence: 92, evidence: [],
  };
  const qs = buildDiscoveryQueries(jur);
  assert.ok(qs.length > 0 && qs.length <= 8);
  assert.ok(qs.some((q) => /Raleigh/.test(q) && /zoning/i.test(q)));
  assert.ok(qs.some((q) => /Wake County/.test(q)));
});

// --- Discovery service (mock search + fetch) --------------------------------

const municipalJur: JurisdictionResult = {
  state: 'North Carolina', stateCode: 'NC', county: 'Wake County', municipality: 'Raleigh',
  incorporated: true, zoningAuthority: 'Raleigh', jurisdictionType: 'municipal', confidence: 92, evidence: [],
};

test('discovery records a direct official ArcGIS URL from search results', async () => {
  const search = async (): Promise<SearchResult[]> => [
    { url: 'https://maps.raleighnc.gov/arcgis/rest/services/Planning/Zoning/MapServer' },
    { url: 'https://www.zillow.com/raleigh-nc/' },
  ];
  const svc = new SourceDiscoveryService(search, async () => '');
  const sources = await svc.discover(municipalJur);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceType, 'arcgis-mapserver');
  assert.ok(sources[0].official);
});

test('discovery crawls an official page and extracts the embedded service URL', async () => {
  const search = async (): Promise<SearchResult[]> => [{ url: 'https://gis.raleighnc.gov/portal/apps/zoning' }];
  const fetchPage = async () =>
    '<script>const layer="https://maps.raleighnc.gov/arcgis/rest/services/Planning/Zoning/MapServer/23";</script>';
  const svc = new SourceDiscoveryService(search, fetchPage);
  const sources = await svc.discover(municipalJur);
  assert.ok(sources.some((s) => /Planning\/Zoning\/MapServer$/.test(s.url)));
});

test('an official government page can establish context for its ArcGIS-hosted service', async () => {
  const officialPage = 'https://raleighnc.gov/planning/services/zoning-map';
  const hosted = 'https://services.arcgis.com/abc/arcgis/rest/services/Raleigh_Current_Zoning/FeatureServer';
  const svc = new SourceDiscoveryService(
    async () => [{ url: officialPage }],
    async () => `<script>const zoning = "${hosted}";</script>`,
  );
  const sources = await svc.discover(municipalJur);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].official, true);
  assert.equal(sources[0].officialPageUrl, officialPage);
});

test('discovery excludes third-party sources unless explicitly allowed', async () => {
  // A direct endpoint hosted on a third-party aggregator: excluded by default,
  // recorded only when third-party sources are explicitly allowed.
  const search = async (): Promise<SearchResult[]> => [
    { url: 'https://www.zoneomics.com/api/raleigh/zoning.geojson' },
  ];
  const svc = new SourceDiscoveryService(search, async () => '');
  assert.equal((await svc.discover(municipalJur)).length, 0);
  assert.equal((await svc.discover(municipalJur, { allowThirdParty: true })).length, 1);
});

// --- Live: real page fetch + extraction ------------------------------------

test('live: fetch a real government GIS page and extract the clean REST service URL', { skip: !LIVE }, async () => {
  const { httpPageFetcher } = await import('./providers');
  const { extractEndpoints } = await import('./arcgis-url-extractor');
  // A real ArcGIS REST HTML page embeds its service URL inside a "View In:
  // ArcGIS.com Map" viewer link (…?url=<serviceUrl>). Real fetch + extraction
  // must recover the clean REST endpoint, not the viewer wrapper.
  const text = await httpPageFetcher(12000)('https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer');
  assert.ok(text.length > 0, 'expected page content');
  const e = extractEndpoints(text);
  assert.ok(
    e.arcgisServices.some((u) => /\/rest\/services\/Planning\/Zoning\/MapServer$/i.test(u)),
    `expected the clean REST URL, got ${JSON.stringify(e.arcgisServices)}`,
  );
  assert.ok(
    !e.arcgisServices.some((u) => /mapviewer|viewer\.html|\/apps\//i.test(u)),
    'must not return a viewer/app wrapper URL',
  );
});
