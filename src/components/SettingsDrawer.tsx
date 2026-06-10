import { useState, useEffect } from 'react';
import { X, Key, User, ShieldAlert, LogOut, CheckCircle, Eye, EyeOff, Info } from 'lucide-react';

interface SettingsDrawerProps {
  activeUser: any;
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
  onUpdateUser: (updatedUser: any) => void;
}

export function SettingsDrawer({ activeUser, isOpen, onClose, onLogout, onUpdateUser }: SettingsDrawerProps) {
  const [googleMapsKey, setGoogleMapsKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [openTopographyKey, setOpenTopographyKey] = useState('');
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showTopographyKey, setShowTopographyKey] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (activeUser && activeUser.keys) {
      setGoogleMapsKey(activeUser.keys.googleMaps || '');
      setGeminiKey(activeUser.keys.gemini || '');
      setOpenTopographyKey(activeUser.keys.openTopography || '');
    }
  }, [activeUser, isOpen]);

  if (!isOpen) return null;

  const handleSave = () => {
    setValidationError(null);
    setSaveSuccess(false);

    // Enforce key requirements
    if (!googleMapsKey.trim()) {
      setValidationError("Google Maps API Key is required for mapping and geocoding services.");
      return;
    }
    if (!geminiKey.trim()) {
      setValidationError("Gemini API Key is required for the chatbot, zoning analysis, and sold comps filters.");
      return;
    }

    // Save user keys in database
    const usersStr = localStorage.getItem('gis_registered_users') || '[]';
    const users = JSON.parse(usersStr);
    
    const userIndex = users.findIndex((u: any) => u.email.toLowerCase() === activeUser.email.toLowerCase());
    
    const updatedKeys = {
      googleMaps: googleMapsKey.trim(),
      gemini: geminiKey.trim(),
      openTopography: openTopographyKey.trim()
    };

    if (userIndex !== -1) {
      users[userIndex].keys = updatedKeys;
      localStorage.setItem('gis_registered_users', JSON.stringify(users));
    }

    // Update active session
    const isRemembered = localStorage.getItem('gis_active_user') !== null;
    const updatedSession = { ...activeUser, keys: updatedKeys };
    
    if (isRemembered) {
      localStorage.setItem('gis_active_user', JSON.stringify(updatedSession));
    } else {
      sessionStorage.setItem('gis_active_user', JSON.stringify(updatedSession));
    }

    onUpdateUser(updatedSession);
    setSaveSuccess(true);
    
    // Automatically trigger page reload to initialize the Google Maps SDK with the new key
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-container animate-slide-left" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="drawer-title-group">
            <h3>Account & API Settings</h3>
            <p>Configure credentials for local execution</p>
          </div>
          <button onClick={onClose} className="drawer-close-btn">
            <X size={20} />
          </button>
        </div>

        {/* Drawer Content */}
        <div className="drawer-body">
          {/* User Profile Card */}
          <div className="settings-profile-card">
            <div className="settings-avatar">
              <User size={20} />
            </div>
            <div className="settings-profile-info">
              <h4>{activeUser.email}</h4>
              <span className="profile-badge">
                {activeUser.provider === 'google' ? 'Google Account' : 'Standard Account'}
              </span>
            </div>
          </div>

          {/* Privacy Note */}
          <div className="settings-notice">
            <Info size={16} className="notice-icon" />
            <p>
              Your API keys are stored entirely inside your browser's local sandbox. They are never sent to external servers except direct connections to Google and Gemini APIs.
            </p>
          </div>

          {/* Error and Success Notifications */}
          {validationError && (
            <div className="settings-alert error">
              <ShieldAlert size={16} />
              <span>{validationError}</span>
            </div>
          )}

          {saveSuccess && (
            <div className="settings-alert success">
              <CheckCircle size={16} />
              <span>Settings saved! Reloading application...</span>
            </div>
          )}

          {/* Key Fields */}
          <div className="settings-section">
            <h5 className="section-title">API CONFIGURATION</h5>
            
            {/* Google Maps Key */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="googleMapsKey">Google Maps API Key</label>
                <span className="badge required">Required</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="googleMapsKey"
                  type={showGoogleKey ? "text" : "password"}
                  placeholder="AIzaSy..."
                  value={googleMapsKey}
                  onChange={(e) => setGoogleMapsKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowGoogleKey(!showGoogleKey)}
                >
                  {showGoogleKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Used to load satellite maps, autocomplete addresses, and fetch driving times.</p>
            </div>

            {/* Gemini Key */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="geminiKey">Gemini API Key</label>
                <span className="badge required">Required</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="geminiKey"
                  type={showGeminiKey ? "text" : "password"}
                  placeholder="AQ.Ab8..."
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowGeminiKey(!showGeminiKey)}
                >
                  {showGeminiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Powering web-search zoning lookups, comps evaluation, and the Advanced chatbot.</p>
            </div>

            {/* OpenTopography Key */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="openTopographyKey">OpenTopography API Key</label>
                <span className="badge optional">Optional</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="openTopographyKey"
                  type={showTopographyKey ? "text" : "password"}
                  placeholder="23f20d..."
                  value={openTopographyKey}
                  onChange={(e) => setOpenTopographyKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowTopographyKey(!showTopographyKey)}
                >
                  {showTopographyKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Enables customized, deep topographic elevation runs.</p>
            </div>
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="drawer-footer">
          <button onClick={onLogout} className="btn-logout">
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
          
          <button onClick={handleSave} className="btn-save-settings">
            <span>Save Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}
