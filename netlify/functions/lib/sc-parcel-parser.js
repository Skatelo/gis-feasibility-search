function textValue(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function money(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/[0-9]/.test(raw)) return undefined;
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function number(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/[0-9]/.test(raw)) return undefined;
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
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

function exactLabelValue(text, patterns) {
  const lines = String(text || '').split(/\r?\n/).map(textValue).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      const inlineValue = textValue(match[1] || '');
      if (inlineValue) return inlineValue;
      return textValue(lines[index + 1] || '') || undefined;
    }
  }
  return undefined;
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

const QPUBLIC_OWNER_HEADING_RE = /^(?:owners?|owner information|current owner):?$/i;
const QPUBLIC_OWNER_STOP_RE = /^(?:\d{4}\s+value information|value information|untitled section|general information|property information|land information|buildings?|building information|valuation by year|property valuation history|notice of value|assessment appeal process|tax information|documents?|sales?|sales history|recent sales in neighborhood|miscellaneous improvement information|mobile homes?|sketches|photos|map|parcel summary)$/i;

function qpublicOwnerSection(text) {
  const lines = String(text || '').split('\n').map(textValue).filter(Boolean);
  const headingIndex = lines.findIndex((line) => QPUBLIC_OWNER_HEADING_RE.test(line));
  if (headingIndex < 0) return [];
  const section = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (QPUBLIC_OWNER_STOP_RE.test(line)) break;
    if (/^(?:new search|view map|columns|legal residence form|mailing address change)$/i.test(line)) continue;
    section.push(line);
  }
  return section;
}

export function parseQpublicParcelText(content, sourceUrl) {
  const text = String(content || '').replace(/\r/g, '');
  if (!text || /attention required|sorry, you have been blocked|just a moment|captcha/i.test(text)) {
    return { status: 'blocked', sourceUrl };
  }

  const parcelId = exactLabelValue(text, [
    /^Parcel Number\s*:?\s*(.*)$/i,
    /^Parcel ID\s*:?\s*(.*)$/i,
  ]);
  const situsAddress = exactLabelValue(text, [
    /^Location Address\s*:?\s*(.*)$/i,
    /^Property Address\s*:?\s*(.*)$/i,
  ]);

  const ownerLines = qpublicOwnerSection(text);
  const ownerName = textValue(ownerLines[0] || '');
  const mailingLines = ownerLines.slice(1, 4);
  const mailingAddress = mailingLines.length ? mailingLines.join(', ').replace(/,\s*(\d{5})$/, ' $1') : undefined;

  const year = number(firstMatch(text, [
    /Property Valuation History[\s\S]{0,160}?\b(20\d{2})\b/i,
    /Valuation by Year[\s\S]{0,160}?\b(20\d{2})\b/i,
    /(\d{4})\s+Value Information/i,
    /Assessed Year\s*\n?\s*(\d{4})/i,
  ]));
  const taxDistrict = firstMatch(text, [
    /Tax District\s*\n?\s*[^\n]*?District\s*(\d+)/i,
    /District\s*\n?\s*(\d+)/i,
  ]);
  const acres = number(firstMatch(text, [/Acres?\s*\n?\s*([0-9,.]+)/i, /Acreage\s*\n?\s*([0-9,.]+)/i]));

  const landValue = money(firstMatch(text, [/Market Land Value\s*\$?([0-9,.-]+)/i, /Land Market Value\s*\$?([0-9,.-]+)/i, /Land Value\s*\$?([0-9,.-]+)/i]));
  const improvementValue = money(firstMatch(text, [/Market Improvement Value\s*\$?([0-9,.-]+)/i, /Improvement Market Value\s*\$?([0-9,.-]+)/i, /Improvement Value\s*\$?([0-9,.-]+)/i]));
  const marketValue = money(firstMatch(text, [
    /Total Market(?:\/Exemption)? Value\s*\$?([0-9,.-]+)/i,
    /(?:^|\n)Market Value\s*\$?([0-9,.-]+)/im,
  ]));
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
    : number(firstMatch(text, [/Building Sq(?:uare)? Ft\s*\n?\s*([0-9,]+)/i, /Total Area Sq Ft\s*\n?\s*([0-9,]+)/i, /Square Feet\s*\n?\s*([0-9,]+)/i]));
  const baths = number(firstMatch(text, [/Baths\s*\n?\s*([0-9.]+)/i]));
  const stories = number(firstMatch(text, [/Stories\s*\n?\s*([0-9.]+)/i, /Stories\s*\n?\s*([0-9.]+)\s+Floors?/i]));
  const buildingCount = number(firstMatch(text, [/([0-9]+)\s+Building\(s\) on Parcel/i, /Building No\.\s*\n?\s*([0-9]+)/i]));
  const lastUpdated = firstMatch(text, [/Last Data Upload:\s*([^\n]+)/i]);

  if (!parcelId || !ownerName) return { status: 'unavailable', sourceUrl };
  return {
    status: 'verified',
    sourceUrl,
    sourceName: 'County assessor',
    asOf: lastUpdated,
    parcelId,
    normalizedParcelId: normalizeParcelId(parcelId),
    situsAddress,
    ownerName: ownerName || undefined,
    ownerRecordType: ownerName ? 'assessor' : undefined,
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
