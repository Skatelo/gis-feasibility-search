import { useState, useEffect } from 'react';
import { X, Key, User, ShieldAlert, LogOut, CheckCircle, Eye, EyeOff, Info, Cloud } from 'lucide-react';
import { persistUserKeys } from '../services/authService';
import { isSupabaseConfigured } from '../services/supabaseClient';

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
  const [realtyApiKey, setRealtyApiKey] = useState('');
  const [showRealtyKey, setShowRealtyKey] = useState(false);
  const [deepSeekKey, setDeepSeekKey] = useState('');
  const [showDeepSeekKey, setShowDeepSeekKey] = useState(false);
  const [rentCastKey, setRentCastKey] = useState('');
  const [showRentCastKey, setShowRentCastKey] = useState(false);
  const [newsDataKey, setNewsDataKey] = useState('');
  const [showNewsDataKey, setShowNewsDataKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showTopographyKey, setShowTopographyKey] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Initialize the form ONLY when the drawer opens — not on every activeUser
  // re-render. Supabase refreshes the session when you switch browser tabs,
  // which produces a new activeUser object; re-initializing on that change
  // would wipe any keys typed but not yet saved.
  useEffect(() => {
    if (isOpen && activeUser) {
      setGoogleMapsKey(activeUser.keys?.googleMaps || '');
      setGeminiKey(activeUser.keys?.gemini || '');
      setOpenTopographyKey(activeUser.keys?.openTopography || '');
      setRealtyApiKey(activeUser.keys?.realtyApi || '');
      setDeepSeekKey(activeUser.keys?.deepSeek || '');
      setRentCastKey(activeUser.keys?.rentCast || '');
      setNewsDataKey(activeUser.keys?.newsData || '');
      setValidationError(null);
      setSaveSuccess(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
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

    const updatedKeys = {
      googleMaps: googleMapsKey.trim(),
      gemini: geminiKey.trim(),
      openTopography: openTopographyKey.trim(),
      realtyApi: realtyApiKey.trim(),
      deepSeek: deepSeekKey.trim(),
      rentCast: rentCastKey.trim(),
      newsData: newsDataKey.trim()
    };

    try {
      // Persists to the Supabase profile when signed in with a cloud account
      // (syncs across devices), or to the local store otherwise. Also updates
      // the running session so the app picks the keys up immediately.
      const updatedSession = await persistUserKeys(activeUser, updatedKeys);
      onUpdateUser(updatedSession);
      setSaveSuccess(true);

      // Reload to initialize the Google Maps SDK with the new key
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (e: any) {
      console.error(e);
      setValidationError(e?.message || 'Failed to save your settings.');
    }
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
              {isSupabaseConfigured() && activeUser.userId && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.68rem', color: '#16a34a', fontWeight: 600, marginLeft: '8px' }}>
                  <Cloud size={12} />
                  <span>Cloud synced</span>
                </span>
              )}
            </div>
          </div>

          {/* Privacy Note */}
          <div className="settings-notice">
            <Info size={16} className="notice-icon" />
            <p>
              Your API keys are stored entirely inside your browser's local sandbox. They are never sent to external servers except direct connections to the Google, Gemini, and RealtyAPI APIs.
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

            {/* RealtyAPI Key (Realtor + Redfin + Zillow sold records) */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="realtyApiKey">RealtyAPI Key (Realtor + Redfin + Zillow sold records)</label>
                <span className="badge required">Recommended</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="realtyApiKey"
                  type={showRealtyKey ? "text" : "password"}
                  placeholder="rt_..."
                  value={realtyApiKey}
                  onChange={(e) => setRealtyApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowRealtyKey(!showRealtyKey)}
                >
                  {showRealtyKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Scans Realtor, Redfin, and Zillow closed-sale records by coordinate radius (realtyapi.io) for new-construction sold comps — merged with the Google comp search.</p>
            </div>

            {/* DeepSeek API Key (powers the Gemini + DeepSeek fusion report) */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="deepSeekKey">DeepSeek API Key (fusion report)</label>
                <span className="badge optional">Optional</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="deepSeekKey"
                  type={showDeepSeekKey ? "text" : "password"}
                  placeholder="sk-..."
                  value={deepSeekKey}
                  onChange={(e) => setDeepSeekKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowDeepSeekKey(!showDeepSeekKey)}
                >
                  {showDeepSeekKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">When set, the AI report runs a fusion: Gemini 3.5 Flash and DeepSeek V4 Pro draft in parallel, then Gemini judges and streams the final report. Leave blank to use Gemini only. Get a key at platform.deepseek.com.</p>
            </div>

            {/* RentCast API Key (enriches buyer/deal sale prices) */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="rentCastKey">RentCast API Key (real sale prices)</label>
                <span className="badge optional">Optional</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="rentCastKey"
                  type={showRentCastKey ? "text" : "password"}
                  placeholder="rc_..."
                  value={rentCastKey}
                  onChange={(e) => setRentCastKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowRentCastKey(!showRentCastKey)}
                >
                  {showRentCastKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Enriches the Investor Buyer List with REAL last-sale prices &amp; dates from RentCast (api.rentcast.io), on demand for the buyers you choose. RentCast bills per request and free plans are limited, so enrichment is opt-in and capped. Get a key at app.rentcast.io.</p>
            </div>

            {/* newsdata.io API Key (real estate / housing news ticker) */}
            <div className="settings-field-group">
              <div className="field-label-row">
                <label htmlFor="newsDataKey">newsdata.io API Key (real estate news)</label>
                <span className="badge optional">Optional</span>
              </div>
              <div className="field-input-container">
                <Key className="input-icon" size={16} />
                <input
                  id="newsDataKey"
                  type={showNewsDataKey ? "text" : "password"}
                  placeholder="pub_..."
                  value={newsDataKey}
                  onChange={(e) => setNewsDataKey(e.target.value)}
                />
                <button
                  type="button"
                  className="field-toggle-btn"
                  onClick={() => setShowNewsDataKey(!showNewsDataKey)}
                >
                  {showNewsDataKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="field-help">Powers the auto-scrolling news strip with real estate, construction &amp; housing-market headlines (biased to North Carolina) from newsdata.io. Get a free key at newsdata.io. (Or set NEWSDATA_API_KEY in Netlify to enable it for everyone.)</p>
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
