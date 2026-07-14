// Confidence scoring — a transparent 0..100 breakdown so a caller can see why a
// result is (or isn't) trustworthy. Never reports high confidence when the
// jurisdiction or source is uncertain.

import type {
  ConfidenceBreakdown,
  GeocodedAddress,
  JurisdictionResult,
  ParcelResult,
  DiscoveredSource,
} from '../types';

export interface ConfidenceInputs {
  address: GeocodedAddress | null;
  jurisdiction: JurisdictionResult;
  parcel: ParcelResult | null;
  zoningFound: boolean;
  /** How the zoning polygon was queried. */
  zoningMatchQuality: 'parcel-polygon-intersect' | 'interior-point' | 'geocode-point' | 'pdf-or-html' | 'none';
  source: DiscoveredSource | null;
  /** Set when the source came from a verified registry record. */
  sourceFromRegistry?: boolean;
}

function addressScore(address: GeocodedAddress | null, warnings: string[], reasons: string[]): number {
  if (!address) return 0;
  const base: Record<string, number> = { rooftop: 95, parcel: 95, interpolated: 78, approximate: 60, locality: 40, unknown: 55 };
  let s = base[address.locationType ?? 'unknown'] ?? 55;
  if (address.partialMatch) {
    s -= 20;
    warnings.push('geocoder returned a partial address match');
  }
  reasons.push(`address geocode: ${address.locationType ?? 'unknown'} (${address.provider})`);
  return Math.max(0, Math.min(100, s));
}

function jurisdictionScore(j: JurisdictionResult, warnings: string[], reasons: string[]): number {
  const s = j.confidence; // resolver already scores geometry vs geocoder-field
  if (s < 60) warnings.push('governing jurisdiction is not boundary-confirmed');
  reasons.push(`jurisdiction: ${j.jurisdictionType} (${j.zoningAuthority ?? 'unknown'}) @ ${s}`);
  return s;
}

function parcelScore(parcel: ParcelResult | null, reasons: string[]): number {
  if (!parcel) return 55; // no parcel verification attempted (point-based)
  switch (parcel.matchMethod) {
    case 'parcel-id':
      reasons.push('parcel matched by id');
      return 95;
    case 'contains-geocode-point':
      reasons.push('geocode point inside parcel');
      return 90;
    case 'nearest-parcel':
      reasons.push(`nearest parcel (${Math.round(parcel.distanceFromGeocodePointMeters ?? 0)} m)`);
      return 70;
    default:
      return 45;
  }
}

function zoningScore(found: boolean, quality: ConfidenceInputs['zoningMatchQuality'], warnings: string[], reasons: string[]): number {
  if (!found) {
    warnings.push('no official zoning polygon intersected the location');
    return 0;
  }
  const map: Record<ConfidenceInputs['zoningMatchQuality'], number> = {
    'parcel-polygon-intersect': 99,
    'interior-point': 92,
    'geocode-point': 80,
    'pdf-or-html': 45,
    none: 0,
  };
  reasons.push(`zoning match: ${quality}`);
  return map[quality];
}

function sourceScore(source: DiscoveredSource | null, fromRegistry: boolean, warnings: string[], reasons: string[]): number {
  if (!source) {
    warnings.push('no authoritative source identified');
    return 0;
  }
  let s: number;
  if (source.official) {
    const rest = /\/(MapServer|FeatureServer)\b/i.test(source.url);
    s = rest ? 96 : 82;
  } else {
    s = 45;
    warnings.push('zoning source is not verified as official government data');
  }
  if (fromRegistry) reasons.push('source reused from verified registry record');
  reasons.push(`source authority: ${source.official ? 'official' : 'unofficial'} (${source.sourceType})`);
  return s;
}

export function computeConfidence(inputs: ConfidenceInputs): ConfidenceBreakdown {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const addressMatch = addressScore(inputs.address, warnings, reasons);
  const jurisdictionMatch = jurisdictionScore(inputs.jurisdiction, warnings, reasons);
  const parcelMatch = parcelScore(inputs.parcel, reasons);
  const zoningMatch = zoningScore(inputs.zoningFound, inputs.zoningMatchQuality, warnings, reasons);
  const sourceAuthority = sourceScore(inputs.source, !!inputs.sourceFromRegistry, warnings, reasons);

  // Weighted blend. Zoning match and source authority dominate; a weak
  // jurisdiction or source caps the overall score so we never overstate.
  const weighted =
    addressMatch * 0.15 +
    jurisdictionMatch * 0.2 +
    parcelMatch * 0.1 +
    zoningMatch * 0.35 +
    sourceAuthority * 0.2;
  let overall = Math.round(weighted);
  // Hard caps: uncertain jurisdiction or source can never yield high confidence.
  if (jurisdictionMatch < 60) overall = Math.min(overall, 65);
  if (sourceAuthority < 60) overall = Math.min(overall, 60);
  if (!inputs.zoningFound) overall = Math.min(overall, 40);

  return {
    overall: Math.max(0, Math.min(100, overall)),
    addressMatch,
    jurisdictionMatch,
    parcelMatch,
    zoningMatch,
    sourceAuthority,
    reasons,
    warnings,
  };
}
