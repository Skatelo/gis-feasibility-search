const comps = [
  "227 Howard St, Mount Holly, NC 28120",
  "609 Elm St, Mount Holly, NC 28120",
  "413 W Glendale Ave, Mount Holly, NC 28120",
  "325 Dutchman Ave, Mount Holly, NC 28120",
  "112 N Main St, Mount Holly, NC 28120",
  "804 Old W Charlotte Ave, Mount Holly, NC 28120",
  "105 N Buckoak St, Mount Holly, NC 28120",
  "212 N Lee St, Mount Holly, NC 28120"
];

async function geocode(address) {
  const url = "https://services.nconemap.gov/secure/rest/services/AddressNC/AddressNC_geocoder/GeocodeServer/findAddressCandidates?SingleLine=" + encodeURIComponent(address) + "&outSR=4326&f=json";
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.candidates && data.candidates.length > 0) {
      const loc = data.candidates[0].location;
      return { address, lat: loc.y, lng: loc.x };
    }
  } catch (e) {
    console.error("Failed for", address, e);
  }
  return { address, lat: null, lng: null };
}

async function run() {
  const results = [];
  for (const comp of comps) {
    const res = await geocode(comp);
    results.push(res);
  }
  console.log(JSON.stringify(results, null, 2));
}

run();
