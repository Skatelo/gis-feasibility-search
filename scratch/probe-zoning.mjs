// Zoning endpoint probe harness.
// Usage:
//   node scratch/probe-zoning.mjs <arcgisUrl> [<arcgisUrl> ...]
// Accepts a service root (/rest/services), a MapServer/FeatureServer, or a
// specific layer URL. Walks the tree, finds layers that look like zoning,
// and reports the layer URL + best-guess zoning code field + description field.

const TIMEOUT_MS = 15000;

async function getJson(url) {
  const u = url.includes("?") ? `${url}&f=json` : `${url}?f=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { __httpError: res.status };
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return { __parseError: txt.slice(0, 120) }; }
  } catch (e) {
    return { __netError: String(e.code || e.name || e.message) };
  } finally {
    clearTimeout(t);
  }
}

const ZONING_NAME_RE = /zon(e|ing)|\bzip\b|land\s*use|district/i;
const CODE_FIELD_RE = /^(zon(e|ing)?|zone_?class|zoning_?class|class|district|zoning_?code|zone_?code|zoning_?district|zonedist|zone_?abbr|zoning_?abbr)$/i;
const DESC_FIELD_RE = /(desc|description|name|long|full|label|type)/i;

function pickFields(fields) {
  if (!fields) return {};
  const names = fields.map((f) => f.name);
  // code field: prefer exact-ish matches
  let code = names.find((n) => CODE_FIELD_RE.test(n));
  if (!code) code = names.find((n) => /zon/i.test(n) && !DESC_FIELD_RE.test(n));
  if (!code) code = names.find((n) => /class|district/i.test(n));
  // desc field: a zoning-related field that looks like a description
  let desc =
    names.find((n) => /zon|class|district|land/i.test(n) && DESC_FIELD_RE.test(n) && n !== code) ||
    names.find((n) => DESC_FIELD_RE.test(n) && n !== code);
  return { code, desc, all: names };
}

async function probeLayer(layerUrl) {
  const meta = await getJson(layerUrl);
  if (meta.__httpError || meta.__netError || meta.__parseError) return { layerUrl, error: meta };
  const { code, desc, all } = pickFields(meta.fields);
  return {
    layerUrl,
    name: meta.name,
    type: meta.geometryType,
    codeField: code,
    descField: desc,
    fields: all,
  };
}

async function probe(url) {
  console.log(`\n=== ${url} ===`);
  const root = await getJson(url);
  if (root.__httpError) return console.log(`  ✗ HTTP ${root.__httpError}`);
  if (root.__netError) return console.log(`  ✗ NET ${root.__netError}`);
  if (root.__parseError) return console.log(`  ✗ non-JSON: ${root.__parseError}`);

  // Case 1: a layer (has fields directly)
  if (root.fields && root.geometryType) {
    const r = await probeLayer(url);
    console.log(`  LAYER "${r.name}" code=${r.codeField} desc=${r.descField}`);
    console.log(`    fields: ${(r.fields || []).join(", ")}`);
    return;
  }

  // Case 2: a MapServer/FeatureServer (has layers array)
  if (Array.isArray(root.layers)) {
    const candidates = root.layers.filter((l) => ZONING_NAME_RE.test(l.name || ""));
    const toCheck = candidates.length ? candidates : root.layers.slice(0, 12);
    if (!candidates.length) console.log(`  (no obvious zoning layer name; scanning first ${toCheck.length})`);
    for (const l of toCheck) {
      const r = await probeLayer(`${url}/${l.id}`);
      const star = ZONING_NAME_RE.test(l.name || "") ? "★" : " ";
      console.log(`  ${star} [${l.id}] "${l.name}" code=${r.codeField} desc=${r.descField}`);
      if (ZONING_NAME_RE.test(l.name || "")) console.log(`       fields: ${(r.fields || []).join(", ")}`);
    }
    return;
  }

  // Case 3: a service root (has services array)
  if (Array.isArray(root.services)) {
    // Service .name is the full path relative to the SERVER root (".../rest/services"),
    // not relative to the folder URL we requested. Build URLs from the server root.
    const serverRoot = url.replace(/(\/rest\/services)(\/.*)?$/, "$1");
    const svc = root.services.filter((s) => ZONING_NAME_RE.test(s.name || ""));
    console.log(`  service root: ${root.services.length} services; zoning-like: ${svc.map((s) => s.name).join(", ") || "none"}`);
    if (Array.isArray(root.folders) && root.folders.length) {
      const zf = root.folders.filter((f) => ZONING_NAME_RE.test(f));
      console.log(`  folders: ${root.folders.join(", ")}${zf.length ? `  (zoning-like: ${zf.join(", ")})` : ""}`);
    }
    for (const s of svc.slice(0, 6)) {
      await probe(`${serverRoot}/${s.name}/${s.type}`);
    }
    return;
  }

  console.log(`  ? unrecognized JSON shape: keys=${Object.keys(root).join(",")}`);
}

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("Provide at least one ArcGIS URL");
  process.exit(1);
}
for (const u of urls) await probe(u.replace(/\/$/, ""));
