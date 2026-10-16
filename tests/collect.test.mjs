import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { runCollection } from '../scripts/collect.mjs';
import { storageGuard } from '../scripts/lib/storage.mjs';
import { tempDir, testConfigs, mockFetch, noSleep, fixture, NOW, ROOT } from './helpers.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MiB = 1024 * 1024;
const ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'brand-on-fire/orbital-policy-simulator-data',
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'workflow_dispatch',
};

async function setup() {
  const dir = await tempDir();
  return { generatedDir: path.join(dir, 'generated'), runtimeDir: path.join(dir, 'runtime'), configs: await testConfigs() };
}

const read = async (h, relative) => JSON.parse(await readFile(path.join(h.generatedDir, relative), 'utf8'));
const entry = (manifest, id) => manifest.files.find((file) => file.id === id);
const guard = (h) => storageGuard(h.generatedDir, { repositoryBytes: 0, maxPayloadBytes: 10 * MiB, maxRepositoryBytes: 200 * MiB });

async function collect(h, at, override, env = {}) {
  const fetch = mockFetch(override);
  const result = await runCollection({ ...h, root: ROOT, env, clock: () => at, fetchImpl: fetch.fetchImpl, sleepImpl: noSleep });
  assert.equal(fetch.log.unknown, undefined, 'every request was routed to a fixture');
  return { ...result, log: fetch.log };
}

test('three staggered runs publish roster, stations, layers, shells and SATCAT; then nothing is due', async () => {
  const h = await setup();

  const first = await collect(h, NOW, undefined, ENV);
  assert.equal(first.exitCode, 0);
  assert.equal(first.status.outcome, 'complete');
  assert.equal(first.status.scheduleGuarantee, false);
  assert.equal(first.status.run.url, 'https://github.com/brand-on-fire/orbital-policy-simulator-data/actions/runs/123456');
  assert.equal(first.status.celestrak.requestsThisRun, 55);
  assert.equal(first.status.celestrak.countedErrorsTotal, 0);
  let manifest = await read(h, 'manifest.json');
  assert.equal(manifest.scheduleGuarantee, false);
  assert.equal(manifest.collector.runUrl, first.status.run.url);
  assert.deepEqual(manifest.files.map((file) => file.id).sort(), ['roster', 'spaceweather:cycle', 'spaceweather:f107', 'spaceweather:kp']);
  assert.equal(entry(manifest, 'roster').objectCount, 75);
  assert.equal(manifest.withheld.length, 9);
  const roster = await read(h, entry(manifest, 'roster').path);
  assert.equal(roster.objects.length, 75);
  assert.ok(roster.objects.every((object) => object.omm && ['current', 'decaying', 'stale-elements'].includes(object.status)));
  const aether = roster.objects.filter((object) => object.group === 'intdes:2026-004').map((object) => object.omm.OBJECT_NAME);
  assert.equal(aether.length, 10);
  assert.ok(aether.every((name) => /^AETHER-/.test(name)));
  assert.equal(roster.objects.filter((object) => object.group === 'intdes:2025-100').length, 12);
  assert.ok(roster.objects.some((object) => object.noradCatId === 100983));
  assert.match(roster.citation, /USSPACECOM via Space-Track\.org, distributed by CelesTrak/);
  await guard(h);
  const notice = await readFile(path.join(h.generatedDir, 'NOTICE.md'), 'utf8');
  assert.match(notice, /not for conjunction assessment/);

  const second = await collect(h, NOW + 30 * MINUTE);
  assert.equal(second.exitCode, 0);
  assert.equal(second.status.sources.find((source) => source.id === 'satcat-roster').status, 'deferred');
  manifest = await read(h, 'manifest.json');
  for (const group of ['gps-ops', 'galileo', 'glo-ops', 'beidou', 'kuiper']) {
    assert.ok(entry(manifest, `shells:${group}`), group);
    assert.ok(entry(manifest, `layer-sampled:${group}`), group);
    assert.ok(entry(manifest, `satcat-layer:${group}`), group);
  }
  const shells = await read(h, entry(manifest, 'shells:kuiper').path);
  assert.equal(shells.objectCount, 391);
  assert.equal(shells.shells.reduce((sum, shell) => sum + shell.count, 0), 391);
  const layer = await read(h, entry(manifest, 'layer-sampled:kuiper').path);
  assert.ok(layer.rows.every((row) => row[0] % 10 === 0));
  assert.equal(layer.fields[0], 'NORAD_CAT_ID');
  const gps = await read(h, entry(manifest, 'layer-sampled:gps-ops').path);
  assert.equal(gps.rows.length, 32, 'small constellations are published in full');
  const stations = await read(h, entry(manifest, 'stations').path);
  assert.deepEqual(stations.stations.map((block) => [block.source, block.noradCatId, block.segments.length]), [['CSS-E', 48274, 60], ['ISS-E', 25544, 60]]);
  await guard(h);

  const third = await collect(h, NOW + 60 * MINUTE);
  assert.equal(third.exitCode, 0);
  manifest = await read(h, 'manifest.json');
  const satcat = await read(h, entry(manifest, 'satcat:roster').path);
  assert.equal(satcat.records.length, 75);
  assert.ok(satcat.records.every((record) => record.OBJECT_TYPE === 'PAY'));
  assert.equal(third.status.celestrak.countedErrorsTotal, 0);
  await guard(h);

  const before = await readdir(h.generatedDir, { recursive: true });
  const quiet = await collect(h, NOW + 90 * MINUTE);
  assert.equal(quiet.changed, false);
  assert.equal(quiet.status.outcome, 'no-sources-due');
  assert.equal(quiet.log.length, 0);
  assert.deepEqual(await readdir(h.generatedDir, { recursive: true }), before);
});

test('keeps the last good layer on a count drop and the last good elements on an epoch regression', async () => {
  const h = await setup();
  await collect(h, NOW);
  await collect(h, NOW + 30 * MINUTE);
  const manifest = await read(h, 'manifest.json');
  const shellsBefore = entry(manifest, 'shells:kuiper');
  const rosterBefore = await read(h, entry(manifest, 'roster').path);
  const issBefore = rosterBefore.objects.find((object) => object.noradCatId === 25544);

  const truncatedKuiper = fixture('celestrak/gp-group-kuiper.csv').split('\r\n').slice(0, 301).join('\r\n') + '\r\n';
  const olderIss = fixture('celestrak/gp-catnr-25544.csv').replace('2026-10-15T11:59:01.524480', '2026-10-14T11:59:01.524480');
  const later = await collect(h, NOW + 25 * HOUR, (url) => {
    if (url.includes('GROUP=kuiper&')) return url.includes('/satcat/') ? null : { status: 200, body: truncatedKuiper };
    if (url.includes('gp.php?CATNR=25544&')) return { status: 200, body: olderIss };
    return null;
  });
  assert.equal(later.exitCode, 1, 'a rejected refresh is surfaced for a human');
  const after = await read(h, 'manifest.json');
  assert.equal(entry(after, 'shells:kuiper').path, shellsBefore.path);
  assert.match(later.status.sources.find((source) => source.id === 'layer-kuiper').detail, /count-drop/);
  assert.notEqual(entry(after, 'shells:gps-ops').retrievedAt, undefined);
  const rosterAfter = await read(h, entry(after, 'roster').path);
  const issAfter = rosterAfter.objects.find((object) => object.noradCatId === 25544);
  assert.equal(issAfter.omm.EPOCH, issBefore.omm.EPOCH);
  assert.equal(issAfter.status, 'retained');
  assert.match(issAfter.flags[0], /epoch-regression/);
  assert.equal(later.status.celestrak.countedErrorsThisRun, 0);
  await guard(h);
});

test('a CSV header change halts only that source until a human reset', async () => {
  const h = await setup();
  await collect(h, NOW);
  const changed = fixture('celestrak/gp-group-gps-ops.csv').replace('MEAN_MOTION,', 'MEAN_MOTION_REV_PER_DAY,');
  const second = await collect(h, NOW + 30 * MINUTE, (url) => (url.includes('gp.php?GROUP=gps-ops&') ? { status: 200, body: changed } : null));
  assert.equal(second.exitCode, 1);
  const gps = second.status.sources.find((source) => source.id === 'layer-gps-ops');
  assert.equal(gps.status, 'failed');
  assert.equal(second.status.celestrak.halted, false, 'a 200 with a new schema is not a CelesTrak error');
  const third = await collect(h, NOW + 30 * HOUR);
  assert.ok(!third.log.some((url) => url.includes('gp.php?GROUP=gps-ops&')));
  assert.equal(third.status.sources.find((source) => source.id === 'layer-gps-ops').status, 'halted');
  h.configs.policy.haltResetAt = new Date(NOW + 31 * HOUR).toISOString();
  const fourth = await collect(h, NOW + 32 * HOUR);
  assert.ok(fourth.log.some((url) => url.includes('gp.php?GROUP=gps-ops&')));
});

test('invalid space weather is rejected and the last good series kept', async () => {
  const h = await setup();
  await collect(h, NOW);
  const kpBefore = entry(await read(h, 'manifest.json'), 'spaceweather:kp');
  const bad = JSON.stringify(JSON.parse(fixture('swpc/noaa-planetary-k-index.json')).map((item, index) => (index === 3 ? { ...item, Kp: 12 } : item)));
  const later = await collect(h, NOW + 4 * HOUR, (url) => (url.includes('noaa-planetary-k-index') ? { status: 200, body: bad } : null));
  assert.equal(later.exitCode, 1);
  assert.equal(entry(await read(h, 'manifest.json'), 'spaceweather:kp').path, kpBefore.path);
  assert.match(later.status.sources.find((source) => source.id === 'swpc-kp').detail, /Kp outside/);
});
