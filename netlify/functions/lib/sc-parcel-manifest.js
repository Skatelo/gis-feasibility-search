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
  anderson: { url: 'https://propertyviewer.andersoncountysc.org/arcgis/rest/services/QueryMap/MapServer', layer: 8 },
  beaufort: { url: 'https://gis.beaufortcountysc.gov/server/rest/services/ArchiveParcels/MapServer', layer: 14 },
  berkeley: { url: 'https://services.arcgis.com/M2JiPNPcfxhLjlp7/arcgis/rest/services/ParcelsAndAddress/FeatureServer', layer: 1 },
  calhoun: { url: 'https://services5.arcgis.com/B3Zo1xqTw8CidOoF/arcgis/rest/services/WebParcels/FeatureServer', layer: 0 },
  charleston: { url: 'https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer', layer: 7 },
  colleton: { url: 'https://services1.arcgis.com/m0cnLGKdhwao8WvM/arcgis/rest/services/Public_Data/FeatureServer', layer: 2 },
  darlington: { url: 'https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/PARCELS/FeatureServer', layer: 1 },
  dorchester: { url: 'https://gisportal.dorchestercounty.net/hosting/rest/services/County_Basemap/MapServer', layer: 3 },
  florence: { url: 'https://services1.arcgis.com/40L6yX6OtdCifNez/arcgis/rest/services/TaxParcelInfo/FeatureServer', layer: 0 },
  georgetown: { url: 'https://gis1.georgetowncountysc.org/portal/rest/services/GCGIS_OpenData/MapServer', layer: 2 },
  greenville: { url: 'https://citygis.greenvillesc.gov/arcgis/rest/services/AddressSearch/Property/MapServer', layer: 3, note: 'City of Greenville extent' },
  hampton: { url: 'https://services8.arcgis.com/6eabNhFouHU5vuYk/arcgis/rest/services/Parcels_Published_view/FeatureServer', layer: 1 },
  horry: { url: 'https://www.horrycounty.org/gisweb/rest/services/Public/Parcels/MapServer', layer: 1 },
  jasper: { url: 'https://services3.arcgis.com/oJaBluQKw5aLHpzj/arcgis/rest/services/County_Parcels/FeatureServer', layer: 0 },
  lancaster: { url: 'https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/Lancaster_Parcels/FeatureServer', layer: 0 },
  laurens: { url: 'https://www.laurenscountygis.org/arcgis/rest/services/Pebble/TaxParcel/MapServer', layer: 5 },
  lee: { url: 'https://services5.arcgis.com/zg6ovB2KKN8L0zFv/arcgis/rest/services/Web_Parcels/FeatureServer', layer: 0 },
  lexington: { url: 'https://maps.lex-co.com/agstserver/rest/services/Property/MapServer', layer: 4 },
  oconee: { url: 'https://arcserver2.oconeesc.com/arcgis/rest/services/PARCELDATA_owner_Assr/MapServer', layer: 1 },
  // Recovered by mining the county's configured viewer app rather than the
  // ArcGIS catalog, which does not index it.
  orangeburg: { url: 'https://services2.arcgis.com/bUKn95BqgpYYTnx3/arcgis/rest/services/Main_Public_Tax_Parcel_Map_WFL1/FeatureServer', layer: 0 },
  pickens: { url: 'https://services1.arcgis.com/59960rq18IxUcAVI/arcgis/rest/services/Energov_AGOL/FeatureServer', layer: 7 },
  richland: { url: 'https://services1.arcgis.com/Mnt8FoJcogKtoVBs/arcgis/rest/services/EnergovInformationPublic/FeatureServer', layer: 13 },
  saluda: { url: 'https://saludacountysc.net/arcgis/rest/services/ParcelViewers/PublicWebsite_Pro/MapServer', layer: 4 },
  spartanburg: { url: 'https://maps.spartanburgcounty.org/server/rest/services/DisplayMap0_11/MapServer', layer: 3 },
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
