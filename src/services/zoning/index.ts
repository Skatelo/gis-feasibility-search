// Universal U.S. zoning lookup engine — public entry point.
//
// Assemble the engine with createZoningEngine() and call engine.lookup({ address }).
// Everything is jurisdiction-agnostic; sources are discovered, verified, cached
// in the registry, and reused for later addresses in the same jurisdiction.

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
import {
  SourceDiscoveryService,
  perplexitySearchProvider,
  crawleePageFetcher,
  httpPageFetcher,
  type SearchProvider,
  type PageFetcher,
} from './discovery';
import { ZoningLookupEngine } from './orchestrator';

export interface CreateEngineConfig {
  googleMapsApiKey?: string;
  perplexityApiKey?: string;
  perplexityEndpoint?: string;
  /** Override the persistence layer (defaults to browser Web Storage / memory). */
  registry?: SourceRegistry;
  /** Override discovery providers (tests inject deterministic ones). */
  searchProvider?: SearchProvider;
  pageFetcher?: PageFetcher;
  log?: Logger;
}

export function createZoningEngine(config: CreateEngineConfig = {}): ZoningLookupEngine {
  const geocoder = createGeocoder({ googleMapsApiKey: config.googleMapsApiKey });
  const registry = config.registry ?? createRegistry();
  const search: SearchProvider =
    config.searchProvider ??
    (config.perplexityApiKey
      ? perplexitySearchProvider({ apiKey: config.perplexityApiKey, endpoint: config.perplexityEndpoint })
      : async () => []);
  const isBrowser = typeof (globalThis as { window?: unknown }).window !== 'undefined';
  const pageFetcher: PageFetcher = config.pageFetcher ?? (isBrowser ? crawleePageFetcher() : httpPageFetcher());
  const discovery = new SourceDiscoveryService(search, pageFetcher);
  return new ZoningLookupEngine({ geocoder, registry, discovery, log: config.log });
}
