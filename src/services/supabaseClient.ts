// ---------------------------------------------------------------------------
// Supabase client (cloud accounts + saved reports).
//
// The project URL and anon key come from .env.local (VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY) or — so non-developers can connect without touching
// files — from values pasted on the sign-in screen (stored in localStorage).
// If neither is configured, the app gracefully falls back to local-only
// accounts/reports. See SETUP_SUPABASE.md for the one-time project setup.
// ---------------------------------------------------------------------------
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const URL_LS_KEY = 'gis_supabase_url';
const ANON_LS_KEY = 'gis_supabase_anon';
const REMEMBER_KEY = 'gis_remember_me';

export function getSupabaseConfig(): { url: string; anonKey: string } {
  let url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  let anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';
  try {
    if (!url) url = localStorage.getItem(URL_LS_KEY) || '';
    if (!anonKey) anonKey = localStorage.getItem(ANON_LS_KEY) || '';
  } catch { /* ignore */ }
  return { url: url.trim(), anonKey: anonKey.trim() };
}

export function setSupabaseConfig(url: string, anonKey: string): void {
  try {
    localStorage.setItem(URL_LS_KEY, url.trim());
    localStorage.setItem(ANON_LS_KEY, anonKey.trim());
  } catch { /* ignore */ }
  resetSupabaseClient();
}

export function clearSupabaseConfig(): void {
  try {
    localStorage.removeItem(URL_LS_KEY);
    localStorage.removeItem(ANON_LS_KEY);
  } catch { /* ignore */ }
  resetSupabaseClient();
}

export function isSupabaseConfigured(): boolean {
  try {
    if (localStorage.getItem('gis_disable_supabase') === 'true') return false;
  } catch { /* ignore */ }
  const { url, anonKey } = getSupabaseConfig();
  return !!(url && anonKey && /^https?:\/\//.test(url));
}

// "Remember me": when true (default) the Supabase session lives in
// localStorage and survives browser restarts; when false it lives in
// sessionStorage and ends when the tab/browser closes.
export function getRememberPreference(): boolean {
  try { return localStorage.getItem(REMEMBER_KEY) !== 'false'; } catch { return true; }
}

export function setRememberPreference(remember: boolean): void {
  const prev = getRememberPreference();
  try { localStorage.setItem(REMEMBER_KEY, remember ? 'true' : 'false'); } catch { /* ignore */ }
  if (prev !== remember) resetSupabaseClient(); // storage backend changed
}

let client: SupabaseClient | null = null;

function resetSupabaseClient(): void {
  client = null;
}

/** Lazy singleton. Throws if called when Supabase isn't configured. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or paste them on the sign-in screen).');
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // completes the Google OAuth redirect flow
      storage: getRememberPreference() ? window.localStorage : window.sessionStorage,
    },
  });
  return client;
}
