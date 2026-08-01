// ---------------------------------------------------------------------------
// DEEPSEEK TRANSPORT
// The fusion report pairs Gemini with DeepSeek. DeepSeek can be reached two
// ways, and the native key wins when present because it is the direct route.
// Without it, OpenRouter serves the same model family, so fusion keeps working
// instead of silently degrading to a single-model report.
//
// Verified against OpenRouter's live model list: deepseek/deepseek-v4-flash-0731
// is a real slug ("DeepSeek: DeepSeek V4 Flash 0731").
//
// Kept free of app imports so the routing and body translation are unit-testable
// without booting the whole service.
// ---------------------------------------------------------------------------

export const OPENROUTER_DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';

export interface DeepSeekTransport {
  provider: 'deepseek' | 'openrouter';
  url: string;
  key: string;
  extraHeaders: Record<string, string>;
  /** Rewrites a DeepSeek-native request body for the active provider. */
  rewriteBody: (body: string) => string;
}

/**
 * Translate a DeepSeek-native body for OpenRouter: namespace the model, and drop
 * `thinking`, which is DeepSeek's own parameter. OpenRouter expresses the same
 * intent as `reasoning`, so a disabled-thinking draft stays a fast draft rather
 * than quietly becoming a reasoning run (or being rejected outright).
 *
 * Only an explicitly DISABLED thinking block is translated. Anything else just
 * loses the unsupported key — we never assert reasoning is off when it isn't.
 */
export function toOpenRouterBody(body: string, model: string = OPENROUTER_DEEPSEEK_MODEL): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  const thinking = parsed.thinking as { type?: string } | undefined;
  delete parsed.thinking;
  if (thinking?.type === 'disabled') parsed.reasoning = { enabled: false };
  parsed.model = model;
  return JSON.stringify(parsed);
}

/**
 * Pick the route to DeepSeek. The native key always wins; OpenRouter is the
 * fallback. Returns null when neither is configured, so callers can fall back
 * to a Gemini-only report.
 */
export function buildDeepSeekTransport(
  nativeKey: string,
  openRouterKey: string,
  origin = 'https://gis-feasibility-search.netlify.app',
): DeepSeekTransport | null {
  const native = String(nativeKey || '').trim();
  if (native) {
    return { provider: 'deepseek', url: DEEPSEEK_CHAT_URL, key: native, extraHeaders: {}, rewriteBody: (b) => b };
  }
  const routed = String(openRouterKey || '').trim();
  if (!routed) return null;
  return {
    provider: 'openrouter',
    url: OPENROUTER_CHAT_URL,
    key: routed,
    // OpenRouter attributes usage to the calling app via these headers.
    extraHeaders: { 'HTTP-Referer': origin, 'X-Title': 'GIS Feasibility Search' },
    rewriteBody: (b) => toOpenRouterBody(b),
  };
}
