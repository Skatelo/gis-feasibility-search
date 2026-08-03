import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.report-shape-test-build');
const services = join(root, 'src', 'services');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'sc'), { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const transpile = (f) => ts.transpileModule(readFileSync(f, 'utf8'), { compilerOptions }).outputText;

  writeFileSync(join(outDir, 'sc', 'utilityEvidence.mjs'), transpile(join(services, 'sc', 'utilityEvidence.ts')));
  writeFileSync(
    join(outDir, 'propertyReportShape.mjs'),
    transpile(join(services, 'propertyReportShape.ts')).replace(/from '\.\/sc\/utilityEvidence'/g, "from './sc/utilityEvidence.mjs'"),
  );
  const testOut = join(outDir, 'propertyReportShape.test.mjs');
  writeFileSync(
    testOut,
    transpile(join(services, 'propertyReportShape.test.ts'))
      .replace(/from '\.\/propertyReportShape'/g, "from './propertyReportShape.mjs'")
      .replace(/from '\.\/sc\/utilityEvidence'/g, "from './sc/utilityEvidence.mjs'"),
  );

  const result = spawnSync(process.execPath, ['--test', testOut], { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
