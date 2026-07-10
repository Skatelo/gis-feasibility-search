import { crawlSources } from './lib/crawlee-scraper.js';
import { crawlOfficialParcelPage } from './lib/sc-official-browser.js';
import { parseQpublicParcelText, unionReportUrl } from './lib/sc-parcel-parser.js';

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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return response(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return response(400, { error: 'Invalid JSON' }); }
  const county = String(body.county || '').split(',')[0].trim();
  const parcelId = String(body.parcelId || '').trim();
  const address = String(body.address || '').trim();
  const portalUrl = String(body.portalUrl || '').trim();
  if (!county || !portalUrl) return response(400, { error: 'county and portalUrl are required' });

  let portalHost = '';
  try { portalHost = new URL(portalUrl).hostname; } catch { return response(400, { error: 'Invalid portalUrl' }); }
  const isSchneider = /(^|\.)((qpublic|beacon)\.)?schneidercorp\.com$/i.test(portalHost);
  if (!isSchneider || (!parcelId && !address)) {
    return response(200, { success: true, data: { status: 'unavailable', sourceUrl: portalUrl } });
  }

  const reportUrl = county.toLowerCase() === 'union' && parcelId ? unionReportUrl(parcelId) : portalUrl;
  try {
    const crawled = await crawlSources({
      urls: [reportUrl],
      queries: ['parcel owner value building tax district'],
      maxPages: 1,
      maxDepth: 0,
      maxCharsPerPage: 30_000,
    });
    const page = crawled.results[0];
    const fastResult = page ? parseQpublicParcelText(page.content, reportUrl) : null;
    if (fastResult?.status === 'verified') return response(200, { success: true, data: fastResult });

    const browserResult = await crawlOfficialParcelPage(reportUrl, { parcelId, address });
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
