import { load } from 'cheerio';

const REQUEST_TIMEOUT_MS = 7_000;

function compact(value) {
  return String(value || '').replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeParcelId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parcelIdsCompatible(left, right) {
  const a = normalizeParcelId(left);
  const b = normalizeParcelId(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && /^0+$/.test(longer.slice(shorter.length));
}

function numeric(value) {
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cdataHtml(value) {
  return String(value || '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] || '';
}

function fieldMap(html) {
  const $ = load(html);
  const fields = new Map();
  $('tr').each((_, row) => {
    const header = compact($(row).find('th').first().text()).replace(/\s/g, '').toLowerCase();
    const value = compact($(row).find('td').first().text());
    if (header && value) fields.set(header, value);
  });
  return fields;
}

export function parseWthgisParcelDetail(content, sourceUrl, county) {
  const html = cdataHtml(content);
  if (!html) return null;
  const fields = fieldMap(html);
  const value = (...names) => names.map((name) => fields.get(name.toLowerCase())).find(Boolean);
  const parcelId = value('mapnumber');
  const owner1 = value('ownername');
  const owner2 = value('ownername2');
  if (!parcelId || !owner1) return null;

  const legalDescription = value('legaldescription');
  const explicitAcres = numeric(value('marketvalueacres', 'taxvalueacres'));
  const legalAcres = numeric(legalDescription?.match(/(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s*AC(?:RE)?S?\b/i)?.[1]);
  const acres = explicitAcres && explicitAcres > 0 ? explicitAcres : legalAcres && legalAcres > 0 ? legalAcres : undefined;
  const ownerName = [owner1, owner2].filter(Boolean).join(' & ');
  const mailingAddress = [
    value('mailingaddress1'),
    value('mailingaddress2'),
    value('mailingcity'),
    [value('mailingstate'), value('mailingzipcode')].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ') || undefined;
  const situsAddress = [
    value('propertyaddress1'),
    value('propertyaddress2'),
    value('propertycity'),
    [value('propertystate'), value('propertyzipcode')].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ') || undefined;

  return {
    status: 'verified',
    sourceUrl,
    sourceName: `${county} County WTHGIS tax roll`,
    parcelId,
    normalizedParcelId: normalizeParcelId(parcelId),
    situsAddress,
    ownerName,
    ownerRecordType: 'assessor',
    mailingAddress,
    acres,
    assessedPropertyValue: numeric(value('taxvaluetotalvalue')),
    totalAssessedValue: numeric(value('taxvaluetotalassessed', 'marketvaluetotalassessed')),
    landValue: numeric(value('marketvaluelandvalue', 'taxvaluelandvalue')),
    improvementValue: numeric(value('marketvaluebuildingsvalue', 'taxvaluebuildingsvalue')),
    marketValue: numeric(value('marketvaluetotalvalue')),
    taxableValue: numeric(value('taxvaluetotalvalue')),
    taxCodeArea: value('district'),
    zoning: value('zoning', 'zoningdistrict', 'zoningcode', 'zone', 'zonecode', 'zoningclassification'),
    building: {
      buildingCount: numeric(value('marketvaluebuildings', 'taxvaluebuildings')),
    },
  };
}

export async function queryWthgisParcel({ portalUrl, address, parcelId, candidateOwner, county, fetcher = fetch }) {
  const base = new URL(portalUrl);
  const request = (url) => fetcher(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'text/html,application/xhtml+xml,application/xml' },
  });

  const home = await request(base.toString());
  if (!home.ok) return null;
  const homeText = await home.text();
  const dsid = homeText.match(/custom\.aspx\?DSID=(\d+)(?:&|&amp;)RequestType=CustomSearchForm/i)?.[1];
  if (!dsid) return null;

  const streetAddress = compact(address).split(',')[0];
  if (streetAddress) {
    const addressSearchUrl = new URL('tgis/search.aspx', base);
    addressSearchUrl.search = new URLSearchParams({ S: streetAddress, M: '99', redir: '1' }).toString();
    const addressSearch = await request(addressSearchUrl.toString());
    if (addressSearch.ok) {
      const addressRecord = parseWthgisParcelDetail(
        await addressSearch.text(),
        addressSearchUrl.toString(),
        county,
      );
      if (addressRecord && (!parcelId || parcelIdsCompatible(addressRecord.parcelId, parcelId))) {
        return addressRecord;
      }
    }
  }

  if (!candidateOwner || !parcelId) return null;

  const ownerParts = compact(candidateOwner).replace(/\bET\s*AL\.?$/i, '').split(' ').filter(Boolean);
  const ownerCriteria = ownerParts.length > 1
    ? `${ownerParts[0]}|${ownerParts.slice(1).join(' ')}`
    : `${ownerParts[0] || ''}|`;
  const searchUrl = new URL('tgis/custom.aspx', base);
  searchUrl.search = new URLSearchParams({
    DSID: dsid,
    RequestType: 'CustomSearchRequest',
    SearchType: 'Name',
    SearchCriteria: ownerCriteria,
  }).toString();
  const search = await request(searchUrl.toString());
  if (!search.ok) return null;
  const results = await search.text();

  const resultPattern = new RegExp(
    `showf\\(\\s*${dsid}\\s*,\\s*(\\d+)\\s*\\)[\\s\\S]{0,700}?resultsParcelNumber[^>]*>([^<]+)<\\/div>`,
    'gi',
  );
  let match;
  let featureId;
  while ((match = resultPattern.exec(results))) {
    if (parcelIdsCompatible(match[2], parcelId)) {
      featureId = match[1];
      break;
    }
  }
  if (!featureId) return null;

  const detailUrl = new URL('tgis/getftr.aspx', base);
  detailUrl.search = new URLSearchParams({ D: dsid, F: featureId, Z: '0' }).toString();
  const detail = await request(detailUrl.toString());
  if (!detail.ok) return null;
  return parseWthgisParcelDetail(await detail.text(), detailUrl.toString(), county);
}
