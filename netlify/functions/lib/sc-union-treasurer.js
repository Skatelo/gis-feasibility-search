import { load } from 'cheerio';

const UNION_SEARCH_URL = 'https://uniontreasurer.qpaybill.com/Taxes/TaxesDefaultType4.aspx';
const REQUEST_TIMEOUT_MS = 6_000;

function compactText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function number(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function match(text, pattern) {
  return compactText(text.match(pattern)?.[1]);
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

function addressCandidates(value) {
  const street = compactText(value);
  const candidates = [street];
  const suffixes = [
    ['ROAD', 'RD'], ['STREET', 'ST'], ['AVENUE', 'AVE'], ['DRIVE', 'DR'],
    ['LANE', 'LN'], ['COURT', 'CT'], ['BOULEVARD', 'BLVD'], ['CIRCLE', 'CIR'],
    ['HIGHWAY', 'HWY'], ['PARKWAY', 'PKWY'], ['PLACE', 'PL'], ['TERRACE', 'TER'],
    ['TRAIL', 'TRL'], ['ROUTE', 'RT'],
  ];
  for (const [full, short] of suffixes) {
    const fullPattern = new RegExp(`\\b${full}\\b`, 'i');
    const shortPattern = new RegExp(`\\b${short}\\b`, 'i');
    if (fullPattern.test(street)) candidates.push(street.replace(fullPattern, short));
    else if (shortPattern.test(street)) candidates.push(street.replace(shortPattern, full));
  }
  return [...new Set(candidates)].slice(0, 4);
}

function idText($, suffix) {
  return compactText($(`[id$="_${suffix}"]`).first().text());
}

function sumPositiveIdValues($, pattern) {
  let total = 0;
  let found = false;
  $('[id]').each((_, element) => {
    const id = $(element).attr('id') || '';
    if (!pattern.test(id)) return;
    const value = number($(element).text());
    if (value !== undefined && value > 0) {
      total += value;
      found = true;
    }
  });
  return found ? total : undefined;
}

export function parseQpayTreasurerDetail(html, sourceUrl, county = '') {
  const $ = load(String(html || ''));
  $('br').replaceWith(' ');
  const text = compactText($('body').text());
  const ownerName = idText($, 'lblName') || match(text, /Name:\s*(.*?)(?=\s+(?:Address|Tax Year):)/i);
  const mailingAddress = match(text, /Name:\s*.*?\s+Address:\s*(.*?)\s+Tax Year:/i);
  const parcelId = idText($, 'lblMapNo') || match(text, /Map Number:\s*(.*?)\s+Acres:/i);
  const taxYear = number(idText($, 'lblTaxYr') || match(text, /Tax Year:\s*(\d{4})/i));
  const taxAmount = number(idText($, 'lblTotalTaxes') || match(text, /Total Taxes:\s*\$?([0-9,.]+)/i));
  const assessedPropertyValue = number(idText($, 'lblMarketVal') || match(text, /Total Appraisal:\s*\$?([0-9,.]+)/i));
  const totalAssessedValue = number(idText($, 'lblAssmt') || match(text, /Total Assessed:\s*\$?([0-9,.]+)/i));
  const district = idText($, 'lblDistrict');
  const taxCodeArea = compactText(district.split('/')[0]) || match(text, /District\/Levy:\s*([^/\s]+)\s*\//i);
  const acres = number(idText($, 'lblAcres') || match(text, /Acres:\s*([0-9.]+)/i));
  const buildingCount = number(match(text, /Buildings:\s*(\d+)/i));
  const situsAddress = idText($, 'lblPropAddress') || match(text, /Property Address\s+(.*?)\s+Taxes\s+County Tax:/i);
  const landValue = sumPositiveIdValues($, /_lblLand\d+$/i);
  const improvementValue = sumPositiveIdValues($, /_lblBuilding\d+$/i);
  const marketValue = assessedPropertyValue && assessedPropertyValue > 0 ? assessedPropertyValue : undefined;

  if (!ownerName || !parcelId || !taxYear) return null;
  return {
    status: 'verified',
    sourceUrl,
    sourceName: `${county || 'County'} Treasurer tax roll`,
    parcelId,
    normalizedParcelId: parcelId.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    situsAddress: situsAddress || undefined,
    ownerName,
    ownerRecordType: 'assessor',
    mailingAddress: mailingAddress || undefined,
    acres: acres && acres > 0 ? acres : undefined,
    assessedYear: taxYear,
    assessedPropertyValue,
    totalAssessedValue,
    landValue,
    improvementValue,
    marketValue,
    taxableValue: assessedPropertyValue,
    taxCodeArea,
    taxAmount,
    taxYear,
    building: { buildingCount },
  };
}

export function parseUnionTreasurerDetail(html, sourceUrl) {
  return parseQpayTreasurerDetail(html, sourceUrl, 'Union County');
}

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  return values.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

function hiddenFields(html) {
  const $ = load(html);
  const fields = {};
  $('input[type="hidden"][name]').each((_, element) => {
    fields[$(element).attr('name')] = $(element).attr('value') || '';
  });
  return fields;
}

export async function queryQpayTreasurer(searchUrl, address, county, expectedParcelId = '', fetcher = fetch) {
  const SEARCH_URL = String(searchUrl || '');
  const streetAddress = compactText(address).split(',')[0];
  if (!streetAddress || !SEARCH_URL) return null;

  const request = (url, init = {}) => fetcher(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let response = await request(SEARCH_URL);
  if (!response.ok) return null;
  const cookie = cookieHeader(response.headers);
  let html = await response.text();

  const post = async (extra) => {
    const body = new URLSearchParams({
      ...hiddenFields(html),
      'ctl00$MainContent$SearchType': 'radRealEstateButton',
      'ctl00$MainContent$PaidStatus': 'radAllPaymentsButton',
      'ctl00$MainContent$ddlYearList': 'All',
      'ctl00$MainContent$ddlCriteriaList': 'Address',
      ...extra,
    });
    response = await request(SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        referer: SEARCH_URL,
      },
      body,
    });
    if (!response.ok) throw new Error(`${county || 'County'} treasurer returned HTTP ${response.status}`);
    html = await response.text();
  };

  await post({ __EVENTTARGET: 'ctl00$MainContent$ddlCriteriaList' });
  let detailAttempts = 0;
  for (const candidate of addressCandidates(streetAddress)) {
    await post({
      __EVENTTARGET: '',
      'ctl00$MainContent$txtCriteriaBox': candidate,
      'ctl00$MainContent$btnSearch': 'Search',
    });

    const $ = load(html);
    const rows = $('tr').toArray().map((row) => {
      const cells = $(row).find('td').toArray().map((cell) => compactText($(cell).text()));
      const href = $(row).find('a[href*="TaxesDetailsType4.aspx"]').attr('href');
      return { cells, href };
    }).filter((row) => row.href && row.cells.includes('RealEstate'));
    const year = (row) => Number(row.cells.find((cell) => /^20\d{2}$/.test(cell))) || 0;
    rows.sort((left, right) => {
      const leftMatches = expectedParcelId && left.cells.some((cell) => parcelIdsCompatible(cell, expectedParcelId));
      const rightMatches = expectedParcelId && right.cells.some((cell) => parcelIdsCompatible(cell, expectedParcelId));
      return Number(rightMatches) - Number(leftMatches) || year(right) - year(left);
    });

    for (const row of rows) {
      if (detailAttempts >= 6) return null;
      detailAttempts += 1;
      const detailUrl = new URL(row.href, SEARCH_URL).toString();
      const detail = await request(detailUrl, { headers: { cookie, referer: SEARCH_URL } });
      if (!detail.ok) continue;
      const record = parseQpayTreasurerDetail(await detail.text(), detailUrl, `${county} County`);
      if (record && (!expectedParcelId || parcelIdsCompatible(record.parcelId, expectedParcelId))) return record;
    }
  }
  return null;
}

export async function queryUnionTreasurer(address, fetcher = fetch) {
  return queryQpayTreasurer(UNION_SEARCH_URL, address, 'Union', '', fetcher);
}
