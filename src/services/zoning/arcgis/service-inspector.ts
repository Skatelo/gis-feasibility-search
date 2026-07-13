// Service inspector — turns a raw ArcGIS service (or layer) URL into a fully
// described InspectedZoningSource: every candidate layer with its role, field
// mapping, geometry, query capability, and spatial reference.
//
// Bounded and concurrent: it inspects at most MAX_LAYERS sublayers so a large
// service can't fan out into hundreds of metadata requests.

import type {
  DiscoveredSource,
  InspectedLayer,
  InspectedZoningSource,
  ZoningSourceType,
} from '../types';
import {
  getServiceMetadata,
  getLayerMetadata,
  serviceRoot,
  isLayerUrl,
  layerIdFromUrl,
  layerSupportsQuery,
  type ArcgisClientOptions,
} from './arcgis-client';
import { wkidOf, type ArcgisLayerMetadata } from './arcgis.types';
import { classifyLayer } from './layer-classifier';
import { detectFieldMapping } from './field-detector';

const MAX_LAYERS = 40;

// Roles worth querying for a zoning lookup, in priority order.
const ROLE_PRIORITY: Record<string, number> = {
  zoning: 0,
  overlay: 1,
  'planning-jurisdiction': 2,
  'municipal-boundary': 3,
  parcel: 4,
  'future-land-use': 5,
  'comprehensive-plan': 6,
  historic: 7,
  floodplain: 8,
  unknown: 9,
};

export function sourceTypeFromUrl(url: string): ZoningSourceType {
  if (/\/FeatureServer\b/i.test(url)) return 'arcgis-featureserver';
  if (/\/MapServer\b/i.test(url)) return 'arcgis-mapserver';
  return 'unknown';
}

function toInspectedLayer(serviceUrl: string, layerId: number | string, meta: ArcgisLayerMetadata): InspectedLayer {
  const classification = classifyLayer(meta);
  const mapping = detectFieldMapping(meta);
  const fields = (meta.fields ?? []).map((f) => ({ name: f.name, alias: f.alias ?? f.name, type: f.type }));
  return {
    id: layerId,
    name: meta.name ?? String(layerId),
    role: classification.role,
    roleConfidence: classification.confidence,
    geometryType: meta.geometryType ?? null,
    supportsQuery: layerSupportsQuery(meta),
    displayField: meta.displayField ?? null,
    objectIdField: meta.objectIdField ?? null,
    fields,
    maxRecordCount: meta.maxRecordCount ?? null,
    spatialReferenceWkid: wkidOf(meta.sourceSpatialReference) ?? wkidOf(meta.spatialReference),
    layerUrl: `${serviceRoot(serviceUrl)}/${layerId}`,
    fieldMapping: mapping,
    reasons: classification.reasons,
  };
}

export async function inspectArcgisService(
  source: DiscoveredSource,
  opts: ArcgisClientOptions = {},
): Promise<InspectedZoningSource> {
  const serviceUrl = serviceRoot(source.url);
  const sourceType = sourceTypeFromUrl(source.url);
  const accessedAt = new Date().toISOString();

  // A layer-specific URL: inspect exactly that layer, no catalog walk.
  if (isLayerUrl(source.url)) {
    const layerId = layerIdFromUrl(source.url);
    if (layerId === null) throw new Error(`Could not parse layer id from ${source.url}`);
    const meta = await getLayerMetadata(serviceUrl, layerId, opts);
    return {
      source,
      serviceUrl,
      sourceType,
      metadataUrl: `${serviceUrl}/${layerId}`,
      layers: [toInspectedLayer(serviceUrl, layerId, meta)],
      accessedAt,
    };
  }

  const service = await getServiceMetadata(serviceUrl, opts);
  const layerRefs = (service.layers ?? []).filter((l) => Number.isInteger(l.id)).slice(0, MAX_LAYERS);
  const inspected = await Promise.allSettled(
    layerRefs.map(async (ref) => toInspectedLayer(serviceUrl, ref.id, await getLayerMetadata(serviceUrl, ref.id, opts))),
  );
  const layers = inspected
    .filter((r): r is PromiseFulfilledResult<InspectedLayer> => r.status === 'fulfilled')
    .map((r) => r.value)
    // Keep only role-relevant layers; drop 'unknown' noise.
    .filter((l) => l.role !== 'unknown')
    .sort((a, b) => (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9) || b.roleConfidence - a.roleConfidence);

  return {
    source,
    serviceUrl,
    sourceType,
    metadataUrl: serviceUrl,
    layers,
    accessedAt,
  };
}

/** Convenience: the highest-confidence layer for a given role. */
export function layerForRole(inspected: InspectedZoningSource, role: InspectedLayer['role']): InspectedLayer | null {
  return inspected.layers.filter((l) => l.role === role).sort((a, b) => b.roleConfidence - a.roleConfidence)[0] ?? null;
}
