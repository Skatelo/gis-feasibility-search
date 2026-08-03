export type ParcelIdentityState = 'NC' | 'SC';

export interface RankedParcelCandidate {
  quality: number;
  state: ParcelIdentityState;
  county: string;
  parcelId: string;
  alternateParcelId?: string;
}

export interface ParsedParcelLookupInput {
  parcelId: string;
  countyHint?: string;
  stateHint?: ParcelIdentityState;
}

export class ParcelIdentityAmbiguityError extends Error {
  constructor(input: string, candidates: readonly RankedParcelCandidate[]) {
    const locations = [...new Set(candidates.map((candidate) =>
      `${candidate.county}${/,\s*(?:NC|SC)$/i.test(candidate.county) ? '' : `, ${candidate.state}`}`,
    ))].join('; ');
    super(`Parcel ID "${input}" is not unique (${locations}). Enter "parcel ID, County, State" or use the full property address so the owner cannot be assigned to the wrong parcel.`);
    this.name = 'ParcelIdentityAmbiguityError';
  }
}

export function normalizeParcelIdentity(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const STREET_TOKEN_ALIASES: Record<string, string> = {
  STREET: 'ST',
  ST: 'ST',
  ROAD: 'RD',
  RD: 'RD',
  AVENUE: 'AVE',
  AVE: 'AVE',
  HIGHWAY: 'HWY',
  HWY: 'HWY',
  LANE: 'LN',
  LN: 'LN',
  DRIVE: 'DR',
  DR: 'DR',
  BOULEVARD: 'BLVD',
  BLVD: 'BLVD',
  COURT: 'CT',
  CT: 'CT',
  CIRCLE: 'CIR',
  CIR: 'CIR',
  PLACE: 'PL',
  PL: 'PL',
  TERRACE: 'TER',
  TER: 'TER',
  PARKWAY: 'PKWY',
  PKWY: 'PKWY',
  TRAIL: 'TRL',
  TRL: 'TRL',
  TURNPIKE: 'TPKE',
  TPKE: 'TPKE',
  ROUTE: 'RTE',
  RTE: 'RTE',
  CROSSING: 'XING',
  XING: 'XING',
  COVE: 'CV',
  CV: 'CV',
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
};

/** Canonical street line used to bind a geocoded SC address to the assessor
 * parcel at that address instead of an arbitrary parcel beside the road. */
export function normalizeParcelStreetAddress(value: unknown): string {
  let text = String(value ?? '').trim().toUpperCase();
  if (!text) return '';
  const firstLine = text.split(',')[0]?.trim();
  if (/^\d+[A-Z]?(?:[-/]\d+[A-Z]?)?\s/.test(firstLine || '')) text = firstLine;
  text = text
    .replace(/\b(?:APT|APARTMENT|UNIT|SUITE|STE|BUILDING|BLDG)\b.*$/i, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((token) => STREET_TOKEN_ALIASES[token] || token)
    .join(' ');
}

export function parcelStreetAddressesMatch(left: unknown, right: unknown): boolean {
  const a = normalizeParcelStreetAddress(left);
  const b = normalizeParcelStreetAddress(right);
  if (!a || !b) return false;
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  if (aTokens[0] !== bTokens[0]) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.split(' ').length >= 3 && longer.startsWith(`${shorter} `);
}

/** Returns a feature only when one unique parcel publishes the searched situs
 * address. Duplicate condo/unit addresses remain unresolved instead of silently
 * assigning the first owner's name. */
export function selectUniqueAddressFeature<T>(
  features: readonly T[],
  expectedAddress: string,
  addressesForFeature: (feature: T) => readonly unknown[],
): T | null {
  if (!normalizeParcelStreetAddress(expectedAddress)) return null;
  const matches = features.filter((feature) =>
    addressesForFeature(feature).some((candidate) =>
      parcelStreetAddressesMatch(candidate, expectedAddress),
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

const SC_ENTITY_OWNER_RE = /\b(?:LLC|L\.?L\.?C\.?|INC|INCORPORATED|CORP|CORPORATION|COMPANY|CO|LP|LLP|PARTNERSHIP|HOLDINGS|PROPERTIES|INVESTMENTS?|VENTURES?|GROUP|REALTY|HOMES|BUILDERS|DEVELOPMENT|ASSOCIATION|ASSOC|HOA|CHURCH|CITY|TOWN|COUNTY|STATE|BANK|UNIVERSITY|SCHOOL|AUTHORITY|DEPARTMENT|COMMISSION|FOUNDATION|MINISTRIES|CEMETERY|CLUB|UNITED STATES|USA)\b/i;
const SC_OWNER_QUALIFIER_RE = /^(?:LIFE ESTATE|LIFE TENANT|REVOCABLE TRUST|IRREVOCABLE TRUST|FAMILY TRUST|TRUSTEES?|TRUST|ESTATE|HEIRS?|ET UX|ET VIR)\b/i;

function titleCaseOwner(value: string): string {
  return value.toLowerCase().replace(/(?:^|[-\s/'])\S/g, (match) => match.toUpperCase());
}

function formatSingleScTaxRollOwner(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return '';
  if (/^(?:THE\s+|ESTATE OF\s+|TRUST OF\s+)/i.test(name) || SC_ENTITY_OWNER_RE.test(name)) {
    return titleCaseOwner(name);
  }
  if (name.includes(',')) {
    const comma = name.indexOf(',');
    const surname = name.slice(0, comma).trim();
    const remainder = name.slice(comma + 1).replace(/,/g, ' ').trim();
    return titleCaseOwner(surname && remainder ? `${remainder} ${surname}` : name);
  }

  const tokens = name.split(' ').filter(Boolean);
  const qualifierIndex = tokens.findIndex((_, index) =>
    SC_OWNER_QUALIFIER_RE.test(tokens.slice(index).join(' ')),
  );
  if (qualifierIndex === 1) return titleCaseOwner(name);
  const nameTokens = qualifierIndex >= 2 ? tokens.slice(0, qualifierIndex) : [...tokens];
  const qualifierTokens = qualifierIndex >= 2 ? tokens.slice(qualifierIndex) : [];
  if (nameTokens.length < 2) return titleCaseOwner(name);

  const suffixes: string[] = [];
  while (nameTokens.length > 2 && /^(?:JR|SR|II|III|IV|V)\.?$/i.test(nameTokens[nameTokens.length - 1])) {
    suffixes.unshift(nameTokens.pop() as string);
  }
  const surname = nameTokens.shift() as string;
  return titleCaseOwner([...nameTokens, surname, ...suffixes, ...qualifierTokens].join(' '));
}

/** SC assessor rolls generally publish people surname-first without a comma.
 * Entity names stay in their published order, while legal suffixes such as
 * "LIFE ESTATE" remain attached after the reordered person's name. */
export function formatScTaxRollOwnerName(value: unknown): string | undefined {
  let name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || /^(?:N\/?A|NONE|UNKNOWN|NOT AVAILABLE)$/i.test(name)) return undefined;
  name = name.replace(/[,\s]+ET\s?AL\.?\s*$/i, '').trim();
  if (!name) return undefined;
  if (SC_ENTITY_OWNER_RE.test(name)) return titleCaseOwner(name);

  const owners = name.split(/\s*(?:&|\/|\bAND\b)\s*/i).map((owner) => owner.trim()).filter(Boolean);
  if (owners.length < 2) return formatSingleScTaxRollOwner(name);

  const firstRaw = owners[0];
  const firstSurname = (firstRaw.includes(',') ? firstRaw.slice(0, firstRaw.indexOf(',')) : firstRaw.split(' ')[0]).trim();
  const formatted = [formatSingleScTaxRollOwner(firstRaw)];
  for (const owner of owners.slice(1)) {
    const coTokens = owner.split(' ').filter(Boolean);
    const lacksSurname = !owner.includes(',') && (
      coTokens.length === 1 || (coTokens.length === 2 && /^[A-Z]\.?$/i.test(coTokens[1]))
    );
    formatted.push(formatSingleScTaxRollOwner(lacksSurname && firstSurname ? `${firstSurname} ${owner}` : owner));
  }
  return formatted.filter(Boolean).join(' & ') || undefined;
}

export function parseParcelLookupInput(value: string): ParsedParcelLookupInput {
  const input = String(value || '').trim();
  const qualified = input.match(/^(.*?),\s*([^,]+?)(?:\s+County)?,\s*(NC|SC)$/i);
  if (!qualified) return { parcelId: input };
  return {
    parcelId: qualified[1].trim(),
    countyHint: qualified[2].replace(/\s+County$/i, '').trim(),
    stateHint: qualified[3].toUpperCase() as ParcelIdentityState,
  };
}

export function parcelIdentitiesMatch(
  left: unknown,
  right: unknown,
  allowTrailingZeroSuffix = false,
): boolean {
  const a = normalizeParcelIdentity(left);
  const b = normalizeParcelIdentity(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!allowTrailingZeroSuffix) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && /^0+$/.test(longer.slice(shorter.length));
}

export function selectExactParcelFeature<T>(
  features: readonly T[],
  expectedParcelIds: readonly string[],
  parcelIdsForFeature: (feature: T) => readonly unknown[],
  allowTrailingZeroSuffix = false,
): T | null {
  const expected = expectedParcelIds.filter((value) => normalizeParcelIdentity(value));
  if (!expected.length) return features[0] ?? null;
  return features.find((feature) => {
    const candidateIds = parcelIdsForFeature(feature);
    return candidateIds.some((candidateId) =>
      expected.some((expectedId) =>
        parcelIdentitiesMatch(candidateId, expectedId, allowTrailingZeroSuffix),
      ),
    );
  }) ?? null;
}

export function chooseUniqueTopParcelCandidate<T extends RankedParcelCandidate>(
  input: string,
  candidates: readonly T[],
): T | null {
  if (!candidates.length) return null;
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const key = [
      candidate.state,
      candidate.county.trim().toUpperCase(),
      normalizeParcelIdentity(candidate.parcelId),
      normalizeParcelIdentity(candidate.alternateParcelId),
    ].join('|');
    if (!unique.has(key)) unique.set(key, candidate);
  }
  if (unique.size > 1) {
    throw new ParcelIdentityAmbiguityError(input, [...unique.values()]);
  }
  return candidates.reduce((best, candidate) =>
    candidate.quality > best.quality ? candidate : best,
  );
}
