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

// Once Supabase reports the user_sync table missing, stop calling it for the
// rest of the session (one clear warning instead of a 404 per save).
// Fix: run the `user_sync` SQL block from SETUP_SUPABASE.md in the Supabase
// SQL editor — sync starts working immediately, no code change needed.
let syncTableMissing = false;

function noteTableMissing(where: string, message: string): boolean {
  if (!/could not find the table|user_sync/i.test(message)) return false;
  if (!syncTableMissing) {
    syncTableMissing = true;
    console.warn(`${where}: the Supabase 'user_sync' table doesn't exist yet — cross-device sync is OFF for this session. Run the user_sync SQL block from SETUP_SUPABASE.md to enable it.`);
  }
  return true;
}

export function syncEnabled(): boolean {
  return isSupabaseConfigured() && !!currentUserId() && !syncTableMissing;
}

export async function syncGet<T = unknown>(key: string): Promise<T | undefined> {
  const userId = currentUserId();
  if (!isSupabaseConfigured() || !userId || syncTableMissing) return undefined;
  try {
    const { data, error } = await getSupabase()
      .from('user_sync')
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (error) {
      if (!noteTableMissing(`syncGet(${key})`, error.message)) console.warn(`syncGet(${key}) failed:`, error.message);
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
  if (!isSupabaseConfigured() || !userId || syncTableMissing) return;
  try {
    const { error } = await getSupabase()
      .from('user_sync')
      .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    if (error && !noteTableMissing(`syncSet(${key})`, error.message)) console.warn(`syncSet(${key}) failed:`, error.message);
  } catch (e) {
    console.warn(`syncSet(${key}) error:`, e);
  }
}
