// Live verification of the seeded NC/SC zoning registry.
//
// For every seeded jurisdiction it runs the same deterministic ArcGIS point/
// sample query the engine uses, and confirms the configured zoning LAYER is
// live + queryable and the mapped CODE FIELD actually returns real district
// codes. This turns "we seeded N jurisdictions" into an honest coverage report:
// which return codes, and which are broken and need fixing.
//
//   node scripts/verify-zoning-registry.mjs            # all seeded records
//   node scripts/verify-zoning-registry.mjs --state SC # filter by state
//   node scripts/verify-zoning-registry.mjs --broken   # only show failures

import { build } from 'esbuild';
import { rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const stateFilter = (argv[argv.indexOf('--state') + 1] || '').toUpperCase();
const onlyBroken = argv.includes('--broken');

// Bundle just the seed export so we read the exact records the engine ships.
const outDir = mkdtempSync(join(tmpdir(), 'zoning-verify-'));
const entry = join(outDir, 'entry.mjs');
await build({
  stdin: {
    contents: `export { INITIAL_NC_SC_SOURCE_RECORDS } from ${JSON.stringify(join(root, 'src/services/zoning/registry/initial-source-records.ts'))};`,
    resolveDir: root,
    loader: 'ts',
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'error',
  external: ['node:*'],
});
const { INITIAL_NC_SC_SOURCE_RECORDS } = await import(pathToFileURL(entry).href);
rmSync(outDir, { recursive: true, force: true });

const PLACEHOLDER = /^(city|county|etj|none|n\/?a|null|muni|municipal|unknown|unzoned|split|tbd)$/i;
const cleanCode = (v) => {
  const s = String(v ?? '').trim();
  return s && s.length <= 40 && /[a-z0-9]/i.test(s) && !PLACEHOLDER.test(s) ? s : null;
};

async function sampleLayer(layer) {
  const codeField = layer.fieldMapping?.zoningCodeField;
  if (!codeField) return { ok: false, reason: 'no code field configured' };
  const url = new URL(`${layer.layerUrl.replace(/\/$/, '')}/query`);
  url.search = new URLSearchParams({
    where: `${codeField} IS NOT NULL`,
    outFields: codeField,
    returnGeometry: 'false',
    resultRecordCount: '5',
    f: 'json',
  }).toString();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    if (data?.error) return { ok: false, reason: `ArcGIS: ${data.error.message}` };
    const feats = data?.features ?? [];
    if (feats.length === 0) return { ok: false, reason: 'query returned 0 features' };
    const codes = feats.map((f) => cleanCode(f.attributes?.[codeField])).filter(Boolean);
    if (codes.length === 0) return { ok: false, reason: `code field "${codeField}" empty in samples` };
    return { ok: true, sample: [...new Set(codes)].slice(0, 3).join(', ') };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}

const records = INITIAL_NC_SC_SOURCE_RECORDS.filter(
  (r) => (!stateFilter || r.stateCode === stateFilter) && r.zoningLayers.length > 0,
);

let pass = 0;
let fail = 0;
const failures = [];
console.log(`\nVerifying ${records.length} seeded NC/SC zoning records...\n`);

for (const r of records) {
  const name = r.municipalityName ? `${r.municipalityName}, ${r.stateCode}` : `${r.countyName}, ${r.stateCode}`;
  const results = await Promise.all(r.zoningLayers.filter((l) => l.role !== 'overlay').map(sampleLayer));
  const good = results.find((x) => x.ok);
  if (good) {
    pass += 1;
    if (!onlyBroken) console.log(`  PASS  ${name.padEnd(28)} ${good.sample}`);
  } else {
    fail += 1;
    const reason = results.map((x) => x.reason).join(' | ');
    failures.push({ name, reason, layer: r.zoningLayers[0]?.layerUrl });
    console.log(`  FAIL  ${name.padEnd(28)} ${reason}`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Coverage: ${pass}/${records.length} jurisdictions return live zoning codes`);
if (failures.length) {
  console.log(`\nBroken records to fix:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.reason}\n    ${f.layer}`);
}
process.exit(fail > 0 ? 1 : 0);
