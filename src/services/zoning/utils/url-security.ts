// URL security — SSRF and unsafe-target defense for every URL the discovery
// layer touches. Discovered URLs come from search results and crawled pages, so
// they are untrusted: only public HTTP(S) endpoints may be fetched.
//
// The synchronous checks (protocol, credentials, private/loopback/link-local
// literals, blocked hostnames) run everywhere. An optional DNS-resolution check
// runs only where node:dns is available (server/tests); in the browser the
// same-origin proxy and CORS already constrain reachable hosts.

const BLOCKED_HOSTNAMES = /^(localhost|localhost\.localdomain|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i;
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata']);

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast + reserved
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isPrivateAddress(address: string): boolean {
  const normalized = String(address || '').toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (isIpv4(normalized)) return isPrivateIpv4(normalized);
  // IPv6 forms.
  if (normalized === '::' || normalized === '::1') return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/.test(normalized)) return true; // ULA + link-local
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (normalized.startsWith('2001:db8:')) return true; // documentation range
  return false;
}

export interface UrlSecurityOptions {
  /** When set, the host must equal or be a subdomain of one of these. */
  allowlist?: string[];
}

function hostAllowed(host: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const h = host.toLowerCase();
  return allowlist.some((d) => {
    const dom = d.toLowerCase().replace(/^\./, '');
    return h === dom || h.endsWith(`.${dom}`);
  });
}

/** Synchronous structural validation. Throws UnsafeUrlError on any violation. */
export function validateUrlSyntax(value: string, options: UrlSecurityOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${String(value).slice(0, 120)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new UnsafeUrlError('Credentialed URLs are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UnsafeUrlError('URL has no host');
  if (BLOCKED_HOSTNAMES.test(host) || CLOUD_METADATA_HOSTS.has(host)) {
    throw new UnsafeUrlError(`Blocked host: ${host}`);
  }
  if ((isIpv4(host) || host.includes(':')) && isPrivateAddress(host)) {
    throw new UnsafeUrlError(`Private/loopback address not allowed: ${host}`);
  }
  if (!hostAllowed(host, options.allowlist)) {
    throw new UnsafeUrlError(`Host not in allowlist: ${host}`);
  }
  url.hash = '';
  return url;
}

/** Full validation including DNS resolution where available (node). In the
 *  browser this resolves after the synchronous checks without a DNS probe. */
export async function assertSafeUrl(value: string, options: UrlSecurityOptions = {}): Promise<URL> {
  const url = validateUrlSyntax(value, options);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpv4(host) || host.includes(':')) return url; // literal IP already checked

  // Best-effort DNS check on platforms that expose node:dns. The specifier is a
  // variable so the type-checker doesn't require @types/node here, and so the
  // browser bundler leaves it as a runtime import that simply throws (caught).
  interface DnsPromises {
    lookup: (hostname: string, options: { all: true; verbatim: boolean }) => Promise<Array<{ address: string }>>;
  }
  try {
    const specifier = 'node:dns/promises';
    const dns = (await import(/* @vite-ignore */ specifier)) as DnsPromises;
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
      throw new UnsafeUrlError(`Host ${host} resolves to a private address`);
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    // node:dns unavailable (browser) or lookup failed — fall back to the
    // synchronous checks already performed.
  }
  return url;
}

export function isSafeUrl(value: string, options: UrlSecurityOptions = {}): boolean {
  try {
    validateUrlSyntax(value, options);
    return true;
  } catch {
    return false;
  }
}
