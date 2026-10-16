import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyVendor, VENDOR_DIR } from '../scripts/verify-vendor.mjs';
import { tempDir } from './helpers.mjs';

test('the vendored satellite.js 7.1.0 bundle matches VENDOR.json and the golden ISS propagation', async () => {
  const result = await verifyVendor();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  const vendor = JSON.parse(await readFile(path.join(VENDOR_DIR, 'VENDOR.json'), 'utf8'));
  assert.equal(vendor.npmIntegrity, 'sha512-U6nRml9Nb7dV9LJPiMNPyna7U7ry+1nXYkOeCEG7K/YbojQQLHHmcjPisp03VNY+HLcbQHqbt7t4t1vQMaKCLQ==');
  assert.deepEqual(vendor.bundle.stubbedImports, ['#wasm-single-thread', '#wasm-multi-thread']);
  const bundle = await readFile(path.join(VENDOR_DIR, 'satellite.mjs'));
  assert.equal(createHash('sha256').update(bundle).digest('hex'), vendor.bundle.sha256);
});

test('a one-byte change to the bundle fails verification', async () => {
  const dir = await tempDir();
  await cp(VENDOR_DIR, dir, { recursive: true });
  const file = path.join(dir, 'satellite.mjs');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('satellite.js 7.1.0', 'satellite.js 7.1.1'));
  const result = await verifyVendor(dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /bundle sha256/);
});

test('the WASM runtimes are stubbed (pure JavaScript only)', async () => {
  const satellite = await import('../vendor/satellite.js-7.1.0/satellite.mjs');
  await assert.rejects(satellite.createSingleThreadRuntime(), /not vendored/);
  assert.equal(typeof satellite.json2satrec, 'function');
  assert.equal(typeof satellite.propagate, 'function');
});
