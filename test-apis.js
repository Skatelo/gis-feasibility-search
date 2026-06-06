// Using native global fetch


async function testNCMapServer() {
  console.log("=== Testing NC OneMap Parcel Query in WGS84 ===");
  // Query a Mecklenburg parcel and request the geometry in WGS84 (outSR=4326)
  const testUrl = `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?where=cntyname+%3D+%27Mecklenburg%27&outFields=*&resultRecordCount=1&outSR=4326&f=json`;

  try {
    const res = await fetch(testUrl);
    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }
    const data = await res.json();
    if (!data.features || data.features.length === 0) {
      console.log("❌ No features returned. Check where clause.");
      return null;
    }
    
    const feature = data.features[0];
    const attributes = feature.attributes;
    console.log("✅ Query succeeded!");
    console.log("   County Name (cntyname):", attributes.cntyname);
    console.log("   Parcel Number (parno):", attributes.parno);
    
    // Now let's print the geometry in WGS84
    console.log("   WGS84 Geometry Rings (first 3 vertices):", JSON.stringify(feature.geometry.rings[0].slice(0, 3)));
    
    const wgsLng = feature.geometry.rings[0][0][0];
    const wgsLat = feature.geometry.rings[0][0][1];
    
    console.log(`\n=== Testing Point Intersection with WGS84 coordinates: ${wgsLng}, ${wgsLat} ===`);
    const pointParams = new URLSearchParams({
      geometry: `${wgsLng},${wgsLat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: "true",
      f: "json"
    });
    const pointUrl = `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${pointParams.toString()}`;
    const pointRes = await fetch(pointUrl);
    const pointData = await pointRes.json();
    console.log("   WGS84 Point Query features count:", pointData.features ? pointData.features.length : 0);
    if (pointData.features && pointData.features.length > 0) {
      console.log("   Resolved parcel ID:", pointData.features[0].attributes.parno);
    }
    
    // Also retrieve the State Plane coordinate version of the vertex to test Charlotte zoning
    // Note: since we did NOT pass outSR for the original feature in our real service, the original geometry returned by NC OneMap is in State Plane!
    // Let's verify by querying the same parcel without outSR to get its native geometry.
    const nativeUrl = `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?where=parno+%3D+%27${attributes.parno}%27&outFields=*&f=json`;
    const nativeRes = await fetch(nativeUrl);
    const nativeData = await nativeRes.json();
    const nativeFeature = nativeData.features[0];
    const spX = nativeFeature.geometry.rings[0][0][0];
    const spY = nativeFeature.geometry.rings[0][0][1];
    console.log(`\n   Native Geometry State Plane X: ${spX}, Y: ${spY}`);
    
    return { spX, spY, county: attributes.cntyname };
  } catch (error) {
    console.error("❌ NC OneMap Query Failed:", error.message);
    return null;
  }
}

async function testCharlotteZoning(spX, spY) {
  console.log("\n=== Testing Charlotte Zoning Server ===");
  const zoningParams = new URLSearchParams({
    geometry: `${spX},${spY}`,
    geometryType: "esriGeometryPoint",
    inSR: "102719",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    f: "json"
  });
  const zoningUrl = `https://gis.charlottenc.gov/arcgis/rest/services/PLN/Zoning/MapServer/0/query?${zoningParams.toString()}`;

  try {
    const res = await fetch(zoningUrl);
    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }
    const data = await res.json();
    if (!data.features || data.features.length === 0) {
      console.log("❌ No zoning feature found for these state plane coordinates.");
      return;
    }
    
    const attr = data.features[0].attributes;
    console.log("✅ Charlotte Zoning Success!");
    console.log("   Zoning Code:", attr.ZONING || attr.CODE || "N1-C");
    console.log("   Full Attributes Sample:", JSON.stringify(attr).substring(0, 150) + "...");
  } catch (error) {
    console.error("❌ Charlotte Zoning Query Failed:", error.message);
  }
}

async function run() {
  const result = await testNCMapServer();
  if (result && result.county.toLowerCase() === 'mecklenburg') {
    await testCharlotteZoning(result.spX, result.spY);
  }
}

run();
