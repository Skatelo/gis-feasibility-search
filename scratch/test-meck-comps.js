const googleApiKey = "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";

// Let's geocode the subject property address first
async function checkMeckComps() {
  const subjectAddress = "9504 Mallard Creek Rd, Charlotte, NC 28262";
  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(subjectAddress)}&key=${googleApiKey}`;
  
  try {
    const geoRes = await fetch(geocodeUrl);
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      console.log("Could not geocode subject address");
      return;
    }
    const origin = geoData.results[0].geometry.location;
    console.log(`Subject Coordinates: lat=${origin.lat}, lng=${origin.lng}`);

    const comps = [
      { address: "2046 Alexander Village Main Dr, Charlotte, NC 28262", coords: "35.311394,-80.730303" },
      { address: "2024 Alexander Village Main Dr, Charlotte, NC 28262", coords: "35.310619,-80.730303" },
      { address: "2020 Alexander Village Main Dr, Charlotte, NC 28262", coords: "35.310464,-80.730303" },
      { address: "2016 Alexander Village Main Dr, Charlotte, NC 28262", coords: "35.310214,-80.730303" },
      { address: "2052 Alexander Village Main Dr, Charlotte, NC 28262", coords: "35.312014,-80.730303" },
      { address: "9524 Mallard Creek Rd, Charlotte, NC 28262", coords: "35.313412,-80.728905" },
      { address: "9601 Senator Royall Dr, Charlotte, NC 28262", coords: "35.316812,-80.732915" },
      { address: "9712 Claude Freeman Dr, Charlotte, NC 28262", coords: "35.318912,-80.735115" }
    ];

    const destStr = comps.map(c => c.coords).join('|');
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destStr}&key=${googleApiKey}`;
    
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "OK" && data.rows && data.rows[0]) {
      const elements = data.rows[0].elements;
      elements.forEach((el, idx) => {
        if (el.status === "OK") {
          const miles = el.distance.value * 0.000621371;
          const mins = el.duration.value / 60;
          console.log(`${comps[idx].address}: ${miles.toFixed(2)} miles, ${mins.toFixed(1)} mins`);
        } else {
          console.log(`${comps[idx].address}: status ${el.status}`);
        }
      });
    } else {
      console.log("Error response:", data);
    }
  } catch (e) {
    console.error(e);
  }
}

checkMeckComps();
