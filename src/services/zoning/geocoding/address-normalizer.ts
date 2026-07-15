const STATE_NAMES: Record<string, string> = {
  'north carolina': 'NC',
  'south carolina': 'SC',
};

/** Conservative input normalization. The geocoder remains responsible for the
 * authoritative postal form; this only creates stable requests and cache keys. */
export function normalizeAddressInput(value: string): string {
  let normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,{2,}/g, ',')
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '');

  for (const [name, abbreviation] of Object.entries(STATE_NAMES)) {
    normalized = normalized.replace(new RegExp(`\\b${name}\\b`, 'gi'), abbreviation);
  }
  return normalized;
}

export function addressCacheKey(value: string): string {
  return normalizeAddressInput(value).toLocaleLowerCase('en-US');
}
