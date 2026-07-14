import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity, Ban, CheckCircle2, CircleAlert, DatabaseZap, Eye, FileClock,
  Filter, MapPinned, Play, Plus, RefreshCw, Search, ServerCog, X,
} from 'lucide-react';

type AdminTab = 'sources' | 'review' | 'coverage' | 'test';

interface SourceRow {
  id: string;
  jurisdiction_id: string;
  jurisdiction_name: string;
  state: 'NC' | 'SC';
  dataset_type: string;
  source_type: string;
  source_name: string;
  publisher: string;
  layer_url: string;
  layer_id: string;
  zoning_code_field: string | null;
  zoning_description_field: string | null;
  classification: string;
  validation_status: string;
  last_checked_at: string | null;
  response_time_ms: number | null;
  failure_count: number;
  active: boolean;
}

interface CoverageRow {
  state: 'NC' | 'SC';
  zoning_status: string;
  jurisdictions: number;
  configured: number;
}

interface SourceForm {
  jurisdictionId: string;
  datasetType: 'zoning' | 'parcels' | 'overlays';
  sourceType: 'arcgis-mapserver' | 'arcgis-featureserver';
  sourceName: string;
  publisher: string;
  officialDomain: string;
  serviceUrl: string;
  layerUrl: string;
  layerId: string;
  zoningCodeField: string;
  zoningDescriptionField: string;
}

const EMPTY_SOURCE: SourceForm = {
  jurisdictionId: '', datasetType: 'zoning', sourceType: 'arcgis-mapserver',
  sourceName: '', publisher: '', officialDomain: '', serviceUrl: '', layerUrl: '',
  layerId: '0', zoningCodeField: '', zoningDescriptionField: '',
};

function dateLabel(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export function ZoningAdmin() {
  const [apiBase, setApiBase] = useState(() => import.meta.env.VITE_ZONING_API_URL || 'http://localhost:8787');
  const [adminKey, setAdminKey] = useState('');
  const [tab, setTab] = useState<AdminTab>('sources');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [stateFilter, setStateFilter] = useState<'all' | 'NC' | 'SC'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [sourceForm, setSourceForm] = useState<SourceForm>(EMPTY_SOURCE);
  const [discovery, setDiscovery] = useState({ jurisdictionId: '', state: 'NC' as 'NC' | 'SC', county: '', municipality: '' });
  const [testAddress, setTestAddress] = useState('');
  const [testResult, setTestResult] = useState<unknown>(null);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(adminKey ? { 'x-admin-key': adminKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(String(payload.error ?? payload.detail ?? `HTTP ${response.status}`));
    return payload as T;
  }, [adminKey, apiBase]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sourceData, coverageData] = await Promise.all([
        request<{ sources: SourceRow[] }>('/v1/admin/sources'),
        request<{ coverage: CoverageRow[] }>('/v1/admin/coverage'),
      ]);
      setSources(sourceData.sources);
      setCoverage(coverageData.coverage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(() => sources.filter((source) => {
    if (stateFilter !== 'all' && source.state !== stateFilter) return false;
    if (tab === 'review' && !['candidate', 'manual_review', 'degraded'].includes(source.validation_status)) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${source.jurisdiction_name} ${source.source_name} ${source.publisher} ${source.validation_status}`.toLowerCase().includes(needle);
  }), [query, sources, stateFilter, tab]);

  const summary = useMemo(() => ({
    active: sources.filter((source) => source.active).length,
    verified: sources.filter((source) => source.validation_status === 'verified').length,
    review: sources.filter((source) => ['candidate', 'manual_review', 'degraded'].includes(source.validation_status)).length,
    broken: sources.filter((source) => source.failure_count > 0 || !source.active).length,
  }), [sources]);

  async function mutateSource(id: string, body: Record<string, unknown>, success: string) {
    setError(null);
    try {
      await request(`/v1/admin/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setNotice(success);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function queue(path: string, success: string, body?: unknown) {
    setError(null);
    try {
      await request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      setNotice(success);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function inspectSource(source: SourceRow, kind: 'inspect' | 'versions') {
    setError(null);
    try {
      const value = await request(`/v1/admin/sources/${source.id}/${kind}`);
      setDetail({ title: `${source.jurisdiction_name}: ${kind === 'inspect' ? 'metadata and samples' : 'source history'}`, value });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    try {
      await request('/v1/admin/sources', {
        method: 'POST',
        body: JSON.stringify({
          ...sourceForm,
          zoningCodeField: sourceForm.zoningCodeField || null,
          zoningDescriptionField: sourceForm.zoningDescriptionField || null,
        }),
      });
      setShowAdd(false);
      setSourceForm(EMPTY_SOURCE);
      setNotice('Candidate source added');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function testLookup(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setTestResult(await request('/v1/zoning/lookup', {
        method: 'POST',
        body: JSON.stringify({ address: testAddress, includeParcel: true, includeOverlays: true }),
      }));
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : String(lookupError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="za-shell">
      <section className="za-toolbar" aria-label="Zoning administration connection">
        <div>
          <h2>Official Zoning Registry</h2>
          <span>{sources.length} source records</span>
        </div>
        <label>API URL<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label>
        <label>Admin key<input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} autoComplete="off" /></label>
        <button className="za-icon-button" type="button" onClick={() => void load()} title="Refresh registry" disabled={loading}>
          <RefreshCw size={17} className={loading ? 'spinner' : ''} />
        </button>
        <button className="za-command" type="button" onClick={() => void queue('/v1/admin/health/run', 'Health scan queued')}>
          <Activity size={16} /> Run health scan
        </button>
      </section>

      {error && <div className="za-alert error"><CircleAlert size={17} />{error}</div>}
      {notice && <div className="za-alert success"><CheckCircle2 size={17} />{notice}<button type="button" onClick={() => setNotice(null)} title="Dismiss"><X size={15} /></button></div>}

      <section className="za-stats" aria-label="Registry status">
        <div><span>Active</span><strong>{summary.active}</strong></div>
        <div><span>Verified</span><strong>{summary.verified}</strong></div>
        <div><span>Needs review</span><strong>{summary.review}</strong></div>
        <div><span>Failed or disabled</span><strong>{summary.broken}</strong></div>
      </section>

      <div className="za-tabs" role="tablist" aria-label="Zoning administration views">
        <button type="button" className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><DatabaseZap size={16} />Sources</button>
        <button type="button" className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}><CircleAlert size={16} />Review</button>
        <button type="button" className={tab === 'coverage' ? 'active' : ''} onClick={() => setTab('coverage')}><MapPinned size={16} />Coverage</button>
        <button type="button" className={tab === 'test' ? 'active' : ''} onClick={() => setTab('test')}><Play size={16} />Test lookup</button>
      </div>

      {(tab === 'sources' || tab === 'review') && (
        <section className="za-panel">
          <div className="za-panel-head">
            <div className="za-filters">
              <label className="za-search"><Search size={16} /><input aria-label="Search sources" placeholder="Jurisdiction or source" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              <label className="za-select"><Filter size={15} /><select aria-label="Filter by state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as 'all' | 'NC' | 'SC')}><option value="all">NC and SC</option><option value="NC">North Carolina</option><option value="SC">South Carolina</option></select></label>
            </div>
            <button className="za-command" type="button" onClick={() => setShowAdd(true)}><Plus size={16} />Add candidate</button>
          </div>
          <div className="za-table-wrap">
            <table className="za-table">
              <thead><tr><th>Authority</th><th>Dataset</th><th>Layer</th><th>Code field</th><th>Status</th><th>Health</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {filtered.map((source) => (
                  <tr key={source.id}>
                    <td><strong>{source.jurisdiction_name}</strong><small>{source.state} · {source.publisher}</small></td>
                    <td>{source.dataset_type}</td>
                    <td><a href={source.layer_url} target="_blank" rel="noreferrer">{source.source_name}</a><small>Layer {source.layer_id}</small></td>
                    <td><code>{source.zoning_code_field || 'Not mapped'}</code></td>
                    <td><span className={`za-status ${source.validation_status}`}>{source.validation_status.replace(/_/g, ' ')}</span></td>
                    <td><span>{source.response_time_ms == null ? 'No check' : `${source.response_time_ms} ms`}</span><small>{dateLabel(source.last_checked_at)}</small></td>
                    <td><div className="za-row-actions">
                      <button type="button" onClick={() => void inspectSource(source, 'inspect')} title="Inspect metadata and samples"><Eye size={16} /></button>
                      <button type="button" onClick={() => void inspectSource(source, 'versions')} title="View source history"><FileClock size={16} /></button>
                      <button type="button" onClick={() => void queue(`/v1/admin/sources/${source.id}/validate`, 'Source validation queued')} title="Run validation"><Activity size={16} /></button>
                      {source.validation_status !== 'verified' && <button type="button" onClick={() => void mutateSource(source.id, { validationStatus: 'verified', classification: source.dataset_type === 'zoning' ? 'verified_current_zoning' : source.dataset_type === 'parcels' ? 'parcel' : 'overlay' }, 'Source approved')} title="Approve source"><CheckCircle2 size={16} /></button>}
                      <button type="button" onClick={() => void mutateSource(source.id, { active: !source.active, validationStatus: source.active ? 'disabled' : 'manual_review' }, source.active ? 'Source disabled' : 'Source enabled for review')} title={source.active ? 'Disable source' : 'Enable source'}><Ban size={16} /></button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <div className="za-empty">No source records match the current filters.</div>}
          </div>

          {tab === 'review' && <form className="za-discovery" onSubmit={(event) => { event.preventDefault(); void queue('/v1/admin/discovery', 'Discovery job queued', { ...discovery, datasetType: 'zoning', municipality: discovery.municipality || undefined }); }}>
            <h3>Source discovery job</h3>
            <select aria-label="Discovery state" value={discovery.state} onChange={(event) => setDiscovery({ ...discovery, state: event.target.value as 'NC' | 'SC' })}><option value="NC">NC</option><option value="SC">SC</option></select>
            <input required placeholder="County" aria-label="County" value={discovery.county} onChange={(event) => setDiscovery({ ...discovery, county: event.target.value })} />
            <input placeholder="Municipality" aria-label="Municipality" value={discovery.municipality} onChange={(event) => setDiscovery({ ...discovery, municipality: event.target.value })} />
            <input required placeholder="Jurisdiction ID" aria-label="Jurisdiction ID" value={discovery.jurisdictionId} onChange={(event) => setDiscovery({ ...discovery, jurisdictionId: event.target.value })} />
            <button className="za-command" type="submit"><ServerCog size={16} />Queue discovery</button>
          </form>}
        </section>
      )}

      {tab === 'coverage' && <section className="za-panel"><div className="za-table-wrap"><table className="za-table"><thead><tr><th>State</th><th>Jurisdiction status</th><th>Imported</th><th>Configured</th><th>Coverage</th></tr></thead><tbody>{coverage.map((row) => { const percent = row.jurisdictions ? Math.round((row.configured / row.jurisdictions) * 100) : 0; return <tr key={`${row.state}-${row.zoning_status}`}><td><strong>{row.state}</strong></td><td>{row.zoning_status.replace(/_/g, ' ')}</td><td>{row.jurisdictions}</td><td>{row.configured}</td><td><div className="za-meter"><span style={{ width: `${percent}%` }} /></div><small>{percent}%</small></td></tr>; })}</tbody></table></div></section>}

      {tab === 'test' && <section className="za-test"><form onSubmit={testLookup}><label>NC or SC address<input required minLength={5} value={testAddress} onChange={(event) => setTestAddress(event.target.value)} placeholder="3714 Memorial Parkway, Charlotte, NC 28217" /></label><button className="za-command" type="submit" disabled={loading}><Play size={16} />Run lookup</button></form>{testResult != null && <pre>{JSON.stringify(testResult, null, 2)}</pre>}</section>}

      {showAdd && <div className="za-modal-backdrop" role="presentation"><section className="za-modal" role="dialog" aria-modal="true" aria-labelledby="za-add-title"><header><h3 id="za-add-title">Add GIS source candidate</h3><button type="button" onClick={() => setShowAdd(false)} title="Close"><X size={18} /></button></header><form onSubmit={addSource}><label>Jurisdiction ID<input required value={sourceForm.jurisdictionId} onChange={(event) => setSourceForm({ ...sourceForm, jurisdictionId: event.target.value })} /></label><label>Dataset<select value={sourceForm.datasetType} onChange={(event) => setSourceForm({ ...sourceForm, datasetType: event.target.value as SourceForm['datasetType'] })}><option value="zoning">Zoning</option><option value="parcels">Parcels</option><option value="overlays">Overlay</option></select></label><label>Service type<select value={sourceForm.sourceType} onChange={(event) => setSourceForm({ ...sourceForm, sourceType: event.target.value as SourceForm['sourceType'] })}><option value="arcgis-mapserver">MapServer</option><option value="arcgis-featureserver">FeatureServer</option></select></label><label>Source name<input required value={sourceForm.sourceName} onChange={(event) => setSourceForm({ ...sourceForm, sourceName: event.target.value })} /></label><label>Publisher<input required value={sourceForm.publisher} onChange={(event) => setSourceForm({ ...sourceForm, publisher: event.target.value })} /></label><label>Official domain<input required value={sourceForm.officialDomain} onChange={(event) => setSourceForm({ ...sourceForm, officialDomain: event.target.value })} /></label><label className="wide">Service URL<input required type="url" value={sourceForm.serviceUrl} onChange={(event) => setSourceForm({ ...sourceForm, serviceUrl: event.target.value })} /></label><label className="wide">Layer URL<input required type="url" value={sourceForm.layerUrl} onChange={(event) => setSourceForm({ ...sourceForm, layerUrl: event.target.value })} /></label><label>Layer ID<input required value={sourceForm.layerId} onChange={(event) => setSourceForm({ ...sourceForm, layerId: event.target.value })} /></label><label>Zoning code field<input value={sourceForm.zoningCodeField} onChange={(event) => setSourceForm({ ...sourceForm, zoningCodeField: event.target.value })} /></label><label>Zoning description field<input value={sourceForm.zoningDescriptionField} onChange={(event) => setSourceForm({ ...sourceForm, zoningDescriptionField: event.target.value })} /></label><footer><button type="button" onClick={() => setShowAdd(false)}>Cancel</button><button className="za-command" type="submit"><Plus size={16} />Add candidate</button></footer></form></section></div>}

      {detail && <div className="za-modal-backdrop" role="presentation"><section className="za-modal za-detail" role="dialog" aria-modal="true" aria-labelledby="za-detail-title"><header><h3 id="za-detail-title">{detail.title}</h3><button type="button" onClick={() => setDetail(null)} title="Close"><X size={18} /></button></header><pre>{JSON.stringify(detail.value, null, 2)}</pre></section></div>}
    </div>
  );
}
