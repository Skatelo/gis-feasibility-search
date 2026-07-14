// Low-level ArcGIS REST client — catalog, service metadata, layer metadata, and
// point queries. All URLs are built with URL/URLSearchParams; every request goes
// through the guarded fetchJson. Nothing here knows about zoning — it just talks
// ArcGIS REST.

import { buildUrl, fetchJson } from '../utils/http';
import {
  ArcgisErrorSchema,
  CatalogSchema,
  ServiceMetadataSchema,
  LayerMetadataSchema,
  QueryResponseSchema,
  type ArcgisCatalog,
  type ArcgisServiceMetadata,
  type ArcgisLayerMetadata,
  type ArcgisQueryResponse,
} from './arcgis.types';

/** Strip a trailing /{layerId} and query string to get the service root. */
export function serviceRoot(url: string): string {
  return url
    .replace(/\/query\/?($|\?).*/i, '')
    .replace(/\/\d+\/?($|\?).*/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

/** True for a URL that already points at a specific layer (…/MapServer/7). */
export function isLayerUrl(url: string): boolean {
  return /\/(MapServer|FeatureServer)\/\d+\/?($|\?)/i.test(url);
}

export function layerIdFromUrl(url: string): number | null {
  const m = url.match(/\/(?:MapServer|FeatureServer)\/(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

function assertNotArcgisError(raw: unknown, url: string): void {
  const err = ArcgisErrorSchema.safeParse(raw);
  if (err.success) throw new Error(`ArcGIS error at ${url}: ${err.data.error.message}`);
}

export interface ArcgisClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function getCatalog(rootUrl: string, opts: ArcgisClientOptions = {}): Promise<ArcgisCatalog> {
  const url = buildUrl(rootUrl.replace(/\/+$/, ''), { f: 'json' });
  const raw = await fetchJson(url, opts);
  assertNotArcgisError(raw, url);
  return CatalogSchema.parse(raw);
}

export async function getServiceMetadata(
  serviceUrl: string,
  opts: ArcgisClientOptions = {},
): Promise<ArcgisServiceMetadata> {
  const url = buildUrl(serviceRoot(serviceUrl), { f: 'json' });
  const raw = await fetchJson(url, opts);
  assertNotArcgisError(raw, url);
  return ServiceMetadataSchema.parse(raw);
}

export async function getLayerMetadata(
  serviceUrl: string,
  layerId: number | string,
  opts: ArcgisClientOptions = {},
): Promise<ArcgisLayerMetadata> {
  const url = buildUrl(`${serviceRoot(serviceUrl)}/${layerId}`, { f: 'json' });
  const raw = await fetchJson(url, opts);
  assertNotArcgisError(raw, url);
  return LayerMetadataSchema.parse(raw);
}

export interface PointQueryOptions extends ArcgisClientOptions {
  outFields?: string;
  returnGeometry?: boolean;
  /** Input spatial reference for the point (default 4326 = WGS84 lon/lat). */
  inSR?: number;
  /** Requested output geometry SR. */
  outSR?: number;
  where?: string;
}

/** Point-in-polygon query against a specific layer. Longitude precedes latitude,
 *  always. Returns the parsed query response (may be empty). */
export async function queryLayerAtPoint(
  serviceUrl: string,
  layerId: number | string,
  longitude: number,
  latitude: number,
  opts: PointQueryOptions = {},
): Promise<ArcgisQueryResponse> {
  const url = buildUrl(`${serviceRoot(serviceUrl)}/${layerId}/query`, {
    f: 'json',
    where: opts.where ?? '1=1',
    geometry: `${longitude},${latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: opts.inSR ?? 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
  });
  const raw = await fetchJson(url, opts);
  assertNotArcgisError(raw, url);
  return QueryResponseSchema.parse(raw);
}

/** Envelope query — a tiny bbox around the point. Some older servers (HARN
 *  State-Plane, ArcGIS 10.x) ignore a reprojected point-in-polygon but match a
 *  small WGS84 envelope reliably; this is the fallback. */
export async function queryLayerAtEnvelope(
  serviceUrl: string,
  layerId: number | string,
  longitude: number,
  latitude: number,
  delta = 0.00012,
  opts: PointQueryOptions = {},
): Promise<ArcgisQueryResponse> {
  const url = buildUrl(`${serviceRoot(serviceUrl)}/${layerId}/query`, {
    f: 'json',
    where: opts.where ?? '1=1',
    geometry: `${longitude - delta},${latitude - delta},${longitude + delta},${latitude + delta}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: opts.inSR ?? 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
  });
  const raw = await fetchJson(url, opts);
  assertNotArcgisError(raw, url);
  return QueryResponseSchema.parse(raw);
}

/** True when the layer's capabilities advertise Query support. */
export function layerSupportsQuery(meta: ArcgisLayerMetadata): boolean {
  const caps = (meta.capabilities ?? '').toLowerCase();
  // Layers omit capabilities on some servers; absence is treated as queryable
  // and confirmed by the actual query attempt.
  return caps === '' || caps.includes('query') || caps.includes('data');
}

export function isPolygonLayer(meta: ArcgisLayerMetadata): boolean {
  return /polygon/i.test(meta.geometryType ?? '');
}
