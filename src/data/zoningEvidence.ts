export type ListingZoningEvidenceTier = 'reported' | 'corroborated';

const LISTING_HOSTS = [
  'zillow.com',
  'realtor.com',
  'redfin.com',
] as const;

export function zoningListingProvider(value: string): string | null {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return LISTING_HOSTS.find((candidate) => host === candidate || host.endsWith(`.${candidate}`)) || null;
  } catch {
    return null;
  }
}

/** Street types are noise for matching — "Ave" vs "Avenue" must not decide it. */
const STREET_TYPE_RE = /^(ave|avenue|st|street|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|way|pl|place|ter|terrace|trl|trail|hwy|highway|pkwy|parkway|loop|run|path|pt|point|sq|square)$/i;

function tokens(value: string): string[] {
  return decodeURIComponent(String(value || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does this listing URL actually describe the SUBJECT property?
 *
 * Listing providers put the address in the path
 * ("/homedetails/1992-Garland-Ave-Gastonia-NC-28052/..."), so the house number
 * and street name can be checked directly. This matters: asked about 1992
 * Garland Ave, the model has come back with listings for 1908 Garland Ave and
 * reported that neighbour's zoning as if it were this parcel's. A neighbour's
 * district is not evidence, and a wrong code is worse than no code.
 *
 * Unverifiable means false. Losing weak evidence is the safe direction.
 */
export function listingUrlMatchesAddress(url: string, address: string): boolean {
  if (!zoningListingProvider(url)) return false;

  const addressTokens = tokens(address);
  const houseNumber = addressTokens.find((token) => /^\d+[a-z]?$/.test(token));
  if (!houseNumber) return false; // no street number to verify against

  // The first non-numeric, non-street-type word is the street name.
  const streetName = addressTokens.find(
    (token) => token !== houseNumber && /^[a-z]/.test(token) && !STREET_TYPE_RE.test(token),
  );

  let pathTokens: string[];
  try {
    pathTokens = tokens(new URL(url).pathname);
  } catch {
    return false;
  }

  const numberIndex = pathTokens.indexOf(houseNumber);
  if (numberIndex === -1) return false;
  if (!streetName) return true;
  // The street name must sit right after the number, so a house number that
  // merely collides with a listing id elsewhere in the path cannot pass.
  return pathTokens.slice(numberIndex + 1, numberIndex + 3).includes(streetName);
}

/** One exact-address listing is reported evidence; matching records from two
 * independent listing providers are corroborated evidence. */
export function listingZoningEvidenceTier(urls: string[]): ListingZoningEvidenceTier | null {
  const providers = new Set(urls.map(zoningListingProvider).filter((value): value is string => !!value));
  if (providers.size >= 2) return 'corroborated';
  if (providers.size === 1) return 'reported';
  return null;
}
