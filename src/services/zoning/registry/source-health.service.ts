// Source health — verifies a cached registry record still points at a live,
// queryable layer whose schema hasn't materially changed. Runs on a TTL (not
// every lookup) and downgrades/repairs records that have drifted.

import type { JurisdictionSourceRecord, SourceHealthResult, ZoningLayerConfig, InspectedLayer } from '../types';
import { getLayerMetadata, serviceRoot, layerIdFromUrl, layerSupportsQuery, isPolygonLayer } from '../arcgis';
import type { ArcgisClientOptions } from '../arcgis';

/** Stable, environment-independent hash (djb2) of a layer's queryable schema —
 *  its sorted field names, geometry type, and the mapped zoning-code field.
 *  A change here means the layer's shape drifted and the record needs repair. */
export function metadataHash(input: { fieldNames: string[]; geometryType: string | null; codeField: string | null }): string {
  const canonical = [
    [...input.fieldNames].map((f) => f.toLowerCase()).sort().join(','),
    (input.geometryType ?? '').toLowerCase(),
    (input.codeField ?? '').toLowerCase(),
  ].join('|');
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

export function hashInspectedLayer(layer: InspectedLayer): string {
  return metadataHash({
    fieldNames: layer.fields.map((f) => f.name),
    geometryType: layer.geometryType,
    codeField: layer.fieldMapping.zoningCodeField,
  });
}

export function hashZoningLayers(layers: Array<{ fieldNames: string[]; geometryType: string | null; codeField: string | null }>): string {
  return metadataHash({
    fieldNames: layers.flatMap((l) => l.fieldNames).concat(layers.map((_, i) => `#${i}`)),
    geometryType: layers.map((l) => l.geometryType ?? '').join(','),
    codeField: layers.map((l) => l.codeField ?? '').join(','),
  });
}

export interface HealthCheckOptions extends ArcgisClientOptions {
  /** Recompute the metadata hash and compare against the stored one. */
  expectedHash?: string;
}

async function checkLayer(layer: ZoningLayerConfig, opts: ArcgisClientOptions): Promise<{
  exists: boolean;
  queryable: boolean;
  codeFieldPresent: boolean;
  fieldNames: string[];
  geometryType: string | null;
}> {
  const service = serviceRoot(layer.layerUrl);
  const layerId = layerIdFromUrl(layer.layerUrl) ?? layer.layerId;
  const meta = await getLayerMetadata(service, layerId, opts);
  const fieldNames = (meta.fields ?? []).map((f) => f.name);
  const codeField = layer.fieldMapping.zoningCodeField;
  return {
    exists: true,
    queryable: layerSupportsQuery(meta) && isPolygonLayer(meta),
    codeFieldPresent: !codeField || fieldNames.some((n) => n.toLowerCase() === codeField.toLowerCase()),
    fieldNames,
    geometryType: meta.geometryType ?? null,
  };
}

export class SourceHealthService {
  async check(record: JurisdictionSourceRecord, options: HealthCheckOptions = {}): Promise<SourceHealthResult> {
    const checkedAt = new Date().toISOString();
    const layers = record.zoningLayers;
    if (layers.length === 0) {
      return { status: 'unverified', checkedAt, httpOk: false, layerExists: false, queryable: false, schemaStable: false, detail: 'no zoning layers recorded' };
    }

    const results = await Promise.allSettled(layers.map((l) => checkLayer(l, options)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof checkLayer>>> => r.status === 'fulfilled');
    const anyExists = ok.length > 0;
    const allQueryable = anyExists && ok.every((r) => r.value.queryable);
    const codeFieldsStable = anyExists && ok.every((r) => r.value.codeFieldPresent);

    let recomputedStable = true;
    if (options.expectedHash) {
      const recomputed = hashZoningLayers(
        ok.map((r, i) => ({
          fieldNames: r.value.fieldNames,
          geometryType: r.value.geometryType,
          codeField: layers[i]?.fieldMapping.zoningCodeField ?? null,
        })),
      );
      recomputedStable = recomputed === options.expectedHash;
    }
    const schemaStable = codeFieldsStable && recomputedStable;

    let status: SourceHealthResult['status'];
    if (!anyExists) status = 'broken';
    else if (allQueryable && schemaStable) status = 'healthy';
    else status = 'degraded';

    const detail = [
      `${ok.length}/${layers.length} layers reachable`,
      allQueryable ? 'queryable' : 'query capability degraded',
      schemaStable ? 'schema stable' : 'schema drift detected',
    ].join('; ');

    return {
      status,
      checkedAt,
      httpOk: anyExists,
      layerExists: anyExists,
      queryable: allQueryable,
      schemaStable,
      detail,
    };
  }
}
