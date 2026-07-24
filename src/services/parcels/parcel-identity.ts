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
