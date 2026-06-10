import { useState, useEffect } from 'react';
import { FeasibilitySearch } from './components/FeasibilitySearch';
import { AuthPortal } from './components/AuthPortal';
import { SettingsDrawer } from './components/SettingsDrawer';
import { Database, FileJson, Globe, Settings } from 'lucide-react';


function App() {
  const [activeUser, setActiveUser] = useState<any>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Load session on startup and listen for settings triggers
  useEffect(() => {
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

    const handleOpenSettings = () => setIsSettingsOpen(true);
    window.addEventListener('open-gis-settings', handleOpenSettings);
    return () => {
      window.removeEventListener('open-gis-settings', handleOpenSettings);
    };
  }, []);


  const handleLogout = () => {
    try {
      localStorage.removeItem('gis_active_user');
      sessionStorage.removeItem('gis_active_user');
    } catch (e) {
      console.error("Failed to clear session:", e);
    }
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
            onClick={() => setIsSettingsOpen(true)} 
            className={`header-settings-btn ${!keysConfigured ? 'keys-alert' : ''}`}
            title="Account & API Settings"
          >
            <Settings size={18} />
            <div className="user-initial">
              {activeUser.email.substring(0, 2).toUpperCase()}
            </div>
          </button>
        </div>
      </header>

      {/* Main Search Component */}
      <main className="main-content">
        <FeasibilitySearch />
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
