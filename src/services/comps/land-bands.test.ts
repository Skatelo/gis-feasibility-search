import test from 'node:test';
import assert from 'node:assert/strict';
import {
  landPriceBandsByRadius,
  subdivisionYield,
  LAND_ARV_LOW_PCT,
  LAND_ARV_HIGH_PCT,
} from './land-bands';
import type { CompProperty } from '../../types/feasibility';

const comp = (price: number, distanceMiles: number): CompProperty =>
  ({ address: `${price} Main St`, price, distanceMiles, saleDate: '2026-01-01' } as CompProperty);

test('a parcel that cannot be subdivided yields null', () => {
  // 0.5 acre with a 10,000 SF minimum: 2,178 SF short of even one extra lot.
  assert.equal(subdivisionYield(0.5, 10_000), null);
  // Exactly one lot's worth.
  assert.equal(subdivisionYield(0.23, 10_000), null);
});

test('missing inputs yield null rather than a guess', () => {
  assert.equal(subdivisionYield(undefined, 10_000), null, 'no acreage');
  assert.equal(subdivisionYield(5, undefined), null, 'no minimum lot size');
  assert.equal(subdivisionYield(5, 0), null);
  assert.equal(subdivisionYield(-5, 10_000), null);
  assert.equal(subdivisionYield(Number.NaN, 10_000), null);
});

test('a minor split keeps the higher efficiency', () => {
  // 1 acre / 10,000 SF = 4 gross lots -> minor split, 10% infrastructure loss.
  const y = subdivisionYield(1, 10_000);
  assert.ok(y);
  assert.equal(y.grossLots, 4);
  assert.equal(y.efficiency, 0.9);
  assert.equal(y.lots, 3, 'floor(4 * 0.9)');
});

test('a larger tract absorbs the road and stormwater discount', () => {
  // 10 acres / 10,000 SF = 43 gross lots -> major subdivision, 25% loss.
  const y = subdivisionYield(10, 10_000);
  assert.ok(y);
  assert.equal(y.grossLots, 43);
  assert.equal(y.efficiency, 0.75);
  assert.equal(y.lots, 32, 'floor(43 * 0.75)');
});

test('the discount can take a marginal tract back to one lot', () => {
  // 0.46 acres = 20,037 SF, which clears two 10,000 SF lots by only 37 SF.
  // Gross yield is 2, but 2 * 0.9 floors to 1, so no split is claimed. Being
  // conservative at the razor's edge is deliberate: any easement or road
  // dedication would wipe out that margin.
  assert.equal(subdivisionYield(0.46, 10_000), null);
  // One more tenth of an acre gives the second lot real room.
  assert.equal(subdivisionYield(0.56, 10_000)?.lots, 2);
});

test('a plain two-lot split is reported', () => {
  // Regression: discounting the lot COUNT instead of the land made 2 * 0.9 floor
  // to 1, which hid every two-lot split — the most common one there is.
  const y = subdivisionYield(1, 15_000);
  assert.ok(y, 'a 1-acre parcel with a 15,000 SF minimum splits in two');
  assert.equal(y.lots, 2);
});

test('without a yield the band is the single-lot price and totals stay null', () => {
  const bands = landPriceBandsByRadius([comp(400_000, 0.5), comp(600_000, 2)], 3, [1, 3]);

  const oneMile = bands[0];
  assert.equal(oneMile.compCount, 1);
  assert.equal(oneMile.averagePrice, 400_000);
  assert.equal(oneMile.lowPrice, 400_000 * LAND_ARV_LOW_PCT);
  assert.equal(oneMile.highPrice, 400_000 * LAND_ARV_HIGH_PCT);
  assert.equal(oneMile.totalLowPrice, null, 'no subdivision totals');
  assert.equal(oneMile.totalHighPrice, null);

  const threeMile = bands[1];
  assert.equal(threeMile.compCount, 2);
  assert.equal(threeMile.averagePrice, 500_000, 'average, not median');
});

test('with a yield the band is per lot and the total multiplies by lot count', () => {
  const y = subdivisionYield(10, 10_000);
  assert.ok(y);
  const [band] = landPriceBandsByRadius([comp(400_000, 0.5)], 1, [1], y);

  // Per-lot band is unchanged — the 8%–15% rule is per lot.
  assert.equal(band.lowPrice, 32_000);
  assert.equal(band.highPrice, 60_000);
  // Whole parcel = per lot * 32 lots.
  assert.equal(band.totalLowPrice, 32_000 * 32);
  assert.equal(band.totalHighPrice, 60_000 * 32);
});

test('an uncovered radius reports no total even when the tract splits', () => {
  const y = subdivisionYield(10, 10_000);
  const bands = landPriceBandsByRadius([comp(400_000, 0.5)], 1, [1, 5], y);
  assert.equal(bands[1].covered, false);
  assert.equal(bands[1].averagePrice, null);
  assert.equal(bands[1].totalLowPrice, null, 'no comps means no total, split or not');
});
