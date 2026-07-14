// Adapter selection — maps a discovered source (or a source type) to the
// adapter that can inspect + query it. New source families are added by
// implementing ZoningSourceAdapter and registering the instance here.

import type { DiscoveredSource, ZoningSourceAdapter, ZoningSourceType } from '../types';
import { ArcgisAdapter } from './arcgis.adapter';
import { GeoJsonAdapter } from './geojson.adapter';

const ADAPTERS: ZoningSourceAdapter[] = [new ArcgisAdapter(), new GeoJsonAdapter()];

export function selectAdapter(source: DiscoveredSource): ZoningSourceAdapter | null {
  return ADAPTERS.find((a) => a.canHandle(source)) ?? null;
}

export function adapterForSourceType(sourceType: ZoningSourceType): ZoningSourceAdapter | null {
  if (/^arcgis-/.test(sourceType)) return ADAPTERS[0];
  if (sourceType === 'geojson') return ADAPTERS[1];
  // Fall back by probing canHandle with a synthetic source for other types.
  return null;
}
