import { useMemo, useState } from 'react';
import {
  Fingerprint, Search, Loader2, AlertCircle, Building2, User, MapPin, Landmark,
  ExternalLink, Copy, Check, FileText, ShieldCheck, Mail, Home, Layers,
} from 'lucide-react';
import { skipTraceLLC, enformionConfigured, skipTraceContact, enformionEnrichPeople } from '../services/feasibilityService';
import type { LlcSkipTrace, SkipTraceContact } from '../services/feasibilityService';
import { Phone, AtSign } from 'lucide-react';

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
  // Enformion skip-trace contacts (real phones/emails for the entity + people)
  const [entityContact, setEntityContact] = useState<SkipTraceContact | null>(null);
  const [peopleContacts, setPeopleContacts] = useState<Record<string, SkipTraceContact>>({});
  const [enformionLoading, setEnformionLoading] = useState(false);

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
    setEntityContact(null);
    setPeopleContacts({});
    setSearched(q);
    try {
      const r = await skipTraceLLC(q, state);
      if (!r) { setError(`No ${state} registration found for "${q}". Try the exact registered name or the SOSID, or check the verification links below.`); return; }
      setResult(r);
      // Enformion skip trace: real phones/emails for the entity (person/business)
      // and each registered agent / official, from the GIS owner data.
      if (enformionConfigured()) {
        setEnformionLoading(true);
        const entityAddr = r.taxMailingAddress || r.mailingAddress || r.principalOffice || undefined;
        const people = [
          ...(r.registeredAgentName ? [{ name: r.registeredAgentName, address: r.registeredAgentAddress || undefined }] : []),
          ...((r.officials || []).map((o) => ({ name: o.name, address: o.address || undefined }))),
        ];
        Promise.all([
          skipTraceContact(r.entityName || q, entityAddr).catch(() => null),
          enformionEnrichPeople(people).catch(() => ({})),
        ]).then(([entity, map]) => {
          setEntityContact(entity);
          setPeopleContacts(map || {});
        }).finally(() => setEnformionLoading(false));
      }
    } catch (e: any) {
      setError(e?.message || 'Skip-trace failed');
    } finally {
      setLoading(false);
    }
  };

  const ContactCard = ({ c, title }: { c: SkipTraceContact; title?: string }) => (
    <div className="st-contact">
      {title && <div className="st-contact-title">{title}{c.isBusiness ? ' (business)' : ''}{c.age ? ` · age ${c.age}` : ''}</div>}
      {c.phones.length > 0 && (
        <div className="st-contact-row"><Phone size={12} />
          {c.phones.map((p, i) => (
            <span key={i} className="st-contact-chip"><a href={`tel:${p.number.replace(/[^0-9+]/g, '')}`}>{p.number}</a>{p.type ? <em> {p.type}</em> : null}<CopyBtn text={p.number} /></span>
          ))}
        </div>
      )}
      {c.emails.length > 0 && (
        <div className="st-contact-row"><AtSign size={12} />
          {c.emails.map((e, i) => (
            <span key={i} className="st-contact-chip"><a href={`mailto:${e}`}>{e}</a><CopyBtn text={e} /></span>
          ))}
        </div>
      )}
      {c.relatives && c.relatives.length > 0 && <div className="st-contact-sub">Relatives: {c.relatives.slice(0, 6).join(', ')}</div>}
      {c.associates && c.associates.length > 0 && <div className="st-contact-sub">Associates: {c.associates.slice(0, 6).join(', ')}</div>}
    </div>
  );

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
          Find the people behind a business entity. The backbone is <strong>NC county tax records (GIS)</strong> —
          it returns the LLC's <strong>mailing address</strong> (where tax bills go — the best skip‑trace contact)
          and <strong>every NC property it owns</strong>. That confirmed identity then anchors an AI search of
          <strong> indexed public records</strong> (Secretary of State snippets, Bizapedia, CorporationWiki) for the
          <strong> registered agent</strong> and <strong>managers/members</strong>. Great for the LLC owners in your Buyer List.
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

          {/* County tax records (NC GIS) — the reliable backbone */}
          {result.foundInGIS && (
            <>
              <div className="st-section-title"><Layers size={14} /> County tax records (NC GIS) — confirmed owner</div>
              {result.taxMailingAddress && (
                <div className="st-mail-hero">
                  <Mail size={16} />
                  <div>
                    <div className="st-mail-label">Owner mailing address — where county tax bills go (best skip-trace contact)</div>
                    <div className="st-mail-value">{result.taxMailingAddress}<CopyBtn text={result.taxMailingAddress} /></div>
                  </div>
                </div>
              )}
              <div className="st-stats">
                <span><Home size={13} /> <strong>{result.propertyCount?.toLocaleString()}{result.propertyCountCapped ? '+' : ''}</strong> NC properties</span>
                {result.countiesOwned && result.countiesOwned.length > 0 && <span><MapPin size={13} /> {result.countiesOwned.length} {result.countiesOwned.length === 1 ? 'county' : 'counties'}: {result.countiesOwned.join(', ')}</span>}
                {!!result.totalAssessedValue && <span><Building2 size={13} /> ${result.totalAssessedValue.toLocaleString()} assessed</span>}
              </div>
              {result.properties && result.properties.length > 0 && (
                <div className="st-props">
                  {result.properties.slice(0, 14).map((p, i) => (
                    <div key={i} className="st-prop">
                      <span className="st-prop-addr">{p.address}</span>
                      <span className="st-prop-meta">{p.county}{p.value > 0 ? ` · $${p.value.toLocaleString()}` : ''}</span>
                    </div>
                  ))}
                  {result.properties.length > 14 && <div className="st-prop-more">+ {(result.propertyCount || result.properties.length) - 14} more {result.propertyCountCapped ? '(showing top 14 by value)' : ''}</div>}
                </div>
              )}
            </>
          )}

          {/* SOS registration — registered agent & members (AI from indexed public records) */}
          {(result.registeredAgentName || result.registeredAgentAddress || result.principalOffice || result.mailingAddress || (result.officials && result.officials.length > 0)) ? (
            <>
              <div className="st-section-title">
                <ShieldCheck size={14} /> Secretary of State record (registered agent &amp; members)
                {result.sosScraped
                  ? <span className="st-conf st-conf-high">scraped record</span>
                  : (result.confidence && <span className={`st-conf st-conf-${String(result.confidence).toLowerCase()}`}>{result.confidence} confidence</span>)}
              </div>
              <div className="st-grid">
                <Field icon={<User size={13} />} label="Registered agent" value={result.registeredAgentName} />
                <Field icon={<MapPin size={13} />} label="Agent address" value={result.registeredAgentAddress} />
                <Field icon={<Landmark size={13} />} label="Principal office" value={result.principalOffice} />
                <Field icon={<MapPin size={13} />} label="SOS mailing address" value={result.mailingAddress} />
              </div>
              {result.officials && result.officials.length > 0 && (
                <div className="st-officials">
                  {result.officials.map((o, i) => (
                    <div key={i} className="st-official">
                      <span className="st-official-name">{o.name}{o.title && <span className="st-official-title">{o.title}</span>}</span>
                      {o.address && <span className="st-official-addr">{o.address}<CopyBtn text={o.address} /></span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="st-agent-missing">
              <AlertCircle size={14} />
              <span>Couldn't confirm the <strong>registered agent / members</strong> in indexed public records for this entity. Open the <strong>NC SOS</strong> link below — it clears the Cloudflare check automatically in your browser and shows the agent &amp; company officials directly.</span>
            </div>
          )}

          {/* Enformion skip trace — real phones / emails / relatives */}
          {(enformionLoading || entityContact || Object.keys(peopleContacts).length > 0) && (
            <>
              <div className="st-section-title">
                <Phone size={14} /> Skip Trace Contacts (Enformion)
                {enformionLoading && <Loader2 size={13} className="finder-spin" style={{ marginLeft: '6px' }} />}
              </div>
              {entityContact && (entityContact.phones.length > 0 || entityContact.emails.length > 0) && (
                <ContactCard c={entityContact} title={result.entityName || 'Owner'} />
              )}
              {Object.entries(peopleContacts).map(([name, c]) => (
                <ContactCard key={name} c={c} title={name} />
              ))}
              {!enformionLoading && !entityContact && Object.keys(peopleContacts).length === 0 && (
                <div className="st-agent-missing">
                  <AlertCircle size={14} />
                  <span>No Enformion contact matches for this entity or its people. Try a more exact name, or verify the credentials in Settings.</span>
                </div>
              )}
              <div className="st-note"><AlertCircle size={12} /> Skip-trace data from Enformion — use in compliance with the FCRA / DPPA (no credit, employment, tenant, or insurance decisions).</div>
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

          <div className="st-note"><AlertCircle size={12} /> {result.sosScraped ? 'Scraped from the public registration record — verify against the official Secretary of State record before relying on it.' : 'AI‑gathered from public records — verify against the official Secretary of State record before relying on it.'}</div>
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
