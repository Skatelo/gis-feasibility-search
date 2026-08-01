import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.reapi-zoning-test-build');
const srcDir = join(root, 'src', 'services');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const transpile = (f) => ts.transpileModule(readFileSync(f, 'utf8'), { compilerOptions }).outputText;

  writeFileSync(join(outDir, 'realEstateApiProperty.mjs'), transpile(join(srcDir, 'realEstateApiProperty.ts')));
  const testOut = join(outDir, 'realEstateZoning.test.mjs');
  writeFileSync(
    testOut,
    transpile(join(srcDir, 'realEstateZoning.test.ts'))
      .replace(/from '\.\/realEstateApiProperty'/g, "from './realEstateApiProperty.mjs'"),
  );

  const result = spawnSync(process.execPath, ['--test', testOut], { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
