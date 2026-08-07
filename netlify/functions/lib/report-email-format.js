// Converts the Markdown feasibility report into a styled HTML email document.
// Deliberately dependency-free: email clients strip <style> blocks, so every
// element carries inline styles, and the converter covers exactly the Markdown
// constructs the report generator emits (headings, bold/italic, lists, tables,
// blockquotes, links, hr, code spans/fences). Raw source HTML is escaped, so
// report content can never inject markup into the email.

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HEADING_STYLES = {
  1: 'font-size:22px;font-weight:700;color:#0f172a;margin:28px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:6px;',
  2: 'font-size:19px;font-weight:700;color:#0f172a;margin:24px 0 10px;',
  3: 'font-size:16px;font-weight:600;color:#1e293b;margin:20px 0 8px;',
  4: 'font-size:15px;font-weight:600;color:#1e293b;margin:16px 0 6px;',
  5: 'font-size:14px;font-weight:600;color:#334155;margin:14px 0 6px;',
  6: 'font-size:13px;font-weight:600;color:#334155;margin:12px 0 6px;',
};

const LINK_STYLE = 'color:#2563eb;text-decoration:underline;';
const CODE_STYLE = 'background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px;font-family:Courier New,monospace;font-size:13px;';
const CELL_STYLE = 'border:1px solid #cbd5e1;padding:6px 10px;';
const TH_STYLE = `${CELL_STYLE}background:#f1f5f9;text-align:left;font-weight:600;`;

/** Renders inline Markdown (bold, italic, code, links) inside already-escaped text. */
function renderInline(escaped) {
  let out = escaped;
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `<a href="$2" style="${LINK_STYLE}">$1</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code style="${CODE_STYLE}">${codeSpans[Number(index)]}</code>`);
  return out;
}

function isTableSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '');
}

function renderTable(tableLines) {
  const parseRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const rows = tableLines.map(parseRow);
  let header = null;
  let body = rows;
  if (rows.length >= 2 && isTableSeparatorRow(rows[1])) {
    header = rows[0];
    body = rows.slice(2);
  }
  let html = '<table role="presentation" style="border-collapse:collapse;margin:16px 0;width:100%;font-size:14px;">';
  if (header) {
    html += `<thead><tr>${header.map((cell) => `<th style="${TH_STYLE}">${renderInline(escapeHtml(cell))}</th>`).join('')}</tr></thead>`;
  }
  html += `<tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td style="${CELL_STYLE}">${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  html += '</table>';
  return html;
}

const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|\s*```)/;
const HR_LINE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** Converts a full Markdown document into an HTML fragment (inline-styled). */
export function markdownToEmailHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level} style="${HEADING_STYLES[level]}">${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_LINE.test(line)) {
      blocks.push('<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />');
      i += 1;
      continue;
    }

    // Fenced code block.
    if (/^\s*```/.test(line)) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i += 1; }
      i += 1; // closing fence
      blocks.push(`<pre style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:6px;overflow-x:auto;font-family:Courier New,monospace;font-size:13px;line-height:1.5;"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote style="margin:16px 0;padding:8px 16px;border-left:4px solid #cbd5e1;color:#475569;">${quoteLines
        .map((quoted) => `<p style="margin:0 0 8px;line-height:1.6;">${renderInline(escapeHtml(quoted))}</p>`)
        .join('')}</blockquote>`);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i].trim()); i += 1; }
      blocks.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag} style="margin:12px 0;padding-left:24px;">${items
        .map((item) => `<li style="margin:4px 0;line-height:1.6;">${renderInline(escapeHtml(item))}</li>`)
        .join('')}</${tag}>`);
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !HR_LINE.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p style="margin:0 0 12px;line-height:1.6;">${renderInline(escapeHtml(paragraph.join(' ')))}</p>`);
  }

  return blocks.join('\n');
}

/** Plain-text fallback for multipart/alternative clients: strips Markdown markers. */
export function markdownToEmailText(markdown) {
  return String(markdown || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/^\s*\|?\s*:?-{3,}[:|\s-]*$/gm, '')
    .trim();
}

/** Wraps the converted report in a full branded HTML email document. */
export function reportToEmailBody(markdown, { address, viewLinkHtml = '' } = {}) {
  const content = String(markdown || '').trim();
  const bodyHtml = content
    ? markdownToEmailHtml(content)
    : '<p style="margin:0 0 12px;line-height:1.6;">The report text is unavailable.</p>';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feasibility report</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">
<div style="background:#0f172a;color:#ffffff;padding:20px 24px;border-radius:8px 8px 0 0;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Feasibility Report</p>
<p style="margin:6px 0 0;font-size:20px;font-weight:700;">${escapeHtml(address || 'Your property')}</p>
</div>
<div style="background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b;">
${viewLinkHtml}
${bodyHtml}
</div>
</div>
</body>
</html>`;
}
