import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeParcelId, parseQpublicParcelText, unionReportUrl } from './sc-parcel-parser.js';
import { parseUnionTreasurerDetail, queryQpayTreasurer } from './sc-union-treasurer.js';
import { parseWthgisParcelDetail, queryWthgisParcel } from './sc-wthgis.js';

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

test('qPublic parcel reports retain an explicitly published zoning code', () => {
  const record = parseQpublicParcelText(`
    Parcel Number
    123-00-00-456
    Location Address
    100 MAIN STREET
    Owners
    SAMPLE OWNER
    100 MAIN STREET
    AIKEN SC 29801
    Zoning District
    RC
    2026 Value Information
    Total Market Value $100,000
    Building Information
  `, 'https://qpublic.example/report');
  assert.equal(record.status, 'verified');
  assert.equal(record.zoning, 'RC');
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

test('Union treasurer detail resolves current owner, parcel, assessment, and tax', () => {
  const html = `<body>
    Tax Information Name: PARKER REGINA G Tax Year: 2025 District/Levy: 19 / 350.5
    Total Appraisal: 110,860 Total Assessed: 4,430
    Property Information Record Type: Real Estate Map Number: 049-00-00-112 000 Acres: .00 Lots: 1 Buildings: 1
    Property Address 116 WRIGHT SIMS ROAD Taxes County Tax: $1,552.72 Total Taxes: $675.29
  </body>`;
  const result = parseUnionTreasurerDetail(html, 'https://uniontreasurer.qpaybill.com/detail');
  assert.equal(result.status, 'verified');
  assert.equal(result.ownerName, 'PARKER REGINA G');
  assert.equal(result.parcelId, '049-00-00-112 000');
  assert.equal(result.taxCodeArea, '19');
  assert.equal(result.assessedPropertyValue, 110860);
  assert.equal(result.totalAssessedValue, 4430);
  assert.equal(result.taxAmount, 675.29);
  assert.equal(result.taxYear, 2025);
  assert.equal(result.building.buildingCount, 1);
  assert.equal(result.acres, undefined);
});

test('qPay detail exposes published land, improvement, market, and situs fields', () => {
  const html = `<body>
    <span id="ctl00_MainContent_lblName">GIST JAY NOLAND JR</span>
    <span id="ctl00_MainContent_lblTaxYr">2025</span>
    <span id="ctl00_MainContent_lblDistrict">19 / 350.5</span>
    <span id="ctl00_MainContent_lblMarketVal">11,500</span>
    <span id="ctl00_MainContent_lblAssmt">690</span>
    <span id="ctl00_MainContent_lblLand6">6,300</span>
    <span id="ctl00_MainContent_lblBuilding6">5,200</span>
    <span id="ctl00_MainContent_lblMapNo">049-00-00-038 000</span>
    <span id="ctl00_MainContent_lblAcres">.00</span>
    <span id="ctl00_MainContent_lblPropAddress">3658 JONESVILLE LOCKHART HWY</span>
    <span id="ctl00_MainContent_lblTotalTaxes">$274.01</span>
  </body>`;
  const result = parseUnionTreasurerDetail(html, 'https://uniontreasurer.qpaybill.com/detail');

  assert.equal(result.ownerName, 'GIST JAY NOLAND JR');
  assert.equal(result.parcelId, '049-00-00-038 000');
  assert.equal(result.situsAddress, '3658 JONESVILLE LOCKHART HWY');
  assert.equal(result.landValue, 6300);
  assert.equal(result.improvementValue, 5200);
  assert.equal(result.marketValue, 11500);
  assert.equal(result.assessedPropertyValue, 11500);
  assert.equal(result.totalAssessedValue, 690);
  assert.equal(result.taxAmount, 274.01);
  assert.equal(result.acres, undefined);
});

test('qPay rejects a newer address result for the wrong parcel', async () => {
  let call = 0;
  const fetcher = async () => {
    call += 1;
    if (call === 1) {
      return new Response('<input type="hidden" name="__VIEWSTATE" value="one">', {
        headers: { 'set-cookie': 'ASP.NET_SessionId=test; path=/' },
      });
    }
    if (call === 2) return new Response('<input type="hidden" name="__VIEWSTATE" value="two">');
    if (call === 3) {
      return new Response(`<table>
        <tr><td>RealEstate</td><td>2025</td><td><a href="TaxesDetailsType4.aspx?id=wrong">View</a></td></tr>
        <tr><td>RealEstate</td><td>2024</td><td><a href="TaxesDetailsType4.aspx?id=right">View</a></td></tr>
      </table>`);
    }
    const parcel = call === 4 ? '999-99-99-999' : '049-00-00-112 000';
    const owner = call === 4 ? 'Wrong Owner' : 'PARKER REGINA G';
    return new Response(`<body>
      Name: ${owner} Address: PO BOX 1 UNION SC 29379 Tax Year: 2025 Map Number: ${parcel} Acres: 0
      District/Levy: 19 / Property Address 116 WRIGHT SIMS ROAD Taxes County Tax:
      Total Appraisal: $110,860 Total Assessed: $4,430 Total Taxes: $675.29 Buildings: 1
    </body>`);
  };

  const result = await queryQpayTreasurer(
    'https://uniontreasurer.qpaybill.com/Taxes/TaxesDefaultType4.aspx',
    '116 Wright Sims Road, Union, SC 29379',
    'Union',
    '049-00-00-112',
    fetcher,
  );

  assert.equal(result.ownerName, 'PARKER REGINA G');
  assert.equal(result.parcelId, '049-00-00-112 000');
  assert.equal(result.mailingAddress, 'PO BOX 1 UNION SC 29379');
  assert.equal(call, 5);
});

test('qPay retries a common street-suffix abbreviation', async () => {
  const searchBodies = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).includes('TaxesDetailsType4.aspx')) {
      return new Response(`<body>
        Name: DEESE FRANKLIN DARNELL Address: PO BOX 626<br>MARSHVILLE NC 28103 Tax Year: 2025
        Map Number: 086-00-00-020 Acres: 42.7 District/Levy: 287 /
        Property Address 2229 SHAMROCK RD Taxes County Tax: Total Appraisal: $5,400
        Total Assessed: $220 Total Taxes: $66.13 Buildings: 0
      </body>`);
    }
    if (!init.method) {
      return new Response('<input type="hidden" name="__VIEWSTATE" value="one">', {
        headers: { 'set-cookie': 'ASP.NET_SessionId=test; path=/' },
      });
    }
    const body = String(init.body || '');
    if (body.includes('ddlCriteriaList') && !body.includes('txtCriteriaBox')) {
      return new Response('<input type="hidden" name="__VIEWSTATE" value="two">');
    }
    if (body.includes('txtCriteriaBox')) {
      searchBodies.push(body);
      if (body.includes('Shamrock+Road')) return new Response('<table></table>');
      return new Response('<table><tr><td>RealEstate</td><td>2025</td><td>086-00-00-020</td><td><a href="TaxesDetailsType4.aspx?id=right">View</a></td></tr></table>');
    }
    return new Response('<table></table>');
  };

  const result = await queryQpayTreasurer(
    'https://kershawcounty.qpaybill.com/Taxes/TaxesDefaultType4.aspx',
    '2229 Shamrock Road, Kershaw, SC',
    'Kershaw',
    '086-00-00-020',
    fetcher,
  );

  assert.equal(result.ownerName, 'DEESE FRANKLIN DARNELL');
  assert.equal(result.mailingAddress, 'PO BOX 626 MARSHVILLE NC 28103');
  assert.equal(searchBodies.length, 2);
  assert.match(searchBodies[1], /Shamrock%2BRD|Shamrock\+RD/);
});

test('WTHGIS detail resolves official owner, land, values, and building data', () => {
  const xml = `<overlay><info><![CDATA[
    <table>
      <tr><th>Map Number</th><td>086 000 000 085</td></tr>
      <tr><th>Owner Name</th><td>Deese Joe Franklin</td></tr>
      <tr><th>Mailing Address1</th><td>5804 Highway 265</td></tr>
      <tr><th>Mailing City</th><td>Ruby</td></tr>
      <tr><th>Mailing State</th><td>SC</td></tr>
      <tr><th>Mailing ZipCode</th><td>29741</td></tr>
      <tr><th>Legal Description</th><td>Lot 5 2.68 Ac</td></tr>
      <tr><th>District</th><td>09</td></tr>
      <tr><th>Zoning</th><td>R-1</td></tr>
      <tr><th>MarketValueBuildings</th><td>1.00</td></tr>
      <tr><th>MarketValueBuildingsValue</th><td>72000.00</td></tr>
      <tr><th>MarketValueLandValue</th><td>25000.00</td></tr>
      <tr><th>MarketValueTotalAssessed</th><td>3880.00</td></tr>
      <tr><th>MarketValueTotalValue</th><td>97000.00</td></tr>
      <tr><th>TaxValueTotalValue</th><td>97000.00</td></tr>
    </table>
  ]]></info></overlay>`;
  const result = parseWthgisParcelDetail(xml, 'https://chesterfieldsc.wthgis.com/detail', 'Chesterfield');
  assert.equal(result.status, 'verified');
  assert.equal(result.ownerName, 'Deese Joe Franklin');
  assert.equal(result.parcelId, '086 000 000 085');
  assert.equal(result.mailingAddress, '5804 Highway 265, Ruby, SC 29741');
  assert.equal(result.acres, 2.68);
  assert.equal(result.taxCodeArea, '09');
  assert.equal(result.zoning, 'R-1');
  assert.equal(result.landValue, 25000);
  assert.equal(result.improvementValue, 72000);
  assert.equal(result.marketValue, 97000);
  assert.equal(result.totalAssessedValue, 3880);
  assert.equal(result.building.buildingCount, 1);
});

test('WTHGIS resolves an exact address without relying on a candidate owner', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response("addMenuItem('x','x',\"fetchOverlay('tgis/custom.aspx?DSID=6796&RequestType=CustomSearchForm&FormType=BasicParcels')\")");
    }
    return new Response(`<overlay><info><![CDATA[
      <table>
        <tr><th>Map Number</th><td>086 000 000 085</td></tr>
        <tr><th>Owner Name</th><td>Deese Joe Franklin</td></tr>
        <tr><th>Legal Description</th><td>Lot 5 2.68 Ac</td></tr>
        <tr><th>MarketValueTotalValue</th><td>97000.00</td></tr>
      </table>
    ]]></info></overlay>`);
  };

  const result = await queryWthgisParcel({
    portalUrl: 'https://chesterfieldsc.wthgis.com/',
    address: '5804 Highway 265, Ruby, SC 29741',
    parcelId: '086-000-000-085',
    county: 'Chesterfield',
    fetcher,
  });

  assert.equal(result.ownerName, 'Deese Joe Franklin');
  assert.equal(result.parcelId, '086 000 000 085');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /tgis\/search\.aspx\?S=5804\+Highway\+265&M=99&redir=1$/);
});

test('SC manifest contains every county and normal searches do not invoke Enformion property matching', async () => {
  const manifest = await readFile(new URL('../../../src/data/scCountySources.ts', import.meta.url), 'utf8');
  const counties = [...manifest.matchAll(/\{ county: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(counties.length, 46);
  assert.equal(new Set(counties).size, 46);
  assert.ok((manifest.match(/treasurerUrl:/g) || []).length >= 18);

  const component = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
  const start = component.indexOf('const generateCostEstimates');
  const end = component.indexOf('const changeCompRadius', start);
  const automaticSearchBlock = component.slice(start, end);
  assert.doesNotMatch(automaticSearchBlock, /enformionPropertySearch|fetchEnformionRecords|ContactEnrich|PersonSearch|BusinessSearch/);
  assert.match(component, /Skip Trace Owner \(Paid\)/);
});

test('SC map, zoning, utilities, and clearing estimates require visible provenance', async () => {
  const service = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
  const geminiZoning = await readFile(new URL('../../../src/services/geminiZoningSearch.ts', import.meta.url), 'utf8');
  const component = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
  const proxy = await readFile(new URL('../perplexity-chat.js', import.meta.url), 'utf8');
  const viteConfig = await readFile(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

  assert.match(geminiZoning, /'parcel-gis'[\s\S]*'official-address-result'[\s\S]*'official-parcel-report'/);
  assert.match(service, /mode: 'hard'/);
  assert.match(geminiZoning, /Prefer official parcel GIS, official address results, and official parcel reports/);
  assert.match(service, /officialMethods[\s\S]*requestedParcelSource[\s\S]*evidenceUrlAllowed/);
  assert.match(service, /SCDOT statewide snapshot owner/);
  assert.doesNotMatch(service, /UTIL_ESTIMATE|TREE_RATE_FALLBACK|CLEARING_FALLBACK/);
  assert.match(service, /A number without a line-specific source URL is invalid/);
  assert.match(service, /source-backed budget range/);
  assert.match(component, /Current tax-roll owner/);
  assert.match(component, /No current pricing source was verified; no dollar estimate is shown/);
  assert.match(component, /sourced estimate/);
  assert.match(component, /Zoning evidence sources/);
  assert.match(proxy, /Cache-Control': 'no-store'/);
  assert.match(viteConfig, /perplexity-chat[\s\S]*chat\/completions/);
});
