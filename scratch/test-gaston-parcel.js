const queryParams = new URLSearchParams({
  where: "cntyname = 'Gaston' AND siteadd LIKE '%FLAT ROCK CEMETERY%'",
  outFields: "*",
  returnGeometry: "true",
  outSR: "4326",
  f: "json"
});

const url = `https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${queryParams.toString()}`;

fetch(url)
  .then(res => res.json())
  .then(data => {
    if (data.features) {
      console.log("Found", data.features.length, "features");
      data.features.forEach(f => {
        console.log(f.attributes.parno, f.attributes.siteadd, f.attributes.gisacres, f.attributes.ownname);
        if (f.geometry && f.geometry.rings) {
          console.log("Rings:", f.geometry.rings[0].slice(0, 3));
        }
      });
    } else {
      console.log("None found:", data);
    }
  })
  .catch(err => console.error(err));
