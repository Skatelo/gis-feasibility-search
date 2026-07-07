import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { Mail, Lock, Shield, Eye, EyeOff, LogIn, UserPlus, KeyRound, Cloud, CloudOff, Loader2 } from 'lucide-react';
import { isSupabaseConfigured, setSupabaseConfig, getRememberPreference } from '../services/supabaseClient';
import { signInWithEmail, signUpWithEmail, signInWithGoogle } from '../services/authService';


interface AuthPortalProps {
  onLoginSuccess: (user: any) => void;
}

// Real Google Sign-In requires the user's OWN Google OAuth Client ID (created in
// their Google Cloud Console, like their other API keys). It's stored locally so
// it only needs to be entered once per browser.
const GOOGLE_CLIENT_ID_KEY = 'gis_google_client_id';

export function AuthPortal({ onLoginSuccess }: AuthPortalProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Google Sign-In state (real OAuth when a Client ID is configured; demo otherwise)
  const [showGoogleMock, setShowGoogleMock] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(() => {
    try { return localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || ''; } catch { return ''; }
  });
  const [clientIdInput, setClientIdInput] = useState('');
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Supabase cloud accounts (real auth + cross-device reports sync)
  const [supaConfigured, setSupaConfigured] = useState(isSupabaseConfigured());
  const [showConnect, setShowConnect] = useState(false);
  const [supaUrlInput, setSupaUrlInput] = useState('');
  const [supaAnonInput, setSupaAnonInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const saveSupabaseConnection = () => {
    setError(null);
    const url = supaUrlInput.trim();
    const anon = supaAnonInput.trim();
    if (!/^https:\/\/.+\.supabase\.co\/?$/.test(url)) {
      setError('That does not look like a Supabase project URL (expected https://xxxx.supabase.co).');
      return;
    }
    if (anon.length < 20) {
      setError('That does not look like a valid Supabase anon (public) key.');
      return;
    }
    setSupabaseConfig(url, anon);
    setSupaConfigured(true);
    setShowConnect(false);
    setSuccess('Supabase connected! Accounts and saved reports now sync to the cloud.');
  };

  /** Find-or-register a Google account locally and start the session. */
  const completeGoogleLogin = (gmail: string) => {
    const usersStr = localStorage.getItem('gis_registered_users') || '[]';
    const users = JSON.parse(usersStr);
    let user = users.find((u: any) => u.email.toLowerCase() === gmail.toLowerCase());
    if (!user) {
      user = {
        email: gmail,
        password: '', // Google users don't have passwords
        keys: { googleMaps: '', gemini: '' },
        provider: 'google'
      };
      users.push(user);
      localStorage.setItem('gis_registered_users', JSON.stringify(users));
    }
    loginUser(user);
  };

  // When the Google dialog opens and a Client ID is configured, load Google
  // Identity Services and render the REAL Google sign-in button.
  useEffect(() => {
    if (!showGoogleMock || !googleClientId) return;
    const init = () => {
      const g = (window as any).google;
      if (!g?.accounts?.id || !googleBtnRef.current) return;
      try {
        g.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp: any) => {
            try {
              const part = resp.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
              const payload = JSON.parse(atob(part));
              if (payload?.email) {
                setShowGoogleMock(false);
                completeGoogleLogin(payload.email);
              } else {
                setError('Google sign-in did not return an email address.');
              }
            } catch {
              setError('Google sign-in failed to decode the credential.');
            }
          },
        });
        googleBtnRef.current.innerHTML = '';
        g.accounts.id.renderButton(googleBtnRef.current, { theme: 'outline', size: 'large', width: 280 });
      } catch (e) {
        console.error('Google Identity Services init failed:', e);
        setError('Failed to initialize Google Sign-In. Check that your OAuth Client ID is valid and this origin is authorized.');
      }
    };
    if ((window as any).google?.accounts?.id) { init(); return; }
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) { existing.addEventListener('load', init); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = init;
    document.head.appendChild(s);
  }, [showGoogleMock, googleClientId]);

  const saveClientId = () => {
    const v = clientIdInput.trim();
    if (!v) return;
    try { localStorage.setItem(GOOGLE_CLIENT_ID_KEY, v); } catch { /* ignore */ }
    setGoogleClientId(v);
    setClientIdInput('');
  };

  const handleEmailAuth = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!email.trim() || !password) {
      setError("Please fill in all fields.");
      return;
    }

    // Developer bypass for local testing:
    if (email.trim().toLowerCase() === 'dev@example.com' && password === 'password') {
      const defaultDev = {
        email: 'dev@example.com',
        password: 'password',
        keys: { googleMaps: '', gemini: '' },
        provider: 'email'
      };
      loginUser(defaultDev);
      return;
    }

    // --- Supabase cloud accounts (real authentication) ---
    if (supaConfigured) {
      if (isSignUp) {
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
        if (password.length < 6) {
          setError("Password must be at least 6 characters.");
          return;
        }
      }
      setAuthBusy(true);
      try {
        if (isSignUp) {
          const { needsConfirmation } = await signUpWithEmail(email.trim(), password);
          if (needsConfirmation) {
            setSuccess("Account created! Check your inbox for the confirmation email, then sign in.");
            setIsSignUp(false);
            setPassword('');
            setConfirmPassword('');
          }
          // If confirmation is disabled on the project, the session is already
          // active and the app-level auth listener signs the user in.
        } else {
          // If the remember-me preference changed, the Supabase client gets a
          // new storage backend — reload afterwards so the app re-subscribes.
          const prefChanged = getRememberPreference() !== rememberMe;
          await signInWithEmail(email.trim(), password, rememberMe);
          if (prefChanged) {
            window.location.reload();
            return;
          }
          // Otherwise the app-level auth listener takes over.
        }
      } catch (err: any) {
        setError(err?.message || 'Authentication failed.');
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    // --- Local fallback mode (Supabase not connected) ---
    if (isSignUp) {
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }

      // Read registered users
      const usersStr = localStorage.getItem('gis_registered_users') || '[]';
      const users = JSON.parse(usersStr);

      const exists = users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());
      if (exists) {
        setError("An account with this email already exists.");
        return;
      }

      const newUser = {
        email: email.trim(),
        password,
        keys: { googleMaps: '', gemini: '' },
        provider: 'email'
      };

      users.push(newUser);
      localStorage.setItem('gis_registered_users', JSON.stringify(users));
      setSuccess("Account created successfully! Please sign in.");
      setIsSignUp(false);
      setPassword('');
      setConfirmPassword('');
    } else {
      // Sign In
      const usersStr = localStorage.getItem('gis_registered_users') || '[]';
      const users = JSON.parse(usersStr);

      // Add a default developer account if database is completely empty
      if (users.length === 0 && email === 'dev@example.com' && password === 'password') {
        const defaultDev = {
          email: 'dev@example.com',
          password: 'password',
          keys: { googleMaps: '', gemini: '' },
          provider: 'email'
        };
        users.push(defaultDev);
        localStorage.setItem('gis_registered_users', JSON.stringify(users));
      }

      const user = users.find((u: any) => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
      if (!user) {
        setError("Invalid email or password. Use dev@example.com / password if testing.");
        return;
      }

      loginUser(user);
    }
  };

  const loginUser = (user: any) => {
    // Save active session
    const sessionData = {
      email: user.email,
      keys: user.keys || { googleMaps: '', gemini: '' },
      provider: user.provider || 'email'
    };

    if (rememberMe) {
      localStorage.setItem('gis_active_user', JSON.stringify(sessionData));
    } else {
      sessionStorage.setItem('gis_active_user', JSON.stringify(sessionData));
    }

    onLoginSuccess(sessionData);
  };

  const startGoogleSignIn = async () => {
    setError(null);
    if (supaConfigured) {
      // REAL Google Sign-In via Supabase OAuth — redirects to accounts.google.com.
      setAuthBusy(true);
      try {
        await signInWithGoogle(rememberMe);
        // The browser is redirecting; no further action here.
      } catch (err: any) {
        setError(err?.message || 'Google sign-in failed. Is the Google provider enabled in your Supabase project?');
        setAuthBusy(false);
      }
      return;
    }
    setShowGoogleMock(true);
  };

  const selectGoogleAccount = (gmail: string) => {
    setGoogleLoading(true);
    setTimeout(() => {
      setGoogleLoading(false);
      setShowGoogleMock(false);
      completeGoogleLogin(gmail);
    }, 1500); // realistic loading feel
  };

  return (
    <div className="auth-portal-backdrop">
      <div className="auth-card-wrapper">
        <div className="auth-card-accent"></div>
        <div className="auth-card">
          {/* Logo Branding */}
          <div className="auth-logo-section">
            <div className="auth-logo-badge">
              <Shield size={28} color="#fff" />
            </div>
            <h2>NC SiteFeasibility</h2>
            <p>GIS Spatial Analytics & Acquisition Intelligence</p>
          </div>

          {/* Error / Success Notifications */}
          {error && (
            <div className="auth-alert error">
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="auth-alert success">
              <span>{success}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleEmailAuth} className="auth-form">
            <div className="auth-input-group">
              <label htmlFor="email">Email Address</label>
              <div className="auth-input-container">
                <Mail className="auth-input-icon" size={16} />
                <input
                  id="email"
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="auth-input-group">
              <label htmlFor="password">Password</label>
              <div className="auth-input-container">
                <Lock className="auth-input-icon" size={16} />
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {isSignUp && (
              <div className="auth-input-group animate-slide-down">
                <label htmlFor="confirmPassword">Confirm Password</label>
                <div className="auth-input-container">
                  <Lock className="auth-input-icon" size={16} />
                  <input
                    id="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required={isSignUp}
                  />
                </div>
              </div>
            )}

            {/* Remember Me & Forgot Password */}
            <div className="auth-actions-row">
              <label className="auth-remember-me">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember me</span>
              </label>
            </div>

            <button type="submit" className="auth-submit-btn" disabled={authBusy}>
              {authBusy ? (
                <>
                  <Loader2 size={18} className="spinner" />
                  <span>Please wait...</span>
                </>
              ) : isSignUp ? (
                <>
                  <UserPlus size={18} />
                  <span>Create Account</span>
                </>
              ) : (
                <>
                  <LogIn size={18} />
                  <span>Sign In</span>
                </>
              )}
            </button>
          </form>

          <div className="auth-divider">
            <span>or continue with</span>
          </div>

          {/* Social Google Login */}
          <button type="button" onClick={startGoogleSignIn} className="auth-google-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
            </svg>
            <span>Sign In with Google</span>
          </button>


          {/* Switch View Link */}
          <div className="auth-switch-link">
            {isSignUp ? (
              <p>
                Already have an account?{' '}
                <button type="button" onClick={() => setIsSignUp(false)}>
                  Sign In
                </button>
              </p>
            ) : (
              <p>
                Don't have an account?{' '}
                <button type="button" onClick={() => setIsSignUp(true)}>
                  Sign Up
                </button>
              </p>
            )}
          </div>

          {/* Cloud accounts status / Supabase connection */}
          <div style={{ marginTop: '14px', borderTop: '1px solid #e2e8f0', paddingTop: '12px' }}>
            {supaConfigured ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '0.74rem', color: '#16a34a', fontWeight: 600 }}>
                  <Cloud size={14} />
                  <span>Cloud accounts enabled — reports & API keys sync via Supabase</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    try { localStorage.setItem('gis_disable_supabase', 'true'); } catch {}
                    setSupaConfigured(false);
                    window.location.reload();
                  }}
                  style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '0.72rem', textDecoration: 'underline', fontWeight: 600 }}
                >
                  Use Local Storage Instead (Bypass Supabase)
                </button>
              </div>
            ) : showConnect ? (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px', background: '#f8fafc' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  <Cloud size={14} />
                  <span>Connect Supabase (cloud accounts)</span>
                </div>
                <p style={{ fontSize: '0.72rem', color: '#64748b', margin: '0 0 8px', lineHeight: 1.45 }}>
                  Paste your Supabase project URL and anon (public) key — found in your Supabase
                  dashboard under Settings → API. Full setup steps (tables + Google provider) are in
                  SETUP_SUPABASE.md in the project folder.
                </p>
                <input
                  type="text"
                  placeholder="https://xxxx.supabase.co"
                  value={supaUrlInput}
                  onChange={(e) => setSupaUrlInput(e.target.value)}
                  style={{ width: '100%', fontSize: '0.76rem', padding: '7px 9px', border: '1px solid #cbd5e1', borderRadius: '6px', marginBottom: '6px', boxSizing: 'border-box' }}
                />
                <input
                  type="password"
                  placeholder="Supabase anon (public) key"
                  value={supaAnonInput}
                  onChange={(e) => setSupaAnonInput(e.target.value)}
                  style={{ width: '100%', fontSize: '0.76rem', padding: '7px 9px', border: '1px solid #cbd5e1', borderRadius: '6px', marginBottom: '8px', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => setShowConnect(false)}
                    style={{ fontSize: '0.74rem', padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', color: '#64748b', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveSupabaseConnection}
                    disabled={!supaUrlInput.trim() || !supaAnonInput.trim()}
                    style={{ fontSize: '0.74rem', padding: '6px 14px', border: 'none', borderRadius: '6px', background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                  >
                    Connect
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '0.74rem', color: '#94a3b8' }}>
                  <CloudOff size={14} />
                  <span>Accounts are stored on this device only.</span>
                  <button
                    type="button"
                    onClick={() => setShowConnect(true)}
                    style={{ background: 'none', border: 'none', color: '#4f46e5', cursor: 'pointer', fontSize: '0.74rem', padding: 0, textDecoration: 'underline', fontWeight: 600 }}
                  >
                    Connect Supabase
                  </button>
                </div>
                {localStorage.getItem('gis_disable_supabase') === 'true' && (
                  <button
                    type="button"
                    onClick={() => {
                      try { localStorage.removeItem('gis_disable_supabase'); } catch {}
                      setSupaConfigured(true);
                      window.location.reload();
                    }}
                    style={{ background: 'none', border: 'none', color: '#16a34a', cursor: 'pointer', fontSize: '0.72rem', textDecoration: 'underline', fontWeight: 600 }}
                  >
                    Re-enable Supabase cloud accounts
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Google Mock Modal */}
      {showGoogleMock && (
        <div className="google-mock-overlay">
          <div className="google-mock-dialog">
            <div className="google-mock-header">
              <div className="google-g-logo">G</div>
              <h3>Sign in with Google</h3>
              <p>to continue to NC SiteFeasibility</p>
            </div>

            {googleLoading ? (
              <div className="google-mock-loading">
                <div className="google-spinner"></div>
                <p>Connecting securely...</p>
              </div>
            ) : googleClientId ? (
              <div className="google-mock-body">
                {/* REAL Google Sign-In (Google Identity Services) */}
                <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center', minHeight: '44px', padding: '8px 0' }} />
                <p style={{ fontSize: '0.72rem', color: '#94a3b8', textAlign: 'center', margin: '10px 0 0' }}>
                  Using your Google OAuth Client ID.{' '}
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#4285F4', cursor: 'pointer', fontSize: '0.72rem', padding: 0, textDecoration: 'underline' }}
                    onClick={() => {
                      try { localStorage.removeItem(GOOGLE_CLIENT_ID_KEY); } catch { /* ignore */ }
                      setGoogleClientId('');
                    }}
                  >
                    Remove
                  </button>
                </p>
                <button
                  type="button"
                  onClick={() => setShowGoogleMock(false)}
                  className="google-mock-cancel"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="google-mock-body">
                <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', background: '#f8fafc' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                    <KeyRound size={13} />
                    <span>Enable real Google Sign-In</span>
                  </div>
                  <p style={{ fontSize: '0.72rem', color: '#64748b', margin: '0 0 8px', lineHeight: 1.4 }}>
                    Paste your own Google OAuth Client ID (Google Cloud Console → Credentials → OAuth 2.0 Client ID, type "Web application"). Without one, the demo accounts below are used.
                  </p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      placeholder="xxxxxxxx.apps.googleusercontent.com"
                      value={clientIdInput}
                      onChange={(e) => setClientIdInput(e.target.value)}
                      style={{ flex: 1, fontSize: '0.74rem', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
                    />
                    <button
                      type="button"
                      onClick={saveClientId}
                      disabled={!clientIdInput.trim()}
                      style={{ fontSize: '0.74rem', padding: '6px 12px', border: 'none', borderRadius: '6px', background: '#4285F4', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="google-account-list">
                  <button
                    onClick={() => selectGoogleAccount("developer.gis@gmail.com")}
                    className="google-account-item"
                  >
                    <div className="google-avatar">D</div>
                    <div className="google-account-info">
                      <div className="google-name">GIS Developer</div>
                      <div className="google-email">developer.gis@gmail.com</div>
                    </div>
                  </button>

                  <button
                    onClick={() => selectGoogleAccount("acquisitions.lead@gmail.com")}
                    className="google-account-item"
                  >
                    <div className="google-avatar">A</div>
                    <div className="google-account-info">
                      <div className="google-name">Lead Acquisitions Manager</div>
                      <div className="google-email">acquisitions.lead@gmail.com</div>
                    </div>
                  </button>

                  <button
                    onClick={() => selectGoogleAccount("guest.investor@gmail.com")}
                    className="google-account-item"
                  >
                    <div className="google-avatar">G</div>
                    <div className="google-account-info">
                      <div className="google-name">Guest Investor</div>
                      <div className="google-email">guest.investor@gmail.com</div>
                    </div>
                  </button>
                </div>
                
                <button
                  type="button"
                  onClick={() => setShowGoogleMock(false)}
                  className="google-mock-cancel"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
