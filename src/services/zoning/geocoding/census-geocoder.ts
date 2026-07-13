// U.S. Census Bureau geocoder — keyless, authoritative for jurisdiction.
//
// The `geographies` endpoint returns coordinates AND the Census geographies the
// point falls in (state, county, county subdivision, incorporated place), which
// is exactly what the jurisdiction resolver needs — and it needs no API key, so
// it is the default provider and the one used in tests.

import { z } from 'zod';
import type { Geocoder, GeocodedAddress } from '../types';
import { buildUrl, fetchJson } from '../utils/http';

const GEOGRAPHIES_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const REVERSE_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';

const GeographyEntry = z.object({ NAME: z.string().optional(), BASENAME: z.string().optional() }).passthrough();

const AddressMatch = z.object({
  matchedAddress: z.string().optional(),
  coordinates: z.object({ x: z.number(), y: z.number() }),
  geographies: z.record(z.string(), z.array(GeographyEntry)).optional(),
  addressComponents: z
    .object({
      state: z.string().optional(),
      zip: z.string().optional(),
      city: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const CensusResponse = z.object({
  result: z.object({ addressMatches: z.array(AddressMatch) }),
});

/** Census geography layer names vary slightly by vintage — match loosely. */
function pickGeography(
  geographies: Record<string, z.infer<typeof GeographyEntry>[]> | undefined,
  test: RegExp,
): string | undefined {
  if (!geographies) return undefined;
  for (const [layerName, rows] of Object.entries(geographies)) {
    if (test.test(layerName) && rows.length > 0) {
      return (rows[0].BASENAME || rows[0].NAME || '').trim() || undefined;
    }
  }
  return undefined;
}

const STATE_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH',
  'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
  Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

function toGeocoded(match: z.infer<typeof AddressMatch>, inputAddress: string): GeocodedAddress {
  const geo = match.geographies;
  const stateName = pickGeography(geo, /^states?$/i);
  const county = pickGeography(geo, /^count(y|ies)$/i);
  // "Incorporated Places" = municipality; absent for unincorporated points.
  const municipality = pickGeography(geo, /incorporated places|census designated|^places?$/i);
  const stateCode = stateName ? STATE_ABBR[stateName] : match.addressComponents?.state;
  return {
    inputAddress,
    formattedAddress: match.matchedAddress || inputAddress,
    latitude: match.coordinates.y,
    longitude: match.coordinates.x,
    state: stateName,
    stateCode,
    county: county ? (/county$/i.test(county) ? county : `${county} County`) : undefined,
    municipality,
    postalCode: match.addressComponents?.zip,
    country: 'US',
    // Census returns rooftop/parcel-quality matches for a successful hit.
    locationType: 'rooftop',
    partialMatch: false,
    provider: 'census',
    raw: match,
  };
}

export class CensusGeocoder implements Geocoder {
  readonly name = 'census';

  isConfigured(): boolean {
    return true; // keyless
  }

  async geocode(address: string, signal?: AbortSignal): Promise<GeocodedAddress> {
    const url = buildUrl(GEOGRAPHIES_BASE, {
      address,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      format: 'json',
    });
    const parsed = CensusResponse.parse(await fetchJson(url, { signal, timeoutMs: 6000 }));
    const match = parsed.result.addressMatches[0];
    if (!match) throw new Error(`Census geocoder found no match for "${address}"`);
    return toGeocoded(match, address);
  }

  async reverseGeocode(latitude: number, longitude: number, signal?: AbortSignal): Promise<GeocodedAddress> {
    const url = buildUrl(REVERSE_BASE, {
      x: longitude,
      y: latitude,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      format: 'json',
    });
    // The coordinates endpoint returns geographies without addressMatches; shape
    // it into the same result envelope the geocode path uses.
    const raw = await fetchJson<{ result?: { geographies?: Record<string, z.infer<typeof GeographyEntry>[]> } }>(url, {
      signal,
      timeoutMs: 6000,
    });
    const geographies = raw.result?.geographies;
    const synthetic: z.infer<typeof AddressMatch> = {
      coordinates: { x: longitude, y: latitude },
      geographies,
      matchedAddress: undefined,
    };
    return toGeocoded(synthetic, `${latitude},${longitude}`);
  }
}
