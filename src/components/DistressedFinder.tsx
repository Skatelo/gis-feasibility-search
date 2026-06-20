import { useMemo, useRef, useState } from 'react';
import {
  Home, Trees, Search, Loader2, AlertCircle, Download, FileJson, Radar,
  MapPin, Eye, Sparkles, Target, X, Plus, Trash2, Waves, Droplets, HardHat, Landmark, Flag, User,
} from 'lucide-react';
import {
  analyzeProperty, analyzeCandidate, discoverCandidates, resultsToCsv, downloadFile, ncCountyNames,
} from '../services/propertyFinderService';
import type { SearchMode, PropertyResult, Candidate, EnvScore } from '../services/propertyFinderService';

const MODES: { id: SearchMode; label: string; icon: typeof Home; blurb: string }[] = [
  { id: 'house', label: 'Distressed Houses', icon: Home, blurb: 'Distressed-only — GIS targets absentee/estate/long-held owners; fine homes are hidden' },
  { id: 'land', label: 'Vacant Land & Builder Lots', icon: Trees, blurb: 'Buildable parcels — access, utilities, slope, FEMA flood & wetlands, nearby development' },
];

function scoreColor(score: number): string {
  if (score >= 75) return 'var(--success)';
  if (score >= 50) return 'var(--warning)';
  return 'var(--text-muted)';
}

const fmtMoney = (n?: number) => (n && n > 0 ? `$${Math.round(n).toLocaleString()}` : '—');
const fmtAcres = (n?: number) => (n && n > 0 ? `${n.toFixed(2)} ac` : '—');

function ScoreRing({ score }: { score: number }) {
  const color = scoreColor(score);
  return (
    <div className="finder-score-ring" style={{ background: `conic-gradient(${color} ${score * 3.6}deg, var(--bg-card-border) 0deg)` }}>
      <div className="finder-score-inner"><span style={{ color }}>{score}</span></div>
    </div>
  );
}

/** Small environmental badge (FEMA flood / NWI wetlands) with a source link. */
function EnvBadge({ env, icon }: { env: EnvScore; icon: 'flood' | 'wet' }) {
  const Icon = icon === 'flood' ? Waves : Droplets;
  const unknown = env.score == null;
  const color = unknown ? 'var(--text-muted)' : env.score! >= 75 ? 'var(--success)' : env.score! >= 40 ? 'var(--warning)' : 'var(--error)';
  return (
    <a className="finder-env-badge" href={env.sourceUrl} target="_blank" rel="noreferrer" title={`${env.detail} — source`} style={{ borderColor: color }}>
      <Icon size={13} style={{ color }} />
      <span className="finder-env-label">{env.label}</span>
      {!unknown && <span className="finder-env-score" style={{ color }}>{env.score}</span>}
    </a>
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
          <button className={tab === 'sat' ? 'active' : ''} onClick={() => setTab('sat')}><MapPin size={13} /> Satellite</button>
          <button className={tab === 'street' ? 'active' : ''} onClick={() => setTab('street')} disabled={!r.imagery.hasStreetView} title={r.imagery.hasStreetView ? '' : 'No Street View at this location'}>
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
        <div className="finder-confidence">AI confidence: <strong>{Math.round(r.confidence * 100)}%</strong></div>

        {r.parcel && (r.parcel.parcelId || r.parcel.acres) && (
          <div className="finder-parcel-row">
            <span><Landmark size={12} /> {r.parcel.parcelId || '—'}</span>
            <span>{fmtAcres(r.parcel.acres)}</span>
            <span title="Assessed value">{fmtMoney(r.parcel.assessedValue)}</span>
          </div>
        )}

        {/* GIS distress / motivated-seller lead signals (house mode) */}
        {r.mode === 'house' && r.parcel?.ownerName && (
          <div className="finder-owner" title="Owner of record (public assessor data)"><User size={12} /> {r.parcel.ownerName}</div>
        )}
        {r.mode === 'house' && r.parcel?.gisSignals && r.parcel.gisSignals.length > 0 && (
          <div className="finder-lead-row">
            {r.parcel.gisSignals.map((s, i) => <span key={i} className="finder-lead-chip"><Flag size={11} /> {s}</span>)}
          </div>
        )}

        {(r.flood || r.wetlands || r.builderInterest) && (
          <div className="finder-env-row">
            {r.flood && <EnvBadge env={r.flood} icon="flood" />}
            {r.wetlands && <EnvBadge env={r.wetlands} icon="wet" />}
            {r.builderInterest && (
              <span className={`finder-builder-badge bi-${r.builderInterest}`} title="Builder interest">
                <HardHat size={13} /> Builder: {r.builderInterest}
              </span>
            )}
          </div>
        )}

        {r.observations.summary && <p className="finder-summary">{r.observations.summary}</p>}

        {r.reasons.length > 0 && (
          <div className="finder-reasons">
            {r.reasons.map((reason, i) => <span key={i} className="finder-reason-chip">{reason}</span>)}
          </div>
        )}

        <div className="finder-recommendation"><Target size={14} /> {r.recommendation}</div>
      </div>
    </div>
  );
}

export function DistressedFinder() {
  const [mode, setMode] = useState<SearchMode>('house');
  const [tab, setTab] = useState<'auto' | 'manual'>('auto');

  // Area-scan (auto) inputs
  const [county, setCounty] = useState('Gaston');
  const [cityZip, setCityZip] = useState('');
  const [radius, setRadius] = useState(0.75);
  const [minAcres, setMinAcres] = useState(0.15);
  const [maxAcres, setMaxAcres] = useState(20);
  const [maxAnalyze, setMaxAnalyze] = useState(12);

  // Manual inputs
  const [addressInput, setAddressInput] = useState('');
  const [queue, setQueue] = useState<string[]>([]);

  // Shared state
  const [results, setResults] = useState<PropertyResult[]>([]);
  const [errors, setErrors] = useState<{ address: string; message: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [minScore, setMinScore] = useState(0);
  const [scanSummary, setScanSummary] = useState('');
  const stopRef = useRef(false); // set by the Stop button to halt a long scan

  const keysConfigured = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user') || '{}');
      return !!(u.keys?.googleMaps && u.keys?.gemini);
    } catch { return false; }
  }, []);

  const parseAddresses = (raw: string): string[] => raw.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);

  const addToQueue = () => {
    const parsed = parseAddresses(addressInput);
    if (!parsed.length) return;
    setQueue((q) => Array.from(new Set([...q, ...parsed])));
    setAddressInput('');
  };
  const removeFromQueue = (addr: string) => setQueue((q) => q.filter((a) => a !== addr));

  /** Run vision analysis sequentially over a set of pending jobs. */
  const analyzeBatch = async (
    jobs: Array<{ label: string; run: (onStage: (s: string) => void) => Promise<PropertyResult> }>,
  ) => {
    const errs: { address: string; message: string }[] = [];
    setProgress({ done: 0, total: jobs.length });
    for (let i = 0; i < jobs.length; i++) {
      if (stopRef.current) break;
      const job = jobs[i];
      setStage(`(${i + 1}/${jobs.length}) ${job.label}`);
      try {
        const res = await job.run((s) => setStage(`(${i + 1}/${jobs.length}) ${s}`));
        setResults((prev) => [...prev.filter((p) => !(p.lat === res.lat && p.lng === res.lng && p.mode === res.mode)), res]);
      } catch (e: any) {
        errs.push({ address: job.label, message: e?.message || 'Analysis failed' });
      }
      setProgress({ done: i + 1, total: jobs.length });
    }
    return errs;
  };

  // Safety ceiling on vision calls per scan, so an area with few distressed homes
  // can't run away with the API budget. The Stop button also halts at any time.
  const SAFETY_MAX_ANALYSES = 300;

  const runAutoScan = async () => {
    setRunning(true);
    setErrors([]);
    setScanSummary('');
    stopRef.current = false;
    setStage('Discovering parcels…');
    try {
      const [city, zip] = (() => {
        const v = cityZip.trim();
        if (!v) return [undefined, undefined] as const;
        return /^\d{5}$/.test(v) ? ([undefined, v] as const) : ([v, undefined] as const);
      })();
      const pool: Candidate[] = await discoverCandidates(
        { county, city, zip, mode, radiusMiles: radius, minAcres, maxAcres },
        (s) => setStage(s),
      );

      const errs: { address: string; message: string }[] = [];

      if (mode === 'land') {
        // Land has no "distressed" gate, so analyze the first maxAnalyze parcels.
        const targets = pool.slice(0, maxAnalyze);
        setProgress({ done: 0, total: targets.length });
        let done = 0;
        for (const c of targets) {
          if (stopRef.current) break;
          setStage(`(${done + 1}/${targets.length}) ${c.address}`);
          try {
            const res = await analyzeCandidate(c, mode, (s) => setStage(`(${done + 1}/${targets.length}) ${s}`));
            setResults((prev) => [...prev.filter((p) => !(p.lat === res.lat && p.lng === res.lng && p.mode === res.mode)), res]);
          } catch (e: any) {
            errs.push({ address: c.address, message: e?.message || 'Analysis failed' });
          }
          done++;
          setProgress({ done, total: targets.length });
        }
        setScanSummary(`Analyzed ${done} of ${pool.length} candidate parcels.`);
      } else {
        // HOUSE: keep analyzing the ranked pool until we've FOUND maxAnalyze
        // distressed homes (or the pool / safety ceiling / Stop button ends it).
        const ceiling = Math.min(pool.length, SAFETY_MAX_ANALYSES);
        setProgress({ done: 0, total: maxAnalyze });
        let analyzed = 0;
        let found = 0;
        for (const c of pool) {
          if (stopRef.current || found >= maxAnalyze || analyzed >= ceiling) break;
          analyzed++;
          setStage(`Found ${found}/${maxAnalyze} distressed · analyzing #${analyzed} — ${c.address}`);
          try {
            const res = await analyzeCandidate(c, mode, (s) =>
              setStage(`Found ${found}/${maxAnalyze} distressed · analyzing #${analyzed} — ${s}`),
            );
            if (res.distressed) {
              found++;
              setResults((prev) => [...prev.filter((p) => !(p.lat === res.lat && p.lng === res.lng && p.mode === res.mode)), res]);
              setProgress({ done: found, total: maxAnalyze });
            }
          } catch (e: any) {
            errs.push({ address: c.address, message: e?.message || 'Analysis failed' });
          }
        }
        const hitCeiling = analyzed >= ceiling && found < maxAnalyze && !stopRef.current;
        setScanSummary(
          `Found ${found} distressed home${found === 1 ? '' : 's'} after analyzing ${analyzed} of ${pool.length} ranked parcels` +
            (stopRef.current ? ' (stopped).' : hitCeiling ? ` (reached the ${SAFETY_MAX_ANALYSES}-parcel safety limit).` : '.'),
        );
      }

      setErrors(errs);
    } catch (e: any) {
      setErrors([{ address: `${county}${cityZip ? ` · ${cityZip}` : ''}`, message: e?.message || 'Discovery failed' }]);
    } finally {
      setRunning(false);
      setStage('');
    }
  };

  const runManualScan = async () => {
    const targets = queue.length ? queue : parseAddresses(addressInput);
    if (!targets.length) return;
    setRunning(true);
    setErrors([]);
    setScanSummary('');
    stopRef.current = false;
    const jobs = targets.map((addr) => ({ label: addr, run: (onStage: (s: string) => void) => analyzeProperty(addr, mode, onStage) }));
    const errs = await analyzeBatch(jobs);
    setErrors(errs);
    setRunning(false);
    setStage('');
    if (errs.length < targets.length) setQueue([]);
  };

  const stopScan = () => { stopRef.current = true; setStage('Stopping…'); };

  const visibleResults = useMemo(
    () =>
      results
        // House mode: ONLY show homes that actually look distressed (never fine houses).
        .filter((r) => r.mode === mode && r.score >= minScore && (mode !== 'house' || r.distressed))
        // Most distressed first; among ties, the strongest GIS motivated-seller lead.
        .sort((a, b) => b.score - a.score || (b.parcel?.gisDistress ?? 0) - (a.parcel?.gisDistress ?? 0)),
    [results, mode, minScore],
  );

  const exportCsv = () => visibleResults.length && downloadFile(`property-finder-${mode}-${Date.now()}.csv`, resultsToCsv(visibleResults), 'text/csv');
  const exportJson = () => visibleResults.length && downloadFile(`property-finder-${mode}-${Date.now()}.json`, JSON.stringify(visibleResults, null, 2), 'application/json');

  const scoreWord = mode === 'house' ? 'distress' : 'land';
  const manualCount = queue.length || parseAddresses(addressInput).length;

  return (
    <div className="finder-page">
      <div className="finder-hero">
        <div className="finder-hero-badge"><Sparkles size={14} /> AI Vision + GIS Pipeline</div>
        <h2>AI Distressed Property &amp; Vacant Land Finder</h2>
        <p>
          Auto-scans an area from the <strong>NC OneMap GIS parcel layer</strong>, prefilters candidates on parcel
          attributes, then routes Google satellite + Street View imagery to <strong>Gemini Vision</strong> and scores
          each property. Land is cross-checked against <strong>authoritative FEMA flood zones</strong> and{' '}
          <strong>USFWS wetlands</strong> — like an investor scanning the map, automated.
        </p>
      </div>

      {!keysConfigured && (
        <div className="finder-alert">
          <AlertCircle size={18} />
          <span>Set your <strong>Google Maps</strong> and <strong>Gemini</strong> API keys in Account Settings (top-right) — both are required.</span>
        </div>
      )}

      {/* Mode toggle */}
      <div className="finder-mode-toggle finder-mode-2">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <button key={m.id} className={`finder-mode-btn ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)} type="button">
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
        <div className="finder-tabs">
          <button className={tab === 'auto' ? 'active' : ''} onClick={() => setTab('auto')} type="button"><Radar size={15} /> Auto-discover (scan an area)</button>
          <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')} type="button"><MapPin size={15} /> Manual addresses</button>
        </div>

        {tab === 'auto' ? (
          <div className="finder-area-form">
            <div className="finder-field">
              <label>County</label>
              <select value={county} onChange={(e) => setCounty(e.target.value)}>
                {ncCountyNames.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="finder-field">
              <label>City or ZIP <span>(optional — centers the scan)</span></label>
              <input type="text" value={cityZip} onChange={(e) => setCityZip(e.target.value)} placeholder="Gastonia  ·  or  28052" />
            </div>
            <div className="finder-field">
              <label>Scan radius: <strong>{radius.toFixed(2)} mi</strong></label>
              <input type="range" min={0.25} max={2} step={0.25} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            </div>
            {mode === 'land' && (
              <div className="finder-field finder-field-acres">
                <label>Acreage band</label>
                <div className="finder-acre-inputs">
                  <input type="number" min={0} step={0.1} value={minAcres} onChange={(e) => setMinAcres(Number(e.target.value))} />
                  <span>to</span>
                  <input type="number" min={0} step={1} value={maxAcres} onChange={(e) => setMaxAcres(Number(e.target.value))} />
                  <span>ac</span>
                </div>
              </div>
            )}
            <div className="finder-field">
              <label>
                {mode === 'house'
                  ? <>Distressed homes to find: <strong>{maxAnalyze}</strong> <span>(keeps analyzing until found)</span></>
                  : <>Parcels to analyze: <strong>{maxAnalyze}</strong> <span>(Gemini Vision calls)</span></>}
              </label>
              <input type="range" min={4} max={40} step={2} value={maxAnalyze} onChange={(e) => setMaxAnalyze(Number(e.target.value))} />
            </div>
            <div className="finder-area-actions">
              {running ? (
                <button className="finder-btn-stop" onClick={stopScan} type="button"><X size={16} /> Stop scan</button>
              ) : (
                <button className="finder-btn-primary" onClick={runAutoScan} type="button">
                  <Radar size={16} /> Scan {county}{cityZip ? ` · ${cityZip}` : ''}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <label className="finder-input-label">Property addresses <span>(one per line, or separated by “;”)</span></label>
            <textarea className="finder-textarea" value={addressInput} onChange={(e) => setAddressInput(e.target.value)} rows={3}
              placeholder={'123 Main St, Gastonia, NC 28052\n456 Oak Ave, Charlotte, NC 28278'} />
            <div className="finder-search-actions">
              <button className="finder-btn-secondary" onClick={addToQueue} type="button" disabled={!addressInput.trim()}><Plus size={16} /> Add to batch</button>
              <button className="finder-btn-primary" onClick={runManualScan} type="button" disabled={running || !manualCount}>
                {running ? <Loader2 size={16} className="finder-spin" /> : <Search size={16} />}
                {running ? 'Scanning…' : `Scan ${manualCount || ''} ${manualCount === 1 ? 'property' : 'properties'}`}
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
                    <span key={a} className="finder-queue-chip">{a}<button onClick={() => removeFromQueue(a)} type="button" aria-label="remove"><X size={12} /></button></span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div className="finder-min-score">
          <label>Min {scoreWord} score to show: <strong>{minScore}</strong></label>
          <input type="range" min={0} max={100} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
        </div>

        {running && (
          <div className="finder-progress">
            <Loader2 size={14} className="finder-spin" />
            <span>{stage}</span>
            <div className="finder-progress-bar"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
            <button className="finder-btn-stop finder-btn-stop-sm" onClick={stopScan} type="button"><X size={13} /> Stop</button>
          </div>
        )}

        {!running && scanSummary && <div className="finder-scan-summary">{scanSummary}</div>}
      </div>

      {errors.length > 0 && (
        <div className="finder-errors">
          {errors.map((e, i) => <div key={i} className="finder-error-row"><AlertCircle size={14} /> <strong>{e.address}</strong>: {e.message}</div>)}
        </div>
      )}

      {visibleResults.length > 0 && (
        <>
          <div className="finder-results-head">
            <h3>{visibleResults.length} {MODES.find((m) => m.id === mode)?.label}</h3>
            <div className="finder-export-actions">
              <button className="finder-btn-secondary" onClick={exportCsv} type="button"><Download size={15} /> CSV</button>
              <button className="finder-btn-secondary" onClick={exportJson} type="button"><FileJson size={15} /> JSON</button>
            </div>
          </div>
          <div className="finder-results-grid">{visibleResults.map((r) => <ResultCard key={r.id} r={r} />)}</div>
        </>
      )}

      {!running && visibleResults.length === 0 && mode === 'house' && scanSummary && (
        <div className="finder-empty">
          Only distressed homes are shown (well-maintained homes are hidden by design). If nothing was found,
          try another City/ZIP or a different radius — or increase the radius to widen the search.
        </div>
      )}
      {!running && visibleResults.length === 0 && mode === 'land' && results.some((r) => r.mode === 'land') && (
        <div className="finder-empty">No results at or above a score of {minScore}. Lower the minimum score filter.</div>
      )}
    </div>
  );
}
