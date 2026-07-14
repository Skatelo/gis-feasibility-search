// Authoritative geographic-boundary queries (Census TIGERweb).
//
// Point-in-polygon against national boundary layers so the governing
// jurisdiction is derived from geometry, not from the mailing city. Keyless and
// nationwide. These layers cover every U.S. state, so nothing here is
// jurisdiction-specific.

import { z } from 'zod';
import { buildUrl, fetchJson } from '../utils/http';

// Places_CouSub_ConCity_SubMCD/MapServer: layer 4 = Incorporated Places,
// layer 1 = County Subdivisions (MCDs — townships/towns in strong-MCD states).
const PLACES_LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4';
const MCD_LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1';

const QueryResponse = z.object({
  features: z
    .array(
      z.object({
        attributes: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

function attrString(attrs: Record<string, unknown>, test: RegExp): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (test.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export interface BoundaryHit {
  name: string;
  geoid: string | null;
  layerUrl: string;
}

async function pointInLayer(layerUrl: string, lng: number, lat: number, signal?: AbortSignal): Promise<BoundaryHit | null> {
  const url = buildUrl(`${layerUrl}/query`, {
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: 4326,
    spatialRel: 'esriSpatialRelIntersects',
    where: '1=1',
    outFields: 'BASENAME,NAME,GEOID',
    returnGeometry: false,
    f: 'json',
  });
  const parsed = QueryResponse.parse(await fetchJson(url, { signal, timeoutMs: 5000 }));
  const attrs = parsed.features?.[0]?.attributes;
  if (!attrs) return null;
  const name = attrString(attrs, /^basename$/i) || attrString(attrs, /^name$/i);
  if (!name) return null;
  return {
    name: name.replace(/\s+(city|town|village|borough|CDP)$/i, '').trim(),
    geoid: attrString(attrs, /^geoid$/i) ?? null,
    layerUrl,
  };
}

/** The incorporated place containing the point, or null when the point is in an
 *  unincorporated area. A null result is authoritative evidence of
 *  unincorporated status, not a lookup failure. */
export async function incorporatedPlaceAtPoint(lng: number, lat: number, signal?: AbortSignal): Promise<BoundaryHit | null> {
  return pointInLayer(PLACES_LAYER, lng, lat, signal);
}

/** The county subdivision / minor civil division containing the point. In
 *  strong-MCD states (e.g. much of the Northeast and Midwest) the MCD (town or
 *  township) is frequently the zoning authority even when no incorporated place
 *  applies. */
export async function countySubdivisionAtPoint(lng: number, lat: number, signal?: AbortSignal): Promise<BoundaryHit | null> {
  return pointInLayer(MCD_LAYER, lng, lat, signal);
}
