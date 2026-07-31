// ---------------------------------------------------------------------------
// LAND PRICE BANDS
// The rule of thumb builders use: a finished lot is worth roughly 8%–15% of the
// value of the home that gets built on it. Applying that band to the AVERAGE
// sold price of nearby comps gives a defensible "what to pay for the land"
// range, and showing it at several radii reveals how sensitive that number is to
// how far out you have to reach for comparables.
//
// Kept in its own module — free of network, DOM and config imports — so the
// arithmetic can be unit-tested directly.
// ---------------------------------------------------------------------------

import type { CompProperty } from '../../types/feasibility';

export const LAND_ARV_LOW_PCT = 0.08;
export const LAND_ARV_HIGH_PCT = 0.15;

export interface LandPriceBand {
  radiusMiles: number;
  compCount: number;
  /** AVERAGE sold price of the comps inside this radius — the value the 8%–15%
   *  band is applied to. */
  averagePrice: number | null;
  averagePricePerSqft: number | null;
  lowPrice: number | null;
  highPrice: number | null;
  /** False when the loaded comp set does not reach this far, so the row is
   *  honestly blank instead of implying data we don't have. */
  covered: boolean;
  /** Whole-parcel totals when the tract can be split: the per-lot band above
   *  multiplied by the buildable lot count. Null when it can't be subdivided. */
  totalLowPrice: number | null;
  totalHighPrice: number | null;
}

// ---------------------------------------------------------------------------
// SUBDIVISION LOT YIELD
// The 8%–15% rule is a PER-LOT rule: each finished lot is worth 8%–15% of the
// home built on it. On a tract that can be split, the parcel is therefore worth
// that band times the number of conforming lots — a very different number from
// the band applied once.
//
// Raw acreage ÷ minimum lot size overstates yield because it spends every square
// foot on lots and none on the road, stormwater, and open space the subdivision
// ordinance requires. The factors below discount for that. They are ESTIMATES
// for screening an offer, not an engineered yield plan.
// ---------------------------------------------------------------------------

const SQFT_PER_ACRE = 43_560;
/** A 2–4 lot minor split usually fronts an existing road: little land is lost. */
export const SMALL_SPLIT_EFFICIENCY = 0.9;
/** A larger tract needs internal road, stormwater and open space — 25% is the
 *  usual planning rule of thumb for that overhead. */
export const MAJOR_SUBDIVISION_EFFICIENCY = 0.75;
/** At or below this gross count the split is "minor" and keeps the higher
 *  efficiency. */
export const MINOR_SPLIT_MAX_LOTS = 4;

export interface SubdivisionYield {
  /** Conforming lots after the infrastructure discount — always >= 2. */
  lots: number;
  /** Lots before the discount (acreage ÷ minimum lot size), for transparency. */
  grossLots: number;
  acres: number;
  minimumLotAreaSqft: number;
  /** The efficiency factor applied, so the UI can state the assumption. */
  efficiency: number;
}

/**
 * Buildable lot count for a tract, or null when it cannot be subdivided or we
 * lack the inputs to say. Null is the honest answer for a missing minimum lot
 * size — the caller then shows the ordinary whole-parcel band rather than
 * implying a split we cannot support.
 */
export function subdivisionYield(
  acres: number | null | undefined,
  minimumLotAreaSqft: number | null | undefined,
): SubdivisionYield | null {
  const a = Number(acres);
  const minSqft = Number(minimumLotAreaSqft);
  if (!Number.isFinite(a) || a <= 0) return null;
  if (!Number.isFinite(minSqft) || minSqft <= 0) return null;

  const totalSqft = a * SQFT_PER_ACRE;
  const grossLots = Math.floor(totalSqft / minSqft);
  if (grossLots < 2) return null; // not splittable — one lot is all the zoning allows

  // The discount applies to the LAND, not to the lot count: infrastructure eats
  // square feet. Discounting the count instead would double-penalise small
  // tracts — 2 lots * 0.9 floors to 1, which would hide every two-lot split.
  const efficiency = grossLots <= MINOR_SPLIT_MAX_LOTS ? SMALL_SPLIT_EFFICIENCY : MAJOR_SUBDIVISION_EFFICIENCY;
  const lots = Math.floor((totalSqft * efficiency) / minSqft);
  if (lots < 2) return null; // after the overhead only one lot actually fits

  return { lots, grossLots, acres: a, minimumLotAreaSqft: minSqft, efficiency };
}

function averageOf(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!usable.length) return null;
  return Math.round(usable.reduce((sum, v) => sum + v, 0) / usable.length);
}

/**
 * Land-price bands for each radius, derived from the ALREADY-LOADED comps by
 * filtering on driving distance — no extra API calls. A radius wider than the
 * comp run is marked uncovered rather than reusing the narrower set, which would
 * overstate what the data supports.
 *
 * Uses the AVERAGE sold price so the figure matches the "Average Close Price"
 * buyers see on the comp summary and in the buyer presentation.
 *
 * The 8%–15% band is PER LOT. Pass a `lotYield` to also get whole-parcel totals
 * for a tract that can be split; without one the band is simply the single-lot
 * price, which is the correct reading for a parcel that cannot be subdivided.
 */
export function landPriceBandsByRadius(
  comps: CompProperty[] | undefined,
  loadedRadiusMiles: number,
  radii: number[] = [1, 3, 5, 10],
  lotYield?: SubdivisionYield | null,
): LandPriceBand[] {
  const all = Array.isArray(comps) ? comps : [];
  return radii.map((radiusMiles) => {
    const covered = radiusMiles <= loadedRadiusMiles;
    const within = covered
      ? all.filter((comp) => Number.isFinite(comp.distanceMiles) && comp.distanceMiles <= radiusMiles)
      : [];
    const averagePrice = averageOf(within.map((comp) => comp.price));
    const averagePricePerSqft = averageOf(
      within.map((comp) => (comp.pricePerSqft ?? (comp.sqft && comp.sqft > 0 ? comp.price / comp.sqft : 0))),
    );
    const lowPrice = averagePrice ? Math.round(averagePrice * LAND_ARV_LOW_PCT) : null;
    const highPrice = averagePrice ? Math.round(averagePrice * LAND_ARV_HIGH_PCT) : null;
    const lots = lotYield?.lots ?? 0;
    return {
      radiusMiles,
      compCount: within.length,
      averagePrice,
      averagePricePerSqft,
      lowPrice,
      highPrice,
      covered,
      totalLowPrice: lots && lowPrice ? lowPrice * lots : null,
      totalHighPrice: lots && highPrice ? highPrice * lots : null,
    };
  });
}
