export const REAL_ESTATE_API_PROPERTY_DETAIL_URL = 'https://api.realestateapi.com/v2/PropertyDetail';
export const REAL_ESTATE_API_PROPERTY_DETAIL_PROXY = '/.netlify/functions/realestateapi-property';
export const REAL_ESTATE_API_PROPERTY_DETAIL_DOCS = 'https://developer.realestateapi.com/reference/property-detail-api-1';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RealEstateMortgageRecord {
  id?: string;
  amount?: number;
  documentDate?: string;
  recordingDate?: string;
  lenderName?: string;
  lenderType?: string;
  loanType?: string;
  interestRate?: number;
  interestRateType?: string;
  maturityDate?: string;
  deedType?: string;
  granteeName?: string;
  open?: boolean;
  transactionType?: string;
}

export interface RealEstateSaleRecord {
  saleDate?: string;
  recordingDate?: string;
  amount?: number;
  buyerNames?: string;
  sellerNames?: string;
  documentType?: string;
  transactionType?: string;
  purchaseMethod?: string;
  armsLength?: boolean;
  downPayment?: number;
  ltv?: number;
}

export interface RealEstatePropertyTransactions {
  propertyId?: string;
  matchedAddress: string;
  lastSaleDate?: string;
  lastSalePrice?: number;
  openMortgageBalance?: number;
  estimatedMortgageBalance?: number;
  freeClear?: boolean;
  mortgages: RealEstateMortgageRecord[];
  sales: RealEstateSaleRecord[];
  fetchedAt: string;
  sourceUrl: string;
}

export class RealEstateApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'RealEstateApiError';
    this.status = status;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function textValue(value: unknown): string | undefined {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed != null && parsed > 0 ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || String(value).toLowerCase() === 'false') return false;
  return undefined;
}

function dateValue(value: unknown): string | undefined {
  const raw = textValue(value);
  if (!raw) return undefined;
  const isoDate = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function responseData(payload: unknown): Record<string, unknown> {
  let current: unknown = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(current)) {
      current = current.find((entry) => Object.keys(objectValue(entry)).length > 0) || {};
      continue;
    }
    const record = objectValue(current);
    const nested = record.data ?? record.property ?? record.result;
    if (!nested || nested === current || (typeof nested !== 'object' && !Array.isArray(nested))) {
      return record;
    }
    current = nested;
  }
  return objectValue(current);
}

function addressLabel(address: Record<string, unknown>): string {
  const label = typeof address.label === 'string' ? textValue(address.label) : undefined;
  if (label) return label;
  const street = (typeof address.address === 'string' ? textValue(address.address) : undefined)
    || [textValue(address.house), textValue(address.street), textValue(address.streetType)].filter(Boolean).join(' ');
  const city = textValue(address.city);
  const stateZip = [textValue(address.state), textValue(address.zip)].filter(Boolean).join(' ');
  return [street, city, stateZip].filter(Boolean).join(', ');
}

function addressObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { label: value };
  return objectValue(value);
}

function propertyAddress(root: Record<string, unknown>): Record<string, unknown> {
  const propertyInfo = objectValue(root.propertyInfo || root.property_info);
  const property = objectValue(root.property);
  const candidates: unknown[] = [
    propertyInfo.address,
    root.address,
    root.propertyAddress,
    root.property_address,
    root.siteAddress,
    property.address,
  ];
  for (const candidate of candidates) {
    const record = addressObject(candidate);
    if (addressLabel(record)) return record;
  }

  // Some sparse land and recorder records flatten the situs parts onto
  // propertyInfo instead of returning propertyInfo.address.
  if (addressLabel(propertyInfo)) return propertyInfo;
  return {};
}

function hasPropertyRecord(root: Record<string, unknown>): boolean {
  if (textValue(root.id || root.propertyId || root.property_id)) return true;
  if (Object.keys(objectValue(root.propertyInfo || root.property_info)).length > 0) return true;
  if (Object.keys(objectValue(root.lotInfo || root.lot_info)).length > 0) return true;
  if (Object.keys(objectValue(root.lastSale || root.last_sale)).length > 0) return true;
  if (arrayValue(root.saleHistory || root.sale_history).length > 0) return true;
  if (arrayValue(root.currentMortgages || root.current_mortgages).length > 0) return true;
  return arrayValue(root.mortgageHistory || root.mortgage_history).length > 0;
}

function expectedAddressParts(address: string): { house?: string; state?: string; zip?: string } {
  const first = address.split(',')[0] || '';
  return {
    house: first.match(/^\s*(\d+[A-Za-z]?)/)?.[1]?.toUpperCase(),
    state: address.match(/\b(NC|SC)\b/i)?.[1]?.toUpperCase(),
    zip: address.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/)?.[1],
  };
}

function assertExactAddress(requestedAddress: string, matchedAddress: Record<string, unknown>): void {
  const expected = expectedAddressParts(requestedAddress);
  const label = addressLabel(matchedAddress);
  const actual = {
    house: textValue(matchedAddress.house)?.toUpperCase()
      || label.match(/^\s*(\d+[A-Za-z]?)/)?.[1]?.toUpperCase(),
    state: textValue(matchedAddress.state)?.toUpperCase()
      || label.match(/\b(NC|SC)\b/i)?.[1]?.toUpperCase(),
    zip: textValue(matchedAddress.zip)?.match(/^\d{5}/)?.[0]
      || label.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1],
  };
  const conflicts = (['house', 'state', 'zip'] as const)
    .filter((field) => expected[field] && actual[field] && expected[field] !== actual[field]);
  if (conflicts.length > 0) {
    throw new RealEstateApiError(
      `RealEstateAPI returned a different property (${addressLabel(matchedAddress) || 'address mismatch'}). No records were shown.`,
      409,
    );
  }
}

function mortgageRecord(value: Record<string, unknown>, current = false): RealEstateMortgageRecord {
  return {
    id: textValue(value.mortgageId || value.id),
    amount: positiveNumber(value.amount),
    documentDate: dateValue(value.documentDate),
    recordingDate: dateValue(value.recordingDate),
    lenderName: textValue(value.lenderName),
    lenderType: textValue(value.lenderType),
    loanType: textValue(value.loanType),
    interestRate: positiveNumber(value.interestRate),
    interestRateType: textValue(value.interestRateType),
    maturityDate: dateValue(value.maturityDate),
    deedType: textValue(value.deedType),
    granteeName: textValue(value.granteeName),
    open: booleanValue(value.open) ?? (current ? true : undefined),
    transactionType: textValue(value.transactionType),
  };
}

function saleRecord(value: Record<string, unknown>): RealEstateSaleRecord {
  return {
    saleDate: dateValue(value.saleDate),
    recordingDate: dateValue(value.recordingDate),
    amount: positiveNumber(value.saleAmount ?? value.amount),
    buyerNames: textValue(value.buyerNames),
    sellerNames: textValue(value.sellerNames),
    documentType: textValue(value.documentType),
    transactionType: textValue(value.transactionType),
    purchaseMethod: textValue(value.purchaseMethod),
    armsLength: booleanValue(value.armsLength),
    downPayment: positiveNumber(value.downPayment),
    ltv: positiveNumber(value.ltv),
  };
}

function recordDate(value: { recordingDate?: string; documentDate?: string; saleDate?: string }): string {
  return value.recordingDate || value.documentDate || value.saleDate || '';
}

function uniqueBy<T>(records: T[], keyOf: (record: T) => string): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = keyOf(record);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeRealEstateApiAddress(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,+$/, '')
    .replace(/,?\s*(?:United States(?: of America)?|USA|U\.S\.A\.|US)\.?$/i, '')
    .replace(/\bNorth Carolina\b/gi, 'NC')
    .replace(/\bSouth Carolina\b/gi, 'SC')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    // Property Detail documents the formatted-address form as
    // "123 Main St, City ST 12345" (no comma between city and state).
    .replace(/,\s*(NC|SC)\b(?=\s+\d{5}(?:-\d{4})?\b|$)/i, ' $1')
    .trim();
}

interface RealEstateApiAddressParts {
  house: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  unit?: string;
}

function realEstateApiAddressParts(address: string): RealEstateApiAddressParts | null {
  const normalized = normalizeRealEstateApiAddress(address);
  const locality = normalized.match(/^(.+),\s*([^,]+?)\s+(NC|SC)\s+(\d{5})(?:-\d{4})?$/i);
  if (!locality) return null;
  const streetLine = locality[1].trim();
  const streetMatch = streetLine.match(/^(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)\s+(.+)$/);
  if (!streetMatch) return null;

  let street = streetMatch[2].trim();
  let unit: string | undefined;
  const unitMatch = street.match(/(?:\s+|,\s*)(?:Apt|Apartment|Unit|Suite|Ste|#)\s*([A-Za-z0-9-]+)$/i);
  if (unitMatch) {
    unit = unitMatch[1];
    street = street.slice(0, unitMatch.index).replace(/,+$/, '').trim();
  }
  if (!street) return null;

  return {
    house: streetMatch[1],
    street,
    city: locality[2].trim(),
    state: locality[3].toUpperCase(),
    zip: locality[4],
    ...(unit ? { unit } : {}),
  };
}

export function parseRealEstatePropertyTransactions(
  payload: unknown,
  requestedAddress: string,
  fetchedAt = new Date().toISOString(),
): RealEstatePropertyTransactions {
  const root = responseData(payload);
  const matchedAddressObject = propertyAddress(root);
  const returnedAddress = addressLabel(matchedAddressObject);
  if (returnedAddress) {
    assertExactAddress(requestedAddress, matchedAddressObject);
  } else if (!hasPropertyRecord(root)) {
    throw new RealEstateApiError('RealEstateAPI returned no property record for this address.', 404);
  }
  // A successful exact_match response can omit propertyInfo.address for sparse
  // land/recorder records. In that case the requested address is the only safe
  // display label; the record itself still carries the REAPI property ID and/or
  // transaction data proving that the endpoint resolved a property.
  const matchedAddress = returnedAddress || normalizeRealEstateApiAddress(requestedAddress);

  const historicalMortgages = arrayValue(root.mortgageHistory).map((record) => mortgageRecord(record));
  const currentMortgages = arrayValue(root.currentMortgages).map((record) => mortgageRecord(record, true));
  const mortgages = uniqueBy(
    [...currentMortgages, ...historicalMortgages],
    (record) => {
      const signature = [recordDate(record), record.amount, record.lenderName, record.loanType]
        .filter((value) => value != null && value !== '')
        .join('|')
        .toLowerCase();
      return signature || record.id || '';
    },
  )
    .sort((a, b) => recordDate(b).localeCompare(recordDate(a)))
    .slice(0, 50);

  const lastSale = objectValue(root.lastSale);
  const salesInput = arrayValue(root.saleHistory);
  if (Object.keys(lastSale).length > 0) salesInput.unshift(lastSale);
  const sales = uniqueBy(
    salesInput.map(saleRecord),
    (record) => [
      record.saleDate,
      record.recordingDate,
      record.amount ?? 0,
      record.buyerNames,
      record.sellerNames,
      record.transactionType,
    ].join('|').toLowerCase(),
  )
    .sort((a, b) => recordDate(b).localeCompare(recordDate(a)))
    .slice(0, 50);

  return {
    propertyId: textValue(root.id || root.propertyId),
    matchedAddress,
    lastSaleDate: dateValue(root.lastSaleDate) || sales[0]?.saleDate,
    lastSalePrice: positiveNumber(root.lastSalePrice) || sales[0]?.amount,
    openMortgageBalance: numberValue(root.openMortgageBalance),
    estimatedMortgageBalance: numberValue(root.estimatedMortgageBalance),
    freeClear: booleanValue(root.freeClear),
    mortgages,
    sales,
    fetchedAt,
    sourceUrl: REAL_ESTATE_API_PROPERTY_DETAIL_DOCS,
  };
}

function errorMessage(status: number, payload: unknown, raw: string): string {
  const body = objectValue(payload);
  const upstream = textValue(body.message || body.error || body.statusMessage || body.status_message);
  if (status === 400) return upstream || 'RealEstateAPI could not validate the full property address.';
  if (status === 401 || status === 403) return 'RealEstateAPI rejected the API key. Add a valid RealEstateAPI.com key in Account Settings.';
  if (status === 404) return 'RealEstateAPI found no exact public-record match for this full address.';
  if (status === 429) return 'RealEstateAPI rate limit or credit limit reached. Wait or check the account plan, then retry.';
  if (status >= 500) return 'RealEstateAPI is temporarily unavailable. Retry this lookup in a moment.';
  return upstream || raw.slice(0, 240) || `RealEstateAPI request failed (HTTP ${status}).`;
}

async function readResponse(response: Response): Promise<{ raw: string; payload: unknown }> {
  const raw = await response.text();
  try {
    return { raw, payload: raw ? JSON.parse(raw) : {} };
  } catch {
    return { raw, payload: {} };
  }
}

export async function fetchRealEstatePropertyTransactions(
  address: string,
  apiKey = '',
  fetcher: FetchLike = fetch,
): Promise<RealEstatePropertyTransactions> {
  const normalizedAddress = normalizeRealEstateApiAddress(address);
  if (!normalizedAddress || !/\b(?:NC|SC)\b/i.test(normalizedAddress)) {
    throw new RealEstateApiError('A full North Carolina or South Carolina address is required.', 400);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (apiKey.trim()) headers['x-api-key'] = apiKey.trim();
  const addressParts = realEstateApiAddressParts(normalizedAddress);
  const request = async (requestBody: { address: string } | RealEstateApiAddressParts) => {
    const init: RequestInit = {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({
        ...requestBody,
        exact_match: true,
        comps: false,
      }),
    };

    let response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_PROXY, init);
    let result = await readResponse(response);
    const contentType = response.headers.get('content-type') || '';
    const proxyMissing = !contentType.includes('json') && /^\s*</.test(result.raw);
    if (proxyMissing && apiKey.trim()) {
      response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_URL, {
        ...init,
      });
      result = await readResponse(response);
    }
    return { response, result };
  };

  let lookup = await request({ address: normalizedAddress });
  if (lookup.response.ok) {
    try {
      return parseRealEstatePropertyTransactions(lookup.result.payload, normalizedAddress);
    } catch (error) {
      if (!(error instanceof RealEstateApiError) || error.status !== 404 || !addressParts) throw error;
    }
  } else if (!addressParts || (lookup.response.status !== 400 && lookup.response.status !== 404)) {
    throw new RealEstateApiError(
      errorMessage(lookup.response.status, lookup.result.payload, lookup.result.raw),
      lookup.response.status,
    );
  }

  lookup = await request(addressParts);
  if (!lookup.response.ok) {
    throw new RealEstateApiError(
      errorMessage(lookup.response.status, lookup.result.payload, lookup.result.raw),
      lookup.response.status,
    );
  }
  return parseRealEstatePropertyTransactions(lookup.result.payload, normalizedAddress);
}

/** Owner + land facts recovered from public records when county GIS has none. */
export interface RealEstateOwnerDetails {
  matchedAddress: string;
  ownerName?: string;
  ownerSecondName?: string;
  mailingAddress?: string;
  ownerOccupied?: boolean;
  parcelId?: string;
  legalDescription?: string;
  lotSquareFeet?: number;
  lotAcres?: number;
  landUse?: string;
  zoning?: string;
  assessedValue?: number;
  assessedLandValue?: number;
  marketValue?: number;
  taxAmount?: number;
  taxYear?: number;
  fetchedAt: string;
}

/**
 * Owner and land details from RealEstateAPI PropertyDetail — the gap-filler for
 * SC counties whose parcel data is not publicly queryable (their assessor
 * portals sit behind Cloudflare, verified returning HTTP 403 server-side).
 *
 * Called ON DEMAND from the "Look up owner" button, never automatically, because
 * each request consumes account credits.
 */
export async function fetchRealEstateOwnerDetails(
  address: string,
  apiKey = '',
  fetcher: FetchLike = fetch,
): Promise<RealEstateOwnerDetails> {
  const normalizedAddress = normalizeRealEstateApiAddress(address);
  if (!normalizedAddress || !/\b(?:NC|SC)\b/i.test(normalizedAddress)) {
    throw new RealEstateApiError('A full North Carolina or South Carolina address is required.', 400);
  }

  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (apiKey.trim()) headers['x-api-key'] = apiKey.trim();
  const addressParts = realEstateApiAddressParts(normalizedAddress);

  const request = async (requestBody: { address: string } | RealEstateApiAddressParts) => {
    const init: RequestInit = {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({ ...requestBody, exact_match: true, comps: false }),
    };
    let response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_PROXY, init);
    let result = await readResponse(response);
    const contentType = response.headers.get('content-type') || '';
    const proxyMissing = !contentType.includes('json') && /^\s*</.test(result.raw);
    if (proxyMissing && apiKey.trim()) {
      response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_URL, { ...init });
      result = await readResponse(response);
    }
    return { response, result };
  };

  let lookup = await request({ address: normalizedAddress });
  if (!lookup.response.ok) {
    if (!addressParts || (lookup.response.status !== 400 && lookup.response.status !== 404)) {
      throw new RealEstateApiError(
        errorMessage(lookup.response.status, lookup.result.payload, lookup.result.raw),
        lookup.response.status,
      );
    }
    lookup = await request(addressParts);
    if (!lookup.response.ok) {
      throw new RealEstateApiError(
        errorMessage(lookup.response.status, lookup.result.payload, lookup.result.raw),
        lookup.response.status,
      );
    }
  }
  return parseRealEstateOwnerDetails(lookup.result.payload, normalizedAddress);
}

/** Public-record zoning for a parcel, used only when official GIS has none. */
export interface RealEstateZoningResult {
  code: string;
  matchedAddress: string;
  landUse?: string;
  /**
   * Always 'base-district'. Measured against official GIS this source returns
   * the right base district but drops conditional/frontage suffixes: it gave
   * DX-40 where Raleigh publishes DX-40-SH, and LI where the layer says LI-C.
   * Callers must not present it as the full adopted district.
   */
  precision: 'base-district';
  sourceUrl: string;
  fetchedAt: string;
}

/**
 * Zoning from RealEstateAPI public records — the fallback for counties with no
 * queryable official zoning layer.
 *
 * Coverage is county-level and all-or-nothing: measured with PropertySearch
 * count queries, Cabarrus is 100%, Iredell 99.8%, Wake 94.7% and Union 98.8%
 * for LAND parcels, while Gaston, Sampson, Robeson and Bladen are 0%. So this
 * either answers well or not at all — it never half-answers. On the counties
 * that do carry it, land parcels matched official GIS exactly 16/16 in testing.
 *
 * Runs only after official GIS comes back empty, because each call costs a
 * credit.
 */
export async function fetchRealEstateZoning(
  address: string,
  apiKey = '',
  fetcher: FetchLike = fetch,
): Promise<RealEstateZoningResult | null> {
  const details = await fetchRealEstateOwnerDetails(address, apiKey, fetcher);
  const code = textValue(details.zoning);
  if (!code) return null;
  return {
    code,
    matchedAddress: details.matchedAddress,
    landUse: details.landUse,
    precision: 'base-district',
    sourceUrl: REAL_ESTATE_API_PROPERTY_DETAIL_DOCS,
    fetchedAt: details.fetchedAt,
  };
}

/** Map a PropertyDetail payload onto the owner/land fields the report shows. */
export function parseRealEstateOwnerDetails(
  payload: unknown,
  requestedAddress: string,
  fetchedAt = new Date().toISOString(),
): RealEstateOwnerDetails {
  const root = responseData(payload);
  const matchedAddressObject = propertyAddress(root);
  const returnedAddress = addressLabel(matchedAddressObject);
  if (returnedAddress) {
    assertExactAddress(requestedAddress, matchedAddressObject);
  } else if (!hasPropertyRecord(root)) {
    throw new RealEstateApiError('RealEstateAPI returned no property record for this address.', 404);
  }

  // The endpoint returns camelCase or snake_case depending on the record, so
  // accept both — the same defensive pattern the transactions parser uses.
  const owner = objectValue(root.ownerInfo || root.owner_info);
  const lot = objectValue(root.lotInfo || root.lot_info);
  const tax = objectValue(root.taxInfo || root.tax_info);
  const propertyInfo = objectValue(root.propertyInfo || root.property_info);
  const mail = objectValue(owner.mailAddress || owner.mail_address);

  const text = (value: unknown): string | undefined => {
    const v = String(value ?? '').trim();
    return v && v.toLowerCase() !== 'null' ? v : undefined;
  };
  const num = (value: unknown): number | undefined => {
    const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? n : undefined;
  };

  const lotSquareFeet = num(lot.lotSquareFeet ?? lot.lot_square_feet);
  const lotAcresRaw = num(lot.lotAcres ?? lot.lot_acres);
  const lotAcres = lotAcresRaw ?? (lotSquareFeet ? Math.round((lotSquareFeet / 43560) * 1000) / 1000 : undefined);

  return {
    matchedAddress: returnedAddress || normalizeRealEstateApiAddress(requestedAddress),
    ownerName: text(owner.owner1FullName ?? owner.owner1_full_name)
      || [text(owner.owner1FirstName), text(owner.owner1LastName)].filter(Boolean).join(' ').trim() || undefined,
    ownerSecondName: text(owner.owner2FullName ?? owner.owner2_full_name),
    mailingAddress: text(mail.label) || text(mail.address),
    ownerOccupied: typeof owner.ownerOccupied === 'boolean' ? owner.ownerOccupied : undefined,
    parcelId: text(root.apn) || text(propertyInfo.apn) || text(lot.apn) || text(lot.apnUnformatted),
    legalDescription: text(lot.legalDescription ?? lot.legal_description) || text(propertyInfo.legalDescription),
    lotSquareFeet,
    lotAcres,
    landUse: text(lot.landUse ?? lot.land_use) || text(propertyInfo.landUse),
    zoning: text(lot.zoning) || text(propertyInfo.zoning),
    assessedValue: num(tax.assessedValue ?? tax.assessed_value),
    assessedLandValue: num(tax.assessedLandValue ?? tax.assessed_land_value),
    marketValue: num(tax.marketValue ?? tax.market_value),
    taxAmount: num(tax.taxAmount ?? tax.tax_amount),
    taxYear: num(tax.year) ?? num(tax.taxYear ?? tax.tax_year),
    fetchedAt,
  };
}
