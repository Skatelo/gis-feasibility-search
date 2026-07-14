import {
  ENGINE_SCHEMA_VERSION,
  type FieldMapping,
  type JurisdictionSourceRecord,
  type ParcelLayerConfig,
  type ZoningLayerConfig,
  type ZoningSourceType,
} from '../types';
import { jurisdictionKey } from './source-registry.repository';

const VERIFIED_AT = '2026-07-14T14:45:41.189Z';

const NC_ONEMAP_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1',
  layerId: 1,
  parcelIdField: 'parno',
  addressField: 'siteadd',
  acreageField: 'gisacres',
  sourceType: 'arcgis-mapserver',
  maxNearestMeters: 75,
};

const MECKLENBURG_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcelBoundaries/MapServer/0',
  layerId: 0,
  parcelIdField: 'pid',
  addressField: null,
  acreageField: 'gisacres',
  sourceType: 'arcgis-mapserver',
  maxNearestMeters: 75,
};

const GASTON_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11',
  layerId: 11,
  parcelIdField: 'PID',
  addressField: 'WHOLE_ADDRESS',
  acreageField: null,
  sourceType: 'arcgis-mapserver',
  maxNearestMeters: 75,
};

const CABARRUS_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://location.cabarruscounty.us/arcgisservices/rest/services/Tax_Parcels_Full/MapServer/0',
  layerId: 0,
  parcelIdField: 'PIN',
  addressField: null,
  acreageField: 'CALCULATED_ACREAGE',
  sourceType: 'arcgis-mapserver',
  maxNearestMeters: 75,
};

const YORK_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0',
  layerId: 0,
  parcelIdField: 'ParcelID',
  addressField: 'PropertyAddress',
  acreageField: 'GISSizeAC',
  sourceType: 'arcgis-featureserver',
  maxNearestMeters: 75,
};

const LANCASTER_PARCELS: ParcelLayerConfig = {
  layerUrl: 'https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/LC_Parcels/FeatureServer/0',
  layerId: 0,
  parcelIdField: 'PIN',
  addressField: null,
  acreageField: 'GIS_Acres',
  sourceType: 'arcgis-featureserver',
  maxNearestMeters: 75,
};

function mapping(code: string | null, description: string | null = null, overlay: string | null = null): FieldMapping {
  return {
    zoningCodeField: code,
    zoningDescriptionField: description,
    jurisdictionField: null,
    overlayField: overlay,
    detectionConfidence: 1,
    reasons: ['manually reviewed against official ArcGIS layer metadata'],
  };
}

function layer(
  serviceUrl: string,
  layerId: number,
  layerName: string,
  codeField: string | null,
  descriptionField: string | null = null,
  spatialReferenceWkid: number | null = null,
  role: ZoningLayerConfig['role'] = 'zoning',
): ZoningLayerConfig {
  return {
    layerUrl: `${serviceUrl}/${layerId}`,
    layerId,
    layerName,
    role,
    fieldMapping: mapping(codeField, descriptionField, role === 'overlay' ? codeField : null),
    spatialReferenceWkid,
  };
}

interface RecordSpec {
  stateCode: 'NC' | 'SC';
  countyName: string;
  municipalityName?: string;
  agencyName: string;
  officialDomain: string;
  serviceUrl: string;
  sourceType: Extract<ZoningSourceType, 'arcgis-mapserver' | 'arcgis-featureserver'>;
  zoningLayers: ZoningLayerConfig[];
  parcelLayer: ParcelLayerConfig;
  healthStatus?: JurisdictionSourceRecord['healthStatus'];
}

function record(spec: RecordSpec): JurisdictionSourceRecord {
  const jurisdictionType = spec.municipalityName ? 'municipal' : 'county';
  const id = jurisdictionKey({
    country: 'US',
    stateCode: spec.stateCode,
    county: spec.countyName,
    municipality: spec.municipalityName,
    jurisdictionType,
  });
  return {
    id,
    country: 'US',
    stateCode: spec.stateCode,
    countyName: spec.countyName,
    municipalityName: spec.municipalityName,
    jurisdictionType,
    agencyName: spec.agencyName,
    officialDomain: spec.officialDomain,
    sourceType: spec.sourceType,
    serviceUrl: spec.serviceUrl,
    zoningLayers: spec.zoningLayers,
    parcelLayers: [spec.parcelLayer],
    boundaryLayers: [],
    lastVerifiedAt: VERIFIED_AT,
    lastSuccessfulQueryAt: VERIFIED_AT,
    healthStatus: spec.healthStatus ?? (spec.zoningLayers.length > 0 ? 'healthy' : 'unverified'),
    schemaVersion: ENGINE_SCHEMA_VERSION,
  };
}

function municipalRecords(
  base: Omit<RecordSpec, 'municipalityName' | 'agencyName' | 'zoningLayers'>,
  municipalities: ReadonlyArray<{
    name: string;
    agency: string;
    layers: ZoningLayerConfig[];
  }>,
): JurisdictionSourceRecord[] {
  return municipalities.map((municipality) =>
    record({
      ...base,
      municipalityName: municipality.name,
      agencyName: municipality.agency,
      zoningLayers: municipality.layers,
    }),
  );
}

const CHARLOTTE_SERVICE =
  'https://meckgis.mecklenburgcountync.gov/server/rest/services/CityofCharlotteZoning/MapServer';
const MECK_TOWNS_SERVICE =
  'https://meckgis.mecklenburgcountync.gov/server/rest/services/UnincorporatedCountyandTownsZoning/MapServer';
const mecklenburgBase = {
  stateCode: 'NC' as const,
  countyName: 'Mecklenburg County',
  officialDomain: 'mecklenburgcountync.gov',
  sourceType: 'arcgis-mapserver' as const,
  parcelLayer: MECKLENBURG_PARCELS,
};

const mecklenburgRecords: JurisdictionSourceRecord[] = [
  record({
    ...mecklenburgBase,
    agencyName: 'Mecklenburg County',
    serviceUrl: MECK_TOWNS_SERVICE,
    zoningLayers: [layer(MECK_TOWNS_SERVICE, 0, 'Unincorporated County and Towns Zoning', 'zone_des', null, 2264)],
  }),
  record({
    ...mecklenburgBase,
    municipalityName: 'Charlotte',
    agencyName: 'City of Charlotte',
    serviceUrl: CHARLOTTE_SERVICE,
    zoningLayers: [layer(CHARLOTTE_SERVICE, 0, 'City of Charlotte Zoning', 'zoneclass', 'zonedes', 2264)],
  }),
  ...municipalRecords(
    { ...mecklenburgBase, serviceUrl: MECK_TOWNS_SERVICE },
    ['Cornelius', 'Davidson', 'Huntersville', 'Matthews', 'Mint Hill', 'Pineville'].map((name) => ({
      name,
      agency: `${name} zoning authority`,
      layers: [layer(MECK_TOWNS_SERVICE, 0, 'Unincorporated County and Towns Zoning', 'zone_des', null, 2264)],
    })),
  ),
];

const GASTON_SERVICE = 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer';
const gastonBase = {
  stateCode: 'NC' as const,
  countyName: 'Gaston County',
  officialDomain: 'gastoncountync.gov',
  serviceUrl: GASTON_SERVICE,
  sourceType: 'arcgis-mapserver' as const,
  parcelLayer: GASTON_PARCELS,
};
const gastonRecords: JurisdictionSourceRecord[] = [
  record({
    ...gastonBase,
    agencyName: 'Gaston County',
    zoningLayers: [
      layer(GASTON_SERVICE, 1, 'Gaston County UDO', 'TYPE', 'NAME', 2264),
      layer(GASTON_SERVICE, 0, 'Gaston County UDO Overlays', 'TYPE', 'NAME', 2264, 'overlay'),
    ],
  }),
  ...municipalRecords(gastonBase, [
    { name: 'Belmont', agency: 'City of Belmont', layers: [layer(GASTON_SERVICE, 11, 'Belmont Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Bessemer City', agency: 'City of Bessemer City', layers: [layer(GASTON_SERVICE, 7, 'Bessemer City Land Development Code', 'TYPE', 'NAME', 2264)] },
    { name: 'Cherryville', agency: 'City of Cherryville', layers: [layer(GASTON_SERVICE, 13, 'Cherryville Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Cramerton', agency: 'Town of Cramerton', layers: [layer(GASTON_SERVICE, 14, 'Cramerton Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Dallas', agency: 'Town of Dallas', layers: [layer(GASTON_SERVICE, 15, 'Dallas Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Gastonia', agency: 'City of Gastonia', layers: [layer(GASTON_SERVICE, 2, 'Gastonia Zoning', 'ZONING', null, 2264)] },
    { name: 'Kings Mountain', agency: 'City of Kings Mountain', layers: [layer(GASTON_SERVICE, 19, 'Kings Mountain Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Lowell', agency: 'City of Lowell', layers: [layer(GASTON_SERVICE, 9, 'Lowell Land Use Code', 'TYPE', 'NAME', 2264)] },
    { name: 'McAdenville', agency: 'Town of McAdenville', layers: [layer(GASTON_SERVICE, 10, 'McAdenville UDO', 'TYPE', 'NAME', 2264)] },
    { name: 'Mount Holly', agency: 'City of Mount Holly', layers: [layer(GASTON_SERVICE, 16, 'Mount Holly Zoning', 'TYPE', 'NAME', 2264)] },
    { name: 'Stanley', agency: 'Town of Stanley', layers: [layer(GASTON_SERVICE, 17, 'Stanley Zoning', 'TYPE', 'NAME', 2264)] },
  ]),
];

const CABARRUS_SERVICE = 'https://location.cabarruscounty.us/arcgisservices/rest/services/Zoning/MapServer';
const cabarrusBase = {
  stateCode: 'NC' as const,
  countyName: 'Cabarrus County',
  officialDomain: 'cabarruscounty.us',
  serviceUrl: CABARRUS_SERVICE,
  sourceType: 'arcgis-mapserver' as const,
  parcelLayer: CABARRUS_PARCELS,
};
const cabarrusRecords: JurisdictionSourceRecord[] = [
  record({
    ...cabarrusBase,
    agencyName: 'Cabarrus County',
    zoningLayers: [
      layer(
        CABARRUS_SERVICE,
        7,
        'Cabarrus County Zoning',
        'cabarrusgis.CAB_DBO.CabarrusCounty_Zoning.ZONINGCODE',
        'cabarrusgis.CAB_DBO.CountyZoningDescriptions.District',
        2264,
      ),
    ],
  }),
  ...municipalRecords(cabarrusBase, [
    {
      name: 'Mount Pleasant',
      agency: 'Town of Mount Pleasant',
      layers: [layer(CABARRUS_SERVICE, 1, 'Mt Pleasant Zoning', 'cabarrusgis.CAB_DBO.MtPleasant_Zoning.ZONINGCODE', 'cabarrusgis.CAB_DBO.ZoningDescMtPleasant.District', 2264)],
    },
    {
      name: 'Midland',
      agency: 'Town of Midland',
      layers: [layer(CABARRUS_SERVICE, 2, 'Midland Zoning', 'cabarrusgis.CAB_DBO.Midland_Zoning.Zoning_Typ', 'cabarrusgis.CAB_DBO.ZoningDescMidland.District', 2264)],
    },
    {
      name: 'Locust',
      agency: 'City of Locust',
      layers: [layer(CABARRUS_SERVICE, 3, 'Locust Zoning', 'cabarrusgis.CAB_DBO.Locust_Zoning.ZONING', 'cabarrusgis.CAB_DBO.ZoningDescLocust.District', 2264)],
    },
    {
      name: 'Kannapolis',
      agency: 'City of Kannapolis',
      layers: [layer(CABARRUS_SERVICE, 4, 'Kannapolis Zoning', 'cabarrusgis.CAB_DBO.Kannapolis_Zoning.BASE_DISTR', 'cabarrusgis.CAB_DBO.ZoningDescKannapolis.District', 2264)],
    },
    {
      name: 'Harrisburg',
      agency: 'Town of Harrisburg',
      layers: [layer(CABARRUS_SERVICE, 5, 'Harrisburg Zoning', 'cabarrusgis.CAB_DBO.Harrisburg_Zoning.ZONINGCODE', 'cabarrusgis.CAB_DBO.ZoningDescHarrisburg.District', 2264)],
    },
    {
      name: 'Concord',
      agency: 'City of Concord',
      layers: [layer(CABARRUS_SERVICE, 6, 'Concord Zoning', 'cabarrusgis.CAB_DBO.Concord_Zoning.ZONINGCODE', 'cabarrusgis.CAB_DBO.ZoningDescConcord.District', 2264)],
    },
  ]),
];

const UNION_SERVICE = 'https://gis.unioncountync.gov/server/rest/services/Zoning_Map_MIL1/MapServer';
const unionBase = {
  stateCode: 'NC' as const,
  countyName: 'Union County',
  officialDomain: 'unioncountync.gov',
  serviceUrl: UNION_SERVICE,
  sourceType: 'arcgis-mapserver' as const,
  parcelLayer: NC_ONEMAP_PARCELS,
};
const unionRecords = [
  record({
    ...unionBase,
    agencyName: 'Union County',
    zoningLayers: [layer(UNION_SERVICE, 6, 'Zoning Classifications', 'ZONE', null, 2264)],
  }),
  record({
    ...unionBase,
    municipalityName: 'Monroe',
    agencyName: 'City of Monroe',
    zoningLayers: [layer(UNION_SERVICE, 6, 'Zoning Classifications', 'ZONE', null, 2264)],
  }),
];

const YORK_COUNTY_SERVICE =
  'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/York%20County%20Zoning%20(regions)/FeatureServer';
const ROCK_HILL_SERVICE =
  'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Rock%20Hill%20Zoning/FeatureServer';
const YORK_CITY_SERVICE =
  'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/CityofYorkSC_Zoning/FeatureServer';
const CLOVER_SERVICE =
  'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/TownofCloverSC_Zoning/FeatureServer';
const FORT_MILL_SERVICE =
  'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/TownofFortMillSC_Zoning/FeatureServer';
const TEGA_CAY_SERVICE =
  'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/CityofTegaCaySC_Zoning/FeatureServer';
const yorkBase = {
  stateCode: 'SC' as const,
  countyName: 'York County',
  officialDomain: 'yorkcountygov.com',
  sourceType: 'arcgis-featureserver' as const,
  parcelLayer: YORK_PARCELS,
};
const yorkRecords = [
  record({
    ...yorkBase,
    agencyName: 'York County',
    serviceUrl: YORK_COUNTY_SERVICE,
    zoningLayers: [layer(YORK_COUNTY_SERVICE, 0, 'Zoning (York County)', 'zone', null, 3857)],
  }),
  record({
    ...yorkBase,
    municipalityName: 'Rock Hill',
    agencyName: 'City of Rock Hill',
    serviceUrl: ROCK_HILL_SERVICE,
    zoningLayers: [layer(ROCK_HILL_SERVICE, 0, 'Rock Hill Zoning', 'ZONE', null, 3857)],
  }),
  record({
    ...yorkBase,
    municipalityName: 'Clover',
    agencyName: 'Town of Clover',
    serviceUrl: CLOVER_SERVICE,
    zoningLayers: [layer(CLOVER_SERVICE, 0, 'Clover Zoning', 'Zoning', null, 3857)],
  }),
  record({
    ...yorkBase,
    municipalityName: 'York',
    agencyName: 'City of York',
    serviceUrl: YORK_CITY_SERVICE,
    zoningLayers: [layer(YORK_CITY_SERVICE, 5, 'City of York Zoning', 'Zoning', null, 3857)],
  }),
  record({
    ...yorkBase,
    municipalityName: 'Fort Mill',
    agencyName: 'Town of Fort Mill',
    serviceUrl: FORT_MILL_SERVICE,
    zoningLayers: [layer(FORT_MILL_SERVICE, 4, 'Fort Mill Zoning', 'ZONING', null, 3857)],
  }),
  record({
    ...yorkBase,
    municipalityName: 'Tega Cay',
    agencyName: 'City of Tega Cay',
    serviceUrl: TEGA_CAY_SERVICE,
    zoningLayers: [layer(TEGA_CAY_SERVICE, 2, 'Tega Cay Zoning', 'ZoningCode', 'NAME', 3857)],
  }),
];

const LANCASTER_CITY_SERVICE =
  'https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/Zoning_City/FeatureServer';
const lancasterBase = {
  stateCode: 'SC' as const,
  countyName: 'Lancaster County',
  officialDomain: 'lancastersc.net',
  sourceType: 'arcgis-featureserver' as const,
  parcelLayer: LANCASTER_PARCELS,
};
const lancasterRecords = [
  record({
    ...lancasterBase,
    agencyName: 'Lancaster County',
    serviceUrl: LANCASTER_CITY_SERVICE,
    zoningLayers: [],
    healthStatus: 'unverified',
  }),
  record({
    ...lancasterBase,
    municipalityName: 'Lancaster',
    agencyName: 'City of Lancaster',
    serviceUrl: LANCASTER_CITY_SERVICE,
    zoningLayers: [layer(LANCASTER_CITY_SERVICE, 0, 'City of Lancaster Zoning', 'NEWZONE', null, 3857)],
  }),
];

/**
 * Bootstrap records for the first six rollout counties. These are import data,
 * not discovery rules: production loads the same records from PostgreSQL.
 */
export const INITIAL_NC_SC_SOURCE_RECORDS: readonly JurisdictionSourceRecord[] = Object.freeze([
  ...mecklenburgRecords,
  ...gastonRecords,
  ...cabarrusRecords,
  ...unionRecords,
  ...yorkRecords,
  ...lancasterRecords,
]);

export async function seedInitialSourceRecords(registry: { put(record: JurisdictionSourceRecord): Promise<void> }): Promise<void> {
  for (const sourceRecord of INITIAL_NC_SC_SOURCE_RECORDS) await registry.put(sourceRecord);
}
