// Complete routing inventory for South Carolina zoning lookups. These are
// official county GIS/assessor entry points; municipal zoning is resolved from
// the exact parcel coordinate after the county route is selected.
export const SC_ZONING_COVERAGE = Object.freeze([
  { county: 'Abbeville', fips: '45001', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=613&LayerID=10508&PageTypeID=1' },
  { county: 'Aiken', fips: '45003', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=844&LayerID=15264&PageTypeID=1&PageID=6876' },
  { county: 'Allendale', fips: '45005', provider: 'restricted', officialMapUrl: 'https://www.allendalecounty.com/' },
  { county: 'Anderson', fips: '45007', provider: 'county', officialMapUrl: 'https://propertyviewer.andersoncountysc.org/mapsjs/', zoningServices: ['https://propertyviewer.andersoncountysc.org/arcgis/rest/services/QueryMap/MapServer', 'https://gis.cityofandersonsc.com/arcgis/rest/services/Reference_Data/Zoning/FeatureServer'] },
  { county: 'Bamberg', fips: '45009', provider: 'restricted', officialMapUrl: 'https://www.bambergcounty.sc.gov/parcel-gis-maps' },
  { county: 'Barnwell', fips: '45011', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=898&LayerID=16996&PageTypeID=1&PageID=7643' },
  { county: 'Beaufort', fips: '45013', provider: 'county', officialMapUrl: 'https://gis.beaufortcountysc.gov/publicmapping/index.html', zoningServices: ['https://gis.beaufortcountysc.gov/server/rest/services/Zoning/MapServer', 'https://services9.arcgis.com/NpTdr5u1ft9aY31O/ArcGIS/rest/services/City_of_Beaufort_Zoning/FeatureServer'] },
  { county: 'Berkeley', fips: '45015', provider: 'county', officialMapUrl: 'https://gis.berkeleycountysc.gov/maps/advanced_map/', zoningServices: ['https://gis.berkeleycountysc.gov/arcgis/rest/services/desktop/internet_map/MapServer'] },
  { county: 'Calhoun', fips: '45017', provider: 'county', officialMapUrl: 'https://gis.aecomonline.net/Calhounparcel/', zoningServices: ['https://services5.arcgis.com/B3Zo1xqTw8CidOoF/arcgis/rest/services/Calhoun_County_Zoning/FeatureServer', 'https://services5.arcgis.com/B3Zo1xqTw8CidOoF/arcgis/rest/services/St_Matthews_Zoning/FeatureServer'] },
  { county: 'Charleston', fips: '45019', provider: 'county', officialMapUrl: 'https://gisccweb.charlestoncounty.org/Public_Search/', zoningServices: ['https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer'] },
  { county: 'Cherokee', fips: '45021', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=908&LayerID=17379&PageTypeID=1&PageID=7805' },
  { county: 'Chester', fips: '45023', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=217&LayerID=2943&PageTypeID=1&PageID=0' },
  { county: 'Chesterfield', fips: '45025', provider: 'wthgis', officialMapUrl: 'https://chesterfieldsc.wthgis.com/' },
  { county: 'Clarendon', fips: '45027', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=795&LayerID=11833&PageTypeID=1&PageID=0' },
  { county: 'Colleton', fips: '45029', provider: 'arcgis', officialMapUrl: 'https://colletoncounty.maps.arcgis.com/apps/webappviewer/index.html?id=dcd2d7443dc9448ea910b9788a2c6b05', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1046&LayerID=23500&PageTypeID=1&PageID=0', zoningServices: ['https://services1.arcgis.com/m0cnLGKdhwao8WvM/arcgis/rest/services/Colleton_County_Zoning/MapServer'] },
  { county: 'Darlington', fips: '45031', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=858&LayerID=16088&PageTypeID=1&PageID=0', zoningServices: ['https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/DARLINGTON_ZONING/FeatureServer', 'https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/HARTSVILLE_ZONING/FeatureServer'] },
  { county: 'Dillon', fips: '45033', provider: 'wthgis', officialMapUrl: 'https://dillonsc.wthgis.com/' },
  { county: 'Dorchester', fips: '45035', provider: 'arcgis', officialMapUrl: 'https://dcscgis.maps.arcgis.com/apps/webappviewer/index.html?id=c5b2bd07c3b84ce98d09c6611377e89c', zoningServices: ['https://gisportal.dorchestercounty.net/hosting/rest/services/General_Data/Zoning_PUBLIC/MapServer', 'https://gisportal.dorchestercounty.net/hosting/rest/services/General_Data/Town_Zoning_Public/MapServer'] },
  { county: 'Edgefield', fips: '45037', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=859&LayerID=16089&PageTypeID=1&PageID=7159' },
  { county: 'Fairfield', fips: '45039', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=796&LayerID=11834&PageTypeID=1&PageID=5735' },
  { county: 'Florence', fips: '45041', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=920&LayerID=17892&PageTypeID=1&PageID=0', alternateMapUrl: 'http://arc2000.florenceco.org/Florence_County_Maps/', zoningServices: ['https://services1.arcgis.com/40L6yX6OtdCifNez/arcgis/rest/services/UDOZoning/FeatureServer'] },
  { county: 'Georgetown', fips: '45043', provider: 'arcgis', officialMapUrl: 'https://georgetown.maps.arcgis.com/apps/webappviewer/index.html?id=8914e8af08b34826b2f38aac4dec476b', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=863&LayerID=16169&PageTypeID=1&PageID=0', zoningServices: ['https://gis1.georgetowncountysc.org/portal/rest/services/GCGIS_Planning/MapServer'] },
  { county: 'Greenville', fips: '45045', provider: 'county', officialMapUrl: 'https://www.gcgis.org/', zoningServices: ['https://www.gcgis.org/arcgis/rest/services/GCGIA/Greenville_Base/MapServer'] },
  { county: 'Greenwood', fips: '45047', provider: 'county', officialMapUrl: 'https://www.greenwoodsc.gov/greenwoodnj/index.html' },
  { county: 'Hampton', fips: '45049', provider: 'arcgis', officialMapUrl: 'https://hamptoncountysc.maps.arcgis.com/apps/webappviewer/index.html?id=bf76cad67d1a48449fb7f9a316c4185e' },
  { county: 'Horry', fips: '45051', provider: 'arcgis', officialMapUrl: 'https://www.arcgis.com/home/webmap/viewer.html?webmap=8488664081244209922ff91537064b1e', zoningServices: ['https://www.horrycounty.org/gispublic/rest/services/Public/Zoning/MapServer'] },
  { county: 'Jasper', fips: '45053', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=921&LayerID=17896&PageTypeID=1&PageID=0' },
  { county: 'Kershaw', fips: '45055', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1249&LayerID=40593&PageTypeID=1&PageID=15083' },
  { county: 'Lancaster', fips: '45057', provider: 'arcgis', officialMapUrl: 'https://lancaster-launch-lancogis.hub.arcgis.com/pages/gis-web-map-page', alternateMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=211&LayerID=2815&PageTypeID=1&PageID=1605', zoningServices: ['https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/Zoning_City/FeatureServer'] },
  { county: 'Laurens', fips: '45059', provider: 'county', officialMapUrl: 'https://www.laurenscountygis.org/parcel/', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1228&LayerID=39077&PageTypeID=1&PageID=14510' },
  { county: 'Lee', fips: '45061', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=913&LayerID=17622&PageTypeID=1&PageID=7893' },
  { county: 'Lexington', fips: '45063', provider: 'county', officialMapUrl: 'https://maps.lex-co.com/OneMap/', zoningServices: ['https://maps.lex-co.com/agstserver/rest/services/PlanZoning/MapServer'] },
  { county: 'McCormick', fips: '45065', provider: 'wthgis', officialMapUrl: 'https://mccormicksc.wthgis.com/' },
  { county: 'Marion', fips: '45067', provider: 'wthgis', officialMapUrl: 'https://marionsc.wthgis.com/' },
  { county: 'Marlboro', fips: '45069', provider: 'wthgis', officialMapUrl: 'https://marlborosc.wthgis.com/' },
  { county: 'Newberry', fips: '45071', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=868&LayerID=16446&PageTypeID=1' },
  { county: 'Oconee', fips: '45073', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1030&LayerID=21692&PageTypeID=1&PageID=9255', arcgisItemIds: ['1040b75d3dcf4db4b74c0b670f3343cd'], zoningServices: ['https://arcserver2.oconeesc.com/arcgis/rest/services/ZoningMap/MapServer'] },
  { county: 'Orangeburg', fips: '45075', provider: 'arcgis', officialMapUrl: 'https://experience.arcgis.com/experience/02a8eeae9f074df9a0821ae7e1125c86', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1214&LayerID=36780&PageTypeID=1&PageID=14063', zoningServices: ['https://services2.arcgis.com/bUKn95BqgpYYTnx3/arcgis/rest/services/Main_Public_Tax_Parcel_Map_WFL1/FeatureServer'] },
  { county: 'Pickens', fips: '45077', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=927&LayerID=18058&PageTypeID=1&PageID=8074' },
  {
    county: 'Richland',
    fips: '45079',
    provider: 'county',
    officialMapUrl: 'https://richlandmaps.com/apps/dataviewer/',
    zoningServices: ['https://services1.arcgis.com/Mnt8FoJcogKtoVBs/arcgis/rest/services/ZoningDistrict/FeatureServer'],
    zoningWms: {
      url: 'https://a.richlandmaps.com/geoserver/wms',
      layer: 'postgisworkspace:rcgeo_zoning_wgs84',
      codeField: 'zoning_pri',
      secondaryCodeField: 'zoning_sec',
      parcelField: 'tms',
      addressField: 'situs_addr',
    },
  },
  { county: 'Saluda', fips: '45081', provider: 'county', officialMapUrl: 'https://saludacountysc.net/SaludaCountyViewer/' },
  { county: 'Spartanburg', fips: '45083', provider: 'arcgis', officialMapUrl: 'https://maps.spartanburgcounty.org/portal/apps/webappviewer/index.html?id=8a88ed02adb845938c81f8c0c4214b9e', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=857&LayerID=16069&PageTypeID=1&PageID=0', zoningServices: ['https://maps.spartanburgcounty.org/server/rest/services/IZM_Districts/MapServer'] },
  { county: 'Sumter', fips: '45085', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?App=SumterCountySC&PageType=Map', arcgisItemIds: ['1f33ad2e99b34341b7dc9d7362b38001'], zoningServices: ['https://services.arcgis.com/4B9WU9185SohZnyi/arcgis/rest/services/UDO_Zoning_Service_Map_WFL1/FeatureServer'] },
  {
    county: 'Union',
    fips: '45087',
    provider: 'qpublic',
    officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=861&LayerID=16112&PageTypeID=1&PageID=0',
    noCountywideZoningSource: 'https://library.municode.com/sc/union_county',
  },
  { county: 'Williamsburg', fips: '45089', provider: 'wthgis', officialMapUrl: 'https://williamsburgsc.wthgis.com/' },
  { county: 'York', fips: '45091', provider: 'county', officialMapUrl: 'https://maps.yorkcountygov.com/v/index.html?viewer=omviewer', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=862&LayerID=16113&PageTypeID=1&PageID=0', arcgisItemIds: ['e827d330f20a4508aa6777bf2c0b94e3'], zoningServices: ['https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/York%20County%20Zoning%20(regions)/FeatureServer', 'https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Rock%20Hill%20Zoning/FeatureServer', 'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/TownofCloverSC_Zoning/FeatureServer', 'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/CityofYorkSC_Zoning/FeatureServer', 'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/TownofFortMillSC_Zoning/FeatureServer', 'https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/CityofTegaCaySC_Zoning/FeatureServer'] },
]);

export function scZoningCoverage(countyName) {
  const county = String(countyName || '')
    .split(',')[0]
    .replace(/\s+County$/i, '')
    .trim()
    .toLowerCase();
  return SC_ZONING_COVERAGE.find((entry) => entry.county.toLowerCase() === county);
}
