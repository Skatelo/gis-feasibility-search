import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeParcelId,
  normalizeSitusAddress,
  parseQpublicParcelText,
  scParcelIdsMatch,
  situsAddressesMatch,
  unionReportUrl,
} from './sc-parcel-parser.js';
import { __testables as parcelDiscoveryTestables } from './sc-parcel-discovery.js';
import {
  parseBerkeleyDeedHtml,
  parseBerkeleyPropertyHtml,
  parseCharlestonPropertyHtml,
  parseGreenvillePropertyHtml,
  parseGreenwoodPropertyHtml,
  parseSpatialestPropertyText,
  queryOfficialCountyProperty,
} from './sc-county-property.js';
import { scOwnerPortalFor, scOwnerVerificationUrl } from './sc-owner-portals.js';
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

test('current qPublic Owner Information reports retain the assessor owner and do not invent zero values', () => {
  const record = parseQpublicParcelText(`
    Parcel ID
    104-12-19-001
    Location Address
    1930 UNIVERSITY PKWY
    Owner Information
    AIKEN COUNTY
    1930 UNIVERSITY PKWY
    AIKEN, SC 29801
    General Information
    Property Valuation History
    2026
    Market Land Value $126,000
    Market Improvement Value $5,356,120
    Total Market/Exemption Value $5,482,120
  `, 'https://qpublic.schneidercorp.com/report');

  assert.equal(record.status, 'verified');
  assert.equal(record.ownerName, 'AIKEN COUNTY');
  assert.equal(record.parcelId, '104-12-19-001');
  assert.equal(record.situsAddress, '1930 UNIVERSITY PKWY');
  assert.equal(record.mailingAddress, '1930 UNIVERSITY PKWY, AIKEN, SC 29801');
  assert.equal(record.assessedYear, 2026);
  assert.equal(record.landValue, 126000);
  assert.equal(record.improvementValue, 5356120);
  assert.equal(record.marketValue, 5482120);
  assert.equal(record.taxAmount, undefined);
  assert.equal(record.building.livingSqft, undefined);
});

test('current qPublic singular Owner heading is parsed', () => {
  const record = parseQpublicParcelText(`
    Parcel Number
    4191-07-58-2437
    Location Address
    222 MCDANIEL AVE
    Owner
    PICKENS COUNTY OF
    222 MCDANIEL AVE
    PICKENS SC 29671
    Property Information
  `, 'https://qpublic.schneidercorp.com/report');
  assert.equal(record.ownerName, 'PICKENS COUNTY OF');
  assert.equal(record.ownerRecordType, 'assessor');
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

test('qPublic map shell labels are never mistaken for a parcel report', () => {
  assert.deepEqual(
    parseQpublicParcelText('Layers\nParcel Numbers\nOwner Names\nLocation Address Search', 'https://qpublic.example/map'),
    { status: 'unavailable', sourceUrl: 'https://qpublic.example/map' },
  );
});

test('SC assessor identity helpers match address abbreviations and parcel suffixes', () => {
  assert.equal(normalizeSitusAddress('21 Magnolia Street, York, SC 29745'), '21 MAGNOLIA ST');
  assert.equal(situsAddressesMatch('21 MAGNOLIA ST', '21 Magnolia Street York SC 29745'), true);
  assert.equal(situsAddressesMatch('17 MAGNOLIA ST', '21 Magnolia Street, York, SC'), false);
  assert.equal(scParcelIdsMatch('049-00-00-112', '049-00-00-112 000'), true);
  assert.equal(scParcelIdsMatch('049-00-00-113', '049-00-00-112 000'), false);
});

test('SC discovery selects the searched situs parcel instead of the first road-side neighbor', () => {
  const features = [
    { attributes: { ParcelID: '0700202027', PropertyAddress: '17 MAGNOLIA ST', Owner1: 'THOMASSON HELEN L ETAL' } },
    { attributes: { ParcelID: '0700202025', PropertyAddress: '21 MAGNOLIA ST', Owner1: 'LOWRY NAOMI LIFE ESTATE' } },
    { attributes: { ParcelID: '0700207007', PropertyAddress: '16 MAGNOLIA ST', Owner1: 'MCELHANEY BESSIE L' } },
  ];
  const selected = parcelDiscoveryTestables.selectUniqueAddressFeature(
    features,
    '21 Magnolia Street, York, South Carolina 29745',
  );
  assert.equal(selected?.attributes?.ParcelID, '0700202025');
  assert.equal(selected?.attributes?.Owner1, 'LOWRY NAOMI LIFE ESTATE');
  assert.equal(
    parcelDiscoveryTestables.parcelAttributeScore({ ParcelID: '0700202025', PreviousOwner: 'OLD OWNER' }),
    2,
  );
});

test('SC assessor browser keeps the Lambda Chromium package as a native ESM import', async () => {
  const browserSource = await readFile(new URL('./sc-official-browser.js', import.meta.url), 'utf8');
  assert.doesNotMatch(browserSource, /^import\s+chromiumBinary\s+from\s+['"]@sparticuz\/chromium['"]/m);
  assert.match(browserSource, /await import\(['"]@sparticuz\/chromium['"]\)/);
});

const BERKELEY_PROPERTY_CARD = `<body>
  <h2>Property Card</h2>
  <div>TMS: 180-00-01-030</div>
  <div>Owner Information:</div>
  <table><tr><td>OWENS JOSEPH W &amp; RAYMOND HARVEY SURVIVORSHIP<br>478 OAKLEY ROAD<br>MONCKS CORNER, SC 29461</td></tr></table>
  <div>Owner Occupied Property: Yes</div>
  <div>Tax District: T06</div><div>Acres: 0.69</div><div>Zoning: Berkeley County - Flex1 Parent TMS:</div>
  <h3>Site addresses:</h3><table><tr><td>478 OAKLEY RD<br>MONCKS CORNER, SC 29461, Unit/Lot:</td></tr></table>
  <div>Previous Owner History:</div>
  <a href="https://search.berkeleydeeds.com/DetailScreen.php?inst_num=2020009164">Current Deed Record</a>
  <div>Building Market: 140,000 Land Market: 42,000 Total Taxable Value: 153,065 Total Assessment: 6,120</div>
  <div>Building Count: 1 Building Total Finished SQFT: 1481</div>
  <table><tr><th>Tax Year</th><th>Receipt #</th><th>Tax District</th><th>Original Total</th></tr><tr><td>2025</td><td>0087059</td><td>6</td><td>$775.29</td></tr></table>
</body>`;

test('Berkeley property card resolves the current assessor owner and exact situs', () => {
  const record = parseBerkeleyPropertyHtml(
    BERKELEY_PROPERTY_CARD,
    'https://assessor.berkeleycountysc.gov/property_card.php?tms=1800001030',
  );
  assert.equal(record.status, 'verified');
  assert.equal(record.parcelId, '180-00-01-030');
  assert.equal(record.ownerName, 'OWENS JOSEPH W & RAYMOND HARVEY SURVIVORSHIP');
  assert.equal(record.situsAddress, '478 OAKLEY RD');
  assert.equal(record.ownerRecordType, 'assessor');
  assert.equal(record.landValue, 42000);
  assert.equal(record.improvementValue, 140000);
  assert.equal(record.marketValue, 182000);
  assert.equal(record.taxAmount, 775.29);
  assert.equal(record.taxYear, 2025);
  assert.equal(record.building.livingSqft, 1481);
});

test('Berkeley address fallback selects one exact property-card result', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response(`<table>
        <tr><th>Export</th><th>TMS</th><th>Street Address</th><th>Owner Name</th><th>Owner Mailing Address</th></tr>
        <tr><td></td><td><a href="property_card.php?tms=1800001030">1800001030</a></td><td>478 OAKLEY RD, MONCKS CORNER 29461</td><td>OWENS JOSEPH W</td><td>478 OAKLEY RD</td></tr>
        <tr><td></td><td><a href="property_card.php?tms=1800001035">1800001035</a></td><td>318 OAKLEY RD, MONCKS CORNER 29461</td><td>FLYNN DONALD D</td><td>318 OAKLEY RD</td></tr>
      </table>`);
    }
    return new Response(BERKELEY_PROPERTY_CARD);
  };
  const record = await queryOfficialCountyProperty({
    county: 'Berkeley',
    address: '478 Oakley Road, Moncks Corner, SC 29461',
    parcelId: '',
    fetcher,
  });
  assert.equal(record.ownerName, 'OWENS JOSEPH W & RAYMOND HARVEY SURVIVORSHIP');
  assert.equal(record.parcelId, '180-00-01-030');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /streetnum=478/);
  assert.match(calls[0], /streetname=Oakley/i);
});

test('Berkeley uses one bounded browser read when the official assessor returns a passive challenge', async () => {
  const browserCalls = [];
  const record = await queryOfficialCountyProperty({
    county: 'Berkeley',
    address: '478 Oakley Road, Moncks Corner, SC 29461',
    parcelId: '1800001030',
    fetcher: async () => new Response('<title>Just a moment...</title>', { status: 403 }),
    browserFetcher: async (url) => {
      browserCalls.push(String(url));
      return { blocked: false, html: BERKELEY_PROPERTY_CARD };
    },
  });
  assert.equal(record.ownerName, 'OWENS JOSEPH W & RAYMOND HARVEY SURVIVORSHIP');
  assert.equal(browserCalls.length, 1);
  assert.match(browserCalls[0], /property_card\.php\?tms=1800001030/);
});

test('Berkeley does not start Crawlee when a verified county GIS owner already exists', async () => {
  let browserCalls = 0;
  const record = await queryOfficialCountyProperty({
    county: 'Berkeley',
    address: '478 Oakley Road, Moncks Corner, SC 29461',
    parcelId: '1800001030',
    allowBrowser: false,
    fetcher: async () => new Response('<title>Just a moment...</title>', { status: 403 }),
    browserFetcher: async () => {
      browserCalls += 1;
      return { blocked: false, html: BERKELEY_PROPERTY_CARD };
    },
  });
  assert.equal(record, null);
  assert.equal(browserCalls, 0);
});

test('Berkeley Register of Deeds supplies a grantee only for the matched property card', async () => {
  const propertyWithoutOwner = BERKELEY_PROPERTY_CARD.replace(
    'OWENS JOSEPH W &amp; RAYMOND HARVEY SURVIVORSHIP<br>478 OAKLEY ROAD<br>MONCKS CORNER, SC 29461',
    '',
  );
  const deedHtml = `<body>
    <div>Instrument Type DEED</div><div>File Date 03/13/2020</div>
    <table><tbody>
      <tr><td>Grantees</td></tr>
      <tr><td>Grantees</td><td>D Status</td><td>Date Corrected</td></tr>
      <tr><td>JOSEPH W OWENS</td><td></td><td></td></tr>
      <tr><td>RAYMOND HARVEY OWENS</td><td></td><td></td></tr>
    </tbody></table>
  </body>`;
  assert.equal(parseBerkeleyDeedHtml(deedHtml, 'https://search.berkeleydeeds.com/detail').granteeName, 'JOSEPH W OWENS & RAYMOND HARVEY OWENS');

  const record = await queryOfficialCountyProperty({
    county: 'Berkeley',
    address: '478 Oakley Road, Moncks Corner, SC 29461',
    parcelId: '1800001030',
    fetcher: async (url) => new Response(String(url).includes('search.berkeleydeeds.com') ? deedHtml : propertyWithoutOwner),
  });
  assert.equal(record.ownerName, 'JOSEPH W OWENS & RAYMOND HARVEY OWENS');
  assert.equal(record.ownerRecordType, 'deed');
  assert.match(record.sourceName, /Register of Deeds/);
});

test('Greenville property details never confuse Previous Owner with current Owner(s)', () => {
  const html = `<body><h1>Real Property Details</h1><table>
    <tr><th>Map #:</th><td>0069000300700</td></tr>
    <tr><th>Tax Year:</th><td>2026</td></tr>
    <tr><th>District:</th><td>500</td></tr>
    <tr><th>Owner(s):</th><td>Anderson Development Inc</td></tr>
    <tr><th>Previous Owner:</th><td>Wrong Previous Owner</td></tr>
    <tr><th>Mailing Address:</th><td>PO Box 2567 Greenville, SC 29602</td></tr>
    <tr><th>Acreage:</th><td>0.280</td></tr>
    <tr><th>Location:</th><td>12 University Ridge</td></tr>
    <tr><th>Fair Market Value:</th><td>318,670</td></tr>
    <tr><th>Taxable Market Value:</th><td>56,930</td></tr>
  </table></body>`;
  const record = parseGreenvillePropertyHtml(html, 'https://www.greenvillecounty.org/property');
  assert.equal(record.ownerName, 'Anderson Development Inc');
  assert.equal(record.parcelId, '0069000300700');
  assert.equal(record.situsAddress, '12 University Ridge');
  assert.equal(record.marketValue, 318670);
  assert.equal(record.taxableValue, 56930);
});

test('Greenwood property report uses assessor owner, or the latest transfer grantee when omitted', () => {
  const report = (ownerRow = '<tr><td>Owner Name</td><td>M &amp; RE ASSOCIATES LLC</td></tr>') => `<body>
    <div>Greenwood County, SC - Property Report 7/27/2026</div>
    <table><tr><td>6826-762-357</td><td>115 Queens Ct</td><td>LT 11 EIGHTEEN QUEENS COURT</td></tr></table>
    <table>${ownerRow}<tr><td>Mailing Address</td><td>PO BOX 11</td></tr><tr><td>City, State Zip</td><td>GREENWOOD, SC 29648</td></tr></table>
    <table><tr><td>BN2019 LLC</td><td>M &amp; RE ASSOCIATES LLC</td><td>6/3/2025</td><td>Partial Interest</td><td>$17,308</td><td>LT 11</td><td>1657-1852</td><td>132-90</td></tr></table>
    <table><tr><td>BN2019 LLC</td><td>$606.55</td><td>$999.42</td><td>2025</td><td>Paid</td><td>1/22/2026</td></tr></table>
  </body>`;
  const assessor = parseGreenwoodPropertyHtml(report(), 'https://www.greenwoodsc.gov/report');
  assert.equal(assessor.ownerName, 'M & RE ASSOCIATES LLC');
  assert.equal(assessor.ownerRecordType, 'assessor');
  assert.equal(assessor.taxAmount, 999.42);
  const deed = parseGreenwoodPropertyHtml(report(''), 'https://www.greenwoodsc.gov/report');
  assert.equal(deed.ownerName, 'M & RE ASSOCIATES LLC');
  assert.equal(deed.ownerRecordType, 'deed');
});

const CHARLESTON_PROPERTY_CARD = `<body>
  <h2>Property Information</h2>
  <table><tbody>
    <tr><td rowspan="8"><div><b>Current Owner:</b><br>COUNTY OF CHARLESTON<br>4045 BRIDGE VIEW DR # B217<br>NORTH CHARLESTON SC 29405<br></div></td></tr>
    <tr><th>Property ID</th><td>4120000020</td></tr>
    <tr><th>Physical Address</th><td>4045 BRIDGE VIEW DR</td></tr>
    <tr><th>Property Class</th><td>671 - GOVT-BLDG</td></tr>
    <tr><th>Plat Acres</th><td>15.9400</td></tr>
  </tbody></table>
</body>`;

test('Charleston direct official property card resolves the current owner', async () => {
  const parsed = parseCharlestonPropertyHtml(
    CHARLESTON_PROPERTY_CARD,
    'https://sc-charleston.publicaccessnow.com/RealPropertyRecordSearch/RealPropertyInfo.aspx?p=4120000020&m=',
  );
  assert.equal(parsed.ownerName, 'COUNTY OF CHARLESTON');
  assert.equal(parsed.parcelId, '4120000020');
  assert.equal(parsed.situsAddress, '4045 BRIDGE VIEW DR');
  assert.equal(parsed.mailingAddress, '4045 BRIDGE VIEW DR # B217, NORTH CHARLESTON SC 29405');
  assert.equal(parsed.acres, 15.94);

  const calls = [];
  const record = await queryOfficialCountyProperty({
    county: 'Charleston',
    address: '4045 Bridge View Drive, North Charleston, SC 29405',
    parcelId: '412-00-00-020',
    fetcher: async (url) => {
      calls.push(String(url));
      return new Response(CHARLESTON_PROPERTY_CARD);
    },
  });
  assert.equal(record.ownerName, 'COUNTY OF CHARLESTON');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /RealPropertyInfo\.aspx\?p=4120000020&m=$/);
});

const RICHLAND_PROPERTY_CARD = `
Tax Map Number: R18913-01-02
Owner
SANDERS MARGARET ETAL
Mailing Address
1761 PINCUSHION RD COLUMBIA SC 29209
Situs Address
1761 PINCUSHION RD
Zoning
RT
Tax District
R1
Assessment Year
2026
Market Land Value
$34,000
Market Improvement Value
$98,500
Total Market Value
$132,500
Taxable Value
$75,000
Acreage
0.57
Heated Square Feet
1,481
`;

test('Richland Spatialest report resolves exact owner, parcel, and situs', async () => {
  const parsed = parseSpatialestPropertyText(RICHLAND_PROPERTY_CARD, 'https://property.spatialest.com/sc/richland#/property/R18913-01-02');
  assert.equal(parsed.ownerName, 'SANDERS MARGARET ETAL');
  assert.equal(parsed.parcelId, 'R18913-01-02');
  assert.equal(parsed.situsAddress, '1761 PINCUSHION RD');
  assert.equal(parsed.zoning, 'RT');
  assert.equal(parsed.marketValue, 132500);
  assert.equal(parsed.building.livingSqft, 1481);

  const browserCalls = [];
  const record = await queryOfficialCountyProperty({
    county: 'Richland',
    address: '1761 Pincushion Road, Columbia, SC 29209',
    parcelId: 'R18913-01-02',
    browserFetcher: async (url, options) => {
      browserCalls.push({ url: String(url), options });
      return { blocked: false, text: RICHLAND_PROPERTY_CARD, loadedUrl: String(url) };
    },
  });
  assert.equal(record.ownerName, 'SANDERS MARGARET ETAL');
  assert.equal(browserCalls.length, 1);
  assert.match(browserCalls[0].url, /#\/property\/R18913-01-02$/);
  assert.equal(browserCalls[0].options.portalType, 'spatialest');
});

test('county property adapters reject a report for the wrong address', async () => {
  const record = await queryOfficialCountyProperty({
    county: 'Charleston',
    address: '4100 Bridge View Drive, North Charleston, SC 29405',
    parcelId: '4120000020',
    fetcher: async () => new Response(CHARLESTON_PROPERTY_CARD),
  });
  assert.equal(record, null);
});

test('address verification corrects a stale candidate parcel but explicit parcel lookup stays strict', async () => {
  const fetcher = async () => new Response(CHARLESTON_PROPERTY_CARD);
  const corrected = await queryOfficialCountyProperty({
    county: 'Charleston',
    address: '4045 Bridge View Drive, North Charleston, SC 29405',
    parcelId: '999-99-99-999',
    fetcher,
  });
  assert.equal(corrected.ownerName, 'COUNTY OF CHARLESTON');
  assert.equal(corrected.parcelId, '4120000020');

  const strict = await queryOfficialCountyProperty({
    county: 'Charleston',
    address: '4045 Bridge View Drive, North Charleston, SC 29405',
    parcelId: '999-99-99-999',
    strictParcelId: true,
    fetcher,
  });
  assert.equal(strict, null);
});

test('SC owner portal registry keeps protected sites manual and exposes free county searches', () => {
  assert.equal(scOwnerPortalFor('Anderson, SC').propertyProvider, 'restricted');
  assert.equal(scOwnerPortalFor('Berkeley County').propertyProvider, 'berkeley');
  assert.match(scOwnerVerificationUrl('Allendale'), /qpublic\.net\/sc\/allendale/);
  assert.match(scOwnerVerificationUrl('Bamberg'), /qpublic\.net\/sc\/bamberg/);
  assert.match(scOwnerPortalFor('Chester').deedUrl, /sclandrecords\.com/);
  assert.match(scOwnerVerificationUrl('Greenwood'), /greenwoodsc\.gov/);
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

test('qPay address lookup rejects a nearby property and accepts only the exact situs address', async () => {
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
        <tr><td>Real Estate</td><td>2025</td><td><a href="TaxesDetailsType4.aspx?id=nearby">View</a></td></tr>
        <tr><td>RealEstate</td><td>2024</td><td><a href="TaxesDetailsType4.aspx?id=exact">View</a></td></tr>
      </table>`);
    }
    const exact = call === 5;
    return new Response(`<body>
      Name: ${exact ? 'SMITH JANE' : 'WRONG OWNER'} Address: PO BOX 1 YORK SC 29745 Tax Year: 2025
      Map Number: ${exact ? '070-01-02-003' : '070-01-02-002'} Acres: 0 District/Levy: 01 /
      Property Address ${exact ? '21 MAGNOLIA ST' : '17 MAGNOLIA ST'} Taxes County Tax:
      Total Appraisal: $100,000 Total Assessed: $4,000 Total Taxes: $500 Buildings: 1
    </body>`);
  };

  const result = await queryQpayTreasurer(
    'https://example.qpaybill.com/Taxes/TaxesDefaultType4.aspx',
    '21 Magnolia Street, York, SC 29745',
    'York',
    '',
    fetcher,
  );

  assert.equal(result.ownerName, 'SMITH JANE');
  assert.equal(result.parcelId, '070-01-02-003');
  assert.equal(result.situsAddress, '21 MAGNOLIA ST');
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
  assert.ok((manifest.match(/treasurerUrl:/g) || []).length >= 20);
  assert.match(manifest, /Allendale[\s\S]*allendaletreasurer\.qpaybill\.com/);
  assert.match(manifest, /Bamberg[\s\S]*bambergcountytreasurer\.qpaybill\.com/);

  const component = await readFile(new URL('../../../src/components/FeasibilitySearch.tsx', import.meta.url), 'utf8');
  const start = component.indexOf('const generateCostEstimates');
  const end = component.indexOf('const changeCompRadius', start);
  const automaticSearchBlock = component.slice(start, end);
  assert.doesNotMatch(automaticSearchBlock, /enformionPropertySearch|fetchEnformionRecords|ContactEnrich|PersonSearch|BusinessSearch/);
  assert.match(component, /Skip Trace Owner \(Paid\)/);

  const service = await readFile(new URL('../../../src/services/feasibilityService.ts', import.meta.url), 'utf8');
  const verification = await readFile(new URL('../../../src/services/scParcelVerification.ts', import.meta.url), 'utf8');
  const ownerFunction = await readFile(new URL('../sc-parcel.js', import.meta.url), 'utf8');
  const analysisStart = service.indexOf('export async function executeLandAnalysis');
  const discoveryCall = service.indexOf('const discovered = await discoverScParcelFeature', analysisStart);
  const statewideLoop = service.indexOf('for (const parcelHost of parcelHosts', analysisStart);
  const bboxStart = service.indexOf('export async function fetchParcelsInBbox');
  const bboxEnd = service.indexOf('function acresFromGeometry', bboxStart);
  const bboxBlock = service.slice(bboxStart, bboxEnd);
  assert.match(service, /const parcelHosts = selectedState === 'NC'[\s\S]{0,160}: \[\];/);
  assert.doesNotMatch(service, /queryScStatewideParcelAttributes/);
  assert.ok(discoveryCall > analysisStart && discoveryCall < statewideLoop);
  assert.match(bboxBlock, /countyParcelLayerFor\(countyName, 'SC'\)/);
  assert.doesNotMatch(bboxBlock, /SCDOT statewide snapshot owner/);
  assert.match(verification, /strictParcelId: options\.strictParcelId === true/);
  assert.match(ownerFunction, /preferAddress: !strictParcelId && !!address/);
  assert.match(ownerFunction, /strictParcelId && usableParcelId/);
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
  assert.match(service, /County GIS tax-roll owner/);
  assert.doesNotMatch(service, /SCDOT statewide snapshot owner/);
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

// --- municipal zoning precedence (spec section 11) -------------------------
import { readFileSync as readSrc } from 'node:fs';
const zoningSrc = readSrc(new URL('./sc-zoning-discovery.js', import.meta.url), 'utf8');

test('inside a city the municipal layer is exhausted before the county', () => {
  // Merging municipal and county services and re-sorting by NAME destroyed
  // municipal precedence: a county service that reads like zoning outranked a
  // municipal one that does not, so a city parcel could be answered with the
  // county's district. Tiers must stay separate.
  assert.match(zoningSrc, /const groups = municipality\s*\n?\s*\? \[\.\.\.tierOf\(municipalServices\), \.\.\.tierOf\(countyServices\)\]/);
  assert.doesNotMatch(zoningSrc, /const services = dedupe\(\[\.\.\.municipalServices, \.\.\.countyServices\]\)/);
});

test('the answer names the authority that actually produced the district', () => {
  // Reporting the municipality whenever one existed sent people to the wrong
  // planning department when the hit came from the county layer.
  assert.match(zoningSrc, /jurisdictionType: fromMunicipality \? 'municipality' : 'county'/);
  assert.match(zoningSrc, /jurisdiction: group\.kind === 'county' \? `\$\{county\} County` : group\.jurisdiction/);
  assert.doesNotMatch(zoningSrc, /jurisdiction: municipality \|\| \(group\.jurisdiction === county/);
});

test('a county answer inside city limits is flagged, not presented as the city\'s', () => {
  assert.match(zoningSrc, /municipalLayerMissing: !!municipality && !fromMunicipality/);
  assert.match(zoningSrc, /municipalLayerMissing: !!municipality && group\.kind === 'county'/);
});
