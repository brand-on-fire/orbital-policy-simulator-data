#!/usr/bin/env node
// Rebuilds vendor/satellite.js-7.1.0/satellite.mjs from the published npm tarball.
// Maintainer-only: CI never runs this file and never installs packages; CI only
// re-hashes the committed bundle (scripts/verify-vendor.mjs).
//
// Usage:
//   node scripts/build-vendor.mjs --package <extracted tarball>/package --esbuild <path to esbuild lib/main.js>
//
// The tarball must be https://registry.npmjs.org/satellite.js/-/satellite.js-7.1.0.tgz and its
// sha512 must equal VENDOR.json npmIntegrity. The two WASM runtimes are replaced by stubs that
// throw, so the bundle is pure JavaScript (json2satrec, propagate, sgp4 and transforms only).
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor', 'satellite.js-7.1.0');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}

const packageDir = argument('--package');
const esbuildPath = argument('--esbuild');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
if (manifest.name !== 'satellite.js' || manifest.version !== '7.1.0') {
  throw new Error('Expected satellite.js 7.1.0');
}

const esbuild = await import(pathToFileURL(esbuildPath).href);
const stubWasm = {
  name: 'stub-satellite-wasm',
  setup(build) {
    build.onResolve({ filter: /^#wasm-(single|multi)-thread$/ }, (args) => ({ path: args.path, namespace: 'wasm-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, () => ({
      contents: 'export default function createWasmModuleStub() { throw new Error("satellite.js WASM runtimes are not vendored; use the pure JavaScript propagate()"); }',
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(packageDir, 'dist', 'index.js')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  legalComments: 'inline',
  write: false,
  plugins: [stubWasm],
  logLevel: 'warning',
});
const banner = '// satellite.js 7.1.0 (MIT, see LICENSE.md), bundled by scripts/build-vendor.mjs with WASM runtimes stubbed.\n';
const bundle = Buffer.concat([Buffer.from(banner), Buffer.from(result.outputFiles[0].contents)]);
await writeFile(path.join(vendorDir, 'satellite.mjs'), bundle);
await writeFile(path.join(vendorDir, 'LICENSE.md'), await readFile(path.join(packageDir, 'LICENSE.md')));
const sha256 = createHash('sha256').update(bundle).digest('hex');
console.log(JSON.stringify({ bytes: bundle.length, sha256, esbuild: esbuild.version }));
