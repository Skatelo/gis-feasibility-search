// Test harness for the TypeScript universal zoning engine.
//
// The engine is strict TS with extensionless imports (bundler resolution), so it
// can't run under `node --test` directly. This bundles every
// `src/services/zoning/**/*.test.ts` to ESM with esbuild, then runs node's test
// runner over the bundles. Live network tests are gated by env vars so the
// default run stays offline-safe.
//
// Usage:
//   node scripts/test-zoning-engine.mjs            # unit tests only
//   ZONING_LIVE=1 node scripts/test-zoning-engine.mjs   # + live network tests

import { build } from 'esbuild';
import { readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src/services/zoning');
const outDir = join(root, '.zoning-test-build');

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const tests = findTests(srcDir);
if (tests.length === 0) {
  console.log('No zoning-engine test files found.');
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Output names keep a `.test` stem so node's test runner discovers them.
const entryPoints = {};
const outFiles = [];
for (const t of tests) {
  const name = relative(srcDir, t).replace(/[\\/]/g, '__').replace(/\.test\.ts$/, '.test');
  entryPoints[name] = t;
  outFiles.push(join(outDir, `${name}.mjs`));
}

try {
  await build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    outExtension: { '.js': '.mjs' },
    logLevel: 'info',
    external: ['node:*'],
  });
} catch (err) {
  console.error('esbuild bundling failed:', err);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...outFiles], {
  stdio: 'inherit',
  env: process.env,
});

rmSync(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
