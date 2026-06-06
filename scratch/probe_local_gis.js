const WAKE_URL = 'https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0/query';
const GASTON_URL = 'https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query';
const MECK_URL = 'https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcelBoundaries/MapServer/0/query';

async function probeService(name, url) {
  console.log(`\n=== Probing ${name} GIS MapServer ===`);
  const queryUrl = `${url}?where=1%3D1&outFields=*&resultRecordCount=1&returnGeometry=true&f=json`;
  try {
    const res = await fetch(queryUrl);
    if (!res.ok) {
      console.log(`❌ ${name} failed with status: ${res.status}`);
      return;
    }
    const data = await res.json();
    if (data.error) {
      console.log(`❌ ${name} returned error:`, data.error);
      return;
    }
    if (!data.features || data.features.length === 0) {
      console.log(`❌ ${name} returned no features.`);
      return;
    }
    const feature = data.features[0];
    console.log(`✅ ${name} query succeeded!`);
    console.log(`   Attributes:`, JSON.stringify(feature.attributes, null, 2));
    console.log(`   Geometry type:`, data.geometryType);
    console.log(`   Has rings:`, !!(feature.geometry && feature.geometry.rings));
  } catch (e) {
    console.error(`❌ Error probing ${name}:`, e.message);
  }
}

async function run() {
  await probeService('Wake County', WAKE_URL);
  await probeService('Gaston County', GASTON_URL);
  await probeService('Mecklenburg County', MECK_URL);
}

run();
