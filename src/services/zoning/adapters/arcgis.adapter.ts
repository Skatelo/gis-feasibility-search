// ArcGIS adapter — wraps the deterministic ArcGIS core (service inspector +
// spatial query) in the common ZoningSourceAdapter interface so the orchestrator
// can treat every source family uniformly.

import type {
  AdapterContext,
  DiscoveredSource,
  InspectedZoningSource,
  QueryLocation,
  RawZoningMatch,
  SourceHealthResult,
  ZoningSourceAdapter,
} from '../types';
import { inspectArcgisService, queryZoning, getLayerMetadata, serviceRoot, layerIdFromUrl, layerSupportsQuery, isPolygonLayer } from '../arcgis';

export class ArcgisAdapter implements ZoningSourceAdapter {
  readonly sourceType = 'arcgis-mapserver' as const;

  canHandle(source: DiscoveredSource): boolean {
    return /\/(MapServer|FeatureServer)\b/i.test(source.url);
  }

  inspect(source: DiscoveredSource, ctx: AdapterContext): Promise<InspectedZoningSource> {
    return inspectArcgisService(source, { signal: ctx.signal, timeoutMs: 12000 });
  }

  query(source: InspectedZoningSource, location: QueryLocation, ctx: AdapterContext): Promise<RawZoningMatch[]> {
    return queryZoning(source, location, {
      signal: ctx.signal,
      jurisdiction: location.jurisdictionHint,
      roles: location.roles,
    });
  }

  async healthCheck(source: InspectedZoningSource, ctx: AdapterContext): Promise<SourceHealthResult> {
    const checkedAt = new Date().toISOString();
    const zoning = source.layers.filter((l) => l.role === 'zoning');
    if (zoning.length === 0) return { status: 'unverified', checkedAt, httpOk: false, layerExists: false, queryable: false, schemaStable: false, detail: 'no zoning layers' };
    try {
      const meta = await getLayerMetadata(serviceRoot(zoning[0].layerUrl), layerIdFromUrl(zoning[0].layerUrl) ?? zoning[0].id, { signal: ctx.signal });
      const ok = layerSupportsQuery(meta) && isPolygonLayer(meta);
      return { status: ok ? 'healthy' : 'degraded', checkedAt, httpOk: true, layerExists: true, queryable: ok, schemaStable: true, detail: ok ? 'queryable polygon layer' : 'layer no longer queryable polygon' };
    } catch (err) {
      return { status: 'broken', checkedAt, httpOk: false, layerExists: false, queryable: false, schemaStable: false, detail: String(err instanceof Error ? err.message : err) };
    }
  }
}
