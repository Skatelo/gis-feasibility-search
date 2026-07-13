// Chain geocoder — tries each configured provider in order, returning the first
// success. Google (when keyed) gives ROOFTOP precision; Census is the keyless
// fallback and always available. A provider that isn't configured is skipped.

import type { Geocoder, GeocodedAddress } from '../types';

export class ChainGeocoder implements Geocoder {
  readonly name = 'chain';
  private readonly providers: Geocoder[];

  constructor(providers: Geocoder[]) {
    this.providers = providers.filter((p) => p.isConfigured());
    if (this.providers.length === 0) {
      throw new Error('ChainGeocoder requires at least one configured provider');
    }
  }

  isConfigured(): boolean {
    return this.providers.length > 0;
  }

  private async run(
    op: (p: Geocoder) => Promise<GeocodedAddress>,
  ): Promise<GeocodedAddress> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        return await op(provider);
      } catch (err) {
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`All geocoders failed — ${errors.join('; ')}`);
  }

  geocode(address: string, signal?: AbortSignal): Promise<GeocodedAddress> {
    return this.run((p) => p.geocode(address, signal));
  }

  reverseGeocode(latitude: number, longitude: number, signal?: AbortSignal): Promise<GeocodedAddress> {
    return this.run((p) => p.reverseGeocode(latitude, longitude, signal));
  }
}
