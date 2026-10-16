// CelesTrak response handling, committed halt state and the human reset lever.
//
// | Response                         | Counted | Effect                                              |
// |----------------------------------|---------|-----------------------------------------------------|
// | 200                              | no      | parse the complete body or reject it                |
// | 200 "No GP data/SATCAT records"  | no      | quarantine that query key                           |
// | 3xx (301 and any redirect)       | yes     | halt for a human (the URL is wrong)                 |
// | 403 (any body)                   | yes     | 2 consecutive 403s halt for a human                 |
// | 404                              | yes     | quarantine that query key (CATNR, INTDES, ...)      |
// | 5xx, other status, timeout, cap  | yes     | source backoff                                      |
// Every non-200 stops all further CelesTrak requests in the run. Any counted
// error starts a global cooldown. Three counted errors (consecutive, or within
// any 24 hours) halt for a human. Only a human clears a halt or a quarantine, by
// committing config/collection-policy.json haltResetAt later than the event.
import { MINUTE, HOUR, DAY } from './constants.mjs';

export const NO_DATA = /^\s*No (?:GP data|SATCAT records) found/i;
export const NOT_UPDATED = /has not updated since your last successful download/i;

export function defaultState() {
  return {
    schemaVersion: 1,
    sources: {},
    celestrak: {
      consecutiveErrors: 0,
      consecutive403: 0,
      countedErrorsTotal: 0,
      lastCountedErrorAt: null,
      errorLog: [],
      halted: false,
      haltedAt: null,
      haltReason: null,
      cooldownUntil: null,
      bytesByDay: {},
      requestsByDay: {},
      lastHaltReminderAt: null,
      lastHaltResetApplied: null,
    },
    quarantine: [],
    keyAttempts: {},
    publishedPaths: {},
    keepalive: { lastCommittedAt: null, lastCommit: null },
    lastSuccessfulCollectionAt: null,
    lastScheduledRun: null,
  };
}

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) return base;
  return {
    ...base,
    ...raw,
    celestrak: { ...base.celestrak, ...(raw.celestrak ?? {}) },
    keepalive: { ...base.keepalive, ...(raw.keepalive ?? {}) },
    sources: { ...(raw.sources ?? {}) },
    quarantine: [...(raw.quarantine ?? [])],
    keyAttempts: { ...(raw.keyAttempts ?? {}) },
    publishedPaths: { ...(raw.publishedPaths ?? {}) },
  };
}

export function classifyResponse(result) {
  if (result.kind === 'response') {
    const status = result.status;
    if (status === 200) {
      if (NO_DATA.test(result.body ?? '')) return { label: 'no-data', counted: false, stop: false, quarantine: true };
      return { label: 'ok', counted: false, stop: false };
    }
    if (status >= 300 && status < 400) {
      return { label: `redirect-${status}`, counted: true, stop: true, halt: `HTTP ${status} redirect: the request URL is wrong` };
    }
    if (status === 403) {
      return { label: NOT_UPDATED.test(result.body ?? '') ? 'forbidden-not-updated' : 'forbidden', counted: true, stop: true, is403: true };
    }
    if (status === 404) return { label: 'not-found', counted: true, stop: true, quarantine: true };
    if (status >= 500) return { label: `server-${status}`, counted: true, stop: true };
    return { label: `http-${status}`, counted: true, stop: true };
  }
  if (result.kind === 'byte-cap') return { label: 'byte-cap', counted: true, stop: true };
  if (result.kind === 'timeout') return { label: 'timeout', counted: true, stop: true };
  return { label: 'network', counted: true, stop: true };
}

function halt(state, reason, nowIso, events) {
  const c = state.celestrak;
  if (c.halted) return;
  c.halted = true;
  c.haltedAt = nowIso;
  c.haltReason = reason;
  events.newlyHalted = true;
}

// Applies one CelesTrak response to the committed state. Returns the classification.
export function recordCelestrakResponse(state, { result, url, queryKey, nowMs, policy, events }) {
  const c = state.celestrak;
  const nowIso = new Date(nowMs).toISOString();
  const day = nowIso.slice(0, 10);
  c.requestsByDay[day] = (c.requestsByDay[day] ?? 0) + 1;
  c.bytesByDay[day] = (c.bytesByDay[day] ?? 0) + (result.bytes ?? 0);
  trimDays(c.requestsByDay, day);
  trimDays(c.bytesByDay, day);
  const classification = classifyResponse(result);
  if (classification.quarantine && queryKey && !state.quarantine.some((entry) => entry.key === queryKey)) {
    state.quarantine.push({ key: queryKey, at: nowIso, label: classification.label, httpStatus: result.status ?? null });
  }
  if (!classification.counted) {
    c.consecutive403 = 0;
    c.consecutiveErrors = 0;
    return classification;
  }
  events.countedErrors = (events.countedErrors ?? 0) + 1;
  c.countedErrorsTotal += 1;
  c.consecutiveErrors += 1;
  c.consecutive403 = classification.is403 ? c.consecutive403 + 1 : 0;
  c.lastCountedErrorAt = nowIso;
  c.cooldownUntil = new Date(nowMs + policy.celestrak.errorCooldownMinutes * MINUTE).toISOString();
  c.errorLog.push({ at: nowIso, label: classification.label, httpStatus: result.status ?? null, url });
  c.errorLog = c.errorLog.slice(-50);
  const last24h = c.errorLog.filter((entry) => Date.parse(entry.at) > nowMs - DAY).length;
  if (classification.halt) halt(state, classification.halt, nowIso, events);
  if (c.consecutive403 >= policy.celestrak.haltAfterConsecutive403) halt(state, `${c.consecutive403} consecutive HTTP 403 responses`, nowIso, events);
  if (c.consecutiveErrors >= policy.celestrak.haltAfterCountedErrors) halt(state, `${c.consecutiveErrors} consecutive counted errors`, nowIso, events);
  if (last24h >= policy.celestrak.haltAfterCountedErrors) halt(state, `${last24h} counted errors within 24 hours`, nowIso, events);
  return classification;
}

function trimDays(map, today) {
  const keep = new Set([today, new Date(Date.parse(today) - DAY).toISOString().slice(0, 10)]);
  for (const key of Object.keys(map)) if (!keep.has(key)) delete map[key];
}

// The only way to clear a halt, a per-source schema halt or a quarantine: a human
// commits haltResetAt (ISO time, not in the future) later than the event it clears.
export function applyHaltReset(state, haltResetAt, nowMs) {
  if (haltResetAt === null || haltResetAt === undefined) return { applied: false };
  const t = Date.parse(haltResetAt);
  if (typeof haltResetAt !== 'string' || !Number.isFinite(t)) return { applied: false, error: 'haltResetAt is not a valid ISO time; ignored' };
  if (t > nowMs) return { applied: false, error: 'haltResetAt is in the future; ignored' };
  const c = state.celestrak;
  const cleared = [];
  if (c.halted && Date.parse(c.haltedAt) < t) {
    cleared.push(`halt (${c.haltReason})`);
    c.halted = false;
    c.haltReason = null;
    c.lastHaltReminderAt = null;
  }
  if (c.lastCountedErrorAt && Date.parse(c.lastCountedErrorAt) < t) {
    c.consecutiveErrors = 0;
    c.consecutive403 = 0;
    c.cooldownUntil = null;
  }
  const errorCount = c.errorLog.length;
  c.errorLog = c.errorLog.filter((entry) => Date.parse(entry.at) >= t);
  if (c.errorLog.length !== errorCount) cleared.push(`${errorCount - c.errorLog.length} logged errors`);
  const before = state.quarantine.length;
  state.quarantine = state.quarantine.filter((entry) => Date.parse(entry.at) >= t);
  if (state.quarantine.length !== before) cleared.push(`${before - state.quarantine.length} quarantined keys`);
  for (const [id, source] of Object.entries(state.sources)) {
    if (source.halted && Date.parse(source.haltedAt) < t) {
      source.halted = false;
      source.haltReason = null;
      cleared.push(`source ${id}`);
    }
  }
  c.lastHaltResetApplied = haltResetAt;
  return { applied: cleared.length > 0, cleared };
}

export function celestrakBlockedReason(state, nowMs) {
  const c = state.celestrak;
  if (c.halted) return `halted: ${c.haltReason}`;
  if (c.cooldownUntil && Date.parse(c.cooldownUntil) > nowMs) return `cooling down after a counted error until ${c.cooldownUntil}`;
  return null;
}

export function isQuarantined(state, queryKey) {
  return state.quarantine.some((entry) => entry.key === queryKey);
}

export function bytesToday(state, nowMs) {
  return state.celestrak.bytesByDay[new Date(nowMs).toISOString().slice(0, 10)] ?? 0;
}

export const HALT_REMINDER_MS = DAY;
export const BACKOFF_MINUTES = Object.freeze({ 'counted-error': 360, 'no-data': 360 });
export { HOUR };
