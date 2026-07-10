import { PlaywrightCrawler } from '@crawlee/playwright';
import { Configuration } from '@crawlee/core';
import chromiumBinary from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

const MAX_TEXT = 60_000;

export async function crawlOfficialParcelPage(url, { parcelId = '', address = '' } = {}) {
  let text = '';
  let loadedUrl = url;
  let blocked = false;
  const executablePath = process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : await chromiumBinary.executablePath();
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });

  const crawler = new PlaywrightCrawler({
    maxRequestRetries: 0,
    minConcurrency: 1,
    maxConcurrency: 1,
    navigationTimeoutSecs: 15,
    requestHandlerTimeoutSecs: 20,
    useSessionPool: false,
    launchContext: {
      launcher: playwrightChromium,
      useIncognitoPages: true,
      launchOptions: {
        executablePath,
        args: chromiumBinary.args,
        headless: true,
      },
    },
    preNavigationHooks: [async ({ page }, gotoOptions) => {
      gotoOptions.waitUntil = 'domcontentloaded';
      await page.setExtraHTTPHeaders({
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      });
    }],
    async requestHandler({ page, request }) {
      // Cloudflare's ordinary JavaScript challenge can settle on its own. We do
      // not interact with CAPTCHA, Turnstile, login, or payment controls.
      for (let i = 0; i < 4; i++) {
        const title = await page.title();
        if (!/just a moment|attention required/i.test(title)) break;
        await page.waitForTimeout(1_250);
      }

      const body = await page.locator('body').innerText().catch(() => '');
      const hasRestrictedControl = await page.locator('iframe[src*="captcha"]:visible, iframe[src*="turnstile"]:visible, input[type="password"]:visible').count();
      if (hasRestrictedControl || /verify you are human|captcha|payment required|sign in to continue|performing security verification|security service to protect against malicious bots|verification is taking longer/i.test(body)) {
        blocked = true;
        return;
      }

      const agree = page.getByRole('button', { name: 'Agree', exact: true });
      if (await agree.count() === 1) {
        await agree.click();
        await page.waitForTimeout(250);
      }

      let currentText = String(await page.locator('body').innerText().catch(() => body));
      if (!/Parcel Number\s+/i.test(currentText)) {
        const searchTab = page.getByRole('tab', { name: 'Search', exact: true });
        if (await searchTab.count() === 1) {
          await searchTab.click();
          await page.waitForTimeout(300);
        }

        const parcelInput = page.getByRole('combobox', { name: 'Search by Parcel Number', exact: true });
        const addressInput = page.getByRole('combobox', { name: 'Search by Location Address', exact: true });
        let searchButton = null;
        if (parcelId && await parcelInput.count() === 1) {
          await parcelInput.fill(parcelId);
          await page.waitForTimeout(350);
          searchButton = page.getByRole('button', { name: 'Search by Parcel Number Search', exact: true });
        } else if (address && await addressInput.count() === 1) {
          await addressInput.fill(address);
          await page.waitForTimeout(350);
          searchButton = page.getByRole('button', { name: 'Search by Location Address Search', exact: true });
        }
        if (searchButton && await searchButton.count() === 1) {
          await searchButton.click();
          await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
          await page.waitForTimeout(300);
          currentText = String(await page.locator('body').innerText().catch(() => currentText));
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
