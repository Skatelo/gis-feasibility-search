export { CensusGeocoder } from './census-geocoder';
export { GoogleGeocoder } from './google-geocoder';
export { ChainGeocoder } from './chain-geocoder';

import type { Geocoder } from '../types';
import { CensusGeocoder } from './census-geocoder';
import { GoogleGeocoder } from './google-geocoder';
import { ChainGeocoder } from './chain-geocoder';

export interface GeocoderConfig {
  googleMapsApiKey?: string;
  mapboxAccessToken?: string;
  arcgisApiKey?: string;
}

/** Assemble the default provider chain from whatever credentials are present.
 *  Google first for precision, Census always last as the keyless fallback. */
export function createGeocoder(config: GeocoderConfig = {}): Geocoder {
  const providers: Geocoder[] = [];
  if (config.googleMapsApiKey?.trim()) providers.push(new GoogleGeocoder(config.googleMapsApiKey.trim()));
  providers.push(new CensusGeocoder());
  return new ChainGeocoder(providers);
}
