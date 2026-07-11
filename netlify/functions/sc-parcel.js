import { parseQpublicParcelText, unionReportUrl } from './lib/sc-parcel-parser.js';
import { queryUnionTreasurer } from './lib/sc-union-treasurer.js';

export const config = {
  path: '/.netlify/functions/sc-parcel',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip'] },
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'content-type': 'application/json; charset=utf-8',
};

function response(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function isSchneiderUrl(value) {
  try {
    return /(^|\.)schneidercorp\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Build a direct record ("report") URL for a Schneider qPublic/Beacon app from
 * its search-page URL. Both parameter styles are in use:
 *   Application.aspx?AppID=nnn&LayerID=nnn&PageTypeID=1...  (numeric ids)
 *   Application.aspx?App=Name&PageType=Map                  (named apps)
 * PageTypeID=4 / PageType=Report with a KeyValue renders the parcel record; the
 * portal resolves its own PageID. If the key misses, the app shell still loads
 * and the browser fallback runs its search UI. */
function schneiderReportUrl(appUrl, parcelId) {
  try {
    const src = new URL(appUrl);
    const out = new URL(`https://${src.hostname}/Application.aspx`);
    const appId = src.searchParams.get('AppID');
    const appName = src.searchParams.get('App');
    if (appId) {
      out.searchParams.set('AppID', appId);
      const layerId = src.searchParams.get('LayerID');
      if (layerId) out.searchParams.set('LayerID', layerId);
      out.searchParams.set('PageTypeID', '4');
    } else if (appName) {
      out.searchParams.set('App', appName);
      out.searchParams.set('PageType', 'Report');
    } else {
      return appUrl;
    }
    out.searchParams.set('KeyValue', parcelId);
    return out.toString();
  } catch {
    return appUrl;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return response(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return response(400, { error: 'Invalid JSON' }); }
  const county = String(body.county || '').split(',')[0].trim();
  const parcelId = String(body.parcelId || '').trim();
  const address = String(body.address || '').trim();
  const portalUrl = String(body.portalUrl || '').trim();
  const alternateUrl = String(body.alternateUrl || '').trim();
  if (!county || !portalUrl) return response(400, { error: 'county and portalUrl are required' });
  try { new URL(portalUrl); } catch { return response(400, { error: 'Invalid portalUrl' }); }

  if (county.toLowerCase() === 'union' && address) {
    try {
      const treasurerRecord = await queryUnionTreasurer(address);
      if (treasurerRecord) return response(200, { success: true, data: treasurerRecord });
    } catch {
      // Continue to the assessor fallback when the treasurer is unavailable.
    }
  }

  // A county's primary portal may be its own viewer while the scrapeable
  // Schneider app is listed as the alternate — use whichever is Schneider.
  const schneiderUrl = [portalUrl, alternateUrl].find(isSchneiderUrl);
  if (!schneiderUrl || (!parcelId && !address)) {
    return response(200, { success: true, data: { status: 'unavailable', sourceUrl: portalUrl } });
  }

  const usableParcelId = parcelId && parcelId.toUpperCase() !== 'N/A' ? parcelId : '';
  const reportUrl = county.toLowerCase() === 'union' && usableParcelId
    ? unionReportUrl(usableParcelId)
    : usableParcelId
      ? schneiderReportUrl(schneiderUrl, usableParcelId)
      : schneiderUrl;
  try {
    // Schneider portals sit behind Cloudflare, which rejects plain HTTP
    // clients outright — go straight to the real-browser Crawlee path.
    // (Browser dependencies load lazily to keep the treasurer path light.)
    const { crawlOfficialParcelPage } = await import('./lib/sc-official-browser.js');
    const browserResult = await crawlOfficialParcelPage(reportUrl, { parcelId: usableParcelId, address });
    if (browserResult.blocked || !browserResult.text) {
      return response(200, { success: true, data: { status: 'blocked', sourceUrl: reportUrl } });
    }
    return response(200, {
      success: true,
      data: parseQpublicParcelText(browserResult.text, browserResult.loadedUrl || reportUrl),
    });
  } catch (error) {
    return response(200, {
      success: true,
      data: { status: 'blocked', sourceUrl: reportUrl, error: String(error?.message || error).slice(0, 240) },
    });
  }
};
