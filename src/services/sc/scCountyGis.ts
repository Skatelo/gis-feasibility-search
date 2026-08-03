// ---------------------------------------------------------------------------
// SOUTH CAROLINA 46-COUNTY DIRECT GIS REGISTRY
//
// SC has no usable statewide parcel service — the SCDOT layer is token-gated —
// so each county is addressed through its OWN ArcGIS service. Counties differ
// in host, service path, layer id and field names, so every county carries its
// own validated configuration rather than a shared assumption.
//
// The statewide layer is still fine for ROUTING (which county contains a point)
// but is never the parcel or zoning source.
//
// Status is evidence, not aspiration:
//   verified            metadata + count + spatial test passed at a real point
//   partially-verified  service answers, but not all checks have been run
//   broken              was working, now fails — kept so the sweep can retry
//   unknown             no endpoint located yet
// ---------------------------------------------------------------------------

export const SOUTH_CAROLINA_COUNTIES = [
  'Abbeville', 'Aiken', 'Allendale', 'Anderson', 'Bamberg', 'Barnwell', 'Beaufort',
  'Berkeley', 'Calhoun', 'Charleston', 'Cherokee', 'Chester', 'Chesterfield',
  'Clarendon', 'Colleton', 'Darlington', 'Dillon', 'Dorchester', 'Edgefield',
  'Fairfield', 'Florence', 'Georgetown', 'Greenville', 'Greenwood', 'Hampton',
  'Horry', 'Jasper', 'Kershaw', 'Lancaster', 'Laurens', 'Lee', 'Lexington',
  'Marion', 'Marlboro', 'McCormick', 'Newberry', 'Oconee', 'Orangeburg',
  'Pickens', 'Richland', 'Saluda', 'Spartanburg', 'Sumter', 'Union',
  'Williamsburg', 'York',
] as const;

export type ScCountyName = typeof SOUTH_CAROLINA_COUNTIES[number];

export type ScProviderType =
  | 'arcgis-enterprise' | 'arcgis-online' | 'arcgis-hub' | 'qpublic'
  | 'schneider' | 'mapgeo' | 'geocortex' | 'wms' | 'wfs'
  | 'download' | 'custom' | 'unknown';

export type ScSourceStatus =
  | 'verified' | 'partially-verified' | 'discovered' | 'broken' | 'manual-review' | 'unknown';

/** Field candidates are ARRAYS: counties expose the same concept under
 *  different names, and some expose more than one. First match wins. */
export interface ScFieldMap {
  parcelId?: string[];
  taxMapNumber?: string[];
  ownerName?: string[];
  ownerAddress?: string[];
  situsAddress?: string[];
  legalDescription?: string[];
  acreage?: string[];
  landValue?: string[];
  improvementValue?: string[];
  assessedValue?: string[];
  marketValue?: string[];
  propertyClass?: string[];
  zoningCode?: string[];
  zoningDescription?: string[];
}

export interface ScLayerConfig {
  serviceUrl: string;
  layerId: number;
  serviceType: 'MapServer' | 'FeatureServer';
  geometryType?: 'esriGeometryPolygon' | 'esriGeometryPoint' | 'esriGeometryPolyline';
  supportsQuery: boolean;
  supportsGeometry: boolean;
  fields?: ScFieldMap;
  /** Feature count seen at validation — a layer that returns 0 is not usable. */
  featureCount?: number;
  note?: string;
}

export interface ScCountyGisConfig {
  state: 'SC';
  county: ScCountyName;
  providerType: ScProviderType;
  officialCountyUrl?: string;
  gisHomepageUrl?: string;
  propertySearchUrl?: string;
  arcgisRestRoots?: string[];
  parcel?: ScLayerConfig;
  zoning?: ScLayerConfig;
  addressPoints?: ScLayerConfig;
  futureLandUse?: ScLayerConfig;
  flood?: ScLayerConfig;
  water?: ScLayerConfig;
  sewer?: ScLayerConfig;
  wetlands?: ScLayerConfig;
  buildingFootprints?: ScLayerConfig;
  status: ScSourceStatus;
  lastVerifiedAt?: string;
  failureCount: number;
}

// ---------------------------------------------------------------------------
// SHARED FIELD CANDIDATES
// SC assessors converge on a small set of spellings. TMS (Tax Map Sheet) is the
// state's parcel identifier and is checked before generic PIN/PARCEL_ID.
// ---------------------------------------------------------------------------

export const SC_FIELD_CANDIDATES: Required<Pick<ScFieldMap,
  'parcelId' | 'taxMapNumber' | 'ownerName' | 'ownerAddress' | 'situsAddress' |
  'acreage' | 'landValue' | 'improvementValue' | 'assessedValue' | 'marketValue' |
  'legalDescription' | 'propertyClass' | 'zoningCode' | 'zoningDescription'>> = {
  parcelId: ['TMS', 'TMS13', 'TMS_NUMBER', 'TMS_NO', 'TMSNUMBER', 'PIN', 'PARCEL_ID', 'PARCELID', 'TAXMAPID', 'MAP_NUMBER', 'MAPNO', 'ACCOUNT', 'ACCOUNT_NO'],
  taxMapNumber: ['TAX_MAP', 'TAXMAP', 'TAX_MAP_NUMBER', 'TMS', 'TMS13', 'MAP_NUMBER'],
  ownerName: ['OWNER', 'OWNER_NAME', 'OWNER1', 'OWNERNME1', 'OWNERNAME', 'TAXPAYER', 'GRANTEE', 'Owner1'],
  ownerAddress: ['OWNER_ADDR', 'OWNER_ADDRESS', 'MAIL_ADDR', 'MAILING_ADDRESS', 'MAILADDR', 'OWNERADD'],
  situsAddress: ['SITUS', 'SITUS_ADDRESS', 'SITE_ADDRESS', 'PROPERTY_ADDRESS', 'LOCATION', 'STREET_ADDRESS', 'PHY_ADDR', 'PHYSICAL_ADDRESS'],
  legalDescription: ['LEGAL', 'LEGAL_DESC', 'LEGALDESC', 'LEGAL_DESCRIPTION', 'DESCRIPTION'],
  acreage: ['ACRES', 'ACREAGE', 'CALC_ACRES', 'GIS_ACRES', 'DEED_ACRES', 'LEGAL_ACRES', 'TOTALACRES'],
  landValue: ['LAND_VALUE', 'LANDVALUE', 'LAND_VAL', 'LNDVALUE'],
  improvementValue: ['IMPROVEMENT_VALUE', 'BUILDING_VALUE', 'BLDG_VALUE', 'IMPVALUE', 'IMP_VALUE'],
  assessedValue: ['ASSESSED_VALUE', 'ASSESSEDVALUE', 'ASSESS_VAL', 'ASMT_VALUE'],
  marketValue: ['MARKET_VALUE', 'TOTAL_VALUE', 'APPRAISED_VALUE', 'MKT_VALUE', 'TOTALVALUE'],
  propertyClass: ['PROPERTY_CLASS', 'PROP_CLASS', 'CLASS', 'LAND_USE', 'USE_CODE', 'PROPCLASS'],
  zoningCode: ['ZONING', 'ZONE', 'ZONE_CODE', 'ZONING_CODE', 'ZONECLASS', 'ZONEDES'],
  zoningDescription: ['ZONING_DESC', 'ZONE_DESC', 'ZONING_DESCRIPTION', 'ZONE_NAME', 'DISTRICT_NAME'],
};

const arcgis = (
  serviceUrl: string,
  layerId: number,
  extra: Partial<ScLayerConfig> = {},
): ScLayerConfig => ({
  serviceUrl,
  layerId,
  serviceType: /FeatureServer\/?$/i.test(serviceUrl) ? 'FeatureServer' : 'MapServer',
  geometryType: 'esriGeometryPolygon',
  supportsQuery: true,
  supportsGeometry: true,
  fields: SC_FIELD_CANDIDATES,
  ...extra,
});

const county = (
  name: ScCountyName,
  over: Partial<ScCountyGisConfig> = {},
): ScCountyGisConfig => ({
  state: 'SC',
  county: name,
  providerType: 'unknown',
  status: 'unknown',
  failureCount: 0,
  ...over,
});

const enterprise = (
  name: ScCountyName,
  serviceUrl: string,
  layerId: number,
  status: ScSourceStatus = 'partially-verified',
  extra: Partial<ScLayerConfig> = {},
): ScCountyGisConfig => county(name, {
  providerType: /services\d*\.arcgis\.com/i.test(serviceUrl) ? 'arcgis-online' : 'arcgis-enterprise',
  arcgisRestRoots: [serviceUrl.replace(/\/(?:MapServer|FeatureServer).*$/i, '').replace(/\/[^/]+$/, '')],
  parcel: arcgis(serviceUrl, layerId, extra),
  status,
});

/**
 * All 46 counties. The 25 with a parcel layer were each confirmed by querying
 * the live layer; the rest are placeholders for the discovery sweep to fill.
 *
 * Counts recorded 2026-08-03 against the live services.
 */
export const SC_COUNTY_GIS: Record<string, ScCountyGisConfig> = Object.fromEntries([
  // --- verified parcel layers -------------------------------------------
  enterprise('Beaufort', 'https://gis.beaufortcountysc.gov/server/rest/services/ArchiveParcels/MapServer', 14),
  enterprise('Berkeley', 'https://services.arcgis.com/M2JiPNPcfxhLjlp7/arcgis/rest/services/ParcelsAndAddress/FeatureServer', 1),
  enterprise('Calhoun', 'https://services5.arcgis.com/B3Zo1xqTw8CidOoF/arcgis/rest/services/WebParcels/FeatureServer', 0),
  // Live check 2026-08-03: 197,518 parcels, owner field OWNER1. The
  // Parcel_Search/MapServer path commonly cited for Charleston returns
  // "Service not found" — this is the service that actually answers.
  enterprise('Charleston', 'https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer', 7, 'verified', { featureCount: 197518 }),
  enterprise('Colleton', 'https://services1.arcgis.com/m0cnLGKdhwao8WvM/arcgis/rest/services/Public_Data/FeatureServer', 2),
  enterprise('Darlington', 'https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/PARCELS/FeatureServer', 1),
  // Live check 2026-08-03: 79,825 parcels, TMS13 + OWNER.
  enterprise('Dorchester', 'https://gisportal.dorchestercounty.net/hosting/rest/services/County_Basemap/MapServer', 3, 'verified', { featureCount: 79825 }),
  enterprise('Florence', 'https://services1.arcgis.com/40L6yX6OtdCifNez/arcgis/rest/services/TaxParcelInfo/FeatureServer', 0),
  enterprise('Georgetown', 'https://gis1.georgetowncountysc.org/portal/rest/services/GCGIS_OpenData/MapServer', 2),
  enterprise('Greenville', 'https://citygis.greenvillesc.gov/arcgis/rest/services/AddressSearch/Property/MapServer', 3, 'partially-verified', { note: 'City of Greenville extent only — county-wide layer still needed' }),
  enterprise('Hampton', 'https://services8.arcgis.com/6eabNhFouHU5vuYk/arcgis/rest/services/Parcels_Published_view/FeatureServer', 1),
  enterprise('Horry', 'https://www.horrycounty.org/gisweb/rest/services/Public/Parcels/MapServer', 1),
  enterprise('Jasper', 'https://services3.arcgis.com/oJaBluQKw5aLHpzj/arcgis/rest/services/County_Parcels/FeatureServer', 0),
  enterprise('Lancaster', 'https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/Lancaster_Parcels/FeatureServer', 0),
  enterprise('Laurens', 'https://www.laurenscountygis.org/arcgis/rest/services/Pebble/TaxParcel/MapServer', 5),
  enterprise('Lee', 'https://services5.arcgis.com/zg6ovB2KKN8L0zFv/arcgis/rest/services/Web_Parcels/FeatureServer', 0),
  enterprise('Lexington', 'https://maps.lex-co.com/agstserver/rest/services/Property/MapServer', 4),
  enterprise('Oconee', 'https://arcserver2.oconeesc.com/arcgis/rest/services/PARCELDATA_owner_Assr/MapServer', 1),
  enterprise('Orangeburg', 'https://services2.arcgis.com/bUKn95BqgpYYTnx3/arcgis/rest/services/Main_Public_Tax_Parcel_Map_WFL1/FeatureServer', 0, 'partially-verified', { note: 'Recovered from the county viewer app; not indexed in the ArcGIS catalog' }),
  enterprise('Pickens', 'https://services1.arcgis.com/59960rq18IxUcAVI/arcgis/rest/services/Energov_AGOL/FeatureServer', 7),
  enterprise('Richland', 'https://services1.arcgis.com/Mnt8FoJcogKtoVBs/arcgis/rest/services/EnergovInformationPublic/FeatureServer', 13),
  enterprise('Saluda', 'https://saludacountysc.net/arcgis/rest/services/ParcelViewers/PublicWebsite_Pro/MapServer', 4),
  enterprise('Spartanburg', 'https://maps.spartanburgcounty.org/server/rest/services/DisplayMap0_11/MapServer', 3),
  // Live check 2026-08-03: 134,295 parcels, TAXMAPID + Owner1.
  enterprise('York', 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer', 0, 'verified', { featureCount: 134295 }),

  // --- known-broken: kept so the sweep retries rather than rediscovering ---
  // Live check 2026-08-03: BOTH the propertyviewer QueryMap service we had and
  // the NewPropertyViewer path fail DNS. Anderson needs rediscovery.
  county('Anderson', {
    providerType: 'arcgis-enterprise',
    propertySearchUrl: 'https://propertyviewer.andersoncountysc.org/',
    status: 'broken',
    failureCount: 1,
    lastVerifiedAt: '2026-08-03',
  }),

  // --- no endpoint located yet -------------------------------------------
  ...(['Abbeville', 'Aiken', 'Allendale', 'Bamberg', 'Barnwell', 'Cherokee',
    'Chester', 'Chesterfield', 'Clarendon', 'Dillon', 'Edgefield', 'Fairfield',
    'Greenwood', 'Kershaw', 'Marion', 'Marlboro', 'McCormick', 'Newberry',
    'Sumter', 'Union', 'Williamsburg'] as ScCountyName[]).map((n) => county(n)),
].map((c) => [normalizeScCountyKey(c.county), c]));

/** "York County, SC" / "YORK" / "york" -> "york". */
export function normalizeScCountyKey(value: string): string {
  return String(value || '')
    .replace(/,\s*SC$/i, '')
    .replace(/\s+County$/i, '')
    .trim()
    .toLowerCase();
}

export function scCountyGisConfig(county: string): ScCountyGisConfig | null {
  return SC_COUNTY_GIS[normalizeScCountyKey(county)] ?? null;
}

/** Counties with a usable parcel endpoint right now. */
export function scCountiesWithParcelLayer(): ScCountyGisConfig[] {
  return Object.values(SC_COUNTY_GIS).filter((c) => c.parcel && c.status !== 'broken');
}

/** Counties the discovery sweep still needs to resolve. */
export function scCountiesNeedingDiscovery(): ScCountyGisConfig[] {
  return Object.values(SC_COUNTY_GIS).filter((c) => !c.parcel || c.status === 'broken');
}

/** First present, non-empty attribute among the candidate names. */
export function pickField(attributes: Record<string, unknown>, candidates: string[] = []): string | null {
  const lower = new Map(Object.keys(attributes || {}).map((k) => [k.toLowerCase(), k]));
  for (const candidate of candidates) {
    const key = lower.get(candidate.toLowerCase());
    if (!key) continue;
    const raw = attributes[key];
    const text = String(raw ?? '').trim();
    if (text && text.toLowerCase() !== 'null') return text;
  }
  return null;
}

function numberField(attributes: Record<string, unknown>, candidates: string[] = []): number | null {
  const text = pickField(attributes, candidates);
  if (text == null) return null;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export interface NormalizedScParcel {
  state: 'SC';
  county: string;
  parcelId: string | null;
  taxMapNumber: string | null;
  ownerName: string | null;
  ownerMailingAddress: string | null;
  propertyAddress: string | null;
  acreage: number | null;
  legalDescription: string | null;
  landValue: number | null;
  improvementValue: number | null;
  assessedValue: number | null;
  marketValue: number | null;
  propertyClass: string | null;
  sourceUrl: string;
  sourceLayerId: number;
  retrievedAt: string;
}

/**
 * Map a county's raw attributes onto the shared shape.
 *
 * A field literally named VALUE is deliberately NOT treated as market value —
 * counties use it for wildly different things, so only the explicit candidates
 * are trusted.
 */
export function normalizeScParcel(
  attributes: Record<string, unknown>,
  config: ScCountyGisConfig,
  layer: ScLayerConfig,
): NormalizedScParcel {
  const f = layer.fields ?? SC_FIELD_CANDIDATES;
  return {
    state: 'SC',
    county: config.county,
    parcelId: pickField(attributes, f.parcelId),
    taxMapNumber: pickField(attributes, f.taxMapNumber),
    ownerName: pickField(attributes, f.ownerName),
    ownerMailingAddress: pickField(attributes, f.ownerAddress),
    propertyAddress: pickField(attributes, f.situsAddress),
    acreage: numberField(attributes, f.acreage),
    legalDescription: pickField(attributes, f.legalDescription),
    landValue: numberField(attributes, f.landValue),
    improvementValue: numberField(attributes, f.improvementValue),
    assessedValue: numberField(attributes, f.assessedValue),
    marketValue: numberField(attributes, f.marketValue),
    propertyClass: pickField(attributes, f.propertyClass),
    sourceUrl: layer.serviceUrl,
    sourceLayerId: layer.layerId,
    retrievedAt: new Date().toISOString(),
  };
}

/** South Carolina bounding box — a parcel outside it belongs to another state's
 *  namesake county and must be rejected. This is how a Washington DC service
 *  matching "Georgetown" was caught. */
export const SC_BOUNDS = { minLng: -83.4, maxLng: -78.4, minLat: 32.0, maxLat: 35.3 };

export function insideSouthCarolina(lng: number, lat: number): boolean {
  return lng >= SC_BOUNDS.minLng && lng <= SC_BOUNDS.maxLng
    && lat >= SC_BOUNDS.minLat && lat <= SC_BOUNDS.maxLat;
}
