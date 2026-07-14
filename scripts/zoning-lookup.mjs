// CLI for the universal zoning engine — a runnable reference + demo.
//
//   node scripts/zoning-lookup.mjs "634 Kentbrook Dr, Charlotte, NC 28213"
//   node scripts/zoning-lookup.mjs "227 Fayetteville St, Raleigh NC" \
//        --service https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer
//   node scripts/zoning-lookup.mjs "..." --mode verified --json
//
// Discovery of a brand-new jurisdiction needs PERPLEXITY_API_KEY (or
// VITE_PERPLEXITY_API_KEY). Pass --service <arcgisUrl> to skip discovery and
// point the engine straight at a known official service (exercises the full
// geocode -> jurisdiction -> query -> normalize -> confidence pipeline live).

import { build } from 'esbuild';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvLocal() {
  const file = join(root, '.env.local');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseArgs(argv) {
  const args = { address: '', mode: 'verified', json: false, service: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--service') args.service = argv[++i];
    else if (!args.address) args.address = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.address) {
  console.error('Usage: node scripts/zoning-lookup.mjs "<address>" [--service <arcgisUrl>] [--mode fast|verified|deep] [--json]');
  process.exit(1);
}

const env = { ...loadEnvLocal(), ...process.env };
const googleMapsApiKey = env.GOOGLE_MAPS_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY || '';
const perplexityApiKey = env.PERPLEXITY_API_KEY || env.VITE_PERPLEXITY_API_KEY || '';

// Bundle the TS engine to an importable ESM module.
const outDir = mkdtempSync(join(tmpdir(), 'zoning-cli-'));
const outFile = join(outDir, 'engine.mjs');
await build({
  entryPoints: [join(root, 'src/services/zoning/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'error',
  external: ['node:*'],
});

const engineModule = await import(pathToFileURL(outFile).href);
const { createZoningEngine } = engineModule;

const config = { googleMapsApiKey, perplexityApiKey };
if (args.service) {
  // Deterministic "search" pointing straight at a known service (skips Perplexity).
  config.searchProvider = async () => [{ url: args.service }];
}

const engine = createZoningEngine(config);
const started = Date.now();
const result = await engine.lookup({ address: args.address, mode: args.mode });
const elapsed = Date.now() - started;

rmSync(outDir, { recursive: true, force: true });

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const z = result.zoning;
  const c = result.confidence;
  console.log('');
  console.log(`Address     : ${result.address?.formattedAddress ?? args.address}`);
  console.log(`Coordinates : ${result.address ? `${result.address.latitude}, ${result.address.longitude}` : 'n/a'}`);
  console.log(`Jurisdiction: ${result.jurisdiction.zoningAuthority ?? 'unknown'} (${result.jurisdiction.jurisdictionType}, confidence ${result.jurisdiction.confidence})`);
  console.log(`Zoning      : ${z.found ? z.code : 'not resolved'}${z.description ? ` — ${z.description}` : ''}`);
  if (z.splitZoned) console.log(`Split-zoned : yes (+${z.additionalDistricts.map((d) => d.code).join(', ')})`);
  if (result.overlays.length) console.log(`Overlays    : ${result.overlays.map((o) => o.code ?? o.layerName).join(', ')}`);
  console.log(`Source      : ${result.source?.serviceUrl ?? 'none'}${result.source?.official ? ' (official)' : ''}`);
  console.log(`Status      : ${result.status}  ·  confidence ${c.overall}/100  ·  ${elapsed} ms`);
  if (c.warnings.length) console.log(`Warnings    : ${c.warnings.join('; ')}`);
  if (result.errors.length) console.log(`Errors      : ${result.errors.map((e) => `${e.stage}: ${e.message}`).join('; ')}`);
  console.log('');
}
process.exit(0);
