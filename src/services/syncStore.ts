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

export function syncEnabled(): boolean {
  return isSupabaseConfigured() && !!currentUserId();
}

export async function syncGet<T = unknown>(key: string): Promise<T | undefined> {
  const userId = currentUserId();
  if (!isSupabaseConfigured() || !userId) return undefined;
  try {
    const { data, error } = await getSupabase()
      .from('user_sync')
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (error) { console.warn(`syncGet(${key}) failed:`, error.message); return undefined; }
    return data ? (data.value as T) : undefined; // undefined = no row yet
  } catch (e) {
    console.warn(`syncGet(${key}) error:`, e);
    return undefined;
  }
}

export async function syncSet(key: string, value: unknown): Promise<void> {
  const userId = currentUserId();
  if (!isSupabaseConfigured() || !userId) return;
  try {
    const { error } = await getSupabase()
      .from('user_sync')
      .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    if (error) console.warn(`syncSet(${key}) failed:`, error.message);
  } catch (e) {
    console.warn(`syncSet(${key}) error:`, e);
  }
}
