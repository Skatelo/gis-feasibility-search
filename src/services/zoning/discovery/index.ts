export { buildDiscoveryQueries } from './search-query-builder';
export { assessOfficialDomain, type OfficialDomainAssessment } from './official-domain-detector';
export { extractEndpoints, endpointSourceType, toServiceRoot, type ExtractedEndpoints } from './arcgis-url-extractor';
export { searchOfficialArcgisPortal, type ArcgisPortalSearchOptions } from './arcgis-portal-search';
export {
  SourceDiscoveryService,
  type SearchProvider,
  type PageFetcher,
  type SearchResult,
  type DiscoveryOptions,
} from './source-discovery.service';
export {
  perplexitySearchProvider,
  httpPageFetcher,
  crawleePageFetcher,
  type PerplexityProviderConfig,
  type CrawleeProviderConfig,
} from './providers';
