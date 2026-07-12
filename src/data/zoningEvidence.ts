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

/** One exact-address listing is reported evidence; matching records from two
 * independent listing providers are corroborated evidence. */
export function listingZoningEvidenceTier(urls: string[]): ListingZoningEvidenceTier | null {
  const providers = new Set(urls.map(zoningListingProvider).filter((value): value is string => !!value));
  if (providers.size >= 2) return 'corroborated';
  if (providers.size === 1) return 'reported';
  return null;
}
