import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAllowedArcgisHost, isArcgisRestPath } from './arcgis-host.js';

const REST = '/arcgis/rest/services/PublicGIS/Zoning/MapServer/identify?f=json';

test('the county GIS that triggered this fix is allowed', () => {
  // Gaston County serves public zoning but sends no Access-Control-Allow-Origin,
  // so the browser cannot read it directly — this is the host the proxy exists
  // for. An identify here returns RS-12 for 1992 Garland Ave.
  assert.equal(
    isAllowedArcgisHost('https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer/identify'),
    true,
  );
});

test('public-sector and Esri hosts are allowed', () => {
  for (const host of [
    'https://gis.gastoncountync.gov',
    'https://maps.co.forsyth.nc.us',
    'https://location.cabarruscounty.us',
    'https://gcgis.guilfordcountync.gov',
    'https://services1.arcgis.com',
    'https://tiles.arcgis.com',
  ]) {
    assert.equal(isAllowedArcgisHost(`${host}${REST}`), true, host);
  }
});

test('the proxy is not an open relay', () => {
  for (const url of [
    'https://example.com/arcgis/rest/services/x/MapServer',
    'https://evil.io/arcgis/rest/services/x/MapServer',
    'https://arcgis.com.evil.io/arcgis/rest/services/x/MapServer',
    'https://api.openai.com/v1/models',
  ]) {
    assert.equal(isAllowedArcgisHost(url), false, url);
  }
});

test('internal and loopback targets are refused (SSRF)', () => {
  for (const url of [
    'https://localhost/arcgis/rest/services/x/MapServer',
    'https://127.0.0.1/arcgis/rest/services/x/MapServer',
    'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://10.0.0.5/arcgis/rest/services/x/MapServer',
    'https://192.168.1.10/arcgis/rest/services/x/MapServer',
    'https://172.16.4.4/arcgis/rest/services/x/MapServer',
  ]) {
    assert.equal(isAllowedArcgisHost(url), false, url);
  }
});

test('plaintext http and malformed urls are refused', () => {
  assert.equal(isAllowedArcgisHost('http://gis.gastoncountync.gov/arcgis/rest/services/x/MapServer'), false);
  assert.equal(isAllowedArcgisHost('not a url'), false);
  assert.equal(isAllowedArcgisHost(''), false);
  assert.equal(isAllowedArcgisHost(null), false);
});

test('only ArcGIS REST paths pass, not arbitrary paths on an allowed host', () => {
  assert.equal(isArcgisRestPath('https://gis.gastoncountync.gov/publicgis/rest/services/A/MapServer/2/query'), true);
  assert.equal(isArcgisRestPath('https://some.gov/internal/admin/secrets.json'), false);
  assert.equal(isArcgisRestPath('https://some.gov/'), false);
});

test('the proxy function enforces both checks before fetching', () => {
  // Guards against someone later relaxing the handler and reintroducing SSRF.
  const src = readFileSync(new URL('../arcgis-proxy.js', import.meta.url), 'utf8');
  assert.match(src, /isAllowedArcgisHost\(target\)/, 'host is validated');
  assert.match(src, /isArcgisRestPath\(target\)/, 'path is validated');
  assert.match(src, /statusCode: 403/, 'rejects disallowed targets');
});
