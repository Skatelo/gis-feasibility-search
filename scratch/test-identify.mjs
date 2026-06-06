// Validate the identify + extraction pipeline against real points per county.
const CASES = [
  ["Mecklenburg", "https://meckgis.mecklenburgcountync.gov/server/rest/services/CityofCharlotteZoning/MapServer", null, -80.8431, 35.2271],
  ["Wake", "https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer", null, -78.6382, 35.7796],
  ["Guilford", "https://gcgis.guilfordcountync.gov/arcgis/rest/services/Planning_Zoning/Combined_Zoning/MapServer", null, -79.7920, 36.0726],
  ["Forsyth", "https://maps.co.forsyth.nc.us/arcgis/rest/services/Planning_Inspection/Planning_Inspection/MapServer", "1", -80.2442, 36.0999],
  ["Cumberland", "https://gis.co.cumberland.nc.us/server/rest/services/Planning/CCZoning/MapServer", null, -78.8784, 35.0527],
  ["Orange", "https://gis.orangecountync.gov/arcgis/rest/services/WebZoningService/MapServer", "22", -79.0997, 36.0757],
  ["New Hanover", "https://gis.nhcgov.com/server/rest/services/Layers/Zoning/MapServer", null, -77.9447, 34.2257],
  ["Gaston", "https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer", null, -81.1873, 35.2621],
  ["Cabarrus", "https://location.cabarruscounty.us/arcgisservices/rest/services/Zoning/MapServer", null, -80.5800, 35.4088],
  ["Brunswick", "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/Zoning/MapServer", null, -78.1486, 34.0688],
  ["Iredell", "https://maps.iredellcountync.gov/server/rest/services/Data/Zoning/MapServer", null, -80.8873, 35.7826],
  ["Rowan", "https://gis.rowancountync.gov/arcgis/rest/services/Public/Alll_Zoning/MapServer", null, -80.4742, 35.6706],
  ["Anson", "https://ansoncountygis.com/arcgis/rest/services/ZoningLayers/MapServer", null, -80.0767, 34.9682],
  ["Lincoln", "https://arcgisserver.lincolncountync.gov/arcgis/rest/services/LandReport/MapServer", "0", -81.2545, 35.4737],
  ["Onslow", "https://gismaps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Planning_Data/MapServer", "0", -77.4302, 34.7541],
  ["Union", "https://gis.unioncountync.gov/server/rest/services/Zoning_Map_MIL1/MapServer", "6", -80.5495, 34.9854],
];

function extract(results) {
  const clean = (v) => { if (v == null) return null; const s = String(v).trim(); if (!s || s.toLowerCase() === "null") return null; if (/^\d+$/.test(s)) return null; return s; };
  const isZoningKey = (k) => /zon|district|^class$|classif/i.test(k);
  const isExcludedKey = (k) => /jur|muni|city|county|town|name|label|date|case|admin|petition|overlay|owner|acre|hyperlink|website|url|globalid|objectid|shape|_id$|id$|fid|height|frontage/i.test(k);
  const isCodeShape = (s) => s.length <= 16 && /[A-Za-z]/.test(s);
  const isPlaceholder = (code, desc) => /^(city|county|etj|unzoned|none|n\/a)$/i.test(code) || /\b(city|town|county|limits)\b/i.test(code) || (!!desc && /\b(town|city)\s+limits\b/i.test(desc));
  const candidates = [];
  for (const r of results) {
    const attrs = r.attributes || {};
    const zoningVals = Object.keys(attrs).filter((k) => isZoningKey(k) && !isExcludedKey(k)).map((k) => clean(attrs[k])).filter(Boolean);
    if (!zoningVals.length) continue;
    const codes = zoningVals.filter(isCodeShape).sort((a, b) => a.length - b.length);
    const code = codes[0] || zoningVals.sort((a, b) => a.length - b.length)[0];
    const description = zoningVals.filter((v) => v !== code && /\s/.test(v) && v.length > code.length).sort((a, b) => b.length - a.length)[0] || null;
    const areaKey = Object.keys(attrs).find((k) => /st_?area|area$/i.test(k));
    const area = areaKey ? parseFloat(String(attrs[areaKey])) || Infinity : Infinity;
    if (code) candidates.push({ code, description, area, placeholder: isPlaceholder(code, description), layerName: r.layerName });
  }
  const real = candidates.filter((c) => !c.placeholder);
  if (!real.length) return null;
  real.sort((a, b) => a.area - b.area);
  return real[0];
}

for (const [name, url, layerRestrict, lng, lat] of CASES) {
  const d = 0.0015;
  const p = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", sr: "4326", tolerance: "3",
    mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`, imageDisplay: "400,400,96",
    layers: layerRestrict ? `all:${layerRestrict}` : "all", returnGeometry: "false", f: "json",
  });
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${url}/identify?${p}`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    const out = extract(j.results || []);
    console.log(`${name.padEnd(13)} ${out ? `code="${out.code}" desc="${out.description || ""}" [${out.layerName}]` : `(no zoning hit; ${(j.results||[]).length} results)`}`);
  } catch (e) {
    console.log(`${name.padEnd(13)} ERROR ${e.code || e.message}`);
  }
}
