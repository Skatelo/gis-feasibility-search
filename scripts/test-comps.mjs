import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.comps-test-build');
const output = join(outDir, 'comp-types.test.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  await build({
    absWorkingDir: root,
    entryPoints: ['./src/services/comps/comp-types.test.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    external: ['node:*'],
    logLevel: 'warning',
  });

  const result = spawnSync(process.execPath, ['--test', output], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
