const googleApiKey = "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";

const comps = [
  "2046 Alexander Village Main Dr, Charlotte, NC 28262",
  "2024 Alexander Village Main Dr, Charlotte, NC 28262",
  "2020 Alexander Village Main Dr, Charlotte, NC 28262",
  "2016 Alexander Village Main Dr, Charlotte, NC 28262",
  "2052 Alexander Village Main Dr, Charlotte, NC 28262",
  "9524 Mallard Creek Rd, Charlotte, NC 28262",
  "9601 Senator Royall Dr, Charlotte, NC 28262",
  "9712 Claude Freeman Dr, Charlotte, NC 28262"
];

async function geocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleApiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.results && data.results[0]) {
      const loc = data.results[0].geometry.location;
      return { address, lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    console.error(e);
  }
  return { address, lat: null, lng: null };
}

async function run() {
  const results = [];
  for (const c of comps) {
    const res = await geocode(c);
    results.push(res);
  }
  console.log(JSON.stringify(results, null, 2));
}

run();
