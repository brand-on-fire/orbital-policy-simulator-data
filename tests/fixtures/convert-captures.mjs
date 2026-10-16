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
for (const id of [25544, 48274, 63724, 60379, 62323, 62339, 57517, 61182, 58654, 62876, 60133, 41836, 54743, 41105, 49260, 60989, 60182, 44804, 48268, 41038, 31797, 100983, 20580, 46114, 42709, 41589, 28899, 65585]) {
  await write(`gp-catnr-${id}.csv`, gpCsv([groups[id]]));
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
