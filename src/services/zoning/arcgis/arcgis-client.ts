// Low-level ArcGIS REST client — catalog, service metadata, layer metadata, and
// point queries. All URLs are built with URL/URLSearchParams; every request goes
// through the guarded fetchJson. Nothing here knows about zoning — it just talks
// ArcGIS REST.

import { buildUrl, fetchJson, HttpError } from '../utils/http';
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

function shouldRetryArcgisErrorAsPost(raw: unknown): boolean {
  const parsed = ArcgisErrorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.error.code !== 400) return false;
  return /failed to execute query|unable to complete operation|invalid input/i.test(parsed.data.error.message);
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
  /** Force form-encoded POST for legacy or URL-length-sensitive services. */
  forcePost?: boolean;
  /** Optional bounded nearest-feature search distance. */
  distance?: number;
  units?: 'esriSRUnit_Meter' | 'esriSRUnit_Foot';
}

const MAX_GET_URL_LENGTH = 1_800;

async function executeQuery(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>,
  opts: PointQueryOptions,
): Promise<ArcgisQueryResponse> {
  const getUrl = buildUrl(endpoint, params);
  const shouldPost = opts.forcePost === true || getUrl.length > MAX_GET_URL_LENGTH;
  const request = async (usePost: boolean): Promise<unknown> => {
    if (!usePost) return fetchJson(getUrl, opts);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, String(value));
    return fetchJson(endpoint, {
      ...opts,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  };

  let raw: unknown;
  try {
    raw = await request(shouldPost);
  } catch (error) {
    if (shouldPost || !(error instanceof HttpError) || ![405, 414, 431].includes(error.status)) throw error;
    raw = await request(true);
  }
  if (!shouldPost && shouldRetryArcgisErrorAsPost(raw)) raw = await request(true);
  assertNotArcgisError(raw, endpoint);
  return QueryResponseSchema.parse(raw);
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
  const endpoint = `${serviceRoot(serviceUrl)}/${layerId}/query`;
  return executeQuery(endpoint, {
    f: 'json',
    where: opts.where ?? '1=1',
    geometry: `${longitude},${latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: opts.inSR ?? 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
    distance: opts.distance,
    units: opts.distance !== undefined ? opts.units ?? 'esriSRUnit_Meter' : undefined,
  }, opts);
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
  const endpoint = `${serviceRoot(serviceUrl)}/${layerId}/query`;
  return executeQuery(endpoint, {
    f: 'json',
    where: opts.where ?? '1=1',
    geometry: `${longitude - delta},${latitude - delta},${longitude + delta},${latitude + delta}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: opts.inSR ?? 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
  }, opts);
}

export interface GeometryQueryOptions extends PointQueryOptions {
  geometryType: 'esriGeometryPolygon' | 'esriGeometryEnvelope';
  geometry: Record<string, unknown> | string;
}

export interface WhereQueryOptions extends PointQueryOptions {
  resultRecordCount?: number;
  orderByFields?: string;
}

/** Retrieve a bounded sample or attribute-filtered set from a numbered layer. */
export async function queryLayerWhere(
  serviceUrl: string,
  layerId: number | string,
  opts: WhereQueryOptions = {},
): Promise<ArcgisQueryResponse> {
  const endpoint = `${serviceRoot(serviceUrl)}/${layerId}/query`;
  return executeQuery(endpoint, {
    f: 'json',
    where: opts.where ?? '1=1',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
    resultRecordCount: opts.resultRecordCount ?? 1,
    orderByFields: opts.orderByFields,
  }, opts);
}

/** Query a numbered layer with a polygon/envelope. Complex geometry is sent by POST. */
export async function queryLayerByGeometry(
  serviceUrl: string,
  layerId: number | string,
  opts: GeometryQueryOptions,
): Promise<ArcgisQueryResponse> {
  const endpoint = `${serviceRoot(serviceUrl)}/${layerId}/query`;
  return executeQuery(endpoint, {
    f: 'json',
    where: opts.where ?? '1=1',
    geometry: typeof opts.geometry === 'string' ? opts.geometry : JSON.stringify(opts.geometry),
    geometryType: opts.geometryType,
    inSR: opts.inSR ?? 4326,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: opts.outFields ?? '*',
    returnGeometry: opts.returnGeometry ?? false,
    outSR: opts.outSR ?? 4326,
  }, { ...opts, forcePost: opts.forcePost ?? true });
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
