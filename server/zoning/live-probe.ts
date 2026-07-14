import { getLayerMetadata, layerSupportsQuery, queryLayerAtPoint, queryLayerWhere } from '../../src/services/zoning/arcgis';
import { arcgisPolygonToGeoJson, parcelInteriorPoint } from '../../src/services/zoning/parcel';
import { INITIAL_NC_SC_SOURCE_RECORDS } from '../../src/services/zoning/registry';
import type { ParcelLayerConfig, ZoningLayerConfig } from '../../src/services/zoning/types';

interface ProbeResult {
  key: string;
  kind: 'zoning' | 'overlay' | 'parcel';
  status: 'passed' | 'failed';
  elapsedMs: number;
  detail: string;
}

function attribute(attributes: Record<string, unknown>, field: string | null): unknown {
  if (!field) return undefined;
  const entry = Object.entries(attributes).find(([name]) => name.toLowerCase() === field.toLowerCase());
  return entry?.[1];
}

async function probeZoning(layer: ZoningLayerConfig): Promise<ProbeResult> {
  const startedAt = Date.now();
  const key = layer.layerUrl;
  try {
    const metadata = await getLayerMetadata(layer.layerUrl, layer.layerId, { timeoutMs: 8_000 });
    if (!/polygon/i.test(metadata.geometryType ?? '')) throw new Error(`geometry is ${metadata.geometryType ?? 'unknown'}`);
    if (!layerSupportsQuery(metadata)) throw new Error('layer does not advertise query support');
    const sample = await queryLayerWhere(layer.layerUrl, layer.layerId, {
      outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 1, timeoutMs: 8_000,
    });
    const sampleFeature = sample.features?.[0];
    const geometry = arcgisPolygonToGeoJson(sampleFeature?.geometry);
    if (!sampleFeature?.attributes || !geometry) throw new Error('no polygon sample returned');
    const point = parcelInteriorPoint(geometry);
    const pointResult = await queryLayerAtPoint(layer.layerUrl, layer.layerId, point.longitude, point.latitude, {
      outFields: '*', returnGeometry: false, timeoutMs: 8_000,
    });
    const attributes = pointResult.features?.[0]?.attributes;
    if (!attributes) throw new Error('sample interior point returned no feature');
    if (layer.role === 'zoning' && layer.fieldMapping.zoningCodeField) {
      const code = attribute(attributes, layer.fieldMapping.zoningCodeField);
      if (code === undefined || code === null || String(code).trim() === '') throw new Error('mapped zoning-code field is empty');
    }
    return { key, kind: layer.role === 'overlay' ? 'overlay' : 'zoning', status: 'passed', elapsedMs: Date.now() - startedAt, detail: layer.layerName };
  } catch (error) {
    return { key, kind: layer.role === 'overlay' ? 'overlay' : 'zoning', status: 'failed', elapsedMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeParcel(layer: ParcelLayerConfig): Promise<ProbeResult> {
  const startedAt = Date.now();
  const key = layer.layerUrl;
  try {
    const metadata = await getLayerMetadata(layer.layerUrl, layer.layerId, { timeoutMs: 8_000 });
    if (!/polygon/i.test(metadata.geometryType ?? '')) throw new Error(`geometry is ${metadata.geometryType ?? 'unknown'}`);
    const sample = await queryLayerWhere(layer.layerUrl, layer.layerId, {
      outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 1, timeoutMs: 8_000,
    });
    const sampleFeature = sample.features?.[0];
    const geometry = arcgisPolygonToGeoJson(sampleFeature?.geometry);
    if (!sampleFeature?.attributes || !geometry) throw new Error('no parcel polygon sample returned');
    const point = parcelInteriorPoint(geometry);
    const pointResult = await queryLayerAtPoint(layer.layerUrl, layer.layerId, point.longitude, point.latitude, {
      outFields: '*', returnGeometry: false, timeoutMs: 8_000,
    });
    const attributes = pointResult.features?.[0]?.attributes;
    if (!attributes) throw new Error('parcel interior point returned no feature');
    if (layer.parcelIdField) {
      const parcelId = attribute(attributes, layer.parcelIdField);
      if (parcelId === undefined || parcelId === null || String(parcelId).trim() === '') throw new Error('mapped parcel ID field is empty');
    }
    return { key, kind: 'parcel', status: 'passed', elapsedMs: Date.now() - startedAt, detail: layer.parcelIdField ?? 'polygon query' };
  } catch (error) {
    return { key, kind: 'parcel', status: 'failed', elapsedMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function limitedMap<T, R>(values: readonly T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index] as T);
    }
  }));
  return results;
}

const zoningLayers = [...new Map(INITIAL_NC_SC_SOURCE_RECORDS
  .flatMap((record) => record.zoningLayers)
  .map((layer) => [layer.layerUrl, layer])).values()];
const parcelLayers = [...new Map(INITIAL_NC_SC_SOURCE_RECORDS
  .flatMap((record) => record.parcelLayers)
  .map((layer) => [layer.layerUrl, layer])).values()];

const startedAt = Date.now();
const [zoning, parcels] = await Promise.all([
  limitedMap(zoningLayers, 4, probeZoning),
  limitedMap(parcelLayers, 3, probeParcel),
]);
const results = [...zoning, ...parcels];
const failed = results.filter((result) => result.status === 'failed');
console.info(JSON.stringify({
  checkedAt: new Date().toISOString(),
  authorityRecords: INITIAL_NC_SC_SOURCE_RECORDS.length,
  manualReviewAuthorities: INITIAL_NC_SC_SOURCE_RECORDS.filter((record) => record.zoningLayers.length === 0).map((record) => record.id),
  uniqueLayers: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  elapsedMs: Date.now() - startedAt,
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
