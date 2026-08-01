import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.openrouter-test-build');
const srcDir = join(root, 'src', 'services');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const transpile = (f) => ts.transpileModule(readFileSync(f, 'utf8'), { compilerOptions }).outputText;

  writeFileSync(join(outDir, 'deepseekTransport.mjs'), transpile(join(srcDir, 'deepseekTransport.ts')));
  const testOut = join(outDir, 'openRouterFusion.test.mjs');
  writeFileSync(
    testOut,
    transpile(join(srcDir, 'openRouterFusion.test.ts'))
      .replace(/from '\.\/deepseekTransport'/g, "from './deepseekTransport.mjs'"),
  );

  const result = spawnSync(process.execPath, ['--test', testOut], { stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
