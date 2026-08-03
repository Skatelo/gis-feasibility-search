// ---------------------------------------------------------------------------
// UTILITY EVIDENCE FROM GIS (spec section 12)
//
// A county parcel layer cannot prove utility availability, and the distinction
// matters in money: being inside a sewer district is NOT the same as having a
// sewer tap. One is a planning boundary, the other is installed infrastructure,
// and a buyer who confuses them can be tens of thousands of dollars wrong.
//
// So each finding carries the strength of the evidence behind it, and the
// strongest claim this module will ever make from spatial data alone is
// "inside-service-area" or "main-adjacent" — never "connected". Only a utility
// record can establish that, and this module does not have one.
// ---------------------------------------------------------------------------

/** Ordered weakest to strongest so callers can compare and merge findings. */
export const UTILITY_CONFIDENCE_ORDER = [
  'unknown',
  'not-found',
  'nearby-only',
  'inside-service-area',
  'main-adjacent',
  'parcel-connected',
  'confirmed-by-utility-record',
] as const;

export type UtilityConfidence = typeof UTILITY_CONFIDENCE_ORDER[number];

export type UtilityKind = 'water' | 'sewer';

export type UtilityLayerRole =
  | 'water-service-area' | 'sewer-service-area'
  | 'water-main' | 'sewer-main'
  | 'utility-district';

export interface UtilityFinding {
  kind: UtilityKind;
  /** What the spatial evidence supports — never an assertion of a tap. */
  status: 'inside-service-area' | 'main-adjacent' | 'nearby-only' | 'not-found' | 'unknown';
  confidence: UtilityConfidence;
  provider?: string;
  distanceFt?: number;
  sourceUrl?: string;
  layerName?: string;
  /** Plain-language caveat shown with the number, so the limit travels with it. */
  caveat: string;
}

export function strongerConfidence(a: UtilityConfidence, b: UtilityConfidence): UtilityConfidence {
  return UTILITY_CONFIDENCE_ORDER.indexOf(a) >= UTILITY_CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

// --- layer classification --------------------------------------------------

// Separators are normalised to spaces before matching, so every multi-word
// pattern has to allow one. Writing `force_?main` silently failed to match
// "Force Main" and the layer was classified as nothing at all.
const S = '[\\s_-]*';
const SEWER_RE = new RegExp(`sewer|wastewater|waste${S}water|septic${S}district|gravity|force${S}main|lift${S}station|collection${S}system`, 'i');
const WATER_RE = new RegExp(`\\bwater\\b|potable|distribution|hydrant|water${S}main`, 'i');
const SERVICE_AREA_RE = new RegExp(`service${S}area|district|boundary|franchise|coverage|utility${S}area|\\bpsd\\b|public${S}service`, 'i');
// Physical infrastructure — pipes and the fittings on them. Laterals, valves,
// manholes and network structures are equipment, NOT a service-area boundary,
// and must not be allowed to produce an "inside-service-area" claim.
const MAIN_RE = /main|line|pipe|gravity|force|distribution|collection|lateral|valve|manhole|structure|network|pump|hydrant/i;

// Not a potable/sanitary utility. Road-closure layers are the trap found live:
// Dorchester publishes "Road Blocks from water" and "Roads Closed from Water",
// which matched \bwater\b and were being read as a water service area — a
// flooding layer implying the parcel has public water.
const EXCLUDE_RE = new RegExp(
  `storm|drain|irrigation|reclaim|reuse|well${S}head|watershed|water${S}bod(y|ies)|water${S}way|flood`
  + `|road|street${S}clos|clos(ed|ure)|block|traffic|detour|incident`,
  'i',
);

/**
 * What role does this layer play, if any? Returns null for layers that only
 * look utility-ish — stormwater and watersheds are the common false positives
 * and would otherwise be read as sanitary sewer.
 */
export function classifyUtilityLayer(name: string): UtilityLayerRole | null {
  const text = String(name || '').replace(/[_-]+/g, ' ').trim();
  if (!text || EXCLUDE_RE.test(text)) return null;

  const isSewer = SEWER_RE.test(text);
  const isWater = WATER_RE.test(text);
  if (!isSewer && !isWater) {
    return SERVICE_AREA_RE.test(text) && /utilit/i.test(text) ? 'utility-district' : null;
  }
  // Service area beats main when a name claims both ("Water Service Area Mains"
  // is a boundary layer far more often than a pipe layer).
  if (SERVICE_AREA_RE.test(text)) return isSewer ? 'sewer-service-area' : 'water-service-area';
  if (MAIN_RE.test(text)) return isSewer ? 'sewer-main' : 'water-main';
  // Defaulting an unrecognised water/sewer name to "service area" was wrong: a
  // service area is the claim that drives availability, so anything merely
  // utility-flavoured would have asserted coverage. Unrecognised means unknown.
  return null;
}

// --- spatial queries -------------------------------------------------------

const METERS_PER_FOOT = 0.3048;
/** Beyond this a main is not meaningfully "at the street" for a connection. */
export const MAIN_ADJACENT_FT = 300;
/** Still worth reporting, but only as a hint. */
export const MAIN_NEARBY_FT = 1000;

interface QueryDeps {
  fetchJson: (url: string) => Promise<any>;
}

const PROVIDER_FIELDS = ['PROVIDER', 'AGENCY', 'UTILITY', 'SYSTEM_NAME', 'NAME', 'DISTRICT', 'OPERATOR', 'OWNER'];

function providerName(attributes: Record<string, unknown> | undefined): string | undefined {
  if (!attributes) return undefined;
  const lower = new Map(Object.keys(attributes).map((k) => [k.toLowerCase(), k]));
  for (const candidate of PROVIDER_FIELDS) {
    const key = lower.get(candidate.toLowerCase());
    if (!key) continue;
    const text = String(attributes[key] ?? '').trim();
    if (text && text.toLowerCase() !== 'null') return text;
  }
  return undefined;
}

/** Is the point inside a service-area polygon? */
export async function serviceAreaAtPoint(
  layerUrl: string,
  lng: number,
  lat: number,
  deps: QueryDeps,
): Promise<{ inside: boolean; provider?: string; attributes?: Record<string, unknown> }> {
  const params = new URLSearchParams({
    f: 'json', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', resultRecordCount: '1',
  });
  const data = await deps.fetchJson(`${layerUrl}/query?${params}`);
  const attributes = data?.features?.[0]?.attributes;
  return { inside: !!attributes, provider: providerName(attributes), attributes };
}

/**
 * Distance from the point to the nearest main, in feet.
 *
 * Uses a distance-bounded query rather than fetching geometry and measuring
 * locally: the server does the spatial work and returns only what is in range.
 */
export async function nearestMainDistanceFt(
  layerUrl: string,
  lng: number,
  lat: number,
  deps: QueryDeps,
  maxFt = MAIN_NEARBY_FT,
): Promise<{ distanceFt?: number; provider?: string }> {
  for (const ft of [MAIN_ADJACENT_FT, maxFt].filter((v, i, a) => a.indexOf(v) === i && v <= maxFt)) {
    const params = new URLSearchParams({
      f: 'json', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', distance: String(ft * METERS_PER_FOOT), units: 'esriSRUnit_Meter',
      outFields: '*', returnGeometry: 'false', resultRecordCount: '1',
    });
    const data = await deps.fetchJson(`${layerUrl}/query?${params}`);
    const attributes = data?.features?.[0]?.attributes;
    // The buffer that matched bounds the distance; we do not claim more
    // precision than the query actually establishes.
    if (attributes) return { distanceFt: ft, provider: providerName(attributes) };
  }
  return {};
}

// --- findings --------------------------------------------------------------

const CAVEATS: Record<UtilityFinding['status'], string> = {
  'inside-service-area': 'Inside the provider\'s service area. That is a planning boundary, not proof a tap or line reaches this parcel — confirm with the utility before budgeting.',
  'main-adjacent': 'A main is mapped near this parcel. Proximity is not a connection: the tap, easement and capacity all still have to be confirmed with the utility.',
  'nearby-only': 'Infrastructure is mapped in the vicinity but not at this parcel. Treat as a hint only.',
  'not-found': 'No mapped service area or main found at this location. Plan for a private well or septic system unless the utility says otherwise.',
  unknown: 'No utility layer was available for this county, so availability could not be established either way.',
};

export function utilityFinding(input: {
  kind: UtilityKind;
  insideServiceArea?: boolean;
  distanceFt?: number;
  provider?: string;
  sourceUrl?: string;
  layerName?: string;
  hadLayer?: boolean;
}): UtilityFinding {
  const { kind, insideServiceArea, distanceFt, provider, sourceUrl, layerName, hadLayer = true } = input;

  let status: UtilityFinding['status'];
  if (!hadLayer) status = 'unknown';
  else if (distanceFt != null && distanceFt <= MAIN_ADJACENT_FT) status = 'main-adjacent';
  else if (insideServiceArea) status = 'inside-service-area';
  else if (distanceFt != null && distanceFt <= MAIN_NEARBY_FT) status = 'nearby-only';
  else status = 'not-found';

  // Confidence deliberately tops out at main-adjacent. Spatial data cannot
  // establish parcel-connected or a utility record; claiming either from a map
  // would be the exact overstatement this module exists to prevent.
  const confidence: UtilityConfidence =
    status === 'main-adjacent' ? 'main-adjacent'
      : status === 'inside-service-area' ? 'inside-service-area'
        : status === 'nearby-only' ? 'nearby-only'
          : status === 'not-found' ? 'not-found'
            : 'unknown';

  return { kind, status, confidence, provider, distanceFt, sourceUrl, layerName, caveat: CAVEATS[status] };
}

/** Warnings for the report, so the limits travel with the numbers. */
export function utilityWarnings(findings: UtilityFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    if (f.status === 'inside-service-area') {
      out.push(`${f.kind === 'water' ? 'Water' : 'Sewer'} service-area coverage does not confirm an installed tap.`);
    }
    if (f.status === 'main-adjacent') {
      out.push(`A ${f.kind} main is mapped within ~${f.distanceFt} ft, but proximity does not confirm a connection or available capacity.`);
    }
    if (f.status === 'unknown') {
      out.push(`No ${f.kind} utility layer was available for this county — availability is unestablished, not absent.`);
    }
  }
  return [...new Set(out)];
}
