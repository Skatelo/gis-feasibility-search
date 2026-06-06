const queryParams = new URLSearchParams({
  where: "cntyname = 'Gaston' AND parno = '4508-31-6577'",
  outFields: "*",
  returnGeometry: "true",
  outSR: "2264", // State Plane
  f: "json"
});

const url = `https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${queryParams.toString()}`;

fetch(url)
  .then(res => res.json())
  .then(data => {
    if (data.features && data.features.length > 0) {
      const feat = data.features[0];
      console.log("Attributes:", JSON.stringify(feat.attributes, null, 2));
      console.log("Geometry Rings (State Plane):", JSON.stringify(feat.geometry.rings));
    } else {
      console.log("None found:", data);
    }
  })
  .catch(err => console.error(err));
