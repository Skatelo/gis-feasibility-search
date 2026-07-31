// REPORT ATTACHMENTS
//
// Images and PDFs a user adds to a report. Both are normalised to IMAGE data
// URLs so a single rendering path covers the on-screen report, the saved copy
// and the exported PDF — PDF pages are rasterised with pdf.js rather than being
// embedded as documents, because jsPDF cannot merge an existing PDF and an
// <embed> would never appear in an html2canvas capture.
//
// Data URLs (not object URLs) are deliberate: object URLs die with the page, so
// a saved report would come back with broken images.

export type ReportAttachmentKind = 'image' | 'pdf';

export interface ReportAttachment {
  id: string;
  name: string;
  kind: ReportAttachmentKind;
  /** Rendered pages (one entry for an image, one per page for a PDF). */
  pages: string[];
  /** Caption shown under the attachment in the report. */
  caption: string;
}

/** Guard against a single huge upload blowing out memory or the saved payload. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 15;
const PDF_RENDER_SCALE = 1.6; // legible in both the report and the PDF export

export function isSupportedAttachment(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf';
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** Rasterise each page of a PDF into a JPEG data URL. */
async function pdfToPageImages(file: File): Promise<string[]> {
  const pdfjs: any = await import('pdfjs-dist');
  // Vite resolves the worker to a real URL; without it pdf.js falls back to a
  // main-thread path that is disabled in v4+ and throws.
  try {
    const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = (worker as any).default;
  } catch {
    /* bundler already provided a worker */
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) break;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pages.push(canvas.toDataURL('image/jpeg', 0.85));
  }

  try { await doc.destroy(); } catch { /* already released */ }
  if (!pages.length) throw new Error('No pages could be read from that PDF.');
  return pages;
}

const newId = () => `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Convert one uploaded file into a report attachment.
 * Throws with a readable reason so the UI can show it next to the upload button.
 */
export async function fileToReportAttachment(file: File): Promise<ReportAttachment> {
  if (!isSupportedAttachment(file)) {
    throw new Error(`${file.name}: only images and PDFs can be added.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than 20 MB.`);
  }

  if (file.type === 'application/pdf') {
    const pages = await pdfToPageImages(file);
    return { id: newId(), name: file.name, kind: 'pdf', pages, caption: file.name };
  }
  const dataUrl = await fileToDataUrl(file);
  return { id: newId(), name: file.name, kind: 'image', pages: [dataUrl], caption: file.name };
}

/** Markdown appendix describing the attachments, for the SAVED copy — the saved
 *  report is markdown text, so the images themselves live in the attachment
 *  records while this keeps a human-readable record of what was attached. */
export function attachmentsAppendix(attachments: ReportAttachment[]): string {
  if (!attachments.length) return '';
  const lines = attachments.map((attachment, index) => {
    const detail = attachment.kind === 'pdf'
      ? `PDF, ${attachment.pages.length} page${attachment.pages.length === 1 ? '' : 's'}`
      : 'Image';
    return `${index + 1}. ${attachment.caption} (${detail})`;
  });
  return `\n\n## Attachments\n\n${lines.join('\n')}\n`;
}
