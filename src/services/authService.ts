// ---------------------------------------------------------------------------
// Authentication + per-account settings, backed by Supabase when configured
// (cloud accounts, real Google OAuth, cross-device sync) with a transparent
// local-only fallback when it isn't.
//
// The signed-in user's email + API keys are mirrored into
// localStorage/sessionStorage under 'gis_active_user' so existing synchronous
// readers (feasibilityService.getUserKeys) keep working unchanged.
// ---------------------------------------------------------------------------
import type { User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured, getRememberPreference, setRememberPreference } from './supabaseClient';
import type { UserKeys } from './feasibilityService';

export interface SessionUser {
  email: string;
  keys: UserKeys;
  provider: string;
  /** Supabase auth user id (absent in local fallback mode). */
  userId?: string;
}

const MIRROR_KEY = 'gis_active_user';

/** Writes the session mirror that getUserKeys() and the UI read synchronously. */
export function writeSessionMirror(user: SessionUser | null): void {
  try {
    localStorage.removeItem(MIRROR_KEY);
    sessionStorage.removeItem(MIRROR_KEY);
    if (user) {
      const store = getRememberPreference() ? localStorage : sessionStorage;
      store.setItem(MIRROR_KEY, JSON.stringify(user));
    }
  } catch (e) {
    console.error('Failed to write session mirror:', e);
  }
}

/** Fetches (or lazily creates) the user's profile row and returns a SessionUser. */
export async function buildSessionUser(authUser: User): Promise<SessionUser> {
  const supabase = getSupabase();
  let keys: UserKeys = {};
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('keys')
      .eq('user_id', authUser.id)
      .maybeSingle();
    if (error) throw error;
    if (data?.keys) {
      keys = data.keys as UserKeys;
    } else {
      // First sign-in on this project: create the profile row.
      await supabase.from('profiles').upsert({
        user_id: authUser.id,
        email: authUser.email,
        keys: {},
      });
    }
  } catch (e) {
    console.warn('Could not load profile keys from Supabase (using empty keys):', e);
  }
  const provider = (authUser.app_metadata?.provider as string) || 'email';
  const user: SessionUser = {
    email: authUser.email || '',
    keys,
    provider,
    userId: authUser.id,
  };
  writeSessionMirror(user);
  return user;
}

export async function signUpWithEmail(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  // If email confirmation is enabled on the project, there's no session yet.
  return { needsConfirmation: !data.session };
}

export async function signInWithEmail(email: string, password: string, rememberMe: boolean): Promise<void> {
  setRememberPreference(rememberMe); // choose session storage BEFORE creating the session
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Real Google Sign-In via Supabase OAuth (redirect flow). */
export async function signInWithGoogle(rememberMe: boolean): Promise<void> {
  setRememberPreference(rememberMe);
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
  // The browser now redirects to Google; the session is picked up on return.
}

export async function signOutEverywhere(): Promise<void> {
  if (isSupabaseConfigured()) {
    try { await getSupabase().auth.signOut(); } catch (e) { console.warn('Supabase sign-out failed:', e); }
  }
  writeSessionMirror(null);
}

/**
 * Persists the user's API keys: Supabase profile when signed in through
 * Supabase, the local registered-users store otherwise. Always refreshes the
 * session mirror so the running app picks the keys up immediately.
 */
export async function persistUserKeys(activeUser: SessionUser, keys: UserKeys): Promise<SessionUser> {
  const updated: SessionUser = { ...activeUser, keys };
  if (isSupabaseConfigured() && activeUser.userId) {
    const supabase = getSupabase();
    const { error } = await supabase.from('profiles').upsert({
      user_id: activeUser.userId,
      email: activeUser.email,
      keys,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Failed to save settings to your account: ${error.message}`);
  } else {
    // Local fallback mode: update the registered-users store.
    try {
      const users = JSON.parse(localStorage.getItem('gis_registered_users') || '[]');
      const idx = users.findIndex((u: any) => u.email?.toLowerCase() === activeUser.email.toLowerCase());
      if (idx !== -1) {
        users[idx].keys = keys;
        localStorage.setItem('gis_registered_users', JSON.stringify(users));
      }
    } catch (e) {
      console.error('Failed to update local user store:', e);
    }
  }
  writeSessionMirror(updated);
  return updated;
}
