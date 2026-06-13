// ---------------------------------------------------------------------------
// Saved Reports store + report-generation time estimator.
//
// When Supabase is configured (see SETUP_SUPABASE.md), reports are stored in
// the cloud per account (saved_reports table, RLS-protected) and sync across
// devices. Otherwise they fall back to per-account localStorage.
// ---------------------------------------------------------------------------
import { getSupabase, isSupabaseConfigured } from './supabaseClient';

export interface SavedReport {
  id: string;
  email: string;
  savedAt: number; // epoch ms
  address: string;
  county: string;
  parcelId: string;
  acres?: number;
  zoningCode?: string;
  ownerName?: string;
  /** The full markdown body of the AI feasibility report. */
  reportMarkdown: string;
}

export type NewReport = Omit<SavedReport, 'id' | 'email' | 'savedAt'>;

const REPORTS_KEY = 'gis_saved_reports';

function activeSession(): { email: string; userId?: string } {
  try {
    const userStr = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    if (userStr) {
      const u = JSON.parse(userStr);
      return { email: (u.email || '').toLowerCase(), userId: u.userId };
    }
  } catch { /* ignore */ }
  return { email: '' };
}

function useCloud(): boolean {
  return isSupabaseConfigured() && !!activeSession().userId;
}

// --- local fallback helpers -------------------------------------------------

function readAllLocal(): SavedReport[] {
  try {
    const raw = localStorage.getItem(REPORTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAllLocal(reports: SavedReport[]): void {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
  } catch (e) {
    console.error('Failed to persist saved reports:', e);
  }
}

// --- public API ---------------------------------------------------------------

/** Reports belonging to the signed-in account, newest first. */
export async function listSavedReports(): Promise<SavedReport[]> {
  if (useCloud()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reports')
      .select('id, address, county, parcel_id, acres, zoning_code, owner_name, report_markdown, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Could not load your reports: ${error.message}`);
    const email = activeSession().email;
    return (data || []).map((r: any) => ({
      id: String(r.id),
      email,
      savedAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      address: r.address,
      county: r.county || '',
      parcelId: r.parcel_id || '',
      acres: r.acres ?? undefined,
      zoningCode: r.zoning_code ?? undefined,
      ownerName: r.owner_name ?? undefined,
      reportMarkdown: r.report_markdown,
    }));
  }
  const email = activeSession().email;
  return readAllLocal()
    .filter((r) => (r.email || '').toLowerCase() === email)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveReport(report: NewReport): Promise<SavedReport> {
  const session = activeSession();
  if (useCloud()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reports')
      .insert({
        user_id: session.userId,
        address: report.address,
        county: report.county,
        parcel_id: report.parcelId,
        acres: report.acres ?? null,
        zoning_code: report.zoningCode ?? null,
        owner_name: report.ownerName ?? null,
        report_markdown: report.reportMarkdown,
      })
      .select('id, created_at')
      .single();
    if (error) throw new Error(`Could not save the report to your account: ${error.message}`);
    return {
      ...report,
      id: String(data.id),
      email: session.email,
      savedAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
    };
  }
  const entry: SavedReport = {
    ...report,
    id: `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email: session.email,
    savedAt: Date.now(),
  };
  const all = readAllLocal();
  all.push(entry);
  while (all.length > 100) all.shift(); // keep the local store bounded
  writeAllLocal(all);
  return entry;
}

export async function deleteReport(id: string): Promise<void> {
  if (useCloud()) {
    const supabase = getSupabase();
    const { error } = await supabase.from('saved_reports').delete().eq('id', id);
    if (error) throw new Error(`Could not delete the report: ${error.message}`);
    return;
  }
  writeAllLocal(readAllLocal().filter((r) => r.id !== id));
}

// ---------------------------------------------------------------------------
// Report generation ETA — rolling average of the last few generation times so
// the countdown timer reflects how long reports actually take on this machine.
// ---------------------------------------------------------------------------

const ETA_KEY = 'gis_report_durations_ms';
const DEFAULT_REPORT_MS = 60_000; // first-run estimate: ~60s

export function getReportEtaMs(): number {
  try {
    const raw = localStorage.getItem(ETA_KEY);
    const arr: number[] = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr) && arr.length > 0) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.min(300_000, Math.max(15_000, Math.round(avg))); // clamp 15s–5min
    }
  } catch { /* ignore */ }
  return DEFAULT_REPORT_MS;
}

export function recordReportDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const raw = localStorage.getItem(ETA_KEY);
    const arr: number[] = raw ? JSON.parse(raw) : [];
    arr.push(Math.round(ms));
    while (arr.length > 5) arr.shift(); // rolling window of the last 5 runs
    localStorage.setItem(ETA_KEY, JSON.stringify(arr));
  } catch { /* ignore */ }
}
