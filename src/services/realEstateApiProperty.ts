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
  const root = objectValue(payload);
  const data = root.data;
  if (Array.isArray(data)) return objectValue(data[0]);
  if (data && typeof data === 'object') {
    const nested = objectValue(data);
    return nested.data && typeof nested.data === 'object'
      ? objectValue(nested.data)
      : nested;
  }
  if (root.property && typeof root.property === 'object') return objectValue(root.property);
  if (root.result && typeof root.result === 'object') return objectValue(root.result);
  return root;
}

function addressLabel(address: Record<string, unknown>): string {
  const label = textValue(address.label);
  if (label) return label;
  const street = textValue(address.address)
    || [textValue(address.house), textValue(address.street), textValue(address.streetType)].filter(Boolean).join(' ');
  const city = textValue(address.city);
  const stateZip = [textValue(address.state), textValue(address.zip)].filter(Boolean).join(' ');
  return [street, city, stateZip].filter(Boolean).join(', ');
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
  const actual = {
    house: textValue(matchedAddress.house)?.toUpperCase()
      || addressLabel(matchedAddress).match(/^\s*(\d+[A-Za-z]?)/)?.[1]?.toUpperCase(),
    state: textValue(matchedAddress.state)?.toUpperCase(),
    zip: textValue(matchedAddress.zip)?.match(/^\d{5}/)?.[0],
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

export function parseRealEstatePropertyTransactions(
  payload: unknown,
  requestedAddress: string,
  fetchedAt = new Date().toISOString(),
): RealEstatePropertyTransactions {
  const root = responseData(payload);
  const propertyInfo = objectValue(root.propertyInfo);
  const matchedAddressObject = objectValue(propertyInfo.address || root.address);
  const matchedAddress = addressLabel(matchedAddressObject);
  if (!matchedAddress) {
    throw new RealEstateApiError('RealEstateAPI did not return an exact property address.', 404);
  }
  assertExactAddress(requestedAddress, matchedAddressObject);

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
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
    headers,
    body: JSON.stringify({
      address: normalizedAddress,
      exact_match: true,
      comps: false,
    }),
  };

  let response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_PROXY, init);
  let result = await readResponse(response);
  const contentType = response.headers.get('content-type') || '';
  const proxyMissing = !contentType.includes('json') && /^\s*</.test(result.raw);
  if (proxyMissing && apiKey.trim()) {
    response = await fetcher(REAL_ESTATE_API_PROPERTY_DETAIL_URL, init);
    result = await readResponse(response);
  }

  if (!response.ok) {
    throw new RealEstateApiError(errorMessage(response.status, result.payload, result.raw), response.status);
  }
  return parseRealEstatePropertyTransactions(result.payload, normalizedAddress);
}
