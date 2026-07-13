// Zod schemas for the ArcGIS REST responses the engine consumes.
//
// Government ArcGIS servers span many versions and vendors, so every schema is
// tolerant: unknown keys pass through, and anything the engine doesn't strictly
// need is optional. Validation exists to reject non-ArcGIS/garbage responses,
// not to enforce a rigid shape.

import { z } from 'zod';

export const ArcgisErrorSchema = z.object({
  error: z.object({ code: z.number().optional(), message: z.string() }),
});

export const SpatialReferenceSchema = z
  .object({
    wkid: z.number().optional(),
    latestWkid: z.number().optional(),
  })
  .passthrough();

/** Service catalog: /rest/services?f=json */
export const CatalogSchema = z
  .object({
    folders: z.array(z.string()).optional(),
    services: z
      .array(z.object({ name: z.string(), type: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();
export type ArcgisCatalog = z.infer<typeof CatalogSchema>;

export const LayerRefSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    geometryType: z.string().optional(),
    parentLayerId: z.number().optional(),
    subLayerIds: z.array(z.number()).nullable().optional(),
    defaultVisibility: z.boolean().optional(),
  })
  .passthrough();

/** MapServer / FeatureServer metadata: /{service}/MapServer?f=json */
export const ServiceMetadataSchema = z
  .object({
    currentVersion: z.number().optional(),
    mapName: z.string().optional(),
    serviceDescription: z.string().optional(),
    description: z.string().optional(),
    capabilities: z.string().optional(),
    supportedQueryFormats: z.string().optional(),
    layers: z.array(LayerRefSchema).optional(),
    tables: z.array(LayerRefSchema).optional(),
    spatialReference: SpatialReferenceSchema.optional(),
    fullExtent: z.unknown().optional(),
    initialExtent: z.unknown().optional(),
  })
  .passthrough();
export type ArcgisServiceMetadata = z.infer<typeof ServiceMetadataSchema>;

export const FieldSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    alias: z.string().optional(),
  })
  .passthrough();
export type ArcgisField = z.infer<typeof FieldSchema>;

export const DrawingInfoSchema = z
  .object({
    renderer: z
      .object({
        type: z.string().optional(),
        field1: z.string().optional(),
        field: z.string().optional(),
        uniqueValueInfos: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Layer metadata: /{service}/{layerId}?f=json */
export const LayerMetadataSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    description: z.string().optional(),
    geometryType: z.string().optional(),
    displayField: z.string().optional(),
    objectIdField: z.string().optional(),
    globalIdField: z.string().optional(),
    fields: z.array(FieldSchema).nullable().optional(),
    capabilities: z.string().optional(),
    supportedQueryFormats: z.string().optional(),
    maxRecordCount: z.number().optional(),
    drawingInfo: DrawingInfoSchema.optional(),
    extent: z.unknown().optional(),
    sourceSpatialReference: SpatialReferenceSchema.optional(),
    spatialReference: SpatialReferenceSchema.optional(),
  })
  .passthrough();
export type ArcgisLayerMetadata = z.infer<typeof LayerMetadataSchema>;

/** Feature query response (f=json). */
export const QueryResponseSchema = z
  .object({
    objectIdFieldName: z.string().optional(),
    fields: z.array(FieldSchema).optional(),
    spatialReference: SpatialReferenceSchema.optional(),
    exceededTransferLimit: z.boolean().optional(),
    features: z
      .array(
        z.object({
          attributes: z.record(z.string(), z.unknown()).optional(),
          geometry: z.unknown().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
export type ArcgisQueryResponse = z.infer<typeof QueryResponseSchema>;

/** Extract the best WKID (prefer latestWkid) from a spatial reference. */
export function wkidOf(sr: z.infer<typeof SpatialReferenceSchema> | undefined): number | null {
  if (!sr) return null;
  return sr.latestWkid ?? sr.wkid ?? null;
}
