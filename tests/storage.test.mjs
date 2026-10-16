import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir, symlink, readFile, readdir } from 'node:fs/promises';
import { storageGuard, writeContent, writeJson, pruneUnreferenced, retainedPaths, allowedPath, StorageError } from '../scripts/lib/storage.mjs';
import { tempDir } from './helpers.mjs';

const MiB = 1024 * 1024;
const LIMITS = { repositoryBytes: 1024, maxPayloadBytes: 10 * MiB, maxRepositoryBytes: 200 * MiB };

async function publication() {
  const root = await tempDir();
  const roster = await writeContent(root, 'roster', { schemaVersion: 1, kind: 'roster', objects: [] });
  const manifest = { schemaVersion: 1, generatedAt: '2026-10-16T01:00:00.000Z', scheduleGuarantee: false, files: [{ id: 'roster', ...roster, objectCount: 0 }] };
  await writeJson(path.join(root, 'manifest.json'), manifest);
  await writeJson(path.join(root, 'status.json'), { schemaVersion: 1, scheduleGuarantee: false, outcome: 'complete' });
  await writeJson(path.join(root, 'state/collector-state.json'), { schemaVersion: 1, publishedPaths: { roster: [roster.path] } });
  await writeFile(path.join(root, 'NOTICE.md'), '# Notice\n');
  return { root, roster, manifest };
}

test('a valid publication passes the guard', async () => {
  const { root } = await publication();
  const result = await storageGuard(root, LIMITS);
  assert.equal(result.files, 5);
});

test('path allowlist', () => {
  for (const ok of ['manifest.json', 'status.json', 'NOTICE.md', 'state/collector-state.json', `roster/${'a'.repeat(64)}.json`, `layers-sampled/${'0'.repeat(64)}.json`]) assert.ok(allowedPath(ok), ok);
  for (const bad of ['README.md', 'roster/latest.json', `roster/${'A'.repeat(64)}.json`, `layers/${'a'.repeat(64)}.json`, `../${'a'.repeat(64)}.json`, 'state/other.json', '.github/workflows/x.yml']) assert.ok(!allowedPath(bad), bad);
});

test('unexpected files, symlinks and tampered content are refused', async () => {
  let p = await publication();
  await writeFile(path.join(p.root, 'extra.txt'), 'x');
  await assert.rejects(storageGuard(p.root, LIMITS), /Unexpected publication file/);

  p = await publication();
  await symlink('/etc/hosts', path.join(p.root, 'hosts'));
  await assert.rejects(storageGuard(p.root, LIMITS), /Symbolic links/);

  p = await publication();
  await writeFile(path.join(p.root, p.roster.path), '{"tampered":true}');
  await assert.rejects(storageGuard(p.root, LIMITS), StorageError);

  p = await publication();
  const manifest = JSON.parse(await readFile(path.join(p.root, 'manifest.json'), 'utf8'));
  manifest.files[0].bytes += 1;
  await writeJson(path.join(p.root, 'manifest.json'), manifest);
  await assert.rejects(storageGuard(p.root, LIMITS), /hash or byte count/);

  p = await publication();
  const schedule = JSON.parse(await readFile(path.join(p.root, 'manifest.json'), 'utf8'));
  schedule.scheduleGuarantee = true;
  await writeJson(path.join(p.root, 'manifest.json'), schedule);
  await assert.rejects(storageGuard(p.root, LIMITS), /Invalid public manifest/);
});

test('an unreferenced content file is refused (retention must be explicit)', async () => {
  const p = await publication();
  await writeContent(p.root, 'shells', { orphan: true });
  await assert.rejects(storageGuard(p.root, LIMITS), /Unreferenced content file/);
});

test('MAINTENANCE REQUIRED at the payload cap and the 200 MiB repository cap', async () => {
  const p = await publication();
  await assert.rejects(storageGuard(p.root, { ...LIMITS, maxPayloadBytes: 100 }), /MAINTENANCE REQUIRED/);
  await assert.rejects(storageGuard(p.root, { ...LIMITS, repositoryBytes: 200 * MiB - 100 }), /MAINTENANCE REQUIRED/);
  await assert.rejects(storageGuard(p.root, { ...LIMITS, localGitBytes: 200 * MiB }), /MAINTENANCE REQUIRED/);
  await assert.rejects(storageGuard(p.root, { ...LIMITS, repositoryBytes: undefined }), /Repository size/);
});

test('retention keeps the current and previous generation and prunes the rest', async () => {
  const root = await tempDir();
  const a = await writeContent(root, 'roster', { generation: 1 });
  const b = await writeContent(root, 'roster', { generation: 2 });
  const c = await writeContent(root, 'roster', { generation: 3 });
  const manifest = { files: [{ id: 'roster', path: c.path }] };
  const state = { publishedPaths: { roster: [c.path, b.path] } };
  const removed = await pruneUnreferenced(root, retainedPaths(manifest, state));
  assert.deepEqual(removed, [a.path]);
  assert.deepEqual((await readdir(path.join(root, 'roster'))).sort(), [path.basename(b.path), path.basename(c.path)].sort());
});

test('content addressing is canonical: equal content gives one path', async () => {
  const root = await tempDir();
  const first = await writeContent(root, 'satcat', { b: 1, a: [1, 2] });
  const second = await writeContent(root, 'satcat', { a: [1, 2], b: 1 });
  assert.equal(first.path, second.path);
  await mkdir(path.join(root, 'x'), { recursive: true });
  await assert.rejects(writeContent(root, 'layers', {}), /Unknown content directory/);
});
