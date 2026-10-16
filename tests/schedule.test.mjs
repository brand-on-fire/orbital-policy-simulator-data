import test from 'node:test';
import assert from 'node:assert/strict';
import { planRun, isDue, allRequests } from '../scripts/lib/sources.mjs';
import { defaultState } from '../scripts/lib/safety.mjs';
import { validateConfigs, MIN_CELESTRAK_POLL_MINUTES } from '../scripts/lib/config.mjs';
import { loadRealConfigs, NOW } from './helpers.mjs';

const MINUTE = 60_000;

test('pollMinutes >= 120 for every CelesTrak source, and validation enforces it', async () => {
  const configs = await loadRealConfigs();
  const celestrak = configs.policy.sources.filter((source) => source.provider === 'celestrak');
  assert.ok(celestrak.length >= 13);
  for (const source of celestrak) assert.ok(source.pollMinutes >= MIN_CELESTRAK_POLL_MINUTES, source.id);
  assert.equal(MIN_CELESTRAK_POLL_MINUTES, 120);
  const broken = await loadRealConfigs();
  broken.policy.sources.find((source) => source.id === 'layer-starlink').pollMinutes = 119;
  assert.throws(() => validateConfigs(broken), /more often than every 120 minutes/);
});

test('configured cadences: roster and SupGP 6 h, layers daily, SATCAT weekly, Kp 3 h, F10.7 daily, cycle weekly', async () => {
  const { policy } = await loadRealConfigs();
  const poll = Object.fromEntries(policy.sources.map((source) => [source.id, source.pollMinutes]));
  assert.equal(poll['roster-gp'], 360);
  assert.equal(poll['stations-supgp'], 360);
  for (const group of ['starlink', 'oneweb', 'kuiper', 'qianfan', 'hulianwang', 'gps-ops', 'glo-ops', 'galileo', 'beidou']) assert.equal(poll[`layer-${group}`], 1440);
  assert.equal(poll['satcat-roster'], 10080);
  assert.equal(poll['satcat-layers'], 10080);
  assert.equal(poll['swpc-kp'], 180);
  assert.equal(poll['swpc-f107'], 1440);
  assert.equal(poll['swpc-cycle'], 10080);
});

test('roster requests: 53 CATNR plus INTDES 2025-100 and 2026-004, CSV only', async () => {
  const configs = await loadRealConfigs();
  const roster = allRequests(configs.policy.sources.find((source) => source.id === 'roster-gp'), configs);
  assert.equal(roster.length, 55);
  for (const id of [67232, 43873, 51850, 39084, 54234, 43613, 25994, 40115, 45465, 33053, 38358, 36395, 56370, 57479, 62259]) {
    assert.ok(roster.some((req) => req.url.endsWith(`CATNR=${id}&FORMAT=CSV`)), `${id}`);
  }
  assert.ok(roster.some((req) => req.url.endsWith('CATNR=65585&FORMAT=CSV')));
  assert.ok(roster.some((req) => req.url.endsWith('INTDES=2025-100&FORMAT=CSV')));
  assert.ok(roster.some((req) => req.url.endsWith('INTDES=2026-004&FORMAT=CSV')));
  assert.ok(roster.every((req) => req.url.endsWith('&FORMAT=CSV') && !/TLE/.test(req.url)));
});

test('every source fits inside the per-run request cap (so none can be deferred forever)', async () => {
  const configs = await loadRealConfigs();
  for (const source of configs.policy.sources) {
    assert.ok(allRequests(source, configs).length <= configs.policy.celestrak.maxRequestsPerRun, source.id);
  }
});

test('due logic is keyed on the last attempt, with backoff after errors', () => {
  const source = { id: 'x', enabled: true, pollMinutes: 360 };
  assert.equal(isDue(source, undefined, NOW), true);
  const attempted = { lastAttemptAt: new Date(NOW).toISOString(), lastStatus: 'ok' };
  assert.equal(isDue(source, attempted, NOW + 359 * MINUTE), false);
  assert.equal(isDue(source, attempted, NOW + 360 * MINUTE), true);
  // A failure never causes a rapid retry: the attempt time still governs.
  const failed = { lastAttemptAt: new Date(NOW).toISOString(), lastStatus: 'counted-error', lastSuccessAt: null };
  assert.equal(isDue(source, failed, NOW + 30 * MINUTE), false);
  const kp = { id: 'kp', enabled: true, pollMinutes: 180 };
  assert.equal(isDue(kp, { ...failed }, NOW + 200 * MINUTE), false);
  assert.equal(isDue(kp, { ...failed }, NOW + 360 * MINUTE), true);
  assert.equal(isDue({ ...source, enabled: false }, undefined, NOW), false);
});

test('first run is staggered: only the roster reaches CelesTrak; the rest are deferred, never errors', async () => {
  const configs = await loadRealConfigs();
  const plan = planRun(configs, defaultState(), NOW);
  assert.deepEqual(plan.run.map((item) => item.id), ['roster-gp', 'swpc-kp', 'swpc-f107', 'swpc-cycle']);
  assert.equal(plan.deferred.length, 12);
  assert.ok(plan.deferred.every((item) => /first-run stagger/.test(item.reason)));
  assert.deepEqual(plan.blocked, []);
});

test('second tick fills the per-run cap in priority order and defers the remainder', async () => {
  const configs = await loadRealConfigs();
  const state = defaultState();
  const at = new Date(NOW).toISOString();
  state.sources['roster-gp'] = { lastAttemptAt: at, lastStatus: 'ok', lastSuccessAt: at };
  for (const id of ['swpc-kp', 'swpc-f107', 'swpc-cycle']) state.sources[id] = { lastAttemptAt: at, lastStatus: 'ok' };
  const plan = planRun(configs, state, NOW + 30 * MINUTE);
  const ran = plan.run.map((item) => item.id);
  assert.ok(ran.includes('stations-supgp'));
  assert.ok(ran.includes('layer-starlink') && ran.includes('layer-beidou'));
  assert.ok(ran.includes('satcat-layers'));
  assert.deepEqual(plan.deferred.map((item) => item.id), ['satcat-roster']);
  assert.match(plan.deferred[0].reason, /per-run request cap \(55 needed, 49 left\)/);
  assert.ok(plan.run.reduce((sum, item) => sum + (item.id.startsWith('swpc') ? 0 : item.requestCount), 0) <= configs.policy.celestrak.maxRequestsPerRun);
});

test('halts, cooldowns, byte budget and the storage threshold block CelesTrak but not SWPC', async () => {
  const configs = await loadRealConfigs();
  const halted = defaultState();
  halted.celestrak.halted = true;
  halted.celestrak.haltReason = 'test';
  let plan = planRun(configs, halted, NOW);
  assert.deepEqual(plan.run.map((item) => item.id), ['swpc-kp', 'swpc-f107', 'swpc-cycle']);
  assert.equal(plan.blocked.length, 13);

  const spent = defaultState();
  spent.celestrak.bytesByDay[new Date(NOW).toISOString().slice(0, 10)] = configs.policy.celestrak.maxBytesPerDay;
  plan = planRun(configs, spent, NOW);
  assert.ok(plan.deferred.every((item) => /byte budget/.test(item.reason)));

  const state = defaultState();
  state.sources['roster-gp'] = { lastAttemptAt: new Date(NOW).toISOString(), lastStatus: 'ok' };
  plan = planRun(configs, state, NOW + 30 * MINUTE, { repositoryBytes: configs.policy.publication.layersHaltRepositoryBytes });
  assert.ok(plan.blocked.filter((item) => /MAINTENANCE REQUIRED/.test(item.reason)).length === 10);
  assert.ok(plan.run.some((item) => item.id === 'stations-supgp'));
});

test('new-id backfill: requests only missing catalog numbers once, without moving the cadence', async () => {
  const configs = await loadRealConfigs();
  const at = new Date(NOW).toISOString();
  const state = defaultState();
  for (const source of configs.policy.sources) state.sources[source.id] = { lastAttemptAt: at, lastStatus: 'ok', lastSuccessAt: at };
  const missingIds = { 'satcat-roster': [67232, 45465], 'roster-gp': [], 'layer-starlink': [67232] };
  let plan = planRun(configs, state, NOW + 30 * MINUTE, { missingIds });
  assert.deepEqual(plan.run, [{ id: 'satcat-roster', requestCount: 2, mode: 'backfill', queryKeys: ['CATNR=67232', 'CATNR=45465'] }]);

  // Once a key has been requested, it waits for the source's own pollMinutes.
  state.keyAttempts['satcat:CATNR=67232'] = new Date(NOW + 31 * MINUTE).toISOString();
  plan = planRun(configs, state, NOW + 60 * MINUTE, { missingIds });
  assert.deepEqual(plan.run.map((item) => item.queryKeys), [['CATNR=45465']]);
  state.keyAttempts['satcat:CATNR=45465'] = new Date(NOW + 61 * MINUTE).toISOString();
  assert.deepEqual(planRun(configs, state, NOW + 90 * MINUTE, { missingIds }).run, []);

  // Quarantined keys are never backfilled; nothing runs inside an error backoff or a cooldown.
  const fresh = structuredClone(state);
  fresh.keyAttempts = {};
  fresh.quarantine.push({ key: 'satcat:CATNR=45465', at });
  assert.deepEqual(planRun(configs, fresh, NOW + 30 * MINUTE, { missingIds }).run[0].queryKeys, ['CATNR=67232']);
  const failed = structuredClone(fresh);
  failed.sources['satcat-roster'].lastStatus = 'counted-error';
  assert.deepEqual(planRun(configs, failed, NOW + 30 * MINUTE, { missingIds }).run, []);
  const backfillFailed = structuredClone(fresh);
  Object.assign(backfillFailed.sources['satcat-roster'], { lastBackfillAt: at, lastBackfillStatus: 'counted-error' });
  const satcatRuns = (plan) => plan.run.filter((item) => item.id === 'satcat-roster');
  assert.deepEqual(satcatRuns(planRun(configs, backfillFailed, NOW + 300 * MINUTE, { missingIds })), []);
  assert.equal(satcatRuns(planRun(configs, backfillFailed, NOW + 361 * MINUTE, { missingIds })).length, 1);
  const cooling = structuredClone(fresh);
  cooling.celestrak.cooldownUntil = new Date(NOW + 60 * MINUTE).toISOString();
  plan = planRun(configs, cooling, NOW + 30 * MINUTE, { missingIds });
  assert.deepEqual(plan.run, []);
  assert.match(plan.blocked.find((item) => item.id === 'satcat-roster').reason, /^backfill: cooling down/);
});
