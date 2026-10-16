import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { keepaliveDue, heartbeatContent, HEARTBEAT_PATH } from '../scripts/lib/keepalive.mjs';
import { ROOT, NOW } from './helpers.mjs';

const DAY = 86_400_000;
const workflow = () => readFile(path.join(ROOT, '.github/workflows/collect.yml'), 'utf8');

function pushPaths(text) {
  const block = text.split('push:')[1].split('schedule:')[0];
  return [...block.matchAll(/- '([^']+)'/g)].map((match) => match[1]);
}

function globMatches(pattern, file) {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  return regex.test(file);
}

test('workflow: schedule, triggers, guard, permissions and concurrency', async () => {
  const text = await workflow();
  assert.match(text, /cron: '17,47 \* \* \* \*'/);
  assert.match(text, /^\s{2}workflow_dispatch:/m);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.match(text, /^ {4}permissions:\n {6}contents: write$/m);
  assert.match(text, /concurrency:\n {2}group: orbital-public-collection\n {2}cancel-in-progress: false/);
  assert.match(text, /toJSON\(github\.event\.repository\.private\) == 'false'/);
  assert.match(text, /github\.event\.repository\.visibility == 'public'/);
  assert.match(text, /github\.repository == 'brand-on-fire\/orbital-policy-simulator-data'/);
  assert.match(text, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(text, /runs-on: ubuntu-24\.04\n/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /continue-on-error: true\n\s+run: node scripts\/collect\.mjs/);
});

test('workflow: no secrets, cache, artifacts, installs or paid runners', async () => {
  const text = (await workflow()).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const forbidden of [/secrets\./, /actions\/cache/, /upload-artifact/, /npm (?:ci|install)/, /setup-node/, /larger|xlarge|-arm|macos|windows/]) {
    assert.doesNotMatch(text, forbidden);
  }
  const tokens = [...text.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]);
  assert.ok(tokens.every((token) => token === 'github.token'), tokens.join(', '));
});

test('the keepalive heartbeat path never matches the push path filter', async () => {
  const patterns = pushPaths(await workflow());
  assert.deepEqual(patterns, ['.github/workflows/collect.yml', 'config/**', 'scripts/**', 'vendor/**', 'tests/**']);
  assert.ok(patterns.some((pattern) => globMatches(pattern, 'scripts/collect.mjs')), 'matcher sanity');
  assert.ok(!patterns.some((pattern) => globMatches(pattern, HEARTBEAT_PATH)));
});

test('keepalive is due only after 30 days without a heartbeat or a main commit', () => {
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  assert.equal(keepaliveDue({ nowMs: NOW, lastCommittedAt: null, mainHeadCommittedAt: at(1), intervalDays: 30 }), false);
  assert.equal(keepaliveDue({ nowMs: NOW, lastCommittedAt: at(29), mainHeadCommittedAt: at(45), intervalDays: 30 }), false);
  assert.equal(keepaliveDue({ nowMs: NOW, lastCommittedAt: at(31), mainHeadCommittedAt: at(31), intervalDays: 30 }), true);
  assert.equal(keepaliveDue({ nowMs: NOW, lastCommittedAt: at(40), mainHeadCommittedAt: at(5), intervalDays: 30 }), false);
  assert.equal(keepaliveDue({ nowMs: NOW, lastCommittedAt: null, mainHeadCommittedAt: null, intervalDays: 30 }), true);
  assert.match(heartbeatContent({ nowIso: '2026-11-15T04:17:00.000Z', runUrl: 'https://example.test/run' }), /Last heartbeat: 2026-11-15T04:17:00\.000Z/);
});

async function textFiles(directory) {
  const found = [];
  for (const name of await readdir(directory)) {
    if (['.git', 'generated', 'runtime', 'node_modules'].includes(name)) continue;
    const full = path.join(directory, name);
    const info = await lstat(full);
    if (info.isDirectory()) found.push(...await textFiles(full));
    else if (/\.(mjs|js|json|md|yml|csv|txt)$|^\.gitignore$|^LICENSE/.test(name)) found.push(full);
  }
  return found;
}

test('no em or en dashes anywhere in the repository', async () => {
  const offenders = [];
  for (const file of await textFiles(ROOT)) {
    const text = await readFile(file, 'utf8');
    if (/[\u2013\u2014]/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('NOTICE carries the required credits and warnings', async () => {
  const notice = await readFile(path.join(ROOT, 'NOTICE.md'), 'utf8');
  assert.match(notice, /USSPACECOM via Space-Track\.org, distributed by CelesTrak/);
  assert.match(notice, /NOAA Space Weather Prediction Center/);
  assert.match(notice, /subset, not a catalog mirror/);
  assert.match(notice, /not for conjunction assessment/);
  assert.match(notice, /NEA/);
});
