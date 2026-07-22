// Same-origin proxy for RealEstateAPI.com Property Detail.
// A user key may be relayed per request, or REALESTATEAPI_KEY may be configured
// as a server-side Netlify environment variable. Nothing is cached.

const UPSTREAM = 'https://api.realestateapi.com/v2/PropertyDetail';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store, max-age=0',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function addressParts(address) {
  const locality = address.match(/^(.+),\s*([^,]+?)\s+(NC|SC)\s+(\d{5})(?:-\d{4})?$/i);
  if (!locality) return null;
  const streetLine = locality[1].trim();
  const streetMatch = streetLine.match(/^(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)\s+(.+)$/);
  if (!streetMatch) return null;

  let street = streetMatch[2].trim();
  let unit;
  const unitMatch = street.match(/(?:\s+|,\s*)(?:Apt|Apartment|Unit|Suite|Ste|#)\s*([A-Za-z0-9-]+)$/i);
  if (unitMatch) {
    unit = unitMatch[1];
    street = street.slice(0, unitMatch.index).replace(/,+$/, '').trim();
  }
  if (!street) return null;

  return {
    house: streetMatch[1],
    street,
    city: locality[2].trim(),
    state: locality[3].toUpperCase(),
    zip: locality[4],
    ...(unit ? { unit } : {}),
  };
}

async function fetchWithAbort(url, init, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const hasAddressParts = ['house', 'street', 'city', 'state', 'zip']
    .every((field) => String(input[field] || '').trim());
  const componentAddress = hasAddressParts
    ? `${input.house} ${input.street}${input.unit ? ` Unit ${input.unit}` : ''}, ${input.city} ${input.state} ${input.zip}`
    : '';
  const address = String(input.address || componentAddress)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,+$/, '')
    .replace(/,?\s*(?:United States(?: of America)?|USA|U\.S\.A\.|US)\.?$/i, '')
    .replace(/\bNorth Carolina\b/gi, 'NC')
    .replace(/\bSouth Carolina\b/gi, 'SC')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*(NC|SC)\b(?=\s+\d{5}(?:-\d{4})?\b|$)/i, ' $1')
    .trim();
  if (!address || !/\b(?:NC|SC)\b/i.test(address)) {
    return json(400, { error: 'A full North Carolina or South Carolina address is required.' });
  }
  const parts = hasAddressParts ? addressParts(address) : null;
  if (hasAddressParts && !parts) {
    return json(400, { error: 'The full property address could not be split into house, street, city, state, and ZIP.' });
  }

  const requestHeaders = event.headers || {};
  const key = requestHeaders['x-api-key']
    || requestHeaders['X-Api-Key']
    || process.env.REALESTATEAPI_KEY
    || '';
  if (!key) {
    return json(401, { error: 'RealEstateAPI key is not configured. Add it in Account Settings or set REALESTATEAPI_KEY on Netlify.' });
  }

  try {
    const response = await fetchWithAbort(UPSTREAM, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({
        ...(parts || { address }),
        exact_match: true,
        comps: false,
      }),
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: { ...CORS, 'content-type': response.headers.get('content-type') || 'application/json' },
      body: body || '{}',
    };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return json(timedOut ? 504 : 502, {
      error: timedOut
        ? 'RealEstateAPI timed out. Retry the on-demand lookup.'
        : String((error && error.message) || error),
    });
  }
};
