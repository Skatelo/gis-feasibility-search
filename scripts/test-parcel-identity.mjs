import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.parcel-identity-test-build');
const output = join(outDir, 'parcel-identity.test.mjs');
const testFile = join(root, 'src', 'services', 'parcels', 'parcel-identity.test.ts');
const moduleFile = join(root, 'src', 'services', 'parcels', 'parcel-identity.ts');
const moduleOutput = join(outDir, 'parcel-identity.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const compiledModule = ts.transpileModule(readFileSync(moduleFile, 'utf8'), { compilerOptions }).outputText;
  const compiledTest = ts.transpileModule(readFileSync(testFile, 'utf8'), { compilerOptions }).outputText
    .replace("from './parcel-identity'", "from './parcel-identity.mjs'");
  writeFileSync(moduleOutput, compiledModule);
  writeFileSync(output, compiledTest);

  const result = spawnSync(process.execPath, ['--test', output], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
