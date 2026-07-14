import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = process.cwd();
const outdir = resolve(root, '.zoning-server-test-build');
const outfile = resolve(outdir, 'api.test.mjs');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: [resolve(root, 'server/zoning/api.test.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'info',
});

const result = spawnSync(process.execPath, ['--test', outfile], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

await rm(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
