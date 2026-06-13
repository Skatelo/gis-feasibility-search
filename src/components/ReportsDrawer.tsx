import { useState, useEffect } from 'react';
import type { FC, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { X, FolderOpen, FileText, Trash2, Download, ArrowLeft, MapPin, Calendar, Loader2, AlertCircle } from 'lucide-react';
import { listSavedReports, deleteReport } from '../services/reportStore';
import type { SavedReport } from '../services/reportStore';

interface ReportsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Markdown renderer (injected from FeasibilitySearch to avoid duplication). */
  renderMarkdown: (text: string) => ReactNode;
}

/** Opens a print-ready window for a saved report so it can be saved as a PDF. */
function openSavedReportPdf(report: SavedReport, renderMarkdown: (text: string) => ReactNode) {
  const w = window.open('', '_blank');
  if (!w) {
    alert('Pop-up blocker is preventing opening the report. Please allow pop-ups for this site.');
    return;
  }
  const savedDate = new Date(report.savedAt).toLocaleString();
  w.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Land Feasibility Report - ${report.address}</title>
  <style>
    :root {
      --primary: #4f46e5; --success: #16a34a; --warning: #eab308; --danger: #dc2626;
      --text-primary: #0f172a; --text-secondary: #475569; --text-muted: #64748b;
      --bg-card-border: #e2e8f0; --bg-card: #ffffff; --bg-app: #f8fafc;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text-secondary); background: var(--bg-app); line-height: 1.6; padding: 80px 0 40px; }
    .report-container { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid var(--bg-card-border); border-radius: 12px; padding: 40px 48px; }
    .report-header { border-bottom: 2px solid var(--primary); padding-bottom: 18px; margin-bottom: 28px; }
    .report-header h1 { color: var(--text-primary); font-size: 1.6rem; margin-bottom: 6px; }
    .report-meta { font-size: 0.85rem; color: var(--text-muted); }
    h1, h2, h3, h4 { color: var(--text-primary); margin: 1.2em 0 0.5em; }
    table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.85rem; }
    th, td { border: 1px solid var(--bg-card-border); padding: 6px 10px; text-align: left; }
    th { background: #f1f5f9; }
    ul, ol { padding-left: 1.4rem; margin: 0.5rem 0; }
    a { color: var(--primary); }
    blockquote { border-left: 3px solid var(--primary); padding-left: 12px; color: var(--text-muted); margin: 0.75rem 0; }
    .control-header { position: fixed; top: 0; left: 0; right: 0; background: #fff; border-bottom: 1px solid var(--bg-card-border); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 10; }
    .btn-print { background: var(--primary); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-weight: 600; cursor: pointer; }
    .btn-close-w { background: transparent; color: var(--text-muted); border: 1px solid var(--bg-card-border); border-radius: 8px; padding: 8px 16px; cursor: pointer; margin-left: 8px; }
    @media print {
      body { padding: 0; background: #fff; }
      .control-header { display: none !important; }
      .report-container { border: none; padding: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="control-header">
    <strong>✨ Saved Feasibility Report</strong>
    <div>
      <button class="btn-print" onclick="window.print()">Save as PDF / Print</button>
      <button class="btn-close-w" onclick="window.close()">Close</button>
    </div>
  </div>
  <div class="report-container">
    <header class="report-header">
      <h1>Land Feasibility Study</h1>
      <div class="report-meta">📍 ${report.address} — ${report.county} County &nbsp;|&nbsp; Parcel ${report.parcelId} &nbsp;|&nbsp; Saved ${savedDate}</div>
    </header>
    <div id="print-root"></div>
  </div>
</body>
</html>`);
  w.document.close();
  const rootEl = w.document.getElementById('print-root');
  if (rootEl) {
    createRoot(rootEl).render(renderMarkdown(report.reportMarkdown));
  }
}

export const ReportsDrawer: FC<ReportsDrawerProps> = ({ isOpen, onClose, renderMarkdown }) => {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [selected, setSelected] = useState<SavedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setReports(await listSavedReports());
    } catch (e: any) {
      console.error(e);
      setError(e?.message || 'Failed to load your reports.');
    } finally {
      setLoading(false);
    }
  };

  // Refresh the list every time the drawer opens.
  useEffect(() => {
    if (isOpen) {
      setSelected(null);
      refresh();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDelete = async (id: string) => {
    try {
      await deleteReport(id);
    } catch (e: any) {
      setError(e?.message || 'Failed to delete the report.');
    }
    if (selected?.id === id) setSelected(null);
    refresh();
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer-container animate-slide-left"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: selected ? '760px' : undefined, width: selected ? 'min(760px, 95vw)' : undefined }}
      >
        {/* Header */}
        <div className="drawer-header">
          <div className="drawer-title-group" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {selected ? (
              <button
                onClick={() => setSelected(null)}
                className="drawer-close-btn"
                title="Back to report list"
                style={{ marginRight: '2px' }}
              >
                <ArrowLeft size={18} />
              </button>
            ) : (
              <FolderOpen size={20} />
            )}
            <div>
              <h3>{selected ? selected.address : 'My Reports'}</h3>
              <p>{selected ? `${selected.county} County — saved ${new Date(selected.savedAt).toLocaleString()}` : 'Saved feasibility reports for your account'}</p>
            </div>
          </div>
          <button onClick={onClose} className="drawer-close-btn">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="drawer-body" style={{ overflowY: 'auto' }}>
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger, #dc2626)', fontSize: '0.82rem', border: '1px solid #fecaca', background: '#fef2f2', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
              <AlertCircle size={15} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}
          {loading && !selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '48px 0', color: 'var(--text-muted)' }}>
              <Loader2 size={18} className="spinner" />
              <span style={{ fontSize: '0.85rem' }}>Loading your reports...</span>
            </div>
          ) : selected ? (
            <>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <button
                  className="btn-save-settings"
                  onClick={() => openSavedReportPdf(selected, renderMarkdown)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <Download size={15} />
                  <span>Download PDF</span>
                </button>
                <button
                  className="btn-logout"
                  onClick={() => handleDelete(selected.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <Trash2 size={15} />
                  <span>Delete</span>
                </button>
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                Parcel {selected.parcelId}
                {selected.acres ? ` • ${selected.acres.toFixed(2)} acres` : ''}
                {selected.zoningCode ? ` • Zoning ${selected.zoningCode}` : ''}
                {selected.ownerName ? ` • Owner: ${selected.ownerName}` : ''}
              </div>
              <div className="message-content model-text saved-report-body" style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
                {renderMarkdown(selected.reportMarkdown)}
              </div>
            </>
          ) : reports.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)' }}>
              <FileText size={36} style={{ opacity: 0.4, marginBottom: '12px' }} />
              <h4 style={{ color: 'var(--text-secondary)', marginBottom: '6px' }}>No saved reports yet</h4>
              <p style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
                Run a feasibility search, then click <strong>"Save to Reports"</strong> on the
                generated report to keep it here for later viewing and PDF download.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {reports.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelected(r)}
                  style={{
                    border: '1px solid var(--bg-card-border)',
                    borderRadius: '10px',
                    padding: '12px 14px',
                    cursor: 'pointer',
                    background: 'var(--bg-card, #fff)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <FileText size={18} style={{ color: 'var(--primary, #4f46e5)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.address}
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', display: 'flex', gap: '12px', marginTop: '2px', flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <MapPin size={11} /> {r.county} County
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <Calendar size={11} /> {new Date(r.savedAt).toLocaleDateString()}
                      </span>
                      {r.zoningCode && <span>Zoning {r.zoningCode}</span>}
                      {typeof r.acres === 'number' && <span>{r.acres.toFixed(2)} ac</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="drawer-close-btn"
                    title="Download as PDF"
                    onClick={(e) => { e.stopPropagation(); openSavedReportPdf(r, renderMarkdown); }}
                  >
                    <Download size={16} />
                  </button>
                  <button
                    type="button"
                    className="drawer-close-btn"
                    title="Delete report"
                    onClick={(e) => { e.stopPropagation(); handleDelete(r.id); }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
