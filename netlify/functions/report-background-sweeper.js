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

async function supabaseRequest(url, serviceRoleKey, path, init = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
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

export async function handler() {
  const supabaseUrl = requiredEnv('VITE_SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const workerSecret = requiredEnv('REPORT_WORKER_SECRET');
  const siteUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  if (!siteUrl) throw new Error('URL or DEPLOY_PRIME_URL is required for the report queue sweeper.');

  const staleBefore = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `report_jobs?status=eq.running&started_at=lt.${encodeURIComponent(staleBefore)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'queued', started_at: null, error_message: 'Recovered after an interrupted worker invocation.' }),
    },
  );

  const jobs = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    'report_jobs?status=eq.queued&select=id&order=created_at.asc&limit=10',
  );
  let dispatched = 0;
  for (const job of jobs || []) {
    const response = await fetch(`${siteUrl}/.netlify/functions/report-background-background`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-report-worker-secret': workerSecret,
      },
      body: JSON.stringify({ jobId: job.id }),
    });
    if (response.ok) dispatched += 1;
  }

  return json(200, { queued: jobs?.length || 0, dispatched });
}
