// Zoning normalization — turns raw polygon matches into the normalized zoning
// result: the primary base district, any additional base districts (split
// zoning), and the overlays kept strictly separate. Uses each layer's detected
// field mapping to read the code/description; never invents values.

import type { InspectedLayer, RawZoningMatch } from '../types';
import {
  cleanCode,
  cleanText,
  isCodeShaped,
  isDescriptionShaped,
  scanForCode,
  scanForDescription,
} from './value-shape';

export { cleanCode } from './value-shape';

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
