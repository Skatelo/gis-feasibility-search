// Value-shape heuristics — decide which attribute holds the zoning CODE vs the
// DESCRIPTION from the actual VALUES, not just column names. Shared by the
// ArcGIS-result normalizer and the GeoJSON/WFS adapters (whose feature
// properties carry no field metadata).

const PLACEHOLDER_RE = /^(city|county|etj|none|n\/?a|null|mun\.?|muni|municipal|municipality|split|unknown|not applicable|unzoned|tbd|unavailable|unresolved|not published|not found|official map review|zoning code unresolved)$/i;
const BOOLEANISH_RE = /^(yes|no|true|false|y|n)$/i;
export const ZONING_KEYISH_RE = /zon|zone|district|dist|class|type|code|category/i;
export const NON_CODE_KEY_RE = /date|year|objectid|globalid|_id$|shape|hyperlink|petition|url|link|_len|area|acre/i;

export function cleanCode(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s || s.length > 40 || !/[a-z0-9]/i.test(s) || PLACEHOLDER_RE.test(s)) return null;
  return s;
}

export function cleanText(value: unknown): string | null {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

/** A short, ≤2-token, code-like value with a letter ("R-1", "DX-40-SH", "UC") —
 *  not prose and not a pure number/date. */
export function isCodeShaped(value: string): boolean {
  const s = value.trim();
  if (!s || s.length > 16 || BOOLEANISH_RE.test(s)) return false;
  if (s.split(/\s+/).length > 2) return false;
  if (!/[a-z]/i.test(s)) return false;
  return !/^[a-z]+(?:\s[a-z]+)+$/.test(s);
}

export function isDescriptionShaped(value: string): boolean {
  const s = value.trim();
  return /\s/.test(s) && s.length > 4;
}

export function codeScore(code: string): number {
  return (/-/.test(code) ? 1 : 0) + (/\d/.test(code) ? 1 : 0) + (code === code.toUpperCase() ? 1 : 0) - (/[-_/]$/.test(code) ? 2 : 0);
}

/** Best code-shaped value under a zoning-ish, non-date/id column. */
export function scanForCode(attributes: Record<string, unknown>, excludeKey?: string): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [key, raw] of Object.entries(attributes)) {
    if (key === excludeKey || !ZONING_KEYISH_RE.test(key) || NON_CODE_KEY_RE.test(key)) continue;
    const code = cleanCode(raw);
    if (!code || !isCodeShaped(code)) continue;
    const s = codeScore(code);
    if (s > bestScore) {
      bestScore = s;
      best = code;
    }
  }
  return best;
}

export function scanForDescription(attributes: Record<string, unknown>, code: string | null): string | null {
  let best: string | null = null;
  for (const [key, raw] of Object.entries(attributes)) {
    if (!ZONING_KEYISH_RE.test(key)) continue;
    const text = cleanText(raw);
    if (!text || text === code || !isDescriptionShaped(text)) continue;
    if (!best || text.length > best.length) best = text;
  }
  return best;
}

/** Detect the code + description property names by aggregating value shapes over
 *  a sample of feature-property records (for sources without field metadata). */
export function detectCodeFieldFromSamples(samples: Array<Record<string, unknown>>): {
  codeField: string | null;
  descriptionField: string | null;
} {
  const codeHits = new Map<string, number>();
  const descHits = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const props of samples) {
    for (const [key, raw] of Object.entries(props)) {
      if (!ZONING_KEYISH_RE.test(key) || NON_CODE_KEY_RE.test(key)) continue;
      const code = cleanCode(raw);
      if (code && isCodeShaped(code)) bump(codeHits, key);
      const text = cleanText(raw);
      if (text && isDescriptionShaped(text)) bump(descHits, key);
    }
  }
  const pick = (m: Map<string, number>, exclude?: string): string | null => {
    let best: string | null = null;
    let bestN = 0;
    for (const [k, n] of m) {
      if (k === exclude) continue;
      if (n > bestN) {
        bestN = n;
        best = k;
      }
    }
    return best;
  };
  const codeField = pick(codeHits);
  const descriptionField = pick(descHits, codeField ?? undefined);
  return { codeField, descriptionField };
}
