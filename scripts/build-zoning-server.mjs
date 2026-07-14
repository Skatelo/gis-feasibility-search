import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const outdir = resolve(root, 'dist-server');

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: {
    main: resolve(root, 'server/zoning/main.ts'),
    worker: resolve(root, 'server/zoning/worker.ts'),
    import: resolve(root, 'server/zoning/import.ts'),
    probe: resolve(root, 'server/zoning/live-probe.ts'),
    coverage: resolve(root, 'server/zoning/coverage-report.ts'),
  },
  absWorkingDir: root,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
