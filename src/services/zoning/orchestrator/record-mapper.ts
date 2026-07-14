// Maps between a persisted JurisdictionSourceRecord and an in-memory
// InspectedZoningSource. Saving after discovery: inspected -> record. Fast-path
// reuse: record -> a minimal inspected source the spatial query can run against
// without re-inspecting the service.

import {
  ENGINE_SCHEMA_VERSION,
  type DiscoveredSource,
  type InspectedLayer,
  type InspectedZoningSource,
  type JurisdictionResult,
  type JurisdictionSourceRecord,
  type ZoningLayerConfig,
  type ParcelLayerConfig,
  type BoundaryLayerConfig,
} from '../types';
import { jurisdictionKey } from '../registry';
import { hashZoningLayers } from '../registry/source-health.service';

function zoningLayerConfig(layer: InspectedLayer): ZoningLayerConfig {
  return {
    layerUrl: layer.layerUrl,
    layerId: layer.id,
    layerName: layer.name,
    role: layer.role,
    fieldMapping: layer.fieldMapping,
    spatialReferenceWkid: layer.spatialReferenceWkid,
  };
}

export function recordFromInspected(
  jurisdiction: JurisdictionResult,
  inspected: InspectedZoningSource,
): JurisdictionSourceRecord {
  const zoningLayers = inspected.layers.filter((l) => l.role === 'zoning' || l.role === 'overlay').map(zoningLayerConfig);
  const parcelLayers: ParcelLayerConfig[] = inspected.layers
    .filter((l) => l.role === 'parcel')
    .map((l) => ({ layerUrl: l.layerUrl, layerId: l.id, parcelIdField: l.fieldMapping.zoningCodeField, addressField: null }));
  const boundaryLayers: BoundaryLayerConfig[] = inspected.layers
    .filter((l) => l.role === 'municipal-boundary' || l.role === 'planning-jurisdiction')
    .map((l) => ({ layerUrl: l.layerUrl, layerId: l.id, nameField: l.fieldMapping.jurisdictionField }));

  let officialDomain = '';
  try {
    officialDomain = new URL(inspected.serviceUrl).hostname;
  } catch {
    /* leave blank */
  }

  const hash = hashZoningLayers(
    inspected.layers
      .filter((l) => l.role === 'zoning')
      .map((l) => ({ fieldNames: l.fields.map((f) => f.name), geometryType: l.geometryType, codeField: l.fieldMapping.zoningCodeField })),
  );

  return {
    id: jurisdictionKey({
      country: 'US',
      stateCode: jurisdiction.stateCode,
      county: jurisdiction.county,
      municipality: jurisdiction.municipality,
      jurisdictionType: jurisdiction.jurisdictionType,
    }),
    country: 'US',
    stateCode: jurisdiction.stateCode ?? '',
    countyName: jurisdiction.county ?? undefined,
    municipalityName: jurisdiction.municipality ?? undefined,
    jurisdictionType: jurisdiction.jurisdictionType,
    agencyName: jurisdiction.zoningAuthority ?? officialDomain,
    officialDomain,
    sourceType: inspected.sourceType,
    serviceUrl: inspected.serviceUrl,
    zoningLayers,
    parcelLayers,
    boundaryLayers,
    lastVerifiedAt: inspected.accessedAt,
    healthStatus: zoningLayers.length > 0 ? 'healthy' : 'unverified',
    metadataHash: hash,
    schemaVersion: ENGINE_SCHEMA_VERSION,
  };
}

/** Reconstruct a queryable inspected source from a cached record (fast path). */
export function inspectedFromRecord(record: JurisdictionSourceRecord): InspectedZoningSource {
  const layers: InspectedLayer[] = record.zoningLayers.map((cfg) => ({
    id: cfg.layerId,
    name: cfg.layerName,
    role: cfg.role,
    roleConfidence: 1,
    geometryType: 'esriGeometryPolygon',
    supportsQuery: true,
    displayField: null,
    objectIdField: null,
    fields: [],
    maxRecordCount: null,
    spatialReferenceWkid: cfg.spatialReferenceWkid,
    layerUrl: cfg.layerUrl,
    fieldMapping: cfg.fieldMapping,
    reasons: ['from registry record'],
  }));
  const source: DiscoveredSource = {
    url: record.serviceUrl,
    sourceType: record.sourceType as InspectedZoningSource['sourceType'],
    official: true,
    agency: record.agencyName,
    discoveredFrom: ['registry'],
  };
  return {
    source,
    serviceUrl: record.serviceUrl,
    sourceType: record.sourceType as InspectedZoningSource['sourceType'],
    metadataUrl: record.serviceUrl,
    layers,
    accessedAt: record.lastVerifiedAt,
  };
}
