import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeParcelId, parseQpublicParcelText, unionReportUrl } from './sc-parcel-parser.js';

const UNION_REPORT = `
Parcel Number
049-00-00-112 000
Tax District
County (District 19)
Location Address
116 WRIGHT SIMS ROAD
Owners
PARKER REGINA G
116 WRIGHT SIMS ROAD
UNION SC
29379
2025 Value Information
Land Market Value $7,300 Improvement Market Value $226,400 Total Market Value $233,700 Taxable Value $110,860 Total Assessed Value $4,430
Building Information
First Floor Sq Ft
2237
Second Floor Sq Ft
0
Baths
1.00
Stories
1.00
1 Building(s) on Parcel
Last Data Upload: 7/9/2026, 6:03:17 PM
`;

test('Union qPublic fixture parses official owner, parcel, values, and building', () => {
  const record = parseQpublicParcelText(UNION_REPORT, 'https://qpublic.example/report');
  assert.equal(record.status, 'verified');
  assert.equal(record.parcelId, '049-00-00-112 000');
  assert.equal(record.normalizedParcelId, '0490000112000');
  assert.equal(record.ownerName, 'PARKER REGINA G');
  assert.equal(record.situsAddress, '116 WRIGHT SIMS ROAD');
  assert.equal(record.taxCodeArea, '19');
  assert.equal(record.assessedYear, 2025);
  assert.equal(record.landValue, 7300);
  assert.equal(record.improvementValue, 226400);
  assert.equal(record.marketValue, 233700);
  assert.equal(record.taxableValue, 110860);
  assert.equal(record.building.livingSqft, 2237);
  assert.equal(record.building.baths, 1);
  assert.equal(record.building.stories, 1);
  assert.equal(record.building.buildingCount, 1);
});

test('blocked assessor pages are not treated as verified data', () => {
  assert.deepEqual(
    parseQpublicParcelText('Attention Required! Sorry, you have been blocked', 'https://qpublic.example'),
    { status: 'blocked', sourceUrl: 'https://qpublic.example' },
  );
});

test('Union report URL pads the county suffix without caching a result', () => {
  const url = unionReportUrl('049-00-00-112');
  assert.match(url, /KeyValue=049-00-00-112%20000$/);
  assert.equal(normalizeParcelId('049-00-00-112 000'), '0490000112000');
  assert.notEqual(normalizeParcelId('049-00-00-112'), normalizeParcelId('049-00-00-112 000'));
});

test('SC manifest contains every county and normal searches do not invoke Enformion property matching', async () => {
  const manifest = await readFile(new URL('../../../src/data/scCountySources.ts', import.meta.url), 'utf8');
  const counties = [...manifest.matchAll(/\{ county: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(counties.length, 46);
  assert.equal(new Set(counties).size, 46);

  const component = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
  const start = component.indexOf('const generateCostEstimates');
  const end = component.indexOf('const changeCompRadius', start);
  const automaticSearchBlock = component.slice(start, end);
  assert.doesNotMatch(automaticSearchBlock, /enformionPropertySearch|fetchEnformionRecords|ContactEnrich|PersonSearch|BusinessSearch/);
  assert.match(component, /Skip Trace Owner \(Paid\)/);
});
