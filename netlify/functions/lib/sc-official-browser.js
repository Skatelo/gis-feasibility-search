import { existsSync } from 'node:fs';

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Configuration } from '@crawlee/core';
import { chromium as playwrightChromium } from 'playwright-core';

const MAX_TEXT = 60_000;
const MAX_HTML = 1_000_000;
const CHALLENGE_TITLE_RE = /just a moment|attention required|checking your browser/i;
const REPORT_TEXT_RE = /Parcel (Number|ID)\s+/i;
const SPATIALEST_REPORT_RE = /Tax Map Number:\s*[A-Z0-9-]+[\s\S]*?\bOwner\b/i;

const STREET_ALIASES = {
  STREET: 'ST', ROAD: 'RD', AVENUE: 'AVE', HIGHWAY: 'HWY', LANE: 'LN', DRIVE: 'DR',
  BOULEVARD: 'BLVD', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER',
  PARKWAY: 'PKWY', TRAIL: 'TRL', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
};

function normalizedParcelId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedAddress(value) {
  const street = String(value || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  return street.split(/\s+/).filter(Boolean).map((token) => STREET_ALIASES[token] || token).join(' ');
}

function normalizedResultText(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
    .split(/\s+/).filter(Boolean).map((token) => STREET_ALIASES[token] || token).join(' ');
}

async function openMatchingResult(page, selector, { parcelId = '', address = '', preferAddress = false } = {}) {
  const links = await page.locator(selector).evaluateAll((elements) => elements.slice(0, 100).map((element) => ({
    href: element.getAttribute('href') || '',
    text: element.closest('tr')?.innerText || element.closest('article')?.innerText || element.parentElement?.innerText || element.textContent || '',
  })));
  if (!links.length) return false;
  const expectedParcelId = normalizedParcelId(parcelId);
  const expectedAddress = normalizedAddress(address);
  const parcelMatches = (link) => {
    const parcelText = normalizedParcelId(`${link.text} ${link.href}`);
    return expectedParcelId && parcelText.includes(expectedParcelId);
  };
  const addressMatches = (link) => {
    const addressText = normalizedResultText(link.text);
    return expectedAddress && addressText.includes(expectedAddress);
  };
  let matches = preferAddress && expectedAddress
    ? links.filter(addressMatches)
    : expectedParcelId
      ? links.filter(parcelMatches)
      : links.filter(addressMatches);
  if (preferAddress && expectedParcelId && matches.length > 1) {
    const exactParcel = matches.filter(parcelMatches);
    if (exactParcel.length === 1) matches = exactParcel;
  }
  if (!matches.length && links.length === 1) matches = links;
  const unique = [...new Map(matches.map((match) => [match.href, match])).values()];
  if (unique.length !== 1 || !unique[0].href) return false;
  await page.goto(new URL(unique[0].href, page.url()).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

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

export async function crawlOfficialParcelPage(url, {
  parcelId = '',
  address = '',
  searchPortal = true,
  portalType = 'schneider',
  strictParcelId = false,
  preferAddress = false,
} = {}) {
  let text = '';
  let html = '';
  let loadedUrl = url;
  let blocked = false;
  const localChrome = localChromePath();
  // Netlify bundles this function as CommonJS while @sparticuz/chromium is ESM.
  // Keep the import native and lazy so the deployed fallback does not crash with
  // ERR_REQUIRE_ESM before the assessor page is opened.
  const chromiumModule = await import('@sparticuz/chromium');
  const chromiumBinary = chromiumModule.default || chromiumModule;
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

      const acceptPublicTerms = async () => {
        const dialog = page.locator('[role="dialog"][aria-label*="Terms" i]:visible').first();
        if (await dialog.count() !== 1) return true;
        const checkbox = dialog.locator('input[type="checkbox"]:visible').first();
        if (await checkbox.count() === 1 && !await checkbox.isChecked().catch(() => false)) {
          await checkbox.check({ timeout: 3_000 }).catch(() => {});
        }
        const roleButton = dialog.getByRole('button', { name: /agree|accept|continue/i }).first();
        const roleLink = dialog.getByRole('link', { name: /agree|accept|continue/i }).first();
        const valueButton = dialog.locator('input[type="submit"][value*="agree" i], input[type="button"][value*="agree" i], input[type="submit"][value*="accept" i], input[type="button"][value*="accept" i]').first();
        const consent = await roleButton.count() ? roleButton : await roleLink.count() ? roleLink : valueButton;
        if (await consent.count() !== 1) return false;
        await consent.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(250);
        return await dialog.count() === 0 || !await dialog.isVisible().catch(() => false);
      };

      // Schneider portals interpose a one-time public-records disclaimer per
      // session; accepting it is required to view the county's public data.
      await page.waitForTimeout(250);
      if (!await acceptPublicTerms()) {
        blocked = true;
        return;
      }

      const readBody = async () => String(await page.locator('body').innerText().catch(() => ''));
      let currentText = await readBody();

      if (portalType === 'spatialest') {
        const understand = page.getByRole('button', { name: /^I Understand$/i });
        if (await understand.count() === 1) {
          await understand.click();
          await page.waitForTimeout(250);
        }
        currentText = await readBody();
        if (!SPATIALEST_REPORT_RE.test(currentText) && address) {
          const searchInput = page.getByRole('combobox', { name: /Search for a property/i });
          const searchButton = page.getByRole('button', { name: /^Search$/i });
          if (await searchInput.count() === 1 && await searchButton.count() === 1) {
            await searchInput.fill(String(address).split(',')[0].trim() || address);
            await searchButton.click();
            await page.waitForURL(/#\/property\//i, { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(500);
            currentText = await readBody();
          }
        }
        if (!SPATIALEST_REPORT_RE.test(currentText)) {
          const opened = await openMatchingResult(page, 'a[href*="#/property/"]', { parcelId, address });
          if (opened) currentText = await readBody();
        }
      }

      if (portalType !== 'spatialest' && searchPortal && !REPORT_TEXT_RE.test(currentText)) {
        // Not on a record page (e.g. a constructed report URL fell back to the
        // app shell): run the portal's own search.
        const searchTab = page.getByRole('tab', { name: 'Search', exact: true });
        if (await searchTab.count() === 1) {
          if (!await acceptPublicTerms()) {
            blocked = true;
            return;
          }
          const openedSearch = await searchTab.click({ timeout: 5_000 }).then(() => true).catch(() => false);
          if (!openedSearch) {
            blocked = true;
            return;
          }
          await page.waitForTimeout(300);
        }

        // Exact accessible names first (verified against qPublic), then loose
        // matches for county-specific labels.
        const exactParcelInput = page.getByRole('combobox', { name: /^(?:Search by )?(?:Parcel|TMS|Map) (?:Number|ID)$/i });
        const exactAddressInput = page.getByRole('combobox', { name: /^(?:Search by )?(?:Location|Property|Site) Address$/i });
        const parcelInput = await exactParcelInput.count() === 1
          ? exactParcelInput
          : page.locator('input[aria-label*="Parcel Number" i]:visible, input[placeholder*="parcel number" i]:visible').first();
        const addressInput = await exactAddressInput.count() === 1
          ? exactAddressInput
          : page.locator('input[id$="_txtAddress"]:visible').first();

        let usedInput = null;
        let searchButton = null;
        if (!preferAddress && parcelId && await parcelInput.count() === 1) {
          await parcelInput.fill(parcelId);
          usedInput = parcelInput;
          searchButton = page.getByRole('button', { name: /^(?:Search by )?(?:Parcel|TMS|Map) (?:Number|ID) Search$/i });
        } else if (address && await addressInput.count() === 1) {
          // Schneider's location search expects the situs street line, not a
          // full postal address with city/state/country. Supplying the full line
          // returns no result in several SC county apps.
          const streetLine = String(address).split(',')[0].trim() || address;
          await addressInput.fill(streetLine);
          usedInput = addressInput;
          searchButton = page.getByRole('button', { name: /^(?:Search by )?(?:Location|Property|Site) Address Search$/i });
          if (await searchButton.count() !== 1) {
            const inputId = await addressInput.getAttribute('id');
            searchButton = inputId
              ? page.locator(`#${inputId.replace(/txtAddress(?:Exact)?$/, 'btnSearch')}`)
              : page.locator('input[id$="_btnSearch"]:visible, button[id$="_btnSearch"]:visible').first();
          }
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
          const opened = await openMatchingResult(page, 'a[href*="KeyValue="]', { parcelId, address, preferAddress });
          if (opened) currentText = await readBody();
        }

        // A county GIS layer can lag behind the assessor's current parcel key.
        // In an address workflow, retry the exact situs in the same browser
        // session before returning a miss. The server still performs strict
        // parcel matching for explicit parcel-ID searches.
        if (!REPORT_TEXT_RE.test(currentText) && parcelId && address && !strictParcelId && !preferAddress) {
          const retryAddressInput = page.locator('input[id$="_txtAddress"]:visible').first();
          if (await retryAddressInput.count() === 1) {
            await retryAddressInput.fill(String(address).split(',')[0].trim() || address);
            const retryInputId = await retryAddressInput.getAttribute('id');
            const retryButton = retryInputId
              ? page.locator(`#${retryInputId.replace(/txtAddress(?:Exact)?$/, 'btnSearch')}`)
              : page.locator('input[id$="_btnSearch"]:visible, button[id$="_btnSearch"]:visible').first();
            if (await retryButton.count() === 1) {
              await retryButton.click({ timeout: 5_000 });
            } else {
              await retryAddressInput.press('Enter');
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(500);
            currentText = await readBody();
            if (!REPORT_TEXT_RE.test(currentText)) {
              const opened = await openMatchingResult(page, 'a[href*="KeyValue="]', { parcelId: '', address });
              if (opened) currentText = await readBody();
            }
          }
        }
      }

      text = currentText.slice(0, MAX_TEXT);
      html = String(await page.content().catch(() => '')).slice(0, MAX_HTML);
      loadedUrl = page.url() || request.loadedUrl || request.url;
    },
    failedRequestHandler() { blocked = true; },
  }, config);

  await crawler.run([url]);
  return { text, html, loadedUrl, blocked };
}
