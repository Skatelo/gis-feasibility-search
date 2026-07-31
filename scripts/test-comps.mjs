import ts from 'typescript';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.comps-test-build');
const srcDir = join(root, 'src', 'services', 'comps');

// Each entry is a self-contained module under src/services/comps plus its test.
// Type-only imports (e.g. CompProperty) are erased by transpileModule, so these
// compile standalone without pulling in the wider app.
const MODULES = ['comp-types', 'land-bands'];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const transpile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions }).outputText;

  const testOutputs = [];
  for (const name of MODULES) {
    writeFileSync(join(outDir, `${name}.mjs`), transpile(join(srcDir, `${name}.ts`)));
    const testOut = join(outDir, `${name}.test.mjs`);
    writeFileSync(
      testOut,
      transpile(join(srcDir, `${name}.test.ts`)).replace(
        new RegExp(`from '\\./${name}'`, 'g'),
        `from './${name}.mjs'`,
      ),
    );
    testOutputs.push(testOut);
  }

  const result = spawnSync(process.execPath, ['--test', ...testOutputs], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
