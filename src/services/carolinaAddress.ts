type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CarolinaAddressResolutionOptions {
  addresses: Array<string | null | undefined>;
  coordinates?: { lat: number; lng: number };
  countyName?: string;
  googleMapsKey?: string;
  fetcher?: FetchLike;
}

function compactAddress(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,+$/, '')
    .replace(/,?\s*(?:United States(?: of America)?|USA|U\.S\.A\.|US)\.?$/i, '')
    .replace(/\bNorth Carolina\b/gi, 'NC')
    .replace(/\bSouth Carolina\b/gi, 'SC')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stateCode(value: string): 'NC' | 'SC' | undefined {
  return compactAddress(value).match(/\b(NC|SC)\b/i)?.[1]?.toUpperCase() as 'NC' | 'SC' | undefined;
}

function houseNumber(value: string): string {
  return compactAddress(value).match(/^\s*(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)/)?.[1]?.toUpperCase() || '';
}

export function isFullCarolinaPostalAddress(value: string): boolean {
  const address = compactAddress(value);
  if (!address || !houseNumber(address) || !stateCode(address)) return false;
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(address);
  const commaParts = address.split(',').map((part) => part.trim()).filter(Boolean);
  return hasZip || commaParts.length >= 3;
}

function component(result: Record<string, unknown>, type: string, name: 'short_name' | 'long_name' = 'short_name'): string {
  const item = (Array.isArray(result.address_components) ? result.address_components : [])
    .map(objectValue)
    .find((entry) => Array.isArray(entry.types) && entry.types.includes(type));
  return String(item?.[name] || item?.short_name || item?.long_name || '').trim();
}

function addressFromGoogleResult(result: Record<string, unknown>): { address: string; house: string; state: string } | null {
  const house = component(result, 'street_number');
  const route = component(result, 'route', 'long_name');
  const city = component(result, 'locality', 'long_name')
    || component(result, 'postal_town', 'long_name')
    || component(result, 'sublocality_level_1', 'long_name')
    || component(result, 'administrative_area_level_3', 'long_name');
  const state = component(result, 'administrative_area_level_1').toUpperCase();
  const zip = component(result, 'postal_code');
  const formatted = compactAddress(result.formatted_address);
  if (!house || !route || (state !== 'NC' && state !== 'SC')) return null;
  // Rural geocoder results sometimes omit a locality component even though the
  // formatted postal address contains the USPS city. Keep that complete result.
  if (!city && !isFullCarolinaPostalAddress(formatted)) return null;
  const address = isFullCarolinaPostalAddress(formatted)
    ? formatted
    : `${house} ${route}, ${city}, ${state}${zip ? ` ${zip}` : ''}`;
  return { address, house: house.toUpperCase(), state };
}

function chooseGoogleAddress(payload: unknown, expectedHouse: string, expectedState?: string): string {
  const root = objectValue(payload);
  const candidates = (Array.isArray(root.results) ? root.results : [])
    .map((result: unknown) => addressFromGoogleResult(objectValue(result)))
    .filter((value): value is NonNullable<typeof value> => !!value)
    .filter((value) => !expectedState || value.state === expectedState);
  if (!candidates.length) return '';
  if (expectedHouse) return candidates.find((value) => value.house === expectedHouse)?.address || '';
  return candidates[0].address;
}

async function googleGeocode(url: string, fetcher: FetchLike): Promise<unknown> {
  try {
    const response = await fetcher(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Resolve a street-only county GIS address to an exact NC/SC postal address.
 * Existing complete addresses are returned without a network request. Incomplete
 * addresses are forward-geocoded with county/state context first, then resolved
 * from the selected parcel point. A mismatched house number is never accepted.
 */
export async function resolveFullCarolinaPostalAddress(
  options: CarolinaAddressResolutionOptions,
): Promise<string> {
  const addresses = [...new Set(options.addresses.map(compactAddress).filter(Boolean))];
  const existing = addresses.find(isFullCarolinaPostalAddress);
  if (existing) return existing;

  const fallback = addresses[0] || '';
  const key = String(options.googleMapsKey || '').trim();
  if (!key) return fallback;

  const fetcher = options.fetcher || fetch;
  const county = compactAddress(options.countyName);
  const countyContext = county.replace(/^(.+?)(?:\s+County)?,\s*(NC|SC)$/i, '$1 County, $2');
  const expectedHouse = addresses.map(houseNumber).find(Boolean) || '';
  const expectedState = addresses.map(stateCode).find(Boolean) || stateCode(county);

  for (const address of addresses) {
    const query = stateCode(address) || !countyContext ? address : `${address}, ${countyContext}`;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}`
      + `&components=country:US&key=${encodeURIComponent(key)}`;
    const resolved = chooseGoogleAddress(await googleGeocode(url, fetcher), expectedHouse, expectedState);
    if (resolved) return resolved;
  }

  const lat = Number(options.coordinates?.lat);
  const lng = Number(options.coordinates?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}`
      + `&key=${encodeURIComponent(key)}`;
    const resolved = chooseGoogleAddress(await googleGeocode(url, fetcher), expectedHouse, expectedState);
    if (resolved) return resolved;
  }

  return fallback;
}
