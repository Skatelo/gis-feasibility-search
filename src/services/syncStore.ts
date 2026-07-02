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

function noteTableMissing(where: string, message: string): boolean {
  if (!/could not find the table|user_sync/i.test(message)) return false;
  syncTableMissing = true;
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(`${where}: the 'user_sync' table doesn't exist — using the account-metadata sync fallback instead (your chats & history still follow your account across devices). Run the user_sync SQL block from SETUP_SUPABASE.md for full-fidelity table sync.`);
  }
  return true;
}

/** Trim oversized payloads for auth metadata (keeps the NEWEST entries). */
function fitForMeta(value: unknown): unknown {
  try {
    let v: any = value;
    let s = JSON.stringify(v);
    while (Array.isArray(v) && s.length > 180_000 && v.length > 1) {
      v = v.slice(0, Math.max(1, Math.floor(v.length * 0.7)));
      s = JSON.stringify(v);
    }
    return s.length <= 200_000 ? v : undefined;
  } catch { return undefined; }
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
    const { data, error } = await getSupabase()
      .from('user_sync')
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (error) {
      if (noteTableMissing(`syncGet(${key})`, error.message)) return metaGet<T>(key);
      console.warn(`syncGet(${key}) failed:`, error.message);
      return undefined;
    }
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
    const { error } = await getSupabase()
      .from('user_sync')
      .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    if (error) {
      if (noteTableMissing(`syncSet(${key})`, error.message)) { await metaSet(key, value); return; }
      console.warn(`syncSet(${key}) failed:`, error.message);
    }
  } catch (e) {
    console.warn(`syncSet(${key}) error:`, e);
  }
}
