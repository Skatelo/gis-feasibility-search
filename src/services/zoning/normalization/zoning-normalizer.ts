// Zoning normalization — turns raw polygon matches into the normalized zoning
// result: the primary base district, any additional base districts (split
// zoning), and the overlays kept strictly separate. Uses each layer's detected
// field mapping to read the code/description; never invents values.

import type { InspectedLayer, RawZoningMatch } from '../types';

// Values that are not real district codes (jurisdiction placeholders, blanks).
const PLACEHOLDER_RE = /^(city|county|etj|none|n\/?a|null|mun\.?|muni|municipal|municipality|split|unknown|not applicable|unzoned|tbd)$/i;

export function cleanCode(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s || s.length > 40 || !/[a-z0-9]/i.test(s) || PLACEHOLDER_RE.test(s)) return null;
  return s;
}

function cleanText(value: unknown): string | null {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

const BOOLEANISH_RE = /^(yes|no|true|false|y|n)$/i;
const ZONING_KEYISH_RE = /zon|zone|district|dist|class|type|code|category/i;
// Zoning-ish columns that are actually dates/ids/geometry, not the code.
const NON_CODE_KEY_RE = /date|year|objectid|globalid|_id$|shape|hyperlink|petition|url|link|_len|area|acre/i;

/** A short, single/double-token, code-like value ("R-1", "DX-40-SH", "UC") —
 *  not multi-word prose and not a pure number (US zoning codes have a letter). */
function isCodeShaped(value: string): boolean {
  const s = value.trim();
  if (!s || s.length > 16 || BOOLEANISH_RE.test(s)) return false;
  if (s.split(/\s+/).length > 2) return false; // multi-word => description
  if (!/[a-z]/i.test(s)) return false; // pure-numeric (e.g. an epoch date) is never a code
  return !/^[a-z]+(?:\s[a-z]+)+$/.test(s);
}

function isDescriptionShaped(value: string): boolean {
  const s = value.trim();
  return /\s/.test(s) && s.length > 4;
}

function codeScore(code: string): number {
  return (/-/.test(code) ? 1 : 0) + (/\d/.test(code) ? 1 : 0) + (code === code.toUpperCase() ? 1 : 0) - (/[-_/]$/.test(code) ? 2 : 0);
}

/** Scan a feature's attributes for the best code-shaped value under a
 *  zoning-ish column, ignoring the mapped field. Recovers the real code when
 *  column names are misleading (e.g. a "class" column holding the description
 *  and a "desc" column holding the code). */
function scanForCode(attributes: Record<string, unknown>, excludeKey?: string): string | null {
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

function scanForDescription(attributes: Record<string, unknown>, code: string | null): string | null {
  let best: string | null = null;
  for (const [key, raw] of Object.entries(attributes)) {
    if (!ZONING_KEYISH_RE.test(key)) continue;
    const text = cleanText(raw);
    if (!text || text === code || !isDescriptionShaped(text)) continue;
    if (!best || text.length > best.length) best = text;
  }
  return best;
}

export interface NormalizedZoning {
  found: boolean;
  code: string | null;
  description: string | null;
  layerName: string | null;
  layerId: number | string | null;
  splitZoned: boolean;
  additionalDistricts: Array<{ code: string | null; description: string | null; coveragePercent: number | null }>;
  rawAttributes: Record<string, unknown> | null;
}

export interface NormalizedOverlay {
  code: string | null;
  name: string | null;
  description: string | null;
  layerName: string;
  rawAttributes: Record<string, unknown>;
}

function layerById(layers: InspectedLayer[]): Map<string, InspectedLayer> {
  return new Map(layers.map((l) => [String(l.id), l]));
}

function readCode(match: RawZoningMatch, layer: InspectedLayer | undefined): { code: string | null; description: string | null } {
  const mapping = layer?.fieldMapping;
  const codeField = mapping?.zoningCodeField;
  const descField = mapping?.zoningDescriptionField;
  const attrs = match.attributes;

  // The mapped code field is trusted only when its VALUE is actually code-shaped.
  // If it holds description-like prose (misleading column name) or is empty, fall
  // back to value-shape scanning to recover the real code. Never fabricated.
  const mappedCode = codeField ? cleanCode(attrs[codeField]) : null;
  const code = mappedCode && isCodeShaped(mappedCode) ? mappedCode : scanForCode(attrs, undefined) ?? mappedCode;

  // Description: the mapped field when it reads like prose, otherwise the best
  // description-shaped zoning value that isn't the code.
  const mappedDesc = descField ? cleanText(attrs[descField]) : null;
  const description =
    mappedDesc && isDescriptionShaped(mappedDesc) && mappedDesc !== code
      ? mappedDesc
      : scanForDescription(attrs, code) ?? (mappedDesc !== code ? mappedDesc : null);

  return { code, description };
}

export function normalizeZoning(
  matches: RawZoningMatch[],
  layers: InspectedLayer[],
): { zoning: NormalizedZoning; overlays: NormalizedOverlay[] } {
  const byId = layerById(layers);
  const zoningMatches = matches.filter((m) => m.layerRole === 'zoning');
  const overlayMatches = matches.filter((m) => m.layerRole === 'overlay');

  const districts: Array<{ code: string; description: string | null; match: RawZoningMatch }> = [];
  const seen = new Set<string>();
  for (const m of zoningMatches) {
    const { code, description } = readCode(m, byId.get(String(m.layerId)));
    if (code && !seen.has(code.toUpperCase())) {
      seen.add(code.toUpperCase());
      districts.push({ code, description, match: m });
    }
  }

  const overlays: NormalizedOverlay[] = overlayMatches.map((m) => {
    const layer = byId.get(String(m.layerId));
    const overlayField = layer?.fieldMapping.overlayField ?? layer?.fieldMapping.zoningCodeField;
    return {
      code: overlayField ? cleanCode(m.attributes[overlayField]) : null,
      name: cleanText(layer?.name ?? m.layerName),
      description: layer?.fieldMapping.zoningDescriptionField ? cleanText(m.attributes[layer.fieldMapping.zoningDescriptionField]) : null,
      layerName: m.layerName,
      rawAttributes: m.attributes,
    };
  });

  if (districts.length === 0) {
    return {
      zoning: { found: false, code: null, description: null, layerName: null, layerId: null, splitZoned: false, additionalDistricts: [], rawAttributes: null },
      overlays,
    };
  }

  const primary = districts[0];
  // Split zoning is a BASE-district condition only — overlays never make a
  // parcel split-zoned. Coverage percentages require parcel geometry (deep
  // mode); left null here.
  const additional = districts.slice(1).map((d) => ({ code: d.code, description: d.description, coveragePercent: null }));
  return {
    zoning: {
      found: true,
      code: primary.code,
      description: primary.description,
      layerName: primary.match.layerName,
      layerId: primary.match.layerId,
      splitZoned: districts.length > 1,
      additionalDistricts: additional,
      rawAttributes: primary.match.attributes,
    },
    overlays,
  };
}
