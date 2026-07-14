// Dependency-free planar geometry for GeoJSON Polygon/MultiPolygon: point-in-
// polygon (ray casting with hole support), bounding box, and ring area. Used by
// the GeoJSON/WFS adapters (which get raw geometry, not a GIS query engine) and,
// later, by split-zoning coverage math.
//
// Coordinates are [lng, lat]. Adequate for the small extents of a parcel/zoning
// polygon; not a geodesic library.

import type { GeoJSONGeometry, GeoJSONPosition } from '../types';

type Ring = GeoJSONPosition[];

/** Ray-casting test for a single ring (no holes). */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A GeoJSON Polygon is [outerRing, ...holes]: inside the outer ring and not in
 *  any hole. */
function pointInPolygonRings(lng: number, lat: number, rings: Ring[]): boolean {
  if (rings.length === 0 || !pointInRing(lng, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lng, lat, rings[h])) return false; // in a hole
  }
  return true;
}

export function pointInGeometry(lng: number, lat: number, geometry: GeoJSONGeometry | null | undefined): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, (geometry.coordinates as Ring[]) ?? []);
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = (geometry.coordinates as Ring[][]) ?? [];
    return polys.some((rings) => pointInPolygonRings(lng, lat, rings));
  }
  return false;
}

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function collectPositions(coords: unknown, out: GeoJSONPosition[]): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    out.push(coords as GeoJSONPosition);
    return;
  }
  for (const c of coords) collectPositions(c, out);
}

export function boundingBox(geometry: GeoJSONGeometry | null | undefined): BBox | null {
  if (!geometry) return null;
  const positions: GeoJSONPosition[] = [];
  collectPositions(geometry.coordinates, positions);
  if (positions.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of positions) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** Shoelace ring area (unsigned, in squared coordinate units). */
export function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area) / 2;
}

/** Net planar area of a Polygon/MultiPolygon (outer rings minus holes). */
export function polygonArea(geometry: GeoJSONGeometry | null | undefined): number {
  if (!geometry) return 0;
  const polyArea = (rings: Ring[]): number => rings.reduce((sum, ring, idx) => sum + (idx === 0 ? ringArea(ring) : -ringArea(ring)), 0);
  if (geometry.type === 'Polygon') return polyArea((geometry.coordinates as Ring[]) ?? []);
  if (geometry.type === 'MultiPolygon') return ((geometry.coordinates as Ring[][]) ?? []).reduce((s, rings) => s + polyArea(rings), 0);
  return 0;
}
