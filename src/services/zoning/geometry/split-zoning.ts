import { arcgisToGeoJSON, geojsonToArcGIS } from '@terraformer/arcgis';
import { area } from '@turf/area';
import { feature, featureCollection } from '@turf/helpers';
import { intersect } from '@turf/intersect';
import type { MultiPolygon, Polygon } from 'geojson';
import { queryLayerByGeometry } from '../arcgis/arcgis-client';
import { normalizeZoningAttributes } from '../normalization/zoning-normalizer';
import type { InspectedLayer, InspectedZoningSource, RawZoningMatch } from '../types';

interface ArcgisFeatureLike {
  attributes?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
}

export interface ParcelZoningQueryResult {
  matches: RawZoningMatch[];
  coverageByCode: Map<string, number>;
  errors: string[];
}

function polygonGeometry(value: unknown): Polygon | MultiPolygon | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const converted = arcgisToGeoJSON({ ...(value as Record<string, unknown>), spatialReference: { wkid: 4326 } });
    if (converted.type === 'Polygon' || converted.type === 'MultiPolygon') return converted;
  } catch {
    return null;
  }
  return null;
}

function coveragePercent(parcel: Polygon | MultiPolygon, zoning: Polygon | MultiPolygon): number | null {
  try {
    const parcelFeature = feature(parcel);
    const zoningFeature = feature(zoning);
    const parcelArea = area(parcelFeature);
    if (parcelArea <= 0) return null;
    const overlap = intersect(featureCollection([parcelFeature, zoningFeature]));
    if (!overlap) return 0;
    return Math.max(0, Math.min(100, (area(overlap) / parcelArea) * 100));
  } catch {
    return null;
  }
}

async function queryLayer(
  layer: InspectedLayer,
  parcel: Polygon | MultiPolygon,
  signal?: AbortSignal,
): Promise<{ matches: RawZoningMatch[]; coverage: Array<{ code: string; percent: number }> }> {
  const esriGeometry = geojsonToArcGIS(parcel) as Record<string, unknown>;
  const response = await queryLayerByGeometry(layer.layerUrl, layer.id, {
    geometryType: 'esriGeometryPolygon',
    geometry: esriGeometry,
    inSR: 4326,
    outSR: 4326,
    outFields: '*',
    returnGeometry: true,
    timeoutMs: 8_000,
    signal,
    forcePost: true,
  });
  const matches: RawZoningMatch[] = [];
  const coverage: Array<{ code: string; percent: number }> = [];
  for (const value of (response.features ?? []) as ArcgisFeatureLike[]) {
    const attributes = value.attributes ?? {};
    const geometry = polygonGeometry(value.geometry);
    matches.push({
      layerId: layer.id,
      layerName: layer.name,
      layerRole: layer.role,
      attributes,
      geometry,
      sourceUrl: layer.layerUrl,
    });
    if (layer.role !== 'zoning' || !geometry) continue;
    const normalized = normalizeZoningAttributes(attributes, layer.fieldMapping);
    const percent = coveragePercent(parcel, geometry);
    if (normalized.code && percent !== null && percent > 0) coverage.push({ code: normalized.code, percent });
  }
  return { matches, coverage };
}

/** Intersect the full parcel against every configured base-zoning and overlay layer. */
export async function queryZoningForParcel(
  source: InspectedZoningSource,
  parcel: Polygon | MultiPolygon,
  includeOverlays = true,
  signal?: AbortSignal,
): Promise<ParcelZoningQueryResult> {
  const layers = source.layers.filter((layer) =>
    layer.supportsQuery && (layer.role === 'zoning' || (includeOverlays && layer.role === 'overlay')),
  );
  const settled = await Promise.allSettled(layers.map((layer) => queryLayer(layer, parcel, signal)));
  const matches: RawZoningMatch[] = [];
  const coverageByCode = new Map<string, number>();
  const errors: string[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'rejected') {
      errors.push(`${layers[index]?.name ?? 'unknown layer'}: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`);
      continue;
    }
    matches.push(...result.value.matches);
    for (const item of result.value.coverage) {
      const key = item.code.toUpperCase();
      coverageByCode.set(key, Math.min(100, (coverageByCode.get(key) ?? 0) + item.percent));
    }
  }

  matches.sort((a, b) => {
    if (a.layerRole !== 'zoning' || b.layerRole !== 'zoning') return a.layerRole === 'zoning' ? -1 : 1;
    const aCode = normalizeZoningAttributes(a.attributes, source.layers.find((layer) => String(layer.id) === String(a.layerId))?.fieldMapping).code;
    const bCode = normalizeZoningAttributes(b.attributes, source.layers.find((layer) => String(layer.id) === String(b.layerId))?.fieldMapping).code;
    return (coverageByCode.get((bCode ?? '').toUpperCase()) ?? 0) - (coverageByCode.get((aCode ?? '').toUpperCase()) ?? 0);
  });
  return { matches, coverageByCode, errors };
}
