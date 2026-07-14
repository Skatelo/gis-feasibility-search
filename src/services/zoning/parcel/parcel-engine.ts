import polylabel from '@mapbox/polylabel';
import { arcgisToGeoJSON } from '@terraformer/arcgis';
import { area } from '@turf/area';
import { feature, point, polygon } from '@turf/helpers';
import { pointOnFeature } from '@turf/point-on-feature';
import { pointToPolygonDistance } from '@turf/point-to-polygon-distance';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { queryLayerAtPoint } from '../arcgis/arcgis-client';
import type { ParcelLayerConfig, ParcelResult } from '../types';

interface ArcgisFeatureLike {
  attributes?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
}

export interface ParcelLookupInput {
  longitude: number;
  latitude: number;
  address?: string;
  parcelId?: string;
}

export interface ParcelLookupOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAddress(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(highway|hwy)\b/g, 'hwy')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function addressScore(input: string | undefined, candidate: unknown): number {
  const candidateText = stringValue(candidate);
  if (!input || !candidateText) return 0;
  const expected = normalizeAddress(input);
  const actual = new Set(normalizeAddress(candidateText));
  if (expected.length === 0 || actual.size === 0) return 0;
  const houseNumber = expected.find((token) => /^\d+[a-z]?$/.test(token));
  let score = houseNumber && actual.has(houseNumber) ? 3 : 0;
  for (const token of expected.filter((value) => value.length > 2)) if (actual.has(token)) score += 1;
  return score;
}

export function arcgisPolygonToGeoJson(value: unknown): Polygon | MultiPolygon | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const withSr = { ...(value as Record<string, unknown>), spatialReference: { wkid: 4326 } };
    const converted = arcgisToGeoJSON(withSr);
    if (converted.type === 'Polygon' || converted.type === 'MultiPolygon') return converted;
  } catch {
    return null;
  }
  return null;
}

function largestPolygonCoordinates(geometry: Polygon | MultiPolygon): Position[][] {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  let selected = geometry.coordinates[0] ?? [];
  let selectedArea = -1;
  for (const coordinates of geometry.coordinates) {
    const candidateArea = area(polygon(coordinates));
    if (candidateArea > selectedArea) {
      selectedArea = candidateArea;
      selected = coordinates;
    }
  }
  return selected;
}

/** A point strictly inside the parcel's largest polygon, with a Turf fallback. */
export function parcelInteriorPoint(geometry: Polygon | MultiPolygon): { longitude: number; latitude: number } {
  const coordinates = largestPolygonCoordinates(geometry);
  if (coordinates.length > 0) {
    const position = polylabel(coordinates as number[][][], 0.000001);
    if (Number.isFinite(position[0]) && Number.isFinite(position[1])) {
      return { longitude: position[0], latitude: position[1] };
    }
  }
  const fallback = pointOnFeature(feature(geometry));
  return { longitude: fallback.geometry.coordinates[0], latitude: fallback.geometry.coordinates[1] };
}

function featureDistanceMeters(featureValue: ArcgisFeatureLike, input: ParcelLookupInput): number {
  const geometry = arcgisPolygonToGeoJson(featureValue.geometry);
  if (!geometry) return Number.POSITIVE_INFINITY;
  return Math.max(0, pointToPolygonDistance(point([input.longitude, input.latitude]), feature(geometry), { units: 'meters' }));
}

function chooseFeature(
  features: ArcgisFeatureLike[],
  config: ParcelLayerConfig,
  input: ParcelLookupInput,
  nearest: boolean,
): ArcgisFeatureLike | null {
  if (features.length === 0) return null;
  return [...features].sort((a, b) => {
    const aAddress = config.addressField ? addressScore(input.address, a.attributes?.[config.addressField]) : 0;
    const bAddress = config.addressField ? addressScore(input.address, b.attributes?.[config.addressField]) : 0;
    if (aAddress !== bAddress) return bAddress - aAddress;
    if (nearest) return featureDistanceMeters(a, input) - featureDistanceMeters(b, input);
    return 0;
  })[0] ?? null;
}

function parcelResult(
  selected: ArcgisFeatureLike,
  config: ParcelLayerConfig,
  input: ParcelLookupInput,
  method: ParcelResult['matchMethod'],
): ParcelResult | null {
  const geometry = arcgisPolygonToGeoJson(selected.geometry);
  if (!geometry) return null;
  const attributes = selected.attributes ?? {};
  const candidateAddress = config.addressField ? attributes[config.addressField] : null;
  const score = addressScore(input.address, candidateAddress);
  return {
    parcelId: config.parcelIdField ? stringValue(attributes[config.parcelIdField]) : null,
    situsAddress: stringValue(candidateAddress),
    acreage: config.acreageField ? numberValue(attributes[config.acreageField]) : null,
    geometry,
    sourceUrl: config.layerUrl,
    matchMethod: method,
    distanceFromGeocodePointMeters: featureDistanceMeters(selected, input),
    addressMatched: input.address && candidateAddress ? score >= 4 : null,
    interiorPoint: parcelInteriorPoint(geometry),
    rawAttributes: attributes,
  };
}

/** Locate the official parcel containing the geocode point, then a bounded nearest parcel. */
export async function lookupParcel(
  config: ParcelLayerConfig,
  input: ParcelLookupInput,
  options: ParcelLookupOptions = {},
): Promise<ParcelResult | null> {
  const common = {
    outFields: '*',
    returnGeometry: true,
    outSR: 4326,
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal,
  } as const;
  const containing = await queryLayerAtPoint(
    config.layerUrl,
    config.layerId,
    input.longitude,
    input.latitude,
    common,
  );
  const contained = chooseFeature((containing.features ?? []) as ArcgisFeatureLike[], config, input, false);
  if (contained) return parcelResult(contained, config, input, input.parcelId ? 'parcel-id' : 'contains-geocode-point');

  const maxDistance = Math.max(1, Math.min(config.maxNearestMeters ?? 75, 150));
  const nearby = await queryLayerAtPoint(
    config.layerUrl,
    config.layerId,
    input.longitude,
    input.latitude,
    { ...common, distance: maxDistance, units: 'esriSRUnit_Meter' },
  );
  const nearest = chooseFeature((nearby.features ?? []) as ArcgisFeatureLike[], config, input, true);
  if (!nearest) return null;
  const result = parcelResult(nearest, config, input, 'nearest-parcel');
  return result && (result.distanceFromGeocodePointMeters ?? Number.POSITIVE_INFINITY) <= maxDistance ? result : null;
}

export function asPolygonFeature(geometry: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return feature(geometry);
}
