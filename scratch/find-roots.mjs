// Batch service-root discovery.
// Reads candidate host bases from stdin or the CANDIDATES list below,
// tries common ArcGIS instance paths, and for any live root prints the
// zoning-like service names it exposes.

const TIMEOUT_MS = 12000;
const INSTANCES = ["/arcgis/rest/services", "/server/rest/services", "/gis/rest/services", "/rest/services"];
const ZRE = /zon(e|ing)|land\s*use|district|planning/i;

async function getJson(url) {
  const u = `${url}?f=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { __e: `HTTP${res.status}` };
    return JSON.parse(await res.text());
  } catch (e) {
    return { __e: String(e.code || e.name) };
  } finally {
    clearTimeout(t);
  }
}

async function tryHost(label, host) {
  for (const inst of INSTANCES) {
    const root = `${host}${inst}`;
    const j = await getJson(root);
    if (j.__e) continue;
    if (Array.isArray(j.services) || Array.isArray(j.folders)) {
      const svc = (j.services || []).filter((s) => ZRE.test(s.name || "")).map((s) => s.name);
      const fld = (j.folders || []).filter((f) => ZRE.test(f));
      console.log(`✓ ${label}: ${root}`);
      if (svc.length) console.log(`    services: ${[...new Set(svc)].join(", ")}`);
      if (fld.length) console.log(`    folders:  ${fld.join(", ")}`);
      if (!svc.length && !fld.length) console.log(`    (root alive; ${(j.services||[]).length} svcs, ${(j.folders||[]).length} folders — no zoning-like names at top level)`);
      return root;
    }
  }
  return null;
}

const CANDIDATES = process.argv.slice(2).map((a) => {
  const [label, host] = a.split("=");
  return host ? { label, host } : { label: a, host: a };
});

const results = await Promise.all(CANDIDATES.map((c) => tryHost(c.label, c.host).then((r) => ({ ...c, root: r }))));
const misses = results.filter((r) => !r.root).map((r) => r.label);
if (misses.length) console.log(`\n✗ no live root: ${misses.join(", ")}`);
