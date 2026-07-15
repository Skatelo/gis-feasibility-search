import test from 'node:test';
import assert from 'node:assert/strict';
import { addressCacheKey, normalizeAddressInput } from './address-normalizer';

test('normalizes whitespace, commas, and Carolina state names conservatively', () => {
  assert.equal(
    normalizeAddressInput(' 3714  Memorial Parkway , Charlotte, North Carolina  28217 '),
    '3714 Memorial Parkway, Charlotte, NC 28217',
  );
  assert.equal(normalizeAddressInput('116 Wright Sims Road\nUnion, South Carolina 29379'), '116 Wright Sims Road Union, SC 29379');
});

test('cache keys are stable without stripping unit or directional information', () => {
  assert.equal(addressCacheKey('100 N Main St, Unit 4, SC'), '100 n main st, unit 4, sc');
});
