/**
 * Race a promise against a wall-clock timeout so a hung network call fails fast
 * on mobile instead of leaving the UI in an eternal spinner. Both handlers are
 * attached to the original promise, so a late rejection after the timeout fires
 * is consumed and can never surface as an unhandled rejection.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Best-effort fetch with an abort timeout. A hung request (dead mobile network,
 * cold-starting serverless function) fails fast instead of pinning the UI.
 */
export async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}
