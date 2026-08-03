import { load } from 'cheerio';

import {
  normalizeParcelId,
  scParcelIdsMatch,
  situsAddressesMatch,
} from './sc-parcel-parser.js';
import { scOwnerPortalFor } from './sc-owner-portals.js';

const REQUEST_HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'SCParcelVerification/1.0',
};
const BLOCKED_PAGE_RE = /just a moment|checking your browser|verify you are human|captcha|turnstile|access denied|request blocked/i;
const STREET_SUFFIX_RE = /^(?:ST|STREET|RD|ROAD|AVE|AVENUE|HWY|HIGHWAY|LN|LANE|DR|DRIVE|BLVD|BOULEVARD|CT|COURT|CIR|CIRCLE|PL|PLACE|PKWY|PARKWAY|TRL|TRAIL|TER|TERRACE)$/i;

function compact(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanValue(value) {
  const text = compact(value);
  return text && !/^(?:n\/?a|none|null|not available|unavailable)$/i.test(text) ? text : undefined;
}

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return compact(match[1]);
  }
  return undefined;
}

function htmlLines(html) {
  const withBreaks = String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, '$&\n');
  const $ = load(withBreaks);
  return $.root().text().split(/\r?\n/).map(compact).filter(Boolean);
}

function sectionLines(lines, startLabel, stopPattern) {
  const start = lines.findIndex((line) => line.toLowerCase().startsWith(startLabel.toLowerCase()));
  if (start < 0) return [];
  const firstRemainder = compact(lines[start].slice(startLabel.length));
  const out = firstRemainder ? [firstRemainder] : [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (stopPattern.test(lines[index])) break;
    out.push(lines[index]);
  }
  return out.filter(Boolean);
}

function directRows($) {
  return $('tr').toArray().map((row) => $(row).children('th,td').toArray().map((cell) => compact($(cell).text())));
}

function rowValue(rows, labels) {
  const wanted = labels.map((label) => label.toLowerCase().replace(/:$/, ''));
  for (const row of rows) {
    if (row.length < 2) continue;
    const label = row[0].toLowerCase().replace(/:$/, '');
    if (wanted.includes(label)) return cleanValue(row.slice(1).join(' '));
  }
  return undefined;
}

function recordWithIdentity(record, { address, parcelId }) {
  if (!record?.ownerName || !record?.parcelId) return null;
  const expectedParcel = cleanValue(parcelId);
  const expectedAddress = cleanValue(address);
  if (expectedParcel && !scParcelIdsMatch(record.parcelId, expectedParcel)) return null;

  const publishedAddresses = (record._situsAddresses || [record.situsAddress]).filter(Boolean);
  const matchingAddress = expectedAddress
    ? publishedAddresses.find((candidate) => situsAddressesMatch(candidate, expectedAddress))
    : undefined;
  if (expectedAddress && publishedAddresses.length && !matchingAddress) return null;
  if (!expectedParcel && expectedAddress && !matchingAddress) return null;

  const { _deedUrl, _situsAddresses, ...publicRecord } = record;
  return {
    ...publicRecord,
    situsAddress: matchingAddress || publicRecord.situsAddress,
  };
}

function berkeleyStreetSearch(address) {
  const streetLine = compact(String(address || '').split(',')[0]);
  const match = streetLine.match(/^(\d+[A-Z]?(?:[-/]\d+[A-Z]?)?)\s+(.+)$/i);
  if (!match) return null;
  const tokens = match[2].split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && STREET_SUFFIX_RE.test(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return null;
  return { streetNumber: match[1], streetName: tokens.join(' ') };
}

function parseBerkeleySearchResult(html, address, baseUrl) {
  const $ = load(String(html || ''));
  const matches = [];
  $('tr').each((_, row) => {
    const link = $(row).find('a[href*="property_card.php"][href*="tms="]').first();
    if (!link.length) return;
    const cells = $(row).children('th,td').toArray().map((cell) => compact($(cell).text()));
    const parcelId = cleanValue(link.text()) || cleanValue(new URL(link.attr('href'), baseUrl).searchParams.get('tms'));
    const situsAddress = cells.find((cell) => /^\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s/.test(cell) && situsAddressesMatch(cell, address));
    if (!parcelId || !situsAddress) return;
    matches.push({
      parcelId,
      situsAddress,
      url: new URL(link.attr('href'), baseUrl).toString(),
    });
  });
  const unique = [...new Map(matches.map((match) => [normalizeParcelId(match.parcelId), match])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function parseBerkeleyDeedHtml(html, sourceUrl) {
  const $ = load(String(html || ''));
  const flat = htmlLines(html).join(' ');
  if (!/\bInstrument Type\s+DEED\b/i.test(flat)) return null;

  let grantees = [];
  $('table').each((_, table) => {
    if (grantees.length) return;
    const rows = $(table).children('tbody').children('tr').toArray()
      .map((row) => $(row).children('th,td').toArray().map((cell) => compact($(cell).text())));
    const headingIndex = rows.findIndex((row) => row.length === 1 && /^Grantees$/i.test(row[0]));
    if (headingIndex < 0) return;
    grantees = rows.slice(headingIndex + 1)
      .map((row) => cleanValue(row[0]))
      .filter((value) => value && !/^Grantees$/i.test(value) && !/^D Status$/i.test(value));
    if (grantees[0] && /Date Corrected/i.test(grantees[0])) grantees.shift();
  });
  if (!grantees.length) return null;
  return {
    granteeName: grantees.join(' & '),
    recordedDate: firstMatch(flat, [/File Date\s+(\d{1,2}\/\d{1,2}\/\d{4})/i]),
    sourceUrl,
  };
}

export function parseBerkeleyPropertyHtml(html, sourceUrl) {
  const $ = load(String(html || ''));
  const flat = compact($.root().text());
  if (!/\bProperty Card\b/i.test(flat)) return null;
  const lines = htmlLines(html);
  const parcelId = firstMatch(flat, [/\bTMS:\s*([A-Z0-9-]+)/i]);
  const ownerSection = sectionLines(lines, 'Owner Information:', /^Owner Occupied Property:/i);
  const ownerName = cleanValue(ownerSection[0]);
  const mailingAddress = ownerSection.length > 1 ? cleanValue(ownerSection.slice(1).join(', ')) : undefined;
  const siteSection = sectionLines(lines, 'Site addresses:', /^(?:Previous Owner History|Assessment Notice Reprint|Tax History):?/i);
  const situsAddresses = siteSection
    .map((line) => compact(line.replace(/,?\s*Unit\/Lot:.*$/i, '')))
    .filter((line) => /^\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s/.test(line));
  const landValue = numberValue(firstMatch(flat, [/\bLand Market:\s*\$?([0-9,.-]+)/i]));
  const improvementValue = numberValue(firstMatch(flat, [/\bBuilding Market:\s*\$?([0-9,.-]+)/i]));
  const marketValue = landValue != null || improvementValue != null
    ? (landValue || 0) + (improvementValue || 0)
    : undefined;
  const currentTax = $('table').toArray().flatMap((table) => {
    const rows = $(table).find('tr').toArray().map((row) => $(row).children('th,td').toArray().map((cell) => compact($(cell).text())));
    const header = rows.findIndex((row) => row.some((cell) => /^Tax Year$/i.test(cell)) && row.some((cell) => /^Original Total$/i.test(cell)));
    return header >= 0 ? rows.slice(header + 1) : [];
  }).find((row) => /^20\d{2}$/.test(row[0] || '') && /\$/.test(row[3] || ''));
  const deedUrl = $('a').toArray()
    .map((link) => ({ text: compact($(link).text()), href: $(link).attr('href') }))
    .find((link) => /Current Deed Record/i.test(link.text) && link.href)?.href;

  return {
    status: ownerName ? 'verified' : 'unavailable',
    sourceUrl,
    sourceName: 'Berkeley County assessor property card',
    parcelId,
    normalizedParcelId: normalizeParcelId(parcelId),
    situsAddress: situsAddresses[0],
    _situsAddresses: situsAddresses,
    ownerName,
    ownerRecordType: ownerName ? 'assessor' : undefined,
    mailingAddress,
    acres: (() => {
      const value = numberValue(firstMatch(flat, [/\bAcres:\s*([0-9,.]+)/i]));
      return value && value > 0 ? value : undefined;
    })(),
    landValue,
    improvementValue,
    marketValue,
    taxableValue: numberValue(firstMatch(flat, [/\bTotal Taxable Value:\s*\$?([0-9,.-]+)/i])),
    totalAssessedValue: numberValue(firstMatch(flat, [/\bTotal Assessment:\s*\$?([0-9,.-]+)/i])),
    taxCodeArea: firstMatch(flat, [/\bTax District:\s*([A-Z0-9-]+)/i]),
    taxYear: currentTax ? numberValue(currentTax[0]) : undefined,
    taxAmount: currentTax ? numberValue(currentTax[3]) : undefined,
    zoning: cleanValue(firstMatch(flat, [/\bZoning:\s*(.+?)\s+Parent TMS:/i])),
    building: {
      livingSqft: numberValue(firstMatch(flat, [/\bBuilding Total Finished SQFT:\s*([0-9,.]+)/i])),
      buildingSqft: numberValue(firstMatch(flat, [/\bBuilding Total Finished SQFT:\s*([0-9,.]+)/i])),
      buildingCount: numberValue(firstMatch(flat, [/\bBuilding Count:\s*([0-9]+)/i])),
    },
    _deedUrl: deedUrl ? new URL(deedUrl, sourceUrl).toString() : undefined,
  };
}

export function parseGreenvillePropertyHtml(html, sourceUrl) {
  const $ = load(String(html || ''));
  const flat = compact($.root().text());
  if (!/\bReal Property Details\b/i.test(flat)) return null;
  const rows = directRows($);
  const parcelId = rowValue(rows, ['Map #']);
  const ownerName = rowValue(rows, ['Owner(s)']);
  const situsAddress = rowValue(rows, ['Location']);
  const taxYear = numberValue(rowValue(rows, ['Tax Year']));
  return {
    status: ownerName ? 'verified' : 'unavailable',
    sourceUrl,
    sourceName: 'Greenville County Real Property Services tax roll',
    asOf: taxYear ? String(taxYear) : undefined,
    parcelId,
    normalizedParcelId: normalizeParcelId(parcelId),
    situsAddress,
    _situsAddresses: situsAddress ? [situsAddress] : [],
    ownerName,
    ownerRecordType: ownerName ? 'assessor' : undefined,
    mailingAddress: rowValue(rows, ['Mailing Address']),
    acres: numberValue(rowValue(rows, ['Acreage'])),
    marketValue: numberValue(rowValue(rows, ['Fair Market Value'])),
    taxableValue: numberValue(rowValue(rows, ['Taxable Market Value'])),
    taxCodeArea: rowValue(rows, ['District']),
    taxYear,
    building: {},
  };
}

export function parseGreenwoodPropertyHtml(html, sourceUrl) {
  const $ = load(String(html || ''));
  const tables = $('table').toArray().map((table) => $(table).find('tr').toArray().map((row) => $(row).children('th,td').toArray().map((cell) => compact($(cell).text()))));
  const identity = tables.flat().find((row) => row.length === 3 && /^[A-Z0-9-]{7,}$/i.test(row[0]) && /^\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s/.test(row[1]));
  if (!identity) return null;
  const labelledRows = tables.flat();
  const assessorOwner = rowValue(labelledRows, ['Owner Name']);
  const mailingStreet = rowValue(labelledRows, ['Mailing Address']);
  const mailingCity = rowValue(labelledRows, ['City, State Zip']);
  const latestTransfer = labelledRows.find((row) => row.length >= 7 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(row[2] || '') && /deed|sale|interest|properties|unknown/i.test(row[3] || ''));
  const latestBuyer = latestTransfer ? cleanValue(latestTransfer[1]) : undefined;
  const ownerName = assessorOwner || latestBuyer;
  const ownerRecordType = assessorOwner ? 'assessor' : latestBuyer ? 'deed' : undefined;
  const taxRow = labelledRows.find((row) => row.length >= 6 && /^20\d{2}$/.test(row[3] || '') && /^\$/.test(row[2] || ''));
  const buildingRow = labelledRows.find((row) => row.length === 7 && row.every((cell) => /^\d+(?:\.\d+)?$/.test(cell)));
  const reportDate = firstMatch(compact($.root().text()), [/Property Report\s+(\d{1,2}\/\d{1,2}\/\d{4})/i]);

  return {
    status: ownerName ? 'verified' : 'unavailable',
    sourceUrl,
    sourceName: ownerRecordType === 'deed'
      ? 'Greenwood County latest recorded transfer grantee'
      : 'Greenwood County assessor property report',
    asOf: reportDate,
    parcelId: identity[0],
    normalizedParcelId: normalizeParcelId(identity[0]),
    situsAddress: identity[1],
    _situsAddresses: [identity[1]],
    ownerName,
    ownerRecordType,
    mailingAddress: [mailingStreet, mailingCity].filter(Boolean).join(', ') || undefined,
    taxAmount: taxRow ? numberValue(taxRow[2]) : undefined,
    taxYear: taxRow ? numberValue(taxRow[3]) : undefined,
    building: {
      buildingSqft: buildingRow ? numberValue(buildingRow[1]) : undefined,
      livingSqft: buildingRow ? numberValue(buildingRow[1]) : undefined,
      baths: buildingRow ? numberValue(buildingRow[3]) : undefined,
    },
  };
}

async function defaultBrowserFetcher(url) {
  const { crawlOfficialParcelPage } = await import('./sc-official-browser.js');
  return crawlOfficialParcelPage(String(url), { searchPortal: false });
}

async function requestHtml(url, fetcher, { browserFallback = false, browserFetcher = defaultBrowserFetcher } = {}) {
  const response = await fetcher(url, {
    method: 'GET',
    headers: REQUEST_HEADERS,
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  const html = (await response.text()).slice(0, 1_000_000);
  if (response.ok && !BLOCKED_PAGE_RE.test(html)) return html;
  if (!browserFallback) return null;
  const browserResult = await browserFetcher(url);
  if (browserResult?.blocked || !browserResult?.html) return null;
  return String(browserResult.html).slice(0, 1_000_000);
}

function greenwoodParcelId(parcelId) {
  const raw = compact(parcelId);
  if (raw.includes('-')) return raw;
  const normalized = normalizeParcelId(raw);
  return /^\d{10}$/.test(normalized)
    ? `${normalized.slice(0, 4)}-${normalized.slice(4, 7)}-${normalized.slice(7)}`
    : raw;
}

async function queryBerkeley({ address, parcelId, fetcher, browserFetcher, allowBrowser, portal }) {
  let reportUrl;
  if (parcelId) {
    const url = new URL('https://assessor.berkeleycountysc.gov/property_card.php');
    url.searchParams.set('tms', normalizeParcelId(parcelId));
    reportUrl = url.toString();
  } else {
    const parts = berkeleyStreetSearch(address);
    if (!parts) return null;
    const searchUrl = new URL(portal.propertyUrl);
    searchUrl.searchParams.set('searchmethod', 'address');
    searchUrl.searchParams.set('streetnum', parts.streetNumber);
    searchUrl.searchParams.set('streetname', parts.streetName);
    searchUrl.searchParams.set('rpsearch', 'rpsearch');
    searchUrl.searchParams.set('searchoption', 'contains');
    searchUrl.searchParams.set('ownername', '');
    const searchHtml = await requestHtml(searchUrl, fetcher, {
      browserFallback: allowBrowser,
      browserFetcher,
    });
    if (!searchHtml) return null;
    const result = parseBerkeleySearchResult(searchHtml, address, searchUrl);
    if (!result) return null;
    reportUrl = result.url;
  }

  const html = await requestHtml(reportUrl, fetcher, {
    browserFallback: allowBrowser,
    browserFetcher,
  });
  if (!html) return null;
  const parsed = parseBerkeleyPropertyHtml(html, reportUrl);
  if (!parsed) return null;
  let record = recordWithIdentity(parsed, { address, parcelId });
  if (record || !parsed._deedUrl) return record;

  const deedHtml = await requestHtml(parsed._deedUrl, fetcher, {
    browserFallback: allowBrowser,
    browserFetcher,
  });
  const deed = deedHtml ? parseBerkeleyDeedHtml(deedHtml, parsed._deedUrl) : null;
  if (!deed?.granteeName) return null;
  record = recordWithIdentity({
    ...parsed,
    status: 'verified',
    sourceUrl: deed.sourceUrl,
    sourceName: 'Berkeley County Register of Deeds latest grantee',
    asOf: deed.recordedDate,
    ownerName: deed.granteeName,
    ownerRecordType: 'deed',
  }, { address, parcelId });
  return record;
}

async function queryGreenville({ address, parcelId, fetcher }) {
  if (!parcelId) return null;
  const mapNumber = normalizeParcelId(parcelId);
  for (const taxYear of [new Date().getFullYear(), new Date().getFullYear() - 1]) {
    const url = new URL('https://www.greenvillecounty.org/appsAS400/RealProperty/Details.aspx');
    url.searchParams.set('MapNumber', mapNumber);
    url.searchParams.set('TaxYear', String(taxYear));
    const html = await requestHtml(url, fetcher);
    if (!html) continue;
    const record = recordWithIdentity(parseGreenvillePropertyHtml(html, url.toString()), { address, parcelId });
    if (record) return record;
  }
  return null;
}

async function queryGreenwood({ address, parcelId, fetcher }) {
  if (!parcelId) return null;
  const url = new URL('https://www.greenwoodsc.gov/Property_Report_TS/Default.aspx');
  url.searchParams.set('isTinyScreen', 'false');
  url.searchParams.set('pin', greenwoodParcelId(parcelId));
  const html = await requestHtml(url, fetcher);
  if (!html) return null;
  return recordWithIdentity(parseGreenwoodPropertyHtml(html, url.toString()), { address, parcelId });
}

export async function queryOfficialCountyProperty({
  county,
  address,
  parcelId,
  fetcher = fetch,
  browserFetcher = defaultBrowserFetcher,
  allowBrowser = true,
}) {
  const portal = scOwnerPortalFor(county);
  if (!portal?.propertyProvider || portal.propertyProvider === 'restricted') return null;
  if (portal.propertyProvider === 'berkeley') {
    return queryBerkeley({ address, parcelId, fetcher, browserFetcher, allowBrowser, portal });
  }
  if (portal.propertyProvider === 'greenville') return queryGreenville({ address, parcelId, fetcher });
  if (portal.propertyProvider === 'greenwood') return queryGreenwood({ address, parcelId, fetcher });
  return null;
}

export const __testables = {
  berkeleyStreetSearch,
  greenwoodParcelId,
  parseBerkeleySearchResult,
  recordWithIdentity,
};
