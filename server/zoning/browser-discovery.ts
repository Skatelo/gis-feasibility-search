import { existsSync } from 'node:fs';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { Configuration } from '@crawlee/core';
import chromiumBinary from '@sparticuz/chromium';
import { chromium as playwrightChromium, type Route } from 'playwright-core';
import { assertSafeUrl } from '../../src/services/zoning/utils/url-security';

const BLOCKED_PAGE = /captcha|turnstile|verify you are human|payment required|sign in to continue/i;

function localBrowserPath(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Maintenance-only JavaScript viewer inspection. It never solves access gates. */
export async function inspectDynamicViewer(url: string): Promise<string> {
  const safeUrl = await assertSafeUrl(url);
  const localBrowser = localBrowserPath();
  const executablePath = localBrowser ?? await chromiumBinary.executablePath();
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });
  let evidence = '';

  const crawler = new PlaywrightCrawler({
    minConcurrency: 1,
    maxConcurrency: 1,
    maxRequestRetries: 0,
    navigationTimeoutSecs: 10,
    requestHandlerTimeoutSecs: 20,
    useSessionPool: false,
    launchContext: {
      launcher: playwrightChromium,
      useIncognitoPages: true,
      launchOptions: {
        executablePath,
        args: localBrowser ? [] : chromiumBinary.args,
        headless: true,
      },
    },
    preNavigationHooks: [async ({ page }, gotoOptions) => {
      await page.route('**/*', async (route: Route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        if (['image', 'font', 'media'].includes(resourceType) || /google-analytics|googletagmanager|doubleclick|facebook\.net/i.test(request.url())) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      gotoOptions.waitUntil = 'domcontentloaded';
    }],
    async requestHandler({ page }) {
      const visibleText = String(await page.locator('body').innerText().catch(() => '')).slice(0, 30_000);
      const restrictedControls = await page.locator(
        'iframe[src*="captcha"]:visible, iframe[src*="turnstile"]:visible, input[type="password"]:visible',
      ).count();
      if (restrictedControls || BLOCKED_PAGE.test(visibleText)) throw new Error('Viewer requires restricted interaction');
      const resources = await page.evaluate(() => performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((entry) => /MapServer|FeatureServer|arcgis\/rest\/services/i.test(entry))
        .slice(0, 200));
      const html = String(await page.content()).slice(0, 200_000);
      evidence = `${html}\n${resources.join('\n')}`;
    },
  }, config);

  await crawler.run([safeUrl.href]);
  return evidence;
}
