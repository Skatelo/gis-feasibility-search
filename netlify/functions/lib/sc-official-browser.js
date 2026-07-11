import { existsSync } from 'node:fs';

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Configuration } from '@crawlee/core';
import chromiumBinary from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

const MAX_TEXT = 60_000;
const CHALLENGE_TITLE_RE = /just a moment|attention required|checking your browser/i;
const REPORT_TEXT_RE = /Parcel (Number|ID)\s+/i;

function localChromePath() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [];
  return candidates.find((p) => existsSync(p)) || null;
}

export async function crawlOfficialParcelPage(url, { parcelId = '', address = '' } = {}) {
  let text = '';
  let loadedUrl = url;
  let blocked = false;
  const localChrome = localChromePath();
  const executablePath = localChrome || await chromiumBinary.executablePath();
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });

  const crawler = new PlaywrightCrawler({
    maxRequestRetries: 0,
    minConcurrency: 1,
    maxConcurrency: 1,
    navigationTimeoutSecs: 20,
    requestHandlerTimeoutSecs: 40,
    useSessionPool: false,
    // A realistic generated fingerprint keeps Cloudflare's passive JS challenge
    // settling on its own in this automated context; interactive checks
    // (CAPTCHA / Turnstile / logins) are still treated as blocked below — those
    // are never solved or bypassed.
    browserPoolOptions: {
      useFingerprints: true,
      fingerprintOptions: {
        fingerprintGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['windows'] },
      },
    },
    launchContext: {
      launcher: playwrightChromium,
      useIncognitoPages: true,
      launchOptions: {
        executablePath,
        // The @sparticuz flag set is tuned for the bundled Lambda binary; it
        // breaks desktop Chrome, so only pass it with that binary.
        args: localChrome ? [] : chromiumBinary.args,
        headless: true,
      },
    },
    preNavigationHooks: [async (_ctx, gotoOptions) => {
      gotoOptions.waitUntil = 'domcontentloaded';
    }],
    async requestHandler({ page, request }) {
      // Cloudflare's ordinary JavaScript challenge settles by itself in a real
      // browser context — poll for it to clear. We do not interact with
      // CAPTCHA, Turnstile, login, or payment controls.
      for (let i = 0; i < 8; i++) {
        const title = await page.title().catch(() => '');
        if (!CHALLENGE_TITLE_RE.test(title)) break;
        await page.waitForTimeout(1_500);
      }

      const body = await page.locator('body').innerText().catch(() => '');
      const hasRestrictedControl = await page.locator('iframe[src*="captcha"]:visible, iframe[src*="turnstile"]:visible, input[type="password"]:visible').count();
      const stuckOnChallenge = CHALLENGE_TITLE_RE.test(await page.title().catch(() => ''));
      if (hasRestrictedControl || stuckOnChallenge || /verify you are human|captcha|payment required|sign in to continue|performing security verification|security service to protect against malicious bots|verification is taking longer/i.test(body)) {
        blocked = true;
        return;
      }

      // Schneider portals interpose a one-time public-records disclaimer per
      // session; accepting it is required to view the county's public data.
      const agree = page.getByRole('button', { name: /^agree$/i });
      if (await agree.count() === 1) {
        await agree.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(400);
      }

      const readBody = async () => String(await page.locator('body').innerText().catch(() => ''));
      let currentText = await readBody();

      if (!REPORT_TEXT_RE.test(currentText)) {
        // Not on a record page (e.g. a constructed report URL fell back to the
        // app shell): run the portal's own search.
        const searchTab = page.getByRole('tab', { name: 'Search', exact: true });
        if (await searchTab.count() === 1) {
          await searchTab.click();
          await page.waitForTimeout(300);
        }

        // Exact accessible names first (verified against qPublic), then loose
        // matches for county-specific labels.
        const parcelInput = (await page.getByRole('combobox', { name: 'Search by Parcel Number', exact: true }).count())
          ? page.getByRole('combobox', { name: 'Search by Parcel Number', exact: true })
          : page.getByRole('combobox', { name: /parcel (number|id)/i }).first();
        const addressInput = (await page.getByRole('combobox', { name: 'Search by Location Address', exact: true }).count())
          ? page.getByRole('combobox', { name: 'Search by Location Address', exact: true })
          : page.getByRole('combobox', { name: /(location|property|site)?\s*address/i }).first();

        let usedInput = null;
        let searchButton = null;
        if (parcelId && await parcelInput.count()) {
          await parcelInput.fill(parcelId);
          usedInput = parcelInput;
          searchButton = page.getByRole('button', { name: 'Search by Parcel Number Search', exact: true });
        } else if (address && await addressInput.count()) {
          await addressInput.fill(address);
          usedInput = addressInput;
          searchButton = page.getByRole('button', { name: 'Search by Location Address Search', exact: true });
        }
        if (usedInput) {
          await page.waitForTimeout(350);
          if (searchButton && await searchButton.count() === 1) {
            await searchButton.click();
          } else {
            await usedInput.press('Enter');
          }
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(500);
          currentText = await readBody();
        }

        // A search can land on a results grid instead of the record page: open
        // the first result that links to a keyed record.
        if (!REPORT_TEXT_RE.test(currentText)) {
          const firstResult = page.locator('a[href*="KeyValue="]').first();
          if (await firstResult.count()) {
            await firstResult.click();
            await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(400);
            currentText = await readBody();
          }
        }
      }

      text = currentText.slice(0, MAX_TEXT);
      loadedUrl = page.url() || request.loadedUrl || request.url;
    },
    failedRequestHandler() { blocked = true; },
  }, config);

  await crawler.run([url]);
  return { text, loadedUrl, blocked };
}
