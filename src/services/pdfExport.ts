// ONE-CLICK PDF EXPORT (jsPDF + html2canvas)
//
// Used by BOTH the AI Feasibility Report and the Buyer Presentation. The report
// markdown is rendered into an off-screen, print-styled sheet, captured with
// html2canvas, then sliced across A4 pages by jsPDF and saved — no print dialog,
// no browser chrome, no popup blocker.
//
// jsPDF + html2canvas together are ~600KB, so they are DYNAMICALLY imported: the
// cost is paid only when someone actually exports, keeping the main bundle
// (already ~1.1MB) unchanged for everyone else.

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MARGIN_PT = 32;

/** Google's imagery has no CORS headers, which would taint the canvas and make
 *  html2canvas throw. Routing through our own function makes it same-origin. */
export function proxiedImageUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/(^|\.)googleapis\.com$|(^|\.)gstatic\.com$/.test(parsed.hostname)) return url;
    return `/.netlify/functions/img-proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

/** Inline every image as a data URL so the capture cannot be blocked by CORS or
 *  a slow network. Images that can't be fetched are dropped, never left broken. */
async function inlineImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (img) => {
    try {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return;
      const res = await fetch(proxiedImageUrl(src), { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(blob);
      });
      img.setAttribute('src', dataUrl);
      img.removeAttribute('crossorigin');
    } catch {
      // An image we cannot inline is removed so it can't render as a broken icon.
      img.closest('figure')?.remove();
      img.remove();
    }
  }));
}

/** Print-friendly stylesheet for the off-screen sheet (light, readable, paged). */
const SHEET_CSS = `
  .pdf-sheet { width: 794px; padding: 40px 44px; background: #ffffff; color: #0f172a;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.55; }
  .pdf-sheet h1 { font-size: 22px; margin: 0 0 6px; }
  .pdf-sheet h2 { font-size: 16px; margin: 20px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; }
  .pdf-sheet h3 { font-size: 14px; margin: 14px 0 6px; }
  .pdf-sheet p, .pdf-sheet li { font-size: 13px; }
  .pdf-sheet table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11.5px; }
  .pdf-sheet th, .pdf-sheet td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
  .pdf-sheet th { background: #f1f5f9; }
  .pdf-sheet ul, .pdf-sheet ol { padding-left: 20px; margin: 8px 0; }
  .pdf-sheet .pdf-head { border-bottom: 2px solid #4f46e5; padding-bottom: 10px; margin-bottom: 16px; }
  .pdf-sheet .pdf-addr { color: #475569; font-size: 13px; }
  .pdf-sheet .pdf-price { display: inline-block; font-weight: 700; background: #ecfdf5; color: #065f46;
    border: 1px solid #a7f3d0; padding: 5px 11px; border-radius: 7px; margin-top: 8px; }
  .pdf-sheet .pdf-imgs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0 18px; }
  .pdf-sheet .pdf-imgs figure { margin: 0; }
  .pdf-sheet .pdf-imgs img { width: 100%; height: auto; border-radius: 6px; border: 1px solid #e2e8f0; display: block; }
  .pdf-sheet .pdf-imgs figcaption { font-size: 10px; color: #64748b; margin-top: 3px; }
  .pdf-sheet .pdf-foot { margin-top: 26px; padding-top: 12px; border-top: 1px solid #e2e8f0;
    font-size: 10px; color: #94a3b8; }
  .pdf-sheet .pdf-attach { margin: 0 0 16px; }
  .pdf-sheet .pdf-attach img { width: 100%; height: auto; display: block; margin-bottom: 6px;
    border: 1px solid #e2e8f0; border-radius: 4px; }
  .pdf-sheet .pdf-attach figcaption { font-size: 10px; color: #64748b; }
`;

export interface PdfExportAttachment {
  name: string;
  caption: string;
  kind: 'image' | 'pdf';
  /** One entry for an image; one per page for a rasterised PDF. */
  pages: string[];
}

export interface PdfExportOptions {
  title: string;
  address: string;
  /** Rendered report body (already-parsed DOM node). */
  bodyNode: Node;
  imageUrls?: { url: string; caption: string }[];
  /** User-added images and PDF pages, appended after the report body. */
  attachments?: PdfExportAttachment[];
  priceLabel?: string;
  footer?: string;
  fileName: string;
}

/**
 * Build the sheet, capture it, and save a real multi-page PDF.
 * Throws with a readable message so the caller can surface a failure.
 */
export async function downloadReportPdf(options: PdfExportOptions): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const host = document.createElement('div');
  // Rendered off-screen (not display:none — that would collapse layout and
  // html2canvas would capture nothing).
  host.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1;';
  const style = document.createElement('style');
  style.textContent = SHEET_CSS;
  host.appendChild(style);

  const sheet = document.createElement('div');
  sheet.className = 'pdf-sheet';

  const head = document.createElement('div');
  head.className = 'pdf-head';
  const h1 = document.createElement('h1');
  h1.textContent = options.title;
  const addr = document.createElement('div');
  addr.className = 'pdf-addr';
  addr.textContent = options.address;
  head.appendChild(h1);
  head.appendChild(addr);
  if (options.priceLabel) {
    const price = document.createElement('div');
    price.className = 'pdf-price';
    price.textContent = options.priceLabel;
    head.appendChild(price);
  }
  sheet.appendChild(head);

  if (options.imageUrls?.length) {
    const grid = document.createElement('div');
    grid.className = 'pdf-imgs';
    for (const image of options.imageUrls) {
      if (!image.url) continue;
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = image.url;
      const caption = document.createElement('figcaption');
      caption.textContent = image.caption;
      figure.appendChild(img);
      figure.appendChild(caption);
      grid.appendChild(figure);
    }
    if (grid.childElementCount) sheet.appendChild(grid);
  }

  const body = document.createElement('div');
  body.appendChild(options.bodyNode);
  sheet.appendChild(body);

  // Attachments follow the report. They are already data URLs (PDF pages were
  // rasterised on upload), so no extra fetching is needed and the capture cannot
  // be tainted by them.
  if (options.attachments?.length) {
    const heading = document.createElement('h2');
    heading.textContent = 'Attachments';
    sheet.appendChild(heading);
    for (const attachment of options.attachments) {
      const figure = document.createElement('figure');
      figure.className = 'pdf-attach';
      for (const page of attachment.pages) {
        const img = document.createElement('img');
        img.src = page;
        figure.appendChild(img);
      }
      const caption = document.createElement('figcaption');
      caption.textContent = attachment.kind === 'pdf' && attachment.pages.length > 1
        ? `${attachment.caption} (${attachment.pages.length} pages)`
        : attachment.caption;
      figure.appendChild(caption);
      sheet.appendChild(figure);
    }
  }

  if (options.footer) {
    const foot = document.createElement('div');
    foot.className = 'pdf-foot';
    foot.textContent = options.footer;
    sheet.appendChild(foot);
  }

  host.appendChild(sheet);
  document.body.appendChild(host);

  try {
    await inlineImages(sheet);
    // Let the inlined images lay out before capture.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const canvas = await html2canvas(sheet, {
      scale: 2,              // legible text in the PDF
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: sheet.scrollWidth,
    });

    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const usableWidth = A4_WIDTH_PT - MARGIN_PT * 2;
    const usableHeight = A4_HEIGHT_PT - MARGIN_PT * 2;
    // Canvas pixels per PDF point, so slices map to whole pages.
    const pxPerPt = canvas.width / usableWidth;
    const pageHeightPx = Math.floor(usableHeight * pxPerPt);
    const pageCount = Math.max(1, Math.ceil(canvas.height / pageHeightPx));

    for (let page = 0; page < pageCount; page++) {
      const sliceHeight = Math.min(pageHeightPx, canvas.height - page * pageHeightPx);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const ctx = slice.getContext('2d');
      if (!ctx) throw new Error('Canvas context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, page * pageHeightPx, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

      if (page > 0) pdf.addPage();
      pdf.addImage(
        slice.toDataURL('image/jpeg', 0.92),
        'JPEG',
        MARGIN_PT,
        MARGIN_PT,
        usableWidth,
        sliceHeight / pxPerPt,
        undefined,
        'FAST',
      );
    }

    pdf.save(options.fileName);
  } finally {
    host.remove();
  }
}

/** Safe, descriptive file name from an address. */
export function pdfFileName(prefix: string, address: string): string {
  const slug = String(address || 'property')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'property';
  return `${prefix}-${slug}.pdf`;
}
