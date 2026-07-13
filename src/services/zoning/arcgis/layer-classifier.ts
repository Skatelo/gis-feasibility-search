// Layer role classifier — decides what a layer actually is from its name,
// description, geometry, and fields. Deterministic and weighted.
//
// The spec's hard rule lives here: current zoning, future land use,
// comprehensive-plan designations, and overlays are DISTINCT roles and must
// never be conflated. A "Future Land Use" layer is never returned as zoning; a
// "Zoning Overlay" layer is an overlay, not base zoning.

import type { LayerRole } from '../types';
import type { ArcgisLayerMetadata } from './arcgis.types';
import { detectFieldMapping } from './field-detector';

const FLOOD_RE = /\b(flood|fema|sfha|floodplain|floodway|firm panel)\b/i;
const PARCEL_RE = /\b(parcel|parcels|tax[_ ]?parcel|cadastr|property ?boundar)/i;
const BOUNDARY_RE = /\b(municipal boundar|city limits?|town limits?|corporate limits?|jurisdiction(al)? boundar|planning jurisdiction|\betj\b|extraterritorial|zoning jurisdiction|municipal limits?)\b/i;
const FLU_RE = /\b(future[_ ]?land[_ ]?use|\bflu\b|land ?use ?plan|land_?use_?plan)\b/i;
const COMP_RE = /\bcomprehensive[_ ]?plan\b|\bcomp\.? ?plan\b/i;
const OVERLAY_RE = /\boverlay\b/i;
const HISTORIC_RE = /\bhistoric\b/i;
const ZONING_RE = /\b(zoning|zone|base ?zon|\budo\b|unified development|land development code)\b/i;

export interface LayerClassification {
  role: LayerRole;
  confidence: number; // 0..1
  reasons: string[];
  hasZoningCodeField: boolean;
}

export function classifyLayer(meta: ArcgisLayerMetadata): LayerClassification {
  const haystack = `${meta.name ?? ''} ${meta.description ?? ''}`.replace(/[_-]+/g, ' ');
  const isPolygon = /polygon/i.test(meta.geometryType ?? '');
  const mapping = detectFieldMapping(meta);
  const hasCodeField = !!mapping.zoningCodeField && mapping.detectionConfidence >= 0.4;
  const reasons: string[] = [];

  const scores: Record<LayerRole, number> = {
    zoning: 0,
    'future-land-use': 0,
    'comprehensive-plan': 0,
    overlay: 0,
    'municipal-boundary': 0,
    'planning-jurisdiction': 0,
    parcel: 0,
    floodplain: 0,
    historic: 0,
    unknown: 0,
  };

  if (FLOOD_RE.test(haystack)) scores.floodplain += 10;
  if (PARCEL_RE.test(haystack)) scores.parcel += 10;
  if (BOUNDARY_RE.test(haystack)) {
    scores['municipal-boundary'] += 9;
    if (/planning jurisdiction|etj|extraterritorial/i.test(haystack)) scores['planning-jurisdiction'] += 9;
  }
  if (FLU_RE.test(haystack)) scores['future-land-use'] += 9;
  if (COMP_RE.test(haystack)) scores['comprehensive-plan'] += 8;
  if (OVERLAY_RE.test(haystack)) scores.overlay += 8;
  if (HISTORIC_RE.test(haystack)) scores.historic += 7;

  if (ZONING_RE.test(haystack)) {
    scores.zoning += 6;
    // Never let a future-land-use or overlay layer win the zoning role.
    if (FLU_RE.test(haystack)) scores.zoning -= 6;
    if (OVERLAY_RE.test(haystack)) scores.zoning -= 4;
    if (COMP_RE.test(haystack)) scores.zoning -= 4;
  }
  // A strong zoning-code field is corroborating evidence for base zoning, but
  // only when the name did not already point at FLU/overlay/comp-plan.
  if (hasCodeField && !FLU_RE.test(haystack) && !OVERLAY_RE.test(haystack) && !COMP_RE.test(haystack)) {
    scores.zoning += 3;
    reasons.push(`layer has a zoning-code field ("${mapping.zoningCodeField}")`);
  }

  // Polygon roles need polygon geometry; downweight when it isn't.
  if (!isPolygon) {
    for (const r of ['zoning', 'future-land-use', 'comprehensive-plan', 'overlay', 'municipal-boundary', 'planning-jurisdiction', 'parcel', 'floodplain', 'historic'] as LayerRole[]) {
      if (scores[r] > 0) scores[r] -= 4;
    }
    reasons.push(`geometry "${meta.geometryType ?? 'none'}" is not polygon`);
  }

  let role: LayerRole = 'unknown';
  let best = 0;
  for (const [r, s] of Object.entries(scores) as [LayerRole, number][]) {
    if (s > best) {
      best = s;
      role = r;
    }
  }
  if (best <= 0) {
    reasons.push('no role pattern matched');
    return { role: 'unknown', confidence: 0, reasons, hasZoningCodeField: hasCodeField };
  }
  reasons.unshift(`classified as ${role} (score ${best})`);
  return { role, confidence: Math.min(1, best / 10), reasons, hasZoningCodeField: hasCodeField };
}
