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
  let code = codeField ? cleanCode(match.attributes[codeField]) : null;
  // Fall back to scanning attributes for a code-shaped value when the mapped
  // field was empty (e.g. a split polygon sliver) but never fabricate one.
  if (!code) {
    for (const [key, value] of Object.entries(match.attributes)) {
      if (/zon|zone|district|class/i.test(key) && !/desc|name|area|shape|id$/i.test(key)) {
        code = cleanCode(value);
        if (code) break;
      }
    }
  }
  const description = descField ? cleanText(match.attributes[descField]) : null;
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
