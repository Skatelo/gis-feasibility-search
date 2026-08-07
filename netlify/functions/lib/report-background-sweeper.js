const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for the report queue sweeper.`);
  return value;
}

/** A job stuck in `running` for longer than this was interrupted — requeue it. */
const RUNNING_STALE_MS = 20 * 60 * 1000;
/** A job stuck in `queued` for longer than this never got picked up — expire it
 *  so it cannot block the user's single active-report slot forever. */
const QUEUED_STALE_MS = 45 * 60 * 1000;

async function supabaseRequest(fetchImpl, supabaseUrl, serviceRoleKey, path, init = {}) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Queue sweep failed with HTTP ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * One pass of queue self-healing:
 *   1. requeue jobs stuck in `running` (worker died mid-report),
 *   2. FAIL jobs stuck in `queued` — they were never picked up, and leaving them
 *      there blocks the user's one-active-job slot forever,
 *   3. dispatch everything legitimately queued to the background worker.
 * Every dependency is injected so the logic is unit-testable without network.
 */
export async function sweepReportQueue({
  fetchImpl = globalThis.fetch,
  supabaseUrl,
  serviceRoleKey,
  workerSecret,
  siteUrl,
  now = Date.now,
}) {
  const base = supabaseUrl.replace(/\/$/, '');
  const nowMs = now();

  // 1. Recover interrupted workers.
  const runningStaleBefore = new Date(nowMs - RUNNING_STALE_MS).toISOString();
  await supabaseRequest(
    fetchImpl,
    base,
    serviceRoleKey,
    `report_jobs?status=eq.running&started_at=lt.${encodeURIComponent(runningStaleBefore)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'queued', started_at: null, error_message: 'Recovered after an interrupted worker invocation.' }),
    },
  );

  // 2. Expire abandoned queued jobs (frees the per-user active slot).
  const queuedStaleBefore = new Date(nowMs - QUEUED_STALE_MS).toISOString();
  const staleQueued = await supabaseRequest(
    fetchImpl,
    base,
    serviceRoleKey,
    `report_jobs?status=eq.queued&created_at=lt.${encodeURIComponent(queuedStaleBefore)}&select=id,user_id`,
  );
  let expiredQueued = 0;
  if (Array.isArray(staleQueued) && staleQueued.length) {
    const ids = staleQueued.map((job) => job.id);
    await supabaseRequest(
      fetchImpl,
      base,
      serviceRoleKey,
      `report_jobs?id=in.(${ids.join(',')})`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          completed_at: new Date(nowMs).toISOString(),
          error_message: 'The report was not picked up in time and expired. Please try again.',
        }),
      },
    );
    expiredQueued = ids.length;
  }

  // 3. Dispatch the live queue.
  const jobs = await supabaseRequest(
    fetchImpl,
    base,
    serviceRoleKey,
    'report_jobs?status=eq.queued&select=id&order=created_at.asc&limit=10',
  );
  let dispatched = 0;
  for (const job of jobs || []) {
    try {
      const response = await fetchImpl(`${siteUrl}/.netlify/functions/report-background-background`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-report-worker-secret': workerSecret,
        },
        body: JSON.stringify({ jobId: job.id }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) dispatched += 1;
    } catch {
      // One dead dispatch must not stop the rest of the queue.
    }
  }

  return { recoveredRunning: true, expiredQueued, queuedFound: jobs?.length || 0, dispatched };
}

export async function handler() {
  const supabaseUrl = requiredEnv('VITE_SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const workerSecret = requiredEnv('REPORT_WORKER_SECRET');
  const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  if (!siteUrl) throw new Error('URL or DEPLOY_PRIME_URL is required for the report queue sweeper.');

  try {
    const result = await sweepReportQueue({ supabaseUrl, serviceRoleKey, workerSecret, siteUrl });
    return json(200, {
      queued: result.queuedFound,
      dispatched: result.dispatched,
      expiredQueued: result.expiredQueued,
    });
  } catch (error) {
    return json(500, { error: String(error?.message || error).slice(0, 300) });
  }
}
