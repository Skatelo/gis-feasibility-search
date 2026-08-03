// ---------------------------------------------------------------------------
// NORMALIZED PROPERTY RESPONSE (spec section 16)
//
// One shape for NC and SC. Counties differ wildly in what they publish, so the
// contract is that every field is explicitly nullable and every claim carries
// its provenance: which agency said it, when it was retrieved, and how strong
// the evidence is.
//
// Two rules the shape enforces rather than merely documents:
//   1. A missing value is null, never a plausible-looking default. A guessed
//      acreage or fee is worse than a blank one.
//   2. Limits travel WITH the number. Warnings are assembled from the findings
//      themselves, so a caveat cannot be dropped on the way to the UI or PDF.
// ---------------------------------------------------------------------------

import type { UtilityConfidence, UtilityFinding } from './sc/utilityEvidence';
import { utilityWarnings } from './sc/utilityEvidence';

export type StateCode = 'NC' | 'SC';

export type ZoningConfidence =
  | 'direct-spatial-match'      // the parcel point fell inside a zoning polygon
  | 'jurisdiction-inferred'     // right authority, district not spatially proven
  | 'public-record'             // assessor/public record, base district only
  | 'research'                  // source-backed web research
  | 'unresolved';

export interface ReportSource {
  agency: string;
  type: 'parcel' | 'zoning' | 'utility' | 'public-record' | 'research';
  url?: string;
  retrievedAt: string;
}

export interface NormalizedParcel {
  parcelId: string | null;
  taxMapNumber: string | null;
  ownerName: string | null;
  ownerMailingAddress: string | null;
  propertyAddress: string | null;
  acreage: number | null;
  legalDescription: string | null;
  landValue: number | null;
  improvementValue: number | null;
  assessedValue: number | null;
  marketValue: number | null;
  propertyClass: string | null;
}

export interface NormalizedZoning {
  code: string | null;
  description: string | null;
  /** WHO controls zoning here — a city district must not be attributed to the
   *  county, or the reader calls the wrong planning department. */
  jurisdiction: string | null;
  jurisdictionType: 'county' | 'city' | 'town' | null;
  confidence: ZoningConfidence;
  /** True when the parcel sits inside a municipality but only the county layer
   *  answered — reportable, but weaker than the city's own district. */
  municipalLayerMissing?: boolean;
  ordinanceUrl?: string;
}

export interface NormalizedUtility {
  status: UtilityFinding['status'];
  confidence: UtilityConfidence;
  provider?: string;
  distanceFt?: number;
}

export interface NormalizedPropertyReport {
  inputAddress: string;
  normalizedAddress: string;
  coordinates: { latitude: number; longitude: number } | null;
  state: StateCode;
  county: string | null;
  municipality: string | null;
  parcel: NormalizedParcel;
  zoning: NormalizedZoning;
  utilities: { water: NormalizedUtility; sewer: NormalizedUtility };
  sources: ReportSource[];
  warnings: string[];
  generatedAt: string;
}

const EMPTY_PARCEL: NormalizedParcel = {
  parcelId: null, taxMapNumber: null, ownerName: null, ownerMailingAddress: null,
  propertyAddress: null, acreage: null, legalDescription: null, landValue: null,
  improvementValue: null, assessedValue: null, marketValue: null, propertyClass: null,
};

const numberOrNull = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

const textOrNull = (value: unknown): string | null => {
  const s = String(value ?? '').trim();
  return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'n/a' ? s : null;
};

/** Utility findings reduced to the response shape. */
function toUtility(finding: UtilityFinding | undefined): NormalizedUtility {
  if (!finding) return { status: 'unknown', confidence: 'unknown' };
  return {
    status: finding.status,
    confidence: finding.confidence,
    ...(finding.provider ? { provider: finding.provider } : {}),
    ...(finding.distanceFt != null ? { distanceFt: finding.distanceFt } : {}),
  };
}

/**
 * Assemble the response. Warnings are DERIVED, not passed in — so a limitation
 * discovered by the utility or zoning logic cannot be lost by a caller that
 * forgets to forward it.
 */
export function buildPropertyReport(input: {
  inputAddress: string;
  normalizedAddress?: string;
  state: StateCode;
  county?: string | null;
  municipality?: string | null;
  coordinates?: { latitude: number; longitude: number } | null;
  parcel?: Partial<NormalizedParcel> | null;
  zoning?: Partial<NormalizedZoning> | null;
  utilityFindings?: UtilityFinding[];
  sources?: ReportSource[];
  extraWarnings?: string[];
}): NormalizedPropertyReport {
  const findings = input.utilityFindings ?? [];
  const zoning: NormalizedZoning = {
    code: textOrNull(input.zoning?.code),
    description: textOrNull(input.zoning?.description),
    jurisdiction: textOrNull(input.zoning?.jurisdiction),
    jurisdictionType: input.zoning?.jurisdictionType ?? null,
    confidence: input.zoning?.confidence ?? 'unresolved',
    ...(input.zoning?.municipalLayerMissing ? { municipalLayerMissing: true } : {}),
    ...(input.zoning?.ordinanceUrl ? { ordinanceUrl: input.zoning.ordinanceUrl } : {}),
  };

  const warnings = [...utilityWarnings(findings), ...(input.extraWarnings ?? [])];

  // Zoning caveats are generated here for the same reason as utility ones: the
  // reader needs the limit attached to the value, not buried in a status enum.
  if (zoning.municipalLayerMissing) {
    warnings.push(`This parcel is inside ${zoning.jurisdiction ?? 'a municipality'}, but only the county zoning layer answered. The city may set a different district — confirm with its planning department.`);
  }
  if (zoning.confidence === 'public-record') {
    warnings.push('Zoning came from public records as a BASE district. Conditional-use and frontage suffixes may be missing; confirm against the adopted ordinance.');
  }
  if (zoning.confidence === 'research' || zoning.confidence === 'unresolved') {
    warnings.push('Zoning was not confirmed against an official GIS layer. Verify the district and permitted use with the controlling planning department.');
  }
  if (!zoning.code) {
    warnings.push('No zoning district could be established for this parcel from any source.');
  }

  return {
    inputAddress: input.inputAddress,
    normalizedAddress: input.normalizedAddress || input.inputAddress.toUpperCase(),
    coordinates: input.coordinates ?? null,
    state: input.state,
    county: textOrNull(input.county),
    municipality: textOrNull(input.municipality),
    parcel: {
      ...EMPTY_PARCEL,
      ...Object.fromEntries(Object.entries(input.parcel ?? {}).map(([k, v]) => [
        k,
        ['acreage', 'landValue', 'improvementValue', 'assessedValue', 'marketValue'].includes(k)
          ? numberOrNull(v)
          : textOrNull(v),
      ])),
    },
    zoning,
    utilities: {
      water: toUtility(findings.find((f) => f.kind === 'water')),
      sewer: toUtility(findings.find((f) => f.kind === 'sewer')),
    },
    sources: input.sources ?? [],
    warnings: [...new Set(warnings)],
    generatedAt: new Date().toISOString(),
  };
}
