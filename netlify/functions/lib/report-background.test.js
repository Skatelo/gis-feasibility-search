import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBackgroundReportPrompt,
  processReportJob,
} from './report-background.js';

const input = {
  reportData: {
    inputAddress: '123 Main St, Raleigh, NC 27601',
    countyName: 'Wake',
    parcelId: 'PIN-123',
    gisAcres: 2.5,
    zoningCode: 'R-4',
    ownerName: 'Ada Lovelace',
    coordinates: { lat: 35.77, lng: -78.64 },
    floodZone: { status: 'mapped', zone: 'X', inSFHA: false, sourceUrl: 'https://fema.example' },
    wetlands: { status: 'none-at-point', sourceUrl: 'https://nwi.example' },
    comps: [{ address: '125 Main St', price: 410000, saleDate: '2026-06-01', distanceMiles: 1.2 }],
  },
  costEstimate: {
    plannedSqft: 1600,
    totalCost: 250000,
    costPerSqft: 156,
  },
};

const fusionKeys = {
  gemini: 'gemini-key',
  deepSeek: 'deepseek-key',
  openRouter: '',
  perplexity: 'perplexity-key',
  monid: 'monid-key',
};

test('background prompt carries the parcel evidence and all required report sections', () => {
  const prompt = buildBackgroundReportPrompt(input);
  assert.match(prompt, /123 Main St, Raleigh, NC 27601/);
  assert.match(prompt, /PIN-123/);
  assert.match(prompt, /R-4/);
  assert.match(prompt, /250000/);
  assert.match(prompt, /# 1\. Executive Summary/);
  assert.match(prompt, /# 25\. Final Investment Recommendation/);
  assert.match(prompt, /PROVIDED DATA PACKET/);
  assert.match(prompt, /Do not invent/i);
  assert.match(prompt, /server-side fusion research packet/i);
  assert.doesNotMatch(prompt, /use live Google Search/i);
});

test('background job passes the complete fusion credential set to its generator', async () => {
  let receivedCredentials;
  const keys = {
    gemini: 'gemini-key',
    deepSeek: 'deepseek-key',
    openRouter: 'openrouter-key',
    perplexity: 'perplexity-key',
    monid: 'monid-key',
  };
  await processReportJob('job-1', 'user-1', {
    loadJob: async () => ({ id: 'job-1', user_id: 'user-1', input_json: input }),
    loadProfile: async () => ({ email: 'ada@example.com', keys }),
    updateJob: async () => {},
    generateReport: async (_prompt, credentials) => {
      receivedCredentials = credentials;
      return '# Complete fused report';
    },
    saveReport: async () => ({ id: 'report-1' }),
    sendEmail: async () => {},
  });

  assert.deepEqual(receivedCredentials, keys);
});

test('completed job saves the report, optionally emails the account, and records completion', async () => {
  const calls = [];
  const deps = {
    loadJob: async () => ({
      id: 'job-1',
      user_id: 'user-1',
      address: input.reportData.inputAddress,
      county: 'Wake',
      parcel_id: 'PIN-123',
      acres: 2.5,
      zoning_code: 'R-4',
      owner_name: 'Ada Lovelace',
      email_when_done: true,
      input_json: input,
    }),
    loadProfile: async () => ({ email: 'ada@example.com', keys: fusionKeys }),
    updateJob: async (_id, patch) => calls.push(['update', patch]),
    generateReport: async (prompt, key) => {
      calls.push(['generate', key, prompt]);
      return '# 1. Executive Summary\nComplete report';
    },
    saveReport: async (_job, markdown) => {
      calls.push(['save', markdown]);
      return { id: 'report-1' };
    },
    sendEmail: async (message) => calls.push(['email', message]),
    now: () => '2026-08-05T12:00:00.000Z',
  };

  const result = await processReportJob('job-1', 'user-1', deps);

  assert.deepEqual(result, { reportId: 'report-1', emailed: true });
  assert.equal(calls.filter(([name]) => name === 'generate').length, 1);
  assert.equal(calls.filter(([name]) => name === 'save').length, 1);
  assert.equal(calls.filter(([name]) => name === 'email').length, 1);
  assert.deepEqual(calls.at(-1), ['update', {
    status: 'completed',
    saved_report_id: 'report-1',
    completed_at: '2026-08-05T12:00:00.000Z',
    error_message: null,
  }]);
  assert.equal(calls.find(([name]) => name === 'email')[1].to, 'ada@example.com');
});

test('job cannot be processed for a different authenticated user', async () => {
  const updates = [];
  await assert.rejects(
    processReportJob('job-1', 'attacker', {
      loadJob: async () => ({ id: 'job-1', user_id: 'owner', input_json: input }),
      loadProfile: async () => ({ email: 'owner@example.com', keys: { gemini: 'secret' } }),
      updateJob: async (_id, patch) => updates.push(patch),
      generateReport: async () => 'should not run',
      saveReport: async () => ({ id: 'never' }),
      sendEmail: async () => {},
    }),
    /does not belong/i,
  );
  assert.equal(updates.length, 0);
});

test('a repeated invocation reuses an already completed job instead of creating a duplicate report', async () => {
  let generated = false;
  const result = await processReportJob('job-1', 'user-1', {
    loadJob: async () => ({ id: 'job-1', user_id: 'user-1', status: 'completed', saved_report_id: 'report-1', input_json: input }),
    loadProfile: async () => { throw new Error('should not load profile'); },
    updateJob: async () => { throw new Error('should not update'); },
    generateReport: async () => { generated = true; return 'duplicate'; },
    saveReport: async () => ({ id: 'duplicate' }),
    sendEmail: async () => {},
  });
  assert.deepEqual(result, { reportId: 'report-1', emailed: false });
  assert.equal(generated, false);
});

test('a concurrent invocation that loses the atomic claim does not generate or fail the active job', async () => {
  let generated = false;
  let reads = 0;
  const result = await processReportJob('job-1', 'user-1', {
    loadJob: async () => {
      reads += 1;
      return reads === 1
        ? { id: 'job-1', user_id: 'user-1', status: 'queued', input_json: input }
        : { id: 'job-1', user_id: 'user-1', status: 'running', input_json: input };
    },
    claimJob: async () => false,
    loadProfile: async () => { throw new Error('should not load profile'); },
    updateJob: async () => { throw new Error('should not update'); },
    generateReport: async () => { generated = true; return 'duplicate'; },
    saveReport: async () => ({ id: 'duplicate' }),
    sendEmail: async () => {},
  });
  assert.deepEqual(result, { status: 'running', alreadyProcessing: true });
  assert.equal(generated, false);
});

test('missing fusion credentials marks the accepted job failed instead of leaving it queued', async () => {
  const updates = [];
  await assert.rejects(
    processReportJob('job-1', 'user-1', {
      loadJob: async () => ({ id: 'job-1', user_id: 'user-1', input_json: input }),
      loadProfile: async () => ({ email: 'ada@example.com', keys: {} }),
      updateJob: async (_id, patch) => updates.push(patch),
      generateReport: async () => 'never',
      saveReport: async () => ({ id: 'never' }),
      sendEmail: async () => {},
      now: () => '2026-08-05T12:00:00.000Z',
    }),
    /Background fusion requires API credentials for: Gemini, DeepSeek or OpenRouter, Perplexity Search, Monid/,
  );
  assert.equal(updates[0].status, 'running');
  assert.equal(updates.at(-1).status, 'failed');
});

test('generation failure marks the job failed and never sends email', async () => {
  const updates = [];
  let emailed = false;
  await assert.rejects(
    processReportJob('job-1', 'user-1', {
      loadJob: async () => ({ id: 'job-1', user_id: 'user-1', email_when_done: true, input_json: input }),
      loadProfile: async () => ({ email: 'ada@example.com', keys: fusionKeys }),
      updateJob: async (_id, patch) => updates.push(patch),
      generateReport: async () => { throw new Error('model quota exceeded'); },
      saveReport: async () => ({ id: 'never' }),
      sendEmail: async () => { emailed = true; },
      now: () => '2026-08-05T12:00:00.000Z',
    }),
    /model quota exceeded/,
  );

  assert.equal(emailed, false);
  assert.equal(updates[0].status, 'running');
  assert.deepEqual(updates.at(-1), {
    status: 'failed',
    error_message: 'model quota exceeded',
    completed_at: '2026-08-05T12:00:00.000Z',
  });
});
