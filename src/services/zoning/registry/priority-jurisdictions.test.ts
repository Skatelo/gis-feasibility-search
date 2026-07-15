import test from 'node:test';
import assert from 'node:assert/strict';
import { ZONING_ROLLOUT_COUNTIES } from './priority-jurisdictions';

test('rollout manifest includes every South Carolina county exactly once', () => {
  const southCarolina = ZONING_ROLLOUT_COUNTIES.filter((entry) => entry.stateCode === 'SC');
  assert.equal(southCarolina.length, 46);
  assert.equal(new Set(southCarolina.map((entry) => entry.county)).size, 46);
});

test('phase-one manifest contains the requested twelve NC and ten SC priority counties', () => {
  assert.equal(ZONING_ROLLOUT_COUNTIES.filter((entry) => entry.stateCode === 'NC' && entry.priority === 1).length, 12);
  assert.equal(ZONING_ROLLOUT_COUNTIES.filter((entry) => entry.stateCode === 'SC' && entry.priority === 1).length, 10);
});
