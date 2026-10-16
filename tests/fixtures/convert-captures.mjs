#!/usr/bin/env node
// Regenerates tests/fixtures/celestrak/*.csv from the 2026-10-15 research captures
// (CelesTrak JSON responses). Maintainer-only; tests read the committed CSV files.
//
// Usage: node tests/fixtures/convert-captures.mjs <research capture folder "sat">
//
// CelesTrak's CSV writes numbers without a leading zero and drag terms in
// exponent form (".1033021E-3"); the converter reproduces that style so the
// parser is tested against it. Synthetic rows (clearly listed in PROVENANCE.json)
// are derived from a captured object by changing only identity fields and the
// mean anomaly.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCsv } from '../../scripts/lib/csv.mjs';
import { GP_HEADER, SATCAT_HEADER } from '../../scripts/lib/constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'celestrak');
const capture = path.resolve(process.argv[2] ?? '');

function plain(value) {
  if (value === 0) return '0';
  const text = String(value);
  return text.replace(/^(-?)0\./, '$1.');
}

function exponent(value) {
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  let power = Math.floor(Math.log10(magnitude)) + 1;
  let mantissa = magnitude / 10 ** power;
  if (mantissa >= 1) { mantissa /= 10; power += 1; }
  const digits = mantissa.toPrecision(8).replace(/0+$/, '').replace(/^0\./, '.');
  return `${sign}${digits}E${power >= 0 ? '+' : '-'}${Math.abs(power)}`;
}

function gpCell(field, value) {
  if (['BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'].includes(field)) return exponent(value);
  if (typeof value === 'number') return plain(value);
  return value ?? '';
}

function satcatCell(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? String(value) : value;
}

const gpCsv = (records) => formatCsv(GP_HEADER, records.map((record) => GP_HEADER.map((field) => gpCell(field, record[field]))));
const satcatCsv = (records) => formatCsv(SATCAT_HEADER, records.map((record) => SATCAT_HEADER.map((field) => satcatCell(record[field]))));
const load = async (relative) => JSON.parse(await readFile(path.join(capture, relative), 'utf8'));

await mkdir(out, { recursive: true });
const write = (name, text) => writeFile(path.join(out, name), text);

for (const group of ['gps-ops', 'galileo', 'glo-ops', 'beidou', 'kuiper']) {
  await write(`gp-group-${group}.csv`, gpCsv(await load(`gp/${group}.json`)));
}
for (const id of [40420, 40699, 44057, 44071, 48808, 54755, 56759, 58582, 63982, 66303, 67335, 67374]) {
  await write(`gp-catnr-${id}.csv`, gpCsv(await load(`gpc/${id}.json`)));
}
// Roster objects captured inside group responses.
const groups = {};
for (const group of ['stations', 'kuiper', 'qianfan', 'hulianwang', 'gps-ops', 'glo-ops', 'galileo', 'beidou', 'sbas', 'weather', 'resource', 'military', 'science']) {
  for (const record of await load(`gp/${group}.json`)) groups[record.NORAD_CAT_ID] = record;
}
for (const id of [25544, 48274, 63724, 60379, 62323, 62339, 57517, 61182, 58654, 62876, 60133, 41836, 54743, 41105, 49260, 60989, 60182, 44804, 48268, 41038, 31797, 100983, 20580, 46114, 42709, 41589, 28899, 65585, 69861, 43873, 51850, 39084, 54234, 43613, 25994, 40115, 33053, 38358, 36395]) {
  await write(`gp-catnr-${id}.csv`, gpCsv([groups[id]]));
}

// Roster objects with no CelesTrak capture (added 2026-10-16): OMM rows converted from the
// Space-Track-derived TLEs on the n2yo pages saved by the US roster research on 2026-10-16.
// Names are the Space-Track catalog names from those pages, unconfirmed against CelesTrak.
const TLE_ROWS = [
  ['SPACEMOBILE-006', '2025-309A',
    '1 67232U 25309A   26288.33475760  .00003015  00000-0  15725-3 0  9992',
    '2 67232  52.9932 141.1105 0011830 136.9725 223.2195 15.19017694 44859'],
  ['AEHF 6 (USA 298)', '2020-022B',
    '1 45465U 20022B   26288.90117128 -.00000299  00000-0  00000-0 0  9996',
    '2 45465   2.3005 303.0979 0043630   9.2686 174.2221  1.00269149 24225'],
  ['VIASAT 3-F1', '2023-060A',
    '1 56370U 23060A   26288.91923147 -.00000184  00000-0  00000-0 0  9998',
    '2 56370   0.0207 251.2099 0000755 343.4049  31.8408  1.00268459 12646'],
  ['JUPITER 3 (ECHOSTAR 24)', '2023-108A',
    '1 57479U 23108A   26288.19856549  .00000000  00000-0  00000-0 0  9999',
    '2 57479   0.0157 193.2220 0001044  15.9924 150.7798  1.00269191 11856'],
  ['SIRIUS XM-9', '2024-234A',
    '1 62259U 24234A   26288.47018134 -.00000204  00000-0  00000-0 0  9990',
    '2 62259   0.0191 307.9118 0004016   5.6528 154.5671  1.00270646  6789'],
];

function tleChecksumOk(line) {
  const sum = [...line.slice(0, 68)].reduce((total, c) => total + (c === '-' ? 1 : /\d/.test(c) ? Number(c) : 0), 0);
  return sum % 10 === Number(line[68]);
}

function tleExponent(field) {
  const text = field.trim();
  const match = /^([+-]?)(\d{5})([+-])(\d)$/.exec(text);
  if (!match) throw new Error(`Bad TLE exponent field ${field}`);
  return Number(`${match[1]}0.${match[2]}e${match[3]}${match[4]}`);
}

function tleToOmm(name, objectId, line1, line2) {
  if (!tleChecksumOk(line1) || !tleChecksumOk(line2)) throw new Error(`TLE checksum failed for ${name}`);
  const year = 2000 + Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  const dayStart = Date.UTC(year, 0, Math.floor(day));
  const microsOfDay = Math.round((day - Math.floor(day)) * 86_400_000_000);
  const seconds = new Date(dayStart + Math.floor(microsOfDay / 1_000_000) * 1000).toISOString().slice(0, 19);
  const epoch = `${seconds}.${String(microsOfDay % 1_000_000).padStart(6, '0')}`;
  return {
    OBJECT_NAME: name,
    OBJECT_ID: objectId,
    EPOCH: epoch,
    MEAN_MOTION: Number(line2.slice(52, 63)),
    ECCENTRICITY: Number(`0.${line2.slice(26, 33).trim()}`),
    INCLINATION: Number(line2.slice(8, 16)),
    RA_OF_ASC_NODE: Number(line2.slice(17, 25)),
    ARG_OF_PERICENTER: Number(line2.slice(34, 42)),
    MEAN_ANOMALY: Number(line2.slice(43, 51)),
    EPHEMERIS_TYPE: Number(line1[62]),
    CLASSIFICATION_TYPE: line1[7],
    NORAD_CAT_ID: Number(line1.slice(2, 7)),
    ELEMENT_SET_NO: Number(line1.slice(64, 68)),
    REV_AT_EPOCH: Number(line2.slice(63, 68)),
    BSTAR: tleExponent(line1.slice(53, 61)),
    MEAN_MOTION_DOT: Number(line1.slice(33, 43)),
    MEAN_MOTION_DDOT: tleExponent(line1.slice(44, 52)),
  };
}

for (const [name, objectId, line1, line2] of TLE_ROWS) {
  const record = tleToOmm(name, objectId, line1, line2);
  await write(`gp-catnr-${record.NORAD_CAT_ID}.csv`, gpCsv([record]));
}

// Synthetic INTDES responses built from the captured SCS-01 A and AETHER-3 elements.
const scs = (await load('gpc/63982.json'))[0];
const scsRows = 'ABCDEFGHJKLM'.split('').map((letter, index) => ({
  ...scs, OBJECT_NAME: `SCS-01 ${letter}`, OBJECT_ID: `2025-100${letter}`, NORAD_CAT_ID: 63982 + index, MEAN_ANOMALY: Number(((scs.MEAN_ANOMALY + index * 30) % 360).toFixed(4)),
}));
await write('gp-intdes-2025-100.csv', gpCsv(scsRows));
const aether = (await load('gpc/67374.json'))[0];
const satcat2026 = await load('q/i26_004.json');
const letters = new Map(satcat2026.map((record) => [record.NORAD_CAT_ID, record]));
const aetherRows = satcat2026.filter((record) => record.NORAD_CAT_ID >= 67371 && record.NORAD_CAT_ID <= 67385).map((record, index) => ({
  ...aether, OBJECT_NAME: letters.get(record.NORAD_CAT_ID).OBJECT_NAME, OBJECT_ID: record.OBJECT_ID, NORAD_CAT_ID: record.NORAD_CAT_ID, MEAN_ANOMALY: Number(((aether.MEAN_ANOMALY + index * 24) % 360).toFixed(4)),
}));
await write('gp-intdes-2026-004.csv', gpCsv(aetherRows));

// SATCAT captures.
await write('satcat-group-gps-ops.csv', satcatCsv(await load('satcat/gps-ops.json')));
await write('satcat-group-kuiper.csv', satcatCsv(await load('satcat/kuiper.json')));
await write('satcat-intdes-2025-100.csv', satcatCsv(await load('intdes_100.json')));
await write('satcat-intdes-2026-004.csv', satcatCsv(satcat2026));
const satcatAll = {};
for (const file of ['satcat/stations.json', 'satcat/military.json', 'satcat/sbas.json', 'satcat/kuiper.json', 'q/1.json', 'q/5.json']) {
  for (const record of await load(file)) satcatAll[record.NORAD_CAT_ID] = record;
}
for (const id of [25544, 65585, 63724, 66303, 37348]) await write(`satcat-catnr-${id}.csv`, satcatCsv([satcatAll[id]]));
console.log('Fixtures regenerated.');
