const googleApiKey = "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";
const origin = "35.3321828,-80.7721722"; // Real 9504 Mallard Creek Rd coords

const realComps = [
  { name: "2046 Alexander Village Main Dr", coords: "35.3334416,-80.7554809" },
  { name: "2024 Alexander Village Main Dr", coords: "35.3334721,-80.7548628" },
  { name: "2020 Alexander Village Main Dr", coords: "35.3334742,-80.754791" },
  { name: "2016 Alexander Village Main Dr", coords: "35.3332666,-80.75477839999999" },
  { name: "2052 Alexander Village Main Dr", coords: "35.3331762,-80.7555292" },
  { name: "9524 Mallard Creek Rd", coords: "35.3326142,-80.7726491" },
  { name: "9601 Senator Royall Dr", coords: "35.3371921,-80.7532145" },
  { name: "9712 Claude Freeman Dr", coords: "35.3361824,-80.7588099" }
];

async function checkDistances() {
  const destStr = realComps.map(c => c.coords).join('|');
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
          console.log(`${realComps[idx].name}: ${miles.toFixed(2)} miles, ${mins.toFixed(1)} mins`);
        } else {
          console.log(`${realComps[idx].name}: status ${el.status}`);
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
