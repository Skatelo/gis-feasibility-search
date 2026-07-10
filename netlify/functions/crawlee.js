import { crawlSources } from './lib/crawlee-scraper.js';

export const config = {
  path: '/.netlify/functions/crawlee',
  rateLimit: {
    windowLimit: 20,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
    const data = await crawlSources({
      urls,
      queries: Array.isArray(body.queries) ? body.queries : [],
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      maxCharsPerPage: body.maxCharsPerPage,
    });
    return json(200, { success: true, data });
  } catch (error) {
    const message = String(error?.message || error || 'Crawl failed');
    const status = /invalid|required|allowed|private/i.test(message) ? 400 : 502;
    return json(status, { success: false, error: message.slice(0, 500) });
  }
};
