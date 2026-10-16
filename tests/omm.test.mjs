import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpCsv, parseSatcatCsv, lockHeader, SchemaError, gpRangeProblems, countDropProblem, isStale } from '../scripts/lib/omm.mjs';
import { GP_HEADER, SUPGP_HEADER, SATCAT_HEADER } from '../scripts/lib/constants.mjs';
import { fixture, NOW } from './helpers.mjs';

const ISS = () => parseGpCsv(fixture('celestrak/raw-gp-catnr-25544.csv'), { retrievedAtMs: NOW })[0].record;

test('GP header lock accepts exactly the CelesTrak OMM header', () => {
  assert.doesNotThrow(() => lockHeader([...GP_HEADER], GP_HEADER, 'GP'));
});

test('GP header lock rejects reordered, missing, extra or renamed columns', () => {
  const variants = [
    [GP_HEADER[1], GP_HEADER[0], ...GP_HEADER.slice(2)],
    GP_HEADER.slice(0, -1),
    [...GP_HEADER, 'EXTRA'],
    GP_HEADER.map((name) => (name === 'BSTAR' ? 'B_STAR' : name)),
    GP_HEADER.map((name) => name.toLowerCase()),
  ];
  for (const header of variants) assert.throws(() => lockHeader(header, GP_HEADER, 'GP'), SchemaError);
  const csv = fixture('celestrak/raw-gp-catnr-25544.csv').replace('OBJECT_NAME,OBJECT_ID', 'OBJECT_ID,OBJECT_NAME');
  assert.throws(() => parseGpCsv(csv, { retrievedAtMs: NOW }), SchemaError);
});

test('SupGP and SATCAT headers are locked separately', () => {
  assert.throws(() => parseGpCsv(fixture('celestrak/raw-supgp-iss-e.csv'), { kind: 'gp', retrievedAtMs: NOW }), SchemaError);
  assert.equal(parseGpCsv(fixture('celestrak/raw-supgp-iss-e.csv'), { kind: 'supgp', retrievedAtMs: NOW }).length, 60);
  assert.throws(() => parseSatcatCsv(fixture('celestrak/gp-catnr-25544.csv')), SchemaError);
  assert.deepEqual(SUPGP_HEADER.slice(0, 17), [...GP_HEADER]);
  assert.equal(SATCAT_HEADER.length, 17);
});

test('converts CelesTrak number style to numbers', () => {
  const iss = ISS();
  assert.equal(iss.ECCENTRICITY, 0.00066468);
  assert.equal(iss.BSTAR, 0.0001033021);
  assert.equal(iss.MEAN_MOTION_DOT, 0.00005222);
  assert.equal(iss.NORAD_CAT_ID, 25544);
  assert.deepEqual(gpRangeProblems(iss, { retrievedAtMs: NOW }), []);
});

test('accepts the large negative BSTAR of an orbit-raising satellite (QIANFAN-232)', () => {
  const [row] = parseGpCsv(fixture('celestrak/gp-catnr-69861.csv'), { retrievedAtMs: NOW });
  assert.ok(row.record.BSTAR < -3);
  assert.deepEqual(row.reasons, []);
});

test('accepts 6-digit catalog numbers', () => {
  const [row] = parseGpCsv(fixture('celestrak/gp-catnr-100983.csv'), { retrievedAtMs: NOW });
  assert.equal(row.record.NORAD_CAT_ID, 100983);
  assert.deepEqual(row.reasons, []);
});

test('range checks reject every out-of-range field', () => {
  const cases = {
    NORAD_CAT_ID: [0, 1_000_000_000, 1.5],
    ECCENTRICITY: [-0.1, 1, 1.2],
    INCLINATION: [-1, 180.01],
    RA_OF_ASC_NODE: [-0.001, 360],
    ARG_OF_PERICENTER: [360.5],
    MEAN_ANOMALY: [-5],
    MEAN_MOTION: [0.9, 17.5, 20],
    BSTAR: [10, -12.5, 1e6],
    OBJECT_ID: ['1998-67A', '1998-067', '1998-067I', '1998-067O', 'XXXX-067A'],
    EPOCH: ['2026-10-15 11:59:01', '2026-10-15T11:59:01Z', 'not a date'],
    CLASSIFICATION_TYPE: ['', 'UU'],
  };
  for (const [field, values] of Object.entries(cases)) {
    for (const value of values) {
      const reasons = gpRangeProblems({ ...ISS(), [field]: value }, { retrievedAtMs: NOW });
      assert.ok(reasons.length > 0, `${field}=${value} should be rejected`);
    }
  }
});

test('epoch sanity: GP may not be more than 5 minutes ahead; SupGP up to 15 days', () => {
  const iss = ISS();
  const t = Date.parse(`${iss.EPOCH}Z`);
  assert.deepEqual(gpRangeProblems(iss, { retrievedAtMs: t - 4 * 60_000 }), []);
  assert.ok(gpRangeProblems(iss, { retrievedAtMs: t - 6 * 60_000 }).includes('EPOCH in the future'));
  const segments = parseGpCsv(fixture('celestrak/raw-supgp-iss-e.csv'), { kind: 'supgp', retrievedAtMs: NOW });
  assert.ok(segments.every((segment) => segment.reasons.length === 0));
  const tooEarly = parseGpCsv(fixture('celestrak/raw-supgp-iss-e.csv'), { kind: 'supgp', retrievedAtMs: Date.parse('2026-10-10T00:00:00Z') });
  assert.ok(tooEarly.some((segment) => segment.reasons.includes('EPOCH in the future')));
});

test('elements older than 30 days are stale', () => {
  const iss = ISS();
  const t = Date.parse(`${iss.EPOCH}Z`);
  assert.equal(isStale(iss, t + 29 * 86_400_000), false);
  assert.equal(isStale(iss, t + 31 * 86_400_000), true);
});

test('non-numeric values are reported, not coerced', () => {
  const csv = fixture('celestrak/raw-gp-catnr-25544.csv').replace(',15.48874993,', ',fast,');
  const [row] = parseGpCsv(csv, { retrievedAtMs: NOW });
  assert.ok(row.reasons.includes('MEAN_MOTION is not a number'));
});

test('count-drop rule', () => {
  assert.equal(countDropProblem(null, 391), null);
  assert.equal(countDropProblem(391, 352), null);
  assert.match(countDropProblem(391, 351), /dropped/);
  assert.equal(countDropProblem(32, 27), null);
  assert.match(countDropProblem(32, 26), /dropped/);
  assert.equal(countDropProblem(391, 1086), null);
  assert.match(countDropProblem(391, 1087), /jumped/);
  assert.match(countDropProblem(10, 0), /no valid objects/);
  assert.match(countDropProblem(null, 0), /no valid objects/);
});

test('SATCAT rows parse with nulls for empty numeric fields and validate codes', () => {
  const rows = parseSatcatCsv(fixture('celestrak/satcat-group-gps-ops.csv'));
  assert.equal(rows.length, 32);
  assert.ok(rows.every((row) => row.reasons.length === 0));
  const kuiper = parseSatcatCsv(fixture('celestrak/satcat-group-kuiper.csv'));
  assert.equal(kuiper[0].record.RCS, null);
  const broken = fixture('celestrak/satcat-catnr-25544.csv').replace(',PAY,', ',SATELLITE,');
  assert.ok(parseSatcatCsv(broken)[0].reasons.includes('OBJECT_TYPE invalid'));
});
