import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpCsv } from '../scripts/lib/omm.mjs';
import { smokeTest, meanAltitudeKm } from '../scripts/lib/smoke.mjs';
import { summarizeShells, sampleRecords, layerRow, rowRecord } from '../scripts/lib/shells.mjs';
import { fixture, loadRealConfigs, NOW } from './helpers.mjs';

const records = (name, kind = 'gp') => parseGpCsv(fixture(name), { kind, retrievedAtMs: NOW }).map((row) => row.record);

test('SGP4 smoke passes for every captured roster and group object at now and +90 min', async () => {
  const { roster } = await loadRealConfigs();
  for (const { noradCatId } of roster.catnr) {
    const [record] = records(`celestrak/gp-catnr-${noradCatId}.csv`);
    assert.deepEqual(smokeTest(record, NOW, [0, 90]), { ok: true }, `${noradCatId}`);
  }
  for (const group of ['gps-ops', 'galileo', 'glo-ops', 'beidou', 'kuiper']) {
    const failures = records(`celestrak/gp-group-${group}.csv`).filter((record) => !smokeTest(record, NOW, [0, 90]).ok);
    assert.equal(failures.length, 0, group);
  }
});

test('SupGP segments smoke-propagate from their own epochs', () => {
  for (const segment of records('celestrak/raw-supgp-iss-e.csv', 'supgp')) {
    assert.ok(smokeTest(segment, Math.max(NOW, Date.parse(`${segment.EPOCH}Z`)), [0, 90]).ok, segment.OBJECT_NAME);
  }
});

test('SGP4 smoke rejects physically impossible elements', () => {
  const [iss] = records('celestrak/raw-gp-catnr-25544.csv');
  assert.equal(smokeTest({ ...iss, MEAN_MOTION: 16.9, ECCENTRICITY: 0.3 }, NOW).ok, false, 'perigee below the surface');
  assert.equal(smokeTest({ ...iss, MEAN_MOTION: 1.0, ECCENTRICITY: 0.95 }, NOW).ok, false, 'radius beyond 60000 km');
  assert.equal(smokeTest({ ...iss, MEAN_MOTION: 16.5, BSTAR: 0.9, MEAN_MOTION_DOT: 0.4 }, NOW, [4320]).ok, false, 'decays within 72 h');
});

test('shell summaries account for every object and report planes', () => {
  const kuiper = records('celestrak/gp-group-kuiper.csv');
  const bins = { leoCeilingKm: 2000, leoAltitudeKm: 20, highAltitudeKm: 250, inclinationDeg: 1, raanDeg: 5 };
  const shells = summarizeShells(kuiper, bins);
  assert.equal(shells.reduce((sum, shell) => sum + shell.count, 0), kuiper.length);
  for (const shell of shells) {
    assert.equal(shell.planes.reduce((sum, plane) => sum + plane.count, 0), shell.count);
    assert.ok(shell.meanAltitudeKm >= shell.altitudeKmMin && shell.meanAltitudeKm < shell.altitudeKmMax);
    assert.ok(shell.planes.every((plane) => plane.raanDeg >= 0 && plane.raanDeg < 360));
  }
  const gps = summarizeShells(records('celestrak/gp-group-gps-ops.csv'), bins);
  assert.ok(gps.every((shell) => shell.altitudeKmMax - shell.altitudeKmMin === 250));
  assert.ok(Math.abs(meanAltitudeKm(2.0056) - 20180) < 50, 'GPS semi-synchronous altitude');
});

test('the sampled layer keeps catalog numbers divisible by N, stably', () => {
  const kuiper = records('celestrak/gp-group-kuiper.csv');
  const tenth = sampleRecords(kuiper, 10);
  assert.ok(tenth.every((record) => record.NORAD_CAT_ID % 10 === 0));
  assert.ok(tenth.length >= Math.floor(kuiper.length / 10) - 5 && tenth.length <= Math.ceil(kuiper.length / 10) + 5);
  assert.equal(sampleRecords(kuiper, 1).length, kuiper.length);
  const withoutFirst = sampleRecords(kuiper.slice(1), 10).map((record) => record.NORAD_CAT_ID);
  assert.ok(withoutFirst.every((id) => tenth.some((record) => record.NORAD_CAT_ID === id)), 'membership does not shift');
  assert.deepEqual(rowRecord(layerRow(kuiper[0])).NORAD_CAT_ID, kuiper[0].NORAD_CAT_ID);
});
