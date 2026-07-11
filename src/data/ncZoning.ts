// NC county zoning GIS registry.
//
// Every `zoning_mapserver_url` below has been verified live against the county's
// ArcGIS REST server (see scratch/verified-zoning.md). Counties whose zoning is
// not published as an export-capable ArcGIS MapServer (only a hosted FeatureServer,
// land-use only, or no public service at all) are left with a null URL and
// `use_state_fallback: true` — for those we show NO zoning overlay rather than
// pretending a parcel layer is zoning.
//
// The overlay renders MapServer tiles via the ArcGIS `export` op (see
// FeasibilitySearch.tsx). `zoning_layers` optionally restricts the export to
// specific sublayers (e.g. "show:0") for mixed/report MapServers. The
// `zoning_field_mapping` / `description_field` drive the point zoning-code lookup
// used to populate the property card.

/** One renderable/queryable zoning MapServer (a county may stack several). */
export interface ZoningService {
  url: string;
  /** Optional ArcGIS export `layers` clause, e.g. "show:0" for mixed report maps. */
  layers?: string | null;
}

export interface CountyZoningConfig {
  county_id: string;
  name: string;
  lat: number;
  lng: number;
  zoning_mapserver_url: string | null;
  zoning_field_mapping: string | null;
  description_field: string | null;
  /** Optional ArcGIS export `layers` clause, e.g. "show:0" for mixed report maps. */
  zoning_layers?: string | null;
  /**
   * Additional zoning MapServers to stack on the map and fall through when
   * looking up the code — used by multi-jurisdiction counties whose city,
   * town, and unincorporated zoning live in separate services.
   */
  extra_zoning?: ZoningService[] | null;
  use_state_fallback: boolean;
}

export interface ZoningRegistry {
  state_fallback_parcel_url: string;
  counties: Record<string, CountyZoningConfig>;
}

const F = false;
const T = true;

export const ncZoningRegistry: ZoningRegistry = {
  state_fallback_parcel_url: "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1",
  counties: {
    alamance: { county_id: "001", name: "Alamance", lat: 36.0427, lng: -79.3995, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    alexander: { county_id: "003", name: "Alexander", lat: 35.9221, lng: -81.1775, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    alleghany: { county_id: "005", name: "Alleghany", lat: 36.4939, lng: -81.1278, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    anson: { county_id: "007", name: "Anson", lat: 34.9749, lng: -80.1008, zoning_mapserver_url: "https://ansoncountygis.com/arcgis/rest/services/ZoningLayers/MapServer", zoning_field_mapping: "ZONECODE", description_field: null, zoning_layers: null, use_state_fallback: F },
    ashe: { county_id: "009", name: "Ashe", lat: 36.4332, lng: -81.4988, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    avery: { county_id: "011", name: "Avery", lat: 36.0734, lng: -81.9213, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    beaufort: { county_id: "013", name: "Beaufort", lat: 35.4925, lng: -76.8483, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    bertie: { county_id: "015", name: "Bertie", lat: 36.0682, lng: -76.9743, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    bladen: { county_id: "017", name: "Bladen", lat: 34.6225, lng: -78.5528, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    brunswick: { county_id: "019", name: "Brunswick", lat: 34.0664, lng: -78.2253, zoning_mapserver_url: "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: null, zoning_layers: null, use_state_fallback: F },
    buncombe: { county_id: "021", name: "Buncombe", lat: 35.6111, lng: -82.5312, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    burke: { county_id: "023", name: "Burke", lat: 35.7511, lng: -81.7001, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    cabarrus: { county_id: "025", name: "Cabarrus", lat: 35.3912, lng: -80.5513, zoning_mapserver_url: "https://location.cabarruscounty.us/arcgisservices/rest/services/Zoning/MapServer", zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: F },
    caldwell: { county_id: "027", name: "Caldwell", lat: 35.9189, lng: -81.5434, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    camden: { county_id: "029", name: "Camden", lat: 36.3312, lng: -76.1555, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    carteret: { county_id: "031", name: "Carteret", lat: 34.8012, lng: -76.7512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    caswell: { county_id: "033", name: "Caswell", lat: 36.3982, lng: -79.3331, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    catawba: { county_id: "035", name: "Catawba", lat: 35.6612, lng: -81.2114, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    chatham: { county_id: "037", name: "Chatham", lat: 35.7012, lng: -79.2512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    cherokee: { county_id: "039", name: "Cherokee", lat: 35.1311, lng: -84.0511, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    chowan: { county_id: "041", name: "Chowan", lat: 36.1312, lng: -76.6012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    clay: { county_id: "043", name: "Clay", lat: 35.0512, lng: -83.7511, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    cleveland: { county_id: "045", name: "Cleveland", lat: 35.3323, lng: -81.5513, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    columbus: { county_id: "047", name: "Columbus", lat: 34.2512, lng: -78.6512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    craven: { county_id: "049", name: "Craven", lat: 35.1012, lng: -77.0712, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    cumberland: { county_id: "051", name: "Cumberland", lat: 35.0512, lng: -78.8812, zoning_mapserver_url: "https://gis.co.cumberland.nc.us/server/rest/services/Planning/CCZoning/MapServer", zoning_field_mapping: "Zone_Class", description_field: null, zoning_layers: null, use_state_fallback: F },
    currituck: { county_id: "053", name: "Currituck", lat: 36.3621, lng: -75.9922, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    dare: { county_id: "055", name: "Dare", lat: 35.6321, lng: -75.7723, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    davidson: { county_id: "057", name: "Davidson", lat: 35.7925, lng: -80.2012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    davie: { county_id: "059", name: "Davie", lat: 35.9125, lng: -80.5323, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    duplin: { county_id: "061", name: "Duplin", lat: 34.9312, lng: -77.9312, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    durham: { county_id: "063", name: "Durham", lat: 36.0312, lng: -78.8923, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    edgecombe: { county_id: "065", name: "Edgecombe", lat: 35.9123, lng: -77.5312, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    forsyth: { county_id: "067", name: "Forsyth", lat: 36.1312, lng: -80.2442, zoning_mapserver_url: "https://maps.co.forsyth.nc.us/arcgis/rest/services/Planning_Inspection/Planning_Inspection/MapServer", zoning_field_mapping: "ZONING_DISTRICT", description_field: null, zoning_layers: "show:1", use_state_fallback: F },
    franklin: { county_id: "069", name: "Franklin", lat: 36.0821, lng: -78.2812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    gaston: { county_id: "071", name: "Gaston", lat: 35.2912, lng: -81.1812, zoning_mapserver_url: "https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: "FULLPATH", zoning_layers: null, use_state_fallback: F },
    gates: { county_id: "073", name: "Gates", lat: 36.4221, lng: -76.7112, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    graham: { county_id: "075", name: "Graham", lat: 35.3421, lng: -83.8212, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    granville: { county_id: "077", name: "Granville", lat: 36.3121, lng: -78.6512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    greene: { county_id: "079", name: "Greene", lat: 35.4312, lng: -77.6812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    guilford: { county_id: "081", name: "Guilford", lat: 36.0812, lng: -79.7912, zoning_mapserver_url: "https://gcgis.guilfordcountync.gov/arcgis/rest/services/Planning_Zoning/Combined_Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: "DESCRIPTION", zoning_layers: null, use_state_fallback: F },
    halifax: { county_id: "083", name: "Halifax", lat: 36.2512, lng: -77.6512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    harnett: { county_id: "085", name: "Harnett", lat: 35.3712, lng: -78.8612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    haywood: { county_id: "087", name: "Haywood", lat: 35.5512, lng: -82.9812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    henderson: { county_id: "089", name: "Henderson", lat: 35.3312, lng: -82.4512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    hertford: { county_id: "091", name: "Hertford", lat: 36.3512, lng: -76.9812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    hoke: { county_id: "093", name: "Hoke", lat: 35.0312, lng: -79.2412, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    hyde: { county_id: "095", name: "Hyde", lat: 35.4112, lng: -76.1512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    iredell: { county_id: "097", name: "Iredell", lat: 35.8112, lng: -80.8912, zoning_mapserver_url: "https://maps.iredellcountync.gov/server/rest/services/Data/Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: null, zoning_layers: null, use_state_fallback: F },
    jackson: { county_id: "099", name: "Jackson", lat: 35.2912, lng: -83.1512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    johnston: { county_id: "101", name: "Johnston", lat: 35.5212, lng: -78.3612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    jones: { county_id: "103", name: "Jones", lat: 35.0112, lng: -77.3612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    lee: { county_id: "105", name: "Lee", lat: 35.4812, lng: -79.1812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    lenoir: { county_id: "107", name: "Lenoir", lat: 35.2512, lng: -77.6312, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    lincoln: { county_id: "109", name: "Lincoln", lat: 35.4812, lng: -81.2212, zoning_mapserver_url: "https://arcgisserver.lincolncountync.gov/arcgis/rest/services/LandReport/MapServer", zoning_field_mapping: "ZONECLASS", description_field: "ZONEDESC", zoning_layers: "show:0", use_state_fallback: F },
    macon: { county_id: "111", name: "Macon", lat: 35.1512, lng: -83.4212, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    madison: { county_id: "113", name: "Madison", lat: 35.8512, lng: -82.7212, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    martin: { county_id: "115", name: "Martin", lat: 35.8512, lng: -77.1012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    mcdowell: { county_id: "117", name: "McDowell", lat: 35.6812, lng: -82.0412, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    mecklenburg: { county_id: "119", name: "Mecklenburg", lat: 35.2271, lng: -80.8431, zoning_mapserver_url: "https://meckgis.mecklenburgcountync.gov/server/rest/services/CityofCharlotteZoning/MapServer", zoning_field_mapping: "zoneclass", description_field: "zonedes", zoning_layers: null, extra_zoning: [{ url: "https://meckgis.mecklenburgcountync.gov/server/rest/services/UnincorporatedCountyandTownsZoning/MapServer", layers: null }], use_state_fallback: F },
    mitchell: { county_id: "121", name: "Mitchell", lat: 36.0121, lng: -82.1612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    montgomery: { county_id: "123", name: "Montgomery", lat: 35.3312, lng: -79.8912, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    moore: { county_id: "125", name: "Moore", lat: 35.3121, lng: -79.4812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    nash: { county_id: "127", name: "Nash", lat: 35.9621, lng: -77.9812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    new_hanover: { county_id: "129", name: "New Hanover", lat: 34.1812, lng: -77.9012, zoning_mapserver_url: "https://gis.nhcgov.com/server/rest/services/Layers/Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: null, zoning_layers: null, use_state_fallback: F },
    northampton: { county_id: "131", name: "Northampton", lat: 36.4212, lng: -77.4012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    onslow: { county_id: "133", name: "Onslow", lat: 34.7312, lng: -77.3612, zoning_mapserver_url: "https://gismaps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Planning_Data/MapServer", zoning_field_mapping: "ZONECODE", description_field: null, zoning_layers: "show:0", use_state_fallback: F },
    orange: { county_id: "135", name: "Orange", lat: 36.0612, lng: -79.1212, zoning_mapserver_url: "https://gis.orangecountync.gov/arcgis/rest/services/WebZoningService/MapServer", zoning_field_mapping: "Zoning", description_field: "Zoning_Def", zoning_layers: "show:22", use_state_fallback: F },
    pamlico: { county_id: "137", name: "Pamlico", lat: 35.1512, lng: -76.6812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    pasquotank: { county_id: "139", name: "Pasquotank", lat: 36.2621, lng: -76.2612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    pender: { county_id: "141", name: "Pender", lat: 34.4312, lng: -77.9012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    perquimans: { county_id: "143", name: "Perquimans", lat: 36.1821, lng: -76.4121, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    person: { county_id: "145", name: "Person", lat: 36.3921, lng: -78.9812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    pitt: { county_id: "147", name: "Pitt", lat: 35.5921, lng: -77.3612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    polk: { county_id: "149", name: "Polk", lat: 35.2812, lng: -82.1612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    randolph: { county_id: "151", name: "Randolph", lat: 35.7112, lng: -79.8112, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    richmond: { county_id: "153", name: "Richmond", lat: 34.9312, lng: -79.7412, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    robeson: { county_id: "155", name: "Robeson", lat: 34.6412, lng: -79.1012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    rockingham: { county_id: "157", name: "Rockingham", lat: 36.3921, lng: -79.7412, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    rowan: { county_id: "159", name: "Rowan", lat: 35.6512, lng: -80.5212, zoning_mapserver_url: "https://gis.rowancountync.gov/arcgis/rest/services/Public/Alll_Zoning/MapServer", zoning_field_mapping: "ZONING", description_field: "TYPE", zoning_layers: null, use_state_fallback: F },
    rutherford: { county_id: "161", name: "Rutherford", lat: 35.3312, lng: -81.9212, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    sampson: { county_id: "163", name: "Sampson", lat: 34.9812, lng: -78.3612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    scotland: { county_id: "165", name: "Scotland", lat: 34.8412, lng: -79.4812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    stanly: { county_id: "167", name: "Stanly", lat: 35.3521, lng: -80.2012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    stokes: { county_id: "169", name: "Stokes", lat: 36.4012, lng: -80.2312, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    surry: { county_id: "171", name: "Surry", lat: 36.4112, lng: -80.6812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    swain: { county_id: "173", name: "Swain", lat: 35.4812, lng: -83.4912, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    transylvania: { county_id: "175", name: "Transylvania", lat: 35.2012, lng: -82.7212, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    tyrrell: { county_id: "177", name: "Tyrrell", lat: 35.8512, lng: -76.1512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    union: { county_id: "179", name: "Union", lat: 34.9812, lng: -80.5312, zoning_mapserver_url: "https://gis.unioncountync.gov/server/rest/services/Zoning_Map_MIL1/MapServer", zoning_field_mapping: "ZONE", description_field: null, zoning_layers: "show:6", use_state_fallback: F },
    vance: { county_id: "181", name: "Vance", lat: 36.3121, lng: -78.4012, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    wake: { county_id: "183", name: "Wake", lat: 35.7721, lng: -78.6386, zoning_mapserver_url: "https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer", zoning_field_mapping: "CLASS", description_field: null, zoning_layers: null, use_state_fallback: F },
    warren: { county_id: "185", name: "Warren", lat: 36.3982, lng: -78.0812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    washington: { county_id: "187", name: "Washington", lat: 35.8512, lng: -76.6512, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    watauga: { county_id: "189", name: "Watauga", lat: 36.2112, lng: -81.6812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    wayne: { county_id: "191", name: "Wayne", lat: 35.3912, lng: -77.9812, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    wilkes: { county_id: "193", name: "Wilkes", lat: 36.2121, lng: -81.1612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    wilson: { county_id: "195", name: "Wilson", lat: 35.7512, lng: -77.9121, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    yadkin: { county_id: "197", name: "Yadkin", lat: 36.1612, lng: -80.6612, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
    yancey: { county_id: "199", name: "Yancey", lat: 35.9012, lng: -82.3112, zoning_mapserver_url: null, zoning_field_mapping: null, description_field: null, zoning_layers: null, use_state_fallback: T },
  },
};

const SC_COUNTY_NAMES = [
  "Abbeville", "Aiken", "Allendale", "Anderson", "Bamberg", "Barnwell", "Beaufort", "Berkeley", "Calhoun", "Charleston",
  "Cherokee", "Chester", "Chesterfield", "Clarendon", "Colleton", "Darlington", "Dillon", "Dorchester", "Edgefield", "Fairfield",
  "Florence", "Georgetown", "Greenville", "Greenwood", "Hampton", "Horry", "Jasper", "Kershaw", "Lancaster", "Laurens",
  "Lee", "Lexington", "Marion", "Marlboro", "McCormick", "Newberry", "Oconee", "Orangeburg", "Pickens", "Richland",
  "Saluda", "Spartanburg", "Sumter", "Union", "Williamsburg", "York",
] as const;

const NC_OVERLAP_COUNTIES = new Set(["beaufort", "cherokee", "lee", "union"]);
const scZoningKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "_");
const scCountyCode = (name: string, idx: number) => {
  if (name === "McCormick") return "065";
  if (name === "Marion") return "067";
  if (name === "Marlboro") return "069";
  return String(idx * 2 + 1).padStart(3, "0");
};

Object.assign(
  ncZoningRegistry.counties,
  Object.fromEntries(
    SC_COUNTY_NAMES.flatMap((name, idx) => {
      const config: CountyZoningConfig = {
        county_id: scCountyCode(name, idx),
        name: `${name}, SC`,
        lat: 0,
        lng: 0,
        zoning_mapserver_url: null,
        zoning_field_mapping: null,
        description_field: null,
        zoning_layers: null,
        use_state_fallback: T,
      };
      const shortKey = scZoningKey(name);
      const qualifiedKey = `${shortKey},_sc`;
      return NC_OVERLAP_COUNTIES.has(shortKey) ? [[qualifiedKey, config]] : [[qualifiedKey, config], [shortKey, config]];
    }),
  ),
);

// Verified SC county zoning MapServers (override the state-fallback default so
// the district overlays on the map + seeds the AI). Each endpoint was tested
// live against a real parcel point via the ArcGIS identify op.
const SC_ZONING_OVERRIDES: Record<string, CountyZoningConfig> = {
  "greenville,_sc": {
    county_id: "045", name: "Greenville, SC", lat: 34.8526, lng: -82.3940,
    // Greenville County GIS base map — layer 41 is the county zoning district
    // polygon (field ZONING, e.g. "MX-D", "R-1", "C-3"). Verified 2026.
    zoning_mapserver_url: "https://www.gcgis.org/arcgis/rest/services/GCGIA/Greenville_Base/MapServer",
    zoning_field_mapping: "ZONING", description_field: null, zoning_layers: "show:41",
    use_state_fallback: F,
  },
};
Object.assign(ncZoningRegistry.counties, SC_ZONING_OVERRIDES);

/** Normalize a county display name to its registry key (e.g. "New Hanover" -> "new_hanover"). */
export function normalizeCountyKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  const state = normalized.match(/,\s*(nc|sc)$/)?.[1];
  const county = normalized.replace(/,\s*(nc|sc)$/, '').replace(/\s+/g, "_");
  return state === 'sc' ? `${county},_sc` : county;
}

/** Returns the zoning config for a county, or undefined if not in the registry. */
export function getZoningConfig(name: string): CountyZoningConfig | undefined {
  return ncZoningRegistry.counties[normalizeCountyKey(name)];
}

/** True when the county publishes a usable zoning MapServer we can overlay/query. */
export function hasCountyZoning(name: string): boolean {
  const c = getZoningConfig(name);
  return !!(c && !c.use_state_fallback && c.zoning_mapserver_url);
}

/**
 * Returns every zoning MapServer for a county (primary + any extras for
 * multi-jurisdiction counties), in stacking order, each with its optional
 * `layers` sublayer restriction. Empty when the county has no published service.
 */
export function getZoningServices(name: string): ZoningService[] {
  const c = getZoningConfig(name);
  if (!c || c.use_state_fallback || !c.zoning_mapserver_url) return [];
  return [
    { url: c.zoning_mapserver_url, layers: c.zoning_layers ?? null },
    ...(c.extra_zoning ?? []).filter((s) => !!s.url),
  ];
}

export interface ResolvedZoning {
  code: string;
  description: string | null;
  sourceUrl?: string;
}

// --- Zoning attribute extraction --------------------------------------------
// ArcGIS `identify` returns field *aliases* as keys (which may contain spaces),
// and the zoning field name varies wildly by county/municipality. So rather than
// hardcode a field per layer, we scan attributes generically and lean on value
// shape: a zoning *code* is short and token-like ("R-3", "UC", "DX-5-UG"); a
// *description* is longer with spaces ("Downtown Mixed Use").

interface IdentifyResult { layerName?: string; attributes?: Record<string, unknown> | null; }

/** A non-empty, non-null, non-pure-numeric trimmed string, else null. */
function cleanZoningValue(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  if (/^\d+$/.test(s)) return null; // pure-numeric = internal id, not a zoning code
  return s;
}

// Keys that hold the zoning district (ZONING, ZONE, ZONE_TYPE, CLASS, DISTRICT,
// plus compact forms like ZCODE / ZNTYPE)…
const ZONING_KEY_RE = /zon|^zn|zcode|^code$|zclass|zdist|district|^class$|classif/i;
// …minus jurisdictions, ids, dates and other metadata.
const EXCLUDED_KEY_RE = /jur|muni|city|county|town|name|label|date|case|admin|petition|overlay|owner|acre|hyperlink|website|url|globalid|objectid|shape|_id$|id$|fid|height|frontage/i;
// Keys that hold a human-readable district description.
const DESC_KEY_RE = /desc|def|decode|classif/i;
const AREA_KEY_RE = /st_?area|area$/i;

const isZoningKey = (k: string) => ZONING_KEY_RE.test(k) && !EXCLUDED_KEY_RE.test(k);
const isDescKey = (k: string) => DESC_KEY_RE.test(k) && !EXCLUDED_KEY_RE.test(k);
const isCodeShape = (s: string) => s.length <= 16 && /[A-Za-z]/.test(s);
const byLengthAsc = (a: string, b: string) => a.length - b.length;

// County-wide layers stamp these placeholders where a municipality does its own
// zoning; the real code lives in that town's separate sublayer, so we ignore them.
const isPlaceholderCode = (code: string, desc: string | null) =>
  /^(city|county|etj|unzoned|none|n\/a|mun\.?|municipal|municipality)$/i.test(code) ||
  /\b(city|town|county|limits|municipal)\b/i.test(code) ||
  (!!desc && /\b(town|city)\s+limits\b/i.test(desc));

/**
 * Picks the best real zoning code/description from ArcGIS `identify` results.
 * Prefers a real (non-placeholder) code and, among overlapping polygons, the
 * most specific (smallest-area) one. Pure and self-contained for easy testing.
 */
export function extractZoning(results: IdentifyResult[]): ResolvedZoning | null {
  const candidates: { code: string; description: string | null; area: number; placeholder: boolean }[] = [];

  for (const r of results) {
    // Overlay districts (watershed, urban-standards, airport, etc.) supplement
    // the base zoning and are often smaller polygons — skip them so we report
    // the underlying base district, not the overlay.
    if (/overlay/i.test(r.layerName || "")) continue;
    const attrs = r.attributes || {};
    const keys = Object.keys(attrs);
    const zoningVals = keys.filter(isZoningKey).map((k) => cleanZoningValue(attrs[k])).filter((v): v is string => !!v);
    if (zoningVals.length === 0) continue;

    // Code: prefer a *complete* code — drop values truncated with a trailing
    // separator (a base like "DX-" when the full "DX-5-UG" is present) — then
    // take the shortest token-like value.
    const shaped = zoningVals.filter(isCodeShape);
    const complete = shaped.filter((s) => !/[-_/]$/.test(s));
    const codePool = complete.length ? complete : shaped.length ? shaped : zoningVals;
    const code = [...codePool].sort(byLengthAsc)[0];
    if (!code) continue;

    // Description: the longest human-readable value (has a space) from a zoning
    // or description field, other than the code itself.
    const descVals = zoningVals.concat(keys.filter(isDescKey).map((k) => cleanZoningValue(attrs[k])).filter((v): v is string => !!v));
    const description = descVals
      .filter((v) => v !== code && /\s/.test(v) && v.length > code.length)
      .sort((a, b) => b.length - a.length)[0] || null;

    const areaKey = keys.find((k) => AREA_KEY_RE.test(k));
    const area = areaKey ? parseFloat(String(attrs[areaKey])) || Infinity : Infinity;
    candidates.push({ code, description, area, placeholder: isPlaceholderCode(code, description) });
  }

  const real = candidates.filter((c) => !c.placeholder);
  if (real.length === 0) return null; // only placeholders => no usable county code
  real.sort((a, b) => a.area - b.area);
  return { code: real[0].code, description: real[0].description };
}

/**
 * Queries a single zoning MapServer at a WGS84 point via the ArcGIS `identify`
 * op and returns the real zoning code/description, or null if nothing usable.
 */
async function identifyZoning(service: ZoningService, lng: number, lat: number): Promise<ResolvedZoning | null> {
  // Escalating search radius: a tight tolerance first (exact point), then a
  // wider one to catch points that sit just off the polygon from geocoding
  // imprecision or a parcel/right-of-way edge — so we resolve the REAL district
  // instead of giving up and showing "See map". extractZoning still picks the
  // most specific (smallest-area) polygon among any hits, so widening the radius
  // recovers near-misses without grabbing a far-away district.
  const passes: { tol: string; d: number }[] = [
    { tol: "3", d: 0.0015 },   // ~2.5 m — exact point
    { tol: "10", d: 0.003 },   // ~16 m — recovers slightly-off geocodes
  ];
  // Fire BOTH passes concurrently (one round-trip, not two) and prefer the tight
  // pass's result — so recovering a near-edge point costs no extra wait.
  const results = await Promise.all(passes.map(({ tol, d }) => {
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: "esriGeometryPoint",
      sr: "4326",
      tolerance: tol,
      mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`,
      imageDisplay: "400,400,96",
      layers: service.layers ? `all:${service.layers.replace(/^show:/, "")}` : "all",
      returnGeometry: "false",
      f: "json",
    });
    return fetch(`${service.url}/identify?${params.toString()}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (Array.isArray(data?.results) && data.results.length ? extractZoning(data.results) : null))
      .catch((e) => { console.warn(`Zoning identify failed for ${service.url}:`, e); return null; });
  }));
  const hit = results.find((z) => z) || null; // index 0 (tight) wins when both hit
  return hit ? { ...hit, sourceUrl: service.url } : null;
}

/**
 * Resolves the real zoning code/description at a WGS84 point for a county by
 * trying each of its zoning services (primary + extras) in order, returning the
 * first real hit. Returns null when the county publishes no zoning service or
 * none of them carry a code at the point (e.g. an in-between municipal gap).
 */
export async function fetchCountyZoningCode(
  countyName: string,
  lng: number,
  lat: number,
): Promise<ResolvedZoning | null> {
  for (const service of getZoningServices(countyName)) {
    const hit = await identifyZoning(service, lng, lat);
    if (hit) return hit;
  }
  return null;
}
