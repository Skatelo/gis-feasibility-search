import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.zoning-evidence-test-build');
const srcDir = join(root, 'src', 'data');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const transpile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions }).outputText;

  writeFileSync(join(outDir, 'zoningEvidence.mjs'), transpile(join(srcDir, 'zoningEvidence.ts')));
  const testOut = join(outDir, 'zoningEvidence.test.mjs');
  writeFileSync(
    testOut,
    transpile(join(srcDir, 'zoningEvidence.test.ts')).replace(/from '\.\/zoningEvidence'/g, "from './zoningEvidence.mjs'"),
  );

  const result = spawnSync(process.execPath, ['--test', testOut], { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
