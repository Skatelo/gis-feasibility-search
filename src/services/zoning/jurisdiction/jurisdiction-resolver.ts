// Jurisdiction resolver — determines the governing zoning authority from
// authoritative boundaries, never from the mailing city.
//
// Signals, strongest first:
//   1. Point-in-polygon against the Census Incorporated Places layer (geometry).
//   2. Point-in-polygon against the County Subdivision (MCD) layer — the town or
//      township is the authority in strong-MCD states.
//   3. Geocoder jurisdiction fields (state/county/municipality).
//
// It classifies incorporated vs unincorporated and produces a confidence score
// plus evidence. It deliberately does NOT assert extraterritorial jurisdiction,
// joint-planning, special districts, or "no zoning" — those require the source
// discovery step to confirm, and the spec forbids claiming no-zoning from a
// single signal. Such cases resolve to the best-supported county/municipal
// authority with evidence, and the discovery layer refines the type later.

import type { GeocodedAddress, JurisdictionResult, JurisdictionType, SourceEvidence } from '../types';
import { incorporatedPlaceAtPoint, countySubdivisionAtPoint, type BoundaryHit } from './boundary-query';

// States where county subdivisions (MCDs) are commonly the governing local
// government for land use even absent an incorporated place.
const STRONG_MCD_STATES = new Set([
  'CT', 'ME', 'MA', 'MI', 'MN', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT', 'WI',
]);

export interface ResolveOptions {
  /** Skip live boundary queries and rely only on geocoder fields (fast path). */
  boundaryLookup?: boolean;
  signal?: AbortSignal;
}

function normalizeCounty(county: string | undefined | null): string | null {
  if (!county) return null;
  const trimmed = county.trim();
  if (!trimmed) return null;
  return /county$/i.test(trimmed) ? trimmed : `${trimmed} County`;
}

export async function resolveJurisdiction(
  geocoded: GeocodedAddress,
  options: ResolveOptions = {},
): Promise<JurisdictionResult> {
  const { boundaryLookup = true, signal } = options;
  const evidence: SourceEvidence[] = [];
  const stateCode = geocoded.stateCode ?? null;
  const county = normalizeCounty(geocoded.county);

  let place: BoundaryHit | null = null;
  let mcd: BoundaryHit | null = null;
  let boundaryConfirmed = false;

  if (boundaryLookup && Number.isFinite(geocoded.latitude) && Number.isFinite(geocoded.longitude)) {
    const [placeResult, mcdResult] = await Promise.allSettled([
      incorporatedPlaceAtPoint(geocoded.longitude, geocoded.latitude, signal),
      countySubdivisionAtPoint(geocoded.longitude, geocoded.latitude, signal),
    ]);
    if (placeResult.status === 'fulfilled') {
      place = placeResult.value;
      boundaryConfirmed = true;
      evidence.push({
        kind: 'boundary-intersection',
        detail: place
          ? `Point falls inside incorporated place "${place.name}" (Census Places layer)`
          : 'Point is outside every incorporated place (unincorporated per Census Places layer)',
        sourceUrl: (place ?? undefined)?.layerUrl,
        confidence: 0.95,
      });
    }
    if (mcdResult.status === 'fulfilled') mcd = mcdResult.value;
  }

  // Municipality precedence: confirmed incorporated place > MCD (strong-MCD
  // states) > geocoder-reported municipality.
  let municipality: string | null = place?.name ?? null;
  let incorporated: boolean | null = boundaryConfirmed ? place !== null : null;

  if (!municipality && mcd && stateCode && STRONG_MCD_STATES.has(stateCode)) {
    municipality = mcd.name;
    evidence.push({
      kind: 'boundary-intersection',
      detail: `Governing county subdivision "${mcd.name}" (strong-MCD state ${stateCode})`,
      sourceUrl: mcd.layerUrl,
      confidence: 0.8,
    });
  }

  if (!municipality && geocoded.municipality) {
    municipality = geocoded.municipality;
    evidence.push({
      kind: 'geocoder-field',
      detail: `Geocoder reported municipality "${geocoded.municipality}" (${geocoded.provider}); not boundary-confirmed`,
      confidence: 0.5,
    });
    if (incorporated === null) incorporated = null; // still unconfirmed
  }

  if (county) {
    evidence.push({
      kind: boundaryConfirmed ? 'boundary-intersection' : 'geocoder-field',
      detail: `County: ${county}`,
      confidence: boundaryConfirmed ? 0.9 : 0.6,
    });
  }

  // Jurisdiction type + authority.
  let jurisdictionType: JurisdictionType;
  let zoningAuthority: string | null;
  if (incorporated === true && municipality) {
    jurisdictionType = 'municipal';
    zoningAuthority = municipality;
  } else if (incorporated === false && county) {
    jurisdictionType = 'county';
    zoningAuthority = county;
  } else if (municipality) {
    // Municipality known but incorporation unconfirmed (geocoder-only).
    jurisdictionType = 'municipal';
    zoningAuthority = municipality;
  } else if (county) {
    jurisdictionType = 'county';
    zoningAuthority = county;
  } else {
    jurisdictionType = 'unknown';
    zoningAuthority = null;
  }

  // Confidence: geometry-confirmed jurisdiction scores high; geocoder-only
  // inference is capped in the medium band; missing county/state is penalized.
  let confidence: number;
  if (boundaryConfirmed && (municipality || county)) confidence = municipality ? 92 : 85;
  else if (municipality || county) confidence = 62;
  else confidence = 25;
  if (!stateCode) confidence = Math.min(confidence, 30);

  return {
    state: geocoded.state ?? null,
    stateCode,
    county,
    municipality,
    incorporated,
    zoningAuthority,
    jurisdictionType,
    confidence,
    evidence,
  };
}
