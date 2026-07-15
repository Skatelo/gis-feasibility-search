import { useState, useEffect, useRef } from 'react';
import { FeasibilitySearch } from './components/FeasibilitySearch';
import { DistressedFinder } from './components/DistressedFinder';
import { SkipTrace } from './components/SkipTrace';
import { NewsTicker } from './components/NewsTicker';
import { AuthPortal } from './components/AuthPortal';
import { SettingsDrawer } from './components/SettingsDrawer';
import { Database, FileJson, FolderOpen, Globe, Settings, Map as MapIcon, Sparkles, Fingerprint } from 'lucide-react';
import { getSupabase, isSupabaseConfigured } from './services/supabaseClient';
import { buildSessionUser, signOutEverywhere, writeSessionMirror, deriveFirstName } from './services/authService';


type AppView = 'feasibility' | 'finder' | 'skiptrace';

function App() {
  const [activeUser, setActiveUser] = useState<any>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const hashToView = (h: string): AppView =>
    h === '#/finder' ? 'finder' : h === '#/skiptrace' ? 'skiptrace' : 'feasibility';
  const [view, setView] = useState<AppView>(() => hashToView(window.location.hash));
  const lastUserIdRef = useRef<string | null>(null);

  // Keep the active view in sync with the URL hash so each page is linkable
  // (e.g. share /#/finder) and the browser back/forward buttons work.
  useEffect(() => {
    const onHash = () => setView(hashToView(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const goTo = (next: AppView) => {
    window.location.hash = next === 'finder' ? '#/finder' : next === 'skiptrace' ? '#/skiptrace' : '#/';
    setView(next);
  };

  // Load the session on startup. With Supabase configured this also completes
  // the Google OAuth redirect and keeps the app in sync with auth changes
  // (sign-in, sign-out, token refresh) across tabs.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    if (isSupabaseConfigured()) {
      try {
        const supabase = getSupabase();
        const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
          if (session?.user) {
            // Supabase re-validates the session whenever the browser tab regains
            // focus (TOKEN_REFRESHED / repeated SIGNED_IN events). Nothing about
            // the user changed, so skip the rebuild — otherwise the whole app
            // re-renders and in-progress form input (e.g. unsaved API keys in
            // Settings) gets reset.
            if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && lastUserIdRef.current === session.user.id) {
              setSessionLoaded(true);
              return;
            }
            buildSessionUser(session.user)
              .then((u) => {
                lastUserIdRef.current = session.user.id;
                // Keep the same object reference when nothing changed to avoid
                // pointless downstream re-renders.
                setActiveUser((prev: any) => (prev && JSON.stringify(prev) === JSON.stringify(u) ? prev : u));
              })
              .finally(() => setSessionLoaded(true));
          } else {
            lastUserIdRef.current = null;
            writeSessionMirror(null);
            setActiveUser(null);
            setSessionLoaded(true);
          }
        });
        unsubscribe = () => sub.subscription.unsubscribe();
        // onAuthStateChange fires INITIAL_SESSION on load, which resolves
        // sessionLoaded above for both signed-in and signed-out states.
      } catch (e) {
        console.error('Supabase session bootstrap failed:', e);
        setSessionLoaded(true);
      }
    } else {
      // Local fallback mode (Supabase not configured yet).
      try {
        const stored = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
        if (stored) {
          setActiveUser(JSON.parse(stored));
        }
      } catch (e) {
        console.error("Failed to load user session:", e);
      } finally {
        setSessionLoaded(true);
      }
    }

    const handleOpenSettings = () => setIsSettingsOpen(true);
    window.addEventListener('open-gis-settings', handleOpenSettings);
    return () => {
      window.removeEventListener('open-gis-settings', handleOpenSettings);
      unsubscribe?.();
    };
  }, []);


  const handleLogout = async () => {
    await signOutEverywhere();
    setActiveUser(null);
    setIsSettingsOpen(false);
  };

  const handleUpdateUser = (updatedUser: any) => {
    setActiveUser(updatedUser);
  };

  if (!sessionLoaded) {
    return (
      <div className="session-loading-viewport">
        <div className="session-spinner"></div>
        <p>Loading application state...</p>
      </div>
    );
  }

  // If user is not authenticated, show Auth portal
  if (!activeUser) {
    return <AuthPortal onLoginSuccess={setActiveUser} />;
  }

  // Check if API Keys are configured
  const keysConfigured = !!(activeUser.keys?.googleMaps && activeUser.keys?.gemini);

  return (
    <>
      {/* Premium Dashboard Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-badge">
            <Database size={24} color="#fff" />
          </div>
          <div className="logo-text">
            <h1>NC SiteFeasibility</h1>
            <div className="logo-subtitle">GIS Spatial Analytics</div>
          </div>
        </div>
        
        <nav className="app-nav">
          <button
            type="button"
            className={`app-nav-btn ${view === 'feasibility' ? 'active' : ''}`}
            onClick={() => goTo('feasibility')}
          >
            <MapIcon size={16} />
            <span>Feasibility Search</span>
          </button>
          <button
            type="button"
            className={`app-nav-btn ${view === 'finder' ? 'active' : ''}`}
            onClick={() => goTo('finder')}
          >
            <Sparkles size={16} />
            <span>AI Property Finder</span>
          </button>
          <button
            type="button"
            className={`app-nav-btn ${view === 'skiptrace' ? 'active' : ''}`}
            onClick={() => goTo('skiptrace')}
          >
            <Fingerprint size={16} />
            <span>Skip Trace</span>
          </button>
        </nav>

        <div className="header-actions">
          <div className="header-status">
            <span className={`status-dot ${keysConfigured ? 'online' : 'offline'}`}></span>
            <span>
              {keysConfigured 
                ? 'NC GIS Services Connected' 
                : 'API Key Required: Set credentials in settings'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('open-gis-reports'))}
            className="header-settings-btn"
            title="My saved feasibility reports"
          >
            <FolderOpen size={18} />
            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Reports</span>
          </button>

          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className={`header-settings-btn account-btn ${!keysConfigured ? 'keys-alert' : ''}`}
            title="Account & API Settings"
          >
            <Settings size={18} />
            <span className="account-first-name">
              {activeUser.firstName || deriveFirstName(null, activeUser.email || '')}
            </span>
          </button>
        </div>
      </header>

      {/* Auto-scrolling real estate / housing news strip (NC-tailored) */}
      <NewsTicker />

      {/* Main Content — feasibility search, AI finder, or LLC skip trace */}
      <main className="main-content">
        {view === 'finder'
          ? <DistressedFinder />
          : view === 'skiptrace'
            ? <SkipTrace />
            : <FeasibilitySearch />}
      </main>

      {/* Dashboard Footer */}
      <footer className="app-footer">
        <div>
          &copy; {new Date().getFullYear()} NC GIS Site Feasibility Search. Professional Developer Toolkit.
        </div>
        <div className="footer-links">
          <a href="https://services.nconemap.gov" target="_blank" rel="noreferrer" className="footer-link">
            <Globe size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            NC OneMap
          </a>
          <a href="https://gis.charlottenc.gov" target="_blank" rel="noreferrer" className="footer-link">
            <Database size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            Charlotte GIS
          </a>
          <a href="https://developers.google.com/maps/documentation/geocoding" target="_blank" rel="noreferrer" className="footer-link">
            <FileJson size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            Google API
          </a>
        </div>
      </footer>

      {/* Settings slide-out Drawer */}
      <SettingsDrawer
        activeUser={activeUser}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onLogout={handleLogout}
        onUpdateUser={handleUpdateUser}
      />
    </>
  );
}

export default App;
