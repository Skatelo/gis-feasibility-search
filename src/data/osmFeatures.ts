// Real geospatial feature extraction from OpenStreetMap via the Overpass API.
// Returns authoritative building footprints, road centerlines, and water bodies
// as a GeoJSON FeatureCollection (WGS84 / EPSG:4326) for a bounding box — used as
// a vector overlay on the Google Map. This is real, curated data (not AI-guessed).

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: any[];
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type FeatureKind = { type: "building" | "road" | "water"; geom: "Polygon" | "LineString" };

function classify(tags: Record<string, any> | undefined): FeatureKind | null {
  if (!tags) return null;
  if (tags.building) return { type: "building", geom: "Polygon" };
  if (tags.natural === "water" || tags.water || tags.landuse === "reservoir") return { type: "water", geom: "Polygon" };
  if (tags.waterway) return { type: "water", geom: "LineString" };
  if (tags.highway) return { type: "road", geom: "LineString" };
  return null;
}

function osmToGeoJson(data: any): GeoJsonFeatureCollection {
  const features: any[] = [];
  for (const el of data.elements || []) {
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const cls = classify(el.tags);
    if (!cls) continue;
    const coords = el.geometry.map((g: any) => [g.lon, g.lat]);
    const props = {
      feature_type: cls.type,
      name: (el.tags && (el.tags.name || (cls.type === "road" ? el.tags.highway : null))) || null,
      source: "OpenStreetMap",
    };
    if (cls.geom === "Polygon") {
      if (coords.length < 3) continue;
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first); // close ring
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: props });
    } else {
      if (coords.length < 2) continue;
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * Fetches buildings, roads, and water in a bounding box from OpenStreetMap.
 * Tries multiple Overpass mirrors for resilience. Throws if all fail.
 */
export async function fetchOsmFeatures(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<GeoJsonFeatureCollection> {
  const bbox = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:25];(` +
    `way["building"](${bbox});` +
    `way["highway"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["natural"="water"](${bbox});` +
    `);out geom;`;

  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return osmToGeoJson(await res.json());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Overpass request failed");
}
