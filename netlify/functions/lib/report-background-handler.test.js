import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeStoredFusionKeys } from '../report-background-background.js';

test('background handler reads the provider key names written by Account Settings', () => {
  assert.deepEqual(normalizeStoredFusionKeys({
    gemini: 'gem',
    deepSeek: 'deep',
    openRouter: 'router',
    perplexity: 'pplx',
    monid: 'monid',
  }), {
    gemini: 'gem',
    deepSeek: 'deep',
    openRouter: 'router',
    perplexity: 'pplx',
    monid: 'monid',
  });
});
