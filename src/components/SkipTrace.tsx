import { useMemo, useState } from 'react';
import {
  Fingerprint, Search, Loader2, AlertCircle, Building2, User, MapPin, Landmark,
  ExternalLink, Copy, Check, FileText, Users, ShieldCheck,
} from 'lucide-react';
import { skipTraceLLC } from '../services/feasibilityService';
import type { LlcSkipTrace } from '../services/feasibilityService';

const NC_COUNTIES_STATES = ['NC', 'SC', 'VA', 'GA', 'TN', 'FL'];

function statusTone(s?: string | null): string {
  const t = (s || '').toLowerCase();
  if (/dissolv|inactive|revoked|forfeit|withdrawn|terminated/.test(t)) return 'bad';
  if (/active|current|good standing/.test(t)) return 'good';
  return 'neutral';
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className="st-copy"
      title="Copy"
      onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function Field({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="st-field">
      <div className="st-field-label">{icon} {label}</div>
      <div className="st-field-value">{value}<CopyBtn text={value} /></div>
    </div>
  );
}

export function SkipTrace() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState('NC');
  const [result, setResult] = useState<LlcSkipTrace | null>(null);
  const [searched, setSearched] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const keysConfigured = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user') || '{}');
      return !!u.keys?.gemini;
    } catch { return false; }
  }, []);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setResult(null);
    setSearched(q);
    try {
      const r = await skipTraceLLC(q, state);
      if (!r) setError(`No ${state} registration found for "${q}". Try the exact registered name or the SOSID, or check the verification links below.`);
      else setResult(r);
    } catch (e: any) {
      setError(e?.message || 'Skip-trace failed');
    } finally {
      setLoading(false);
    }
  };

  // Verification deep-links (open in the user's real browser, which clears the
  // NC SOS Cloudflare check automatically).
  const links = (q: string) => [
    { label: 'NC SOS Business Search', url: 'https://www.sosnc.gov/online_services/search/by_title/Business_Registration' },
    { label: 'OpenCorporates', url: `https://opencorporates.com/companies/us_${state.toLowerCase()}?q=${encodeURIComponent(q)}` },
    { label: 'Bizapedia', url: `https://www.bizapedia.com/search/?qfn=${encodeURIComponent(q)}` },
    { label: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(`${q} ${state} registered agent secretary of state`)}` },
  ];

  return (
    <div className="finder-page">
      <div className="finder-hero">
        <div className="finder-hero-badge"><Fingerprint size={14} /> LLC Skip Trace</div>
        <h2>Skip Trace an LLC</h2>
        <p>
          Find the people behind a business entity — the <strong>registered agent</strong>, <strong>principal office</strong>,
          and the <strong>members/managers</strong> — from the Secretary of State registry and public records.
          Great for the LLC owners surfaced in your Buyer List. Results are AI‑gathered from{' '}
          <strong>Google‑grounded public records</strong> with cited sources (the live NC SOS search is
          Cloudflare‑protected, so this reads indexed records instead).
        </p>
      </div>

      {!keysConfigured && (
        <div className="finder-alert">
          <AlertCircle size={18} />
          <span>Set your <strong>Gemini</strong> API key in Account Settings (top‑right) — it powers the skip‑trace lookup.</span>
        </div>
      )}

      <div className="finder-search-panel">
        <label className="finder-input-label">LLC / business name or SOSID <span>(e.g. "David B Miller Rentals LLC")</span></label>
        <div className="st-search-row">
          <select value={state} onChange={(e) => setState(e.target.value)} className="st-state">
            {NC_COUNTIES_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="text"
            className="st-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder="Acme Holdings LLC  ·  or  SOSID 1417294"
          />
          <button className="finder-btn-primary" onClick={run} type="button" disabled={loading || !query.trim()}>
            {loading ? <Loader2 size={16} className="finder-spin" /> : <Search size={16} />}
            {loading ? 'Tracing…' : 'Skip Trace'}
          </button>
        </div>
      </div>

      {error && (
        <div className="finder-errors">
          <div className="finder-error-row"><AlertCircle size={14} /> {error}</div>
        </div>
      )}

      {result && (
        <div className="st-result">
          <div className="st-result-head">
            <div className="st-entity">
              <Building2 size={18} />
              <div>
                <h3>{result.entityName}</h3>
                <div className="st-entity-sub">
                  {result.entityType && <span>{result.entityType}</span>}
                  {result.sosId && <span>· SOSID {result.sosId}</span>}
                  {result.formationDate && <span>· formed {result.formationDate}</span>}
                </div>
              </div>
            </div>
            {result.status && <span className={`st-status st-${statusTone(result.status)}`}>{result.status}</span>}
          </div>

          {/* The skip-trace contacts */}
          <div className="st-section-title"><ShieldCheck size={14} /> Skip-trace contacts</div>
          <div className="st-grid">
            <Field icon={<User size={13} />} label="Registered agent" value={result.registeredAgentName} />
            <Field icon={<MapPin size={13} />} label="Agent address" value={result.registeredAgentAddress} />
            <Field icon={<Landmark size={13} />} label="Principal office" value={result.principalOffice} />
            <Field icon={<MapPin size={13} />} label="Mailing address" value={result.mailingAddress} />
          </div>

          {result.officials && result.officials.length > 0 && (
            <>
              <div className="st-section-title"><Users size={14} /> Officials — managers / members (the owners)</div>
              <div className="st-officials">
                {result.officials.map((o, i) => (
                  <div key={i} className="st-official">
                    <span className="st-official-name">{o.name}{o.title && <span className="st-official-title">{o.title}</span>}</span>
                    {o.address && <span className="st-official-addr">{o.address}<CopyBtn text={o.address} /></span>}
                  </div>
                ))}
              </div>
            </>
          )}

          {result.recentFiling && (
            <div className="st-filing"><FileText size={14} /> <span>Most recent filing: {result.recentFiling}</span></div>
          )}

          {result.sources && result.sources.length > 0 && (
            <div className="st-sources">
              <span className="st-sources-label">Sources:</span>
              {result.sources.map((s, i) => (
                <a key={i} href={s} target="_blank" rel="noreferrer" className="st-source-link">
                  {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()} <ExternalLink size={10} />
                </a>
              ))}
            </div>
          )}

          <div className="st-note"><AlertCircle size={12} /> AI‑gathered from public records — verify against the official Secretary of State record before relying on it.</div>
        </div>
      )}

      {/* Always-available verification launchpad */}
      {(searched || query.trim()) && (
        <div className="st-launchpad">
          <div className="st-launchpad-label">Verify / dig deeper on “{searched || query.trim()}”:</div>
          <div className="st-launchpad-links">
            {links(searched || query.trim()).map((l) => (
              <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="finder-btn-secondary">
                {l.label} <ExternalLink size={13} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
