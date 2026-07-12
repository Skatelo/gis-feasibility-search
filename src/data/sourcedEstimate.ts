export interface NormalizedRange {
  low: number;
  high: number;
  midpoint: number;
}

function positiveWholeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

/** Normalize a published point value or a researched low/high range. Invalid
 * values stay unavailable; reversed model bounds are corrected deterministically. */
export function normalizeSourcedRange(
  pointValue: unknown,
  lowValue: unknown,
  highValue: unknown,
): NormalizedRange | null {
  const point = positiveWholeNumber(pointValue);
  const first = positiveWholeNumber(lowValue) || point;
  const second = positiveWholeNumber(highValue) || point;
  if (!first && !second) return null;
  const low = Math.min(first || second, second || first);
  const high = Math.max(first || second, second || first);
  return { low, high, midpoint: Math.round((low + high) / 2) };
}
