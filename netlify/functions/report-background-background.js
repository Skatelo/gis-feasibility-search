import { processReportJob } from './lib/report-background.js';
import { runReportFusion } from './lib/report-fusion.js';
import { createReportFusionAdapters } from './lib/report-fusion-adapters.js';
import { crawlSources } from './lib/crawlee-scraper.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const fusionAdapters = createReportFusionAdapters({ fetchImpl: globalThis.fetch, crawlSources });

function requiredEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value.replace(/\/$/, '');
  }
  throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
}

function bearerToken(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() || '';
}

async function responseJson(response, label) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = body?.message || body?.error?.message || body?.error || text || `HTTP ${response.status}`;
    throw new Error(`${label}: ${String(detail).slice(0, 800)}`);
  }
  return body;
}

function supabaseHeaders(anonKey, token, extra = {}) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function reportEmailText({ address, markdown, appUrl }) {
  return `Your land feasibility report for ${address || 'your property'} is complete.\n\n${markdown}\n\nA saved copy is available in My Reports: ${appUrl}`;
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ error: 'POST only' }) };
    }

    const token = bearerToken(event.headers);
    if (!token) throw new Error('A signed-in Supabase session is required.');
    const body = JSON.parse(event.body || '{}');
    const jobId = String(body.jobId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('A valid report job id is required.');

    const supabaseUrl = requiredEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
    const anonKey = requiredEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
    const authHeaders = supabaseHeaders(anonKey, token);

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: authHeaders });
    const authUser = await responseJson(authResponse, 'Could not authenticate report worker');
    if (!authUser?.id) throw new Error('The report worker could not identify the signed-in user.');

    const rest = async (path, options = {}, label = 'Supabase request failed') => {
      const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...options,
        headers: {
          ...authHeaders,
          ...(options.headers || {}),
        },
      });
      return responseJson(response, label);
    };

    const deps = {
      loadJob: async (id) => {
        const rows = await rest(`report_jobs?id=eq.${encodeURIComponent(id)}&select=*`, {}, 'Could not load report job');
        return rows?.[0] || null;
      },
      loadProfile: async (userId) => {
        const rows = await rest(`profiles?user_id=eq.${encodeURIComponent(userId)}&select=email,keys`, {}, 'Could not load report credentials');
        const profile = rows?.[0] || { email: authUser.email, keys: {} };
        const stored = profile.keys && typeof profile.keys === 'object' ? profile.keys : {};
        return {
          ...profile,
          email: profile.email || authUser.email,
          keys: {
            ...stored,
            gemini: stored.gemini || process.env.REPORT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
            deepSeek: stored.deepSeek || process.env.DEEPSEEK_API_KEY || '',
            openRouter: stored.openRouter || process.env.OPENROUTER_API_KEY || '',
            perplexity: stored.perplexity || process.env.PERPLEXITY_API_KEY || '',
            monid: stored.monid || process.env.MONID_API_KEY || '',
          },
        };
      },
      updateJob: async (id, patch) => rest(
        `report_jobs?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        },
        'Could not update report job',
      ),
      claimJob: async (id, patch) => {
        const rows = await rest(
          `report_jobs?id=eq.${encodeURIComponent(id)}&status=eq.queued&select=id,status`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify(patch),
          },
          'Could not claim report job',
        );
        return Array.isArray(rows) && rows.length === 1;
      },
      generateReport: async (prompt, credentials, input) => {
        const fused = await runReportFusion(prompt, input, credentials, fusionAdapters);
        console.info('Background fusion provider coverage:', fused.providers, 'sources:', fused.sourceCount);
        if (Object.values(fused.diagnostics.errors).some(Boolean)) {
          console.warn('Background fusion provider degradation:', fused.diagnostics.errors);
        }
        return fused.markdown;
      },
      saveReport: async (job, markdown) => {
        const rows = await rest('saved_reports?select=id', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            user_id: authUser.id,
            address: job.address,
            county: job.county,
            parcel_id: job.parcel_id,
            acres: job.acres,
            zoning_code: job.zoning_code,
            owner_name: job.owner_name,
            report_markdown: markdown,
          }),
        }, 'Could not save completed report');
        if (!rows?.[0]?.id) throw new Error('Supabase did not return the saved report id.');
        return rows[0];
      },
      sendEmail: async ({ to, address, markdown }) => {
        const resendKey = requiredEnv('RESEND_API_KEY');
        const from = requiredEnv('REPORT_FROM_EMAIL');
        const appUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://gis-feasibility-search.netlify.app').replace(/\/$/, '');
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [to || authUser.email],
            subject: `Your feasibility report is ready — ${address || 'property report'}`,
            text: reportEmailText({ address, markdown, appUrl }),
          }),
        });
        await responseJson(response, 'Report email delivery failed');
      },
    };

    const result = await processReportJob(jobId, authUser.id, deps);
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Background report worker failed:', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: String(error?.message || error).slice(0, 1000) }),
    };
  }
};
