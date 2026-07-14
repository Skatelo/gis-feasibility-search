// Guarded HTTP helpers shared by geocoders and adapters.
//
// A single choke point for timeouts, JSON parsing, response-size caps, and
// (later, in url-security) SSRF/allowlist checks. Everything the engine does
// over the network goes through here so limits are enforced in one place.

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB guard against oversized bodies

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Combine an optional caller AbortSignal with a per-request timeout. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort((signal as AbortSignal & { reason?: unknown })?.reason);
  if (signal) {
    if (signal.aborted) controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

export interface FetchTextOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const { signal, done } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      cache: 'no-store',
      signal,
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, url);
    const cap = opts.maxBytes ?? MAX_RESPONSE_BYTES;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > cap) throw new HttpError(`Response too large (${declared} bytes)`, res.status, url);
    const text = await res.text();
    if (text.length > cap) throw new HttpError(`Response too large (${text.length} bytes)`, res.status, url);
    return text;
  } finally {
    done();
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchTextOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError('Invalid JSON response', 200, url);
  }
}

/** Build a URL with query params without manual string concatenation. */
export function buildUrl(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}
