import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);

/**
 * Build one function bundle the way the Netlify deploy does (esbuild, same
 * externals as netlify.toml) and require it through a COMMONJS wrapper —
 * exactly how Lambda loads it. If the bundle loses its named exports when
 * loaded through require() (observed with a dynamic-import refactor), the
 * wrapper exposes {} and every invocation dies before the handler runs —
 * jobs stay 'queued' forever. This test pins the Lambda load path.
 */
function buildAndRequire(name, entry) {
  const outDir = path.join(root, `scratch/.bundle-test-${name}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // Lambda's deployed zip carries NO package.json, so a plain .js bundle is
  // loaded as CommonJS regardless of the repo root's "type": "module". Pin
  // that exact resolution context here so this test mirrors Lambda.
  fs.writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}');

  execSync(
    `npx esbuild "${entry}" --bundle --platform=node --format=cjs --outfile="${path.join(outDir, 'fn.js')}"`
    + ' --external:@crawlee/cheerio --external:@crawlee/playwright --external:@sparticuz/chromium'
    + ' --external:playwright-core --external:mammoth --external:pdf-parse --external:read-excel-file --external:saxen',
    { cwd: root, stdio: 'pipe' },
  );

  // Lambda entry: a CJS wrapper requiring the bundled file.
  const wrapperPath = path.join(outDir, 'wrapper.cjs');
  fs.writeFileSync(wrapperPath, `module.exports = require(${JSON.stringify(path.join(outDir, 'fn.js'))});`);
  return require(wrapperPath);
}

test('the background worker exports a handler through the Lambda CJS wrapper load path', () => {
  const mod = buildAndRequire('worker', path.join(root, 'netlify/functions/report-background-background.js'));
  assert.equal(typeof mod.handler, 'function', 'handler must be reachable via require() — Lambda loads background functions through a CJS wrapper');
});

test('the worker bundle stays decoupled from the heavy crawler dependency tree', () => {
  // The crawler chain (Chromium/canvas/PDF parsers, ~120 MB of native binaries)
  // crashed the Lambda runtime with SIGBUS when bundled into this function. It
  // must only ever run inside the standalone `crawlee` function, reached over
  // HTTP. If this fails, someone re-added a crawler import to the worker.
  const bundlePath = path.join(root, 'scratch/.bundle-test-worker/fn.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(!/CheerioCrawler/.test(bundle), 'worker bundle must not inline the Crawlee crawler');
  assert.ok(bundle.length < 500_000, `worker bundle should stay small without the crawler chain (got ${bundle.length} bytes)`);
});

test('the sweeper exports a handler through the Lambda CJS wrapper load path', () => {
  const mod = buildAndRequire('sweeper', path.join(root, 'netlify/functions/report-background-sweeper.js'));
  assert.equal(typeof mod.handler, 'function', 'handler must be reachable via require()');
});
