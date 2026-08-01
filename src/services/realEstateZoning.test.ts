import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRealEstateZoning, RealEstateApiError } from './realEstateApiProperty';

const ADDRESS = '3730 Shiloh Church Rd, Davidson NC 28036';

function payload(over: Record<string, unknown> = {}) {
  return {
    data: {
      id: '123',
      propertyInfo: { address: { label: ADDRESS, house: '3730', state: 'NC', zip: '28036' } },
      lotInfo: { zoning: 'CR', landUse: 'Residential', lotAcres: '2.10' },
      ...over,
    },
  };
}

const respond = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('returns the public-record district, flagged as base-district only', async () => {
  const out = await fetchRealEstateZoning(ADDRESS, 'k', respond(payload()) as never);
  assert.ok(out);
  assert.equal(out.code, 'CR');
  assert.equal(out.landUse, 'Residential');
  // Measured behaviour: this source drops conditional/frontage suffixes
  // (DX-40 for DX-40-SH), so it must never claim full district precision.
  assert.equal(out.precision, 'base-district');
});

test('a record with no zoning yields null, not a guess', async () => {
  // Gaston and the other zero-coverage counties look exactly like this.
  const out = await fetchRealEstateZoning(ADDRESS, 'k', respond(payload({ lotInfo: { landUse: 'Residential' } })) as never);
  assert.equal(out, null);
});

test('a different property is rejected rather than returned', async () => {
  const wrong = payload();
  (wrong.data.propertyInfo.address as Record<string, unknown>).house = '3999';
  (wrong.data.propertyInfo.address as Record<string, unknown>).label = '3999 Shiloh Church Rd, Davidson NC 28036';
  await assert.rejects(
    () => fetchRealEstateZoning(ADDRESS, 'k', respond(wrong) as never),
    (e: unknown) => e instanceof RealEstateApiError && e.status === 409,
  );
});

test('a non-Carolina address is refused before any request is made', async () => {
  let called = 0;
  await assert.rejects(
    () => fetchRealEstateZoning('1 Main St, Austin TX 78701', 'k', (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as never),
    (e: unknown) => e instanceof RealEstateApiError && e.status === 400,
  );
  assert.equal(called, 0, 'no credit should be spent on an out-of-area address');
});
