import { rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = process.cwd();
const outdir = resolve(root, '.zoning-server-test-build');
const testDir = resolve(root, 'server/zoning');
const testFiles = readdirSync(testDir).filter((name) => name.endsWith('.test.ts')).map((name) => resolve(testDir, name));

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: testFiles.map((file) => `./${relative(root, file).replaceAll('\\', '/')}`),
  absWorkingDir: root,
  outdir,
  outbase: 'server/zoning',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'info',
});

const result = spawnSync(process.execPath, ['--test', ...testFiles.map((file) => resolve(outdir, `${basename(file, '.ts')}.js`))], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

await rm(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
