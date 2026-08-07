import { timingSafeEqual } from 'node:crypto';

import { processReportJob, validateReportMarkdown } from './lib/report-background.js';
import { runReportFusion } from './lib/report-fusion.js';
import { createReportFusionAdapters } from './lib/report-fusion-adapters.js';

// The Crawlee scraper pulls in a large dependency tree (cheerio crawler, PDF /
// DOCX / XLSX parsers). It is imported LAZILY inside the handler — a failure at
// import time must surface as a caught, reportable error, never as a silent
// cold-start crash that leaves the job stuck in `queued`.
let cachedCrawlSources = null;
async function loadCrawlSources() {
  if (!cachedCrawlSources) {
    const mod = await import('./lib/crawlee-scraper.js');
    cachedCrawlSources = mod.crawlSources;
  }
  return cachedCrawlSources;
}


const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for background reports.`);
  return value;
}

function safeSecretMatch(received, expected) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = payload?.message || payload?.msg || payload?.error || text || `HTTP ${response.status}`;
    throw new Error(`${label}: ${detail}`);
  }
  return payload;
}

function serviceHeaders(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

export function normalizeStoredFusionKeys(stored = {}) {
  return {
    gemini: stored.gemini || '',
    deepSeek: stored.deepSeek || '',
    openRouter: stored.openRouter || '',
    perplexity: stored.perplexity || '',
    monid: stored.monid || '',
  };
}

async function authenticate(supabaseUrl, anonKey, token) {
  if (!token) throw new Error('Missing authenticated Supabase session.');
  return fetchJson(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  }, 'Could not authenticate the report worker request');
}

async function loadVerifiedAuthEmail(supabaseUrl, serviceRoleKey, userId) {
  const user = await fetchJson(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: serviceHeaders(serviceRoleKey),
  }, 'Could not load the authenticated account');
  if (!user?.email || !user?.email_confirmed_at) {
    throw new Error('The authenticated account has no verified email address.');
  }
  return user.email;
}

async function supabaseRequest(supabaseUrl, serviceRoleKey, path, init = {}) {
  return fetchJson(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders(serviceRoleKey, {
      'content-type': 'application/json',
      ...(init.headers || {}),
    }),
  }, 'Supabase report worker request failed');
}

async function sendCompletionEmail({ to, address, jobId, reportId, markdown }) {
  const apiKey = requiredEnv('RESEND_API_KEY');
  const from = requiredEnv('RESEND_FROM_EMAIL');
  const appUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  const reportUrl = appUrl ? `${appUrl}/?report=${encodeURIComponent(reportId)}` : '';
  const fullReport = String(markdown || '').trim() || 'The report text is unavailable.';
  await fetchJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'Idempotency-Key': `report-job-${jobId}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Feasibility report ready: ${address || 'your property'}`,
      text: `Your feasibility report is complete.\n\n${reportUrl ? `Open it: ${reportUrl}\n\n` : ''}${fullReport}`,
    }),
  }, 'Completion email failed');
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const supabaseUrl = requiredEnv('VITE_SUPABASE_URL').replace(/\/$/, '');
  const anonKey = requiredEnv('VITE_SUPABASE_ANON_KEY');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const workerSecret = requiredEnv('REPORT_WORKER_SECRET');
  const suppliedWorkerSecret = event.headers?.['x-report-worker-secret'] || event.headers?.['X-Report-Worker-Secret'];
  const trustedWorker = safeSecretMatch(suppliedWorkerSecret, workerSecret);

  let authenticatedUser = null;
  if (!trustedWorker) {
    const authorization = event.headers?.authorization || event.headers?.Authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    authenticatedUser = await authenticate(supabaseUrl, anonKey, token);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
  const jobId = String(body.jobId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(jobId)) return json(400, { error: 'A valid jobId is required' });

  const loadJob = async (id) => {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `report_jobs?id=eq.${encodeURIComponent(id)}&select=*`,
    );
    return rows?.[0] || null;
  };

  const updateJob = async (id, patch) => {
    await supabaseRequest(supabaseUrl, serviceRoleKey, `report_jobs?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  };

  const failJob = async (id, patch) => {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `report_jobs?id=eq.${encodeURIComponent(id)}&status=eq.running&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      },
    );
    return rows?.length === 1;
  };

  const claimJob = async (id, runningPatch) => {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `report_jobs?id=eq.${encodeURIComponent(id)}&status=eq.queued&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(runningPatch),
      },
    );
    return rows?.length === 1;
  };

  const loadProfile = async (userId) => {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `profiles?user_id=eq.${encodeURIComponent(userId)}&select=keys`,
    );
    const row = rows?.[0] || {};
    const stored = row.keys || {};
    return { keys: normalizeStoredFusionKeys(stored) };
  };

  const completeJob = async (job, reportMarkdown) => {
    const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, 'rpc/complete_report_job', {
      method: 'POST',
      body: JSON.stringify({ p_job_id: job.id, p_report_markdown: reportMarkdown }),
    });
    const saved = Array.isArray(rows) ? rows[0] : rows;
    if (!saved?.id) throw new Error('The report completion transaction returned no saved report.');
    return saved;
  };

  const loadSavedReport = async (id) => {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `saved_reports?id=eq.${encodeURIComponent(id)}&select=id,report_markdown`,
    );
    return rows?.[0] || null;
  };

  // Marks the job failed ONLY if it is still active (queued/running) — so this
  // safety net never overwrites a more specific failure message that
  // processReportJob already recorded.
  const failActiveJob = async (message) => {
    await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `report_jobs?id=eq.${encodeURIComponent(jobId)}&status=in.(queued,running)&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: message.slice(0, 900),
        }),
      },
    ).catch(() => {});
  };

  let adapters;
  try {
    const crawlSources = await loadCrawlSources();
    adapters = createReportFusionAdapters({ crawlSources });
  } catch (error) {
    // Heavy dependency chain failed to load. Never die silently: mark the job
    // failed with the real reason so the user's queue slot is freed.
    await failActiveJob(`The report worker failed to start: ${String(error?.message || error)}`);
    return json(502, { ok: false, error: 'The report worker failed to start. Please try again.' });
  }

  try {
    const result = await processReportJob(jobId, authenticatedUser?.id || null, {
      trustedWorker,
      loadJob,
      claimJob,
      updateJob,
      failJob,
      loadProfile,
      loadVerifiedEmail: async (userId) => {
        if (authenticatedUser?.id === userId && authenticatedUser.email && authenticatedUser.email_confirmed_at) {
          return authenticatedUser.email;
        }
        return loadVerifiedAuthEmail(supabaseUrl, serviceRoleKey, userId);
      },
      loadSavedReport,
      generateReport: async (prompt, credentials, input) => {
        const fusion = await runReportFusion(prompt, input, credentials, adapters);
        return validateReportMarkdown(fusion.markdown).markdown;
      },
      completeJob,
      sendEmail: sendCompletionEmail,
    });
    return json(200, { ok: true, ...result });
  } catch (error) {
    // processReportJob already marks the job failed before re-throwing, but if
    // something unexpected slipped through, make the failure visible instead of
    // leaving the job wedged with no diagnostics.
    await failActiveJob(`The report worker crashed: ${String(error?.message || error)}`);
    return json(502, { ok: false, error: String(error?.message || 'The report worker failed.').slice(0, 300) });
  }
}
