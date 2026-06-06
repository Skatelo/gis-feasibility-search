import { FeasibilitySearch } from './components/FeasibilitySearch';
import { Database, FileJson, Globe } from 'lucide-react';

function App() {
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
        
        <div className="header-status">
          <span className="status-dot"></span>
          <span>NC OneMap & Charlotte GIS Services Online</span>
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
    </>
  );
}

export default App;
