import test from 'node:test';
import assert from 'node:assert/strict';
import { gpUrl, satcatUrl, supgpUrl, assertRequestAllowed, NeaGuardError, RequestGuardError } from '../scripts/lib/urls.mjs';
import { NEA_DENYLIST, NEA_LAUNCH_DESIGNATORS } from '../scripts/lib/constants.mjs';
import { allRequests } from '../scripts/lib/sources.mjs';
import { validateConfigs } from '../scripts/lib/config.mjs';
import { fetchBounded } from '../scripts/lib/http.mjs';
import { parseSatcatCsv } from '../scripts/lib/omm.mjs';
import { buildSatcatRoster } from '../scripts/lib/builders.mjs';
import { fixture, loadRealConfigs, NOW } from './helpers.mjs';

const EXPECTED = [37348, 39232, 43941, 43866, 63156, 36608, 45860, 56083, 65432];

test('the hard-coded denylist is exactly the nine withheld objects', () => {
  assert.deepEqual([...NEA_DENYLIST], EXPECTED);
  assert.ok(Object.isFrozen(NEA_DENYLIST));
});

test('no GP or SATCAT URL can be built for a withheld catalog number, in any spelling', () => {
  for (const id of EXPECTED) {
    for (const spelling of [id, String(id), `${id}`]) {
      assert.throws(() => gpUrl({ CATNR: spelling }), NeaGuardError);
      assert.throws(() => satcatUrl({ CATNR: spelling }), NeaGuardError);
    }
    for (const sneaky of [`0${id}`, `${id},25544`, `${id} `, `+${id}`, `${id}.0`]) {
      assert.throws(() => gpUrl({ CATNR: sneaky }), RequestGuardError);
      assert.throws(() => satcatUrl({ CATNR: sneaky }), RequestGuardError);
    }
  }
});

test('no INTDES query can name the launch of a withheld object', () => {
  for (const launch of NEA_LAUNCH_DESIGNATORS) {
    assert.throws(() => gpUrl({ INTDES: launch }), NeaGuardError);
    assert.throws(() => satcatUrl({ INTDES: launch }), NeaGuardError);
  }
});

test('the final request check refuses hand-built URLs for withheld objects', () => {
  for (const id of EXPECTED) {
    for (const url of [
      `https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=CSV`,
      `https://celestrak.org/satcat/records.php?CATNR=${id}&FORMAT=CSV`,
      `https://celestrak.org/satcat/records.php?FORMAT=CSV&CATNR=${id}`,
    ]) {
      assert.throws(() => assertRequestAllowed(url), NeaGuardError);
    }
  }
});

test('fetchBounded refuses a withheld URL before any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('x'); };
  await assert.rejects(fetchBounded('https://celestrak.org/NORAD/elements/gp.php?CATNR=37348&FORMAT=CSV', { fetchImpl, userAgent: 't', timeoutMs: 1000, maxBytes: 100 }), NeaGuardError);
  assert.equal(called, false);
});

test('only https://celestrak.org (never .com) and services.swpc.noaa.gov are reachable', () => {
  const refused = [
    'https://celestrak.com/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV',
    'http://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV',
    'https://www.celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV',
    'https://celestrak.org:8443/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV',
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=037348&FORMAT=CSV',
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE',
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544',
    'https://celestrak.org/NORAD/elements/gp.php?NAME=USA&FORMAT=CSV',
    'https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=CSV',
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&CATNR=20580&FORMAT=CSV',
    'https://celestrak.org/NORAD/elements/table.php?CATNR=25544&FORMAT=CSV',
    'https://services.swpc.noaa.gov/products/noaa-scales.json',
    'https://example.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV',
  ];
  for (const url of refused) assert.throws(() => assertRequestAllowed(url), RequestGuardError, url);
  assert.equal(assertRequestAllowed(gpUrl({ CATNR: 25544 })).provider, 'celestrak');
  assert.equal(gpUrl({ CATNR: 100983 }), 'https://celestrak.org/NORAD/elements/gp.php?CATNR=100983&FORMAT=CSV');
  assert.equal(supgpUrl({ SOURCE: 'ISS-E' }), 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=ISS-E&FORMAT=CSV');
});

test('every request the real configuration can build is allowed and names no withheld object', async () => {
  const configs = await loadRealConfigs();
  assert.equal(validateConfigs(configs), true);
  const urls = configs.policy.sources.flatMap((source) => allRequests(source, configs).map((req) => req.url));
  for (const url of urls) {
    assertRequestAllowed(url);
    for (const id of EXPECTED) assert.ok(!new RegExp(`[=,]${id}(?:&|$)`).test(url), `${url} names ${id}`);
  }
  assert.ok(urls.every((url) => !url.includes('celestrak.com')));
});

test('a roster that names a withheld object fails configuration validation', async () => {
  const configs = await loadRealConfigs();
  configs.roster.catnr.push({ noradCatId: 63156 });
  assert.throws(() => validateConfigs(configs), /withheld/);
});

test('withheld rows inside any response are dropped before publication', async () => {
  assert.equal(parseSatcatCsv(fixture('celestrak/satcat-catnr-37348.csv'))[0].record.DATA_STATUS_CODE, 'NEA');
  const configs = await loadRealConfigs();
  const req = { queryKey: 'CATNR=65585', noradCatId: 65585 };
  const leaked = fixture('celestrak/satcat-catnr-65585.csv') + fixture('celestrak/satcat-catnr-37348.csv').split('\r\n')[1] + '\r\n';
  const ctx = { configs, nowIso: new Date(NOW).toISOString(), previousContent: async () => null, previousEntry: () => null };
  const built = await buildSatcatRoster({}, [{ req, outcome: { status: 'ok', body: leaked, retrievedAtMs: NOW, url: 'u' } }], ctx);
  const ids = built.outputs[0].value.records.map((record) => record.NORAD_CAT_ID);
  assert.deepEqual(ids, [65585]);
});
