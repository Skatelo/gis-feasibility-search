import type { ConstructionCostEstimate, SiteFeasibilityData } from '../types/feasibility';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { fetchWithTimeout, withTimeout } from './asyncTimeout';

export type ReportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface BackgroundReportJob {
  id: string;
  status: ReportJobStatus;
  emailWhenDone: boolean;
  address: string;
  county: string;
  parcelId: string;
  savedReportId?: string;
  errorMessage?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface BackgroundReportInput {
  reportData: SiteFeasibilityData;
  costEstimate?: ConstructionCostEstimate;
}

export interface ReportExecutionPreferences {
  mode: 'foreground' | 'background';
  emailWhenDone: boolean;
}

const EXECUTION_PREFS_KEY = 'gis_report_execution_preferences';

export function getReportExecutionPreferences(): ReportExecutionPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(EXECUTION_PREFS_KEY) || '{}');
    return {
      mode: stored.mode === 'background' ? 'background' : 'foreground',
      emailWhenDone: !!stored.emailWhenDone,
    };
  } catch {
    return { mode: 'foreground', emailWhenDone: false };
  }
}

export function setReportExecutionPreferences(preferences: ReportExecutionPreferences): void {
  try { localStorage.setItem(EXECUTION_PREFS_KEY, JSON.stringify(preferences)); } catch { /* ignore */ }
}

function activeUserId(): string {
  try {
    const raw = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    return raw ? String(JSON.parse(raw)?.userId || '') : '';
  } catch {
    return '';
  }
}

export function canRunReportsInBackground(): boolean {
  return isSupabaseConfigured() && !!activeUserId();
}

function epoch(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapJob(row: Record<string, unknown>): BackgroundReportJob {
  return {
    id: String(row.id),
    status: row.status as ReportJobStatus,
    emailWhenDone: !!row.email_when_done,
    address: String(row.address || ''),
    county: String(row.county || ''),
    parcelId: String(row.parcel_id || ''),
    savedReportId: typeof row.saved_report_id === 'string' ? row.saved_report_id : undefined,
    errorMessage: typeof row.error_message === 'string' ? row.error_message : undefined,
    createdAt: epoch(row.created_at) || Date.now(),
    startedAt: epoch(row.started_at),
    completedAt: epoch(row.completed_at),
  };
}

export async function listBackgroundReportJobs(): Promise<BackgroundReportJob[]> {
  if (!canRunReportsInBackground()) return [];
  // Fail fast (mobile: flaky networks must not pin the drawer's spinner).
  const { data, error } = await withTimeout(
    getSupabase()
      .from('report_jobs')
      .select('id, status, email_when_done, address, county, parcel_id, saved_report_id, error_message, created_at, started_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(25),
    12000,
    'Timed out loading background reports. Check your connection.',
  );
  if (error) throw new Error(`Could not load background reports: ${error.message}`);
  return (data || []).map(mapJob);
}

export async function enqueueBackgroundReport(
  input: BackgroundReportInput,
  emailWhenDone: boolean,
): Promise<BackgroundReportJob> {
  if (!canRunReportsInBackground()) {
    throw new Error('Background reports require a signed-in Supabase account. Connect Supabase and sign in first.');
  }

  const supabase = getSupabase();
  // getSession() can perform a network token refresh; cap it so a dead mobile
  // connection fails fast instead of leaving the button stuck on "Queuing...".
  const { data: sessionData, error: sessionError } = await withTimeout(
    supabase.auth.getSession(),
    8000,
    'Timed out checking your session. Check your connection.',
  );
  const session = sessionData.session;
  if (sessionError || !session?.access_token || !session.user?.id) {
    throw new Error('Your cloud session expired. Please sign in again before starting a background report.');
  }

  const reportData = input.reportData;
  // Fail fast if the queue insert hangs on a flaky connection — a 15s stall is
  // enough to make the mobile UI look broken.
  const { data: row, error } = await withTimeout(
    supabase
      .from('report_jobs')
      .insert({
        user_id: session.user.id,
        status: 'queued',
        email_when_done: emailWhenDone,
        address: reportData.inputAddress,
        county: reportData.countyName,
        parcel_id: reportData.parcelId,
        acres: reportData.gisAcres,
        zoning_code: reportData.zoningCode,
        owner_name: reportData.ownerName,
        input_json: input,
      })
      .select('id, status, email_when_done, address, county, parcel_id, saved_report_id, error_message, created_at, started_at, completed_at')
      .single(),
    15000,
    'Timed out queueing the background report. Check your connection and try again.',
  );
  if (error || !row) throw new Error(`Could not queue the background report: ${error?.message || 'no job was created'}`);

  // The job is durably queued; the sweeper will retry it even if this immediate
  // dispatch is slow or fails. Fire it WITHOUT awaiting so a slow mobile network
  // can never leave the UI stuck on "Queuing...". 8s abort cap.
  void dispatchBackgroundJob(row.id, session.access_token)
    .catch((dispatchError: unknown) => {
      console.warn('Immediate background dispatch was unavailable; the durable queue sweeper will retry.', dispatchError);
    });

  window.dispatchEvent(new CustomEvent('gis-report-jobs-updated'));
  return mapJob(row);
}

async function dispatchBackgroundJob(jobId: string, accessToken: string): Promise<void> {
  const response = await fetchWithTimeout('/.netlify/functions/report-background-background', 8000, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jobId }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${response.status}`);
  }
}
