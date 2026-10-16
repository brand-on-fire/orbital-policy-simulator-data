// Source definitions, request lists and the due/plan logic.
//
// Due rule: a source is due when now >= lastAttemptAt + max(pollMinutes, backoff).
// It is keyed on the last ATTEMPT (committed in state), so a failure never causes a
// rapid retry. CelesTrak sources run in policy order within a per-run request cap;
// a due source that does not fit is deferred to a later tick (never an error). On
// the very first run (no CelesTrak source ever attempted) only the first CelesTrak
// source runs, so the initial load is staggered across ticks.
//
// New-id backfill: a source with backfillNewIds that is not due may still request
// roster catalog numbers missing from its last publication, once each: a key is
// eligible only if it was never requested, or not within the source's pollMinutes
// (per-key attempts are committed in state.keyAttempts). The source's own cadence
// (lastAttemptAt) is unchanged, no backfill runs inside an error backoff, and every
// CelesTrak rule (cap, cooldown, halt, quarantine, stop on non-200) applies as usual.
import { gpUrl, satcatUrl, supgpUrl, swpcUrl, selectorKey } from './urls.mjs';
import { celestrakBlockedReason, isQuarantined, bytesToday, BACKOFF_MINUTES } from './safety.mjs';
import { MINUTE } from './constants.mjs';

function request(url, selector, meta = {}) {
  return { url, queryKey: selectorKey(selector), selector, ...meta };
}

export function allRequests(source, { roster, layers }) {
  switch (source.kind) {
    case 'roster-gp':
      return [
        ...roster.catnr.map((entry) => request(gpUrl({ CATNR: entry.noradCatId }), { CATNR: String(entry.noradCatId) }, { noradCatId: entry.noradCatId })),
        ...roster.intdes.map((entry) => request(gpUrl({ INTDES: entry.intdes }), { INTDES: entry.intdes }, { intdes: entry })),
      ];
    case 'satcat-roster':
      return [
        ...roster.catnr.map((entry) => request(satcatUrl({ CATNR: entry.noradCatId }), { CATNR: String(entry.noradCatId) }, { noradCatId: entry.noradCatId })),
        ...roster.intdes.map((entry) => request(satcatUrl({ INTDES: entry.intdes }), { INTDES: entry.intdes }, { intdes: entry })),
      ];
    case 'stations-supgp':
      return roster.stations.map((entry) => request(supgpUrl({ SOURCE: entry.source }), { SOURCE: entry.source }, { station: entry }));
    case 'layer':
      return [request(gpUrl({ GROUP: source.group }), { GROUP: source.group }, { group: source.group })];
    case 'satcat-layers':
      return layers.groups.map((entry) => request(satcatUrl({ GROUP: entry.group }), { GROUP: entry.group }, { group: entry.group }));
    case 'swpc':
      return [{ url: swpcUrl(source.product), queryKey: `SWPC=${source.product}`, product: source.product }];
    default:
      throw new Error(`Unknown source kind ${source.kind}`);
  }
}

// Each request is scoped to its endpoint: a quarantined GP CATNR does not block
// the same number's SATCAT request, and vice versa.
export function quarantineKey(source, req) {
  return `${source.kind === 'satcat-roster' || source.kind === 'satcat-layers' ? 'satcat' : source.kind === 'stations-supgp' ? 'supgp' : 'gp'}:${req.queryKey}`;
}

export function runnableRequests(source, configs, state) {
  const requests = allRequests(source, configs);
  if (source.provider !== 'celestrak') return { requests, skipped: [] };
  const skipped = requests.filter((req) => isQuarantined(state, quarantineKey(source, req)));
  return { requests: requests.filter((req) => !skipped.includes(req)), skipped };
}

export function backfillRequests(source, configs, state, nowMs, missingIds) {
  if (!source.backfillNewIds || source.provider !== 'celestrak' || !missingIds?.length) return [];
  // Never a faster retry path after an error: no backfill inside an error backoff.
  const sourceState = state.sources[source.id] ?? {};
  if (BACKOFF_MINUTES[sourceState.lastStatus]) return [];
  const backoff = BACKOFF_MINUTES[sourceState.lastBackfillStatus];
  if (backoff && nowMs < Date.parse(sourceState.lastBackfillAt) + backoff * MINUTE) return [];
  const missing = new Set(missingIds);
  return runnableRequests(source, configs, state).requests.filter((req) => {
    if (req.noradCatId === undefined || !missing.has(req.noradCatId)) return false;
    const last = Date.parse(state.keyAttempts?.[quarantineKey(source, req)] ?? '');
    return !Number.isFinite(last) || nowMs >= last + source.pollMinutes * MINUTE;
  });
}

export function isDue(source, sourceState, nowMs) {
  if (!source.enabled) return false;
  if (!sourceState?.lastAttemptAt) return true;
  const waitMinutes = Math.max(source.pollMinutes, BACKOFF_MINUTES[sourceState.lastStatus] ?? 0);
  return nowMs >= Date.parse(sourceState.lastAttemptAt) + waitMinutes * MINUTE;
}

export function planRun({ policy, roster, layers }, state, nowMs, { repositoryBytes = 0, missingIds = {} } = {}) {
  const configs = { policy, roster, layers };
  const plan = { run: [], deferred: [], notDue: [], blocked: [], disabled: [] };
  if (!policy.enabled) {
    for (const source of policy.sources) plan.disabled.push({ id: source.id, reason: 'collection disabled by policy' });
    return plan;
  }
  const celestrakSources = policy.sources.filter((source) => source.provider === 'celestrak');
  const bootstrap = celestrakSources.every((source) => !state.sources[source.id]?.lastAttemptAt);
  const blocked = celestrakBlockedReason(state, nowMs);
  const overBytes = bytesToday(state, nowMs) >= policy.celestrak.maxBytesPerDay;
  let budget = policy.celestrak.maxRequestsPerRun;
  let bootstrapTaken = false;
  for (const source of policy.sources) {
    const sourceState = state.sources[source.id];
    if (!source.enabled) { plan.disabled.push({ id: source.id, reason: 'source disabled' }); continue; }
    if (sourceState?.halted) { plan.blocked.push({ id: source.id, reason: `source halted: ${sourceState.haltReason}` }); continue; }
    let backfill = null;
    if (!isDue(source, sourceState, nowMs)) {
      const pending = backfillRequests(source, configs, state, nowMs, missingIds[source.id]);
      if (!pending.length) { plan.notDue.push({ id: source.id }); continue; }
      backfill = pending;
    }
    if (source.provider !== 'celestrak') { plan.run.push({ id: source.id, requestCount: 1 }); continue; }
    const label = backfill ? 'backfill: ' : '';
    if (blocked) { plan.blocked.push({ id: source.id, reason: `${label}${blocked}` }); continue; }
    if ((source.kind === 'layer' || source.kind === 'satcat-layers') && repositoryBytes >= policy.publication.layersHaltRepositoryBytes) {
      plan.blocked.push({ id: source.id, reason: 'MAINTENANCE REQUIRED: layer refresh stopped at the repository storage threshold' });
      continue;
    }
    if (overBytes) { plan.deferred.push({ id: source.id, reason: `${label}daily CelesTrak byte budget reached` }); continue; }
    if (bootstrap && bootstrapTaken) { plan.deferred.push({ id: source.id, reason: 'first-run stagger: deferred to a later tick' }); continue; }
    const requests = backfill ?? runnableRequests(source, configs, state).requests;
    if (requests.length > budget) { plan.deferred.push({ id: source.id, reason: `${label}per-run request cap (${requests.length} needed, ${budget} left)` }); continue; }
    budget -= requests.length;
    bootstrapTaken = true;
    plan.run.push({ id: source.id, requestCount: requests.length, ...(backfill ? { mode: 'backfill', queryKeys: requests.map((req) => req.queryKey) } : {}) });
  }
  return plan;
}
