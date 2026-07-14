// GeoJSON adapter — for jurisdictions that publish zoning as a GeoJSON
// FeatureCollection (ArcGIS Hub / open-data exports, Socrata/CKAN downloads).
// No GIS query engine is involved: the whole collection is fetched once, its
// code/description fields detected from sampled property values, and the point
// is tested against each polygon locally.

import type {
  AdapterContext,
  DiscoveredSource,
  FieldMapping,
  GeoJSONGeometry,
  InspectedLayer,
  InspectedZoningSource,
  QueryLocation,
  RawZoningMatch,
  SourceHealthResult,
  ZoningSourceAdapter,
} from '../types';
import { detectCodeFieldFromSamples } from '../normalization/value-shape';
import { pointInGeometry } from '../geometry/point-in-polygon';

interface GeoFeature {
  properties?: Record<string, unknown> | null;
  geometry?: GeoJSONGeometry | null;
}
interface FeatureCollection {
  type?: string;
  features?: GeoFeature[];
}

const MAX_CACHE = 8;

export class GeoJsonAdapter implements ZoningSourceAdapter {
  readonly sourceType = 'geojson' as const;
  private readonly cache = new Map<string, FeatureCollection>();

  canHandle(source: DiscoveredSource): boolean {
    return source.sourceType === 'geojson' || /\.geojson(\?|$)/i.test(source.url);
  }

  private async load(url: string, ctx: AdapterContext): Promise<FeatureCollection> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const fc = await ctx.fetchJson<FeatureCollection>(url, ctx.signal);
    if (!fc || !Array.isArray(fc.features)) throw new Error(`Not a GeoJSON FeatureCollection: ${url}`);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(url, fc);
    return fc;
  }

  async inspect(source: DiscoveredSource, ctx: AdapterContext): Promise<InspectedZoningSource> {
    const fc = await this.load(source.url, ctx);
    const samples = fc.features!.slice(0, 25).map((f) => f.properties ?? {});
    const { codeField, descriptionField } = detectCodeFieldFromSamples(samples);
    const fieldNames = [...new Set(samples.flatMap((p) => Object.keys(p)))];
    const fieldMapping: FieldMapping = {
      zoningCodeField: codeField,
      zoningDescriptionField: descriptionField,
      jurisdictionField: null,
      overlayField: null,
      detectionConfidence: codeField ? 0.7 : 0,
      reasons: codeField ? [`value-sampled code field "${codeField}"`] : ['no code field detected from samples'],
    };
    const layer: InspectedLayer = {
      id: '0',
      name: source.agency ? `${source.agency} zoning (GeoJSON)` : 'Zoning (GeoJSON)',
      role: 'zoning',
      roleConfidence: codeField ? 0.8 : 0.3,
      geometryType: 'esriGeometryPolygon',
      supportsQuery: true,
      displayField: codeField,
      objectIdField: null,
      fields: fieldNames.map((n) => ({ name: n, alias: n, type: 'esriFieldTypeString' })),
      maxRecordCount: null,
      spatialReferenceWkid: 4326,
      layerUrl: source.url,
      fieldMapping,
      reasons: ['GeoJSON FeatureCollection'],
    };
    return {
      source,
      serviceUrl: source.url,
      sourceType: 'geojson',
      metadataUrl: source.url,
      layers: [layer],
      accessedAt: new Date().toISOString(),
    };
  }

  async query(source: InspectedZoningSource, location: QueryLocation, ctx: AdapterContext): Promise<RawZoningMatch[]> {
    const layer = source.layers[0];
    const fc = await this.load(source.serviceUrl, ctx);
    const out: RawZoningMatch[] = [];
    for (const feature of fc.features ?? []) {
      if (pointInGeometry(location.longitude, location.latitude, feature.geometry)) {
        out.push({
          layerId: layer?.id ?? '0',
          layerName: layer?.name ?? 'Zoning (GeoJSON)',
          layerRole: 'zoning',
          attributes: feature.properties ?? {},
          geometry: location.includeGeometry ? feature.geometry ?? null : null,
          sourceUrl: source.serviceUrl,
        });
      }
    }
    return out;
  }

  async healthCheck(source: InspectedZoningSource, ctx: AdapterContext): Promise<SourceHealthResult> {
    const checkedAt = new Date().toISOString();
    try {
      const fc = await this.load(source.serviceUrl, ctx);
      const ok = Array.isArray(fc.features) && fc.features.length > 0;
      return { status: ok ? 'healthy' : 'degraded', checkedAt, httpOk: true, layerExists: ok, queryable: ok, schemaStable: true, detail: `${fc.features?.length ?? 0} features` };
    } catch (err) {
      return { status: 'broken', checkedAt, httpOk: false, layerExists: false, queryable: false, schemaStable: false, detail: String(err instanceof Error ? err.message : err) };
    }
  }
}
