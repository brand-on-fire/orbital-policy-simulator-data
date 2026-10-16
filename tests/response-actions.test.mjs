import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { classifyResponse, recordCelestrakResponse, applyHaltReset, defaultState, celestrakBlockedReason } from '../scripts/lib/safety.mjs';
import { runCollection } from '../scripts/collect.mjs';
import { tempDir, testConfigs, mockFetch, noSleep, NOW, ROOT } from './helpers.mjs';

const POLICY = { celestrak: { errorCooldownMinutes: 120, haltAfterCountedErrors: 3, haltAfterConsecutive403: 2 } };
const HOUR = 3_600_000;
const response = (status, body = '') => ({ kind: 'response', status, body, bytes: body.length });

test('response-to-action table', () => {
  const table = [
    [response(200, 'OBJECT_NAME,...'), { label: 'ok', counted: false, stop: false }],
    [response(200, 'No GP data found'), { label: 'no-data', counted: false, stop: false, quarantine: true }],
    [response(200, 'No SATCAT records found'), { label: 'no-data', counted: false, stop: false, quarantine: true }],
    [response(301), { label: 'redirect-301', counted: true, stop: true, halt: 'HTTP 301 redirect: the request URL is wrong' }],
    [response(302), { label: 'redirect-302', counted: true, stop: true, halt: 'HTTP 302 redirect: the request URL is wrong' }],
    [response(403, 'GP data has not updated since your last successful download'), { label: 'forbidden-not-updated', counted: true, stop: true, is403: true }],
    [response(403, '<h3>Access from IP address 203.0.113.7 was blocked</h3>'), { label: 'forbidden', counted: true, stop: true, is403: true }],
    [response(404, 'No GP data found'), { label: 'not-found', counted: true, stop: true, quarantine: true }],
    [response(429), { label: 'http-429', counted: true, stop: true }],
    [response(500), { label: 'server-500', counted: true, stop: true }],
    [response(503), { label: 'server-503', counted: true, stop: true }],
    [{ kind: 'timeout' }, { label: 'timeout', counted: true, stop: true }],
    [{ kind: 'network' }, { label: 'network', counted: true, stop: true }],
    [{ kind: 'byte-cap', status: 200 }, { label: 'byte-cap', counted: true, stop: true }],
  ];
  for (const [result, expected] of table) assert.deepEqual(classifyResponse(result), expected, JSON.stringify(result));
});

function apply(state, result, nowMs, queryKey = 'gp:CATNR=25544') {
  const events = {};
  const classification = recordCelestrakResponse(state, { result, url: 'u', queryKey, nowMs, policy: POLICY, events });
  return { classification, events };
}

test('every 403 counts and two consecutive 403s halt for a human', () => {
  const state = defaultState();
  assert.equal(apply(state, response(403, 'GP data has not updated since your last successful download'), NOW).events.countedErrors, 1);
  assert.equal(state.celestrak.halted, false);
  const second = apply(state, response(403), NOW + 3 * HOUR);
  assert.equal(second.events.newlyHalted, true);
  assert.match(state.celestrak.haltReason, /2 consecutive HTTP 403/);
});

test('a 200 between 403s resets the 403 streak, but 3 counted errors in 24 hours still halt', () => {
  const state = defaultState();
  apply(state, response(403), NOW);
  apply(state, response(200), NOW + 2 * HOUR);
  apply(state, response(403), NOW + 3 * HOUR);
  assert.equal(state.celestrak.halted, false);
  assert.equal(state.celestrak.consecutive403, 1);
  apply(state, response(500), NOW + 6 * HOUR);
  assert.equal(state.celestrak.halted, true);
  assert.match(state.celestrak.haltReason, /3 counted errors within 24 hours/);
});

test('three consecutive counted errors halt even when spread over days', () => {
  const state = defaultState();
  apply(state, response(500), NOW);
  apply(state, response(503), NOW + 30 * HOUR);
  assert.equal(state.celestrak.halted, false);
  apply(state, { kind: 'timeout' }, NOW + 60 * HOUR);
  assert.equal(state.celestrak.halted, true);
  assert.match(state.celestrak.haltReason, /3 consecutive counted errors/);
});

test('a 301 halts immediately; a 404 quarantines its query key', () => {
  const state = defaultState();
  assert.equal(apply(state, response(301), NOW).events.newlyHalted, true);
  const other = defaultState();
  apply(other, response(404, 'No GP data found'), NOW, 'gp:CATNR=99999');
  assert.deepEqual(other.quarantine.map((entry) => entry.key), ['gp:CATNR=99999']);
  assert.equal(other.celestrak.countedErrorsTotal, 1);
  assert.equal(other.celestrak.halted, false);
});

test('a counted error starts a 120-minute cooldown for all CelesTrak requests', () => {
  const state = defaultState();
  apply(state, response(500), NOW);
  assert.match(celestrakBlockedReason(state, NOW + 119 * 60_000), /cooling down/);
  assert.equal(celestrakBlockedReason(state, NOW + 121 * 60_000), null);
});

test('only a past haltResetAt later than the halt clears it', () => {
  const state = defaultState();
  apply(state, response(301), NOW);
  assert.match(applyHaltReset(state, new Date(NOW + 10 * HOUR).toISOString(), NOW + HOUR).error, /future/);
  assert.equal(state.celestrak.halted, true);
  assert.match(applyHaltReset(state, 'yesterday', NOW + HOUR).error, /not a valid/);
  assert.equal(applyHaltReset(state, new Date(NOW - HOUR).toISOString(), NOW + HOUR).applied, false);
  assert.equal(state.celestrak.halted, true);
  const reset = applyHaltReset(state, new Date(NOW + 30 * 60_000).toISOString(), NOW + HOUR);
  assert.equal(reset.applied, true);
  assert.equal(state.celestrak.halted, false);
  assert.equal(state.celestrak.consecutiveErrors, 0);
  assert.equal(celestrakBlockedReason(state, NOW + HOUR), null);
  // A later halt is not cleared by the same (older) reset.
  apply(state, response(301), NOW + 2 * HOUR);
  applyHaltReset(state, new Date(NOW + 30 * 60_000).toISOString(), NOW + 3 * HOUR);
  assert.equal(state.celestrak.halted, true);
});

async function harness() {
  const dir = await tempDir();
  return { generatedDir: path.join(dir, 'generated'), runtimeDir: path.join(dir, 'runtime'), configs: await testConfigs() };
}

const celestrakCalls = (log) => log.filter((url) => url.startsWith('https://celestrak.org/')).length;

test('the first non-200 stops every later CelesTrak request in the run; SWPC continues', async () => {
  const h = await harness();
  const { fetchImpl, log } = mockFetch((url) => (url.includes('CATNR=48274') ? { status: 403, body: 'blocked' } : null));
  const result = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW, fetchImpl, sleepImpl: noSleep });
  assert.equal(celestrakCalls(log), 2, 'ISS succeeded, Tiangong 403, then nothing');
  assert.equal(log.filter((url) => url.includes('swpc.noaa.gov')).length, 3);
  assert.equal(result.exitCode, 1);
  assert.equal(result.status.celestrak.countedErrorsThisRun, 1);
  assert.equal(result.status.celestrak.halted, false);
  const roster = result.status.sources.find((source) => source.id === 'roster-gp');
  assert.equal(roster.status, 'partial');
  const state = JSON.parse(await readFile(path.join(h.generatedDir, 'state/collector-state.json'), 'utf8'));
  assert.equal(state.celestrak.consecutive403, 1);
  assert.equal(state.sources['roster-gp'].lastStatus, 'counted-error');
  assert.equal(log.unknown, undefined);

  // Within the cooldown nothing is requested from CelesTrak, even sources that are due.
  const again = mockFetch();
  const second = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW + 60 * 60_000, fetchImpl: again.fetchImpl, sleepImpl: noSleep });
  assert.equal(celestrakCalls(again.log), 0);
  assert.equal(second.status.celestrak.requestsThisRun, 0);
  assert.match(second.status.sources.find((source) => source.id === 'stations-supgp').detail, /cooling down/);
});

test('a second consecutive 403 on a later run halts, and halted runs make no CelesTrak request', async () => {
  const h = await harness();
  const first = mockFetch((url) => (url.includes('CATNR=25544') ? { status: 403, body: 'GP data has not updated since your last successful download' } : null));
  await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW, fetchImpl: first.fetchImpl, sleepImpl: noSleep });
  assert.equal(celestrakCalls(first.log), 1);
  const second = mockFetch((url) => (url.includes('celestrak.org') ? { status: 403, body: 'blocked' } : null));
  const halted = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW + 3 * HOUR, fetchImpl: second.fetchImpl, sleepImpl: noSleep });
  assert.equal(celestrakCalls(second.log), 1);
  assert.equal(halted.status.celestrak.halted, true);
  assert.equal(halted.exitCode, 1);
  const third = mockFetch();
  const later = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW + 9 * HOUR, fetchImpl: third.fetchImpl, sleepImpl: noSleep });
  assert.equal(celestrakCalls(third.log), 0);
  assert.equal(later.status.celestrak.halted, true);
  assert.ok(later.status.sources.filter((source) => source.provider === 'celestrak').every((source) => source.status === 'halted'));
  // A human commits haltResetAt; collection resumes.
  h.configs.policy.haltResetAt = new Date(NOW + 10 * HOUR).toISOString();
  const fourth = mockFetch();
  const resumed = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW + 11 * HOUR, fetchImpl: fourth.fetchImpl, sleepImpl: noSleep });
  assert.equal(resumed.status.celestrak.halted, false);
  assert.ok(celestrakCalls(fourth.log) > 0);
});

test('a 404 quarantines the catalog number; it is never requested again until a human reset', async () => {
  const h = await harness();
  const first = mockFetch((url) => (url.includes('gp.php?CATNR=20580&') ? { status: 404, body: 'No GP data found' } : null));
  const result = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW, fetchImpl: first.fetchImpl, sleepImpl: noSleep });
  assert.deepEqual(result.status.celestrak.quarantine.map((entry) => entry.key), ['gp:CATNR=20580']);
  const later = mockFetch();
  const next = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW + 7 * HOUR, fetchImpl: later.fetchImpl, sleepImpl: noSleep });
  assert.ok(later.log.some((url) => url.includes('gp.php?CATNR=25544&')));
  assert.ok(!later.log.some((url) => url.includes('gp.php?CATNR=20580&')));
  assert.equal(next.status.celestrak.countedErrorsThisRun, 0);
  const roster = JSON.parse(await readFile(path.join(h.generatedDir, (JSON.parse(await readFile(path.join(h.generatedDir, 'manifest.json'), 'utf8')).files.find((f) => f.id === 'roster').path)), 'utf8'));
  assert.equal(roster.objects.find((object) => object.noradCatId === 20580).status, 'quarantined');
});

test('a 301 halts at once and a byte-cap breach counts as an error', async () => {
  const h = await harness();
  const moved = mockFetch((url) => (url.includes('CATNR=25544') ? { status: 301, body: '', headers: { location: 'https://celestrak.com/' } } : null));
  const result = await runCollection({ ...h, root: ROOT, env: {}, clock: () => NOW, fetchImpl: moved.fetchImpl, sleepImpl: noSleep });
  assert.equal(result.status.celestrak.halted, true);
  assert.match(result.status.celestrak.haltReason, /301/);
  assert.equal(celestrakCalls(moved.log), 1);

  const h2 = await harness();
  h2.configs.policy.sources.find((source) => source.id === 'roster-gp').maxResponseBytes = 100;
  const big = mockFetch();
  const capped = await runCollection({ ...h2, root: ROOT, env: {}, clock: () => NOW, fetchImpl: big.fetchImpl, sleepImpl: noSleep });
  assert.equal(capped.status.celestrak.countedErrorsThisRun, 1);
  assert.equal(celestrakCalls(big.log), 1);
});
