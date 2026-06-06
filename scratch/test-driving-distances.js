const googleApiKey = "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";
const origin = "35.331597,-80.9993925"; // Real 529 Flat Rock Cemetery Rd coords

const newComps = [
  { name: "1645 Windermere Rd", coords: "35.331838,-81.011616" },
  { name: "1618 Gander Way", coords: "35.343286,-81.025075" },
  { name: "1624 Gander Way", coords: "35.342946,-81.024845" },
  { name: "358 Crandon Rd", coords: "35.316091,-81.004405" },
  { name: "177 Sculpin Ln", coords: "35.314243,-81.003140" },
  { name: "105 Bristleback Ct", coords: "35.314608,-81.006584" },
  { name: "133 Bristleback Ct", coords: "35.316306,-81.006351" },
  { name: "5229 Piedmont Run Rd", coords: "35.320577,-81.033518" },
  { name: "5414 Cotton Mill Ct", coords: "35.321076,-81.036276" },
  { name: "5016 Mooreland Oaks Way", coords: "35.317282,-81.031543" }
];

async function checkDistances() {
  const destStr = newComps.map(c => c.coords).join('|');
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destStr}&key=${googleApiKey}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "OK" && data.rows && data.rows[0]) {
      const elements = data.rows[0].elements;
      elements.forEach((el, idx) => {
        if (el.status === "OK") {
          const miles = el.distance.value * 0.000621371;
          const mins = el.duration.value / 60;
          console.log(`${newComps[idx].name}: ${miles.toFixed(2)} miles, ${mins.toFixed(1)} mins`);
        } else {
          console.log(`${newComps[idx].name}: status ${el.status}`);
        }
      });
    } else {
      console.log("Error response:", data);
    }
  } catch (e) {
    console.error(e);
  }
}

checkDistances();
