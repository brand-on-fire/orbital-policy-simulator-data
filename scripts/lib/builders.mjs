// Turns validated responses into publication files. Every builder keeps the last
// good data for anything that failed: a failed request, an invalid record, an
// epoch regression or a count drop never replaces previously published data.
import { parseGpCsv, parseSatcatCsv, SchemaError, epochMs, isStale, countDropProblem } from './omm.mjs';
import { smokeTest } from './smoke.mjs';
import { summarizeShells, sampleRecords, layerRow, rowRecord } from './shells.mjs';
import { isWithheld } from './urls.mjs';
import { GP_CITATION, SWPC_CITATION, LAYER_FIELDS, SATCAT_LAYER_FIELDS, MINUTE } from './constants.mjs';

const iso = (ms) => new Date(ms).toISOString();
const DECAY_CHECK_MINUTES = 72 * 60;

function failureReason(outcome) {
  if (outcome.status === 'skipped') return outcome.reason;
  return `${outcome.label}${outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ''}`;
}

function epochRange(records) {
  const epochs = records.map((record) => record.EPOCH).filter(Boolean).sort();
  return epochs.length ? { oldestEpoch: epochs[0], newestEpoch: epochs.at(-1) } : {};
}

function summarizeReport(updated, retained, schemaChanged, extra = {}) {
  const status = updated === 0 ? 'failed' : retained > 0 || schemaChanged ? 'partial' : 'healthy';
  return { status, updated, retained, ...(schemaChanged ? { schemaChanged } : {}), ...extra };
}

// Roster: one CATNR request per object plus INTDES requests filtered to payloads.
export async function buildRoster(source, results, ctx) {
  const previous = await ctx.previousContent('roster');
  const prevById = new Map((previous?.objects ?? []).map((object) => [object.noradCatId, object]));
  const objects = new Map();
  const notes = [];
  let schemaChanged = null;
  let updated = 0;
  let retained = 0;
  let newestRetrieval = 0;
  const urls = [];

  const retain = (noradCatId, reason, { status, group } = {}) => {
    const prev = prevById.get(noradCatId);
    objects.set(noradCatId, prev
      ? { ...prev, status: status ?? 'retained', flags: [reason] }
      : { noradCatId, status: status ?? 'unavailable', retrievedAt: null, flags: [reason], omm: null, ...(group ? { group } : {}) });
    retained += 1;
  };
  const accept = (record, retrievedAtMs, group) => {
    const id = record.NORAD_CAT_ID;
    const prev = prevById.get(id);
    const smoke = smokeTest(record, retrievedAtMs, [0, 90]);
    if (!smoke.ok) return retain(id, `smoke: ${smoke.reason}`, { group });
    if (prev?.omm && epochMs(record.EPOCH) < epochMs(prev.omm.EPOCH)) return retain(id, 'epoch-regression: kept the newer published elements', { group });
    let status = 'current';
    if (isStale(record, retrievedAtMs)) status = 'stale-elements';
    else if (!smokeTest(record, retrievedAtMs, [DECAY_CHECK_MINUTES]).ok) status = 'decaying';
    objects.set(id, { noradCatId: id, status, retrievedAt: iso(retrievedAtMs), flags: [], ...(group ? { group } : {}), omm: record });
    updated += 1;
    newestRetrieval = Math.max(newestRetrieval, retrievedAtMs);
    return undefined;
  };

  for (const { req, outcome } of results) {
    if (outcome.url) urls.push(outcome.url);
    if (req.noradCatId !== undefined) {
      const id = req.noradCatId;
      if (outcome.status === 'no-data') { retain(id, 'no GP data found; quarantined', { status: 'quarantined' }); continue; }
      if (outcome.status !== 'ok') { retain(id, failureReason(outcome)); continue; }
      if (schemaChanged) { retain(id, 'schema changed'); continue; }
      let rows;
      try { rows = parseGpCsv(outcome.body, { kind: 'gp', retrievedAtMs: outcome.retrievedAtMs }); } catch (error) {
        if (error instanceof SchemaError) schemaChanged = error.message;
        retain(id, error.message.slice(0, 200));
        continue;
      }
      if (rows.length !== 1 || rows[0].record.NORAD_CAT_ID !== id) { retain(id, `expected exactly one row for ${id}, got ${rows.length}`); continue; }
      if (rows[0].reasons.length) { retain(id, `invalid: ${rows[0].reasons.join('; ')}`); continue; }
      accept(rows[0].record, outcome.retrievedAtMs);
    } else {
      const { intdes, namePattern, expectedCount } = req.intdes;
      const group = `intdes:${intdes}`;
      const prevMembers = [...prevById.values()].filter((object) => object.group === group);
      const retainGroup = (reason) => { for (const object of prevMembers) retain(object.noradCatId, reason, { group }); };
      if (outcome.status !== 'ok' || schemaChanged) { retainGroup(schemaChanged ? 'schema changed' : failureReason(outcome)); continue; }
      let rows;
      try { rows = parseGpCsv(outcome.body, { kind: 'gp', retrievedAtMs: outcome.retrievedAtMs }); } catch (error) {
        if (error instanceof SchemaError) schemaChanged = error.message;
        retainGroup(error.message.slice(0, 200));
        continue;
      }
      const pattern = new RegExp(namePattern);
      const members = rows.filter(({ record }) => typeof record.OBJECT_ID === 'string' && record.OBJECT_ID.startsWith(`${intdes}`)
        && pattern.test(record.OBJECT_NAME) && !isWithheld(record.NORAD_CAT_ID));
      const baseline = prevMembers.filter((object) => object.omm).length || expectedCount;
      const problem = countDropProblem(baseline, members.length);
      if (problem) { retainGroup(`count-drop: ${problem}`); notes.push(`${group} rejected: ${problem}`); continue; }
      for (const { record, reasons } of members) {
        if (reasons.length) retain(record.NORAD_CAT_ID, `invalid: ${reasons.join('; ')}`, { group });
        else accept(record, outcome.retrievedAtMs, group);
      }
      for (const object of prevMembers) if (!objects.has(object.noradCatId)) retain(object.noradCatId, `missing from ${group} response`, { group });
    }
  }
  // A backfill requests only new catalog numbers; everything else stays as published.
  const backfill = ctx.mode === 'backfill';
  for (const entry of ctx.configs.roster.catnr) {
    if (objects.has(entry.noradCatId)) continue;
    if (backfill && prevById.has(entry.noradCatId)) objects.set(entry.noradCatId, prevById.get(entry.noradCatId));
    else retain(entry.noradCatId, 'quarantined: not requested until a human resets it', { status: 'quarantined' });
  }
  for (const object of prevById.values()) {
    if (!object.group || objects.has(object.noradCatId)) continue;
    if (backfill) objects.set(object.noradCatId, object);
    else retain(object.noradCatId, 'INTDES query not requested this run', { group: object.group });
  }

  const report = summarizeReport(updated, retained, schemaChanged, { detail: notes.join('; ') || undefined });
  if (updated === 0) return { outputs: [], report };
  const sorted = [...objects.values()].sort((a, b) => a.noradCatId - b.noradCatId);
  const withElements = sorted.filter((object) => object.omm);
  report.objectCount = withElements.length;
  return {
    report,
    outputs: [{
      id: 'roster',
      directory: 'roster',
      value: { schemaVersion: 1, kind: 'roster', generatedAt: ctx.nowIso, citation: GP_CITATION, objects: sorted },
      meta: { objectCount: withElements.length, retrievedAt: iso(newestRetrieval), ...epochRange(withElements.map((object) => object.omm)), sources: urls },
    }],
  };
}

// ISS and Tiangong SupGP: multi-epoch 6-hour segments fitted forward from now.
export async function buildStations(source, results, ctx) {
  const previous = await ctx.previousContent('stations');
  const blocks = new Map((previous?.stations ?? []).map((block) => [block.source, block]));
  let updated = 0;
  let retained = 0;
  let schemaChanged = null;
  let newestRetrieval = 0;
  const notes = [];
  const urls = [];
  for (const { req, outcome } of results) {
    const { source: supSource, noradCatId } = req.station;
    if (outcome.url) urls.push(outcome.url);
    const keep = (reason) => {
      retained += 1;
      notes.push(`${supSource}: ${reason}`);
      const prev = blocks.get(supSource);
      if (prev) blocks.set(supSource, { ...prev, status: 'retained', flags: [reason] });
    };
    if (outcome.status !== 'ok') { keep(failureReason(outcome)); continue; }
    let rows;
    try { rows = parseGpCsv(outcome.body, { kind: 'supgp', retrievedAtMs: outcome.retrievedAtMs }); } catch (error) {
      if (error instanceof SchemaError) schemaChanged = error.message;
      keep(error.message.slice(0, 200));
      continue;
    }
    const problems = [];
    if (rows.length < 4) problems.push(`only ${rows.length} segments`);
    rows.forEach(({ record, reasons }, index) => {
      if (reasons.length) problems.push(`segment ${index + 1}: ${reasons.join('; ')}`);
      if (record.NORAD_CAT_ID !== noradCatId) problems.push(`segment ${index + 1} is catalog ${record.NORAD_CAT_ID}`);
      if (record.DATA_SOURCE !== supSource) problems.push(`segment ${index + 1} source ${record.DATA_SOURCE}`);
      if (index > 0 && !(epochMs(record.EPOCH) > epochMs(rows[index - 1].record.EPOCH))) problems.push(`segment ${index + 1} epoch not increasing`);
      if (!reasons.length) {
        const smoke = smokeTest(record, Math.max(outcome.retrievedAtMs, epochMs(record.EPOCH)), [0, 90]);
        if (!smoke.ok) problems.push(`segment ${index + 1} smoke: ${smoke.reason}`);
      }
    });
    const prev = blocks.get(supSource);
    if (!problems.length && prev?.segments?.length && epochMs(rows.at(-1).record.EPOCH) < epochMs(prev.segments.at(-1).EPOCH)) {
      problems.push('epoch-regression: newest segment is older than the published one');
    }
    if (problems.length) { keep(`rejected: ${problems.slice(0, 3).join('; ')}`); continue; }
    const segments = rows.map(({ record }) => record);
    blocks.set(supSource, { source: supSource, noradCatId, status: 'current', flags: [], retrievedAt: iso(outcome.retrievedAtMs), url: outcome.url, segments });
    updated += 1;
    newestRetrieval = Math.max(newestRetrieval, outcome.retrievedAtMs);
  }
  const report = summarizeReport(updated, retained, schemaChanged, { detail: notes.join('; ') || undefined });
  if (updated === 0) return { outputs: [], report };
  const stations = [...blocks.values()].sort((a, b) => a.source.localeCompare(b.source));
  const segments = stations.flatMap((block) => block.segments);
  report.objectCount = stations.length;
  return {
    report,
    outputs: [{
      id: 'stations',
      directory: 'stations',
      value: { schemaVersion: 1, kind: 'stations', generatedAt: ctx.nowIso, citation: GP_CITATION, stations },
      meta: { objectCount: stations.length, retrievedAt: iso(newestRetrieval), ...epochRange(segments), sources: urls },
    }],
  };
}

// One constellation group: full validation of every object, then the shell
// summary of all objects and the deterministic 1-in-N sampled layer.
export async function buildLayer(source, results, ctx) {
  const groupConfig = ctx.configs.layers.groups.find((entry) => entry.group === source.group);
  const { outcome } = results[0];
  if (outcome.status !== 'ok') return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: failureReason(outcome) } };
  let rows;
  try { rows = parseGpCsv(outcome.body, { kind: 'gp', retrievedAtMs: outcome.retrievedAtMs }); } catch (error) {
    return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: error.message.slice(0, 200), ...(error instanceof SchemaError ? { schemaChanged: error.message } : {}) } };
  }
  const byId = new Map();
  let stale = 0;
  let invalid = 0;
  let withheld = 0;
  for (const { record, reasons } of rows) {
    if (isWithheld(record.NORAD_CAT_ID)) { withheld += 1; continue; }
    if (reasons.length) { invalid += 1; continue; }
    if (isStale(record, outcome.retrievedAtMs)) { stale += 1; continue; }
    if (!smokeTest(record, outcome.retrievedAtMs, [0, 90]).ok) { invalid += 1; continue; }
    const existing = byId.get(record.NORAD_CAT_ID);
    if (!existing || epochMs(record.EPOCH) > epochMs(existing.EPOCH)) byId.set(record.NORAD_CAT_ID, record);
  }
  const accepted = [...byId.values()].sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
  const tolerance = Math.max(2, Math.ceil(rows.length * ctx.configs.layers.maxInvalidFraction));
  const detail = `${rows.length} rows, ${accepted.length} accepted, ${stale} stale dropped, ${invalid} invalid dropped`;
  if (invalid > tolerance) return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: `rejected: too many invalid rows (${detail})` } };
  const problem = countDropProblem(ctx.previousEntry(`shells:${source.group}`)?.objectCount, accepted.length);
  if (problem) return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: `rejected count-drop: ${problem}` } };

  const previousLayer = await ctx.previousContent(`layer-sampled:${source.group}`);
  const previousRows = new Map((previousLayer?.rows ?? []).map((row) => [row[0], row]));
  let regressions = 0;
  const sampledRows = sampleRecords(accepted, groupConfig.sampleEvery).map((record) => {
    const prevRow = previousRows.get(record.NORAD_CAT_ID);
    if (prevRow && epochMs(record.EPOCH) < epochMs(rowRecord(prevRow).EPOCH)) { regressions += 1; return prevRow; }
    return layerRow(record);
  });
  const retrievedAt = iso(outcome.retrievedAtMs);
  const common = { schemaVersion: 1, layerId: source.group, generatedAt: ctx.nowIso, retrievedAt, source: outcome.url, citation: GP_CITATION };
  const range = epochRange(accepted);
  return {
    report: { status: 'healthy', updated: 1, retained: 0, objectCount: accepted.length, detail: `${detail}, ${sampledRows.length} sampled${regressions ? `, ${regressions} epoch regressions kept` : ''}${withheld ? `, ${withheld} withheld dropped` : ''}` },
    outputs: [
      {
        id: `shells:${source.group}`,
        directory: 'shells',
        value: { ...common, kind: 'shells', objectCount: accepted.length, droppedStale: stale, droppedInvalid: invalid, bins: ctx.configs.layers.shellBins, shells: summarizeShells(accepted, ctx.configs.layers.shellBins) },
        meta: { objectCount: accepted.length, retrievedAt, ...range, sources: [outcome.url] },
      },
      {
        id: `layer-sampled:${source.group}`,
        directory: 'layers-sampled',
        value: { ...common, kind: 'layer-sampled', sampling: { rule: `NORAD_CAT_ID % ${groupConfig.sampleEvery} == 0`, every: groupConfig.sampleEvery, groupObjectCount: accepted.length }, fields: LAYER_FIELDS, rows: sampledRows },
        meta: { objectCount: sampledRows.length, retrievedAt, ...epochRange(sampledRows.map(rowRecord)), sources: [outcome.url] },
      },
    ],
  };
}

function satcatRows(outcome) {
  return parseSatcatCsv(outcome.body).filter(({ record }) => !isWithheld(record.NORAD_CAT_ID) && record.DATA_STATUS_CODE !== 'NEA');
}

// SATCAT origin fields for the roster (never queried for withheld objects).
export async function buildSatcatRoster(source, results, ctx) {
  const previous = await ctx.previousContent('satcat:roster');
  const records = new Map((previous?.records ?? []).map((record) => [record.NORAD_CAT_ID, record]));
  let updated = 0;
  let retained = 0;
  let schemaChanged = null;
  let newestRetrieval = 0;
  const notes = [];
  const urls = [];
  const put = (record, retrievedAtMs) => {
    records.set(record.NORAD_CAT_ID, { ...record, retrievedAt: iso(retrievedAtMs) });
    updated += 1;
    newestRetrieval = Math.max(newestRetrieval, retrievedAtMs);
  };
  for (const { req, outcome } of results) {
    if (outcome.url) urls.push(outcome.url);
    if (outcome.status !== 'ok' || schemaChanged) { retained += 1; if (outcome.status !== 'skipped') notes.push(`${req.queryKey}: ${schemaChanged ? 'schema changed' : failureReason(outcome)}`); continue; }
    let rows;
    try { rows = satcatRows(outcome); } catch (error) {
      if (error instanceof SchemaError) schemaChanged = error.message;
      retained += 1;
      notes.push(`${req.queryKey}: ${error.message.slice(0, 160)}`);
      continue;
    }
    if (req.noradCatId !== undefined) {
      const matching = rows.filter(({ record }) => record.NORAD_CAT_ID === req.noradCatId);
      if (matching.length !== 1 || matching[0].reasons.length) { retained += 1; notes.push(`${req.queryKey}: invalid or missing row`); continue; }
      put(matching[0].record, outcome.retrievedAtMs);
    } else {
      const { intdes, namePattern, expectedCount } = req.intdes;
      const pattern = new RegExp(namePattern);
      const members = rows.filter(({ record, reasons }) => !reasons.length && record.OBJECT_ID.startsWith(intdes) && record.OBJECT_TYPE === 'PAY' && pattern.test(record.OBJECT_NAME));
      const baseline = [...records.values()].filter((record) => record.OBJECT_ID.startsWith(intdes)).length || expectedCount;
      const problem = countDropProblem(baseline, members.length);
      if (problem) { retained += 1; notes.push(`${req.queryKey} rejected: ${problem}`); continue; }
      for (const { record } of members) put(record, outcome.retrievedAtMs);
    }
  }
  const report = summarizeReport(updated, retained, schemaChanged, { detail: notes.slice(0, 5).join('; ') || undefined });
  if (updated === 0) return { outputs: [], report };
  const sorted = [...records.values()].sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
  report.objectCount = sorted.length;
  return {
    report,
    outputs: [{
      id: 'satcat:roster',
      directory: 'satcat',
      value: { schemaVersion: 1, kind: 'satcat', scope: 'roster', generatedAt: ctx.nowIso, citation: GP_CITATION, records: sorted },
      meta: { objectCount: sorted.length, retrievedAt: iso(newestRetrieval), sources: urls },
    }],
  };
}

// SATCAT origin fields for the objects in each sampled layer (same sampling rule).
export async function buildSatcatLayers(source, results, ctx) {
  const outputs = [];
  const notes = [];
  let updated = 0;
  let retained = 0;
  let schemaChanged = null;
  for (const { req, outcome } of results) {
    const groupConfig = ctx.configs.layers.groups.find((entry) => entry.group === req.group);
    if (outcome.status !== 'ok' || schemaChanged) { retained += 1; if (outcome.status !== 'skipped') notes.push(`${req.group}: ${schemaChanged ? 'schema changed' : failureReason(outcome)}`); continue; }
    let rows;
    try { rows = satcatRows(outcome); } catch (error) {
      if (error instanceof SchemaError) schemaChanged = error.message;
      retained += 1;
      notes.push(`${req.group}: ${error.message.slice(0, 160)}`);
      continue;
    }
    const invalid = rows.filter(({ reasons }) => reasons.length).length;
    const valid = rows.filter(({ reasons }) => !reasons.length).map(({ record }) => record);
    const tolerance = Math.max(2, Math.ceil(rows.length * ctx.configs.layers.maxInvalidFraction));
    const id = `satcat-layer:${req.group}`;
    const sampled = sampleRecords(valid, groupConfig.sampleEvery).sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
    const problem = invalid > tolerance ? `too many invalid rows (${invalid})` : countDropProblem(ctx.previousEntry(id)?.objectCount, sampled.length);
    if (problem) { retained += 1; notes.push(`${req.group} rejected: ${problem}`); continue; }
    const retrievedAt = iso(outcome.retrievedAtMs);
    outputs.push({
      id,
      directory: 'satcat',
      value: {
        schemaVersion: 1, kind: 'satcat-layer', layerId: req.group, generatedAt: ctx.nowIso, retrievedAt, source: outcome.url, citation: GP_CITATION,
        sampling: { rule: `NORAD_CAT_ID % ${groupConfig.sampleEvery} == 0`, every: groupConfig.sampleEvery, groupObjectCount: valid.length },
        fields: SATCAT_LAYER_FIELDS, rows: sampled.map((record) => SATCAT_LAYER_FIELDS.map((field) => record[field])),
      },
      meta: { objectCount: sampled.length, retrievedAt, sources: [outcome.url] },
    });
    updated += 1;
  }
  const report = summarizeReport(updated, retained, schemaChanged, { detail: notes.slice(0, 5).join('; ') || undefined, objectCount: outputs.reduce((sum, item) => sum + item.meta.objectCount, 0) });
  return { outputs, report };
}

const SWPC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function swpcSeries(product, data, nowMs) {
  if (!Array.isArray(data)) throw new Error('response is not an array');
  const future = (text) => Date.parse(`${text}Z`) > nowMs + 5 * MINUTE;
  if (product === 'kp') {
    const rows = data.map((item) => {
      if (!SWPC_TIME.test(item?.time_tag ?? '') || future(item.time_tag)) throw new Error('Kp time_tag invalid or in the future');
      if (typeof item.Kp !== 'number' || !(item.Kp >= 0 && item.Kp <= 9)) throw new Error('Kp outside [0, 9]');
      return [item.time_tag, item.Kp];
    });
    if (rows.length < 8) throw new Error('fewer than 8 Kp values');
    return { fields: ['time_tag', 'Kp'], rows };
  }
  if (product === 'f107') {
    const rows = data.map((item) => {
      if (!SWPC_TIME.test(item?.time_tag ?? '') || future(item.time_tag)) throw new Error('F10.7 time_tag invalid or in the future');
      if (typeof item.flux !== 'number' || !(item.flux >= 50 && item.flux <= 400)) throw new Error('F10.7 flux outside [50, 400] sfu');
      const mean = item.ninety_day_mean;
      if (mean !== null && mean !== undefined && !(typeof mean === 'number' && mean >= 50 && mean <= 400)) throw new Error('F10.7 90-day mean outside [50, 400] sfu');
      return [item.time_tag, item.flux, mean ?? null];
    });
    if (rows.length < 5) throw new Error('fewer than 5 F10.7 values');
    return { fields: ['time_tag', 'flux', 'ninety_day_mean'], rows };
  }
  const rows = data.map((item) => {
    if (!/^\d{4}-\d{2}$/.test(item?.['time-tag'] ?? '')) throw new Error('cycle time-tag invalid');
    const values = ['predicted_ssn', 'predicted_f10.7', 'low_f10.7', 'high_f10.7'].map((key) => item[key]);
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('cycle values invalid');
    if (!(values[1] >= 50 && values[1] <= 400)) throw new Error('predicted F10.7 outside [50, 400] sfu');
    return [item['time-tag'], ...values];
  });
  if (rows.length < 6) throw new Error('fewer than 6 predicted months');
  return { fields: ['month', 'predicted_ssn', 'predicted_f10.7', 'low_f10.7', 'high_f10.7'], rows };
}

export async function buildSpaceWeather(source, results, ctx) {
  const { outcome } = results[0];
  const id = `spaceweather:${source.product}`;
  if (outcome.status !== 'ok') return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: failureReason(outcome) } };
  let series;
  try {
    series = swpcSeries(source.product, JSON.parse(outcome.body), outcome.retrievedAtMs);
  } catch (error) {
    return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: `rejected: ${error.message}`.slice(0, 200) } };
  }
  const rows = [...new Map(series.rows.map((row) => [row[0], row])).values()].sort((a, b) => a[0].localeCompare(b[0]));
  const previous = await ctx.previousContent(id);
  if (source.product !== 'cycle' && previous?.rows?.length && rows.at(-1)[0] < previous.rows.at(-1)[0]) {
    return { outputs: [], report: { status: 'failed', updated: 0, retained: 1, detail: 'rejected: newest value is older than the published one' } };
  }
  const retrievedAt = iso(outcome.retrievedAtMs);
  return {
    report: { status: 'healthy', updated: 1, retained: 0, objectCount: rows.length },
    outputs: [{
      id,
      directory: 'spaceweather',
      value: { schemaVersion: 1, kind: 'spaceweather', product: source.product, generatedAt: ctx.nowIso, retrievedAt, source: outcome.url, citation: SWPC_CITATION, fields: series.fields, rows },
      meta: { objectCount: rows.length, retrievedAt, oldestValueAt: rows[0][0], newestValueAt: rows.at(-1)[0], sources: [outcome.url] },
    }],
  };
}

export const BUILDERS = Object.freeze({
  'roster-gp': buildRoster,
  'stations-supgp': buildStations,
  layer: buildLayer,
  'satcat-roster': buildSatcatRoster,
  'satcat-layers': buildSatcatLayers,
  swpc: buildSpaceWeather,
});
