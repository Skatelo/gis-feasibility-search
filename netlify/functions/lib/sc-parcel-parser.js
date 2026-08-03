function textValue(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function money(value) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function number(value) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function zoningCode(value) {
  const code = textValue(value);
  if (!code || code.length > 50 || /^(?:n\/?a|none|unknown|null|not available|unavailable)$/i.test(code)) return undefined;
  return code;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return textValue(match[1]);
  }
  return undefined;
}

export function normalizeParcelId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const STREET_ALIASES = {
  STREET: 'ST', ROAD: 'RD', AVENUE: 'AVE', HIGHWAY: 'HWY', LANE: 'LN', DRIVE: 'DR',
  BOULEVARD: 'BLVD', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER',
  PARKWAY: 'PKWY', TRAIL: 'TRL', TURNPIKE: 'TPKE', ROUTE: 'RTE', CROSSING: 'XING',
  COVE: 'CV', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
};

export function normalizeSitusAddress(value) {
  let text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  const firstLine = text.split(',')[0]?.trim();
  if (/^\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s/.test(firstLine || '')) text = firstLine;
  text = text
    .replace(/\b(?:APT|APARTMENT|UNIT|SUITE|STE|BUILDING|BLDG)\b.*$/i, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return text.split(/\s+/).filter(Boolean).map((token) => STREET_ALIASES[token] || token).join(' ');
}

export function situsAddressesMatch(left, right) {
  const a = normalizeSitusAddress(left);
  const b = normalizeSitusAddress(right);
  if (!a || !b) return false;
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  if (aTokens[0] !== bTokens[0]) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.split(' ').length >= 3 && longer.startsWith(`${shorter} `);
}

export function scParcelIdsMatch(left, right) {
  const a = normalizeParcelId(left);
  const b = normalizeParcelId(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && /^0+$/.test(longer.slice(shorter.length));
}

export function parseQpublicParcelText(content, sourceUrl) {
  const text = String(content || '').replace(/\r/g, '');
  if (!text || /attention required|sorry, you have been blocked|just a moment|captcha/i.test(text)) {
    return { status: 'blocked', sourceUrl };
  }

  const parcelId = firstMatch(text, [
    /Parcel Number\s*\n?\s*([^\n]+)/i,
    /Parcel ID\s*\n?\s*([^\n]+)/i,
  ]);
  const situsAddress = firstMatch(text, [
    /Location Address\s*\n?\s*([^\n]+)/i,
    /Property Address\s*\n?\s*([^\n]+)/i,
  ]);

  const ownersSection = text.match(/Owners?\s*\n([\s\S]*?)(?:\n\s*\d{4}\s+Value Information|\n\s*Value Information|\n\s*Building Information)/i)?.[1] || '';
  const ownerName = textValue(ownersSection.split('\n').map(textValue).find((line) => line && !/^owners?$/i.test(line)) || '');
  const mailingLines = ownersSection.split('\n').map(textValue).filter(Boolean).slice(1, 4);
  const mailingAddress = mailingLines.length ? mailingLines.join(', ').replace(/,\s*(\d{5})$/, ' $1') : undefined;

  const year = number(firstMatch(text, [/(\d{4})\s+Value Information/i, /Assessed Year\s*\n?\s*(\d{4})/i]));
  const taxDistrict = firstMatch(text, [
    /Tax District\s*\n?\s*[^\n]*?District\s*(\d+)/i,
    /District\s*\n?\s*(\d+)/i,
  ]);
  const acres = number(firstMatch(text, [/Acres?\s*\n?\s*([0-9,.]+)/i, /Acreage\s*\n?\s*([0-9,.]+)/i]));

  const landValue = money(firstMatch(text, [/Land Market Value\s*\$?([0-9,.-]+)/i, /Land Value\s*\$?([0-9,.-]+)/i]));
  const improvementValue = money(firstMatch(text, [/Improvement Market Value\s*\$?([0-9,.-]+)/i, /Improvement Value\s*\$?([0-9,.-]+)/i]));
  const marketValue = money(firstMatch(text, [/Total Market Value\s*\$?([0-9,.-]+)/i]));
  const taxableValue = money(firstMatch(text, [/Taxable Value\s*\$?([0-9,.-]+)/i]));
  const assessedValue = money(firstMatch(text, [/Total Assessed Value\s*\$?([0-9,.-]+)/i, /Assessed Value\s*\$?([0-9,.-]+)/i]));
  const taxAmount = money(firstMatch(text, [/Tax Amount\s*\$?([0-9,.-]+)/i, /Property Tax\s*\$?([0-9,.-]+)/i]));
  const zoning = zoningCode(firstMatch(text, [
    /Zoning(?: District| Code| Classification)?\s*\n\s*([^\n]+)/i,
    /Zoning(?: District| Code| Classification)?\s*:\s*([^\n]+)/i,
  ]));

  const firstFloorSqft = number(firstMatch(text, [/First Floor Sq Ft\s*\n?\s*([0-9,]+)/i]));
  const secondFloorSqft = number(firstMatch(text, [/Second Floor Sq Ft\s*\n?\s*([0-9,]+)/i]));
  const buildingSqft = firstFloorSqft != null || secondFloorSqft != null
    ? (firstFloorSqft || 0) + (secondFloorSqft || 0)
    : number(firstMatch(text, [/Building Sq(?:uare)? Ft\s*\n?\s*([0-9,]+)/i]));
  const baths = number(firstMatch(text, [/Baths\s*\n?\s*([0-9.]+)/i]));
  const stories = number(firstMatch(text, [/Stories\s*\n?\s*([0-9.]+)/i]));
  const buildingCount = number(firstMatch(text, [/([0-9]+)\s+Building\(s\) on Parcel/i]));
  const lastUpdated = firstMatch(text, [/Last Data Upload:\s*([^\n]+)/i]);

  if (!parcelId && !ownerName && !situsAddress) return { status: 'unavailable', sourceUrl };
  return {
    status: 'verified',
    sourceUrl,
    sourceName: 'County assessor',
    asOf: lastUpdated,
    parcelId,
    normalizedParcelId: normalizeParcelId(parcelId),
    situsAddress,
    ownerName: ownerName || undefined,
    ownerRecordType: 'assessor',
    mailingAddress,
    acres: acres && acres > 0 ? acres : undefined,
    assessedYear: year,
    assessedPropertyValue: taxableValue ?? assessedValue,
    totalAssessedValue: assessedValue,
    landValue,
    improvementValue,
    marketValue,
    taxableValue,
    taxCodeArea: taxDistrict,
    taxAmount,
    taxYear: taxAmount != null ? year : undefined,
    zoning,
    building: {
      livingSqft: buildingSqft,
      firstFloorSqft,
      buildingSqft,
      buildingCount,
      stories,
      baths,
    },
  };
}

export function unionReportUrl(parcelId) {
  let normalized = String(parcelId || '').trim();
  if (/^\d{3}-\d{2}-\d{2}-\d{3}$/.test(normalized)) normalized += ' 000';
  return `https://qpublic.schneidercorp.com/Application.aspx?AppID=861&LayerID=16112&PageTypeID=4&PageID=7170&KeyValue=${encodeURIComponent(normalized)}`;
}
