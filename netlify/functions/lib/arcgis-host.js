// Host allowlist for the ArcGIS proxy.
//
// Government GIS servers frequently omit Access-Control-Allow-Origin, so a
// browser fetch to them fails even though the service is healthy and public.
// Proxying fixes that, but a proxy that forwards ANY url is an open relay and an
// SSRF hole — so the target must be a public-sector or Esri-hosted GIS host.
//
// Kept in its own module so the rule is unit-testable without booting a function.

/** Esri's own hosted platforms — the common home for county/municipal layers. */
const ESRI_SUFFIXES = ['.arcgis.com', '.esri.com'];

/** Public-sector TLD/suffix patterns. `.gov` and `.us` cover US agencies;
 *  `.state.xx.us`, `.co.xx.us`, `.ci.xx.us` are the classic local-gov forms. */
const PUBLIC_SUFFIXES = ['.gov', '.us', '.mil'];

/** Private hosts a county GIS is never on. Blocking these stops the proxy being
 *  pointed at internal infrastructure even if a suffix check were fooled. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'metadata.google.internal', '169.254.169.254',
]);

const PRIVATE_IP_RE = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * True when `value` is an https URL on a host we are willing to fetch on the
 * browser's behalf. Deliberately strict: unknown host means no.
 */
export function isAllowedArcgisHost(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTNAMES.has(host)) return false;
  if (PRIVATE_IP_RE.test(host)) return false;
  // A bare IP is never a published GIS endpoint we know by name.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;

  if (ESRI_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (PUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return false;
}

/** True when the path looks like an ArcGIS REST operation rather than an
 *  arbitrary endpoint on an allowed host. */
export function isArcgisRestPath(value) {
  try {
    return /\/rest\/services\//i.test(new URL(String(value || '')).pathname);
  } catch {
    return false;
  }
}
