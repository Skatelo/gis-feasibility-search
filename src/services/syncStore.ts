// ---------------------------------------------------------------------------
// Cross-device sync: a generic per-user key/value store backed by the Supabase
// `user_sync` table (see SETUP_SUPABASE.md). Used to sync the Land Assistant
// chat history and the GIS search history across a user's devices.
//
// syncGet returns `undefined` when the key has NEVER been synced (no row) so
// callers can distinguish "first-time, migrate local up" from "cloud is
// authoritatively empty ([])". All calls no-op gracefully when Supabase isn't
// configured or the user is signed out.
// ---------------------------------------------------------------------------
import { getSupabase, isSupabaseConfigured } from './supabaseClient';

function currentUserId(): string | undefined {
  try {
    const raw = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    if (raw) return JSON.parse(raw).userId;
  } catch { /* ignore */ }
  return undefined;
}

// When the `user_sync` table exists, it is the sync backend (full fidelity).
// When it DOESN'T exist (the SQL block was never run), sync automatically
// falls back to Supabase AUTH USER-METADATA — a JSON blob on the signed-in
// account itself. It needs NO table, no SQL, no setup, and follows the account
// to every device. Payloads are size-guarded (metadata has practical limits);
// running the user_sync SQL from SETUP_SUPABASE.md later upgrades sync
// transparently to the table.
let syncTableMissing = false;
let warnedFallback = false;
const META_PREFIX = 'sync_';

// HARD size cap for anything stored in auth user-metadata. The metadata is
// embedded in EVERY JWT access token, and the token rides in the Authorization
// header of EVERY Supabase request — oversized metadata therefore blows the
// gateway's header limits and the whole REST API starts failing with 520s
// (edge) and 400s (PostgREST can't parse the mangled JWT). Keep it small.
const META_MAX_CHARS = 8_000;

function noteTableMissing(where: string, message: string): boolean {
  // ONLY a genuine "table doesn't exist" (PostgREST schema-cache miss) may
  // flip sync to the metadata fallback. The old check also matched any error
  // that merely MENTIONED "user_sync" (RLS/permission/5xx messages echo the
  // table name), which wrongly switched accounts onto metadata sync.
  if (!/could not find the table|schema cache|PGRST205/i.test(message)) return false;
  syncTableMissing = true;
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(`${where}: the 'user_sync' table doesn't exist — using the account-metadata sync fallback instead (your chats & history still follow your account across devices). Run the user_sync SQL block from SETUP_SUPABASE.md for full-fidelity table sync.`);
  }
  return true;
}

/** Transient-failure detector: network hiccups, gateway 5xx/520 bodies, rate
 *  limits — worth an automatic retry with backoff. */
function isTransient(message: string): boolean {
  return /fetch|network|timeout|timed out|5\d\d|429|too many|rate limit|upstream|cloudflare|unknown error/i.test(message);
}

/** Retry a Supabase call up to 3× with backoff when the failure looks
 *  transient (the 520s in the project logs are exactly this class). */
async function withRetry<T extends { error: { message?: string } | null }>(
  run: () => PromiseLike<T>,
): Promise<T> {
  let last: T = await run();
  for (let attempt = 1; attempt < 3 && last.error; attempt++) {
    const msg = String(last.error.message || '');
    if (/could not find the table|schema cache|PGRST205/i.test(msg)) return last; // structural — retrying won't help
    if (!isTransient(msg)) return last;
    await new Promise((r) => setTimeout(r, 700 * attempt));
    last = await run();
  }
  return last;
}

/** Trim oversized payloads for auth metadata (keeps the NEWEST entries). */
function fitForMeta(value: unknown): unknown {
  try {
    let v: any = value;
    let s = JSON.stringify(v);
    while (Array.isArray(v) && s.length > META_MAX_CHARS && v.length > 1) {
      v = v.slice(0, Math.max(1, Math.floor(v.length * 0.7)));
      s = JSON.stringify(v);
    }
    return s.length <= META_MAX_CHARS ? v : undefined;
  } catch { return undefined; }
}

// One-shot metadata hygiene per app load. 'oversized' strips only dangerous
// blobs (> META_MAX_CHARS); 'all' removes every legacy sync_ blob (used once
// table sync is confirmed working — the table is then the backend of record).
let metaCleanupDone = false;

/** Remove legacy sync_ blobs from auth user-metadata. Oversized blobs bloat
 *  the JWT → oversized request headers → the Supabase REST 520/400 failures
 *  seen in the project logs. Safe to call any time; runs once per session. */
export async function cleanupSyncMetadata(mode: 'oversized' | 'all' = 'oversized'): Promise<void> {
  if (metaCleanupDone || !isSupabaseConfigured()) return;
  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error || !data?.user) return;
    const meta = (data.user.user_metadata || {}) as Record<string, unknown>;
    const nulls: Record<string, null> = {};
    for (const k of Object.keys(meta)) {
      if (!k.startsWith(META_PREFIX) || meta[k] == null) continue;
      if (mode === 'all') { nulls[k] = null; continue; }
      try {
        if ((JSON.stringify(meta[k]) || '').length > META_MAX_CHARS) nulls[k] = null;
      } catch { nulls[k] = null; }
    }
    if (Object.keys(nulls).length > 0) {
      const { error: upErr } = await getSupabase().auth.updateUser({ data: nulls });
      if (!upErr) {
        console.warn(`Cleared ${Object.keys(nulls).length} legacy sync blob(s) from account metadata — oversized metadata bloats the auth token and causes Supabase REST 520/400 errors. Refresh the session (sign out/in) if errors persist.`);
      }
    }
    metaCleanupDone = true;
  } catch { /* best-effort hygiene — never block the caller */ }
}

async function metaGet<T>(key: string): Promise<T | undefined> {
  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error || !data?.user) return undefined;
    return ((data.user.user_metadata || {}) as Record<string, unknown>)[META_PREFIX + key] as T | undefined;
  } catch { return undefined; }
}

async function metaSet(key: string, value: unknown): Promise<void> {
  try {
    const v = fitForMeta(value);
    if (v === undefined) return;
    await getSupabase().auth.updateUser({ data: { [META_PREFIX + key]: v } });
  } catch { /* signed out / local-only session — nothing to sync to */ }
}

export function syncEnabled(): boolean {
  return isSupabaseConfigured() && !!currentUserId();
}

export async function syncGet<T = unknown>(key: string): Promise<T | undefined> {
  const userId = currentUserId();
  if (!isSupabaseConfigured() || !userId) return undefined;
  if (syncTableMissing) return metaGet<T>(key);
  try {
    const { data, error } = await withRetry(() => getSupabase()
      .from('user_sync')
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle());
    if (error) {
      if (noteTableMissing(`syncGet(${key})`, error.message)) return metaGet<T>(key);
      console.warn(`syncGet(${key}) failed:`, error.message);
      return undefined;
    }
    // Table sync works — retire any legacy metadata blobs (JWT hygiene).
    void cleanupSyncMetadata('all');
    return data ? (data.value as T) : undefined; // undefined = no row yet
  } catch (e) {
    console.warn(`syncGet(${key}) error:`, e);
    return undefined;
  }
}

export async function syncSet(key: string, value: unknown): Promise<void> {
  const userId = currentUserId();
  if (!isSupabaseConfigured() || !userId) return;
  if (syncTableMissing) { await metaSet(key, value); return; }
  try {
    const { error } = await withRetry(() => getSupabase()
      .from('user_sync')
      .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }));
    if (error) {
      if (noteTableMissing(`syncSet(${key})`, error.message)) { await metaSet(key, value); return; }
      console.warn(`syncSet(${key}) failed:`, error.message);
      return;
    }
    // Table sync works — retire any legacy metadata blobs (JWT hygiene).
    void cleanupSyncMetadata('all');
  } catch (e) {
    console.warn(`syncSet(${key}) error:`, e);
  }
}
