// Secretary of State scraper proxy — fetches a public business-registration
// record page through Bright Data's Web Unlocker (which solves anti-bot
// challenges and avoids browser CORS). The user's Bright Data token is passed
// per-call (header), never stored server-side. Returns the page HTML plus a
// `blocked` flag when the response is an anti-bot interstitial rather than real
// content, so the caller can fall back gracefully.
//
// ESM syntax because the project's package.json is "type": "module".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-brightdata-key, x-brightdata-zone, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Signals that the returned page is an anti-bot challenge / error shell, not the
// real record (Cloudflare "just a moment", captcha, IIS 404/5xx shells, etc.).
function looksBlocked(statusCode, body) {
  if (statusCode && (statusCode >= 400)) return true;
  const b = String(body || '');
  if (b.length < 1500) return true; // real record pages are large
  return /just a moment|performing a quick security check|attention required|cf-browser-verification|captcha|enable javascript and cookies|access denied|request unsuccessful/i.test(b);
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) };
  }

  const headers = event.headers || {};
  const token = headers['x-brightdata-key'] || headers['X-Brightdata-Key'] || '';
  const zone = headers['x-brightdata-zone'] || headers['X-Brightdata-Zone'] || 'web_unlocker1';

  let url = '';
  try { url = (JSON.parse(event.body || '{}').url) || ''; } catch { /* ignore */ }

  if (!token || !url || !/^https?:\/\//i.test(url)) {
    return { statusCode: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'token (x-brightdata-key) and a valid url are required' }) };
  }

  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, url, format: 'json' }),
    });
    const text = await res.text();

    // format:json wraps the upstream response: { status_code, headers, body }.
    let statusCode = res.status;
    let pageBody = text;
    try {
      const j = JSON.parse(text);
      if (j && (j.status_code != null || j.body != null)) {
        statusCode = j.status_code ?? res.status;
        pageBody = j.body ?? '';
      }
    } catch { /* upstream returned raw text */ }

    if (!res.ok && res.status === 401) {
      return { statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, blocked: true, reason: 'brightdata-auth', statusCode: res.status }) };
    }

    const blocked = looksBlocked(statusCode, pageBody);
    return {
      statusCode: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: !blocked, blocked, statusCode, url, body: blocked ? '' : String(pageBody).slice(0, 400000) }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, blocked: true, error: String((e && e.message) || e) }) };
  }
};
