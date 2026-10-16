// Header lock, typed conversion and range checks for CelesTrak GP, SupGP and SATCAT CSV.
import { parseCsv } from './csv.mjs';
import { GP_HEADER, SUPGP_HEADER, SATCAT_HEADER, MINUTE, DAY } from './constants.mjs';

export class SchemaError extends Error {
  constructor(message) { super(message); this.name = 'SchemaError'; }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
export const OBJECT_ID = /^\d{4}-\d{3}[A-HJ-NP-Z]{1,3}$/;
const EPOCH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const GP_NUMBERS = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const GP_INTEGERS = ['EPHEMERIS_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH'];
const SATCAT_NUMBERS = ['PERIOD', 'INCLINATION', 'APOGEE', 'PERIGEE', 'RCS'];

export const GP_LIMITS = Object.freeze({
  gpFutureMs: 5 * MINUTE,
  supgpFutureMs: 15 * DAY,
  staleMs: 30 * DAY,
});

export function lockHeader(header, expected, label) {
  if (header.length !== expected.length || header.some((name, index) => name !== expected[index])) {
    throw new SchemaError(`${label} CSV header changed: ${header.join(',').slice(0, 400)}`);
  }
}

export function epochMs(epoch) {
  if (typeof epoch !== 'string' || !EPOCH.test(epoch)) return Number.NaN;
  return Date.parse(`${epoch}Z`);
}

function convertGpRow(header, row) {
  const record = {};
  const reasons = [];
  header.forEach((name, index) => {
    const raw = row[index];
    if (GP_NUMBERS.includes(name) || name === 'RMS') {
      if (!NUMBER.test(raw)) { reasons.push(`${name} is not a number`); record[name] = null; return; }
      record[name] = Number(raw);
    } else if (GP_INTEGERS.includes(name)) {
      if (!INTEGER.test(raw)) { reasons.push(`${name} is not an integer`); record[name] = null; return; }
      record[name] = Number(raw);
    } else {
      record[name] = raw;
    }
  });
  return { record, reasons };
}

// Range checks shared by GP and SupGP records. Returns a list of reasons (empty when valid).
export function gpRangeProblems(record, { retrievedAtMs, kind = 'gp' }) {
  const reasons = [];
  const n = record.NORAD_CAT_ID;
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) reasons.push('NORAD_CAT_ID out of range');
  if (typeof record.OBJECT_NAME !== 'string' || !record.OBJECT_NAME.trim() || record.OBJECT_NAME.length > 80 || /[\u0000-\u001f]/.test(record.OBJECT_NAME)) reasons.push('OBJECT_NAME invalid');
  if (!OBJECT_ID.test(record.OBJECT_ID ?? '')) reasons.push('OBJECT_ID invalid');
  if (!/^[A-Z]$/.test(record.CLASSIFICATION_TYPE ?? '')) reasons.push('CLASSIFICATION_TYPE invalid');
  if (!Number.isInteger(record.EPHEMERIS_TYPE) || record.EPHEMERIS_TYPE < 0 || record.EPHEMERIS_TYPE > 9) reasons.push('EPHEMERIS_TYPE out of range');
  if (!Number.isInteger(record.ELEMENT_SET_NO) || record.ELEMENT_SET_NO < 0) reasons.push('ELEMENT_SET_NO out of range');
  if (!Number.isInteger(record.REV_AT_EPOCH) || record.REV_AT_EPOCH < 0) reasons.push('REV_AT_EPOCH out of range');
  const e = record.ECCENTRICITY;
  if (!(e >= 0 && e < 1)) reasons.push('ECCENTRICITY out of range');
  if (!(record.INCLINATION >= 0 && record.INCLINATION <= 180)) reasons.push('INCLINATION out of range');
  for (const angle of ['RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY']) {
    if (!(record[angle] >= 0 && record[angle] < 360)) reasons.push(`${angle} out of range`);
  }
  if (!(record.MEAN_MOTION > 0.9 && record.MEAN_MOTION < 17.5)) reasons.push('MEAN_MOTION out of range');
  if (!(Math.abs(record.BSTAR) < 1)) reasons.push('BSTAR out of range');
  for (const drag of ['MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']) {
    if (!Number.isFinite(record[drag])) reasons.push(`${drag} not finite`);
  }
  const t = epochMs(record.EPOCH);
  if (!Number.isFinite(t)) {
    reasons.push('EPOCH invalid');
  } else {
    const future = kind === 'supgp' ? GP_LIMITS.supgpFutureMs : GP_LIMITS.gpFutureMs;
    if (t > retrievedAtMs + future) reasons.push('EPOCH in the future');
  }
  if (kind === 'supgp' && !(record.RMS >= 0 && Number.isFinite(record.RMS))) reasons.push('RMS invalid');
  return reasons;
}

// Parses a complete GP or SupGP CSV body. Throws SchemaError on a header change;
// returns every row with its conversion and range problems.
export function parseGpCsv(text, { kind = 'gp', retrievedAtMs }) {
  const { header, rows } = parseCsv(text);
  lockHeader(header, kind === 'supgp' ? SUPGP_HEADER : GP_HEADER, kind === 'supgp' ? 'SupGP' : 'GP');
  return rows.map((row) => {
    const { record, reasons } = convertGpRow(header, row);
    return { record, reasons: reasons.length ? reasons : gpRangeProblems(record, { retrievedAtMs, kind }) };
  });
}

export function isStale(record, retrievedAtMs) {
  return epochMs(record.EPOCH) < retrievedAtMs - GP_LIMITS.staleMs;
}

const OBJECT_TYPES = new Set(['PAY', 'R/B', 'DEB', 'UNK']);
const OPS_CODES = new Set(['+', '-', 'P', 'B', 'S', 'X', 'D', '?', '']);
const DATA_STATUS = new Set(['', 'NCE', 'NIE', 'NEA']);
const ORBIT_TYPES = new Set(['ORB', 'LAN', 'IMP', 'DOC', 'R/T']);

export function parseSatcatCsv(text) {
  const { header, rows } = parseCsv(text);
  lockHeader(header, SATCAT_HEADER, 'SATCAT');
  return rows.map((row) => {
    const record = {};
    const reasons = [];
    header.forEach((name, index) => {
      const raw = row[index];
      if (name === 'NORAD_CAT_ID') {
        record[name] = INTEGER.test(raw) ? Number(raw) : null;
      } else if (SATCAT_NUMBERS.includes(name)) {
        if (raw === '') record[name] = null;
        else if (NUMBER.test(raw)) record[name] = Number(raw);
        else { record[name] = null; reasons.push(`${name} is not a number`); }
      } else {
        record[name] = raw;
      }
    });
    const n = record.NORAD_CAT_ID;
    if (!Number.isInteger(n) || n < 1 || n > 999_999_999) reasons.push('NORAD_CAT_ID out of range');
    if (!record.OBJECT_NAME.trim() || record.OBJECT_NAME.length > 80) reasons.push('OBJECT_NAME invalid');
    if (!OBJECT_ID.test(record.OBJECT_ID)) reasons.push('OBJECT_ID invalid');
    if (!OBJECT_TYPES.has(record.OBJECT_TYPE)) reasons.push('OBJECT_TYPE invalid');
    if (!OPS_CODES.has(record.OPS_STATUS_CODE)) reasons.push('OPS_STATUS_CODE invalid');
    if (!/^[A-Z0-9/]{1,8}$/.test(record.OWNER)) reasons.push('OWNER invalid');
    if (!DATE.test(record.LAUNCH_DATE) || Number.isNaN(Date.parse(record.LAUNCH_DATE))) reasons.push('LAUNCH_DATE invalid');
    if (!/^[A-Z0-9]{0,8}$/.test(record.LAUNCH_SITE)) reasons.push('LAUNCH_SITE invalid');
    if (record.DECAY_DATE !== '' && !DATE.test(record.DECAY_DATE)) reasons.push('DECAY_DATE invalid');
    if (!DATA_STATUS.has(record.DATA_STATUS_CODE)) reasons.push('DATA_STATUS_CODE invalid');
    if (!/^[A-Z0-9]{1,9}$/.test(record.ORBIT_CENTER)) reasons.push('ORBIT_CENTER invalid');
    if (!ORBIT_TYPES.has(record.ORBIT_TYPE)) reasons.push('ORBIT_TYPE invalid');
    if (record.INCLINATION !== null && !(record.INCLINATION >= 0 && record.INCLINATION <= 180)) reasons.push('INCLINATION out of range');
    return { record, reasons };
  });
}

// Count-drop rule: a refresh is rejected when its object count falls more than
// 10 percent (or 5 objects for 50 or fewer) or grows beyond 1.5x + 500.
export function countDropProblem(previousCount, nextCount) {
  if (!Number.isInteger(nextCount) || nextCount <= 0) return 'no valid objects';
  if (!Number.isInteger(previousCount) || previousCount <= 0) return null;
  const floor = previousCount <= 50 ? previousCount - 5 : Math.ceil(0.9 * previousCount);
  if (nextCount < floor) return `count dropped from ${previousCount} to ${nextCount}`;
  if (nextCount > 1.5 * previousCount + 500) return `count jumped from ${previousCount} to ${nextCount}`;
  return null;
}
