// VERIFIED SC COUNTY PARCEL LAYERS
//
// Credential-free replacement for the statewide SCDOT layer (now token-gated).
// Each entry was found by running the auto-discovery against the county seat and
// then CONFIRMED by re-querying the layer and checking the returned parcel's
// centroid actually falls inside South Carolina — which is how a Washington DC
// service that matched "Georgetown" was caught and excluded.
//
// The manifest is only a FAST PATH: every lookup is still probed at the real
// coordinate, and anything that fails falls through to live discovery. So a
// stale or narrowly-scoped entry degrades to discovery instead of returning
// wrong data.
//
// Re-verify with: node _sweep.mjs && node _review.mjs

export const SC_PARCEL_LAYERS = {
  beaufort: { url: 'https://services9.arcgis.com/NpTdr5u1ft9aY31O/arcgis/rest/services/CityOfBeaufort_Parcels/FeatureServer', layer: 21, note: 'City of Beaufort extent' },
  berkeley: { url: 'https://gis.berkeleycountysc.gov/arcgis/rest/services/desktop/internet_map/MapServer', layer: 4 },
  charleston: { url: 'https://services1.arcgis.com/5Gtv38l8677OspKm/arcgis/rest/services/Charleston_County_Parcels/FeatureServer', layer: 0 },
  colleton: { url: 'https://services1.arcgis.com/m0cnLGKdhwao8WvM/arcgis/rest/services/Public_Data/FeatureServer', layer: 2 },
  darlington: { url: 'https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/PARCELS/FeatureServer', layer: 1 },
  florence: { url: 'https://arc2000.florenceco.org/ArcGIS/rest/services/Florence_County_Maps_WebMercator/MapServer', layer: 5 },
  greenville: { url: 'https://citygis.greenvillesc.gov/arcgis/rest/services/AddressSearch/Property/MapServer', layer: 3, note: 'City of Greenville extent' },
  hampton: { url: 'https://services8.arcgis.com/6eabNhFouHU5vuYk/arcgis/rest/services/Parcels_Published_view/FeatureServer', layer: 1 },
  jasper: { url: 'https://services3.arcgis.com/oJaBluQKw5aLHpzj/arcgis/rest/services/County_Parcels/FeatureServer', layer: 0 },
  laurens: { url: 'https://www.laurenscountygis.org/arcgis/rest/services/Pebble/TaxParcel/MapServer', layer: 5 },
  lee: { url: 'https://services5.arcgis.com/zg6ovB2KKN8L0zFv/arcgis/rest/services/Web_Parcels/FeatureServer', layer: 0 },
  lexington: { url: 'https://maps.lex-co.com/agstserver/rest/services/Property/MapServer', layer: 4 },
  oconee: { url: 'https://arcserver2.oconeesc.com/arcgis/rest/services/PARCELDATA/MapServer', layer: 1 },
  pickens: { url: 'https://services1.arcgis.com/59960rq18IxUcAVI/arcgis/rest/services/par_density/FeatureServer', layer: 0 },
  spartanburg: { url: 'https://services9.arcgis.com/HoRra3ATPLGmyjn6/arcgis/rest/services/Spartanburg_County_Parcels_1_7_2019/FeatureServer', layer: 0 },
  york: { url: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer', layer: 0 },
};

/** South Carolina bounding box — a returned parcel outside this is another
 *  state's namesake county and must be rejected. */
export const SC_BOUNDS = { minLng: -83.4, maxLng: -78.4, minLat: 32.0, maxLat: 35.3 };

export function scParcelLayerFor(county) {
  const key = String(county || '')
    .replace(/,\s*SC$/i, '')
    .replace(/\s+County$/i, '')
    .trim()
    .toLowerCase();
  return SC_PARCEL_LAYERS[key] || null;
}
