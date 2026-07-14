// Spatial point query — runs the actual zoning/overlay lookups against an
// inspected service and returns raw polygon matches, tagged by layer role so
// base zoning and overlays stay separate downstream.
//
// Multi-jurisdiction services (e.g. a county service with a separate zoning
// layer per town) are common, so queries are jurisdiction-aware: when the
// governing municipality is known, its layer is queried first and the search
// stops as soon as a base-zoning polygon is found. Concurrency is bounded to
// stay polite to public government servers.

import type { InspectedZoningSource, InspectedLayer, LayerRole, QueryLocation, RawZoningMatch } from '../types';
import { queryLayerAtPoint, queryLayerAtEnvelope, type ArcgisClientOptions } from './arcgis-client';
import type { ArcgisQueryResponse } from './arcgis.types';

const DEFAULT_QUERY_ROLES: LayerRole[] = ['zoning', 'overlay'];
const DEFAULT_CONCURRENCY = 4;

function token(value: string | undefined | null): string {
  return (value ?? '').toLowerCase().replace(/\b(city|town|village|borough|county|of|the)\b/g, '').replace(/[^a-z0-9]/g, '');
}

function toMatches(layer: InspectedLayer, res: ArcgisQueryResponse): RawZoningMatch[] {
  return (res.features ?? [])
    .filter((f) => f.attributes && Object.keys(f.attributes).length > 0)
    .map((f) => ({
      layerId: layer.id,
      layerName: layer.name,
      layerRole: layer.role,
      attributes: f.attributes as Record<string, unknown>,
      geometry: (f.geometry as RawZoningMatch['geometry']) ?? null,
      sourceUrl: layer.layerUrl,
    }));
}

async function queryOneLayer(
  layer: InspectedLayer,
  location: QueryLocation,
  opts: ArcgisClientOptions,
): Promise<RawZoningMatch[]> {
  if (!layer.supportsQuery) return [];
  // Request all fields: a single matched polygon's attributes are tiny, and the
  // full set enables value-shape disambiguation of misleadingly-named columns
  // and preserves the raw attributes for auditability.
  const common = { ...opts, outFields: '*', returnGeometry: !!location.includeGeometry };
  const point = await queryLayerAtPoint(layer.layerUrl, layer.id, location.longitude, location.latitude, common).catch(
    () => null,
  );
  if (point && (point.features?.length ?? 0) > 0) return toMatches(layer, point);
  const env = await queryLayerAtEnvelope(layer.layerUrl, layer.id, location.longitude, location.latitude, 0.00012, common).catch(
    () => null,
  );
  return env ? toMatches(layer, env) : [];
}

/** Order zoning layers so the governing jurisdiction's layer is tried first,
 *  then any county-wide zoning layer, then the rest by confidence. */
function orderZoningLayers(layers: InspectedLayer[], jurisdiction: string | undefined): InspectedLayer[] {
  const jur = token(jurisdiction);
  return [...layers].sort((a, b) => rank(a) - rank(b) || b.roleConfidence - a.roleConfidence);
  function rank(l: InspectedLayer): number {
    const name = token(l.name);
    if (jur && name.includes(jur)) return 0;
    if (/county/i.test(l.name)) return 1;
    return 2;
  }
}

/** Query layers in bounded-concurrency batches. For the zoning role, stop once a
 *  base-zoning polygon has been found (the point can only be in one layer's
 *  jurisdiction). Overlays are always queried exhaustively. */
async function queryLayersBounded(
  layers: InspectedLayer[],
  location: QueryLocation,
  opts: ArcgisClientOptions,
  concurrency: number,
  stopOnFirstMatch: boolean,
): Promise<RawZoningMatch[]> {
  const out: RawZoningMatch[] = [];
  for (let i = 0; i < layers.length; i += concurrency) {
    const batch = layers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((l) => queryOneLayer(l, location, opts)));
    for (const r of settled) if (r.status === 'fulfilled') out.push(...r.value);
    if (stopOnFirstMatch && out.length > 0) break;
  }
  return out;
}

export interface SpatialQueryOptions extends ArcgisClientOptions {
  roles?: LayerRole[];
  /** Governing municipality/authority name — prioritizes its zoning layer. */
  jurisdiction?: string;
  /** Max concurrent layer queries per host (conservative by default). */
  concurrency?: number;
  /** Hard cap on zoning layers queried when no jurisdiction hint narrows them. */
  maxZoningLayers?: number;
}

export async function queryZoning(
  inspected: InspectedZoningSource,
  location: QueryLocation,
  options: SpatialQueryOptions = {},
): Promise<RawZoningMatch[]> {
  const roles = options.roles ?? DEFAULT_QUERY_ROLES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const out: RawZoningMatch[] = [];

  for (const role of roles) {
    let layers = inspected.layers.filter((l) => l.role === role && l.supportsQuery);
    if (layers.length === 0) continue;
    if (role === 'zoning') {
      layers = orderZoningLayers(layers, options.jurisdiction).slice(0, options.maxZoningLayers ?? layers.length);
      out.push(...(await queryLayersBounded(layers, location, options, concurrency, true)));
    } else {
      layers = layers.sort((a, b) => b.roleConfidence - a.roleConfidence);
      out.push(...(await queryLayersBounded(layers, location, options, concurrency, false)));
    }
  }
  return out;
}
