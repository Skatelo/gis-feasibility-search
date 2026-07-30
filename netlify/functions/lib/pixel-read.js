// PIXEL-NATIVE PAGE READING — PixelRAG's core idea, Gemini-flavoured.
// Reference: https://github.com/StarTrail-org/PixelRAG
//
// PixelRAG's insight is that parsing HTML is the fragile part: render the page
// and READ THE PIXELS instead. Its own stack (Qwen3-VL embeddings → FAISS →
// FastAPI, on a CUDA GPU) cannot run in a Netlify function, so this implements
// the same idea with the pieces available here:
//
//     page → headless Chromium screenshot → Gemini 3.6 vision → markdown
//
// That covers precisely what the Cheerio scrape cannot: client-rendered pages,
// canvas/map viewers, scanned or image-only PDFs, and portals that return an
// HTML shell with no text. It is TIER 3 — the last resort — because rendering a
// browser is the slowest and most expensive step in the chain.
//
// Every failure path returns '' so the crawl degrades instead of breaking.

const GEMINI_VISION_MODEL = 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODEL = 'gemini-3-flash-preview';

/** Vision needs a Gemini key; the caller may pass one from the request. */
export function pixelReadConfigured(geminiKey = '') {
  return !!(String(geminiKey || '').trim() || String(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim());
}

function resolveGeminiKey(geminiKey = '') {
  return String(
    geminiKey
    || process.env.GEMINI_API_KEY
    || process.env.VITE_GEMINI_API_KEY
    || '',
  ).trim();
}

/**
 * Full-page screenshot via playwright-core + @sparticuz/chromium (the
 * serverless Chromium build already in this project's dependencies). Imports are
 * DYNAMIC so a missing/incompatible binary degrades to '' instead of crashing
 * the whole function at module load.
 */
export async function renderPageScreenshot(url, { timeoutMs = 20000, fullPage = true, maxHeight = 3000 } = {}) {
  let browser = null;
  try {
    const { chromium: playwright } = await import('playwright-core');

    // @sparticuz/chromium ships a LINUX binary (that's the Netlify runtime). On a
    // Windows/macOS dev machine it can't launch, so fall back to an installed
    // system browser — same screenshot path, so `netlify dev` works locally too.
    const launchAttempts = [];
    try {
      const { default: serverlessChromium } = await import('@sparticuz/chromium');
      const executablePath = await serverlessChromium.executablePath();
      if (executablePath) launchAttempts.push({ args: serverlessChromium.args, executablePath, headless: true });
    } catch { /* not available in this environment */ }
    launchAttempts.push({ headless: true, channel: 'chrome' });
    launchAttempts.push({ headless: true, channel: 'msedge' });

    for (const options of launchAttempts) {
      try {
        browser = await playwright.launch(options);
        break;
      } catch { /* try the next launcher */ }
    }
    if (!browser) return '';

    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    const page = await context.newPage();
    // 'domcontentloaded' + a settle delay beats 'networkidle', which frequently
    // never fires on map/analytics-heavy government viewers.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(2500);
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage,
      clip: fullPage ? undefined : { x: 0, y: 0, width: 1280, height: Math.min(1600, maxHeight) },
    });
    return buffer ? Buffer.from(buffer).toString('base64') : '';
  } catch {
    return '';
  } finally {
    try { if (browser) await browser.close(); } catch { /* already gone */ }
  }
}

/** Ask Gemini vision to transcribe a page screenshot into markdown. */
export async function readScreenshotWithGemini(base64Jpeg, { url = '', queries = [], geminiKey = '', timeoutMs = 45000 } = {}) {
  const key = resolveGeminiKey(geminiKey);
  if (!key || !base64Jpeg) return '';

  const focus = queries.filter(Boolean).slice(0, 6).join('; ');
  const prompt = [
    'You are reading a SCREENSHOT of a web page because its text could not be extracted from the HTML.',
    'Transcribe the page content into clean, faithful markdown.',
    'Rules: transcribe only what is VISIBLE in the image. Never infer, complete, or invent values.',
    'Preserve tables as markdown tables and keep every label/value pair together (owner names, parcel ids, acreage, values, dates, dimensions).',
    'Omit navigation chrome, cookie banners, ads and footers.',
    'If the page shows no substantive content (blank, error, login wall, or bot challenge), reply with exactly: NO_CONTENT',
    url ? `Page URL: ${url}` : '',
    focus ? `Pay particular attention to anything about: ${focus}` : '',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } },
      ],
    }],
    // Transcription is perception, not reasoning: thinking off keeps it fast and
    // stops reasoning tokens from consuming the output budget.
    generationConfig: { temperature: 0, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  });

  for (const model of [GEMINI_VISION_MODEL, GEMINI_FALLBACK_MODEL]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal },
      );
      if (!res.ok) continue; // try the fallback model
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      if (!text || /^NO_CONTENT\b/i.test(text)) return '';
      return text;
    } catch {
      // fall through to the next model
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

/** TIER 3: render the page and read the pixels. Returns markdown, or ''. */
export async function pixelReadUrl(url, { queries = [], geminiKey = '', renderTimeoutMs = 20000 } = {}) {
  if (!pixelReadConfigured(geminiKey)) return '';
  const shot = await renderPageScreenshot(url, { timeoutMs: renderTimeoutMs });
  if (!shot) return '';
  return readScreenshotWithGemini(shot, { url, queries, geminiKey });
}
