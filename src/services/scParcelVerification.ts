import { scCountySource } from '../data/scCountySources';

export type ParcelVerificationStatus = 'verified' | 'unavailable' | 'blocked';

export interface OfficialScParcelRecord {
  status: ParcelVerificationStatus;
  sourceUrl: string;
  sourceName?: string;
  asOf?: string;
  parcelId?: string;
  normalizedParcelId?: string;
  situsAddress?: string;
  ownerName?: string;
  ownerRecordType?: 'assessor' | 'deed';
  mailingAddress?: string;
  acres?: number;
  assessedYear?: number;
  assessedPropertyValue?: number;
  totalAssessedValue?: number;
  landValue?: number;
  improvementValue?: number;
  marketValue?: number;
  taxableValue?: number;
  taxCodeArea?: string;
  taxAmount?: number;
  taxYear?: number;
  building?: {
    livingSqft?: number;
    firstFloorSqft?: number;
    buildingSqft?: number;
    buildingCount?: number;
    stories?: number;
    baths?: number;
  };
}

export function normalizeScParcelId(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function parcelIdsMatch(left: unknown, right: unknown): boolean {
  const a = normalizeScParcelId(left);
  const b = normalizeScParcelId(right);
  return !!a && !!b && a === b;
}

export function shouldHideStatewideGeometry(statewideParcelId: unknown, officialParcelId: unknown): boolean {
  const statewide = normalizeScParcelId(statewideParcelId);
  const official = normalizeScParcelId(officialParcelId);
  return !!statewide && !!official && statewide !== official;
}

export async function fetchOfficialScParcel(
  countyName: string,
  address: string,
  parcelId: string,
  coordinates: { lat: number; lng: number },
  fetcher: typeof fetch = fetch,
): Promise<OfficialScParcelRecord | null> {
  const source = scCountySource(countyName);
  if (!source) return null;
  try {
    const result = await fetcher('/.netlify/functions/sc-parcel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        county: source.county,
        fips: source.fips,
        address,
        parcelId,
        coordinates,
        portalUrl: source.portalUrl,
        alternateUrl: source.alternateUrl,
      }),
    });
    if (!result.ok) return { status: 'unavailable', sourceUrl: source.portalUrl };
    const payload = await result.json();
    return payload?.data || null;
  } catch {
    return { status: 'unavailable', sourceUrl: source.portalUrl };
  }
}
