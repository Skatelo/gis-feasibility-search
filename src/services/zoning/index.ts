// Universal U.S. zoning lookup engine — public entry point.
//
// Assemble the engine with createZoningEngine() and call engine.lookup({ address }).
// Everything is jurisdiction-agnostic. Live lookups only use verified records
// already present in the source registry; discovery is maintenance-only.

export * from './types';
export { ZoningLookupEngine, type LookupMode } from './orchestrator';
export { createGeocoder, CensusGeocoder, GoogleGeocoder } from './geocoding';
export { resolveJurisdiction } from './jurisdiction';
export {
  SourceDiscoveryService,
  perplexitySearchProvider,
  crawleePageFetcher,
  httpPageFetcher,
  type SearchProvider,
  type PageFetcher,
} from './discovery';
export { createRegistry, createInMemoryRegistry, SourceHealthService, jurisdictionKey } from './registry';

import type { Logger, SourceRegistry } from './types';
import { createGeocoder } from './geocoding';
import { createRegistry } from './registry';
import { ZoningLookupEngine } from './orchestrator';
import type { GeocodedAddress, JurisdictionResult } from './types';

export interface CreateEngineConfig {
  googleMapsApiKey?: string;
  /** Override the persistence layer (defaults to browser Web Storage / memory). */
  registry?: SourceRegistry;
  /** Prefer a PostGIS-backed resolver in production. */
  jurisdictionResolver?: (address: GeocodedAddress, mode: 'fast' | 'verified' | 'deep') => Promise<JurisdictionResult>;
  log?: Logger;
}

export function createZoningEngine(config: CreateEngineConfig = {}): ZoningLookupEngine {
  const geocoder = createGeocoder({ googleMapsApiKey: config.googleMapsApiKey });
  const registry = config.registry ?? createRegistry();
  return new ZoningLookupEngine({
    geocoder,
    registry,
    jurisdictionResolver: config.jurisdictionResolver,
    log: config.log,
  });
}
