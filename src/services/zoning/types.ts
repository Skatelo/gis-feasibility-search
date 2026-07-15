// Universal U.S. zoning lookup engine — core types.
//
// Zod schemas are the source of truth for anything that crosses an external
// boundary (geocoder responses, ArcGIS metadata, cached registry records); the
// TypeScript types are inferred from them so validation and typing never drift.
// Pure-internal shapes that never touch untrusted data are plain interfaces.
//
// Nothing here is specific to a county, state, GIS vendor, or layer number.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const ZoningLookupInputSchema = z.object({
  address: z.string().trim().min(1).max(400),
  parcelId: z.string().trim().max(120).optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  stateHint: z.string().trim().max(60).optional(),
  countyHint: z.string().trim().max(120).optional(),
  municipalityHint: z.string().trim().max(120).optional(),
  includeGeometry: z.boolean().optional(),
  includeParcel: z.boolean().optional(),
  includeOverlays: z.boolean().optional(),
  /** Deprecated and ignored by the live engine. Discovery is maintenance-only. */
  discoverSources: z.boolean().optional(),
  forceRefresh: z.boolean().optional(),
  // Lookup mode drives the deadline + how much verification runs.
  mode: z.enum(['fast', 'verified', 'deep']).optional(),
  // Allow third-party (non-government) sources as an authoritative fallback.
  allowThirdParty: z.boolean().optional(),
});
export type ZoningLookupInput = z.infer<typeof ZoningLookupInputSchema>;

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

export const GeocodedAddressSchema = z.object({
  inputAddress: z.string(),
  formattedAddress: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  state: z.string().optional(),
  stateCode: z.string().optional(),
  county: z.string().optional(),
  municipality: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  // Geocoder precision tier — drives the address-confidence factor.
  locationType: z.enum(['rooftop', 'parcel', 'interpolated', 'locality', 'approximate', 'unknown']).optional(),
  partialMatch: z.boolean().optional(),
  provider: z.string(),
  raw: z.unknown(),
});
export type GeocodedAddress = z.infer<typeof GeocodedAddressSchema>;

export interface AddressCandidate {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  provider: string;
}

/** Raised when a geocoder returns more than one materially different match.
 * Callers must present the candidates instead of silently choosing the first. */
export class AmbiguousAddressError extends Error {
  readonly candidates: AddressCandidate[];

  constructor(candidates: AddressCandidate[]) {
    super('Multiple strong address matches were returned');
    this.name = 'AmbiguousAddressError';
    this.candidates = candidates;
  }
}

export interface Geocoder {
  readonly name: string;
  /** True when this provider has the credentials/config it needs to run. */
  isConfigured(): boolean;
  geocode(address: string, signal?: AbortSignal): Promise<GeocodedAddress>;
  reverseGeocode(latitude: number, longitude: number, signal?: AbortSignal): Promise<GeocodedAddress>;
}

// ---------------------------------------------------------------------------
// Evidence + jurisdiction
// ---------------------------------------------------------------------------

export interface SourceEvidence {
  kind: 'boundary-intersection' | 'geocoder-field' | 'registry' | 'search-result' | 'inference';
  detail: string;
  sourceUrl?: string;
  confidence: number; // 0..1
}

export type JurisdictionType =
  | 'municipal'
  | 'county'
  | 'extraterritorial'
  | 'joint-planning'
  | 'special-district'
  | 'no-zoning'
  | 'unknown';

export interface JurisdictionResult {
  state: string | null;
  stateCode: string | null;
  county: string | null;
  municipality: string | null;
  incorporated: boolean | null;
  zoningAuthority: string | null;
  jurisdictionType: JurisdictionType;
  confidence: number; // 0..100
  evidence: SourceEvidence[];
}

// ---------------------------------------------------------------------------
// Discovery + sources
// ---------------------------------------------------------------------------

export type ZoningSourceType =
  | 'arcgis-mapserver'
  | 'arcgis-featureserver'
  | 'wfs'
  | 'geoserver'
  | 'geojson'
  | 'open-data'
  | 'pdf'
  | 'html-lookup'
  | 'unknown';

/** A candidate source URL surfaced by discovery, before inspection. */
export interface DiscoveredSource {
  url: string;
  sourceType: ZoningSourceType;
  official: boolean;
  agency: string | null;
  /** The pages/queries this candidate was discovered from (audit trail). */
  discoveredFrom: string[];
  officialPageUrl?: string | null;
  publisher?: string | null;
  officialReason?: string;
  discoveryConfidence?: number;
  browserFallback?: boolean;
}

export type LayerRole =
  | 'zoning'
  | 'future-land-use'
  | 'comprehensive-plan'
  | 'overlay'
  | 'municipal-boundary'
  | 'planning-jurisdiction'
  | 'parcel'
  | 'floodplain'
  | 'historic'
  | 'unknown';

export interface FieldMapping {
  zoningCodeField: string | null;
  zoningDescriptionField: string | null;
  jurisdictionField: string | null;
  overlayField: string | null;
  detectionConfidence: number; // 0..1
  reasons: string[];
}

/** A single queryable layer within an inspected service. */
export interface InspectedLayer {
  id: number | string;
  name: string;
  role: LayerRole;
  roleConfidence: number; // 0..1
  geometryType: string | null;
  supportsQuery: boolean;
  displayField: string | null;
  objectIdField: string | null;
  fields: Array<{ name: string; alias: string; type: string }>;
  maxRecordCount: number | null;
  spatialReferenceWkid: number | null;
  layerUrl: string;
  fieldMapping: FieldMapping;
  reasons: string[];
}

export interface InspectedZoningSource {
  source: DiscoveredSource;
  serviceUrl: string;
  sourceType: ZoningSourceType;
  metadataUrl: string | null;
  layers: InspectedLayer[];
  accessedAt: string;
}

/** One raw polygon match from a spatial query, before normalization. */
export interface RawZoningMatch {
  layerId: number | string;
  layerName: string;
  layerRole: LayerRole;
  attributes: Record<string, unknown>;
  geometry?: GeoJSONGeometry | null;
  sourceUrl: string;
}

export interface SourceHealthResult {
  status: 'healthy' | 'degraded' | 'broken' | 'unverified';
  checkedAt: string;
  httpOk: boolean;
  layerExists: boolean;
  queryable: boolean;
  schemaStable: boolean;
  detail: string;
}

export interface QueryLocation {
  longitude: number;
  latitude: number;
  parcelId?: string;
  includeGeometry?: boolean;
  /** Governing municipality/authority — lets an adapter target its layer. */
  jurisdictionHint?: string;
  /** Which layer roles to query (defaults to base zoning + overlay). */
  roles?: LayerRole[];
}

// A minimal GeoJSON geometry shape (avoids a hard dependency on @types/geojson
// at this boundary; Turf operations accept these).
export type GeoJSONPosition = [number, number] | [number, number, number];
export interface GeoJSONGeometry {
  type:
    | 'Point'
    | 'MultiPoint'
    | 'LineString'
    | 'MultiLineString'
    | 'Polygon'
    | 'MultiPolygon'
    | 'GeometryCollection';
  coordinates?: unknown;
  geometries?: GeoJSONGeometry[];
}

// ---------------------------------------------------------------------------
// Adapter interface — one per source family, all independent
// ---------------------------------------------------------------------------

export interface ZoningSourceAdapter {
  readonly sourceType: ZoningSourceType;
  canHandle(source: DiscoveredSource): boolean;
  inspect(source: DiscoveredSource, ctx: AdapterContext): Promise<InspectedZoningSource>;
  query(source: InspectedZoningSource, location: QueryLocation, ctx: AdapterContext): Promise<RawZoningMatch[]>;
  healthCheck?(source: InspectedZoningSource, ctx: AdapterContext): Promise<SourceHealthResult>;
}

/** Shared services passed to adapters (DI): a guarded fetch and a logger. */
export interface AdapterContext {
  fetchJson: <T = unknown>(url: string, signal?: AbortSignal) => Promise<T>;
  log: Logger;
  signal?: AbortSignal;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Parcel
// ---------------------------------------------------------------------------

export interface ParcelResult {
  parcelId: string | null;
  ownerName?: string | null;
  situsAddress?: string | null;
  acreage?: number | null;
  geometry?: GeoJSONGeometry;
  sourceUrl: string;
  matchMethod: 'contains-geocode-point' | 'nearest-parcel' | 'parcel-id' | 'unavailable';
  distanceFromGeocodePointMeters?: number;
  addressMatched?: boolean | null;
  interiorPoint?: { longitude: number; latitude: number };
  rawAttributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ConfidenceBreakdown {
  overall: number;
  addressMatch: number;
  jurisdictionMatch: number;
  parcelMatch: number;
  zoningMatch: number;
  sourceAuthority: number;
  reasons: string[];
  warnings: string[];
}

export type ZoningResultStatus =
  | 'verified'
  | 'verified-with-warnings'
  | 'possible-match'
  | 'manual-review-required'
  | 'not-found'
  | 'no-zoning'
  | 'error';

export type PipelineStage =
  | 'input-validation'
  | 'geocoding'
  | 'reverse-geocoding'
  | 'jurisdiction-resolution'
  | 'source-discovery'
  | 'source-inspection'
  | 'parcel-query'
  | 'zoning-query'
  | 'overlay-query'
  | 'geometry-processing'
  | 'normalization'
  | 'ordinance-lookup'
  | 'registry';

export interface StageError {
  stage: PipelineStage;
  message: string;
  recoverable: boolean;
}

export interface PipelineTimings {
  normalizeMs: number;
  geocodeMs: number;
  jurisdictionMs: number;
  registryMs: number;
  discoveryMs: number;
  arcgisInspectionMs: number;
  parcelQueryMs: number;
  zoningQueryMs: number;
  normalizationMs: number;
  validationMs: number;
  totalMs: number;
}

export interface UniversalZoningResult {
  input: ZoningLookupInput;
  address: GeocodedAddress | null;
  jurisdiction: JurisdictionResult;
  parcel: ParcelResult | null;
  zoning: {
    found: boolean;
    code: string | null;
    description: string | null;
    jurisdiction: string | null;
    jurisdictionType: string | null;
    layerName: string | null;
    layerId: number | string | null;
    splitZoned: boolean;
    coveragePercent: number | null;
    additionalDistricts: Array<{
      code: string | null;
      description: string | null;
      coveragePercent: number | null;
    }>;
    rawAttributes: Record<string, unknown> | null;
  };
  overlays: Array<{
    code: string | null;
    name: string | null;
    description: string | null;
    layerName: string;
    rawAttributes: Record<string, unknown>;
  }>;
  source: {
    sourceType: ZoningSourceType;
    official: boolean;
    agency: string | null;
    serviceUrl: string | null;
    layerUrl: string | null;
    metadataUrl: string | null;
    discoveredFrom: string[];
    accessedAt: string;
    lastValidatedAt?: string | null;
  } | null;
  confidence: ConfidenceBreakdown;
  status: ZoningResultStatus;
  errors: StageError[];
  rawSources: unknown[];
  candidateMatches?: AddressCandidate[];
  diagnostics: {
    timings: PipelineTimings;
    geocodeCacheHit: boolean;
    jurisdictionCacheHit: boolean;
    registryHit: boolean;
  };
}

// ---------------------------------------------------------------------------
// Registry (discover-once / verify / cache / reuse)
// ---------------------------------------------------------------------------

export interface ZoningLayerConfig {
  layerUrl: string;
  layerId: number | string;
  layerName: string;
  role: LayerRole;
  fieldMapping: FieldMapping;
  spatialReferenceWkid: number | null;
}

export interface ParcelLayerConfig {
  layerUrl: string;
  layerId: number | string;
  parcelIdField: string | null;
  addressField: string | null;
  acreageField?: string | null;
  sourceType?: 'arcgis-mapserver' | 'arcgis-featureserver';
  /** Maximum bounded nearest-parcel search when the address point misses. */
  maxNearestMeters?: number;
}

export interface BoundaryLayerConfig {
  layerUrl: string;
  layerId: number | string;
  nameField: string | null;
}

export const JurisdictionSourceRecordSchema = z.object({
  id: z.string(),
  country: z.string(),
  stateCode: z.string(),
  countyName: z.string().optional(),
  municipalityName: z.string().optional(),
  jurisdictionType: z.string(),
  agencyName: z.string(),
  officialDomain: z.string(),
  sourceType: z.string(),
  serviceUrl: z.string(),
  // Stored as JSON — validated structurally, typed loosely (config shapes vary).
  zoningLayers: z.array(z.unknown()),
  parcelLayers: z.array(z.unknown()),
  boundaryLayers: z.array(z.unknown()),
  lastVerifiedAt: z.string(),
  lastSuccessfulQueryAt: z.string().optional(),
  healthStatus: z.enum(['healthy', 'degraded', 'broken', 'unverified']),
  metadataHash: z.string().optional(),
  // Schema version so a cached record from an older engine is invalidated.
  schemaVersion: z.number(),
});
export type JurisdictionSourceRecordRaw = z.infer<typeof JurisdictionSourceRecordSchema>;

/** Strongly-typed view over a persisted record (layer configs narrowed). */
export interface JurisdictionSourceRecord extends Omit<JurisdictionSourceRecordRaw, 'zoningLayers' | 'parcelLayers' | 'boundaryLayers'> {
  zoningLayers: ZoningLayerConfig[];
  parcelLayers: ParcelLayerConfig[];
  boundaryLayers: BoundaryLayerConfig[];
}

/** Pluggable persistence so the engine runs in-browser (IndexedDB), on a
 *  server (SQL), or in tests (in-memory) without code changes. */
export interface SourceRegistry {
  get(key: string): Promise<JurisdictionSourceRecord | null>;
  put(record: JurisdictionSourceRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Generic key/value cache for geocoding, jurisdiction, health, etc. */
  cacheGet<T>(namespace: string, key: string): Promise<T | null>;
  cacheSet<T>(namespace: string, key: string, value: T, ttlMs: number): Promise<void>;
}

export const ENGINE_SCHEMA_VERSION = 2;
