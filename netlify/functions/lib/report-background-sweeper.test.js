import assert from 'node:assert/strict';
import test from 'node:test';

import { sweepReportQueue } from './report-background-sweeper.js';

function fakeFetch(plan) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, response] of plan) {
      if (String(url).includes(match)) {
        return {
          ok: true,
          status: 200,
          async json() { return response; },
          async text() { return JSON.stringify(response); },
        };
      }
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}

test('the sweeper recovers stale running jobs, expires stale queued jobs, and dispatches the live queue', async () => {
  const { calls, fetchImpl } = fakeFetch([
    // 1. recover stale running -> PATCH returns minimal
    ['status=eq.running&started_at=lt.', null],
    // 2. find stale queued -> two dead jobs
    ['status=eq.queued&created_at=lt.', [
      { id: 'job-dead-1', created_at: '2026-08-06T00:00:00Z', user_id: 'u1' },
      { id: 'job-dead-2', created_at: '2026-08-06T00:05:00Z', user_id: 'u2' },
    ]],
    // 3. fail the stale queued ones -> PATCH minimal
    ['id=in.(job-dead-1,job-dead-2)', null],
    // 4. dispatch queue -> one fresh job
    ['status=eq.queued&select=id&order=created_at.asc', [{ id: 'job-fresh' }]],
    // 5. the worker dispatch
    ['report-background-background', null],
  ]);

  const result = await sweepReportQueue({
    fetchImpl,
    supabaseUrl: 'https://db.example.supabase.co',
    serviceRoleKey: 'service-key',
    workerSecret: 'secret-123',
    siteUrl: 'https://app.example.netlify.app',
    now: () => new Date('2026-08-06T12:00:00Z').getTime(),
  });

  assert.deepEqual(result, { recoveredRunning: true, expiredQueued: 2, queuedFound: 1, dispatched: 1 });

  // Running jobs older than 20 minutes were requeued.
  const recover = calls.find((c) => c.url.includes('status=eq.running&started_at=lt.'));
  assert.ok(recover, 'sweeper must requeue stale running jobs');
  assert.ok(recover.url.includes('2026-08-06T11%3A40'), 'running jobs are stale after 20 minutes');
  assert.equal(JSON.parse(recover.init.body).status, 'queued');

  // Queued jobs older than 45 minutes are failed (frees the per-user slot).
  const staleQueued = calls.find((c) => c.url.includes('status=eq.queued&created_at=lt.'));
  assert.ok(staleQueued.url.includes('2026-08-06T11%3A15'), 'queued jobs are stale after 45 minutes');
  const failPatch = calls.find((c) => c.url.includes('id=in.(job-dead-1,job-dead-2)'));
  assert.ok(failPatch, 'sweeper must mark stale queued jobs failed');
  const failedBody = JSON.parse(failPatch.init.body);
  assert.equal(failedBody.status, 'failed');
  assert.match(failedBody.error_message, /expired|not picked up|retry/i);

  // The fresh job was dispatched to the worker with the secret header.
  const dispatch = calls.find((c) => c.url.includes('report-background-background'));
  assert.equal(dispatch.init.method, 'POST');
  assert.equal(dispatch.init.headers['x-report-worker-secret'], 'secret-123');
  assert.deepEqual(JSON.parse(dispatch.init.body), { jobId: 'job-fresh' });
});

test('the sweeper tolerates an empty queue and worker failures without throwing', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('report-background-background')) {
      return { ok: false, status: 502, async json() { return { error: 'boom' }; }, async text() { return 'boom'; } };
    }
    const list = String(url).includes('select=id&order=created_at.asc')
      ? [{ id: 'job-a' }, { id: 'job-b' }]
      : String(url).includes('created_at=lt.') ? [] : null;
    return { ok: true, status: 200, async json() { return list; }, async text() { return JSON.stringify(list); } };
  };

  const result = await sweepReportQueue({
    fetchImpl,
    supabaseUrl: 'https://db.example.supabase.co',
    serviceRoleKey: 'service-key',
    workerSecret: 'secret-123',
    siteUrl: 'https://app.example.netlify.app',
  });

  assert.equal(result.queuedFound, 2);
  assert.equal(result.dispatched, 0, 'failed dispatches do not count as dispatched');
  assert.equal(result.expiredQueued, 0);
});

test('the handler reads configuration from environment variables', async () => {
  const { handler } = await import('./report-background-sweeper.js');
  const original = { ...process.env };
  try {
    process.env.VITE_SUPABASE_URL = 'https://db.example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    process.env.REPORT_WORKER_SECRET = 'secret-123';
    process.env.URL = 'https://app.example.netlify.app';
    // The handler uses global fetch; point it at a sink that records calls.
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(String(url));
      const list = String(url).includes('select=id&order=created_at.asc')
        ? [] : String(url).includes('created_at=lt.') ? [] : null;
      return { ok: true, status: 200, async json() { return list; }, async text() { return JSON.stringify(list); } };
    };
    const res = await handler();
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"queued":0/);
    assert.ok(seen.some((u) => u.startsWith('https://db.example.supabase.co/rest/v1/')), 'uses the configured Supabase URL');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    delete globalThis.fetch;
  }
});
