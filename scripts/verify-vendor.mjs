#!/usr/bin/env node
// Re-hashes the vendored satellite.js bundle and licence against VENDOR.json and
// runs the golden ISS propagation. Exits 1 on any mismatch. No network, no install.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(root, 'vendor', 'satellite.js-7.1.0');

export async function verifyVendor(directory = VENDOR_DIR) {
  const vendor = JSON.parse(await readFile(path.join(directory, 'VENDOR.json'), 'utf8'));
  const problems = [];
  if (vendor.package !== 'satellite.js' || vendor.version !== '7.1.0') problems.push('VENDOR.json does not describe satellite.js 7.1.0');
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(vendor.npmIntegrity)) problems.push('npm integrity string is malformed');
  const bundle = await readFile(path.join(directory, vendor.bundle.file));
  const bundleSha = createHash('sha256').update(bundle).digest('hex');
  if (bundleSha !== vendor.bundle.sha256 || bundle.length !== vendor.bundle.bytes) problems.push(`bundle sha256 ${bundleSha} (${bundle.length} bytes) does not match VENDOR.json`);
  const licence = await readFile(path.join(directory, vendor.licenseFile.file));
  if (createHash('sha256').update(licence).digest('hex') !== vendor.licenseFile.sha256) problems.push('licence sha256 does not match VENDOR.json');
  const text = bundle.toString('utf8');
  for (const specifier of vendor.bundle.stubbedImports) {
    if (text.includes(`import("${specifier}")`) || text.includes(`from "${specifier}"`)) problems.push(`bundle still imports ${specifier}`);
  }
  if (problems.length) return { ok: false, problems };

  const satellite = await import(pathToFileURL(path.join(directory, vendor.bundle.file)).href);
  const satrec = satellite.json2satrec(vendor.golden.omm);
  const result = satellite.propagate(satrec, new Date(vendor.golden.at));
  if (satrec.error !== 0 || !result?.position) return { ok: false, problems: ['golden propagation failed'] };
  for (const axis of ['x', 'y', 'z']) {
    const delta = Math.abs(result.position[axis] - vendor.golden.positionKm[axis]);
    if (!(delta <= vendor.golden.toleranceKm)) problems.push(`golden position ${axis} differs by ${delta} km`);
  }
  return { ok: problems.length === 0, problems, sha256: bundleSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyVendor();
  if (!result.ok) {
    console.error(`Vendored satellite.js verification FAILED:\n- ${result.problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Vendored satellite.js 7.1.0 verified (sha256 ${result.sha256}); golden ISS propagation matches.`);
}
