// Complete routing inventory for South Carolina zoning lookups. These are
// official county GIS/assessor entry points; municipal zoning is resolved from
// the exact parcel coordinate after the county route is selected.
export const SC_ZONING_COVERAGE = Object.freeze([
  { county: 'Abbeville', fips: '45001', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=613&LayerID=10508&PageTypeID=1' },
  { county: 'Aiken', fips: '45003', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=844&LayerID=15264&PageTypeID=1&PageID=6876' },
  { county: 'Allendale', fips: '45005', provider: 'restricted', officialMapUrl: 'https://www.allendalecounty.com/' },
  { county: 'Anderson', fips: '45007', provider: 'county', officialMapUrl: 'https://propertyviewer.andersoncountysc.org/mapsjs/' },
  { county: 'Bamberg', fips: '45009', provider: 'restricted', officialMapUrl: 'https://www.bambergcounty.sc.gov/parcel-gis-maps' },
  { county: 'Barnwell', fips: '45011', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=898&LayerID=16996&PageTypeID=1&PageID=7643' },
  { county: 'Beaufort', fips: '45013', provider: 'county', officialMapUrl: 'https://gis.beaufortcountysc.gov/publicmapping/index.html' },
  { county: 'Berkeley', fips: '45015', provider: 'county', officialMapUrl: 'https://gis.berkeleycountysc.gov/maps/advanced_map/' },
  { county: 'Calhoun', fips: '45017', provider: 'county', officialMapUrl: 'https://gis.aecomonline.net/Calhounparcel/' },
  { county: 'Charleston', fips: '45019', provider: 'county', officialMapUrl: 'https://gisccweb.charlestoncounty.org/Public_Search/' },
  { county: 'Cherokee', fips: '45021', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=908&LayerID=17379&PageTypeID=1&PageID=7805' },
  { county: 'Chester', fips: '45023', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=217&LayerID=2943&PageTypeID=1&PageID=0' },
  { county: 'Chesterfield', fips: '45025', provider: 'wthgis', officialMapUrl: 'https://chesterfieldsc.wthgis.com/' },
  { county: 'Clarendon', fips: '45027', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=795&LayerID=11833&PageTypeID=1&PageID=0' },
  { county: 'Colleton', fips: '45029', provider: 'arcgis', officialMapUrl: 'https://colletoncounty.maps.arcgis.com/apps/webappviewer/index.html?id=dcd2d7443dc9448ea910b9788a2c6b05', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1046&LayerID=23500&PageTypeID=1&PageID=0' },
  { county: 'Darlington', fips: '45031', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=858&LayerID=16088&PageTypeID=1&PageID=0' },
  { county: 'Dillon', fips: '45033', provider: 'wthgis', officialMapUrl: 'https://dillonsc.wthgis.com/' },
  { county: 'Dorchester', fips: '45035', provider: 'arcgis', officialMapUrl: 'https://dcscgis.maps.arcgis.com/apps/webappviewer/index.html?id=c5b2bd07c3b84ce98d09c6611377e89c' },
  { county: 'Edgefield', fips: '45037', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=859&LayerID=16089&PageTypeID=1&PageID=7159' },
  { county: 'Fairfield', fips: '45039', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=796&LayerID=11834&PageTypeID=1&PageID=5735' },
  { county: 'Florence', fips: '45041', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=920&LayerID=17892&PageTypeID=1&PageID=0', alternateMapUrl: 'http://arc2000.florenceco.org/Florence_County_Maps/' },
  { county: 'Georgetown', fips: '45043', provider: 'arcgis', officialMapUrl: 'https://georgetown.maps.arcgis.com/apps/webappviewer/index.html?id=8914e8af08b34826b2f38aac4dec476b', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=863&LayerID=16169&PageTypeID=1&PageID=0' },
  { county: 'Greenville', fips: '45045', provider: 'county', officialMapUrl: 'https://www.gcgis.org/' },
  { county: 'Greenwood', fips: '45047', provider: 'county', officialMapUrl: 'https://www.greenwoodsc.gov/greenwoodnj/index.html' },
  { county: 'Hampton', fips: '45049', provider: 'arcgis', officialMapUrl: 'https://hamptoncountysc.maps.arcgis.com/apps/webappviewer/index.html?id=bf76cad67d1a48449fb7f9a316c4185e' },
  { county: 'Horry', fips: '45051', provider: 'arcgis', officialMapUrl: 'https://www.arcgis.com/home/webmap/viewer.html?webmap=8488664081244209922ff91537064b1e' },
  { county: 'Jasper', fips: '45053', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=921&LayerID=17896&PageTypeID=1&PageID=0' },
  { county: 'Kershaw', fips: '45055', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1249&LayerID=40593&PageTypeID=1&PageID=15083' },
  { county: 'Lancaster', fips: '45057', provider: 'arcgis', officialMapUrl: 'https://lancaster-launch-lancogis.hub.arcgis.com/pages/gis-web-map-page', alternateMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=211&LayerID=2815&PageTypeID=1&PageID=1605' },
  { county: 'Laurens', fips: '45059', provider: 'county', officialMapUrl: 'https://www.laurenscountygis.org/parcel/', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1228&LayerID=39077&PageTypeID=1&PageID=14510' },
  { county: 'Lee', fips: '45061', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=913&LayerID=17622&PageTypeID=1&PageID=7893' },
  { county: 'Lexington', fips: '45063', provider: 'county', officialMapUrl: 'https://maps.lex-co.com/OneMap/' },
  { county: 'McCormick', fips: '45065', provider: 'wthgis', officialMapUrl: 'https://mccormicksc.wthgis.com/' },
  { county: 'Marion', fips: '45067', provider: 'wthgis', officialMapUrl: 'https://marionsc.wthgis.com/' },
  { county: 'Marlboro', fips: '45069', provider: 'wthgis', officialMapUrl: 'https://marlborosc.wthgis.com/' },
  { county: 'Newberry', fips: '45071', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=868&LayerID=16446&PageTypeID=1' },
  { county: 'Oconee', fips: '45073', provider: 'beacon', officialMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1030&LayerID=21692&PageTypeID=1&PageID=9255' },
  { county: 'Orangeburg', fips: '45075', provider: 'arcgis', officialMapUrl: 'https://experience.arcgis.com/experience/02a8eeae9f074df9a0821ae7e1125c86', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=1214&LayerID=36780&PageTypeID=1&PageID=14063' },
  { county: 'Pickens', fips: '45077', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=927&LayerID=18058&PageTypeID=1&PageID=8074' },
  {
    county: 'Richland',
    fips: '45079',
    provider: 'county',
    officialMapUrl: 'https://richlandmaps.com/apps/dataviewer/',
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
  { county: 'Spartanburg', fips: '45083', provider: 'arcgis', officialMapUrl: 'https://maps.spartanburgcounty.org/portal/apps/webappviewer/index.html?id=8a88ed02adb845938c81f8c0c4214b9e', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=857&LayerID=16069&PageTypeID=1&PageID=0' },
  { county: 'Sumter', fips: '45085', provider: 'qpublic', officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?App=SumterCountySC&PageType=Map' },
  {
    county: 'Union',
    fips: '45087',
    provider: 'qpublic',
    officialMapUrl: 'https://qpublic.schneidercorp.com/Application.aspx?AppID=861&LayerID=16112&PageTypeID=1&PageID=0',
    noCountywideZoningSource: 'https://library.municode.com/sc/union_county',
  },
  { county: 'Williamsburg', fips: '45089', provider: 'wthgis', officialMapUrl: 'https://williamsburgsc.wthgis.com/' },
  { county: 'York', fips: '45091', provider: 'county', officialMapUrl: 'https://maps.yorkcountygov.com/v/index.html?viewer=omviewer', alternateMapUrl: 'https://beacon.schneidercorp.com/Application.aspx?AppID=862&LayerID=16113&PageTypeID=1&PageID=0' },
]);

export function scZoningCoverage(countyName) {
  const county = String(countyName || '')
    .split(',')[0]
    .replace(/\s+County$/i, '')
    .trim()
    .toLowerCase();
  return SC_ZONING_COVERAGE.find((entry) => entry.county.toLowerCase() === county);
}
