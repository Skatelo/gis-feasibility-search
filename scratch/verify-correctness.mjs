// Correctness audit: for each verified county, run identify at a known point,
// print the RAW zoning-relevant attributes (so we can see the true zoning field)
// next to what our extractor picks. Extraction logic mirrors ncZoning.ts exactly.

// county -> { services:[{url,layers}], points:[[label,lng,lat],...] }
const COUNTIES = {
  Mecklenburg: { services: [
      { url: "https://meckgis.mecklenburgcountync.gov/server/rest/services/CityofCharlotteZoning/MapServer", layers: null },
      { url: "https://meckgis.mecklenburgcountync.gov/server/rest/services/UnincorporatedCountyandTownsZoning/MapServer", layers: null },
    ], points: [["Charlotte res", -80.8101, 35.0527], ["Matthews", -80.7234, 35.1168]] },
  Wake: { services: [{ url: "https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer", layers: null }],
    points: [["Raleigh downtown", -78.6382, 35.7796], ["Cary", -78.7747, 35.7882]] },
  Guilford: { services: [{ url: "https://gcgis.guilfordcountync.gov/arcgis/rest/services/Planning_Zoning/Combined_Zoning/MapServer", layers: null }],
    points: [["Greensboro", -79.7920, 36.0726]] },
  Forsyth: { services: [{ url: "https://maps.co.forsyth.nc.us/arcgis/rest/services/Planning_Inspection/Planning_Inspection/MapServer", layers: "show:1" }],
    points: [["Winston-Salem", -80.2442, 36.0999]] },
  Cumberland: { services: [{ url: "https://gis.co.cumberland.nc.us/server/rest/services/Planning/CCZoning/MapServer", layers: null }],
    points: [["Fayetteville", -78.8784, 35.0527], ["downtown Fay", -78.8990, 35.0546]] },
  Orange: { services: [{ url: "https://gis.orangecountync.gov/arcgis/rest/services/WebZoningService/MapServer", layers: "show:22" }],
    points: [["rural Orange", -79.1700, 36.0400], ["Chapel Hill", -79.0558, 35.9132]] },
  "New Hanover": { services: [{ url: "https://gis.nhcgov.com/server/rest/services/Layers/Zoning/MapServer", layers: null }],
    points: [["unincorp NHC", -77.8870, 34.2680], ["Wilmington", -77.9447, 34.2257]] },
  Gaston: { services: [{ url: "https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer", layers: null }],
    points: [["Gastonia", -81.1873, 35.2621]] },
  Cabarrus: { services: [{ url: "https://location.cabarruscounty.us/arcgisservices/rest/services/Zoning/MapServer", layers: null }],
    points: [["Concord", -80.5800, 35.4088]] },
  Brunswick: { services: [{ url: "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/Zoning/MapServer", layers: null }],
    points: [["NE Brunswick", -78.0522, 34.2598], ["Shallotte area", -78.4295, 33.9879]] },
  Iredell: { services: [{ url: "https://maps.iredellcountync.gov/server/rest/services/Data/Zoning/MapServer", layers: null }],
    points: [["Statesville", -80.8873, 35.7826], ["rural Iredell", -80.9500, 35.7000]] },
  Rowan: { services: [{ url: "https://gis.rowancountync.gov/arcgis/rest/services/Public/Alll_Zoning/MapServer", layers: null }],
    points: [["Salisbury", -80.4742, 35.6706]] },
  Anson: { services: [{ url: "https://ansoncountygis.com/arcgis/rest/services/ZoningLayers/MapServer", layers: null }],
    points: [["Wadesboro", -80.0767, 34.9682]] },
  Lincoln: { services: [{ url: "https://arcgisserver.lincolncountync.gov/arcgis/rest/services/LandReport/MapServer", layers: "show:0" }],
    points: [["Lincolnton", -81.2545, 35.4737]] },
  Onslow: { services: [{ url: "https://gismaps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Planning_Data/MapServer", layers: "show:0" }],
    points: [["Jacksonville", -77.4302, 34.7541]] },
  Union: { services: [{ url: "https://gis.unioncountync.gov/server/rest/services/Zoning_Map_MIL1/MapServer", layers: "show:6" }],
    points: [["Monroe", -80.5495, 34.9854], ["rural Union", -80.6300, 35.0500]] },
};

// ---- extraction mirrored from ncZoning.ts ----
const clean = (v) => { if (v == null) return null; const s = String(v).trim(); if (!s || s.toLowerCase() === "null") return null; if (/^\d+$/.test(s)) return null; return s; };
const isZoningKey = (k) => /zon|^zn|zcode|zclass|zdist|district|^class$|classif/i.test(k);
const isExcludedKey = (k) => /jur|muni|city|county|town|name|label|date|case|admin|petition|overlay|owner|acre|hyperlink|website|url|globalid|objectid|shape|_id$|id$|fid|height|frontage/i.test(k);
const isDescKey = (k) => /desc|def|decode|classif/i.test(k);
const isCodeShape = (s) => s.length <= 16 && /[A-Za-z]/.test(s);
const isPlaceholder = (code, desc) => /^(city|county|etj|unzoned|none|n\/a|mun\.?|municipal|municipality)$/i.test(code) || /\b(city|town|county|limits|municipal)\b/i.test(code) || (!!desc && /\b(town|city)\s+limits\b/i.test(desc));

function extract(results) {
  const candidates = [];
  for (const r of results) {
    const attrs = r.attributes || {};
    const keys = Object.keys(attrs);
    const zoningVals = keys.filter((k) => isZoningKey(k) && !isExcludedKey(k)).map((k) => clean(attrs[k])).filter(Boolean);
    if (!zoningVals.length) continue;
    let codeCands = zoningVals.filter(isCodeShape);
    const complete = codeCands.filter((s) => !/[-_/]$/.test(s));
    if (complete.length) codeCands = complete;
    const code = codeCands.sort((a, b) => a.length - b.length)[0] || zoningVals.slice().sort((a, b) => a.length - b.length)[0];
    const descVals = [...zoningVals, ...keys.filter((k) => isDescKey(k) && !isExcludedKey(k)).map((k) => clean(attrs[k])).filter(Boolean)];
    const description = descVals.filter((v) => v !== code && /\s/.test(v) && v.length > code.length).sort((a, b) => b.length - a.length)[0] || null;
    const areaKey = keys.find((k) => /st_?area|area$/i.test(k));
    const area = areaKey ? parseFloat(String(attrs[areaKey])) || Infinity : Infinity;
    candidates.push({ code, description, area, placeholder: isPlaceholder(code, description), layerName: r.layerName });
  }
  const real = candidates.filter((c) => !c.placeholder);
  if (!real.length) return null;
  real.sort((a, b) => a.area - b.area);
  return real[0];
}

async function identify(service, lng, lat) {
  const d = 0.0015;
  const p = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", sr: "4326", tolerance: "3",
    mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`, imageDisplay: "400,400,96",
    layers: service.layers ? `all:${service.layers.replace(/^show:/, "")}` : "all", returnGeometry: "false", f: "json",
  });
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${service.url}/identify?${p}`, { signal: ctrl.signal });
    const j = await res.json();
    return j.results || [];
  } catch (e) { return { __err: String(e.code || e.message) }; }
  finally { clearTimeout(t); }
}

// Show raw zoning-ish attributes from the first result, so we can see the true field.
function rawZoning(results) {
  if (!results.length) return "(no polygon at point)";
  const a = results[0].attributes || {};
  const keep = Object.keys(a).filter((k) => isZoningKey(k) || /jur|muni|district|class|type|desc|def/i.test(k));
  return `[${results[0].layerName}] ` + keep.map((k) => `${k}=${JSON.stringify(a[k])}`).join("  ");
}

for (const [county, cfg] of Object.entries(COUNTIES)) {
  console.log(`\n##### ${county}`);
  for (const [label, lng, lat] of cfg.points) {
    // mirror fetchCountyZoningCode: try services in order
    let picked = null, rawShown = null;
    for (const svc of cfg.services) {
      const results = await identify(svc, lng, lat);
      if (results.__err) { console.log(`  ${label}: ERROR ${results.__err}`); rawShown = "err"; break; }
      if (!rawShown && results.length) rawShown = rawZoning(results);
      const hit = extract(results);
      if (hit) { picked = hit; if (results.length) rawShown = rawZoning(results); break; }
    }
    console.log(`  ${label}:`);
    console.log(`     EXTRACTED -> ${picked ? `code="${picked.code}" desc="${picked.description || ""}"` : "(none -> Gridics fallback)"}`);
    console.log(`     RAW       -> ${rawShown || "(no data)"}`);
  }
}
