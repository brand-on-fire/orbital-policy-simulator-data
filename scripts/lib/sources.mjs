// Source definitions, request lists and the due/plan logic.
//
// Due rule: a source is due when now >= lastAttemptAt + max(pollMinutes, backoff).
// It is keyed on the last ATTEMPT (committed in state), so a failure never causes a
// rapid retry. CelesTrak sources run in policy order within a per-run request cap;
// a due source that does not fit is deferred to a later tick (never an error). On
// the very first run (no CelesTrak source ever attempted) only the first CelesTrak
// source runs, so the initial load is staggered across ticks.
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

export function isDue(source, sourceState, nowMs) {
  if (!source.enabled) return false;
  if (!sourceState?.lastAttemptAt) return true;
  const waitMinutes = Math.max(source.pollMinutes, BACKOFF_MINUTES[sourceState.lastStatus] ?? 0);
  return nowMs >= Date.parse(sourceState.lastAttemptAt) + waitMinutes * MINUTE;
}

export function planRun({ policy, roster, layers }, state, nowMs, { repositoryBytes = 0 } = {}) {
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
    if (!isDue(source, sourceState, nowMs)) { plan.notDue.push({ id: source.id }); continue; }
    if (source.provider !== 'celestrak') { plan.run.push({ id: source.id, requestCount: 1 }); continue; }
    if (blocked) { plan.blocked.push({ id: source.id, reason: blocked }); continue; }
    if ((source.kind === 'layer' || source.kind === 'satcat-layers') && repositoryBytes >= policy.publication.layersHaltRepositoryBytes) {
      plan.blocked.push({ id: source.id, reason: 'MAINTENANCE REQUIRED: layer refresh stopped at the repository storage threshold' });
      continue;
    }
    if (overBytes) { plan.deferred.push({ id: source.id, reason: 'daily CelesTrak byte budget reached' }); continue; }
    if (bootstrap && bootstrapTaken) { plan.deferred.push({ id: source.id, reason: 'first-run stagger: deferred to a later tick' }); continue; }
    const { requests } = runnableRequests(source, configs, state);
    if (requests.length > budget) { plan.deferred.push({ id: source.id, reason: `per-run request cap (${requests.length} needed, ${budget} left)` }); continue; }
    budget -= requests.length;
    bootstrapTaken = true;
    plan.run.push({ id: source.id, requestCount: requests.length });
  }
  return plan;
}
