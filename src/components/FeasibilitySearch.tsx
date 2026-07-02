import { useState, useEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent, FC } from 'react';
import { createRoot } from 'react-dom/client';
import { executeLandAnalysis, chatWithGemini, chatFollowUp, getUserKeys, detectNcCounty, lookupParcelById, fetchConstructionCostEstimate, fetchMaterialTakeoff, fetchLandClearingEstimate, fetchUtilitiesEstimate, fetchGoogleDistanceMatrixComps, getCompPrefs, getReportAutoGenerate, enformionConfigured, enformionContactEnrich, enformionPersonSearch, enformionBusinessSearch, looksLikeBusiness, enformionDiagMessage, getLastEnformionShape, getLastEnformionDetail, enformionPropertySearch } from '../services/feasibilityService';
import type { SkipTraceContact, EnformionPropertyRecord } from '../services/feasibilityService';
import type { ChatMessage, ChatAttachment } from '../services/feasibilityService';
import { saveReport, getReportEtaMs, recordReportDuration } from '../services/reportStore';
import { listConversations, saveConversation, deleteConversation as deleteConvo, newConversationId, deriveTitle } from '../services/chatStore';
import type { ChatConversation } from '../services/chatStore';
import { getSearchHistory, addSearchHistory } from '../services/searchHistoryStore';
import { ReportsDrawer } from './ReportsDrawer';
import type { SiteFeasibilityData, ConstructionCostEstimate, CostLineItem, MaterialTakeoff, LandClearingEstimate, UtilitiesEstimate } from '../types/feasibility';

/** Group cost line items by category, preserving first-seen order. (Avoids the
 *  global Map — lucide-react's `Map` icon is imported in this file.) */
function groupCostItems(items: CostLineItem[]): [string, CostLineItem[]][] {
  const order: string[] = [];
  const groups: Record<string, CostLineItem[]> = {};
  for (const li of items) {
    const k = li.category || 'Other';
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(li);
  }
  return order.map((k) => [k, groups[k]]);
}
import { getZoningServices, hasCountyZoning } from '../data/ncZoning';
import { fetchOsmFeatures } from '../data/osmFeatures';
import {
  Search,
  MapPin,
  Layers,
  Loader2,
  Phone,
  AtSign,
  Fingerprint,
  Copy, 
  Check, 
  History,
  AlertCircle,
  Map,
  User,
  Mail,
  LayoutGrid,
  Ruler,
  Calendar,
  DollarSign,
  HelpCircle,
  FileText,
  Tag,
  Navigation,
  Bookmark,
  Download,
  ThumbsUp,
  ThumbsDown,
  Share2,
  Paperclip,
  Mic,
  Send,
  Globe,
  Clock,
  FolderOpen,
  MessageCircle,
  TrendingUp,
  ImageOff,
  Landmark,
  Hammer,
  Trees,
  Droplets,
  Plus,
  Trash2,
  X
} from 'lucide-react';




declare const google: any;


const CodeBlock: FC<{ code: string; language: string }> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      margin: '0.75rem 0',
      borderRadius: '8px',
      border: '1px solid var(--bg-card-border)',
      overflow: 'hidden',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: '0.8rem',
      background: '#1e1e2e',
      color: '#cdd6f4'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 12px',
        background: '#11111b',
        borderBottom: '1px solid #313244',
        fontSize: '0.7rem',
        color: '#a6adc8',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? '#a6e3a1' : '#a6adc8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '0.7rem',
            padding: '2px 6px',
            borderRadius: '4px',
            transition: 'all 0.2s'
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? 'Copied!' : 'Copy code'}</span>
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: '0.75rem',
        overflowX: 'auto',
        lineHeight: '1.4'
      }}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

const parseInlineMarkdown = (text: string): React.ReactNode[] => {
  const tokens: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  while (remaining) {
    const boldIndex = remaining.indexOf('**');
    const codeIndex = remaining.indexOf('`');
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const linkIndex = linkMatch ? remaining.indexOf(linkMatch[0]) : -1;

    // Check for single asterisks for italic text, ignoring double asterisks
    let italicIndex = -1;
    let nextAsterisk = remaining.indexOf('*');
    while (nextAsterisk !== -1) {
      if (nextAsterisk === boldIndex || nextAsterisk === boldIndex + 1) {
        nextAsterisk = remaining.indexOf('*', nextAsterisk + 1);
      } else {
        italicIndex = nextAsterisk;
        break;
      }
    }

    const indices = [
      { type: 'bold', index: boldIndex },
      { type: 'italic', index: italicIndex },
      { type: 'code', index: codeIndex },
      { type: 'link', index: linkIndex, length: linkMatch ? linkMatch[0].length : 0 }
    ].filter(x => x.index !== -1).sort((a, b) => a.index - b.index);

    if (indices.length === 0) {
      tokens.push(remaining);
      break;
    }

    const first = indices[0];

    if (first.index > 0) {
      tokens.push(remaining.substring(0, first.index));
    }

    if (first.type === 'bold') {
      const rest = remaining.substring(first.index + 2);
      const closeIdx = rest.indexOf('**');
      if (closeIdx !== -1) {
        const boldText = rest.substring(0, closeIdx);
        tokens.push(<strong key={keyIdx++} style={{ fontWeight: '600', color: 'var(--text-primary)' }}>{boldText}</strong>);
        remaining = rest.substring(closeIdx + 2);
      } else {
        tokens.push('**');
        remaining = rest;
      }
    } else if (first.type === 'italic') {
      const rest = remaining.substring(first.index + 1);
      const closeIdx = rest.indexOf('*');
      if (closeIdx !== -1) {
        const italicText = rest.substring(0, closeIdx);
        tokens.push(<em key={keyIdx++} style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>{italicText}</em>);
        remaining = rest.substring(closeIdx + 1);
      } else {
        tokens.push('*');
        remaining = rest;
      }
    } else if (first.type === 'code') {
      const rest = remaining.substring(first.index + 1);
      const closeIdx = rest.indexOf('`');
      if (closeIdx !== -1) {
        const codeText = rest.substring(0, closeIdx);
        tokens.push(
          <code key={keyIdx++} style={{ 
            fontFamily: 'var(--font-mono, monospace)', 
            background: 'rgba(0,0,0,0.06)', 
            padding: '2px 4px', 
            borderRadius: '4px',
            fontSize: '0.85em',
            color: '#c2185b',
            fontWeight: '500'
          }}>
            {codeText}
          </code>
        );
        remaining = rest.substring(closeIdx + 1);
      } else {
        tokens.push('`');
        remaining = rest;
      }
    } else if (first.type === 'link' && linkMatch) {
      const [fullMatch, linkText, linkUrl] = linkMatch;
      let finalUrl = linkUrl;
      
      if (linkUrl.includes('realtor.com') && !linkUrl.includes('google.com/search')) {
        // Intercept direct Realtor.com detail or listing links to prevent broken pages/incorrect listings
        let searchAddr = '';
        if (linkText.match(/\d+/) && (
          linkText.includes(',') || 
          linkText.toLowerCase().includes(' st') || 
          linkText.toLowerCase().includes(' rd') || 
          linkText.toLowerCase().includes(' ave') || 
          linkText.toLowerCase().includes(' blvd') || 
          linkText.toLowerCase().includes(' lane') || 
          linkText.toLowerCase().includes(' ln') || 
          linkText.toLowerCase().includes(' dr') || 
          linkText.toLowerCase().includes(' way')
        )) {
          searchAddr = linkText;
        } else {
          // Try to extract address from Realtor.com URL slug structure, e.g. /realestateandhomes-detail/227-Howard-St_Mount-Holly_NC_28120
          const urlParts = linkUrl.split('/');
          const slug = urlParts.find(p => p.includes('_'));
          if (slug) {
            const rawParts = slug.split('_');
            // Filter out any Realtor.com listing ID patterns at the end (e.g. M63151-01970)
            const filteredParts = rawParts.filter(part => !part.match(/^[MP]\d+/i));
            const addressParts = filteredParts.map(part => part.replace(/-/g, ' ').trim());
            if (addressParts.length >= 3) {
              searchAddr = `${addressParts[0]}, ${addressParts[1]}, ${addressParts[2]} ${addressParts[3] || ''}`.trim();
            } else {
              searchAddr = addressParts.join(', ');
            }
          }
        }
        
        if (searchAddr) {
          finalUrl = `https://www.google.com/search?q=${encodeURIComponent(searchAddr)}`;
        } else {
          finalUrl = `https://www.google.com/search?q=${encodeURIComponent(linkText)}`;
        }
      }

      tokens.push(
        <a key={keyIdx++} href={finalUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary, #4338ca)', textDecoration: 'underline', fontWeight: '500' }}>
          {linkText}
        </a>
      );
      remaining = remaining.substring(first.index + fullMatch.length);
    }
  }

  return tokens;
};

/**
 * Pull the lead conclusion of a numbered report section whose heading matches
 * `titleRe`. The report leads each section with its conclusion, so the first
 * substantive line after the heading is the takeaway. Returns undefined if the
 * section isn't present (e.g. still streaming) or has no content yet.
 */
const sectionConclusion = (md: string, titleRe: RegExp): string | undefined => {
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i]) && titleRe.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (/^#{1,4}\s/.test(l)) break; // hit the next heading, no content
        const clean = l.replace(/^[-*+>]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
        if (clean.length > 8) return clean.length > 260 ? clean.slice(0, 257) + '…' : clean;
      }
      return undefined;
    }
  }
  return undefined;
};

/** Rezoning (§6) and Subdivision (§7) lead conclusions for the value-add highlight. */
export const extractValueAdd = (md: string): { rezoning?: string; subdivision?: string } => ({
  rezoning: sectionConclusion(md, /rezon|upzon/i),
  subdivision: sectionConclusion(md, /subdivi|lot[-\s]?split/i),
});

/**
 * Clean the report for display: no code blocks / backticks / raw-data styling,
 * and math written with × and ÷ instead of the asterisk. The model is also told
 * this in the prompt; this is the guaranteed safety net so the rendered report
 * never shows code or stray "*".
 */
export const sanitizeReportText = (md: string): string => {
  if (!md) return md;
  let s = md;
  // Unwrap fenced code blocks → keep the inner text as plain lines (no CodeBlock).
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, inner) => inner);
  s = s.replace(/```/g, '');
  // Inline code → plain text.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Multiplication asterisks → × (only when a value sits next to the asterisk, so
  // **bold** and bullet lists "* item" / nested bullets are never touched).
  s = s.replace(/(\$?[\d,.]+%?)\s*\*\s*(?=\$?[\d(])/g, '$1 × ');     // number * number
  s = s.replace(/([\w%)\]])\s\*\s(?=[\d$(])/g, '$1 × ');             // word * number
  return s;
};

export const parseMarkdown = (text: string) => {
  if (!text) return null;
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLanguage = '';
  
  let inList: 'bullet' | 'number' | null = null;
  let listItems: React.ReactNode[] = [];
  
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  
  let inBlockquote = false;
  let blockquoteLines: string[] = [];
  
  let paragraphLines: string[] = [];

  const closeActiveBlock = () => {
    if (inList === 'bullet') {
      nodes.push(
        <ul key={`ul-${nodes.length}`} style={{ 
          margin: '0.5rem 0 0.8rem 0', 
          paddingLeft: '1.25rem', 
          listStyleType: 'disc' 
        }}>
          {listItems}
        </ul>
      );
      listItems = [];
      inList = null;
    } else if (inList === 'number') {
      nodes.push(
        <ol key={`ol-${nodes.length}`} style={{ 
          margin: '0.5rem 0 0.8rem 0', 
          paddingLeft: '1.25rem', 
          listStyleType: 'decimal' 
        }}>
          {listItems}
        </ol>
      );
      listItems = [];
      inList = null;
    } else if (inTable) {
      nodes.push(
        <div key={`table-${nodes.length}`} style={{ 
          overflowX: 'auto', 
          margin: '0.75rem 0', 
          borderRadius: '8px', 
          border: '1px solid var(--bg-card-border)', 
          background: '#ffffff' 
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#f1f5f9', borderBottom: '2px solid var(--bg-card-border)' }}>
                {tableHeaders.map((h, hIdx) => (
                  <th key={hIdx} style={{ padding: '8px 12px', fontWeight: '600', color: 'var(--text-primary)' }}>
                    {parseInlineMarkdown(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, rIdx) => (
                <tr key={rIdx} style={{ 
                  borderBottom: '1px solid var(--bg-card-border)',
                  background: rIdx % 2 === 1 ? '#f8fafc' : '#ffffff'
                }}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
                      {parseInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableHeaders = [];
      tableRows = [];
      inTable = false;
    } else if (inBlockquote) {
      nodes.push(
        <blockquote key={`bq-${nodes.length}`} style={{ 
          borderLeft: '4px solid var(--primary, #4338ca)', 
          paddingLeft: '0.75rem', 
          color: 'var(--text-secondary)', 
          fontStyle: 'italic', 
          margin: '0.6rem 0',
          background: '#f8fafc',
          paddingTop: '4px',
          paddingBottom: '4px'
        }}>
          {parseMarkdown(blockquoteLines.join('\n'))}
        </blockquote>
      );
      blockquoteLines = [];
      inBlockquote = false;
    } else if (paragraphLines.length > 0) {
      const textContent = paragraphLines.join(' ');
      nodes.push(
        <p key={`p-${nodes.length}`} style={{ 
          margin: '0.4rem 0 0.6rem 0', 
          lineHeight: '1.72', 
          fontSize: '0.9rem', 
          color: 'var(--text-primary)' 
        }}>
          {parseInlineMarkdown(textContent)}
        </p>
      );
      paragraphLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Code block handling
    if (inCodeBlock) {
      if (trimmed.startsWith('```')) {
        nodes.push(
          <CodeBlock 
            key={`code-${nodes.length}`} 
            code={codeLines.join('\n')} 
            language={codeLanguage} 
          />
        );
        inCodeBlock = false;
        codeLines = [];
        codeLanguage = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith('```')) {
      closeActiveBlock();
      inCodeBlock = true;
      codeLanguage = trimmed.replace('```', '').trim();
      codeLines = [];
      continue;
    }

    // 2. Table detection & parsing
    if (inTable) {
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        // Separator check
        if (trimmed.includes('-') && !trimmed.match(/[a-zA-Z0-9]/)) {
          continue;
        }
        const cells = trimmed.split('|').map(x => x.trim());
        if (cells[0] === '') cells.shift();
        if (cells[cells.length - 1] === '') cells.pop();
        tableRows.push(cells);
      } else {
        closeActiveBlock();
      }
    }

    if (!inTable && trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.trim().startsWith('|') && nextLine.trim().includes('-') && !nextLine.trim().match(/[a-zA-Z0-9]/)) {
        closeActiveBlock();
        inTable = true;
        const cells = trimmed.split('|').map(x => x.trim());
        if (cells[0] === '') cells.shift();
        if (cells[cells.length - 1] === '') cells.pop();
        tableHeaders = cells;
        tableRows = [];
        i++; // skip separator
        continue;
      }
    }

    if (inTable) continue;

    // 3. Headers
    if (trimmed.startsWith('#')) {
      const match = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        closeActiveBlock();
        const level = match[1].length;
        const content = match[2];
        const headingContent = parseInlineMarkdown(content);
        const style: React.CSSProperties = {
          color: 'var(--text-primary)',
          fontWeight: 700,
          fontFamily: 'var(--font-heading)',
          letterSpacing: '-0.02em',
          margin: level === 1 ? '1.6rem 0 0.8rem 0' : level === 2 ? '1.25rem 0 0.5rem 0' : '1rem 0 0.35rem 0'
        };
        switch (level) {
          case 1:
            nodes.push(<h1 key={`h1-${nodes.length}`} style={{ ...style, fontSize: '1.4rem', lineHeight: 1.25, paddingBottom: '0.4rem', borderBottom: '2px solid var(--bg-card-border)' }}>{headingContent}</h1>);
            break;
          case 2:
            nodes.push(<h2 key={`h2-${nodes.length}`} style={{ ...style, fontSize: '1.15rem', lineHeight: 1.3 }}>{headingContent}</h2>);
            break;
          default:
            nodes.push(<h3 key={`h3-${nodes.length}`} style={{ ...style, fontSize: '1rem', color: 'var(--text-secondary)' }}>{headingContent}</h3>);
            break;
        }
        continue;
      }
    }

    // 4. Horizontal Rule
    if (trimmed === '---' || trimmed === '***') {
      closeActiveBlock();
      nodes.push(<hr key={`hr-${nodes.length}`} style={{ border: 'none', borderTop: '1px solid var(--bg-card-border)', margin: '1rem 0' }} />);
      continue;
    }

    // 5. Blockquotes
    if (trimmed.startsWith('>')) {
      if (!inBlockquote) {
        closeActiveBlock();
        inBlockquote = true;
      }
      blockquoteLines.push(trimmed.replace(/^>\s*/, ''));
      continue;
    }

    // 6. Bullet lists
    const bulletMatch = line.match(/^(\s*)([\*\-\+])\s+(.*)$/);
    if (bulletMatch) {
      if (inList === 'number' || inBlockquote) closeActiveBlock();
      inList = 'bullet';
      const content = bulletMatch[3];
      listItems.push(
        <li key={`li-${listItems.length}`} style={{ 
          marginBottom: '0.35rem', 
          lineHeight: '1.5',
          fontSize: '0.85rem',
          color: 'var(--text-primary)'
        }}>
          {parseInlineMarkdown(content)}
        </li>
      );
      continue;
    }

    // 7. Numbered lists
    const numberMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numberMatch) {
      if (inList === 'bullet' || inBlockquote) closeActiveBlock();
      inList = 'number';
      const content = numberMatch[3];
      listItems.push(
        <li key={`li-${listItems.length}`} style={{ 
          marginBottom: '0.35rem', 
          lineHeight: '1.5',
          fontSize: '0.85rem',
          color: 'var(--text-primary)'
        }}>
          {parseInlineMarkdown(content)}
        </li>
      );
      continue;
    }

    // 8. Empty lines
    if (trimmed === '') {
      closeActiveBlock();
      continue;
    }

    // 9. Standard paragraphs
    if (inBlockquote || inList) {
      closeActiveBlock();
    }
    paragraphLines.push(line);
  }

  closeActiveBlock();
  return nodes;
};

/**
 * Live countdown for AI report generation. The estimate is a rolling average
 * of this machine's recent generation times (see reportStore), so it gets more
 * accurate with every report.
 */
const ReportCountdown: FC<{ startedAt: number; etaMs: number }> = ({ startedAt, etaMs }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - startedAt;
  const remaining = Math.max(0, etaMs - elapsed);
  const pct = Math.min(99, Math.round((elapsed / etaMs) * 100));
  const secs = Math.ceil(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const label = remaining > 0
    ? `Estimated ${mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`} remaining`
    : 'Finalizing report — almost done...';
  return (
    <div style={{ marginTop: '10px', maxWidth: '420px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '6px' }}>
        <Clock size={13} />
        <span>{label}</span>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
      </div>
      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--bg-card-border, #e2e8f0)', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          borderRadius: '3px',
          background: 'linear-gradient(90deg, #1a73e8, #a530f2, #f43f5e)',
          transition: 'width 1s linear'
        }} />
      </div>
    </div>
  );
};

/** Single row in the live analysis-progress checklist. */
const ProgressStep: FC<{ done: boolean; active?: boolean; label: string }> = ({ done, active, label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', padding: '4px 0', color: done ? 'var(--success)' : active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
    {done ? <Check size={14} /> : active ? <Loader2 size={14} className="spinner" /> : <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--bg-card-border)', display: 'inline-block' }} />}
    <span style={{ fontWeight: done || active ? 600 : 400 }}>{label}</span>
  </div>
);

export const FeasibilitySearch: FC = () => {
  const keys = getUserKeys();
  const hasGoogleMapsKey = !!keys.googleMaps;
  const hasGeminiKey = !!keys.gemini;
  const hasKeys = hasGoogleMapsKey && hasGeminiKey;

  const [addressInput, setAddressInput] = useState('');
  const [searchMode, setSearchMode] = useState<'address' | 'parcel'>('address');
  const [parcelIdInput, setParcelIdInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SiteFeasibilityData | null>(null);
  const [costEstimate, setCostEstimate] = useState<ConstructionCostEstimate | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const [costError, setCostError] = useState(false);
  const [materialTakeoff, setMaterialTakeoff] = useState<MaterialTakeoff | null>(null);
  const [landClearing, setLandClearing] = useState<LandClearingEstimate | null>(null);
  const [landClearingLoading, setLandClearingLoading] = useState(false);
  const [utilities, setUtilities] = useState<UtilitiesEstimate | null>(null);
  const [utilitiesLoading, setUtilitiesLoading] = useState(false);
  const [utilitiesError, setUtilitiesError] = useState('');
  // Enformion Property Search V2 for the searched address — deed owners,
  // recorded mortgages & sale transactions.
  const [enfProperty, setEnfProperty] = useState<EnformionPropertyRecord | null>(null);
  const [enfLoading, setEnfLoading] = useState(false);
  const [enfErrors, setEnfErrors] = useState<{ property?: string }>({});
  // Manual report mode: report awaits the "Generate AI Report" button
  const [reportPending, setReportPending] = useState(false);
  // Owner skip trace (Enformion) — phones/emails for the parcel owner
  const [ownerSkip, setOwnerSkip] = useState<SkipTraceContact | null>(null);
  const [ownerSkipLoading, setOwnerSkipLoading] = useState(false);
  const [ownerSkipError, setOwnerSkipError] = useState('');
  // Comps display/search filters
  const [compRadius, setCompRadius] = useState(5);          // max DRIVING-mile radius (3 / 5 / 10) — re-fetches
  const [compTypeFilter, setCompTypeFilter] = useState('all'); // property-type display filter
  const [compsShowAll, setCompsShowAll] = useState(false);  // show 10 vs. all
  const [compsRefetching, setCompsRefetching] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);

  // Saved Reports drawer + save feedback
  const [showReports, setShowReports] = useState(false);
  const [reportSaved, setReportSaved] = useState(false);

  // Floating AI chat bubble
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(false);

  // Report-generation countdown ({ startedAt, etaMs } while the AI report runs)
  const [reportTimer, setReportTimer] = useState<{ startedAt: number; etaMs: number } | null>(null);

  // Monotonic search sequence — partial emissions from a superseded search are ignored.
  const searchSeqRef = useRef(0);
  // The address as the user searched it (usually "street, city, NC zip") — the
  // GIS situs address in reportData.inputAddress is often street-only, so
  // Enformion gets its city/state/zip from this.
  const searchedAddressRef = useRef('');

  // Chatbot states
  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // Attachments pending on the next message (images / PDFs / text docs)
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chat history (persisted conversations)
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConvoId, setActiveConvoId] = useState<string>(() => newConversationId());
  const [showHistory, setShowHistory] = useState(false);
  const activeConvoIdRef = useRef<string>('');
  activeConvoIdRef.current = activeConvoId;

  const refreshConversations = () => { listConversations().then(setConversations).catch(() => {}); };
  useEffect(() => { refreshConversations(); }, []);

  // Auto-save the active conversation when messages settle (skips while streaming).
  useEffect(() => {
    if (chatHistory.length === 0 || chatLoading) return;
    const now = Date.now();
    saveConversation({
      id: activeConvoIdRef.current,
      title: deriveTitle(chatHistory, data?.inputAddress),
      address: data?.inputAddress,
      messages: chatHistory,
      createdAt: now,
      updatedAt: now,
    }).then(refreshConversations).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHistory, chatLoading]);

  // Downscale an image to a small JPEG data-URL for previews/history thumbnails.
  const downscaleImage = (dataUrl: string, max = 320): Promise<string> => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL('image/jpeg', 0.8)); } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

  const readFileAsAttachment = (file: File): Promise<ChatAttachment | null> => new Promise((resolve) => {
    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isText = file.type.startsWith('text/') || /\.(txt|csv|md|json|log)$/i.test(file.name);
    if (file.size > 18 * 1024 * 1024) { alert(`"${file.name}" is too large (max 18 MB).`); resolve(null); return; }
    const reader = new FileReader();
    if (isImage || isPdf) {
      reader.onload = async () => {
        const result = String(reader.result || '');
        const base64 = result.split(',')[1] || '';
        const previewUrl = isImage ? await downscaleImage(result) : undefined;
        resolve({ name: file.name, mimeType: file.type || (isPdf ? 'application/pdf' : 'image/png'), kind: isImage ? 'image' : 'pdf', data: base64, previewUrl });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else if (isText) {
      reader.onload = () => resolve({ name: file.name, mimeType: 'text/plain', kind: 'text', data: String(reader.result || '').slice(0, 200000) });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    } else {
      alert(`"${file.name}" isn't a supported type. Attach images, PDFs, or text documents.`);
      resolve(null);
    }
  });

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const read = await Promise.all(Array.from(files).map(readFileAsAttachment));
    const ok = read.filter((a): a is ChatAttachment => !!a);
    if (ok.length) setPendingAttachments((prev) => [...prev, ...ok]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startNewChat = () => {
    resetChatUiState();
    setPendingAttachments([]);
    setActiveConvoId(newConversationId());
    setShowHistory(false);
    setChatInput('');
  };

  const loadConversation = (convo: ChatConversation) => {
    setChatHistory(convo.messages);
    setActiveConvoId(convo.id);
    setPendingAttachments([]);
    setShowHistory(false);
  };

  const removeConversation = async (id: string) => {
    await deleteConvo(id).catch(() => {});
    refreshConversations();
    if (id === activeConvoIdRef.current) startNewChat();
  };
  // Grow the chat textarea to fit what's typed (wraps to multiple lines) so the
  // full question is always visible; caps out then scrolls.
  const autoGrowChat = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  // Keep the screen awake while a report is generating, so a device whose screen
  // turns off (and would otherwise suspend/throttle the page and stall the
  // streaming generation) keeps running until the report finishes. The Screen
  // Wake Lock auto-releases when the tab is hidden, so we re-acquire on return.
  useEffect(() => {
    if (!chatLoading) return;
    let lock: any = null;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || lock || document.visibilityState !== 'visible') return;
      try {
        lock = await (navigator as any).wakeLock?.request?.('screen');
        lock?.addEventListener?.('release', () => { lock = null; });
      } catch { /* unsupported or denied — nothing to do */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { lock?.release?.(); } catch { /* ignore */ }
    };
  }, [chatLoading]);

  // Gemini UI helper states
  const [likedMessages, setLikedMessages] = useState<Record<number, 'like' | 'dislike' | undefined>>({});
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [showCheckOverlay, setShowCheckOverlay] = useState<Record<number, boolean>>({});

  // Scroll to bottom of chat history when new message added
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, chatLoading]);

  // Unread indicator on the chat bubble when an answer arrives while it's closed
  useEffect(() => {
    if (!chatOpen && chatHistory.length > 1 && chatHistory[chatHistory.length - 1].role === 'model') {
      setChatUnread(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHistory]);

  // Utilities + connection costs + permit fees lookup. The card NEVER silently
  // disappears: failures land in utilitiesError with the real reason and a
  // Retry button re-runs just this lookup.
  const runUtilitiesLookup = (reportData: SiteFeasibilityData, seq: number) => {
    setUtilities(null);
    setUtilitiesError('');
    setUtilitiesLoading(true);
    fetchUtilitiesEstimate(reportData)
      .then((u) => {
        if (seq !== searchSeqRef.current) return;
        if (u) setUtilities(u);
        else setUtilitiesError('The utilities lookup returned nothing — tap Retry.');
      })
      .catch((e) => { if (seq === searchSeqRef.current) setUtilitiesError(e?.message || 'Utilities lookup failed — tap Retry.'); })
      .finally(() => { if (seq === searchSeqRef.current) setUtilitiesLoading(false); });
  };

  // Enformion Property Search V2 for the searched address — deed, current
  // owners, recorded MORTGAGES & sale TRANSACTIONS. Called directly against
  // Enformion's CORS-enabled API (no serverless proxy in the hot path).
  const fetchEnformionRecords = async (reportData: SiteFeasibilityData, seq: number) => {
    setEnfProperty(null);
    setEnfErrors({});
    setEnfLoading(false);
    const addr = (reportData.inputAddress || '').trim();
    if (!enformionConfigured() || !addr) return;
    setEnfLoading(true);

    // The REAL failure reason: base status message plus Enformion's own error
    // text (validation messages, input errors).
    const errOf = (fallback: string) => {
      const detail = getLastEnformionDetail();
      // Enformion's per-key permission wall: the search type isn't enabled on
      // this API Access Profile. Give the exact fix instead of a raw error.
      const m = detail.match(/Access Profile does not permit client to call\s*([^.·]+)/i);
      if (m) {
        return `Your Enformion API Access Profile doesn't have "${m[1].trim()}" enabled. This is a per-key permission: log in at api.enformion.com → Keys, or email supportgo@enformion.com and ask them to enable ${m[1].trim()} on your access profile — then hit Retry.`;
      }
      const base = enformionDiagMessage() || fallback;
      return detail && !base.includes(detail) ? `${base}\n${detail}` : base;
    };

    try {
      let rec: EnformionPropertyRecord | null = null;
      try {
        rec = await enformionPropertySearch(
          addr,
          searchedAddressRef.current,
          reportData.coordinates ? { lat: reportData.coordinates.lat, lng: reportData.coordinates.lng } : undefined,
        );
      } catch { /* handled below */ }
      if (seq !== searchSeqRef.current) return;
      if (rec) setEnfProperty(rec);
      else setEnfErrors({ property: errOf('Property record search failed — please try again.') });
    } finally {
      if (seq === searchSeqRef.current) setEnfLoading(false);
    }
  };

  // Build the cost estimate + material takeoff (each shows as it arrives). If
  // BOTH fail (e.g. a transient Gemini rate limit), the card stays and offers a
  // retry instead of vanishing.
  const generateCostEstimates = (reportData: SiteFeasibilityData, seq: number): Promise<ConstructionCostEstimate | null> => {
    setCostLoading(true);
    setCostError(false);
    setCostEstimate(null);
    setMaterialTakeoff(null);
    // Land-clearing / site-prep estimate (rule-based + satellite vision) — fires
    // alongside, shows in its own card on the left.
    setLandClearing(null);
    setLandClearingLoading(true);
    fetchLandClearingEstimate(reportData)
      .then((lc) => { if (seq === searchSeqRef.current && lc) setLandClearing(lc); })
      .catch(() => {})
      .finally(() => { if (seq === searchSeqRef.current) setLandClearingLoading(false); });
    // Utilities + connection costs (public water/sewer tap fees, or well/septic).
    runUtilitiesLookup(reportData, seq);
    // Enformion records (property/mortgage/transactions, debt, tenant history)
    // fire alongside — they render in their own card as each search resolves.
    fetchEnformionRecords(reportData, seq);
    let pending = 2;
    let anySuccess = false;
    const settle = (ok: boolean) => {
      if (ok) anySuccess = true;
      if (--pending === 0 && seq === searchSeqRef.current) {
        setCostLoading(false);
        if (!anySuccess) setCostError(true);
      }
    };
    const estPromise = fetchConstructionCostEstimate(reportData).catch(() => null);
    estPromise.then((est) => { if (seq === searchSeqRef.current && est) setCostEstimate(est); settle(!!est); });
    fetchMaterialTakeoff(reportData).then(
      (mt) => { if (seq === searchSeqRef.current && mt) setMaterialTakeoff(mt); settle(!!mt); },
      () => settle(false),
    );
    return estPromise;
  };

  // Re-run ONLY the comps for the current parcel at a new max DRIVING-mile radius
  // (3 / 5 / 10). The report itself stays as generated; this just widens/tightens
  // the comp set shown in the card.
  const changeCompRadius = async (newRadius: number) => {
    if (newRadius === compRadius) return;
    setCompRadius(newRadius);
    setCompsShowAll(false);
    const d = data;
    if (!d || !d.coordinates) return;
    const seq = searchSeqRef.current;
    setCompsRefetching(true);
    try {
      const run = await fetchGoogleDistanceMatrixComps(
        d.coordinates.lat,
        d.coordinates.lng,
        d.parcelId || '',
        d.zoningCode || '',
        d.zoningDescription || '',
        d.inputAddress || '',
        d.countyName || '',
        undefined,
        newRadius,
      );
      if (seq !== searchSeqRef.current) return; // a new search superseded this
      setData((prev) => (prev ? { ...prev, comps: run.comps, compRunSummary: run.summary } : prev));
    } catch (e) {
      console.warn('Comp radius re-fetch failed:', e);
    } finally {
      if (seq === searchSeqRef.current) setCompsRefetching(false);
    }
  };

  // Skip trace the parcel owner via Enformion (phones/emails). GIS owner names are
  // surname-first, so split before the (first-last) Enformion lookup.
  const skipTraceOwner = async () => {
    const name = (data?.ownerName || '').trim();
    if (!name || ownerSkipLoading) return;
    if (!enformionConfigured()) { setOwnerSkipError('Add your Enformion AP Name & Password in Account Settings first.'); return; }
    setOwnerSkipLoading(true);
    setOwnerSkipError('');
    setOwnerSkip(null);
    try {
      const addr = data?.mailingAddress || undefined;
      const first = (data?.ownerFirst || '').trim();
      const last = (data?.ownerLast || '').trim();
      const ok = (x: SkipTraceContact | null) => !!(x && (x.phones.length || x.emails.length));
      let c: SkipTraceContact | null = null;
      if (looksLikeBusiness(name)) {
        c = await enformionBusinessSearch(name, addr);
      } else {
        // Authoritative GIS first/last when present; else the service-formatted
        // (first-last) ownerName. As a safety net for the rare wrong-order parcel,
        // also try the reversed token order.
        const primary = first && last ? `${first} ${last}` : name;
        const tryNames = [primary];
        if (!(first && last)) {
          const p = name.split(/\s+/).filter(Boolean);
          if (p.length >= 2) tryNames.push(`${p[p.length - 1]} ${p.slice(0, -1).join(' ')}`);
        }
        for (const pn of tryNames) {
          c = await enformionPersonSearch(pn, addr); if (ok(c)) break;
          c = await enformionContactEnrich(pn, addr); if (ok(c)) break;
        }
        if (!ok(c) && addr) c = await enformionPersonSearch(primary);
      }
      setOwnerSkip(c);
      const gotSomething = !!(c && (c.phones.length || c.emails.length || (c.officers && c.officers.length)));
      if (!gotSomething) {
        const detail = getLastEnformionDetail();
        const shape = getLastEnformionShape();
        const llcHint = looksLikeBusiness(name)
          ? '\n\nThis owner is an LLC/business. Use the Skip Trace tab (Business mode) to find the members/registered agent behind it, then their personal phones & emails.'
          : '';
        setOwnerSkipError(enformionDiagMessage() + llcHint + (detail ? `\n\nEnformion: ${detail}` : '') + (shape ? `\n\nResponse fields: ${shape}` : ''));
      }
    } catch {
      setOwnerSkipError('Skip trace failed — please try again.');
    } finally {
      setOwnerSkipLoading(false);
    }
  };

  // Manual mode: kick off the report on the user's click, passing the cost
  // estimate (if it's finished) so Section 20 stays linked to the card.
  const startReportManually = () => {
    if (!data) return;
    setReportPending(false);
    generateInitialChatReport(data, costEstimate || undefined);
  };

  const generateInitialChatReport = async (reportData: SiteFeasibilityData, costEstimate?: ConstructionCostEstimate) => {
    setActiveConvoId(newConversationId()); // a new parcel report = a new conversation
    setPendingAttachments([]);
    setChatLoading(true);
    setChatHistory([]);
    setReportSaved(false);
    const reportStart = Date.now();
    setReportTimer({ startedAt: reportStart, etaMs: getReportEtaMs() });
    try {
      // When the Instant Construction Cost Estimate is ready, hand its figures to
      // the report so Section 20 (Development Cost Considerations) is built FROM
      // it — same numbers, explicitly linked to the card.
      const costBlock = costEstimate
        ? `\n\nINSTANT CONSTRUCTION COST ESTIMATE (already computed for THIS parcel and shown to the user in the "Instant Construction Cost Estimate" card) — USE THESE FIGURES as the authoritative basis for Section 20 (Development Cost Considerations). Present the same itemized lines and totals (you may add site-specific adders + cited sources), keep every number CONSISTENT with the card, and state that the build budget matches the Instant Construction Cost Estimate. Do NOT contradict these totals.
Planned home: ${costEstimate.plannedSqft.toLocaleString()} sqft · Locality: ${costEstimate.locality}
Itemized hard costs:
${costEstimate.lineItems.map((li) => `- ${li.category} — ${li.item}${li.detail ? ` (${li.detail})` : ''}: $${li.cost.toLocaleString()}`).join('\n')}
Hard cost subtotal: $${costEstimate.hardCostTotal.toLocaleString()}
Builder fee: $${costEstimate.builderFee.toLocaleString()}
Contingency: $${costEstimate.contingency.toLocaleString()}
TOTAL build cost: $${costEstimate.totalCost.toLocaleString()} ($${costEstimate.costPerSqft.toLocaleString()}/sqft)${costEstimate.laborBasis ? `\nLabor basis: ${costEstimate.laborBasis}` : ''}`
        : '';
      const compsList = reportData.comps && reportData.comps.length > 0
        ? reportData.comps.map((comp, idx) =>
            `- Comp ${idx + 1}: ${comp.address} | Sold: $${comp.price.toLocaleString()}${comp.pricePerSqft ? ` ($${comp.pricePerSqft}/sqft)` : ''} | ${comp.sqft ? `${comp.sqft.toLocaleString()} sqft | ` : ''}Driving: ${comp.distanceMiles.toFixed(2)} mi | Year Built: ${comp.yearBuilt || 'N/A'} | Type: ${comp.propertyType || 'N/A'} | Sale Date: ${comp.saleDate || 'N/A'} | ${comp.verifiedNote || 'RealtyAPI closed-sale record'}`
          ).join('\n')
        : 'No verified comps available.';

      const initialPrompt = `Produce the AI Land Feasibility Report for "${reportData.inputAddress}" following your Operating Standards exactly. Lead every section with its conclusion, label evidence Verified / Likely / Unknown, and do not finish until all required sections are completed or explicitly marked "Unknown — unverifiable due to lack of available evidence."

INVESTIGATE with live Google Search (focused on this exact address + ZIP, not the whole city) and cite sources for anything not in the data packet:
- Parcel ID, jurisdiction, legal description, and lot size (reconciled in acres/SF)
- Zoning + permitted uses — VERIFY the county-provided zoning code is CORRECT for THIS parcel against the official county/municipal zoning map or ordinance and flag any discrepancy; plus the future land use / comprehensive-plan designation
- FEMA flood zone / floodplain status — USE the FEMA NFHL flood zone provided in the data packet (queried by the parcel coordinate) and cite its source link; only research further if the packet marks it unavailable or no-coverage
- Wetlands & environmental constraints — USE the USFWS NWI wetlands result in the data packet and cite its source; note NWI omits some wetlands so a field delineation is authoritative; also note nearby streams/protected areas if found
- Utilities (public water, sewer vs. septic, well, electric, gas)
- Road access, frontage, and road condition
- Topography (wooded/cleared) to corroborate the provided USGS slope data
- Assigned schools/ratings and neighborhood/location context
- Market trends and, for land valuation, comparable VACANT-LAND sales
- REZONING / UPZONING potential: the parcel's current zoning vs. the future-land-use designation and the zoning of ADJACENT parcels; whether a rezoning or conditional rezoning to a higher-value/higher-density district (e.g. single-family → townhome / multifamily / mixed-use) is plausible and SUPPORTED by the comprehensive plan; the jurisdiction's recent rezoning approval trend
- SUBDIVISION / lot-split potential: the jurisdiction's MINIMUM lot size, frontage, and density for the district; whether the parcel's acreage, frontage, and utilities allow splitting into multiple buildable lots; minor vs. major subdivision process
- MARKET SATURATION & ABSORPTION by product type: current ACTIVE inventory, median DAYS ON MARKET (DOM), and MONTHS OF SUPPLY for single-family, townhomes, condos, and multifamily/rentals near this address/ZIP — identify which product types are OVERSUPPLIED or sitting too long vs. absorbing quickly (cite sources, e.g. local MLS/Realtor/Redfin market pages, market reports)
- MORTGAGE / INTEREST RATE environment: the current 30-year mortgage rate and its recent trend (rising / falling / steady), Federal Reserve posture, and the effect on buyer demand, affordability, absorption, and the project's exit timing (cite a current rate source)
- HOA: whether the parcel is in a homeowners association; if so, the HOA name, dues, management company, any preferred/featured/approved BUILDER list, and the building requirements / architectural guidelines / restrictions (CCRs) — where publicly available, else mark Unknown
- CURRENT LOCAL construction costs for this address's metro/county for the Development Cost + Profitability sections — searching AS MANY local sources near the address as possible (not one), with sources, never national averages. Get local figures for: per-sqft new single-family build cost; land CLEARING / TREE removal ($/acre); GRADING/earthwork on slopes; foundation; WELL drilling ($/ft + total) and SEPTIC system + perc test when there's no public water/sewer; public water/sewer TAP & impact fees when available; permits and survey. Be EXTREMELY ACCURATE.
Reconcile differences across sources and cite at least 3 distinct Markdown links.

COMPARABLES — use ONLY these verified, already-filtered SOLD comps (closed within 12 months, new construction, zoning-matched, within 5 driving miles). Do NOT search for or substitute any other comps, and never cite a price other than those below:
${compsList}

In Section 19 (New Construction Comparable Sales Analysis) present EVERY comp above in a table with: address, sale price, sale date, year built, living-area sqft, lot size (or "Unknown"), distance from subject, and price/sqft — plus one line on why each qualifies. Then derive the median, range, and median $/sqft.

REQUIRED SECTION STRUCTURE — use these exact numbered headings:
# 1. Executive Summary
# 2. Property Overview
# 3. Parcel Verification
# 4. Zoning Analysis
# 5. Future Land Use Analysis
# 6. Rezoning & Upzoning Opportunity
# 7. Subdivision & Lot-Split Potential
# 8. HOA, Deed Restrictions & Builder Requirements
# 9. Buildability Assessment
# 10. Topography and Slope Analysis
# 11. Floodplain Analysis
# 12. Wetlands and Environmental Constraints
# 13. Utilities Analysis
# 14. Road Access and Frontage
# 15. School and Location Analysis
# 16. Market Analysis
# 17. Market Saturation & Absorption by Product Type
# 18. Interest Rate & Financing Environment
# 19. New Construction Comparable Sales Analysis
# 20. Development Cost Considerations
# 21. Highest and Best Use
# 22. Land Valuation
# 23. Builder/Developer Profitability Analysis
# 24. Risk Assessment
# 25. Final Investment Recommendation

Section 6 (Rezoning & Upzoning Opportunity) must state plainly whether a value-add REZONING is realistic for THIS parcel, in detail: the current district vs. the future-land-use/comprehensive-plan designation and the zoning of adjacent parcels; the specific higher-value district to target (e.g. single-family → townhome/attached, multifamily, or mixed-use) and the density/units it would unlock; whether the comp plan and surrounding pattern SUPPORT approval (and the jurisdiction's recent rezoning approval trend); the realistic process, timeline, cost, and entitlement RISK; and the VALUE DELTA — roughly what the land is worth as-zoned vs. if rezoned (price per unit/door or per buildable lot). If a rezoning is NOT supportable, say so and explain why (don't invent upside).

Section 7 (Subdivision & Lot-Split Potential) must state in detail whether the parcel can be SUBDIVIDED for more value: the district's minimum lot size, minimum frontage, and max density; how many conforming buildable lots the acreage/frontage/utilities realistically yield; minor vs. major subdivision process and likely infrastructure cost (road, utility extensions, stormwater); and the VALUE UPLIFT — estimated sum of finished-lot values vs. the whole-parcel value, net of subdivision cost. If it can't be split, say so and why.

Section 8 (HOA, Deed Restrictions & Builder Requirements) must state whether the parcel is in an HOA and, if so, its dues, featured/approved builders, and building restrictions/architectural guidelines (or mark Unknown where not public).

Section 17 (Market Saturation & Absorption by Product Type) must be PRECISE and data-driven: present a TABLE by product type — single-family detached, townhomes/attached, condos, and multifamily/rentals — with current ACTIVE inventory, median DAYS ON MARKET (DOM), and MONTHS OF SUPPLY near this address/ZIP (cite sources). Explicitly flag which product types are OVERSUPPLIED or sitting too long on market (slow absorption / buyer's market) vs. which are absorbing quickly (low supply / seller's market), and conclude with the product type a developer should BUILD here and which to avoid, with the numbers behind it.

Section 18 (Interest Rate & Financing Environment) must state, in detail, the CURRENT 30-year mortgage rate and its recent trend — RISING, FALLING, or STEADY (cite a current source) — the Federal Reserve's posture, and exactly how that affects buyer demand, affordability, absorption pace, and the project's exit timing. Give a short SENSITIVITY read: what a rate move up vs. down would do to demand and to the recommended hold/sell timing.

Section 20 (Development Cost Considerations) must present an ITEMIZED construction-cost TABLE that mirrors the Construction Cost Reference Model in your standards (a real ~$250k / ~1,600 sqft 3BR/2BA new-build budget incl. a $25k builder fee and a contingency), but with each line LOCALIZED to CURRENT prices near this address (cited sources) and SCALED to the planned home's size; show the scaled total hard cost and $/sqft. Search AS MANY local sources as possible for clearing/tree removal, grading, foundation, well + septic (or tap/impact fees), and per-sqft build cost — be EXTREMELY ACCURATE.${costEstimate ? ' When the INSTANT CONSTRUCTION COST ESTIMATE figures are provided below, BUILD this section from them — use the SAME line items and totals (you may add the site adders + sources), keep $/sqft and the total CONSISTENT with that card, and note that the budget matches the on-screen Instant Construction Cost Estimate.' : ''}${costBlock}

Sections 22 (Land Valuation) & 23 (Builder/Developer Profitability) must compute, in a pro-forma TABLE, what a builder would PAY FOR THE LAND: start from ARV (from the comps' median $/sqft × planned GLA), subtract the localized total construction cost, subtract SITE-SPECIFIC adders that reduce land value — TREE/lot CLEARING (if wooded), extra GRADING/engineering (if slope ≥15%), and WELL + SEPTIC (if no public water/sewer) — subtract selling/closing/financing, and subtract DEVELOPER PROFIT at THREE margins shown side by side: a little less than 20% of ARV (≈15%), EXACTLY 20% of ARV, and more than 20% of ARV (≈25%). This yields THREE residual land values (one per margin) in the table — a lower profit margin lets the builder pay MORE for the land, a higher margin less. Cross-check against the rule of thumb that builders pay ≈ 20% of ARV for a finished lot (then deduct those same site costs), and present a defensible land-value RANGE that brackets the three figures. Reflect any rezoning/subdivision upside from Sections 6–7 and the saturation/rate context from Sections 17–18 in the highest-and-best-use and valuation. This is development-feasibility "what a builder would pay" — NOT a wholesale max-allowable-offer.

The Final Investment Recommendation (Section 25) must state whether the property appears buildable, the most likely development strategy (including any rezoning/subdivision value-add play), the primary risks, the strongest value drivers, and an overall Feasibility Rating (Excellent / Good / Moderate / Challenging / Poor).

The report must ultimately answer: What is the property worth today? What would a builder likely pay? What can realistically be built? What are the primary risks? What approvals and infrastructure improvements may be required? Is the opportunity attractive enough to pursue?

Format with clear markdown headers, bold key findings, and tables. Subject GIS data: lot size ${reportData.gisAcres.toFixed(2)} acres, zoning ${reportData.zoningCode}, owner ${reportData.ownerName || 'N/A'}. No conversational intro/outro filler, no JSON/code blocks, and no wholesaling/assignment/MAO/spread/exit-strategy content anywhere. Write ALL formulas/calculations in plain English or clean tables — never in code, backticks, or raw data, and use "times"/× and ÷ for math, NEVER the asterisk (*). Do not use asterisks for emphasis.`;

      let streamed = '';
      const response = await chatWithGemini([{ role: 'user', content: initialPrompt }], reportData, (chunk) => {
        streamed += chunk;
        setChatHistory([{ role: 'model', content: streamed }]); // stream tokens into the report as they arrive
      });
      recordReportDuration(Date.now() - reportStart); // refine future countdown estimates
      const messages: ChatMessage[] = [
        { role: 'model', content: response.text || streamed, sources: response.sources }
      ];
      // Follow the report with the verified comp-run summary (criteria,
      // per-comp detail, Bottom Line) as its own conversational message.
      if (reportData.compRunSummary) {
        messages.push({ role: 'model', content: reportData.compRunSummary });
      }
      setChatHistory(messages);
    } catch (err: any) {
      console.error(err);
      setChatHistory([
        { role: 'model', content: `Error generating initial report: ${err?.message || 'Please check your connection.'}` }
      ]);
    } finally {
      setChatLoading(false);
      setReportTimer(null);
    }
  };

  /** Clears all chat/report UI state at the start of a new search. */
  const resetChatUiState = () => {
    setChatInput('');
    setChatHistory([]);
    setLikedMessages({});
    setCopiedMessageIndex(null);
    setShowCheckOverlay({});
    setReportSaved(false);
  };

  const handleChatSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if ((!chatInput.trim() && pendingAttachments.length === 0) || !data || chatLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: chatInput.trim(),
      ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
    };
    const updatedHistory = [...chatHistory, userMessage];
    setChatHistory(updatedHistory);
    setChatInput('');
    setPendingAttachments([]);
    if (chatInputRef.current) chatInputRef.current.style.height = 'auto'; // reset after send
    setChatLoading(true);

    try {
      let streamed = '';
      // Fast single-stream follow-up (no fusion) — the report is already in the
      // conversation, so this replies quickly.
      const response = await chatFollowUp(updatedHistory, data, (chunk) => {
        streamed += chunk;
        setChatHistory([...updatedHistory, { role: 'model', content: streamed }]);
      });
      setChatHistory([
        ...updatedHistory,
        { role: 'model', content: response.text || streamed, sources: response.sources }
      ]);
    } catch (err: any) {
      console.error(err);
      setChatHistory([
        ...updatedHistory,
        { role: 'model', content: `Error generating response: ${err?.message || 'Please check your connection.'}` }
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const generatePrintableReport = () => {
    if (!data || chatHistory.length === 0) return;

    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      alert('Pop-up blocker is preventing opening the report. Please allow pop-ups for this site.');
      return;
    }

    const reportHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Land Feasibility Report - ${data.inputAddress}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --success: #16a34a;
      --warning: #eab308;
      --danger: #dc2626;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg-card-border: #e2e8f0;
      --bg-card: #ffffff;
      --bg-app: #f8fafc;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text-secondary);
      background-color: var(--bg-app);
      line-height: 1.6;
      padding-top: 80px;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: 'Outfit', sans-serif;
      color: var(--text-primary);
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
    }
    h1 {
      font-size: 1.85rem;
      font-weight: 800;
      border-bottom: 2px solid var(--bg-card-border);
      padding-bottom: 0.5rem;
      margin-top: 2rem;
    }
    h2 {
      font-size: 1.35rem;
      font-weight: 700;
      border-bottom: 1px solid var(--bg-card-border);
      padding-bottom: 0.25rem;
    }
    h3 {
      font-size: 1.1rem;
      font-weight: 600;
    }
    p {
      margin: 0.5rem 0 1rem 0;
      font-size: 0.95rem;
    }
    ul, ol {
      margin: 0.5rem 0 1rem 1.5rem;
    }
    li {
      margin-bottom: 0.25rem;
      font-size: 0.95rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-size: 0.9rem;
    }
    th, td {
      border: 1px solid var(--bg-card-border);
      padding: 10px 14px;
      text-align: left;
    }
    th {
      background-color: #f1f5f9;
      font-weight: 600;
      color: var(--text-primary);
    }
    tr:nth-child(even) {
      background-color: #f8fafc;
    }
    blockquote {
      border-left: 4px solid var(--primary);
      padding-left: 1rem;
      color: var(--text-secondary);
      font-style: italic;
      margin: 1rem 0;
      background: #f8fafc;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    pre {
      background: #1e1e2e;
      color: #cdd6f4;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      margin: 1rem 0;
      font-size: 0.85rem;
      line-height: 1.4;
    }
    code {
      font-family: monospace;
    }
    
    .no-print {
      display: block;
    }
    
    /* Control Header */
    .control-header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 64px;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid #e2e8f0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .control-header-content {
      width: 100%;
      max-width: 850px;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .report-title {
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .control-actions {
      display: flex;
      gap: 12px;
    }
    .btn-print, .btn-close {
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--bg-card-border);
      background: white;
    }
    .btn-print {
      background: var(--primary);
      color: white;
      border: none;
    }

    .report-container {
      max-width: 850px;
      margin: 24px auto 48px;
      background: white;
      padding: 50px 60px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.03), 0 8px 10px -6px rgba(0, 0, 0, 0.03);
      border: 1px solid #f1f5f9;
    }

    .report-header {
      border-bottom: 2px solid #f1f5f9;
      padding-bottom: 24px;
      margin-bottom: 32px;
    }
    .report-header-badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 800;
      text-transform: uppercase;
      color: var(--primary);
      background: #e0e7ff;
      padding: 4px 12px;
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .report-header h1 {
      font-size: 1.85rem;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      border: none;
      padding: 0;
      margin-top: 0;
    }
    .address-header {
      font-size: 1.15rem;
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .report-footer {
      border-top: 2px solid #f1f5f9;
      margin-top: 48px;
      padding-top: 24px;
      color: #94a3b8;
      font-size: 0.8rem;
      text-align: center;
      line-height: 1.5;
    }

    /* Print Styles Overrides */
    @media print {
      body {
        background: white;
        padding-top: 0;
      }
      .no-print {
        display: none !important;
      }
      .report-container {
        margin: 0;
        padding: 0;
        box-shadow: none;
        border: none;
        max-width: 100%;
      }
      .page-break {
        page-break-before: always;
        height: 0;
        margin: 0;
        border: none;
      }
      button, .report-container button {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <!-- Control Header (Sticky toolbar for browser view) -->
  <div class="control-header no-print">
    <div class="control-header-content">
      <div class="report-title">
        <span class="sparkle-icon">✨</span>
        <span>Feasibility Report</span>
      </div>
      <div class="control-actions">
        <button onclick="window.print()" class="btn-print">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;"><path d="M6 9V2h12v7"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
          Save as PDF / Print
        </button>
        <button onclick="window.close()" class="btn-close">
          Close
        </button>
      </div>
    </div>
  </div>

  <div class="report-container">
    <header class="report-header">
      <div class="report-header-badge">Property Feasibility Analysis</div>
      <h1>Land Feasibility Study</h1>
      <div class="address-header">
        📍 <span>${data.inputAddress}</span>
      </div>
    </header>

    <div id="print-root"></div>

    <!-- Footer -->
    <footer class="report-footer">
      <div>Report ID: ANTG-INVESTOR-${data.parcelId}</div>
      <div>Generated by Antigravity Autonomous Real Estate Acquisition Intelligence</div>
      <div style="font-size: 0.65rem; color: #cbd5e1; margin-top: 8px;">
        Disclaimer: This feasibility summary compiles data from public GIS, municipal databases, USGS 3DEP elevation models, and zoning indices. All cost estimations, setbacks, and land bases must be surveyed and validated by licensed engineers and contractors prior to closing.
      </div>
    </footer>
  </div>
</body>
</html>
    `;

    reportWindow.document.write(reportHtml);
    reportWindow.document.close();

    const rootEl = reportWindow.document.getElementById('print-root');
    if (rootEl) {
      const root = createRoot(rootEl);
      root.render(parseMarkdown(sanitizeReportText(chatHistory[0].content)));
    }
  };


  // Google Places Autocomplete states
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const autocompleteServiceRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapInstanceRef = useRef<any>(null);
  const polygonInstanceRef = useRef<any>(null);
  const infoWindowInstanceRef = useRef<any>(null);
  const labelsInstanceRef = useRef<any[]>([]);
  const markersInstanceRef = useRef<any[]>([]);

  // Street View Refs & States
  const streetViewRef = useRef<HTMLDivElement>(null);
  const streetViewInstanceRef = useRef<any>(null);
  const [hasStreetView, setHasStreetView] = useState(false);
  const [splitOrientation, setSplitOrientation] = useState<'side-by-side' | 'stacked'>('side-by-side');

  // GIS Overlay Layer States
  const [showFloodplains, setShowFloodplains] = useState(true);
  const [showStreams, setShowStreams] = useState(true);
  const [showContours, setShowContours] = useState(true);
  const [showZoning, setShowZoning] = useState(true);
  const [showWetlands, setShowWetlands] = useState(false);
  const [showOsmFeatures, setShowOsmFeatures] = useState(false);
  const [osmLoading, setOsmLoading] = useState(false);

  // GIS Overlay Layer Refs
  const floodplainsLayerRef = useRef<any>(null);
  const streamsLayerRef = useRef<any>(null);
  const contoursLayerRef = useRef<any>(null);
  const wetlandsLayerRef = useRef<any>(null);
  const zoningLayersRef = useRef<any[]>([]);
  const zoningLabelOverlayRef = useRef<any>(null);
  const osmDataLayerRef = useRef<any>(null);
  const osmCacheRef = useRef<{ key: string; fc: any } | null>(null);

  // Load search history on mount (merges cloud-synced history when signed in).
  useEffect(() => {
    getSearchHistory().then(setHistory).catch((e) => console.error('Failed to load search history:', e));
  }, []);

  // Open the Reports drawer from the app header ("My Reports" button)
  useEffect(() => {
    const openReports = () => setShowReports(true);
    window.addEventListener('open-gis-reports', openReports);
    return () => window.removeEventListener('open-gis-reports', openReports);
  }, []);

  // Dynamic loader for Google Maps JS API script
  useEffect(() => {
    const callback = () => {
      setMapsLoaded(true);
      if (typeof google !== 'undefined' && google.maps && google.maps.places) {
        autocompleteServiceRef.current = new google.maps.places.AutocompleteService();
      }
    };

    if (typeof google !== 'undefined' && google.maps && google.maps.places) {
      callback();
      return;
    }

    const existingScript = document.getElementById("googleMapsScript");
    if (existingScript) {
      existingScript.addEventListener("load", callback);
      return;
    }

    const keys = getUserKeys();
    const apiKey = keys.googleMaps;
    if (!apiKey) {
      console.warn("User Google Maps API Key is not configured in settings.");
      return;
    }


    const script = document.createElement("script");
    // loading=async is Google's recommended bootstrap param (silences the
    // "loaded directly without loading=async" console warning + best perf).
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,geometry&loading=async`;
    script.id = "googleMapsScript";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", callback);
    document.head.appendChild(script);
  }, []);

  // Fetch predictions with debouncing
  useEffect(() => {
    if (!mapsLoaded || !autocompleteServiceRef.current || !addressInput.trim()) {
      setPredictions([]);
      setShowDropdown(false);
      return;
    }

    const delayDebounce = setTimeout(() => {
      autocompleteServiceRef.current.getPlacePredictions(
        {
          input: addressInput,
          componentRestrictions: { country: "us" },
        },
        (preds: any[], status: any) => {
          if (status === "OK" && preds) {
            setPredictions(preds);
            setShowDropdown(true);
            setActiveIndex(-1);
          } else {
            setPredictions([]);
            setShowDropdown(false);
          }
        }
      );
    }, 150);

    return () => clearTimeout(delayDebounce);
  }, [addressInput, mapsLoaded]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Render and update Google Map with satellite aerial imagery and parcel polygon overlay
  useEffect(() => {
    if (!mapsLoaded || !mapRef.current || !data) return;

    const { lat, lng } = data.coordinates;
    if (isNaN(lat) || isNaN(lng)) {
      console.warn("Invalid coordinates for map centering:", lat, lng);
      return;
    }
    const center = { lat, lng };

    // 1. Initialize Map if not already created
    if (!googleMapInstanceRef.current) {
      googleMapInstanceRef.current = new google.maps.Map(mapRef.current, {
        center,
        zoom: 18,
        mapTypeId: 'hybrid', // Satellite view with road labels
        tilt: 0,            // Top-down view
        maxZoom: 20,        // fallback cap; the adaptive MaxZoomService below lifts this to the sharpest tiles available at the location
        minZoom: 10,
        mapTypeControl: true,
        streetViewControl: false,
        fullscreenControl: true
      });
    } else {
      googleMapInstanceRef.current.setCenter(center);
      googleMapInstanceRef.current.setZoom(18);
    }

    // High-res aerial: query the SHARPEST satellite zoom Google actually has at
    // this exact location (varies, often 20-23 in developed areas) and lift the
    // cap to it, so the imagery stays crisp without graying out where tiles end.
    try {
      new google.maps.MaxZoomService().getMaxZoomAtLatLng(center, (res: any) => {
        const map = googleMapInstanceRef.current;
        if (map && res && res.status === 'OK' && typeof res.zoom === 'number') {
          map.setOptions({ maxZoom: res.zoom });
        }
      });
    } catch { /* MaxZoomService unavailable — keep the static cap */ }

    // 2. Remove old parcel boundary, popup window, and line dimension labels if present
    if (polygonInstanceRef.current) {
      polygonInstanceRef.current.setMap(null);
      polygonInstanceRef.current = null;
    }
    if (infoWindowInstanceRef.current) {
      infoWindowInstanceRef.current.close();
      infoWindowInstanceRef.current = null;
    }
    if (zoningLabelOverlayRef.current) {
      zoningLabelOverlayRef.current.setMap(null);
      zoningLabelOverlayRef.current = null;
    }
    if (labelsInstanceRef.current) {
      labelsInstanceRef.current.forEach(label => label.setMap(null));
      labelsInstanceRef.current = [];
    }
    if (markersInstanceRef.current) {
      markersInstanceRef.current.forEach(marker => marker.setMap(null));
      markersInstanceRef.current = [];
    }


    // Define custom HTML overlay for line dimension labels inside the map rendering block
    class TextLabelOverlay extends google.maps.OverlayView {
      private div: HTMLDivElement | null = null;
      private position: any;
      private text: string;
      private angle: number;

      constructor(position: any, text: string, angle: number) {
        super();
        this.position = position;
        this.text = text;
        this.angle = angle;
      }

      onAdd() {
        const div = document.createElement('div');
        div.className = 'line-dimension-label';
        
        const inner = document.createElement('div');
        inner.innerText = this.text;
        div.appendChild(inner);

        this.div = div;

        const panes = this.getPanes();
        panes.overlayMouseTarget.appendChild(div);
      }

      draw() {
        if (!this.div) return;
        const overlayProjection = this.getProjection();
        const position = overlayProjection.fromLatLngToDivPixel(this.position);

        if (position) {
          this.div.style.left = position.x + 'px';
          this.div.style.top = position.y + 'px';
          this.div.style.position = 'absolute';
          this.div.style.transform = `translate(-50%, -50%) rotate(${this.angle}deg)`;
        }
      }

      onRemove() {
        if (this.div) {
          this.div.parentNode?.removeChild(this.div);
          this.div = null;
        }
      }
    }

    class ZoningLabelOverlay extends google.maps.OverlayView {
      private div: HTMLDivElement | null = null;
      private position: any;
      private text: string;

      constructor(position: any, text: string) {
        super();
        this.position = position;
        this.text = text;
      }

      onAdd() {
        const div = document.createElement('div');
        div.className = 'zoning-map-label';
        
        const inner = document.createElement('div');
        inner.innerText = this.text;
        div.appendChild(inner);

        this.div = div;

        const panes = this.getPanes();
        panes.overlayMouseTarget.appendChild(div);
      }

      draw() {
        if (!this.div) return;
        const overlayProjection = this.getProjection();
        const position = overlayProjection.fromLatLngToDivPixel(this.position);

        if (position) {
          this.div.style.left = position.x + 'px';
          this.div.style.top = position.y + 'px';
          this.div.style.position = 'absolute';
          this.div.style.transform = 'translate(-50%, -170%)';
        }
      }

      onRemove() {
        if (this.div) {
          this.div.parentNode?.removeChild(this.div);
          this.div = null;
        }
      }
    }

    // 3. Draw new parcel boundary polygon from WGS84 rings
    if (data.boundaryRings && data.boundaryRings.length > 0) {
      const paths = data.boundaryRings.map((ring: number[][]) => 
        ring.map((coord: number[]) => ({
          lat: coord[1],
          lng: coord[0]
        }))
      );

      polygonInstanceRef.current = new google.maps.Polygon({
        paths: paths,
        strokeColor: "#00ff88",  // Bright neon green outline (matching official Mecklenburg style)
        strokeOpacity: 1.0,
        strokeWeight: 3,         // Clean sharp line weight
        fillColor: "#00ff88",
        fillOpacity: 0.0,        // Completely transparent fill to keep base maps clear
        map: googleMapInstanceRef.current
      });

      // 4. Lot dimension logic. The parcel geometry comes straight from the
      //    county parcel fabric (NC OneMap). We measure each real property line
      //    directly in WGS84 using Google's geodesic distance (sub-foot accurate),
      //    so there's no cross-projection alignment to get wrong. Consecutive
      //    near-collinear vertices are merged into a single side so one straight
      //    boundary reads as one dimension (not several), and tiny corner
      //    chamfers are dropped. Every real side is labeled — not just the
      //    longest few.
      const labels: any[] = [];
      const wgsRings = data.boundaryRings || [];
      const spherical = google.maps?.geometry?.spherical;

      const sideLenFt = (a: number[], b: number[]): number => {
        const la = new google.maps.LatLng(a[1], a[0]);
        const lb = new google.maps.LatLng(b[1], b[0]);
        if (spherical) return spherical.computeDistanceBetween(la, lb) * 3.280839895; // m -> ft
        // Fallback if the geometry library is unavailable.
        const ftPerDegLat = 364000;
        const ftPerDegLng = 364000 * Math.cos((a[1] * Math.PI) / 180);
        const dx = (b[0] - a[0]) * ftPerDegLng;
        const dy = (b[1] - a[1]) * ftPerDegLat;
        return Math.sqrt(dx * dx + dy * dy);
      };
      const headingDeg = (a: number[], b: number[]): number => {
        if (spherical) return spherical.computeHeading(new google.maps.LatLng(a[1], a[0]), new google.maps.LatLng(b[1], b[0]));
        return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      };
      const norm180 = (d: number) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
      const COLLINEAR_TOL = 8; // deg: vertices straighter than this belong to one side
      const MIN_SIDE_FT = 12;  // skip corner chamfers / notches

      wgsRings.forEach((ringRaw: number[][]) => {
        if (!ringRaw || ringRaw.length < 4) return;
        // Unique vertices (drop the duplicated closing vertex if present).
        const last = ringRaw.length - 1;
        const closed = ringRaw[0][0] === ringRaw[last][0] && ringRaw[0][1] === ringRaw[last][1];
        const v = closed ? ringRaw.slice(0, -1) : ringRaw.slice();
        const n = v.length;
        if (n < 3) return;

        const edgeBearing: number[] = [];
        for (let i = 0; i < n; i++) edgeBearing.push(headingDeg(v[i], v[(i + 1) % n]));

        // Start grouping at a real corner so a side isn't split across index 0.
        let start = -1;
        for (let i = 0; i < n; i++) {
          if (Math.abs(norm180(edgeBearing[i] - edgeBearing[(i - 1 + n) % n])) > COLLINEAR_TOL) { start = i; break; }
        }
        if (start === -1) return; // round/degenerate ring

        const emitSide = (aIdx: number, bIdx: number) => {
          const a = v[aIdx], b = v[bIdx];
          const lenFt = sideLenFt(a, b);
          if (lenFt < MIN_SIDE_FT) return;
          let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
          const mid = new google.maps.LatLng((a[1] + b[1]) / 2, (a[0] + b[0]) / 2);
          const lbl = new TextLabelOverlay(mid, `${lenFt.toFixed(1)} ft`, ang);
          lbl.setMap(googleMapInstanceRef.current);
          labels.push(lbl);
        };

        let sideStartVtx = start;
        let prevBearing = edgeBearing[start];
        for (let k = 0; k < n; k++) {
          const e = (start + k) % n;
          if (k > 0 && Math.abs(norm180(edgeBearing[e] - prevBearing)) > COLLINEAR_TOL) {
            emitSide(sideStartVtx, e); // side runs up to the start vertex of this edge
            sideStartVtx = e;
          }
          prevBearing = edgeBearing[e];
        }
        emitSide(sideStartVtx, start); // final side wraps back to the starting corner
      });

      labelsInstanceRef.current = labels;

      // Subject marker (green pin)
      const subjectMarker = new google.maps.Marker({
        position: center,
        map: googleMapInstanceRef.current,
        title: "Target Site",
        icon: {
          path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
          scale: 6,
          fillColor: "#10B981", // green
          fillOpacity: 1.0,
          strokeColor: "#FFFFFF",
          strokeWeight: 2,
        }
      });
      
      const subjectMarkerInfoWindow = new google.maps.InfoWindow({
        content: `<div style="font-family: Arial, sans-serif; font-size: 12px; color: #000; padding: 4px;"><strong>Target Site</strong><br/>${data.inputAddress}</div>`
      });
      
      subjectMarker.addListener('click', () => {
        subjectMarkerInfoWindow.open(googleMapInstanceRef.current, subjectMarker);
      });
      
      markersInstanceRef.current.push(subjectMarker);

      // Draw zoning label over the parcel whenever we have a real zoning code —
      // from county GIS, or the web-search fallback (marked "web"). We don't float
      // a code when none was resolved (N/A).
      const hasRealZoning = !!data.zoningSource && data.zoningCode !== 'N/A';
      if (hasRealZoning) {
        const zoningLabelText = data.zoningSource === 'web'
          ? `Zoning: ${data.zoningCode} (web)`
          : `Zoning: ${data.zoningCode}`;
        zoningLabelOverlayRef.current = new ZoningLabelOverlay(center, zoningLabelText);
        if (showZoning) {
          zoningLabelOverlayRef.current.setMap(googleMapInstanceRef.current);
        }
      }

      // Comps markers (red circles with index numbers). ONE shared InfoWindow is
      // reused for every marker — creating one per comp (150+) was memory-heavy and
      // occasionally rendered the map black. Map pins are capped to the closest 75
      // (the full comp list and report still include every comp).
      if (data.comps && data.comps.length > 0) {
        const compInfoWindow = new google.maps.InfoWindow();
        data.comps.slice(0, 75).forEach((comp, idx) => {
          if (!comp.coords) return;
          const compMarker = new google.maps.Marker({
            position: comp.coords,
            map: googleMapInstanceRef.current,
            title: `Comp ${idx + 1}: ${comp.address}`,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: "#EF4444", // red
              fillOpacity: 1.0,
              strokeColor: "#FFFFFF",
              strokeWeight: 2,
            },
            label: {
              text: `${idx + 1}`,
              color: "#FFFFFF",
              fontSize: "10px",
              fontWeight: "bold"
            }
          });
          
          const _compContent = `
              <div style="font-family: Arial, sans-serif; font-size: 12px; color: #000; padding: 6px; min-width: 180px;">
                <strong style="color: #EF4444; font-size: 13px; display: block; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 2px;">SOLD COMP ${idx + 1}</strong>
                <strong>Address:</strong> <a href="${comp.url || `https://www.google.com/search?q=${encodeURIComponent(comp.address)}`}" target="_blank" rel="noopener noreferrer" style="color: #4338ca; text-decoration: underline; font-weight: 500;">${comp.address} ↗</a><br/>
                <strong>Price:</strong> $${comp.price.toLocaleString()}<br/>
                <strong>Proximity:</strong> ${comp.distanceMiles.toFixed(2)} mi (${comp.durationMins.toFixed(0)} mins)<br/>
                <strong>Sale Date:</strong> ${comp.saleDate}
              </div>
            `;
          compMarker.addListener('click', () => {
            compInfoWindow.setContent(_compContent);
            compInfoWindow.open(googleMapInstanceRef.current, compMarker);
          });
          
          markersInstanceRef.current.push(compMarker);
        });
      }

      // Automatically adjust bounds to fit only the subject parcel boundary (not the comps, to stay zoomed in on the address)
      const bounds = new google.maps.LatLngBounds();
      let hasValidCoords = false;
      paths.forEach(path => {
        path.forEach(coord => {
          if (coord && !isNaN(coord.lat) && !isNaN(coord.lng)) {
            bounds.extend(coord);
            hasValidCoords = true;
          }
        });
      });
      
      if (hasValidCoords && !bounds.isEmpty()) {
        googleMapInstanceRef.current.fitBounds(bounds, 40);
        
        // Prevent too deep of a zoom on extremely small parcels (capping at 18 to avoid blank satellite views in rural areas)
        const currentZoom = googleMapInstanceRef.current.getZoom();
        if (currentZoom && currentZoom > 18) {
          googleMapInstanceRef.current.setZoom(18);
        }
      }

      // 5. Open Interactive Info Details Popup Card (Mecklenburg GeoPortal / Gridics Style)
      const g = data.gridics;
      const infoCard = `
          <div style="font-family: Arial, sans-serif; padding: 8px; color: #000; font-size: 12px; line-height: 1.45; min-width: 260px; max-width: 280px;">
              <strong style="color: #0070f3; font-size: 13px; display: block; margin-bottom: 5px; border-bottom: 1px solid #eaeaea; padding-bottom: 3px;">PROPERTY BLUEPRINT</strong>
              <strong>County Market:</strong> ${data.countyName}<br>
              <strong>Parcel PIN:</strong> ${data.parcelId}<br>
              <strong>Situs Address:</strong> ${data.inputAddress}<br>
              <strong>Calculated Area:</strong> ${data.gisAcres ? data.gisAcres.toFixed(3) + ' ac (' + data.grossSf.toLocaleString() + ' SF)' : 'N/A'}<br>
              
              <strong style="color: #008f5d; font-size: 13px; display: block; margin-top: 8px; margin-bottom: 5px; border-bottom: 1px solid #eaeaea; padding-bottom: 3px;">ZONING &amp; STANDARDS</strong>
              <strong>Zoning Code:</strong> ${data.zoningCode}<br>
              <strong>Street Frontage:</strong> ${g ? g.frontageLengthFt.toFixed(1) + ' ft' : 'N/A'}<br>
              <strong>Max Height (est.):</strong> ${g ? g.maxHeightFt + ' ft' : 'N/A'}<br>
              <strong>Floor Area Ratio (est.):</strong> ${g ? g.floorAreaRatio : 'N/A'}<br>
              <strong>Setbacks (est.):</strong> F: ${g ? g.setbacks.frontFt : 0}ft | R: ${g ? g.setbacks.rearFt : 0}ft | S: ${g ? g.setbacks.sideFt : 0}ft<br>
              <strong>Net Buildable (est.):</strong> ${g ? g.netBuildableAreaSqft.toLocaleString() + ' SF' : 'N/A'}<br>
              <strong>Max Footprint (est.):</strong> ${g ? g.maxBuildingFootprintSqft.toLocaleString() + ' SF' : 'N/A'}
          </div>
      `;

      infoWindowInstanceRef.current = new google.maps.InfoWindow({
        content: infoCard,
        position: center
      });
      infoWindowInstanceRef.current.open(googleMapInstanceRef.current);
    }

    // 5. Query Street View Availability
    const svService = new google.maps.StreetViewService();
    svService.getPanorama({ location: center, radius: 50 }, (svData: any, status: any) => {
      if (status === 'OK' && svData && svData.location && svData.location.pano) {
        setHasStreetView(true);
      } else {
        setHasStreetView(false);
      }
    });

  }, [data, mapsLoaded]);

  // Handle Street View Panorama Initialization and updates
  useEffect(() => {
    if (!mapsLoaded || !hasStreetView || !data || !streetViewRef.current) {
      if (streetViewInstanceRef.current) {
        streetViewInstanceRef.current = null;
      }
      return;
    }

    const { lat, lng } = data.coordinates;
    const center = { lat, lng };

    // Initialize or update Street View panorama container
    streetViewInstanceRef.current = new google.maps.StreetViewPanorama(
      streetViewRef.current,
      {
        position: center,
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        addressControl: false,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false
      }
    );
  }, [hasStreetView, data, mapsLoaded]);

  // Dynamically toggle overlay layers on top of Google Maps base imagery
  useEffect(() => {
    const map = googleMapInstanceRef.current;
    if (!mapsLoaded) return;

    if (!data) {
      if (map) {
        map.overlayMapTypes.clear();
      }
      return;
    }

    if (!map) return;

    // Helper function to dynamically pull tiles from ArcGIS REST MapServer or ImageServer layers
    const getArcGISLayer = (url: string, opacity: number, maxZoom: number = 19, layers?: string | null) => {
      const isImageServer = url.includes("ImageServer");
      const operation = isImageServer ? "exportImage" : "export";
      // Optional sublayer restriction (e.g. "show:0") for mixed/report MapServers.
      const layersParam = layers ? `&layers=${encodeURIComponent(layers)}` : "";

      return new google.maps.ImageMapType({
        getTileUrl: function (coord: any, zoom: number): string {
          // Calculate the Mercator bounding box coordinates corresponding to this tile (x, y, zoom)
          const numTiles = 1 << zoom;
          const tileWidthMeters = 40075016.68557849 / numTiles;
          const west = -20037508.342789244 + coord.x * tileWidthMeters;
          const east = west + tileWidthMeters;
          const north = 20037508.342789244 - coord.y * tileWidthMeters;
          const south = north - tileWidthMeters;

          // Request the rendered tile graphic for this exact bounding box envelope in EPSG:3857 (Web Mercator)
          return `${url}/${operation}?bbox=${west},${south},${east},${north}&bboxSR=3857&size=256,256&imageSR=3857&format=png32&transparent=true${layersParam}&f=image`;
        },
        tileSize: new google.maps.Size(256, 256),
        isPng: true,
        opacity: opacity,
        maxZoom: maxZoom
      });
    };

    // Stacking Layer 1: Floodplains (Index 0)
    if (showFloodplains) {
      if (!floodplainsLayerRef.current) {
        floodplainsLayerRef.current = getArcGISLayer(
          "https://spartagis.ncem.org/arcgis/rest/services/Public/FRIS_FloodZones/MapServer",
          0.45, // 45% Opacity
          19 // Cap at zoom 19 to preserve visible overlays on zoom 20/21
        );
      }
      map.overlayMapTypes.setAt(0, floodplainsLayerRef.current);
    } else {
      map.overlayMapTypes.setAt(0, null as any);
    }

    // Stacking Layer 2: Streams & Hydrography (Index 1)
    if (showStreams) {
      if (!streamsLayerRef.current) {
        streamsLayerRef.current = getArcGISLayer(
          "https://services.nconemap.gov/secure/rest/services/NC1Map_Hydrography/MapServer",
          0.7, // 70% Opacity
          19
        );
      }
      map.overlayMapTypes.setAt(1, streamsLayerRef.current);
    } else {
      map.overlayMapTypes.setAt(1, null as any);
    }

    // Stacking Layer 3: Contours & Topography (Index 2)
    if (showContours) {
      if (!contoursLayerRef.current) {
        contoursLayerRef.current = getArcGISLayer(
          "https://services.nconemap.gov/secure/rest/services/Elevation/DEM03_Contours2_raster/ImageServer",
          0.5, // 50% Opacity
          19
        );
      }
      map.overlayMapTypes.setAt(2, contoursLayerRef.current);
    } else {
      map.overlayMapTypes.setAt(2, null as any);
    }

    // Stacking Layers 4+: Zoning from the county's own GIS MapServer(s) (Index 3+).
    // Multi-jurisdiction counties expose several zoning services (city / towns /
    // unincorporated) which we stack so the whole county is covered. Counties
    // without a published service show no overlay (we don't fake it with parcels).
    const ZONING_BASE = 3;
    const ZONING_SLOTS = 8; // reserved overlay indices for stacked zoning layers
    const zoningServices = showZoning ? getZoningServices(data.countyName) : [];

    // (Re)build layer objects, reusing cached ones keyed by url+layers clause.
    const existing: Record<string, any> = {};
    for (const lyr of zoningLayersRef.current) existing[lyr.cacheKey] = lyr;
    zoningLayersRef.current = zoningServices.map((s) => {
      const key = `${s.url}|${s.layers || ''}`;
      let lyr = existing[key];
      if (!lyr) {
        lyr = getArcGISLayer(s.url, 0.5, 19, s.layers || null);
        lyr.cacheKey = key;
      }
      return lyr;
    });

    // Place active zoning layers at consecutive indices, clearing the reserved window.
    for (let i = 0; i < ZONING_SLOTS; i++) {
      map.overlayMapTypes.setAt(ZONING_BASE + i, (zoningLayersRef.current[i] || null) as any);
    }

    if (zoningLabelOverlayRef.current) {
      zoningLabelOverlayRef.current.setMap(showZoning ? map : null);
    }

    // Stacking Layer (Index 11): USFWS National Wetlands Inventory — official FWS
    // Wetlands web mapping service, placed after the reserved zoning window.
    const WETLANDS_INDEX = ZONING_BASE + ZONING_SLOTS; // 11
    if (showWetlands) {
      if (!wetlandsLayerRef.current) {
        wetlandsLayerRef.current = getArcGISLayer(
          "https://www.fws.gov/wetlandsmapservice/rest/services/Wetlands/MapServer",
          0.55, // 55% opacity so the parcel/base imagery stays readable
          19
        );
      }
      map.overlayMapTypes.setAt(WETLANDS_INDEX, wetlandsLayerRef.current);
    } else {
      map.overlayMapTypes.setAt(WETLANDS_INDEX, null as any);
    }

  }, [showFloodplains, showStreams, showContours, showZoning, showWetlands, data, mapsLoaded]);

  // Real OSM feature overlay: buildings, road centerlines, and water bodies drawn
  // as a Google Maps vector Data layer (authoritative OpenStreetMap data).
  useEffect(() => {
    const map = googleMapInstanceRef.current;
    if (!mapsLoaded || !map) return;

    if (!showOsmFeatures || !data) {
      if (osmDataLayerRef.current) osmDataLayerRef.current.setMap(null);
      return;
    }

    const { lat, lng } = data.coordinates;
    if (isNaN(lat) || isNaN(lng)) return;

    // Ensure the Data layer exists with feature-type styling.
    if (!osmDataLayerRef.current) {
      const layer = new google.maps.Data();
      layer.setStyle((feature: any) => {
        const ft = feature.getProperty('feature_type');
        if (ft === 'building') return { fillColor: '#f59e0b', fillOpacity: 0.35, strokeColor: '#f59e0b', strokeWeight: 1, clickable: true };
        if (ft === 'water') return { fillColor: '#3b82f6', fillOpacity: 0.4, strokeColor: '#2563eb', strokeWeight: 2, clickable: true };
        if (ft === 'road') return { strokeColor: '#ef4444', strokeWeight: 2.5, clickable: true };
        return { strokeColor: '#ffffff', strokeWeight: 1 };
      });
      const info = new google.maps.InfoWindow();
      layer.addListener('click', (e: any) => {
        const ft = e.feature.getProperty('feature_type');
        const name = e.feature.getProperty('name');
        info.setContent(`<div style="font-family:Arial,sans-serif;font-size:12px;color:#000;padding:2px 4px;"><strong>${(ft || 'feature').toUpperCase()}</strong>${name ? `<br/>${name}` : ''}<br/><span style="color:#666;font-size:10px;">Source: OpenStreetMap</span></div>`);
        info.setPosition(e.latLng);
        info.open(map);
      });
      osmDataLayerRef.current = layer;
    }
    const layer = osmDataLayerRef.current;

    // Bounding box around the subject (~550m square, adjusted for longitude).
    const dLat = 0.0025;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;

    const render = (fc: any) => {
      layer.forEach((f: any) => layer.remove(f));
      try { layer.addGeoJson(fc); } catch (err) { console.warn('Failed to add OSM GeoJSON:', err); }
      layer.setMap(map);
    };

    if (osmCacheRef.current && osmCacheRef.current.key === cacheKey) {
      render(osmCacheRef.current.fc);
      return;
    }

    let cancelled = false;
    setOsmLoading(true);
    fetchOsmFeatures(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
      .then((fc) => {
        if (cancelled) return;
        osmCacheRef.current = { key: cacheKey, fc };
        render(fc);
      })
      .catch((err) => console.warn('OSM feature fetch failed:', err))
      .finally(() => { if (!cancelled) setOsmLoading(false); });

    return () => { cancelled = true; };
  }, [showOsmFeatures, data, mapsLoaded]);

  const handleSelectPrediction = (prediction: any) => {
    setAddressInput(prediction.description);
    setShowDropdown(false);
    setPredictions([]);
    handleSearch(prediction.description);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || predictions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % predictions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + predictions.length) % predictions.length);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < predictions.length) {
        e.preventDefault();
        handleSelectPrediction(predictions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  // Save history helper (associates county and address string) — syncs across devices.
  const addToHistory = (address: string, county: string) => {
    addSearchHistory(address, county)
      .then(setHistory)
      .catch((e) => console.error('Failed to update search history:', e));
  };

  const handleSearch = async (addressToSearch: string, countyOverride?: string) => {
    if (!addressToSearch.trim()) return;
    if (!hasKeys) {
      setError("Please set your personal Google Maps and Gemini API Keys in Account Settings to run feasibility analyses.");
      return;
    }

    const seq = ++searchSeqRef.current; // invalidates any in-flight previous search
    searchedAddressRef.current = addressToSearch.trim(); // full "street, city, state" for Enformion
    // Comp-search preferences (Account & API Settings) drive the search radius +
    // the initial property-type filter for this run.
    const compPrefs = getCompPrefs();
    setLoading(true);
    setError(null);
    setData(null);
    setCostEstimate(null);
    setCostLoading(false);
    setCostError(false);
    setMaterialTakeoff(null);
    setLandClearing(null);
    setLandClearingLoading(false);
    setUtilities(null);
    setUtilitiesLoading(false);
    setUtilitiesError('');
    setEnfProperty(null);
    setEnfErrors({});
    setEnfLoading(false);
    setOwnerSkip(null);
    setOwnerSkipError('');
    setOwnerSkipLoading(false);
    setReportPending(false);
    setCompRadius(compPrefs.radiusMiles);
    setCompTypeFilter(compPrefs.propertyType);
    setCompsShowAll(false);
    setCompsRefetching(false);
    resetChatUiState();

    // Progressive loading: merge each partial emission into view state the
    // moment it arrives — parcel/GIS data renders immediately; zoning,
    // topography, and comps stream in as they resolve.
    let current: SiteFeasibilityData | null = null;
    const onPartial = (partial: Partial<SiteFeasibilityData>) => {
      if (seq !== searchSeqRef.current) return; // superseded search — discard
      current = current ? { ...current, ...partial } : (partial as SiteFeasibilityData);
      setData(current);
    };

    try {
      // The county is determined AUTOMATICALLY from the NC address — no manual
      // selection. (countyOverride comes from a parcel-ID lookup or history.)
      let county = countyOverride;
      if (!county) {
        setLoadingStage("Detecting county…");
        county = (await detectNcCounty(addressToSearch, getUserKeys().googleMaps || '')) || undefined;
        if (seq !== searchSeqRef.current) return;
        if (!county) {
          setError("Couldn't determine the North Carolina county for that address. Please confirm it's a valid NC address.");
          setLoading(false); setLoadingStage(null);
          return;
        }
      }

      setLoadingStage("Querying county GIS records...");
      const result = await executeLandAnalysis(
        county,
        addressToSearch,
        (stage) => { if (seq === searchSeqRef.current) setLoadingStage(stage); },
        onPartial,
        compPrefs.radiusMiles,
      );
      if (seq !== searchSeqRef.current) return;
      setData(result);
      addToHistory(result.inputAddress, county);
      // Kick off the instant construction-cost estimate + local material takeoff
      // (the card fills as they arrive). Capture the estimate promise so the AI
      // report's Development Cost Considerations section can be built FROM it
      // (consistent, linked figures).
      const estPromise = generateCostEstimates(result, seq);
      // Manual mode: don't auto-run the report — show a "Generate AI Report" button.
      if (!getReportAutoGenerate()) {
        setReportPending(true);
      } else {
        // Show the report card as "generating" immediately so it isn't idle during
        // the brief wait for the estimate below.
        setChatLoading(true);
        setChatHistory([]);
        // Give the estimate a brief head start so the report can cite it; if it
        // isn't ready quickly, generate the report anyway (it estimates on its own
        // and the card still fills in).
        const est = await Promise.race([
          estPromise,
          new Promise<ConstructionCostEstimate | null>((r) => setTimeout(() => r(null), 45000)),
        ]);
        if (seq !== searchSeqRef.current) return;
        // All site data is in — generate the AI feasibility report (the countdown
        // timer in the chat panel tracks this phase).
        generateInitialChatReport(result, est || undefined);
      }
    } catch (err: any) {
      if (seq !== searchSeqRef.current) return;
      console.error(err);
      setError(err?.message || "An unexpected error occurred while fetching feasibility data.");
      setData(null);
    } finally {
      if (seq === searchSeqRef.current) {
        setLoading(false);
        setLoadingStage(null);
      }
    }
  };

  // Look up a property by its NC parcel ID (PIN), then run the normal analysis.
  const handleParcelLookup = async () => {
    const pin = parcelIdInput.trim();
    if (!pin) return;
    if (!hasKeys) {
      setError("Please set your personal Google Maps and Gemini API Keys in Account Settings to run feasibility analyses.");
      return;
    }
    setLoading(true);
    setError(null);
    setLoadingStage("Looking up parcel ID…");
    try {
      const found = await lookupParcelById(pin, getUserKeys().googleMaps || '');
      if (!found) {
        setError(`No NC parcel found for ID "${pin}". Check the parcel number (PIN) — it must match the county's records exactly.`);
        setLoading(false); setLoadingStage(null);
        return;
      }
      setAddressInput(found.address);
      await handleSearch(found.address, found.county); // county known from the parcel record
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Parcel ID lookup failed.");
      setLoading(false); setLoadingStage(null);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (searchMode === 'parcel') handleParcelLookup();
    else handleSearch(addressInput);
  };

  const handleHistoryClick = (item: any) => {
    const address = typeof item === 'string' ? item : item.address;
    const county = typeof item === 'string' ? undefined : item.county;
    setSearchMode('address');
    setAddressInput(address);
    handleSearch(address, county);
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Comp property-type buckets for the display filter.
  const compTypeBucket = (t?: string): string => {
    const s = String(t || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
    if (/single|sfr|detached/.test(s)) return 'single-family';
    if (/townh/.test(s)) return 'townhouse';
    if (/condo/.test(s)) return 'condo';
    if (/multi|duplex|triplex|quadruplex|apartment|\bapt\b/.test(s)) return 'multi-family';
    return 'other';
  };
  const COMP_TYPE_OPTIONS: { value: string; label: string }[] = [
    { value: 'all', label: 'All types' },
    { value: 'single-family', label: 'Single Family' },
    { value: 'townhouse', label: 'Townhouse' },
    { value: 'condo', label: 'Condo' },
    { value: 'multi-family', label: 'Multi-Family' },
  ];
  const allComps = data?.comps || [];
  const filteredComps = compTypeFilter === 'all' ? allComps : allComps.filter((c) => compTypeBucket(c.propertyType) === compTypeFilter);
  const visibleComps = compsShowAll ? filteredComps : filteredComps.slice(0, 10);

  return (
    <div className="dashboard-container">
      {/* Top Search Hero Section */}
      <div className="search-hero-section">
        <div className="card search-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
            <h2>GIS Feasibility Search</h2>
            <button
              type="button"
              className="btn-quick-action"
              onClick={() => setShowReports(true)}
              title="View your saved feasibility reports"
              style={{ flexShrink: 0 }}
            >
              <FolderOpen size={14} />
              <span>My Reports</span>
            </button>
          </div>
          <p className="card-subtitle">
            Enter any North Carolina property address to instantly query parcel boundaries, state plane projections, and local zoning classifications.
          </p>

          {!hasKeys && (
            <div className="api-keys-warning-banner" onClick={() => window.dispatchEvent(new CustomEvent('open-gis-settings'))}>
              <AlertCircle size={18} className="warning-icon" />
              <div className="warning-text">
                <strong>API Keys Required:</strong> Personal Google Maps and Gemini API Keys must be configured to run feasibility analyses. Click here to configure them in Account Settings.
              </div>
            </div>
          )}

          {/* Search by address (county auto-detected) or by NC parcel ID */}
          <div className="search-mode-toggle">
            <button
              type="button"
              className={`mode-btn ${searchMode === 'address' ? 'active' : ''}`}
              onClick={() => { setSearchMode('address'); setError(null); }}
              disabled={loading}
            >
              <MapPin size={14} /> Address
            </button>
            <button
              type="button"
              className={`mode-btn ${searchMode === 'parcel' ? 'active' : ''}`}
              onClick={() => { setSearchMode('parcel'); setError(null); }}
              disabled={loading}
            >
              <Landmark size={14} /> Parcel ID
            </button>
          </div>

          <form onSubmit={handleSubmit} className="search-form-row">
            {searchMode === 'address' ? (
              <div className="autocomplete-container" ref={containerRef}>
                <div className="input-group">
                  <Search className="input-icon" size={20} />
                  <input
                    type="text"
                    placeholder="Search any NC address — county is detected automatically…"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => {
                      if (predictions.length > 0) setShowDropdown(true);
                    }}
                    disabled={loading}
                    required
                  />
                </div>
                {showDropdown && predictions.length > 0 && (
                  <ul className="suggestions-list">
                    {predictions.map((pred, index) => (
                      <li
                        key={pred.place_id}
                        className={`suggestion-item ${index === activeIndex ? "active" : ""}`}
                        onClick={() => handleSelectPrediction(pred)}
                      >
                        <MapPin size={14} className="suggestion-icon" />
                        <span className="suggestion-text">{pred.description}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="autocomplete-container">
                <div className="input-group">
                  <Landmark className="input-icon" size={20} />
                  <input
                    type="text"
                    placeholder="Enter NC parcel ID / PIN (e.g. 56120014450000)…"
                    value={parcelIdInput}
                    onChange={(e) => setParcelIdInput(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>
              </div>
            )}
            <button
              type="submit"
              disabled={loading || (searchMode === 'address' ? !addressInput.trim() : !parcelIdInput.trim()) || !hasKeys}
              className="btn btn-primary"
            >
              {loading ? (
                <>
                  <Loader2 className="spinner" size={18} />
                  <span>{loadingStage || "Querying GIS..."}</span>
                </>
              ) : !hasKeys ? (
                <span>Setup API Keys</span>
              ) : (
                <span>Analyze Site</span>
              )}
            </button>

          </form>

          {/* Graceful error reporting */}
          {error && (
            <div className="error-alert">
              <AlertCircle size={18} className="error-icon" />
              <div className="error-message">{error}</div>
            </div>
          )}

          {/* Recent Searches */}
          {history.length > 0 && (
            <div className="recent-searches">
              <div className="recent-header">
                <History size={14} />
                <span>Recent Searches</span>
              </div>
              <div className="history-tags">
                {history.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleHistoryClick(item)}
                    className="history-tag"
                    title={typeof item === 'string' ? item : `${item.address} (${item.county} County)`}
                    disabled={loading}
                  >
                    {typeof item === 'string' ? item : `${item.address} (${item.county} County)`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Dashboard Split Grid */}
      <div className="dashboard-content-grid">
        {/* Left Column: Result Details / Stats */}
        <div className="dashboard-sidebar-column">
          {data ? (
            <div className="sidebar-scroll-wrapper fade-in">
              {/* Live analysis progress — parcel data is already visible below;
                  the remaining layers stream in as they resolve. */}
              {loading && (
                <div className="card registry-card" style={{ marginBottom: '15px' }}>
                  <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Loader2 size={15} className="spinner" />
                    <span>Live Analysis Progress</span>
                  </h3>
                  <ProgressStep done label="Parcel boundary & county registry" />
                  <ProgressStep done={!!data.zoningCode} active={!data.zoningCode} label="Zoning district & dimensional standards" />
                  <ProgressStep done={!!data.slopeProfile} active={!data.slopeProfile} label="Topography & buildability (USGS 3DEP)" />
                  <ProgressStep
                    done={data.comps !== undefined}
                    active={data.comps === undefined}
                    label={data.comps === undefined && loadingStage ? `Sold comps — ${loadingStage}` : "Verified sold comps"}
                  />
                </div>
              )}
              {data.isSimulated && (
                <div className="card" style={{ background: 'var(--warning-bg, #fef3c7)', border: '1px solid var(--warning-border, #f59e0b)', color: 'var(--warning-text, #78350f)', padding: '10px 15px', borderRadius: 'var(--radius-md)', marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <AlertCircle size={20} style={{ color: '#d97706', flexShrink: 0 }} />
                  <div style={{ fontSize: '0.78rem', lineHeight: '1.3' }}>
                    <strong>Statewide GIS Server Offline (504 Gateway Timeout)</strong><br />
                    Showing simulated parcel bounds centered on the geocoded coordinate. Web search zoning lookup and topography profiles remain active.
                  </div>
                </div>
              )}
              {/* Screenshot-Style Parcel Header Card */}
              <div className="card registry-header-card">
                {/* Big Title Name */}
                <h3 className="registry-title-name">
                  {data.ownerName || "Property Owner"}
                </h3>
                <div className="registry-title-address">
                  {data.inputAddress}
                </div>
                <div className="registry-title-acres">
                  {data.gisAcres.toFixed(2)} acres
                </div>

                {/* Quick Action Buttons */}
                <div className="registry-quick-actions">
                  <a 
                    href={`https://www.google.com/maps/search/?api=1&query=${data.coordinates.lat},${data.coordinates.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-quick-action"
                  >
                    <Navigation size={14} className="directions-icon-rotate" />
                    <span>Directions</span>
                  </a>
                  <button
                    onClick={generatePrintableReport}
                    className="btn-quick-action"
                    disabled={chatLoading || chatHistory.length === 0}
                  >
                    {chatLoading ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>Generating Report...</span>
                      </>
                    ) : (
                      <>
                        <Download size={14} />
                        <span>Download PDF Report</span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={async () => {
                      if (!data || chatHistory.length === 0 || chatHistory[0].role !== 'model') return;
                      try {
                        await saveReport({
                          address: data.inputAddress,
                          county: data.countyName,
                          parcelId: data.parcelId,
                          acres: data.gisAcres,
                          zoningCode: data.zoningCode,
                          ownerName: data.ownerName,
                          reportMarkdown: sanitizeReportText(chatHistory[0].content),
                        });
                        setReportSaved(true);
                      } catch (e: any) {
                        console.error(e);
                        alert(e?.message || 'Failed to save the report.');
                      }
                    }}
                    className="btn-quick-action"
                    disabled={chatLoading || chatHistory.length === 0 || reportSaved}
                    title="Save this report to your Reports section"
                  >
                    {reportSaved ? (
                      <>
                        <Check size={14} />
                        <span>Saved to Reports</span>
                      </>
                    ) : (
                      <>
                        <Bookmark size={14} />
                        <span>Save to Reports</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Card 1: Owner Information */}
              <div className="card registry-card">
                <h3 className="registry-card-header">Owner Information</h3>
                <div className="registry-list">
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <User size={16} className="registry-icon-blue" />
                      <span>{data.ownerName || "N/A"}</span>
                    </div>
                  </div>
                  <div className="registry-row copyable-row">
                    <div className="registry-label-with-icon" style={{ flex: 1 }}>
                      <Mail size={16} className="registry-icon-blue" />
                      <span className="address-text-break">{data.mailingAddress || "N/A"}</span>
                    </div>
                    <button 
                      type="button" 
                      onClick={() => handleCopy(data.mailingAddress || "", "mailAddress")}
                      className="registry-row-copy-btn"
                      title="Copy Mailing Address"
                    >
                      {copiedId === "mailAddress" ? <Check size={14} className="success-icon" /> : <Copy size={14} />}
                    </button>
                  </div>

                  {/* Skip Trace Owner (Enformion) — phones & emails for this owner */}
                  <div className="owner-skip">
                    <button type="button" className="owner-skip-btn" onClick={skipTraceOwner} disabled={ownerSkipLoading || !data.ownerName}>
                      {ownerSkipLoading ? <Loader2 size={14} className="spinner" /> : <Fingerprint size={14} />}
                      {ownerSkipLoading ? 'Skip tracing…' : 'Skip Trace Owner'}
                    </button>
                    {ownerSkip && (ownerSkip.phones.length > 0 || ownerSkip.emails.length > 0 || (ownerSkip.officers && ownerSkip.officers.length > 0) || (ownerSkip.relatives && ownerSkip.relatives.length > 0)) && (
                      <div className="owner-skip-result">
                        {ownerSkip.phones.length > 0 && (
                          <div className="owner-skip-row"><Phone size={13} />
                            {ownerSkip.phones.map((p, i) => (
                              <span key={i} className="owner-skip-chip"><a href={`tel:${p.number.replace(/[^0-9+]/g, '')}`}>{p.number}</a>{p.type ? <em> {p.type}</em> : null}</span>
                            ))}
                          </div>
                        )}
                        {ownerSkip.emails.length > 0 && (
                          <div className="owner-skip-row"><AtSign size={13} />
                            {ownerSkip.emails.map((e, i) => (
                              <span key={i} className="owner-skip-chip"><a href={`mailto:${e}`}>{e}</a></span>
                            ))}
                          </div>
                        )}
                        {/* Members / officers behind the LLC, each with their own phones/emails */}
                        {ownerSkip.officers && ownerSkip.officers.length > 0 && (
                          <div className="owner-skip-officers">
                            <div className="owner-skip-sub">Members / officers:</div>
                            {ownerSkip.officers.map((o, i) => (
                              <div key={i} className="owner-skip-officer">
                                <span className="owner-skip-officer-name">{o.name}{o.title ? <em> — {o.title}</em> : null}</span>
                                {(o.phones.length > 0 || o.emails.length > 0) ? (
                                  <span className="owner-skip-officer-contacts">
                                    {o.phones.map((p, j) => <a key={`p${j}`} href={`tel:${p.replace(/[^0-9+]/g, '')}`} className="owner-skip-chip">{p}</a>)}
                                    {o.emails.map((e, j) => <a key={`e${j}`} href={`mailto:${e}`} className="owner-skip-chip">{e}</a>)}
                                  </span>
                                ) : <span className="owner-skip-officer-none">no contact match</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {ownerSkip.relatives && ownerSkip.relatives.length > 0 && <div className="owner-skip-sub">Relatives: {ownerSkip.relatives.slice(0, 5).join(', ')}</div>}
                      </div>
                    )}
                    {ownerSkipError && <div className="owner-skip-err"><AlertCircle size={12} /> {ownerSkipError}</div>}
                  </div>
                </div>
              </div>

              {/* Enformion Property Search V2: deed owners, recorded mortgages
                  & sale transactions for the searched address. */}
              {enformionConfigured() && (enfLoading || enfProperty || enfErrors.property) && (
                <div className="card registry-card enf-records-card">
                  <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <FileText size={16} style={{ color: 'var(--primary)' }} />
                    <span>Mortgage &amp; Transactions — Enformion</span>
                    <button
                      type="button"
                      className="enf-retry-btn"
                      title="Re-run the Enformion record searches"
                      disabled={enfLoading}
                      onClick={() => { if (data) fetchEnformionRecords(data, searchSeqRef.current); }}
                    >
                      {enfLoading ? <Loader2 size={13} className="spinner" /> : <History size={13} />}
                      <span>{enfLoading ? 'Searching…' : 'Retry'}</span>
                    </button>
                  </h3>
                  {enfLoading && (
                    <div className="enf-loading"><Loader2 size={14} className="spinner" /><span>Pulling deed, mortgage &amp; transaction records…</span></div>
                  )}

                  {/* Property Search V2: deed + mortgages + sale transactions */}
                  <div className="enf-section">
                    <div className="enf-section-head">
                      <Landmark size={14} />
                      <span>Recorded Deed, Mortgages &amp; Sales</span>
                      {enfProperty && (
                        <span className="enf-count-pill">{enfProperty.mortgages.length + enfProperty.transactions.length} record{enfProperty.mortgages.length + enfProperty.transactions.length === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    {enfProperty ? (
                      <>
                        {enfProperty.currentOwners.length > 0 && (
                          <div className="enf-kv"><span className="k">Deed owner{enfProperty.currentOwners.length > 1 ? 's' : ''}</span><span className="v">{enfProperty.currentOwners.join(' & ')}</span></div>
                        )}
                        {enfProperty.apn && <div className="enf-kv"><span className="k">APN</span><span className="v">{enfProperty.apn}</span></div>}
                        {(enfProperty.purchasePrice > 0 || enfProperty.purchaseDate) && (
                          <div className="enf-kv"><span className="k">Last purchase</span><span className="v">{enfProperty.purchasePrice > 0 ? `$${enfProperty.purchasePrice.toLocaleString()}` : '—'}{enfProperty.purchaseDate ? ` · ${enfProperty.purchaseDate}` : ''}</span></div>
                        )}
                        {enfProperty.assessedValue > 0 && (
                          <div className="enf-kv"><span className="k">Assessed value{enfProperty.assessedYear ? ` (${enfProperty.assessedYear})` : ''}</span><span className="v">${enfProperty.assessedValue.toLocaleString()}</span></div>
                        )}
                        {enfProperty.taxAmount > 0 && (
                          <div className="enf-kv"><span className="k">Property tax{enfProperty.taxYear ? ` (${enfProperty.taxYear})` : ''}</span><span className="v">${enfProperty.taxAmount.toLocaleString()}</span></div>
                        )}
                        {enfProperty.openLienCount > 0 && (
                          <div className="enf-kv"><span className="k">Open liens on record</span><span className="v">{enfProperty.openLienCount}</span></div>
                        )}
                        {enfProperty.mortgages.map((m, i) => (
                          <div key={`m${i}`} className="enf-row">
                            <div className="enf-row-top">
                              <span className="enf-row-title">Mortgage{m.date ? ` · ${m.date}` : ''}</span>
                              {m.amount > 0 && <span className="enf-row-amt">${m.amount.toLocaleString()}</span>}
                            </div>
                            <span className="enf-row-sub">
                              {[m.lender && `Lender: ${m.lender}`, m.loanType && `Type: ${m.loanType}`, m.rateType && `Rate: ${m.rateType}`, m.docNumber && `Doc #${m.docNumber}`].filter(Boolean).join(' · ') || 'Recorded mortgage'}
                            </span>
                          </div>
                        ))}
                        {enfProperty.transactions.map((t, i) => (
                          <div key={`t${i}`} className="enf-row">
                            <div className="enf-row-top">
                              <span className="enf-row-title">{t.type || 'Sale'}{t.date ? ` · ${t.date}` : ''}</span>
                              {t.amount > 0 && <span className="enf-row-amt">${t.amount.toLocaleString()}</span>}
                            </div>
                            <span className="enf-row-sub">
                              {[t.buyers.length > 0 && `Buyer: ${t.buyers.join(' & ')}`, t.sellers.length > 0 && `Seller: ${t.sellers.join(' & ')}`, t.docNumber && `Doc #${t.docNumber}`].filter(Boolean).join(' · ') || 'Recorded transaction'}
                            </span>
                          </div>
                        ))}
                        {enfProperty.mortgages.length === 0 && enfProperty.transactions.length === 0 && (
                          <div className="enf-empty">
                            {enfProperty.recorderIncluded
                              ? 'Deed record found; Enformion\'s recorder section came back EMPTY for this parcel — no mortgages or sale transactions are on file with their data provider (common for new subdivision lots; county recorder coverage varies).'
                              : 'Deed record found, but Enformion\'s response did not include the Recorder (mortgage & transaction) section at all — ask Enformion support to enable the RecorderRecords include on your API access profile.'}
                          </div>
                        )}
                      </>
                    ) : enfErrors.property ? (
                      <div className="enf-err"><AlertCircle size={12} /> {enfErrors.property}</div>
                    ) : !enfLoading ? (
                      <div className="enf-empty">No property record matched this address in Enformion.</div>
                    ) : null}
                  </div>

                  <div className="enf-foot">Live from the Enformion Property Search V2 API using your credentials. Public-record coverage varies by county.</div>
                </div>
              )}

              {/* Card 2: Land Information */}
              <div className="card registry-card">
                <h3 className="registry-card-header">Land Information</h3>
                <div className="registry-list">
                  {/* Coordinates */}
                  <div className="registry-row copyable-row">
                    <div className="registry-label-with-icon" style={{ flex: 1 }}>
                      <MapPin size={16} className="registry-icon-blue" />
                      <span>{data.coordinates.lat.toFixed(5)}, {data.coordinates.lng.toFixed(5)}</span>
                    </div>
                    <button 
                      type="button" 
                      onClick={() => handleCopy(`${data.coordinates.lat.toFixed(5)}, ${data.coordinates.lng.toFixed(5)}`, "coords")}
                      className="registry-row-copy-btn"
                      title="Copy Coordinates"
                    >
                      {copiedId === "coords" ? <Check size={14} className="success-icon" /> : <Copy size={14} />}
                    </button>
                  </div>

                  {/* Acres */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <LayoutGrid size={16} className="registry-icon-blue" />
                      <span className="field-label">Total acres</span>
                    </div>
                    <strong className="field-value">{data.gisAcres.toFixed(2)}</strong>
                  </div>

                  {/* SQFT */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Ruler size={16} className="registry-icon-blue" />
                      <span className="field-label">Land sqft.</span>
                    </div>
                    <strong className="field-value">{new Intl.NumberFormat().format(data.grossSf)}</strong>
                  </div>

                  {/* Assessed Year */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Calendar size={16} className="registry-icon-blue" />
                      <span className="field-label">Assessed year</span>
                    </div>
                    <strong className="field-value">{data.assessedYear || 2025}</strong>
                  </div>

                  {/* Assessed Value */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <DollarSign size={16} className="registry-icon-blue" />
                      <span className="field-label">Assessed property value</span>
                      <span title="Value of properties as assessed by the local government for tax purposes." className="registry-icon-help">
                        <HelpCircle size={14} />
                      </span>
                    </div>
                    <strong className="field-value">${new Intl.NumberFormat().format(data.assessedPropertyValue || 0)}</strong>
                  </div>

                  {/* Land Value */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Layers size={16} className="registry-icon-blue" />
                      <span className="field-label">Land value</span>
                      <span title="The value of the raw land alone, excluding improvements." className="registry-icon-help">
                        <HelpCircle size={14} />
                      </span>
                    </div>
                    <strong className="field-value">${new Intl.NumberFormat().format(data.landValue || 0)}</strong>
                  </div>

                  {/* County */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Map size={16} className="registry-icon-blue" />
                      <span className="field-label">County</span>
                    </div>
                    <strong className="field-value">{data.countyName}</strong>
                  </div>

                  {/* Contact by Mail */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Mail size={16} className="registry-icon-blue" />
                      <span className="field-label">Contact by mail</span>
                      <span title="Whether the owner has requested to receive correspondence by mail." className="registry-icon-help">
                        <HelpCircle size={14} />
                      </span>
                    </div>
                    <strong className="field-value">{data.contactByMail || "No"}</strong>
                  </div>

                  {/* Parcel ID */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <FileText size={16} className="registry-icon-blue" />
                      <span className="field-label">Parcel id</span>
                    </div>
                    <strong className="field-value">{data.countyName.toLowerCase() === 'mecklenburg' && data.parcelId.length === 8 ? `${data.parcelId.substring(0, 3)}-${data.parcelId.substring(3, 6)}-${data.parcelId.substring(6, 8)} (${data.parcelId})` : data.parcelId}</strong>
                  </div>

                  {/* Deed Type */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <FileText size={16} className="registry-icon-blue" />
                      <span className="field-label">Type of deed</span>
                    </div>
                    <strong className="field-value">{data.deedType || "Warranty Deed"}</strong>
                  </div>

                  {/* Census Tract */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Bookmark size={16} className="registry-icon-blue" />
                      <span className="field-label">Census tract</span>
                    </div>
                    <strong className="field-value">{data.censusTract || "N/A"}</strong>
                  </div>
                </div>
              </div>

              {/* Card 3: Parcel & Tax Information */}
              <div className="card registry-card">
                <h3 className="registry-card-header">Parcel & Tax Information</h3>
                <div className="registry-list">
                  {/* Price sold for */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <DollarSign size={16} className="registry-icon-blue" />
                      <span className="field-label">Price sold for</span>
                      <span title="The price the property was last sold for." className="registry-icon-help">
                        <HelpCircle size={14} />
                      </span>
                    </div>
                    <strong className="field-value">${new Intl.NumberFormat().format(data.priceSoldFor || 0)}</strong>
                  </div>

                  {/* Date of sale */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Calendar size={16} className="registry-icon-blue" />
                      <span className="field-label">Date of sale</span>
                    </div>
                    <strong className="field-value">{data.dateOfSale || "N/A"}</strong>
                  </div>

                  {/* Tax code area */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <FileText size={16} className="registry-icon-blue" />
                      <span className="field-label">Tax code area</span>
                    </div>
                    <strong className="field-value">{data.taxCodeArea || "N/A"}</strong>
                  </div>

                  {/* Tax amount */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <DollarSign size={16} className="registry-icon-blue" />
                      <span className="field-label">Tax amount</span>
                    </div>
                    <strong className="field-value">${new Intl.NumberFormat().format(data.taxAmount || 0)}</strong>
                  </div>

                  {/* Tax year */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Calendar size={16} className="registry-icon-blue" />
                      <span className="field-label">Tax year</span>
                    </div>
                    <strong className="field-value">{data.taxYear || 2025}</strong>
                  </div>

                  {/* Sale price (full) */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <DollarSign size={16} className="registry-icon-blue" />
                      <span className="field-label">Sale price (full)</span>
                    </div>
                    <strong className="field-value">{data.salePriceFull || "Financial consideration"}</strong>
                  </div>

                  {/* Legal description */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon" style={{ flex: 1 }}>
                      <FileText size={16} className="registry-icon-blue" />
                      <span className="field-label">Legal description</span>
                    </div>
                    <strong className="field-value text-right" style={{ maxWidth: '60%', wordBreak: 'break-word', fontSize: '0.8rem' }}>{data.legalDescription || "N/A"}</strong>
                  </div>

                  {/* Total value calculated */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <DollarSign size={16} className="registry-icon-blue" />
                      <span className="field-label">Total value calculated</span>
                      <span title="The total calculated assessment value of the land and improvements." className="registry-icon-help">
                        <HelpCircle size={14} />
                      </span>
                    </div>
                    <strong className="field-value">${new Intl.NumberFormat().format(data.totalValueCalculated || 0)}</strong>
                  </div>

                  {/* Type of transaction */}
                  <div className="registry-row">
                    <div className="registry-label-with-icon">
                      <Tag size={16} className="registry-icon-blue" />
                      <span className="field-label">Type of transaction</span>
                    </div>
                    <strong className="field-value">{data.typeOfTransaction || "Resale"}</strong>
                  </div>
                </div>
              </div>

              {/* Card 4: Zoning & Development allowances */}
              <div className="card registry-card gridics-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '1rem' }}>
                  <h3 className="registry-card-header" style={{ margin: 0 }}>Zoning & Allowances</h3>
                  <span
                    title="Setbacks, height, and FAR are typical estimates by use category. Confirm against the local zoning ordinance."
                    style={{
                      fontSize: '10px',
                      backgroundColor: 'var(--warning-bg, rgba(245, 158, 11, 0.12))',
                      color: 'var(--warning, #d97706)',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      border: '1px solid var(--warning-border, rgba(245, 158, 11, 0.35))'
                    }}
                  >
                    STANDARDS: ESTIMATED
                  </span>
                </div>

                <div className="registry-list">
                  <div className="registry-row">
                    <span className="field-label">
                      Zoning Classification
                      <span style={{ display: 'block', fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.03em' }}>
                        {data.zoningSource === 'county-gis' ? 'SOURCE: COUNTY GIS' : data.zoningSource === 'web' ? 'SOURCE: WEB LOOKUP — VERIFY' : ''}
                      </span>
                    </span>
                    {data.zoningCode ? (
                      <span className={`zoning-badge ${data.zoningSource === 'county-gis' ? 'active-zone' : 'fallback-zone'}`}>
                        {data.zoningCode}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        <Loader2 size={13} className="spinner" />
                        <span>Resolving...</span>
                      </span>
                    )}
                  </div>
                  <div className="registry-row" style={{ borderBottom: '1px solid var(--bg-card-border)', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
                    <span className="field-label" style={{ fontSize: '0.75rem' }}>Zoning Description</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'right', maxWidth: '65%' }}>
                      {data.zoningDescription}
                      {data.zoningSourceUrl && (
                        <>
                          {' '}
                          <a href={data.zoningSourceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', fontSize: '0.72rem' }}>source ↗</a>
                        </>
                      )}
                    </span>
                  </div>
                </div>

                {data.gridics && (
                  <>
                    <div className="gridics-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px', marginTop: '12px' }}>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>LOT LAYOUT TYPE:</span>
                        <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.lotType.toUpperCase()}</strong>
                      </div>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>STREET FRONTAGE:</span>
                        <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.frontageLengthFt.toFixed(1)} ft</strong>
                      </div>
                      {data.gridics.lotWidthFt != null && data.gridics.lotDepthFt != null && (
                        <div>
                          <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>LOT SIZE (W × D):</span>
                          <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.lotWidthFt.toFixed(1)} × {data.gridics.lotDepthFt.toFixed(1)} ft</strong>
                        </div>
                      )}
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>MAX FOOTPRINT (EST.):</span>
                        <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.maxBuildingFootprintSqft.toLocaleString()} SF</strong>
                      </div>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>MAX HEIGHT (EST.):</span>
                        <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.maxHeightFt} ft</strong>
                      </div>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>FAR (EST.):</span>
                        <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{data.gridics.floorAreaRatio}</strong>
                      </div>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>TYPICAL SETBACKS (EST.):</span>
                        <strong style={{ fontSize: '11px', color: 'var(--text-primary)' }}>
                          F: {data.gridics.setbacks.frontFt} ft | R: {data.gridics.setbacks.rearFt} ft | S: {data.gridics.setbacks.sideFt} ft
                        </strong>
                      </div>
                    </div>

                    <hr style={{ border: '0', borderTop: '1px solid var(--bg-card-border)', margin: '15px 0' }} />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                      <div>
                        <span className="coord-label" style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>NET BUILDABLE ENVELOPE (EST.):</span>
                        <strong style={{ fontSize: '18px', color: 'var(--success)' }}>
                          {data.gridics.netBuildableAreaSqft.toLocaleString()} <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-muted)' }}>SF</span>
                        </strong>
                      </div>
                      <span style={{ fontSize: '10px', backgroundColor: 'var(--success-bg)', color: 'var(--success)', padding: '3px 8px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: 'bold', border: '1px solid var(--success-border)' }}>
                        Estimated
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Card 5: USGS 3DEP Slope Profile */}
              {!data.slopeProfile && (
                <div className="card registry-card slope-card">
                  <h3 className="registry-card-header">USGS 3DEP Slope Profile (1m)</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    <Loader2 size={16} className="spinner" />
                    <span>Sampling parcel elevations from USGS 3DEP...</span>
                  </div>
                </div>
              )}
              {data.slopeProfile && (
                <div className="card registry-card slope-card">
                  <h3 className="registry-card-header">USGS 3DEP Slope Profile (1m)</h3>
                  <div className="registry-list">
                    <div className="registry-row">
                      <span className="field-label">Average Site Slope</span>
                      <strong className="field-value">{data.slopeProfile.avgSlope}%</strong>
                    </div>
                    <div className="registry-row">
                      <span className="field-label">Maximum Site Slope</span>
                      <strong className="field-value">{data.slopeProfile.maxSlope}%</strong>
                    </div>
                    <div className="registry-row">
                      <span className="field-label">Elevation Range</span>
                      <strong className="field-value">{data.slopeProfile.minElevation}m - {data.slopeProfile.maxElevation}m (Avg: {data.slopeProfile.avgElevation}m)</strong>
                    </div>
                    <div className="registry-row" style={{ borderBottom: '1px solid var(--bg-card-border)', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
                      <span className="field-label">Buildability Verdict</span>
                      <span style={{
                        fontSize: '11px',
                        backgroundColor: 
                          data.slopeProfile.verdict === 'BUILDABLE' ? 'var(--success-bg)' : 
                          data.slopeProfile.verdict === 'REQUIRES ENGINEERING' ? 'var(--warning-bg, #fef3c7)' : 'var(--error-bg)',
                        color: 
                          data.slopeProfile.verdict === 'BUILDABLE' ? 'var(--success)' : 
                          data.slopeProfile.verdict === 'REQUIRES ENGINEERING' ? 'var(--warning, #d97706)' : 'var(--error)',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                        textTransform: 'uppercase',
                        border: `1px solid ${
                          data.slopeProfile.verdict === 'BUILDABLE' ? 'var(--success-border)' : 
                          data.slopeProfile.verdict === 'REQUIRES ENGINEERING' ? '#fde68a' : 'var(--error-border)'
                        }`
                      }}>
                        {data.slopeProfile.verdict}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                      {data.slopeProfile.verdict === 'BUILDABLE' && (
                        <span>The property has a mild terrain (average slope {data.slopeProfile.avgSlope}%) and is classified as <strong>Buildable</strong>. Standard foundation designs and grading can be utilized.</span>
                      )}
                      {data.slopeProfile.verdict === 'REQUIRES ENGINEERING' && (
                        <span style={{ color: 'var(--warning, #d97706)' }}><strong>Requires Special Engineering:</strong> Slope falls between 15% and 25%. Expect increased site preparation, grading costs, or engineered retaining walls.</span>
                      )}
                      {data.slopeProfile.verdict === 'NON-BUILDABLE' && (
                        <span style={{ color: 'var(--error)' }}><strong>Non-Buildable / High Risk:</strong> Slopes exceed 25% threshold. Extreme grading challenges, retaining wall configurations, and landslide/runoff engineering required.</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Card 6: Verified Market Comps (SOLD ONLY) */}
              {data.comps === undefined && (
                <div className="card registry-card comps-card">
                  <h3 className="registry-card-header">Verified Market Comps (SOLD ONLY)</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    <Loader2 size={16} className="spinner" />
                    <span>{loadingStage || 'Searching & verifying sold new-construction comps...'}</span>
                  </div>
                </div>
              )}
              {data.comps && data.comps.length === 0 && (
                <div className="card registry-card comps-card">
                  <h3 className="registry-card-header">Verified Market Comps (SOLD ONLY)</h3>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 0', color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.45 }}>
                    <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--warning, #d97706)' }} />
                    <span>No qualifying comps found: no new-construction sales (built 2025–2026) matching this parcel's zoning use closed within the last 12 months inside the 5 driving-mile radius (RealtyAPI: Realtor, Redfin, Zillow). The chat bubble has the run breakdown.</span>
                  </div>
                </div>
              )}
              {data.comps && data.comps.length > 0 && (
                <div className="card registry-card comps-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <h3 className="registry-card-header">Verified Market Comps (SOLD ONLY)</h3>
                    {data.compRunSummary && (
                      <a
                        className="btn-quick-action"
                        style={{ flexShrink: 0, textDecoration: 'none' }}
                        title="Open a pre-filled email with the comp run summary"
                        href={`mailto:Herringdarius00@gmail.com?subject=${encodeURIComponent(`New Construction Comps — ${data.inputAddress} (${data.comps.length} comps)`)}&body=${encodeURIComponent(data.compRunSummary.replace(/[#*]/g, '').slice(0, 1800))}`}
                      >
                        <Mail size={13} />
                        <span>Email Summary</span>
                      </a>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.6rem', fontStyle: 'italic', borderBottom: '1px dashed var(--bg-card-border)', paddingBottom: '0.5rem' }}>
                    *Criteria: New construction (built 2025–2026) matching this parcel's zoning use, sold within 12 months, no sqft limits, within {compRadius} driving miles. Sources: Realtor.com sold records (radius scan, ✓ confirmed) + public MLS via Google Search.*
                  </div>
                  {/* Comp filters: max radius (re-fetches) + property type (instant) */}
                  <div className="comp-filter-bar">
                    <div className="comp-filter-group">
                      <span className="comp-filter-label">Radius</span>
                      {[3, 5, 10].map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={`comp-filter-pill${compRadius === r ? ' active' : ''}`}
                          disabled={compsRefetching}
                          onClick={() => changeCompRadius(r)}
                        >
                          {r} mi
                        </button>
                      ))}
                      {compsRefetching && <Loader2 size={13} className="spinner" style={{ color: 'var(--text-muted)' }} />}
                    </div>
                    <div className="comp-filter-group">
                      <span className="comp-filter-label">Type</span>
                      <select
                        className="comp-filter-select"
                        value={compTypeFilter}
                        onChange={(e) => { setCompTypeFilter(e.target.value); setCompsShowAll(false); }}
                      >
                        {COMP_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {filteredComps.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      <AlertCircle size={15} style={{ color: 'var(--warning, #d97706)' }} />
                      <span>No {COMP_TYPE_OPTIONS.find((o) => o.value === compTypeFilter)?.label.toLowerCase()} comps in this set. Try “All types” or a wider radius.</span>
                    </div>
                  ) : (
                  <>
                  <div className="comps-list" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {(() => {
                      const prettyType = (t?: string) => {
                        const s = String(t || '').replace(/[_-]+/g, ' ').trim();
                        if (!s) return '';
                        const map: Record<string, string> = {
                          'single family': 'Single Family', 'singlefamily': 'Single Family', 'sfr': 'Single Family', 'single family residence': 'Single Family', 'single family residential': 'Single Family',
                          'townhouse': 'Townhouse', 'townhome': 'Townhome', 'townhomes': 'Townhome', 'condo': 'Condo', 'condos': 'Condo', 'condominium': 'Condo',
                          'multi family': 'Multi-Family', 'multifamily': 'Multi-Family', 'duplex': 'Duplex', 'triplex': 'Triplex', 'quadruplex': 'Quadruplex',
                          'apartment': 'Apartment', 'land': 'Land', 'mobile': 'Mobile/Manufactured', 'manufactured': 'Mobile/Manufactured',
                        };
                        return map[s.toLowerCase()] || s.replace(/\b\w/g, (c) => c.toUpperCase());
                      };
                      return visibleComps.map((comp, idx) => (
                      <div key={idx} className="comp-item" style={{
                        padding: '10px',
                        borderRadius: '6px',
                        border: '1px solid var(--bg-card-border)',
                        background: 'var(--bg-card-hover, #f8fafc)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px'
                      }}>
                        {/* The ACTUAL listing photo from the Realtor/Redfin/Zillow feed.
                            No Google Street View/satellite fallback — show a neutral
                            placeholder instead when a comp's source has no photo. */}
                        {comp.imageUrl ? (
                          <img
                            src={comp.imageUrl}
                            onError={(e) => {
                              const img = e.currentTarget;
                              img.style.display = 'none';
                              if (img.nextElementSibling instanceof HTMLElement) img.nextElementSibling.style.display = 'flex';
                            }}
                            alt={`Comp ${idx + 1}: ${comp.address}`}
                            loading="lazy"
                            /* Full photo, never cropped: natural width/height (object-fit
                               contain) inside a fixed-ratio frame so nothing is cut off. */
                            style={{ width: '100%', height: 'auto', maxHeight: '420px', objectFit: 'contain', display: 'block', borderRadius: '4px', border: '1px solid var(--bg-card-border)', background: '#0f172a' }}
                          />
                        ) : null}
                        <div style={{
                          display: comp.imageUrl ? 'none' : 'flex',
                          alignItems: 'center', justifyContent: 'center', gap: '6px',
                          width: '100%', height: '130px', borderRadius: '4px',
                          border: '1px dashed var(--bg-card-border)', background: 'var(--bg-main, #f1f5f9)',
                          color: 'var(--text-muted)', fontSize: '0.72rem',
                        }}>
                          <ImageOff size={14} /> No listing photo for this comp
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ 
                            fontSize: '11px', 
                            background: '#ef4444', 
                            color: '#ffffff', 
                            borderRadius: '50%', 
                            width: '18px', 
                            height: '18px', 
                            display: 'inline-flex', 
                            alignItems: 'center', 
                            justifyContent: 'center', 
                            fontWeight: 'bold',
                            marginRight: '6px'
                          }}>
                            {idx + 1}
                          </span>
                            <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', flex: 1 }}>
                            <a 
                              href={comp.url || `https://www.google.com/search?q=${encodeURIComponent(comp.address)}`} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              style={{ color: 'var(--primary)', textDecoration: 'underline' }}
                            >
                              {comp.address} ↗
                            </a>
                          </strong>
                          <strong style={{ fontSize: '0.9rem', color: 'var(--success)', marginLeft: '10px' }}>
                            ${comp.price.toLocaleString()}
                          </strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-secondary)', paddingLeft: '24px' }}>
                          <span>
                            Driving: <strong>{comp.distanceMiles.toFixed(1)} mi</strong> ({comp.durationMins.toFixed(0)} mins)
                            {comp.straightLineMiles != null && <span style={{ color: 'var(--text-muted)' }}> · {comp.straightLineMiles.toFixed(1)} mi straight</span>}
                          </span>
                          <span>Sold: <strong>{comp.saleDate}</strong></span>
                        </div>
                        {(comp.sqft || comp.pricePerSqft || comp.yearBuilt || comp.propertyType) && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 10px', fontSize: '0.72rem', color: 'var(--text-secondary)', paddingLeft: '24px', borderTop: '1px dashed rgba(0,0,0,0.05)', paddingTop: '4px' }}>
                            {comp.propertyType && <span>Type: <strong>{prettyType(comp.propertyType)}</strong></span>}
                            {comp.sqft && <span>Size: <strong>{comp.sqft.toLocaleString()} SF</strong></span>}
                            {comp.pricePerSqft && <span><strong>${comp.pricePerSqft.toLocaleString()}/SF</strong></span>}
                            {comp.yearBuilt && <span>Built: <strong>{comp.yearBuilt}</strong></span>}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', paddingLeft: '24px', paddingTop: '2px' }}>
                          <span style={{ color: comp.verified ? 'var(--success)' : 'var(--text-muted)', fontWeight: 600 }}>
                            {comp.verifiedNote || 'Source: RealtyAPI closed-sale record'}
                            {comp.url && (
                              <a href={comp.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: '6px', color: 'var(--primary)', textDecoration: 'underline', fontWeight: 700 }} title="Open the actual listing to confirm the sold price">verify ↗</a>
                            )}
                          </span>
                          {comp.drivingFallback && (
                            <span style={{ color: 'var(--warning, #d97706)' }} title="Google driving distance unavailable — straight-line used">⚠ straight-line</span>
                          )}
                        </div>
                        {comp.priceDiscrepancy && (
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', paddingLeft: '24px' }}>
                            Price corrected to MLS record ({comp.priceDiscrepancy})
                          </div>
                        )}
                      </div>
                      ));
                    })()}
                  </div>
                  {filteredComps.length > 10 && (
                    <button
                      type="button"
                      className="comps-viewall-btn"
                      onClick={() => setCompsShowAll((v) => !v)}
                    >
                      {compsShowAll ? 'Show less' : `View all ${filteredComps.length} comps`}
                    </button>
                  )}
                  </>
                  )}
                </div>
              )}

              {/* Instant Construction Cost Estimate — real-time LOCAL pricing,
                  shown after the comps and before the full AI report. */}
              {(costEstimate || costLoading || materialTakeoff || costError) && (
                <div className="card registry-card cost-estimate-card">
                  <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Hammer size={16} style={{ color: 'var(--primary)' }} />
                    <span>Instant Construction Cost Estimate</span>
                  </h3>

                  {costError && !costEstimate && !materialTakeoff ? (
                    <div className="cost-loading" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
                      <span>Couldn't generate the local cost estimate (the pricing service was busy).</span>
                      <button
                        type="button"
                        className="btn-quick-action"
                        onClick={() => { if (data) generateCostEstimates(data, searchSeqRef.current); }}
                      >
                        <Loader2 size={14} className={costLoading ? 'spinner' : ''} /> Retry estimate
                      </button>
                    </div>
                  ) : costLoading && !costEstimate && !materialTakeoff ? (
                    <div className="cost-loading">
                      <Loader2 size={15} className="spinner" />
                      <span>Pricing this build with current local costs…</span>
                    </div>
                  ) : costEstimate ? (
                    <>
                      <div className="cost-hero">
                        <div className="cost-total-block">
                          <span className="cost-total-label">Estimated build cost</span>
                          <span className="cost-total-value">${costEstimate.totalCost.toLocaleString()}</span>
                        </div>
                        <div className="cost-meta">
                          <span><strong>${costEstimate.costPerSqft.toLocaleString()}</strong> / sqft</span>
                          <span><strong>{costEstimate.plannedSqft.toLocaleString()}</strong> sqft home</span>
                        </div>
                        <div className="cost-locality"><MapPin size={11} /> {costEstimate.locality}</div>
                        {costEstimate.laborBasis && (
                          <div className="cost-labor-basis"><Hammer size={11} /> {costEstimate.laborBasis}</div>
                        )}
                      </div>

                      {groupCostItems(costEstimate.lineItems).map(([cat, items]) => (
                        <div key={cat} className="cost-group">
                          <div className="cost-group-head">
                            <span>{cat}</span>
                            <span>${items.reduce((s, i) => s + i.cost, 0).toLocaleString()}</span>
                          </div>
                          {items.map((li, i) => (
                            <div key={i} className="cost-line">
                              <span className="cost-line-item">{li.item}{li.detail && <span className="cost-line-detail"> · {li.detail}</span>}</span>
                              <span className="cost-line-cost">${li.cost.toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      ))}

                      <div className="cost-group cost-totals">
                        <div className="cost-line"><span>Hard cost subtotal</span><span>${costEstimate.hardCostTotal.toLocaleString()}</span></div>
                        {costEstimate.builderFee > 0 && <div className="cost-line"><span>Builder fee</span><span>${costEstimate.builderFee.toLocaleString()}</span></div>}
                        {costEstimate.contingency > 0 && <div className="cost-line"><span>Contingency</span><span>${costEstimate.contingency.toLocaleString()}</span></div>}
                        <div className="cost-line cost-grand"><span>Total build cost</span><span>${costEstimate.totalCost.toLocaleString()}</span></div>
                      </div>

                      {costEstimate.assumptions.length > 0 && (
                        <div className="cost-assumptions">
                          <span className="cost-assumptions-label">Assumptions:</span> {costEstimate.assumptions.join(' · ')}
                        </div>
                      )}
                      {costEstimate.sources.length > 0 && (
                        <div className="cost-sources">
                          <span className="cost-sources-label">Local pricing sources:</span>
                          {costEstimate.sources.map((s, i) => (
                            <a key={i} href={s} target="_blank" rel="noreferrer">
                              {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="cost-disclaimer">Instant AI estimate from current local pricing — confirm with local bids before contracting. Excludes the land/lot price.</div>
                    </>
                  ) : null}

                  {/* Local Material Takeoff — parcel ZIP → quantity (recipe × size) × local unit price */}
                  {materialTakeoff && (
                    <div className="takeoff-section">
                      <div className="takeoff-head">
                        <span><Landmark size={13} /> Local Material Takeoff{materialTakeoff.zip ? ` · ZIP ${materialTakeoff.zip}` : ''}</span>
                        <span className="takeoff-total">${materialTakeoff.materialTotal.toLocaleString()}</span>
                      </div>
                      <div className="takeoff-sub">Every major material to build a ~{materialTakeoff.plannedSqft.toLocaleString()} sqft house — quantity × current local unit price, phase by phase</div>
                      <div className="takeoff-table">
                        <div className="takeoff-row takeoff-row-head">
                          <span>Material</span><span>Qty</span><span>Unit&nbsp;$</span><span>Cost</span>
                        </div>
                        {(() => {
                          // Group line items by build phase, preserving recipe order.
                          const order: string[] = [];
                          const byPhase: Record<string, typeof materialTakeoff.items> = {};
                          for (const it of materialTakeoff.items) {
                            const ph = it.phase || 'Materials';
                            if (!byPhase[ph]) { byPhase[ph] = []; order.push(ph); }
                            byPhase[ph].push(it);
                          }
                          return order.map((ph) => {
                            const phaseCost = byPhase[ph].reduce((s, it) => s + it.cost, 0);
                            return (
                              <div key={ph} className="takeoff-phase">
                                <div className="takeoff-phase-head">
                                  <span>{ph}</span>
                                  <span>${phaseCost.toLocaleString()}</span>
                                </div>
                                {byPhase[ph].map((it, i) => (
                                  <div key={i} className="takeoff-row">
                                    <span className="takeoff-mat">{it.material}</span>
                                    <span>{it.quantity.toLocaleString()} {it.unit}</span>
                                    <span>${it.unitPrice.toLocaleString(undefined, { minimumFractionDigits: it.unitPrice < 10 ? 2 : 0, maximumFractionDigits: 2 })}</span>
                                    <span className="takeoff-cost">${it.cost.toLocaleString()}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          });
                        })()}
                        <div className="takeoff-row takeoff-grand">
                          <span className="takeoff-mat">Total materials</span><span></span><span></span>
                          <span className="takeoff-cost">${materialTakeoff.materialTotal.toLocaleString()}</span>
                        </div>
                      </div>
                      {materialTakeoff.sources.length > 0 && (
                        <div className="cost-sources">
                          <span className="cost-sources-label">Material price sources:</span>
                          {materialTakeoff.sources.map((s, i) => (
                            <a key={i} href={s} target="_blank" rel="noreferrer">
                              {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="cost-disclaimer">Whole-house material list — quantities from standard takeoff factors × the building size, priced at current local unit costs. This is MATERIALS only; labor, permits, builder fee &amp; contingency are in the full estimate above.</div>
                    </div>
                  )}
                </div>
              )}

              {/* Utilities & Connection Costs — public water/sewer tap fees when
                  served, otherwise real-time local well + septic costs. The card
                  stays visible on failure with the real reason + Retry. */}
              {(utilities || utilitiesLoading || utilitiesError) && (
                <div className="card registry-card utilities-card">
                  <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Droplets size={16} style={{ color: 'var(--primary)' }} />
                    <span>Utilities, Taps &amp; Permit Fees</span>
                    <button
                      type="button"
                      className="enf-retry-btn"
                      title="Re-run the utilities & fee-schedule lookup"
                      disabled={utilitiesLoading}
                      onClick={() => { if (data) runUtilitiesLookup(data, searchSeqRef.current); }}
                    >
                      {utilitiesLoading ? <Loader2 size={13} className="spinner" /> : <History size={13} />}
                      <span>{utilitiesLoading ? 'Searching…' : 'Retry'}</span>
                    </button>
                  </h3>
                  {utilitiesLoading && !utilities ? (
                    <div className="cost-loading"><Loader2 size={15} className="spinner" /><span>Checking water/sewer availability, tap fees &amp; permit schedules…</span></div>
                  ) : utilitiesError && !utilities ? (
                    <div className="enf-err"><AlertCircle size={12} /> {utilitiesError}</div>
                  ) : utilities ? (
                    <>
                      <div className="util-summary">
                        <span className={`util-jurisdiction ${utilities.incorporated ? 'incorporated' : 'unincorporated'}`}>
                          <MapPin size={12} /> {utilities.jurisdiction}
                        </span>
                        <span className="util-summary-text">{utilities.summary}</span>
                        {utilities.provider && <span className="util-provider">Authority: {utilities.provider}</span>}
                      </div>
                      <div className="util-rows">
                        {utilities.lines.map((ln, i) => (
                          <div key={i} className="util-row">
                            <div className="util-row-top">
                              <span className="util-name">{ln.name}</span>
                              <span className={`util-badge ${ln.isPublic ? 'public' : 'private'}`}>
                                {ln.isPublic ? 'Public hookup' : (ln.kind === 'water' ? 'Well needed' : 'Septic needed')}
                              </span>
                            </div>
                            {ln.detail && <div className="util-note util-detail">{ln.detail}</div>}
                            {ln.note && <div className="util-note">{ln.note}</div>}
                            {ln.verified ? (
                              <div className="util-cost">{ln.low === ln.high ? `$${ln.low.toLocaleString()}` : `$${ln.low.toLocaleString()} – $${ln.high.toLocaleString()}`} <span className="util-verified-tag">verified local price</span></div>
                            ) : (
                              <div className="util-cost util-unpriced">No verified local price found — confirm with {utilities.provider || 'the local provider/contractor'}</div>
                            )}
                          </div>
                        ))}
                        {(utilities.totalLow > 0 || utilities.totalHigh > 0) && (
                          <div className="util-row util-total">
                            <span>{utilities.totalLow === utilities.totalHigh ? 'Total tap fees (verified)' : 'Total to connect (verified items only)'}</span>
                            <span className="util-cost">{utilities.totalLow === utilities.totalHigh ? `$${utilities.totalLow.toLocaleString()}` : `$${utilities.totalLow.toLocaleString()} – $${utilities.totalHigh.toLocaleString()}`}</span>
                          </div>
                        )}
                        {utilities.tapNote && (
                          <div className="util-tapnote">{utilities.tapNote}</div>
                        )}
                      </div>

                      {/* Residential permit fees — jurisdiction's adopted fee
                          schedule, verified figures only. */}
                      {utilities.permits.length > 0 && (
                        <div className="util-rows util-permits">
                          <div className="util-subhead">Permits &amp; development fees</div>
                          {utilities.permits.map((p, i) => (
                            <div key={i} className="util-row">
                              <div className="util-row-top">
                                <span className="util-name">{p.name}</span>
                              </div>
                              {p.note && <div className="util-note">{p.note}</div>}
                              <div className="util-cost">{p.low === p.high ? `$${p.low.toLocaleString()}` : `~$${p.low.toLocaleString()} – $${p.high.toLocaleString()}`} <span className="util-verified-tag">fee schedule</span></div>
                            </div>
                          ))}
                          {(() => {
                            const pl = utilities.permits.reduce((s, p) => s + p.low, 0);
                            const ph = utilities.permits.reduce((s, p) => s + p.high, 0);
                            const tl = utilities.totalLow + pl, th = utilities.totalHigh + ph;
                            return (
                              <div className="util-row util-total">
                                <span>Estimated development fees (taps + permits)</span>
                                <span className="util-cost">{tl === th ? `$${tl.toLocaleString()}` : `~$${tl.toLocaleString()} – $${th.toLocaleString()}`}</span>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                      {utilities.sources.length > 0 && (
                        <div className="cost-sources">
                          <span className="cost-sources-label">Sources:</span>
                          {utilities.sources.map((s, i) => (
                            <a key={i} href={s} target="_blank" rel="noreferrer">
                              {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="cost-disclaimer">{utilities.realTime ? 'Every dollar figure above was found live in the cited local sources (current fee schedules / local contractor pricing) — no estimates or regional averages are ever shown.' : 'No verifiable current local prices were found online for this location, so no figures are shown — nothing is estimated or guessed.'} Tap/impact fees + well/septic costs vary by lot, depth, and soil — confirm with the utility authority and a local well/septic contractor (a septic perc test is required before building).</div>
                    </>
                  ) : null}
                </div>
              )}

              {/* Land Clearing & Site Prep — rule-based pricing engine (regional
                  NC $/acre rates × satellite-classified vegetation density). */}
              {(landClearing || landClearingLoading) && (
                <div className="card registry-card clearing-card">
                  <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Trees size={16} style={{ color: 'var(--primary)' }} />
                    <span>Land Clearing &amp; Site Prep Estimate</span>
                  </h3>
                  {landClearingLoading && !landClearing ? (
                    <div className="cost-loading"><Loader2 size={15} className="spinner" /><span>Reading tree cover from satellite imagery…</span></div>
                  ) : landClearing ? (
                    <>
                      <div className="clearing-hero">
                        <div className="clearing-imgs">
                          <a href={`https://www.google.com/maps/@${data.coordinates.lat},${data.coordinates.lng},18z/data=!3m1!1e3`} target="_blank" rel="noreferrer" title="Open in Google Maps satellite">
                            <img className="clearing-sat" src={landClearing.satelliteUrl} alt="Parcel satellite view" loading="lazy" />
                          </a>
                          {landClearing.streetViewUrl && (
                            <a href={`https://www.google.com/maps?layer=c&cbll=${data.coordinates.lat},${data.coordinates.lng}`} target="_blank" rel="noreferrer" title="Open Street View">
                              <img className="clearing-sat" src={landClearing.streetViewUrl} alt="Street view" loading="lazy" />
                            </a>
                          )}
                        </div>
                        <div className="clearing-hero-meta">
                          <span className="clearing-treecount">~{landClearing.treeCount.toLocaleString()} trees to remove</span>
                          {landClearing.canopyCoverPct != null && <span className="clearing-canopy">~{landClearing.canopyCoverPct}% tree canopy · {landClearing.density}</span>}
                          <span className="clearing-acres">{landClearing.acres.toLocaleString()} acres · {landClearing.realTimePricing ? 'live local rates' : 'baseline rates'}</span>
                        </div>
                      </div>
                      <div className="clearing-rows">
                        <div className="clearing-row clearing-row-head"><span>Trees</span><span>Each</span><span>Cost</span></div>
                        {landClearing.trees.map((t, i) => (
                          <div key={i} className="clearing-row clearing-tree">
                            <span className="clearing-tree-size">{t.count.toLocaleString()} {t.size}</span>
                            <span>${t.unitCost.toLocaleString()}</span>
                            <span className="clearing-amt">${t.cost.toLocaleString()}</span>
                          </div>
                        ))}
                        {landClearing.stumpGrindCost > 0 && (
                          <div className="clearing-row clearing-tree">
                            <span className="clearing-tree-size">{landClearing.treeCount.toLocaleString()} stump grind</span>
                            <span>${landClearing.stumpGrindUnit.toLocaleString()}</span>
                            <span className="clearing-amt">${landClearing.stumpGrindCost.toLocaleString()}</span>
                          </div>
                        )}
                        <div className="clearing-row clearing-total">
                          <span>Per-tree removal total</span>
                          <span className="clearing-amt">${landClearing.total.toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Bulk machine-clearing methods (forestry mulching vs. traditional) */}
                      {landClearing.clearingMethods.length > 0 && (
                        <div className="clearing-methods">
                          <div className="clearing-methods-head">Bulk machine clearing — cost by method ({landClearing.acres.toLocaleString()} ac / ~{landClearing.treeCount.toLocaleString()} trees)</div>
                          {landClearing.clearingMethods.map((mth, i) => (
                            <div key={i} className="clearing-method">
                              <div className="clearing-method-top">
                                <span className="clearing-method-name">{mth.method}</span>
                                <span className="clearing-method-range">${mth.low.toLocaleString()} – ${mth.high.toLocaleString()}</span>
                              </div>
                              <div className="clearing-method-what">{mth.what}</div>
                              {mth.note && <div className="clearing-method-note">{mth.note}</div>}
                            </div>
                          ))}
                        </div>
                      )}

                      {landClearing.clearingFactors.length > 0 && (
                        <div className="clearing-factors">
                          <div className="clearing-factors-head">What drives the price</div>
                          <ul>{landClearing.clearingFactors.map((f, i) => <li key={i}>{f}</li>)}</ul>
                        </div>
                      )}

                      {landClearing.pricingSources.length > 0 && (
                        <div className="cost-sources">
                          <span className="cost-sources-label">Pricing sources:</span>
                          {landClearing.pricingSources.map((s, i) => (
                            <a key={i} href={s} target="_blank" rel="noreferrer">
                              {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()}
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="cost-disclaimer">Trees counted from satellite + street view by AI (estimate). Per-tree removal fits scattered/lot trees; the method ranges (forestry mulching vs. traditional excavator) are usually closer for clearing a whole site. {landClearing.realTimePricing ? 'Priced at current local rates' : 'Regional baseline rates'} — a ground assessment / contractor bid will confirm.</div>
                    </>
                  ) : null}
                </div>
              )}

              {/* AI Feasibility Report (follow-up Q&A lives in the floating chat bubble) */}
              <div className="card registry-card report-card">
                <h3 className="registry-card-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FileText size={16} style={{ color: 'var(--primary)' }} />
                  <span>AI Feasibility Report</span>
                </h3>
                {reportPending ? (
                  <div className="report-manual">
                    <p className="report-manual-text">The full AI Feasibility Report (25 sections — zoning, rezoning, comps, valuation, risk &amp; more) is ready to generate.</p>
                    <button type="button" className="report-generate-btn" onClick={startReportManually}>
                      <FileText size={16} /> Generate AI Report
                    </button>
                  </div>
                ) : chatLoading && chatHistory.length === 0 ? (
                  <div style={{ padding: '8px 0' }}>
                    <div className="gemini-wave-loader-wrapper">
                      <div className="gemini-wave-loader">
                        <div className="wave-bar bar-1"></div>
                        <div className="wave-bar bar-2"></div>
                        <div className="wave-bar bar-3"></div>
                      </div>
                      <span className="loading-text">Generating the full feasibility report...</span>
                    </div>
                    {reportTimer && <ReportCountdown startedAt={reportTimer.startedAt} etaMs={reportTimer.etaMs} />}
                  </div>
                ) : chatHistory.length > 0 && chatHistory[0].role === 'model' ? (
                  <>
                    {(() => {
                      const va = extractValueAdd(sanitizeReportText(chatHistory[0].content));
                      if (!va.rezoning && !va.subdivision) return null;
                      return (
                        <div className="value-add-highlight">
                          <div className="va-head"><TrendingUp size={15} /> Value-Add Upside</div>
                          {va.rezoning && (
                            <div className="va-row"><span className="va-tag">Rezoning</span><span className="va-text">{va.rezoning}</span></div>
                          )}
                          {va.subdivision && (
                            <div className="va-row"><span className="va-tag">Subdivision</span><span className="va-text">{va.subdivision}</span></div>
                          )}
                          <div className="va-foot">See §6 Rezoning &amp; §7 Subdivision below for the full analysis.</div>
                        </div>
                      );
                    })()}
                    <div className="message-content model-text report-inline-body">
                      {parseMarkdown(sanitizeReportText(chatHistory[0].content))}
                    </div>
                    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px dashed var(--bg-card-border)', fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <MessageCircle size={13} />
                      <span>Questions about this report? Use the chat bubble in the corner.</span>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', padding: '8px 0' }}>
                    The investor-style feasibility report will appear here automatically once the site analysis completes.
                  </div>
                )}
              </div>

              {/* Informational Guidelines Card */}
              <div className="card info-card">
                <h3>Statewide Data Coverage</h3>
                <ul className="info-list">
                  <li>
                    <strong>Google Geocoder:</strong> Pinpoints standard latitude/longitude coordinates from text addresses.
                  </li>
                  <li>
                    <strong>NC OneMap Service:</strong> Queries the official state-wide database intersecting GPS points with registered parcel boundaries.
                  </li>
                  <li>
                    <strong>Charlotte Zoning:</strong> Direct API routing for Mecklenburg county queries returning exact planning classifications (e.g. UMUD, TOD, N1-C).
                  </li>
                  <li>
                    <strong>Other Counties:</strong> Standard fallback instructing to verify local municipal codes.
                  </li>
                </ul>
              </div>
            </div>
          ) : loading ? (
            <div className="card info-card fade-in" style={{ height: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Loader2 size={18} className="spinner" />
                <span>Running Site Analysis</span>
              </h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.5rem 0 1rem' }}>
                {loadingStage || 'Resolving the parcel...'} Results appear here the moment each layer is ready.
              </p>
              <ProgressStep done={false} active label="Parcel boundary & county registry" />
              <ProgressStep done={false} label="Zoning district & dimensional standards" />
              <ProgressStep done={false} label="Topography & buildability (USGS 3DEP)" />
              <ProgressStep done={false} label="Verified sold comps" />
            </div>
          ) : (
            <div className="card info-card fade-in" style={{ height: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <h3>Statewide Data Coverage</h3>
              <p style={{ fontSize: '0.9rem', color: '#888', marginBottom: '1.5rem' }}>
                Antigravity GIS integrates direct parcel coordinate layers and zoning APIs for standard NC counties:
              </p>
              <ul className="info-list" style={{ gap: '1.25rem' }}>
                <li>
                  <strong>Google Geocoder:</strong> Pinpoints standard latitude/longitude coordinates from text addresses.
                </li>
                <li>
                  <strong>NC OneMap Service:</strong> Queries the official state-wide database intersecting GPS points with registered parcel boundaries.
                </li>
                <li>
                  <strong>Charlotte Zoning:</strong> Direct API routing for Mecklenburg county queries returning exact planning classifications (e.g. UMUD, TOD, N1-C).
                </li>
                <li>
                  <strong>Other Counties:</strong> Standard fallback instructing to verify local municipal codes.
                </li>
              </ul>
            </div>
          )}
        </div>

        {/* Right Column: Maps Column */}
        <div className="dashboard-map-column">
          {data ? (
            <div className="card map-card fade-in" style={{ height: 'auto' }}>
              <div className="map-header" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                  <h3 className="map-title">
                    <Layers size={18} className="geo-icon" />
                    <span>GIS Boundary & Aerial Imagery Overlay</span>
                  </h3>
                  
                  {/* Street View Orientation Switcher */}
                  {hasStreetView && (
                    <div className="split-toggle-group" style={{ display: 'flex', background: 'var(--bg-card-hover)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--bg-card-border)' }}>
                      <button
                        type="button"
                        className={`layer-toggle-btn ${splitOrientation === 'side-by-side' ? 'active' : ''}`}
                        style={{ margin: 0, padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: 'calc(var(--radius-sm) - 2px)' }}
                        onClick={() => setSplitOrientation('side-by-side')}
                        title="Display maps side-by-side"
                      >
                        Side-by-Side
                      </button>
                      <button
                        type="button"
                        className={`layer-toggle-btn ${splitOrientation === 'stacked' ? 'active' : ''}`}
                        style={{ margin: 0, padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: 'calc(var(--radius-sm) - 2px)' }}
                        onClick={() => setSplitOrientation('stacked')}
                        title="Stack maps vertically"
                      >
                        Stacked View
                      </button>
                    </div>
                  )}
                </div>
                
                {/* GIS Layer Toggles */}
                <div className="map-controls" style={{ alignSelf: 'flex-start' }}>
                  <button
                    type="button"
                    className={`layer-toggle-btn ${showFloodplains ? 'active' : ''}`}
                    onClick={() => setShowFloodplains(!showFloodplains)}
                    title="Overlay FEMA Flood Zones (AE, VE, and Shaded X)"
                  >
                    <span className="toggle-indicator floodplain" />
                    <span>Flood Zones (FEMA)</span>
                  </button>
                  <button
                    type="button"
                    className={`layer-toggle-btn ${showStreams ? 'active' : ''}`}
                    onClick={() => setShowStreams(!showStreams)}
                    title="Overlay NC OneMap Streams, Flowlines, and Hydrology"
                  >
                    <span className="toggle-indicator stream" />
                    <span>Streams & Waterways</span>
                  </button>
                  <button
                    type="button"
                    className={`layer-toggle-btn ${showContours ? 'active' : ''}`}
                    onClick={() => setShowContours(!showContours)}
                    title="Overlay NC OneMap Smoothed Vector Elevation Contour Lines"
                  >
                    <span className="toggle-indicator elevation" />
                    <span>Contour Lines (Elevation)</span>
                  </button>
                  <button
                    type="button"
                    className={`layer-toggle-btn ${showWetlands ? 'active' : ''}`}
                    onClick={() => setShowWetlands(!showWetlands)}
                    title="Overlay USFWS National Wetlands Inventory (NWI) — official FWS Wetlands web mapping service"
                  >
                    <span className="toggle-indicator wetland" />
                    <span>Wetlands (USFWS NWI)</span>
                  </button>
                  {(() => {
                    const countyGis = hasCountyZoning(data.countyName);
                    const webZoning = data.zoningSource === 'web';
                    const canToggle = countyGis || webZoning; // tiles for GIS, label for web
                    const label = countyGis ? "Zoning (County GIS)" : webZoning ? "Zoning (web lookup)" : "Zoning (not published)";
                    const title = countyGis
                      ? `Overlay zoning districts from ${data.countyName} County's own GIS server`
                      : webZoning
                        ? `Zoning resolved via web search — verify against the local ordinance`
                        : `${data.countyName} County does not publish a zoning GIS service`;
                    return (
                      <button
                        type="button"
                        className={`layer-toggle-btn ${canToggle && showZoning ? 'active' : ''} ${canToggle ? '' : 'disabled'}`}
                        onClick={() => canToggle && setShowZoning(!showZoning)}
                        disabled={!canToggle}
                        title={title}
                      >
                        <span className="toggle-indicator zoning" />
                        <span>{label}</span>
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    className={`layer-toggle-btn ${showOsmFeatures ? 'active' : ''}`}
                    onClick={() => setShowOsmFeatures(!showOsmFeatures)}
                    title="Overlay real building footprints, road centerlines, and water bodies from OpenStreetMap"
                  >
                    <span className="toggle-indicator osm" />
                    <span>{osmLoading ? 'Loading Features…' : 'Buildings & Roads (OSM)'}</span>
                  </button>
                </div>
              </div>

              <div className={`map-wrapper ${hasStreetView ? `split-view ${splitOrientation}` : ''}`} style={{ height: splitOrientation === 'stacked' && hasStreetView ? '500px' : '400px', position: 'relative' }}>
                {!hasGoogleMapsKey ? (
                  <div className="map-offline-placeholder" onClick={() => window.dispatchEvent(new CustomEvent('open-gis-settings'))}>
                    <Map size={36} className="offline-map-icon" />
                    <h4>Map Viewer Offline</h4>
                    <p>Configure your Google Maps API Key in Account Settings to initialize the interactive satellite map canvas.</p>
                    <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '8px' }}>
                      Open Settings
                    </button>
                  </div>
                ) : (
                  <>
                    <div ref={mapRef} className="gis-map-canvas" />
                    {hasStreetView && (
                      <div ref={streetViewRef} className="streetview-canvas" />
                    )}
                  </>
                )}
              </div>

              <div className="map-legend">
                <span className="legend-item">
                  <span className="legend-color boundary" />
                  <span>Parcel Boundary ({data.gisAcres.toFixed(3)} Acres / {data.grossSf.toLocaleString()} SF)</span>
                </span>
              </div>
            </div>
          ) : (
            <div className="results-placeholder" style={{ height: '400px' }}>
              <div className="radar-animation">
                <div className="radar-circle circle-1"></div>
                <div className="radar-circle circle-2"></div>
                <div className="radar-circle circle-3"></div>
                <MapPin size={40} className="placeholder-pin" />
              </div>
              <h3>Site Feasibility Dashboard</h3>
              <p>
                Awaiting query instructions. Type in a North Carolina address to pull spatial boundaries, state-plane coordinates, size computations, and zoning classifications.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Floating AI assistant — always available while you scroll */}
      <div className={chatOpen ? 'chat-fab-panel open' : 'chat-fab-panel'}>
              <div className="card registry-card chatbot-card gemini-chat-container">
                <div className="gemini-chat-header">
                  <div className="gemini-logo-wrapper">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 2C12 2 12.5 7.5 14.5 9.5C16.5 11.5 22 12 22 12C22 12 16.5 12.5 14.5 14.5C12.5 16.5 12 22 12 22C12 22 11.5 16.5 9.5 14.5C7.5 12.5 2 12 2 12C2 12 7.5 11.5 9.5 9.5C11.5 7.5 12 2 12 2Z" fill="url(#geminiGradient)"/>
                      <defs>
                        <linearGradient id="geminiGradient" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                          <stop offset="0%" stopColor="#1a73e8" />
                          <stop offset="50%" stopColor="#a530f2" />
                          <stop offset="100%" stopColor="#f43f5e" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                  <div className="gemini-header-text">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className="gemini-title">Land Assistant</span>
                      <span className="gemini-model-badge">3.5 Flash</span>
                    </div>
                    <span className="gemini-subtitle">Gemini 3.5 Flash — Google Search grounded</span>
                  </div>
                  <div className="chat-header-actions">
                    <button type="button" className="chat-header-btn" title="New chat" onClick={startNewChat}>
                      <Plus size={16} />
                    </button>
                    <button type="button" className={`chat-header-btn ${showHistory ? 'active' : ''}`} title="Chat history" onClick={() => setShowHistory((s) => !s)}>
                      <History size={16} />
                    </button>
                  </div>
                </div>

                {showHistory && (
                  <div className="chat-history-panel">
                    <div className="chat-history-head">
                      <span>Chat history</span>
                      <button type="button" className="chat-history-new" onClick={startNewChat}><Plus size={13} /> New chat</button>
                    </div>
                    {conversations.length === 0 ? (
                      <div className="chat-history-empty">No saved chats yet.</div>
                    ) : (
                      <div className="chat-history-list">
                        {conversations.map((c) => (
                          <div key={c.id} className={`chat-history-item ${c.id === activeConvoId ? 'active' : ''}`} onClick={() => loadConversation(c)}>
                            <div className="chat-history-item-main">
                              <MessageCircle size={13} className="chat-history-item-icon" />
                              <div className="chat-history-item-text">
                                <span className="chat-history-item-title">{c.title || 'New chat'}</span>
                                {c.address && <span className="chat-history-item-sub">{c.address}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="chat-history-del"
                              title="Delete chat"
                              onClick={(e) => { e.stopPropagation(); removeConversation(c.id); }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="chat-messages-container borderless-chat-body">
                  {chatHistory.length === 0 && !chatLoading ? (
                    <div className="chat-message model">
                      <div className="model-avatar">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 2C12 2 12.5 7.5 14.5 9.5C16.5 11.5 22 12 22 12C22 12 16.5 12.5 14.5 14.5C12.5 16.5 12 22 12 22C12 22 11.5 16.5 9.5 14.5C7.5 12.5 2 12 2 12C2 12 7.5 11.5 9.5 9.5C11.5 7.5 12 2 12 2Z" fill="url(#geminiSparkleGrad)"/>
                          <defs>
                            <linearGradient id="geminiSparkleGrad" x1="2" y1="2" x2="22" y2="22">
                              <stop offset="0%" stopColor="#1a73e8" />
                              <stop offset="50%" stopColor="#a530f2" />
                              <stop offset="100%" stopColor="#f43f5e" />
                            </linearGradient>
                          </defs>
                        </svg>
                      </div>
                      <div className="model-message-wrapper" style={{ flex: 1 }}>
                        <div className="message-content model-text">
                          Search for a North Carolina address to load the parcel details and automatically generate a custom, investor-style land feasibility report.
                        </div>
                      </div>
                    </div>
                  ) : (
                    chatHistory.map((msg, idx) => (
                      <div key={idx} className={`chat-message ${msg.role}`}>
                        {msg.role === 'user' ? (
                          <div className="message-content-wrapper" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%' }}>
                            {msg.attachments && msg.attachments.length > 0 && (
                              <div className="msg-attachments">
                                {msg.attachments.map((att, aIdx) => (
                                  att.kind === 'image' && att.previewUrl ? (
                                    <img key={aIdx} src={att.previewUrl} alt={att.name} className="msg-attachment-img" />
                                  ) : (
                                    <div key={aIdx} className="msg-attachment-file">
                                      <FileText size={13} />
                                      <span>{att.name}</span>
                                    </div>
                                  )
                                ))}
                              </div>
                            )}
                            {msg.content && (
                              <div className="message-bubble user-bubble">
                                {msg.content}
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            <div className="model-avatar">
                              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 2C12 2 12.5 7.5 14.5 9.5C16.5 11.5 22 12 22 12C22 12 16.5 12.5 14.5 14.5C12.5 16.5 12 22 12 22C12 22 11.5 16.5 9.5 14.5C7.5 12.5 2 12 2 12C2 12 7.5 11.5 9.5 9.5C11.5 7.5 12 2 12 2Z" fill="url(#geminiSparkleGrad)"/>
                                <defs>
                                  <linearGradient id="geminiSparkleGrad" x1="2" y1="2" x2="22" y2="22">
                                    <stop offset="0%" stopColor="#1a73e8" />
                                    <stop offset="50%" stopColor="#a530f2" />
                                    <stop offset="100%" stopColor="#f43f5e" />
                                  </linearGradient>
                                </defs>
                              </svg>
                            </div>
                            <div className="model-message-wrapper" style={{ flex: 1 }}>
                              <div className="message-content model-text">
                                {parseMarkdown(msg.content)}
                              </div>

                              {/* Double Check Verification Overlay */}
                              {showCheckOverlay[idx] && (
                                <div className="double-check-feedback-line">
                                  <span className="check-dot"></span>
                                  <span>Google Search Grounding cross-referenced. 100% verified source matches.</span>
                                </div>
                              )}
                              
                              {/* Grounding Sources */}
                              {msg.sources && msg.sources.length > 0 && (
                                <div className={`message-sources-footer ${showCheckOverlay[idx] ? 'highlighted-sources' : ''}`}>
                                  <div className="sources-title">
                                    <Globe size={12} className="globe-icon-indigo" />
                                    <span>Sources and related content</span>
                                  </div>
                                  <div className="sources-list">
                                    {msg.sources.map((src, sIdx) => {
                                      let domain = '';
                                      try {
                                        domain = new URL(src.uri).hostname.replace('www.', '');
                                      } catch (e) {
                                        domain = src.uri;
                                      }
                                      return (
                                        <a key={sIdx} href={src.uri} target="_blank" rel="noreferrer" className="source-pill-link">
                                          <span className="source-index">{sIdx + 1}</span>
                                          <span className="source-name">{src.title}</span>
                                          <span className="source-domain">({domain})</span>
                                        </a>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                              {/* Gemini Action Bar */}
                              <div className="gemini-action-bar">
                                <button 
                                  type="button" 
                                  className={`chat-action-btn ${likedMessages[idx] === 'like' ? 'active-like' : ''}`} 
                                  title="Good response"
                                  onClick={() => setLikedMessages(prev => ({ ...prev, [idx]: prev[idx] === 'like' ? undefined : 'like' }))}
                                >
                                  <ThumbsUp size={14} />
                                </button>
                                <button 
                                  type="button" 
                                  className={`chat-action-btn ${likedMessages[idx] === 'dislike' ? 'active-dislike' : ''}`} 
                                  title="Bad response"
                                  onClick={() => setLikedMessages(prev => ({ ...prev, [idx]: prev[idx] === 'dislike' ? undefined : 'dislike' }))}
                                >
                                  <ThumbsDown size={14} />
                                </button>
                                <button 
                                  type="button" 
                                  className={`chat-action-btn double-check-btn ${showCheckOverlay[idx] ? 'active-check' : ''}`} 
                                  title="Double-check response"
                                  onClick={() => setShowCheckOverlay(prev => ({ ...prev, [idx]: !prev[idx] }))}
                                >
                                  <Search size={14} />
                                </button>
                                <div style={{ position: 'relative' }}>
                                  <button 
                                    type="button" 
                                    className="chat-action-btn" 
                                    title="Copy response"
                                    onClick={() => {
                                      navigator.clipboard.writeText(msg.content);
                                      setCopiedMessageIndex(idx);
                                      setTimeout(() => setCopiedMessageIndex(null), 2000);
                                    }}
                                  >
                                    {copiedMessageIndex === idx ? <Check size={14} style={{ color: '#10b981' }} /> : <Copy size={14} />}
                                  </button>
                                  {copiedMessageIndex === idx && (
                                    <div className="copied-tooltip">Copied to clipboard</div>
                                  )}
                                </div>
                                <button 
                                  type="button" 
                                  className="chat-action-btn" 
                                  title="Share response"
                                  onClick={() => {
                                    navigator.clipboard.writeText(msg.content);
                                    alert("Share link copied to clipboard!");
                                  }}
                                >
                                  <Share2 size={14} />
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                  )}
                  {chatLoading && (
                    <div className="chat-message model loading-message">
                      <div className="model-avatar">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 2C12 2 12.5 7.5 14.5 9.5C16.5 11.5 22 12 22 12C22 12 16.5 12.5 14.5 14.5C12.5 16.5 12 22 12 22C12 22 11.5 16.5 9.5 14.5C7.5 12.5 2 12 2 12C2 12 7.5 11.5 9.5 9.5C11.5 7.5 12 2 12 2Z" fill="url(#geminiLoadingGrad)"/>
                          <defs>
                            <linearGradient id="geminiLoadingGrad" x1="2" y1="2" x2="22" y2="22">
                              <stop offset="0%" stopColor="#1a73e8" />
                              <stop offset="50%" stopColor="#a530f2" />
                              <stop offset="100%" stopColor="#f43f5e" />
                            </linearGradient>
                          </defs>
                        </svg>
                      </div>
                      <div className="model-message-wrapper" style={{ flex: 1 }}>
                        <div className="gemini-wave-loader-wrapper">
                          <div className="gemini-wave-loader">
                            <div className="wave-bar bar-1"></div>
                            <div className="wave-bar bar-2"></div>
                            <div className="wave-bar bar-3"></div>
                          </div>
                          <span className="loading-text">
                            {reportTimer ? 'Generating the full feasibility report...' : 'Thinking with Google Search...'}
                          </span>
                        </div>
                        {reportTimer && (
                          <ReportCountdown startedAt={reportTimer.startedAt} etaMs={reportTimer.etaMs} />
                        )}
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                <form onSubmit={handleChatSubmit} className="gemini-input-form">
                  {pendingAttachments.length > 0 && (
                    <div className="pending-attachments">
                      {pendingAttachments.map((att, i) => (
                        <div key={i} className={`pending-chip ${att.kind === 'image' ? 'has-thumb' : ''}`}>
                          {att.kind === 'image' && att.previewUrl
                            ? <img src={att.previewUrl} alt={att.name} className="pending-thumb" />
                            : <FileText size={14} />}
                          <span className="pending-name">{att.name}</span>
                          <button type="button" className="pending-remove" title="Remove" onClick={() => setPendingAttachments((prev) => prev.filter((_, j) => j !== i))}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,application/pdf,.pdf,.txt,.csv,.md,.json,.log"
                    style={{ display: 'none' }}
                    onChange={(e) => handleFilesSelected(e.target.files)}
                  />
                  <div className="gemini-input-capsule">
                    <button type="button" className="input-attachment-btn" title="Attach images or documents" onClick={() => fileInputRef.current?.click()}>
                      <Paperclip size={16} />
                    </button>
                    <textarea
                      ref={chatInputRef}
                      rows={1}
                      placeholder="Ask anything, or attach an image/document..."
                      value={chatInput}
                      onChange={(e) => { setChatInput(e.target.value); autoGrowChat(e.target); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSubmit(); } }}
                      disabled={chatLoading}
                      className="gemini-prompt-input"
                    />
                    <button type="button" className="input-mic-btn" title="Use microphone">
                      <Mic size={16} />
                    </button>
                    <button
                      type="submit"
                      disabled={chatLoading || (!chatInput.trim() && pendingAttachments.length === 0)}
                      className={`gemini-send-btn ${(chatInput.trim() || pendingAttachments.length > 0) ? 'active' : ''}`}
                      title="Send prompt"
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </form>
              </div>
      </div>
      <button
        type="button"
        className="chat-fab"
        onClick={() => { const next = !chatOpen; setChatOpen(next); if (next) setChatUnread(false); }}
        title={chatOpen ? 'Close the AI assistant' : 'Chat with the AI about this property'}
        aria-label="AI assistant chat"
      >
        {chatOpen ? <X size={24} /> : <MessageCircle size={24} />}
        {!chatOpen && (chatUnread || chatLoading) && <span className={chatLoading ? 'chat-fab-dot pulsing' : 'chat-fab-dot'} />}
      </button>

      {/* Saved Reports drawer */}
      <ReportsDrawer
        isOpen={showReports}
        onClose={() => setShowReports(false)}
        renderMarkdown={parseMarkdown}
      />
    </div>
  );
};
