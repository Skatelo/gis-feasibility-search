const queryParams = new URLSearchParams({
  geometry: "-80.9993925,35.331597",
  geometryType: "esriGeometryPoint",
  inSR: "4326",
  spatialRel: "esriSpatialRelIntersects",
  distance: "3",
  units: "esriSRUnit_StatuteMile",
  where: "cntyname = 'Gaston' AND structyear >= 2018 AND siteadd IS NOT NULL AND siteadd <> ''",
  outFields: "siteadd,parval,saledate,structyear,ownname,parno",
  returnGeometry: "true",
  outSR: "4326",
  f: "json",
  resultRecordCount: "20"
});

const url = `https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${queryParams.toString()}`;

fetch(url)
  .then(res => res.json())
  .then(data => {
    if (data.features) {
      console.log(`Found ${data.features.length} features within 3 miles:`);
      data.features.forEach((f, idx) => {
        const attr = f.attributes;
        let coords = null;
        if (f.geometry && f.geometry.rings && f.geometry.rings[0]) {
          const ring = f.geometry.rings[0];
          let sumLng = 0, sumLat = 0;
          ring.forEach(pt => { sumLng += pt[0]; sumLat += pt[1]; });
          coords = { lat: sumLat / ring.length, lng: sumLng / ring.length };
        }
        console.log(`${idx + 1}. Address: ${attr.siteadd}, Year: ${attr.structyear}, Value: ${attr.parval}, Coords: ${coords ? coords.lat + ',' + coords.lng : 'N/A'}`);
      });
    } else {
      console.log("No features found or error:", data);
    }
  })
  .catch(err => console.error(err));
