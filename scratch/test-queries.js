const WAKE_URL = 'https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0/query';
const GASTON_URL = 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query';
const CABARRUS_URL = 'https://location.cabarruscounty.us/arcgisservices/rest/services/Parcels/MapServer/0/query';

// Helper to format string to Title Case
function toTitleCase(str) {
  if (!str) return 'N/A';
  return str.toLowerCase().replace(/(?:^|\s|-|\/)\S/g, (m) => m.toUpperCase());
}

async function queryWakeLocalParcel(lng, lat) {
  const urlWgs84 = `${WAKE_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
  const urlStatePlane = `${WAKE_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&f=json`;

  const [resWgs84, resStatePlane] = await Promise.all([
    fetch(urlWgs84),
    fetch(urlStatePlane)
  ]);

  if (resWgs84.ok && resStatePlane.ok) {
    const wgs84Json = await resWgs84.json();
    const spJson = await resStatePlane.json();

    if (wgs84Json.features && wgs84Json.features.length > 0) {
      const wgs84Feature = wgs84Json.features[0];
      const spFeature = spJson.features ? spJson.features[0] : null;
      const attributes = wgs84Feature.attributes || {};
      
      const gisacres = attributes.CALC_AREA ? parseFloat(attributes.CALC_AREA) : 0.25;

      // Parse ADDR2 (e.g. "HOLLY SPRINGS NC 27540-4452")
      const addr2 = attributes.ADDR2 || "";
      let mcity = "N/A", mstate = "NC", mzip = "N/A";
      const match = addr2.trim().match(/^(.*?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
      if (match) {
        mcity = match[1].trim();
        mstate = match[2];
        mzip = match[3];
      }

      const properties = {
        parno: attributes.PIN_NUM || "N/A",
        ownname: attributes.OWNER ? toTitleCase(attributes.OWNER) : "N/A",
        mailadd: attributes.ADDR1 ? toTitleCase(attributes.ADDR1) : "N/A",
        mcity: toTitleCase(mcity),
        mstate,
        mzip,
        saledate: attributes.SALE_DATE || attributes.DEED_DATE || null,
        parval: attributes.TOTAL_VALUE_ASSD || (attributes.BLDG_VAL + attributes.LAND_VAL) || 0,
        landval: attributes.LAND_VAL || 0,
        reviseyear: "2025",
        siteadd: attributes.SITE_ADDRESS ? toTitleCase(attributes.SITE_ADDRESS) : "N/A",
        legdecfull: attributes.PROPDESC || "Local County Parcel",
        gisacres: gisacres.toString()
      };

      return {
        wgs84Feature: {
          type: "Feature",
          properties,
          geometry: {
            type: "Polygon",
            coordinates: wgs84Feature.geometry.rings
          }
        },
        statePlaneFeature: spFeature
      };
    }
  }
  return null;
}

async function queryGastonLocalParcel(lng, lat) {
  const urlWgs84 = `${GASTON_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
  const urlStatePlane = `${GASTON_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&f=json`;

  const [resWgs84, resStatePlane] = await Promise.all([
    fetch(urlWgs84),
    fetch(urlStatePlane)
  ]);

  if (resWgs84.ok && resStatePlane.ok) {
    const wgs84Json = await resWgs84.json();
    const spJson = await resStatePlane.json();

    if (wgs84Json.features && wgs84Json.features.length > 0) {
      const wgs84Feature = wgs84Json.features[0];
      const spFeature = spJson.features ? spJson.features[0] : null;
      const attributes = wgs84Feature.attributes || {};
      
      const gisacres = attributes.CALCAC ? parseFloat(attributes.CALCAC) : 0.25;

      const ownerName = attributes.CURR_NAME1 + (attributes.CURR_NAME2 ? " & " + attributes.CURR_NAME2 : "");

      const properties = {
        parno: attributes.PIN || attributes.PID || "N/A",
        ownname: ownerName ? toTitleCase(ownerName) : "N/A",
        mailadd: attributes.CURR_ADDR1 ? toTitleCase(attributes.CURR_ADDR1) : "N/A",
        mcity: attributes.CURR_CITY ? toTitleCase(attributes.CURR_CITY) : "N/A",
        mstate: attributes.CURR_STATE || "NC",
        mzip: attributes.CURR_ZIPCODE || "N/A",
        saledate: attributes.SALEDATE || null,
        parval: attributes.FMV_TOTAL || 0,
        landval: attributes.FMV_LAND || 0,
        reviseyear: attributes.parcel_year ? attributes.parcel_year.toString() : "2025",
        siteadd: attributes.PHYSSTRADD ? toTitleCase(attributes.PHYSSTRADD) : "N/A",
        legdecfull: attributes.LEGDESC_1 || "Local County Parcel",
        gisacres: gisacres.toString()
      };

      return {
        wgs84Feature: {
          type: "Feature",
          properties,
          geometry: {
            type: "Polygon",
            coordinates: wgs84Feature.geometry.rings
          }
        },
        statePlaneFeature: spFeature
      };
    }
  }
  return null;
}

async function queryCabarrusLocalParcel(lng, lat) {
  const urlWgs84 = `${CABARRUS_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
  const urlStatePlane = `${CABARRUS_URL}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&f=json`;

  const [resWgs84, resStatePlane] = await Promise.all([
    fetch(urlWgs84),
    fetch(urlStatePlane)
  ]);

  if (resWgs84.ok && resStatePlane.ok) {
    const wgs84Json = await resWgs84.json();
    const spJson = await resStatePlane.json();

    if (wgs84Json.features && wgs84Json.features.length > 0) {
      const wgs84Feature = wgs84Json.features[0];
      const spFeature = spJson.features ? spJson.features[0] : null;
      const attributes = wgs84Feature.attributes || {};
      
      const gisacres = attributes.CALCULATED_ACREAGE ? parseFloat(attributes.CALCULATED_ACREAGE) : 0.25;

      const ownerName = attributes.AcctName1 + (attributes.AcctName2 ? " & " + attributes.AcctName2 : "");

      const properties = {
        parno: attributes.PIN || "N/A",
        ownname: ownerName ? toTitleCase(ownerName) : "N/A",
        mailadd: attributes.MailAddr1 ? toTitleCase(attributes.MailAddr1) : "N/A",
        mcity: attributes.MailCity ? toTitleCase(attributes.MailCity) : "N/A",
        mstate: attributes.MailState || "NC",
        mzip: attributes.MailZipCode || "N/A",
        saledate: Date.now() - 3 * 365 * 24 * 60 * 60 * 1000, // Default 3 years ago fallback
        parval: attributes.MarketValue || attributes.AssessedValue || 0,
        landval: attributes.LandValue || 0,
        reviseyear: "2025",
        siteadd: attributes.LegalDesc ? toTitleCase(attributes.LegalDesc) : "N/A", // Legal description is more descriptive in this county
        legdecfull: attributes.LegalDesc || "Local County Parcel",
        gisacres: gisacres.toString()
      };

      // Set siteadd to a combination of AcctName or default if site address field isn't direct
      if (attributes.LegalDesc) {
        properties.siteadd = toTitleCase(attributes.LegalDesc);
      }

      return {
        wgs84Feature: {
          type: "Feature",
          properties,
          geometry: {
            type: "Polygon",
            coordinates: wgs84Feature.geometry.rings
          }
        },
        statePlaneFeature: spFeature
      };
    }
  }
  return null;
}

async function run() {
  // 1. Wake County sample coordinate (from Bill Love Rd centroid lookup in database: let's query first to get coords)
  console.log("Fetching a Wake County coordinate...");
  const wakeRes = await fetch(`${WAKE_URL}?where=PIN_NUM%3D%270695327712%27&outFields=*&returnGeometry=true&outSR=4326&f=json`);
  const wakeData = await wakeRes.json();
  if (wakeData.features && wakeData.features.length > 0) {
    const ring = wakeData.features[0].geometry.rings[0];
    const lng = ring[0][0];
    const lat = ring[0][1];
    console.log(`Wake coordinate: ${lng}, ${lat}`);
    const wakeResult = await queryWakeLocalParcel(lng, lat);
    console.log("Wake Result properties:", wakeResult ? wakeResult.wgs84Feature.properties : "null");
  }

  // 2. Gaston County sample coordinate (from N Weldon St)
  console.log("\nFetching a Gaston County coordinate...");
  const gastonLng = -81.19481699;
  const gastonLat = 35.28019461;
  const gastonResult = await queryGastonLocalParcel(gastonLng, gastonLat);
  console.log("Gaston Result properties:", gastonResult ? gastonResult.wgs84Feature.properties : "null");

  // 3. Cabarrus County sample coordinate
  console.log("\nFetching a Cabarrus County coordinate...");
  const cabarrusRes = await fetch(`${CABARRUS_URL}?where=PIN%3D%275604122201.00000000%27&outFields=*&returnGeometry=true&outSR=4326&f=json`);
  const cabarrusData = await cabarrusRes.json();
  if (cabarrusData.features && cabarrusData.features.length > 0) {
    const ring = cabarrusData.features[0].geometry.rings[0];
    const lng = ring[0][0];
    const lat = ring[0][1];
    console.log(`Cabarrus coordinate: ${lng}, ${lat}`);
    const cabarrusResult = await queryCabarrusLocalParcel(lng, lat);
    console.log("Cabarrus Result properties:", cabarrusResult ? cabarrusResult.wgs84Feature.properties : "null");
  }
}

run();
