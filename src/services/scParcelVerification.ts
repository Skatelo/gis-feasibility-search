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

function cleanText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text && text.toUpperCase() !== 'N/A' && text.toLowerCase() !== 'null' ? text : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Promote a successful county ArcGIS point query to an official tax-roll record.
 * This keeps a blocked assessor portal from erasing data the county already
 * published through its own structured GIS service. */
export function officialRecordFromCountyGis(
  countyName: string,
  attributes: Record<string, unknown>,
): OfficialScParcelRecord | null {
  if (attributes.recordsource !== 'county-gis') return null;
  const source = scCountySource(countyName);
  if (!source) return null;

  const parcelId = cleanText(attributes.parno);
  const owner1 = cleanText(attributes.ownname);
  const owner2 = cleanText(attributes.ownname2);
  const ownerName = [owner1, owner2].filter(Boolean).join(' & ') || undefined;
  const situsAddress = cleanText(attributes.siteadd);
  if (!parcelId && !ownerName && !situsAddress) return null;

  const mailingAddress = cleanText(attributes.officialmailingaddress) || [
    cleanText(attributes.mailadd),
    cleanText(attributes.mcity),
    [cleanText(attributes.mstate), cleanText(attributes.mzip)].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ') || undefined;

  return {
    status: 'verified',
    sourceUrl: source.portalUrl,
    sourceName: `${source.county} County GIS tax roll`,
    parcelId,
    normalizedParcelId: parcelId ? normalizeScParcelId(parcelId) : undefined,
    situsAddress,
    ownerName,
    ownerRecordType: ownerName ? 'assessor' : undefined,
    mailingAddress,
    acres: cleanNumber(attributes.gisacres),
    assessedYear: cleanNumber(attributes.reviseyear),
    assessedPropertyValue: cleanNumber(attributes.parval),
    totalAssessedValue: cleanNumber(attributes.totalassessedvalue),
    landValue: cleanNumber(attributes.landval),
    improvementValue: cleanNumber(attributes.improvementvalue),
    marketValue: cleanNumber(attributes.marketvalue),
    taxableValue: cleanNumber(attributes.taxablevalue),
    taxCodeArea: cleanText(attributes.taxcodearea),
    taxAmount: cleanNumber(attributes.taxamount),
    taxYear: cleanNumber(attributes.taxyear),
    building: attributes.building as OfficialScParcelRecord['building'],
  };
}

/** Prefer the assessor/browser response, but fill any omitted fields from the
 * county GIS record. A blocked secondary portal never downgrades a verified
 * structured county result. */
export function mergeOfficialScParcelRecords(
  remote: OfficialScParcelRecord | null,
  countyGis: OfficialScParcelRecord | null,
): OfficialScParcelRecord | null {
  if (remote?.status !== 'verified') return countyGis || remote;
  if (!countyGis) return remote;
  const definedRemote = Object.fromEntries(
    Object.entries(remote).filter(([, value]) => value !== undefined),
  ) as Partial<OfficialScParcelRecord>;
  return {
    ...countyGis,
    ...definedRemote,
    status: 'verified',
    building: {
      ...(countyGis.building || {}),
      ...(remote.building || {}),
    },
  };
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
