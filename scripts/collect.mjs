#!/usr/bin/env node
// Collects every due source into the restored public-data tree (generated/).
// Writes content-addressed files, manifest.json, status.json and the committed
// collector state. Exits 1 when a human should look (a counted CelesTrak error,
// a halt, or a rejected refresh); the workflow publishes the diagnostic first.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBounded, sleep } from './lib/http.mjs';
import { canonicalJson } from './lib/canonical-json.mjs';
import { normalizeState, recordCelestrakResponse, applyHaltReset, HALT_REMINDER_MS } from './lib/safety.mjs';
import { planRun, runnableRequests, quarantineKey, allRequests } from './lib/sources.mjs';
import { BUILDERS } from './lib/builders.mjs';
import { readJsonIfExists, writeJson, writeContent, writeFileAtomic, retainedPaths, pruneUnreferenced } from './lib/storage.mjs';
import { runProvenance } from './lib/provenance.mjs';
import { validateConfigs } from './lib/config.mjs';
import { NEA_DENYLIST, GP_CITATION, SWPC_CITATION, MINUTE } from './lib/constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export async function loadConfigFiles(root = ROOT) {
  const read = async (name) => JSON.parse(await readFile(path.join(root, 'config', name), 'utf8'));
  return { policy: await read('collection-policy.json'), roster: await read('roster.json'), layers: await read('layers.json') };
}

function outcomeFor(req, result, classification, retrievedAtMs) {
  const base = { url: req.url, httpStatus: result.status ?? null, retrievedAtMs, label: classification?.label ?? result.kind };
  if (classification?.label === 'ok') return { ...base, status: 'ok', body: result.body };
  if (classification?.label === 'no-data') return { ...base, status: 'no-data' };
  return { ...base, status: 'error' };
}

function sourceHealth(source, sourceState, celestrakHalted, nowMs) {
  if (!source.enabled) return 'disabled';
  if (sourceState?.halted || (source.provider === 'celestrak' && celestrakHalted)) return 'halted';
  if (!sourceState?.lastAttemptAt) return 'pending';
  if (sourceState.lastStatus !== 'ok') return 'failed';
  const lastSuccess = Date.parse(sourceState.lastSuccessAt ?? 0);
  return nowMs - lastSuccess > 2 * Math.max(source.pollMinutes, 180) * MINUTE ? 'stale' : 'healthy';
}

export async function runCollection({
  root = ROOT,
  generatedDir = path.join(ROOT, 'generated'),
  runtimeDir = path.join(ROOT, 'runtime'),
  env = process.env,
  clock = () => Date.now(),
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  configs: providedConfigs,
} = {}) {
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();
  const configs = providedConfigs ?? await loadConfigFiles(root);
  validateConfigs(configs);
  const { policy } = configs;
  const statePath = path.join(generatedDir, 'state', 'collector-state.json');
  const state = normalizeState(await readJsonIfExists(statePath));
  const stateBefore = canonicalJson(state);
  const previousManifest = await readJsonIfExists(path.join(generatedDir, 'manifest.json'));
  const runtime = (await readJsonIfExists(path.join(runtimeDir, 'restore.json'))) ?? { repositoryBytes: 0 };
  const run = runProvenance(env, nowIso);
  const events = { countedErrors: 0, newlyHalted: false };
  const errors = [];

  const reset = applyHaltReset(state, policy.haltResetAt, nowMs);
  if (reset.error) errors.push(reset.error);

  const entries = new Map((previousManifest?.files ?? []).map((entry) => [entry.id, entry]));
  const contentCache = new Map();
  const ctx = {
    configs,
    nowMs,
    nowIso,
    previousEntry: (id) => entries.get(id) ?? null,
    previousContent: async (id) => {
      const entry = (previousManifest?.files ?? []).find((item) => item.id === id);
      if (!entry) return null;
      if (!contentCache.has(entry.path)) contentCache.set(entry.path, await readJsonIfExists(path.join(generatedDir, entry.path)));
      return contentCache.get(entry.path);
    },
  };
  const persistState = () => writeJson(statePath, state);

  // Roster catalog numbers missing from the last publication of each backfill source.
  const missingIds = {};
  const configuredIds = configs.roster.catnr.map((entry) => entry.noradCatId);
  const lastRoster = await ctx.previousContent('roster');
  if (lastRoster) {
    const have = new Set(lastRoster.objects.filter((object) => object.omm).map((object) => object.noradCatId));
    missingIds['roster-gp'] = configuredIds.filter((id) => !have.has(id));
  }
  const lastSatcat = await ctx.previousContent('satcat:roster');
  if (lastSatcat) {
    const have = new Set(lastSatcat.records.map((record) => record.NORAD_CAT_ID));
    missingIds['satcat-roster'] = configuredIds.filter((id) => !have.has(id));
  }

  const plan = planRun(configs, state, nowMs, { repositoryBytes: runtime.repositoryBytes, missingIds });

  const stops = { celestrak: null, swpc: null };
  const counters = { celestrakRequests: 0, celestrakBytes: 0, swpcRequests: 0 };
  const reports = [];
  for (const item of plan.run) {
    const source = policy.sources.find((candidate) => candidate.id === item.id);
    const backfill = item.mode === 'backfill';
    const runnable = runnableRequests(source, configs, state).requests;
    const requests = backfill ? runnable.filter((req) => item.queryKeys.includes(req.queryKey)) : runnable;
    const results = [];
    let attempted = 0;
    let counted = false;
    let noData = false;
    for (const req of requests) {
      const provider = source.provider;
      if (stops[provider]) {
        results.push({ req, outcome: { status: 'skipped', reason: `not requested: ${provider} stopped after ${stops[provider]}`, url: null } });
        continue;
      }
      const settings = policy[provider];
      if (provider === 'celestrak' ? counters.celestrakRequests > 0 : counters.swpcRequests > 0) await sleepImpl(settings.requestSpacingMs);
      const result = await fetchBounded(req.url, {
        fetchImpl, userAgent: policy.userAgent, timeoutMs: settings.timeoutSeconds * 1000, maxBytes: source.maxResponseBytes,
      });
      const retrievedAtMs = clock();
      attempted += 1;
      let classification;
      if (provider === 'celestrak') {
        counters.celestrakRequests += 1;
        counters.celestrakBytes += result.bytes ?? 0;
        classification = recordCelestrakResponse(state, { result, url: req.url, queryKey: quarantineKey(source, req), nowMs: retrievedAtMs, policy, events });
        state.keyAttempts[quarantineKey(source, req)] = new Date(retrievedAtMs).toISOString();
        await persistState();
      } else {
        counters.swpcRequests += 1;
        classification = result.kind === 'response' && result.status === 200
          ? { label: 'ok', stop: false }
          : { label: result.kind === 'response' ? `http-${result.status}` : result.kind, stop: true };
      }
      if (classification.counted) counted = true;
      if (classification.label === 'no-data') noData = true;
      if (classification.stop) stops[provider] = `${classification.label} from ${req.url}`;
      results.push({ req, outcome: outcomeFor(req, result, classification, retrievedAtMs) });
    }

    const sourceState = state.sources[source.id] ?? {};
    if (attempted === 0 && requests.length > 0) {
      reports.push({ id: source.id, status: 'deferred', detail: results[0]?.outcome.reason ?? 'not attempted' });
      continue;
    }
    const built = await BUILDERS[source.kind](source, results, { ...ctx, mode: backfill ? 'backfill' : 'full' });
    if (backfill) built.report.detail = [`backfill of ${requests.length} new catalog numbers`, built.report.detail].filter(Boolean).join('; ');
    for (const output of built.outputs) {
      const written = await writeContent(generatedDir, output.directory, output.value);
      entries.set(output.id, { id: output.id, ...written, ...output.meta });
    }
    const httpStatuses = results.map((entry) => entry.outcome.httpStatus).filter((value) => value !== null && value !== undefined);
    let lastStatus = 'ok';
    if (counted) lastStatus = 'counted-error';
    else if (results.some((entry) => entry.outcome.status === 'error')) lastStatus = 'error';
    else if (noData) lastStatus = 'no-data';
    else if (built.report.status === 'failed') lastStatus = 'validation-failed';
    // A backfill leaves the source's cadence (lastAttemptAt, lastStatus) untouched.
    state.sources[source.id] = {
      ...sourceState,
      ...(backfill
        ? { lastBackfillAt: nowIso, lastBackfillStatus: lastStatus }
        : { lastAttemptAt: nowIso, lastStatus, httpStatus: httpStatuses.at(-1) ?? null, requests: attempted }),
      objectCount: built.report.objectCount ?? sourceState.objectCount ?? null,
      detail: built.report.detail ?? null,
      ...(built.outputs.length ? { lastSuccessAt: nowIso } : {}),
      ...(built.report.schemaChanged ? { halted: true, haltedAt: nowIso, haltReason: `schema-changed: ${built.report.schemaChanged}`.slice(0, 300) } : {}),
    };
    reports.push({ id: source.id, ...built.report, lastStatus });
    await persistState();
  }

  // Per-key attempt times are kept only for requests the configuration still makes.
  const liveKeys = new Set(policy.sources.filter((source) => source.provider === 'celestrak')
    .flatMap((source) => allRequests(source, configs).map((req) => quarantineKey(source, req))));
  for (const key of Object.keys(state.keyAttempts)) if (!liveKeys.has(key)) delete state.keyAttempts[key];

  const ranCount = reports.filter((report) => report.status !== 'deferred').length;
  const celestrak = state.celestrak;
  let haltReminder = false;
  if (celestrak.halted && !events.newlyHalted && (!celestrak.lastHaltReminderAt || nowMs - Date.parse(celestrak.lastHaltReminderAt) >= HALT_REMINDER_MS)) {
    celestrak.lastHaltReminderAt = nowIso;
    haltReminder = true;
  }
  if (events.newlyHalted) celestrak.lastHaltReminderAt = nowIso;

  const failed = reports.filter((report) => report.status === 'failed' || report.schemaChanged);
  const healthy = reports.filter((report) => report.status === 'healthy' || report.status === 'partial');
  let outcome;
  if (ranCount === 0) outcome = 'no-sources-due';
  else if (failed.length === 0 && reports.every((report) => report.status === 'healthy' || report.status === 'deferred')) outcome = 'complete';
  else if (healthy.length === 0) outcome = 'failed';
  else outcome = 'degraded';
  if (outcome === 'complete' && celestrak.halted) outcome = 'degraded';
  if (outcome === 'no-sources-due' && celestrak.halted) outcome = 'degraded';

  const stateChanged = canonicalJson(state) !== stateBefore;
  if (healthy.length) state.lastSuccessfulCollectionAt = nowIso;
  if (run.event === 'schedule') state.lastScheduledRun = run;

  const exitCode = events.countedErrors > 0 || events.newlyHalted || failed.length > 0 || haltReminder || errors.length > 0 ? 1 : 0;
  const status = buildStatus({ policy, state, plan, reports, run, nowIso, nowMs, outcome, errors, counters, events, previousManifest });

  // A tick where nothing was due and nothing changed makes no commit.
  if (ranCount === 0 && !stateChanged && !haltReminder && previousManifest) {
    return { status, exitCode, changed: false };
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: nowIso,
    scheduleGuarantee: false,
    notice: 'NOTICE.md',
    citations: [GP_CITATION, SWPC_CITATION],
    collector: { commit: run.headSha ?? null, event: run.event, runId: run.id ?? null, runAttempt: run.attempt ?? null, runUrl: run.url ?? null },
    status: 'status.json',
    files: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    withheld: configs.roster.withheld,
  };
  for (const entry of manifest.files) {
    const kept = state.publishedPaths[entry.id] ?? [];
    if (kept[0] !== entry.path) state.publishedPaths[entry.id] = [entry.path, kept[0]].filter(Boolean);
  }
  await writeJson(statePath, state);
  await writeJson(path.join(generatedDir, 'manifest.json'), manifest);
  await writeJson(path.join(generatedDir, 'status.json'), status);
  await writeFileAtomic(path.join(generatedDir, 'NOTICE.md'), await readFile(path.join(root, 'NOTICE.md')));
  await pruneUnreferenced(generatedDir, retainedPaths(manifest, state));
  return { status, exitCode, changed: true };
}

export function buildStatus({ policy, state, plan, reports, run, nowIso, nowMs, outcome, errors, counters, events, previousManifest }) {
  const byReport = new Map(reports.map((report) => [report.id, report]));
  const planned = new Map([...plan.deferred, ...plan.blocked, ...plan.disabled].map((item) => [item.id, item.reason]));
  const c = state.celestrak;
  return {
    schemaVersion: 1,
    generatedAt: nowIso,
    outcome,
    scheduleGuarantee: false,
    run,
    lastScheduledRun: state.lastScheduledRun ?? null,
    lastSuccessfulCollectionAt: state.lastSuccessfulCollectionAt ?? null,
    previousPublicationAt: previousManifest?.generatedAt ?? null,
    celestrak: {
      requestsThisRun: counters.celestrakRequests,
      bytesThisRun: counters.celestrakBytes,
      requestsToday: c.requestsByDay[nowIso.slice(0, 10)] ?? 0,
      bytesToday: c.bytesByDay[nowIso.slice(0, 10)] ?? 0,
      countedErrorsThisRun: events.countedErrors,
      countedErrorsTotal: c.countedErrorsTotal,
      errorsLast2h: c.errorLog.filter((entry) => Date.parse(entry.at) > nowMs - 120 * MINUTE).length,
      errorsLast24h: c.errorLog.filter((entry) => Date.parse(entry.at) > nowMs - 1440 * MINUTE).length,
      consecutiveErrors: c.consecutiveErrors,
      consecutive403: c.consecutive403,
      halted: c.halted,
      haltedAt: c.haltedAt,
      haltReason: c.haltReason,
      cooldownUntil: c.cooldownUntil,
      quarantine: state.quarantine,
      neaDenylist: NEA_DENYLIST,
    },
    sources: policy.sources.map((source) => {
      const sourceState = state.sources[source.id] ?? {};
      const report = byReport.get(source.id);
      const ran = Boolean(report && report.status !== 'deferred');
      const deferred = report?.status === 'deferred' || plan.deferred.some((item) => item.id === source.id);
      return {
        id: source.id,
        provider: source.provider,
        pollMinutes: source.pollMinutes,
        lastAttemptAt: sourceState.lastAttemptAt ?? null,
        lastSuccessAt: sourceState.lastSuccessAt ?? null,
        status: ran ? report.status : deferred ? 'deferred' : sourceHealth(source, sourceState, c.halted, nowMs),
        ranThisRun: ran,
        httpStatus: sourceState.httpStatus ?? null,
        objectCount: sourceState.objectCount ?? null,
        detail: report?.detail ?? planned.get(source.id) ?? sourceState.haltReason ?? sourceState.detail ?? null,
      };
    }),
    errors,
  };
}

async function main() {
  const generatedDir = path.join(ROOT, 'generated');
  let result;
  try {
    result = await runCollection({ generatedDir });
  } catch (error) {
    // Public diagnostics never include machine paths, environment or tokens.
    const nowIso = new Date().toISOString();
    const message = `Collection failed (${error?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 200)}); the last validated publication was retained.`;
    const previous = await readJsonIfExists(path.join(generatedDir, 'status.json')).catch(() => null);
    let run;
    try { run = runProvenance(process.env, nowIso); } catch { run = { event: 'unknown', startedAt: nowIso }; }
    const status = { ...(previous ?? {}), schemaVersion: 1, generatedAt: nowIso, outcome: 'failed', scheduleGuarantee: false, run, errors: [message] };
    await writeJson(path.join(generatedDir, 'status.json'), status).catch(() => {});
    console.error(message);
    await summarize(status);
    process.exit(1);
  }
  const { status, exitCode, changed } = result;
  console.log(JSON.stringify({ outcome: status.outcome, changed, celestrak: { requests: status.celestrak.requestsThisRun, countedErrorsThisRun: status.celestrak.countedErrorsThisRun, countedErrorsTotal: status.celestrak.countedErrorsTotal, halted: status.celestrak.halted }, sources: status.sources.filter((s) => s.ranThisRun || s.status === 'deferred').map((s) => `${s.id}:${s.status}`) }));
  await summarize(status);
  process.exit(exitCode);
}

async function summarize(status) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## Orbital public collection: ${status.outcome}`,
    '',
    `Trigger: ${status.run?.event ?? 'unknown'}. CelesTrak requests this run: ${status.celestrak?.requestsThisRun ?? 0}; counted errors this run: ${status.celestrak?.countedErrorsThisRun ?? 0}; halted: ${status.celestrak?.halted ?? 'unknown'}.`,
    '',
    ...(status.sources ?? []).map((source) => `- ${source.id}: ${source.status}${source.detail ? ` (${source.detail})` : ''}`),
    '',
    ...(status.celestrak?.halted ? [`HALTED: ${status.celestrak.haltReason}. A human must review and commit config/collection-policy.json haltResetAt.`] : []),
    ...(status.errors ?? []),
    '',
    'Scheduled runs are best effort; this run does not establish a future delivery guarantee.',
  ];
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

