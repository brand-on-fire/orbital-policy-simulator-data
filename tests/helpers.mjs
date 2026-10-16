// Shared offline test helpers: fixtures, a URL-routed mock fetch and temp dirs.
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, formatCsv } from '../scripts/lib/csv.mjs';
import { SATCAT_HEADER } from '../scripts/lib/constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const FIXTURES = path.join(here, 'fixtures');
export const NOW = Date.parse('2026-10-16T01:00:00Z');

export const fixture = (relative) => readFileSync(path.join(FIXTURES, relative), 'utf8');
export const fixtureExists = (relative) => existsSync(path.join(FIXTURES, relative));

export async function tempDir(prefix = 'orbital-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function loadRealConfigs() {
  const read = async (name) => JSON.parse(await readFile(path.join(ROOT, 'config', name), 'utf8'));
  return { policy: await read('collection-policy.json'), roster: await read('roster.json'), layers: await read('layers.json') };
}

// Real configuration with the layer groups reduced to those captured in fixtures.
export async function testConfigs({ groups = ['gps-ops', 'galileo', 'glo-ops', 'beidou', 'kuiper'], kuiperEvery = 10 } = {}) {
  const configs = await loadRealConfigs();
  configs.layers.groups = configs.layers.groups
    .filter((entry) => groups.includes(entry.group))
    .map((entry) => (entry.group === 'kuiper' ? { ...entry, sampleEvery: kuiperEvery } : entry));
  configs.policy.sources = configs.policy.sources.filter((source) => source.kind !== 'layer' || groups.includes(source.group));
  return configs;
}

// SYNTHETIC: Tiangong SupGP built from the real ISS-E capture (identity fields only).
export function cssSupgp() {
  return fixture('celestrak/raw-supgp-iss-e.csv')
    .replaceAll('ISS [Segment', 'CSS [Segment')
    .replaceAll(',1998-067A,', ',2021-035A,')
    .replaceAll(',25544,', ',48274,')
    .replaceAll(',ISS-E\r\n', ',CSS-E\r\n');
}

// SYNTHETIC: a SATCAT row derived from a GP fixture when no SATCAT capture exists.
function satcatFromGp(gpCsv) {
  const { header, rows } = parseCsv(gpCsv);
  const at = (row, name) => row[header.indexOf(name)];
  return formatCsv(SATCAT_HEADER, rows.map((row) => SATCAT_HEADER.map((field) => ({
    OBJECT_NAME: at(row, 'OBJECT_NAME'), OBJECT_ID: at(row, 'OBJECT_ID'), NORAD_CAT_ID: at(row, 'NORAD_CAT_ID'),
    OBJECT_TYPE: 'PAY', OPS_STATUS_CODE: '+', OWNER: 'TBD', LAUNCH_DATE: `${at(row, 'OBJECT_ID').slice(0, 4)}-01-01`, LAUNCH_SITE: 'AFETR',
    DECAY_DATE: '', PERIOD: '', INCLINATION: at(row, 'INCLINATION'), APOGEE: '', PERIGEE: '', RCS: '', DATA_STATUS_CODE: '', ORBIT_CENTER: 'EA', ORBIT_TYPE: 'ORB',
  })[field])));
}

export function defaultRoute(url) {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams.entries());
  if (u.hostname === 'services.swpc.noaa.gov') {
    const file = {
      '/products/noaa-planetary-k-index.json': 'swpc/noaa-planetary-k-index.json',
      '/json/f107_cm_flux.json': 'swpc/f107_cm_flux.json',
      '/json/solar-cycle/predicted-solar-cycle.json': 'swpc/predicted-solar-cycle.json',
    }[u.pathname];
    return file ? { status: 200, body: fixture(file) } : null;
  }
  if (u.pathname === '/NORAD/elements/gp.php') {
    if (q.CATNR) return { status: 200, body: fixture(`celestrak/gp-catnr-${q.CATNR}.csv`) };
    if (q.INTDES) return { status: 200, body: fixture(`celestrak/gp-intdes-${q.INTDES}.csv`) };
    if (q.GROUP) return { status: 200, body: fixture(`celestrak/gp-group-${q.GROUP}.csv`) };
  }
  if (u.pathname === '/NORAD/elements/supplemental/sup-gp.php') {
    if (q.SOURCE === 'ISS-E') return { status: 200, body: fixture('celestrak/raw-supgp-iss-e.csv') };
    if (q.SOURCE === 'CSS-E') return { status: 200, body: cssSupgp() };
  }
  if (u.pathname === '/satcat/records.php') {
    if (q.CATNR) {
      const name = `celestrak/satcat-catnr-${q.CATNR}.csv`;
      return { status: 200, body: fixtureExists(name) ? fixture(name) : satcatFromGp(fixture(`celestrak/gp-catnr-${q.CATNR}.csv`)) };
    }
    if (q.INTDES) return { status: 200, body: fixture(`celestrak/satcat-intdes-${q.INTDES}.csv`) };
    if (q.GROUP) {
      const name = `celestrak/satcat-group-${q.GROUP}.csv`;
      return { status: 200, body: fixtureExists(name) ? fixture(name) : satcatFromGp(fixture(`celestrak/gp-group-${q.GROUP}.csv`)) };
    }
  }
  return null;
}

// A fetch stand-in. `override(url, count)` may return {status, body} or {throw}.
export function mockFetch(override = () => null) {
  const log = [];
  const fetchImpl = async (url) => {
    log.push(url);
    const routed = override(url, log.length) ?? defaultRoute(url);
    if (!routed) { log.unknown = (log.unknown ?? 0) + 1; return new Response('unrouted test URL', { status: 418 }); }
    if (routed.throw) throw routed.throw;
    return new Response(routed.body, { status: routed.status, headers: routed.headers ?? {} });
  };
  return { fetchImpl, log };
}

export const noSleep = async () => {};
export const fixedClock = (ms) => () => ms;
