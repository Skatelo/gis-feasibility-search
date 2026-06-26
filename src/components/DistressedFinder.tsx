import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Home, Trees, Search, Loader2, AlertCircle, Download, FileJson, Radar,
  MapPin, Eye, Sparkles, Target, X, Plus, Trash2, Waves, Droplets, HardHat, Landmark, Flag, User, Users, Building2, Database, Check, Mountain, Mail,
} from 'lucide-react';
import {
  analyzeProperty, analyzeCandidate, discoverCandidates, buildBuyerList, buildBuyerDatabase,
  rentCastLastSale, buyerLookupAddress, geocodeDealCounty, matchBuyersToDeal,
  saveBuyerDatabase, loadBuyerDatabase, clearBuyerDatabase,
  resultsToCsv, buyersToCsv, downloadFile, ncCountyNames,
} from '../services/propertyFinderService';
import type { SearchMode, PropertyResult, Candidate, EnvScore, BuyerRecord, SavedBuyerDatabase } from '../services/propertyFinderService';

/** Read the signed-in user's API keys from local/session storage. */
function readUserKeys(): { googleMaps?: string; gemini?: string; rentCast?: string } {
  try {
    const u = JSON.parse(localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user') || '{}');
    return u.keys || {};
  } catch { return {}; }
}

type UiMode = SearchMode | 'buyers';

// Charlotte-metro + western Piedmont counties for the multi-county buyer database.
const METRO_COUNTIES = ['Gaston', 'Mecklenburg', 'Cabarrus', 'Union', 'Lincoln', 'Iredell', 'Catawba', 'Cleveland', 'Rowan', 'Stanly'];
const BIG_COUNTIES = new Set(['Mecklenburg', 'Wake', 'Guilford', 'Forsyth']); // large → slower scan

const MODES: { id: UiMode; label: string; icon: typeof Home; blurb: string }[] = [
  { id: 'house', label: 'Distressed Houses', icon: Home, blurb: 'Distressed-only — GIS targets absentee/estate/long-held owners; fine homes are hidden' },
  { id: 'land', label: 'Vacant Land & Builder Lots', icon: Trees, blurb: 'Buildable parcels — access, utilities, slope, FEMA flood & wetlands, nearby development' },
  { id: 'buyers', label: 'Investor Buyer List', icon: Users, blurb: 'Cash buyers from county tax records — owners holding multiple parcels (LLCs, landlords, out-of-state)' },
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

/** Small environmental badge (FEMA flood / NWI wetlands / USGS 3DEP slope) with a source link. */
function EnvBadge({ env, icon }: { env: EnvScore; icon: 'flood' | 'wet' | 'slope' }) {
  const Icon = icon === 'flood' ? Waves : icon === 'slope' ? Mountain : Droplets;
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

        {/* Owner of record + mailing address (NC GIS / county tax records) */}
        {r.parcel?.ownerName && (
          <div className="finder-owner" title="Owner of record (NC GIS / county tax records)"><User size={12} /> {r.parcel.ownerName}</div>
        )}
        {r.parcel?.mailingAddress && (
          <div className="finder-owner finder-owner-mail" title="Owner mailing address — where the county sends tax bills"><Mail size={12} /> {r.parcel.mailingAddress}</div>
        )}
        {r.mode === 'house' && r.parcel?.gisSignals && r.parcel.gisSignals.length > 0 && (
          <div className="finder-lead-row">
            {r.parcel.gisSignals.map((s, i) => <span key={i} className="finder-lead-chip"><Flag size={11} /> {s}</span>)}
          </div>
        )}

        {(r.flood || r.wetlands || r.slope || r.builderInterest) && (
          <div className="finder-env-row">
            {r.slope && <EnvBadge env={r.slope} icon="slope" />}
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
  const [mode, setMode] = useState<UiMode>('house');
  const [tab, setTab] = useState<'auto' | 'manual'>('auto');

  // Area-scan (auto) inputs
  const [county, setCounty] = useState('Gaston');
  const [cityZip, setCityZip] = useState('');
  const [radius, setRadius] = useState(0.75);
  const [minAcres, setMinAcres] = useState(0.15);
  const [maxAcres, setMaxAcres] = useState(20);
  const [maxAnalyze, setMaxAnalyze] = useState(12);

  // Buyer-list inputs/results
  const [minProperties, setMinProperties] = useState(3);
  const [dealAddress, setDealAddress] = useState('');
  const [dealContext, setDealContext] = useState('');
  const [buyers, setBuyers] = useState<BuyerRecord[]>([]);
  const [buyerFilter, setBuyerFilter] = useState<'all' | 'house' | 'land'>('all');
  const [buyerClass, setBuyerClass] = useState<'all' | 'llc' | 'builder' | 'developer' | 'individual'>('all');
  const [buyerSort, setBuyerSort] = useState<'recent' | 'props' | 'distance' | 'score'>('recent');
  const [buyerScope, setBuyerScope] = useState<'area' | 'database'>('area');
  const [dbCounties, setDbCounties] = useState<string[]>(['Gaston', 'Cabarrus', 'Union', 'Lincoln']);
  const [savedDb, setSavedDb] = useState<SavedBuyerDatabase | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichNote, setEnrichNote] = useState('');
  // Deal matching against the saved database (county-based, instant).
  const [dbDealInput, setDbDealInput] = useState('');
  const [dealMatch, setDealMatch] = useState<{ county?: string; label: string } | null>(null);
  const [matching, setMatching] = useState(false);

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

  // Load any previously-saved buyer database (IndexedDB) once on mount.
  useEffect(() => { loadBuyerDatabase().then((db) => { if (db) setSavedDb(db); }).catch(() => {}); }, []);

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

  const runAutoScan = async () => {
    // Only the property modes reach this; narrow 'buyers' out of the vision path.
    const sMode: SearchMode = mode === 'land' ? 'land' : 'house';
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
        { county, city, zip, mode: sMode, radiusMiles: radius, minAcres, maxAcres },
        (s) => setStage(s),
      );

      const errs: { address: string; message: string }[] = [];

      if (sMode === 'land') {
        // Land has no "distressed" gate, so analyze the first maxAnalyze parcels.
        const targets = pool.slice(0, maxAnalyze);
        setProgress({ done: 0, total: targets.length });
        let done = 0;
        for (const c of targets) {
          if (stopRef.current) break;
          setStage(`(${done + 1}/${targets.length}) ${c.address}`);
          try {
            const res = await analyzeCandidate(c, sMode, (s) => setStage(`(${done + 1}/${targets.length}) ${s}`));
            setResults((prev) => [...prev.filter((p) => !(p.lat === res.lat && p.lng === res.lng && p.mode === res.mode)), res]);
          } catch (e: any) {
            errs.push({ address: c.address, message: e?.message || 'Analysis failed' });
          }
          done++;
          setProgress({ done, total: targets.length });
        }
        setScanSummary(`Analyzed ${done} of ${pool.length} candidate parcels.`);
      } else {
        // HOUSE: work straight DOWN the ranked pool (best leads first) and keep
        // going until we've FOUND maxAnalyze distressed homes or the WHOLE area
        // is exhausted (or Stop). Ranking orders the search; it never caps it.
        setProgress({ done: 0, total: maxAnalyze });
        let analyzed = 0;
        let found = 0;
        for (const c of pool) {
          if (stopRef.current || found >= maxAnalyze) break;
          analyzed++;
          setStage(`Found ${found}/${maxAnalyze} distressed · analyzing #${analyzed} of ${pool.length} — ${c.address}`);
          try {
            const res = await analyzeCandidate(c, sMode, (s) =>
              setStage(`Found ${found}/${maxAnalyze} distressed · analyzing #${analyzed} of ${pool.length} — ${s}`),
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
        setScanSummary(
          `Found ${found} distressed home${found === 1 ? '' : 's'} after analyzing ${analyzed} of ${pool.length} ranked parcels` +
            (stopRef.current ? ' (stopped).' : found >= maxAnalyze ? '.' : ' (whole area scanned).'),
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
    const sMode: SearchMode = mode === 'land' ? 'land' : 'house';
    const targets = queue.length ? queue : parseAddresses(addressInput);
    if (!targets.length) return;
    setRunning(true);
    setErrors([]);
    setScanSummary('');
    stopRef.current = false;
    const jobs = targets.map((addr) => ({ label: addr, run: (onStage: (s: string) => void) => analyzeProperty(addr, sMode, onStage) }));
    const errs = await analyzeBatch(jobs);
    setErrors(errs);
    setRunning(false);
    setStage('');
    if (errs.length < targets.length) setQueue([]);
  };

  const runBuyerList = async () => {
    setRunning(true);
    setErrors([]);
    setScanSummary('');
    setBuyers([]);
    setBuyerFilter('all');
    setBuyerClass('all');
    stopRef.current = false;
    const deal = dealAddress.trim();
    setDealContext(deal);
    // Default: recent buyers first (this year's buyers up top); with a deal,
    // default to nearest-to-deal since that's the point of the address search.
    setBuyerSort(deal ? 'distance' : 'recent');
    setStage('Building buyer list…');
    try {
      const [city, zip] = (() => {
        const v = cityZip.trim();
        if (!v) return [undefined, undefined] as const;
        return /^\d{5}$/.test(v) ? ([undefined, v] as const) : ([v, undefined] as const);
      })();
      const list = await buildBuyerList(
        { county, city, zip, radiusMiles: Math.max(1, radius), minProperties, dealAddress: deal || undefined },
        (s) => setStage(s),
        () => stopRef.current,
      );
      setBuyers(list);
      const asOf = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      setScanSummary(
        (deal
          ? `${list.length} investor buyer${list.length === 1 ? '' : 's'} holding ${minProperties}+ parcels within ${Math.max(1, radius)} mi of ${deal}${stopRef.current ? ' (stopped early)' : ''} — closest first.`
          : `${list.length} investor/owner${list.length === 1 ? '' : 's'} holding ${minProperties}+ parcels in ${county}${cityZip ? ` · ${cityZip}` : ''}` +
              (stopRef.current ? ' (stopped early).' : '.')) +
          ` Live county records as of ${asOf} — rebuild to pick up new transactions.`,
      );
    } catch (e: any) {
      setErrors([{ address: deal || `${county}${cityZip ? ` · ${cityZip}` : ''}`, message: e?.message || 'Buyer-list build failed' }]);
    } finally {
      setRunning(false);
      setStage('');
    }
  };

  const runBuyerDatabase = async () => {
    if (!dbCounties.length) return;
    setRunning(true);
    setErrors([]);
    setScanSummary('');
    setBuyers([]);
    setBuyerFilter('all');
    setBuyerClass('all');
    setDealContext('');
    setBuyerSort('score');
    stopRef.current = false;
    setStage('Building buyer database…');
    try {
      const list = await buildBuyerDatabase(dbCounties, minProperties, (s) => setStage(s), () => stopRef.current);
      setBuyers(list);
      setDealMatch(null);
      // Persist so deals can be matched instantly later (and across reloads).
      const dbRecord: SavedBuyerDatabase = { counties: dbCounties, minProperties, builtAt: Date.now(), buyers: list };
      try { await saveBuyerDatabase(dbRecord); setSavedDb(dbRecord); } catch { /* ignore quota */ }
      const asOf = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      setScanSummary(
        `${list.length.toLocaleString()} investor buyers holding ${minProperties}+ parcels across ${dbCounties.length} ${dbCounties.length === 1 ? 'county' : 'counties'} (${dbCounties.join(', ')})` +
          `${stopRef.current ? ' — stopped early' : ''}. Saved for instant deal matching · ranked by activity score · live as of ${asOf}.`,
      );
    } catch (e: any) {
      setErrors([{ address: dbCounties.join(', '), message: e?.message || 'Buyer database build failed' }]);
    } finally {
      setRunning(false);
      setStage('');
    }
  };

  const toggleDbCounty = (c: string) =>
    setDbCounties((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  /** Load the previously-saved database instantly (no scan). */
  const loadSavedDb = () => {
    if (!savedDb) return;
    setBuyers(savedDb.buyers);
    setBuyerScope('database');
    setBuyerFilter('all');
    setBuyerClass('all');
    setBuyerSort('score');
    setDealContext('');
    setDealMatch(null);
    setErrors([]);
    setDbCounties(savedDb.counties);
    setScanSummary(
      `Loaded saved database: ${savedDb.buyers.length.toLocaleString()} buyers across ${savedDb.counties.join(', ')} (built ${new Date(savedDb.builtAt).toLocaleDateString()}). Enter a deal address to match instantly.`,
    );
  };

  const deleteSavedDb = async () => { await clearBuyerDatabase(); setSavedDb(null); };

  /** Match a deal address against the loaded database (county-based, instant). */
  const runDealMatch = async () => {
    const addr = dbDealInput.trim();
    if (!addr || !buyers.length) return;
    setMatching(true);
    setErrors([]);
    try {
      const keys = readUserKeys();
      if (!keys.googleMaps) throw new Error('Google Maps API key required.');
      const res = await geocodeDealCounty(addr, keys.googleMaps);
      if (!res) throw new Error(`Could not locate "${addr}".`);
      setDealMatch({ county: res.county, label: addr });
      setBuyerSort('score');
    } catch (e: any) {
      setErrors([{ address: addr, message: e?.message || 'Deal match failed' }]);
    } finally {
      setMatching(false);
    }
  };

  /** Enrich the currently-visible buyers' most-recent sale with RentCast (capped). */
  const RENTCAST_MAX = 25;
  const enrichWithRentCast = async () => {
    const keys = readUserKeys();
    if (!keys.rentCast) {
      setErrors([{ address: 'RentCast', message: 'Add your RentCast API key in Account Settings first.' }]);
      return;
    }
    const targets = visibleBuyers.filter((b) => b.rentCastStatus == null && buyerLookupAddress(b)).slice(0, RENTCAST_MAX);
    if (!targets.length) { setEnrichNote('No visible buyers need enrichment (need a numbered street address).'); return; }
    setEnriching(true);
    stopRef.current = false;
    const updates = new Map<string, Partial<BuyerRecord>>();
    let done = 0, ok = 0, none = 0, err = 0;
    for (const b of targets) {
      if (stopRef.current) break;
      const addr = buyerLookupAddress(b)!;
      setEnrichNote(`RentCast ${done + 1}/${targets.length}: ${addr}`);
      try {
        const sale = await rentCastLastSale(addr, keys.rentCast);
        if (sale.found && sale.price) { ok++; updates.set(b.ownerName + '|' + (b.mailingAddress || ''), { rentCastStatus: 'ok', realLastSalePrice: sale.price, realLastSaleDate: sale.dateEpoch }); }
        else { none++; updates.set(b.ownerName + '|' + (b.mailingAddress || ''), { rentCastStatus: 'none' }); }
      } catch {
        err++;
        updates.set(b.ownerName + '|' + (b.mailingAddress || ''), { rentCastStatus: 'error' });
      }
      done++;
    }
    setBuyers((prev) => prev.map((b) => {
      const u = updates.get(b.ownerName + '|' + (b.mailingAddress || ''));
      return u ? { ...b, ...u } : b;
    }));
    setEnriching(false);
    setEnrichNote(
      err > 0 && ok === 0 && none === 0
        ? `RentCast couldn't be reached for any lookup (${err} errors) — check your RentCast API key, plan limits, or that requests aren't blocked.`
        : `RentCast: ${ok} priced · ${none} no-record · ${err} failed (of ${done}, cached).` +
            (visibleBuyers.length > RENTCAST_MAX ? ` Showing ${RENTCAST_MAX}/run — narrow the list or run again for more.` : ''),
    );
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

  // The most likely buyers for these finder hits, drawn from the saved buyer
  // database, matched by the scan county + deal type (house vs land).
  const dealBuyers = useMemo(() => {
    if (!savedDb || (mode !== 'house' && mode !== 'land')) return null;
    const type: 'house' | 'land' = mode === 'land' ? 'land' : 'house';
    const matched = matchBuyersToDeal(savedDb, county, type);
    return { county, type, list: matched.slice(0, 8), total: matched.length };
  }, [savedDb, mode, county]);

  const exportCsv = () => visibleResults.length && downloadFile(`property-finder-${mode}-${Date.now()}.csv`, resultsToCsv(visibleResults), 'text/csv');
  const exportJson = () => visibleResults.length && downloadFile(`property-finder-${mode}-${Date.now()}.json`, JSON.stringify(visibleResults, null, 2), 'application/json');
  const visibleBuyers = useMemo(() => {
    const matchCty = dealMatch?.county?.toLowerCase();
    const list = buyers.filter(
      (b) =>
        (buyerFilter === 'all' || (buyerFilter === 'house' ? b.houseCount > 0 : b.landCount > 0)) &&
        (buyerClass === 'all' || b.investorClass === buyerClass) &&
        (!matchCty || b.counties.some((c) => c.toLowerCase() === matchCty)),
    );
    const sorted = [...list];
    if (buyerSort === 'recent') {
      sorted.sort((a, b) => (b.mostRecentPurchaseEpoch ?? 0) - (a.mostRecentPurchaseEpoch ?? 0) || b.propertyCount - a.propertyCount);
    } else if (buyerSort === 'distance') {
      sorted.sort((a, b) => (a.nearestMiles ?? Infinity) - (b.nearestMiles ?? Infinity) || b.propertyCount - a.propertyCount);
    } else if (buyerSort === 'score') {
      sorted.sort((a, b) => b.buyerScore - a.buyerScore || b.propertyCount - a.propertyCount);
    } else {
      sorted.sort((a, b) => b.propertyCount - a.propertyCount || b.totalAssessedValue - a.totalAssessedValue);
    }
    return sorted;
  }, [buyers, buyerFilter, buyerClass, buyerSort, dealMatch]);
  const buyerCounts = useMemo(
    () => ({ house: buyers.filter((b) => b.houseCount > 0).length, land: buyers.filter((b) => b.landCount > 0).length }),
    [buyers],
  );
  const exportBuyersCsv = () => visibleBuyers.length && downloadFile(`buyer-list-${buyerFilter}-${county}-${Date.now()}.csv`, buyersToCsv(visibleBuyers), 'text/csv');

  const scoreWord = mode === 'house' ? 'distress' : 'land';
  const manualCount = queue.length || parseAddresses(addressInput).length;
  const fmtUsd0 = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const currentYear = new Date().getFullYear();
  const buyYear = (e?: number) => { if (!e) return undefined; const d = new Date(e); return isNaN(d.getTime()) ? undefined : d.getFullYear(); };
  const fmtSaleDate = (e?: number) => {
    if (!e) return '—';
    const d = new Date(e);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

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
      <div className="finder-mode-toggle finder-mode-3">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              className={`finder-mode-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => {
                setMode(m.id);
                // Keep the shared radius valid for each mode's slider range.
                if (m.id === 'buyers' && radius < 1) setRadius(5);
                if (m.id !== 'buyers' && radius > 2) setRadius(0.75);
              }}
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
        {mode === 'buyers' ? (
        <>
          <div className="finder-tabs">
            <button className={buyerScope === 'area' ? 'active' : ''} onClick={() => setBuyerScope('area')} type="button"><MapPin size={15} /> Area / deal address</button>
            <button className={buyerScope === 'database' ? 'active' : ''} onClick={() => setBuyerScope('database')} type="button"><Database size={15} /> Multi-county database</button>
          </div>

          {buyerScope === 'database' ? (
          <div className="finder-area-form">
            <div className="finder-field finder-field-wide">
              <label>Counties to scan <span>(merges the same owner across counties; large counties take a few minutes)</span></label>
              <div className="finder-county-chips">
                {METRO_COUNTIES.map((c) => (
                  <button key={c} type="button" className={dbCounties.includes(c) ? 'active' : ''} onClick={() => toggleDbCounty(c)}>
                    {dbCounties.includes(c) ? <Check size={12} /> : null} {c}{BIG_COUNTIES.has(c) ? ' ·lg' : ''}
                  </button>
                ))}
              </div>
            </div>
            <div className="finder-field">
              <label>Min properties owned: <strong>{minProperties}</strong></label>
              <input type="range" min={2} max={15} step={1} value={minProperties} onChange={(e) => setMinProperties(Number(e.target.value))} />
            </div>
            <div className="finder-area-actions">
              {running ? (
                <button className="finder-btn-stop" onClick={stopScan} type="button"><X size={16} /> Stop</button>
              ) : (
                <button className="finder-btn-primary" onClick={runBuyerDatabase} type="button" disabled={!dbCounties.length}>
                  <Database size={16} /> Build database — {dbCounties.length} {dbCounties.length === 1 ? 'county' : 'counties'}
                </button>
              )}
            </div>

            {/* Saved database (instant load — no re-scan) */}
            {savedDb && (
              <div className="finder-saved-db finder-field-wide">
                <span><Database size={13} /> Saved database: <strong>{savedDb.buyers.length.toLocaleString()}</strong> buyers · {savedDb.counties.join(', ')} · built {new Date(savedDb.builtAt).toLocaleDateString()}</span>
                <span className="finder-saved-db-actions">
                  <button type="button" className="finder-btn-secondary" onClick={loadSavedDb} disabled={running}><Database size={14} /> Load</button>
                  <button type="button" className="finder-link-danger" onClick={deleteSavedDb} disabled={running}>Delete</button>
                </span>
              </div>
            )}

            {/* Instant deal matching against the loaded database */}
            {buyers.length > 0 && (
              <div className="finder-field finder-field-wide finder-deal-match">
                <label>Match a deal address <span>(instant — finds your saved buyers active in the deal's county)</span></label>
                <div className="finder-deal-match-row">
                  <input type="text" value={dbDealInput} onChange={(e) => setDbDealInput(e.target.value)} placeholder="813 Corriher St, Kannapolis, NC 28081"
                    onKeyDown={(e) => { if (e.key === 'Enter') runDealMatch(); }} />
                  <button type="button" className="finder-btn-secondary" onClick={runDealMatch} disabled={matching || !dbDealInput.trim()}>
                    {matching ? <Loader2 size={15} className="finder-spin" /> : <Target size={15} />} Match
                  </button>
                  {dealMatch && <button type="button" className="finder-link-danger" onClick={() => { setDealMatch(null); setDbDealInput(''); }}>Clear</button>}
                </div>
              </div>
            )}
          </div>
          ) : (
          <div className="finder-area-form">
            <div className="finder-field finder-field-wide">
              <label>Property you're selling <span>(optional — finds buyers active in its area, closest first)</span></label>
              <input type="text" value={dealAddress} onChange={(e) => setDealAddress(e.target.value)} placeholder="813 Corriher St, Kannapolis, NC 28081" />
            </div>
            <div className="finder-field">
              <label>County {dealAddress.trim() && <span>(ignored — address sets the area)</span>}</label>
              <select value={county} onChange={(e) => setCounty(e.target.value)} disabled={!!dealAddress.trim()}>
                {ncCountyNames.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="finder-field">
              <label>City or ZIP <span>{dealAddress.trim() ? '(ignored — using the address)' : '(optional — centers the scan)'}</span></label>
              <input type="text" value={cityZip} onChange={(e) => setCityZip(e.target.value)} placeholder="Gastonia  ·  or  28052" disabled={!!dealAddress.trim()} />
            </div>
            <div className="finder-field">
              <label>Scan radius: <strong>{radius.toFixed(1)} mi</strong> <span>(larger ≈ whole county)</span></label>
              <input type="range" min={1} max={25} step={1} value={Math.max(1, radius)} onChange={(e) => setRadius(Number(e.target.value))} />
            </div>
            <div className="finder-field">
              <label>Min properties owned: <strong>{minProperties}</strong> <span>(higher = bigger investors only)</span></label>
              <input type="range" min={2} max={15} step={1} value={minProperties} onChange={(e) => setMinProperties(Number(e.target.value))} />
            </div>
            <div className="finder-area-actions">
              {running ? (
                <button className="finder-btn-stop" onClick={stopScan} type="button"><X size={16} /> Stop</button>
              ) : (
                <button className="finder-btn-primary" onClick={runBuyerList} type="button">
                  <Users size={16} /> {dealAddress.trim() ? 'Find buyers near this address' : `Build buyer list — ${county}${cityZip ? ` · ${cityZip}` : ''}`}
                </button>
              )}
            </div>
          </div>
          )}
        </>
        ) : (
        <>
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
        </>
        )}

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

      {mode !== 'buyers' && visibleResults.length > 0 && (
        <>
          <div className="finder-results-head">
            <h3>{visibleResults.length} {MODES.find((m) => m.id === mode)?.label}</h3>
            <div className="finder-export-actions">
              <button className="finder-btn-secondary" onClick={exportCsv} type="button"><Download size={15} /> CSV</button>
              <button className="finder-btn-secondary" onClick={exportJson} type="button"><FileJson size={15} /> JSON</button>
            </div>
          </div>

          {/* Most likely buyers for these deals, from the saved buyer database */}
          {dealBuyers ? (
            <div className="finder-dealbuyers">
              <div className="finder-dealbuyers-head">
                <Users size={15} />
                <strong>Most likely buyers</strong> for these {county} {dealBuyers.type === 'land' ? 'land' : 'house'} deals
                <span className="finder-dealbuyers-count">{dealBuyers.total} in your database</span>
              </div>
              {dealBuyers.list.length > 0 ? (
                <div className="finder-dealbuyers-list">
                  {dealBuyers.list.map((b, i) => (
                    <div key={`${b.ownerName}-${i}`} className="finder-dealbuyer">
                      <span className={`finder-score-pill ${b.buyerScore >= 70 ? 'sc-hot' : b.buyerScore >= 45 ? 'sc-warm' : ''}`}>{b.buyerScore}</span>
                      <span className="db-name">{b.ownerName}{b.outOfState && <span className="finder-oos-tag">{b.mailState}</span>}</span>
                      <span className={`finder-owner-type ot-${b.investorClass}`}>{b.investorClass}</span>
                      <span className="db-meta">{b.propertyCount} props · last buy {fmtSaleDate(b.mostRecentPurchaseEpoch)}</span>
                      <span className="db-mail">{b.mailingAddress}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="finder-dealbuyers-empty">
                  Your saved database doesn't cover <strong>{county}</strong>. Build one including it in <strong>Buyers → Multi-county database</strong>.
                </div>
              )}
            </div>
          ) : (mode === 'house' || mode === 'land') ? (
            <div className="finder-dealbuyers-hint">
              <Users size={14} /> Build an investor <strong>buyer database</strong> (Buyers tab → Multi-county database) and it'll auto-match the most likely buyers to deals like these.
            </div>
          ) : null}

          <div className="finder-results-grid">{visibleResults.map((r) => <ResultCard key={r.id} r={r} />)}</div>
        </>
      )}

      {/* Investor buyer list */}
      {mode === 'buyers' && buyers.length > 0 && (
        <>
          {dealMatch && (
            <div className="finder-match-banner">
              <Target size={15} />
              <span>Most likely buyers for <strong>{dealMatch.label}</strong>{dealMatch.county ? <> — active in <strong>{dealMatch.county} County</strong></> : ' — county undetermined, showing all'}. Use the House/Land filter to match what you're selling.</span>
            </div>
          )}
          <div className="finder-results-head">
            <h3>
              {visibleBuyers.length.toLocaleString()} {buyerFilter === 'house' ? 'House' : buyerFilter === 'land' ? 'Land' : 'Investor'} Buyers
              {dealContext ? <span className="finder-deal-context"> near {dealContext}</span> : ''}
            </h3>
            <div className="finder-export-actions">
              {enriching ? (
                <button className="finder-btn-stop" onClick={stopScan} type="button"><X size={15} /> Stop</button>
              ) : (
                <button className="finder-btn-secondary" onClick={enrichWithRentCast} type="button" title="Fetch real last-sale prices for the visible buyers from RentCast">
                  <Sparkles size={15} /> Enrich $ (RentCast)
                </button>
              )}
              <button className="finder-btn-secondary" onClick={exportBuyersCsv} type="button"><Download size={15} /> CSV</button>
            </div>
          </div>
          {(enriching || enrichNote) && <div className="finder-scan-summary">{enriching ? <><Loader2 size={13} className="finder-spin" /> {enrichNote}</> : enrichNote}</div>}

          {/* House / land buyer filter + class filter + sort */}
          <div className="finder-buyer-controls">
            <div className="finder-buyer-filter">
              <button className={buyerFilter === 'all' ? 'active' : ''} onClick={() => setBuyerFilter('all')} type="button">All ({buyers.length})</button>
              <button className={buyerFilter === 'house' ? 'active' : ''} onClick={() => setBuyerFilter('house')} type="button"><Home size={13} /> House buyers ({buyerCounts.house})</button>
              <button className={buyerFilter === 'land' ? 'active' : ''} onClick={() => setBuyerFilter('land')} type="button"><Trees size={13} /> Land buyers ({buyerCounts.land})</button>
            </div>
            <div className="finder-buyer-side">
              <label className="finder-buyer-sort">
                Type
                <select value={buyerClass} onChange={(e) => setBuyerClass(e.target.value as typeof buyerClass)}>
                  <option value="all">All</option>
                  <option value="llc">LLCs</option>
                  <option value="builder">Builders</option>
                  <option value="developer">Developers</option>
                  <option value="individual">Individuals</option>
                </select>
              </label>
              <label className="finder-buyer-sort">
                Sort
                <select value={buyerSort} onChange={(e) => setBuyerSort(e.target.value as typeof buyerSort)}>
                  <option value="score">Activity score</option>
                  <option value="recent">Most recent buy</option>
                  {dealContext && <option value="distance">Nearest to deal</option>}
                  <option value="props">Most properties</option>
                </select>
              </label>
            </div>
          </div>

          <div className="finder-table-wrap">
            <table className="finder-buyer-table">
              <thead>
                <tr>
                  {dealContext && <th className="num">Near Deal</th>}
                  <th className="num">Score</th><th>Owner</th><th>Class</th><th>Buys</th><th className="num">Props</th>
                  {buyerScope === 'database' && <th>Counties</th>}
                  <th className="num">Avg Value</th><th className="num">RentCast $</th><th>Most Recent Buy</th><th>Mailing Address</th><th>Example Properties</th>
                </tr>
              </thead>
              <tbody>
                {visibleBuyers.map((b, i) => (
                  <tr key={`${b.ownerName}-${i}`}>
                    {dealContext && (
                      <td className="num">
                        {b.nearestMiles != null
                          ? <span className={`finder-near-tag ${b.nearestMiles <= 1 ? 'near-hot' : b.nearestMiles <= 3 ? 'near-warm' : ''}`}>
                              <Target size={11} /> {b.nearestMiles < 0.1 ? '<0.1' : b.nearestMiles.toFixed(1)} mi
                            </span>
                          : '—'}
                      </td>
                    )}
                    <td className="num">
                      <span className={`finder-score-pill ${b.buyerScore >= 70 ? 'sc-hot' : b.buyerScore >= 45 ? 'sc-warm' : ''}`}>{b.buyerScore}</span>
                    </td>
                    <td className="owner">
                      {b.ownerName}
                      {b.outOfState && <span className="finder-oos-tag">{b.mailState}</span>}
                    </td>
                    <td>
                      <span className={`finder-owner-type ot-${b.investorClass}`}>
                        {b.investorClass === 'builder' ? <HardHat size={12} /> : b.investorClass === 'developer' ? <Building2 size={12} /> : b.investorClass === 'llc' ? <Landmark size={12} /> : <User size={12} />}
                        {b.investorClass}
                      </span>
                    </td>
                    <td>
                      <span className={`finder-buys bt-${b.buyerType}`} title={`${b.houseCount} house / improved · ${b.landCount} land / vacant`}>
                        {b.houseCount > 0 && <span className="buys-h"><Home size={11} /> {b.houseCount}</span>}
                        {b.landCount > 0 && <span className="buys-l"><Trees size={11} /> {b.landCount}</span>}
                        {b.houseCount === 0 && b.landCount === 0 && <span className="buys-u">—</span>}
                      </span>
                    </td>
                    <td className="num strong">{b.propertyCount}</td>
                    {buyerScope === 'database' && (
                      <td className="counties" title={b.counties.join(', ')}>
                        {b.counties.length > 1 ? <span className="finder-multi-county">{b.counties.length} counties</span> : (b.counties[0] || '—')}
                      </td>
                    )}
                    <td className="num">{b.avgAssessedValue > 0 ? fmtUsd0(b.avgAssessedValue) : '—'}</td>
                    <td className="num">
                      {b.realLastSalePrice ? <span className="finder-rentcast-val">{fmtUsd0(b.realLastSalePrice)}</span>
                        : b.rentCastStatus === 'none' ? <span className="finder-rc-muted">no record</span>
                        : b.rentCastStatus === 'error' ? <span className="finder-rc-muted">—</span>
                        : ''}
                    </td>
                    <td className="recent-buy">
                      <span className="rb-date">
                        {fmtSaleDate(b.mostRecentPurchaseEpoch)}
                        {buyYear(b.mostRecentPurchaseEpoch) === currentYear && <span className="rb-new">{currentYear}</span>}
                      </span>
                      {b.mostRecentProperty && <span className="rb-prop" title={b.mostRecentProperty}>{b.mostRecentProperty}</span>}
                    </td>
                    <td className="addr">{b.mailingAddress}</td>
                    <td className="examples">{b.exampleProperties.join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!running && mode !== 'buyers' && visibleResults.length === 0 && mode === 'house' && scanSummary && (
        <div className="finder-empty">
          Only distressed homes are shown (well-maintained homes are hidden by design). If nothing was found,
          try another City/ZIP or a different radius — or increase the radius to widen the search.
        </div>
      )}
      {!running && mode === 'land' && visibleResults.length === 0 && results.some((r) => r.mode === 'land') && (
        <div className="finder-empty">No results at or above a score of {minScore}. Lower the minimum score filter.</div>
      )}
    </div>
  );
}
