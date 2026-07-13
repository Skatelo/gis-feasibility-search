// Weighted field detection — finds the zoning-code, description, jurisdiction,
// and overlay fields on a layer without relying on a fixed field-name list.
//
// Every jurisdiction names its columns differently, so detection scores each
// field on multiple signals (exact name, alias, the layer's display field, the
// renderer's classification field) and picks the highest-scoring candidate,
// while excluding ids/dates/owners/geometry/area columns.

import type { FieldMapping } from '../types';
import type { ArcgisLayerMetadata, ArcgisField } from './arcgis.types';

// Strong zoning-code field names (exact or near-exact).
const CODE_STRONG_RE = /^(zoning|zone|zone_?code|zoning_?code|zone_?class|zoning_?class|base_?zone|basezoning|zoningdist|zoning_?district|zdist|zcode|dist_?code|newzone|udo(?:_?label)?)$/i;
// Weaker structural hints when nothing strong matches.
const CODE_LOOSE_RE = /\b(zon|zone|district|class|dist|category|type|code)\b|^zn|zclass|zcode/i;
// Fields that are never the zoning code.
const EXCLUDED_RE = /desc|definition|name|label|jurisdiction|jur\b|muni|city|town|county|date|year|owner|acre|area|shape|object|globalid|fid|_id$|^id$|url|link|hyperlink|edit|created|last_?edit|source|gis|perimeter|len(gth)?|st_?area|st_?length/i;
// Human-readable district description fields.
const DESC_RE = /desc|definition|decode|long_?name|zone_?gen|zoning_?name|zone_?name|district_?name|udo_?legend|category_?name/i;
// Jurisdiction / governing-authority fields.
const JUR_RE = /jurisdiction|jur\b|muni|municipal|city|town|authority|govern|planning_?area/i;
// Overlay / special-district fields.
const OVERLAY_RE = /overlay|special_?district|historic_?overlay|conditional|ovl\b/i;

function fieldText(field: ArcgisField): string {
  return `${field.name} ${field.alias ?? ''}`;
}

/** Fields that hold short, code-like string values are better zoning-code
 *  candidates than long text or numeric fields. */
function isStringLike(field: ArcgisField): boolean {
  return /string/i.test(field.type);
}

function scoreCodeField(
  field: ArcgisField,
  displayField: string | undefined,
  rendererField: string | undefined,
  reasons: string[],
): number {
  const text = fieldText(field);
  if (EXCLUDED_RE.test(field.name)) return 0;
  let score = 0;
  if (CODE_STRONG_RE.test(field.name)) {
    score += 6;
    reasons.push(`"${field.name}" matches a strong zoning-code name`);
  } else if (CODE_STRONG_RE.test(field.alias ?? '')) {
    score += 4;
    reasons.push(`alias of "${field.name}" matches a strong zoning-code name`);
  } else if (CODE_LOOSE_RE.test(text)) {
    score += 2;
  } else {
    return 0;
  }
  if (rendererField && field.name.toLowerCase() === rendererField.toLowerCase()) {
    score += 4;
    reasons.push(`"${field.name}" is the renderer classification field`);
  }
  if (displayField && field.name.toLowerCase() === displayField.toLowerCase()) {
    score += 2;
    reasons.push(`"${field.name}" is the layer display field`);
  }
  if (isStringLike(field)) score += 1;
  return score;
}

function bestByRegex(fields: ArcgisField[], re: RegExp): string | null {
  const hit = fields.find((f) => re.test(f.name) && !/shape|object|globalid|_id$/i.test(f.name));
  return hit ? hit.name : null;
}

export function detectFieldMapping(meta: ArcgisLayerMetadata): FieldMapping {
  const fields = (meta.fields ?? []).filter((f): f is ArcgisField => !!f && typeof f.name === 'string');
  const reasons: string[] = [];
  const rendererField = meta.drawingInfo?.renderer?.field1 ?? meta.drawingInfo?.renderer?.field;
  const displayField = meta.displayField;

  let zoningCodeField: string | null = null;
  let bestScore = 0;
  for (const field of fields) {
    const s = scoreCodeField(field, displayField, rendererField, reasons);
    if (s > bestScore) {
      bestScore = s;
      zoningCodeField = field.name;
    }
  }

  const zoningDescriptionField = bestByRegex(fields, DESC_RE);
  const jurisdictionField = bestByRegex(fields, JUR_RE);
  const overlayField = bestByRegex(fields, OVERLAY_RE);

  // Confidence scales with the winning code-field score (max ~13).
  const detectionConfidence = zoningCodeField ? Math.min(1, bestScore / 10) : 0;
  if (!zoningCodeField) reasons.push('no field scored as a zoning-code field');

  return {
    zoningCodeField,
    zoningDescriptionField: zoningDescriptionField && zoningDescriptionField !== zoningCodeField ? zoningDescriptionField : null,
    jurisdictionField,
    overlayField,
    detectionConfidence,
    reasons,
  };
}
