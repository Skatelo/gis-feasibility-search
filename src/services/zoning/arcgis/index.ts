export * from './arcgis.types';
export {
  serviceRoot,
  isLayerUrl,
  layerIdFromUrl,
  getCatalog,
  getServiceMetadata,
  getLayerMetadata,
  queryLayerAtPoint,
  queryLayerAtEnvelope,
  queryLayerByGeometry,
  queryLayerWhere,
  layerSupportsQuery,
  isPolygonLayer,
  type ArcgisClientOptions,
  type PointQueryOptions,
  type GeometryQueryOptions,
  type WhereQueryOptions,
} from './arcgis-client';
export { detectFieldMapping } from './field-detector';
export { classifyLayer, type LayerClassification } from './layer-classifier';
export { inspectArcgisService, layerForRole, sourceTypeFromUrl } from './service-inspector';
export { queryZoning, type SpatialQueryOptions } from './spatial-query';
