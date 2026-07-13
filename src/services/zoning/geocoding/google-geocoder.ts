// Google Geocoding API provider.
//
// Highest address precision (ROOFTOP), used as the primary geocoder when a key
// is configured; the keyless Census geocoder is the fallback and the source of
// authoritative jurisdiction geographies. The key is injected (DI) so the engine
// never reaches into app-specific key storage.

import { z } from 'zod';
import type { Geocoder, GeocodedAddress } from '../types';
import { buildUrl, fetchJson } from '../utils/http';

const BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

const Component = z.object({
  long_name: z.string(),
  short_name: z.string(),
  types: z.array(z.string()),
});
const Result = z.object({
  formatted_address: z.string(),
  partial_match: z.boolean().optional(),
  geometry: z.object({
    location: z.object({ lat: z.number(), lng: z.number() }),
    location_type: z.string().optional(),
  }),
  address_components: z.array(Component),
});
const GoogleResponse = z.object({
  status: z.string(),
  error_message: z.string().optional(),
  results: z.array(Result),
});

function component(components: z.infer<typeof Component>[], type: string): z.infer<typeof Component> | undefined {
  return components.find((c) => c.types.includes(type));
}

function mapLocationType(value: string | undefined): GeocodedAddress['locationType'] {
  switch (value) {
    case 'ROOFTOP':
      return 'rooftop';
    case 'RANGE_INTERPOLATED':
      return 'interpolated';
    case 'GEOMETRIC_CENTER':
      return 'approximate';
    case 'APPROXIMATE':
      return 'locality';
    default:
      return 'unknown';
  }
}

function toGeocoded(result: z.infer<typeof Result>, inputAddress: string): GeocodedAddress {
  const comps = result.address_components;
  const state = component(comps, 'administrative_area_level_1');
  const county = component(comps, 'administrative_area_level_2');
  // Municipality precedence: incorporated locality first, then the smaller
  // civil divisions. The postal "city" is intentionally NOT trusted as the
  // zoning authority — the jurisdiction resolver confirms via boundaries.
  const municipality =
    component(comps, 'locality') ||
    component(comps, 'administrative_area_level_3') ||
    component(comps, 'sublocality') ||
    component(comps, 'administrative_area_level_2');
  return {
    inputAddress,
    formattedAddress: result.formatted_address,
    latitude: result.geometry.location.lat,
    longitude: result.geometry.location.lng,
    state: state?.long_name,
    stateCode: state?.short_name,
    county: county?.long_name,
    municipality: municipality?.long_name,
    postalCode: component(comps, 'postal_code')?.long_name,
    country: component(comps, 'country')?.short_name || 'US',
    locationType: mapLocationType(result.geometry.location_type),
    partialMatch: result.partial_match ?? false,
    provider: 'google',
    raw: result,
  };
}

export class GoogleGeocoder implements Geocoder {
  readonly name = 'google';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  private async request(params: Record<string, string | number>, signal?: AbortSignal): Promise<GeocodedAddress> {
    const url = buildUrl(BASE, { ...params, key: this.apiKey });
    const data = GoogleResponse.parse(await fetchJson(url, { signal, timeoutMs: 5000 }));
    if (data.status === 'ZERO_RESULTS' || data.results.length === 0) {
      throw new Error(`Google geocoder found no match (${data.status})`);
    }
    if (data.status !== 'OK') {
      throw new Error(`Google geocoder error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    }
    return toGeocoded(data.results[0], String(params.address ?? `${params.latlng ?? ''}`));
  }

  geocode(address: string, signal?: AbortSignal): Promise<GeocodedAddress> {
    return this.request({ address }, signal);
  }

  reverseGeocode(latitude: number, longitude: number, signal?: AbortSignal): Promise<GeocodedAddress> {
    return this.request({ latlng: `${latitude},${longitude}` }, signal);
  }
}
