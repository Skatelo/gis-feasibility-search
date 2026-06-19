import { useMemo, useState } from 'react';
import {
  Home, Trees, HardHat, Search, Loader2, AlertCircle, Download, FileJson,
  MapPin, Eye, Sparkles, Target, X, Plus, Trash2,
} from 'lucide-react';
import {
  analyzeProperty, resultsToCsv, downloadFile,
} from '../services/propertyFinderService';
import type { SearchMode, PropertyResult } from '../services/propertyFinderService';

const MODES: { id: SearchMode; label: string; icon: typeof Home; blurb: string }[] = [
  { id: 'house', label: 'Distressed Houses', icon: Home, blurb: 'Wholesale / fix-and-flip / rental acquisition candidates' },
  { id: 'land', label: 'Vacant Land', icon: Trees, blurb: 'Buildable parcels — access, utilities, terrain, flood' },
  { id: 'builder', label: 'Builder Lots', icon: HardHat, blurb: 'Lots builders would likely purchase near active construction' },
];

function scoreColor(score: number): string {
  if (score >= 75) return 'var(--success)';
  if (score >= 50) return 'var(--warning)';
  return 'var(--text-muted)';
}

function ScoreRing({ score }: { score: number }) {
  const color = scoreColor(score);
  return (
    <div
      className="finder-score-ring"
      style={{ background: `conic-gradient(${color} ${score * 3.6}deg, var(--bg-card-border) 0deg)` }}
    >
      <div className="finder-score-inner">
        <span style={{ color }}>{score}</span>
      </div>
    </div>
  );
}

function ResultCard({ r }: { r: PropertyResult }) {
  const [tab, setTab] = useState<'sat' | 'street'>('sat');
  const showStreet = tab === 'street' && r.imagery.streetViewUrl;
  const imgUrl = showStreet ? r.imagery.streetViewUrl! : r.imagery.satelliteUrl;

  return (
    <div className="finder-result-card">
      <div className="finder-result-media">
        <img src={imgUrl} alt={`${tab} view of ${r.address}`} loading="lazy" />
        <div className="finder-media-tabs">
          <button className={tab === 'sat' ? 'active' : ''} onClick={() => setTab('sat')}>
            <MapPin size={13} /> Satellite
          </button>
          <button
            className={tab === 'street' ? 'active' : ''}
            onClick={() => setTab('street')}
            disabled={!r.imagery.hasStreetView}
            title={r.imagery.hasStreetView ? '' : 'No Street View at this location'}
          >
            <Eye size={13} /> Street
          </button>
        </div>
        <div className="finder-score-badge" style={{ borderColor: scoreColor(r.score) }}>
          <ScoreRing score={r.score} />
          <span className="finder-score-label">{r.scoreLabel}</span>
        </div>
      </div>

      <div className="finder-result-body">
        <div className="finder-result-addr" title={r.address}>{r.address}</div>
        <div className="finder-confidence">
          AI confidence: <strong>{Math.round(r.confidence * 100)}%</strong>
        </div>

        {r.observations.summary && <p className="finder-summary">{r.observations.summary}</p>}

        {r.reasons.length > 0 && (
          <div className="finder-reasons">
            {r.reasons.map((reason, i) => (
              <span key={i} className="finder-reason-chip">{reason}</span>
            ))}
          </div>
        )}

        <div className="finder-recommendation">
          <Target size={14} /> {r.recommendation}
        </div>
      </div>
    </div>
  );
}

export function DistressedFinder() {
  const [mode, setMode] = useState<SearchMode>('house');
  const [addressInput, setAddressInput] = useState('');
  const [queue, setQueue] = useState<string[]>([]);
  const [results, setResults] = useState<PropertyResult[]>([]);
  const [errors, setErrors] = useState<{ address: string; message: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [minScore, setMinScore] = useState(0);

  const keysConfigured = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user') || '{}');
      return !!(u.keys?.googleMaps && u.keys?.gemini);
    } catch { return false; }
  }, []);

  const parseAddresses = (raw: string): string[] =>
    raw.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);

  const addToQueue = () => {
    const parsed = parseAddresses(addressInput);
    if (!parsed.length) return;
    setQueue((q) => Array.from(new Set([...q, ...parsed])));
    setAddressInput('');
  };

  const removeFromQueue = (addr: string) => setQueue((q) => q.filter((a) => a !== addr));

  const runScan = async () => {
    const targets = queue.length ? queue : parseAddresses(addressInput);
    if (!targets.length) return;
    setRunning(true);
    setErrors([]);
    setProgress({ done: 0, total: targets.length });

    const fresh: PropertyResult[] = [];
    const errs: { address: string; message: string }[] = [];

    // Sequential to respect per-property staged progress and avoid key rate limits.
    for (let i = 0; i < targets.length; i++) {
      const addr = targets[i];
      setStage(`(${i + 1}/${targets.length}) ${addr}`);
      try {
        const res = await analyzeProperty(addr, mode, (s) => setStage(`(${i + 1}/${targets.length}) ${s}`));
        fresh.push(res);
        setResults((prev) => [...prev.filter((p) => p.address !== res.address || p.mode !== res.mode), res]);
      } catch (e: any) {
        errs.push({ address: addr, message: e?.message || 'Analysis failed' });
      }
      setProgress({ done: i + 1, total: targets.length });
    }

    setErrors(errs);
    setRunning(false);
    setStage('');
    if (fresh.length) setQueue([]);
  };

  const visibleResults = useMemo(
    () => results.filter((r) => r.mode === mode && r.score >= minScore).sort((a, b) => b.score - a.score),
    [results, mode, minScore],
  );

  const exportCsv = () => {
    if (!visibleResults.length) return;
    downloadFile(`property-finder-${mode}-${Date.now()}.csv`, resultsToCsv(visibleResults), 'text/csv');
  };
  const exportJson = () => {
    if (!visibleResults.length) return;
    downloadFile(`property-finder-${mode}-${Date.now()}.json`, JSON.stringify(visibleResults, null, 2), 'application/json');
  };

  return (
    <div className="finder-page">
      <div className="finder-hero">
        <div className="finder-hero-badge"><Sparkles size={14} /> AI Vision Pipeline</div>
        <h2>AI Distressed Property &amp; Vacant Land Finder</h2>
        <p>
          Acquires Google satellite + Street View imagery for each property, routes it to{' '}
          <strong>Gemini Vision</strong> for structured detection, then scores distress, buildability,
          and builder interest using weighted real-estate logic — like an investor scanning the map, at scale.
        </p>
      </div>

      {!keysConfigured && (
        <div className="finder-alert">
          <AlertCircle size={18} />
          <span>
            Set your <strong>Google Maps</strong> and <strong>Gemini</strong> API keys in Account Settings
            (top-right) — both are required to acquire imagery and run vision analysis.
          </span>
        </div>
      )}

      {/* Mode toggle */}
      <div className="finder-mode-toggle">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              className={`finder-mode-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => setMode(m.id)}
              type="button"
            >
              <Icon size={20} />
              <div>
                <div className="finder-mode-label">{m.label}</div>
                <div className="finder-mode-blurb">{m.blurb}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Search panel */}
      <div className="finder-search-panel">
        <label className="finder-input-label">
          Property addresses <span>(one per line, or separated by “;”)</span>
        </label>
        <textarea
          className="finder-textarea"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder={'123 Main St, Gastonia, NC 28052\n456 Oak Ave, Charlotte, NC 28278'}
          rows={3}
        />
        <div className="finder-search-actions">
          <button className="finder-btn-secondary" onClick={addToQueue} type="button" disabled={!addressInput.trim()}>
            <Plus size={16} /> Add to batch
          </button>
          <div className="finder-min-score">
            <label>Min {mode === 'house' ? 'distress' : mode === 'builder' ? 'builder' : 'buildability'} score: <strong>{minScore}</strong></label>
            <input type="range" min={0} max={100} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
          </div>
          <button
            className="finder-btn-primary"
            onClick={runScan}
            type="button"
            disabled={running || (!queue.length && !addressInput.trim())}
          >
            {running ? <Loader2 size={16} className="finder-spin" /> : <Search size={16} />}
            {running ? 'Scanning…' : `Scan ${queue.length || parseAddresses(addressInput).length || ''} ${(queue.length || parseAddresses(addressInput).length) === 1 ? 'property' : 'properties'}`}
          </button>
        </div>

        {queue.length > 0 && (
          <div className="finder-queue">
            <div className="finder-queue-head">
              <span>Batch queue ({queue.length})</span>
              <button onClick={() => setQueue([])} type="button"><Trash2 size={13} /> Clear</button>
            </div>
            <div className="finder-queue-chips">
              {queue.map((a) => (
                <span key={a} className="finder-queue-chip">
                  {a}
                  <button onClick={() => removeFromQueue(a)} type="button" aria-label="remove"><X size={12} /></button>
                </span>
              ))}
            </div>
          </div>
        )}

        {running && (
          <div className="finder-progress">
            <Loader2 size={14} className="finder-spin" />
            <span>{stage}</span>
            <div className="finder-progress-bar">
              <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="finder-errors">
          {errors.map((e, i) => (
            <div key={i} className="finder-error-row">
              <AlertCircle size={14} /> <strong>{e.address}</strong>: {e.message}
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {visibleResults.length > 0 && (
        <>
          <div className="finder-results-head">
            <h3>{visibleResults.length} {MODES.find((m) => m.id === mode)?.label}</h3>
            <div className="finder-export-actions">
              <button className="finder-btn-secondary" onClick={exportCsv} type="button"><Download size={15} /> CSV</button>
              <button className="finder-btn-secondary" onClick={exportJson} type="button"><FileJson size={15} /> JSON</button>
            </div>
          </div>
          <div className="finder-results-grid">
            {visibleResults.map((r) => <ResultCard key={r.id} r={r} />)}
          </div>
        </>
      )}

      {!running && visibleResults.length === 0 && results.some((r) => r.mode === mode) && (
        <div className="finder-empty">No results at or above a score of {minScore}. Lower the minimum score filter.</div>
      )}
    </div>
  );
}
