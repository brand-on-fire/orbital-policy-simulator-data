// Fail-closed configuration checks, run before any request.
import { NEA_DENYLIST, NEA_LAUNCH_DESIGNATORS } from './constants.mjs';
import { allRequests } from './sources.mjs';
import { assertRequestAllowed } from './urls.mjs';

export const MIN_CELESTRAK_POLL_MINUTES = 120;

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

const check = (condition, message) => { if (!condition) throw new ConfigError(message); };

export function validateConfigs({ policy, roster, layers }) {
  check(policy?.schemaVersion === 1 && roster?.schemaVersion === 1 && layers?.schemaVersion === 1, 'Unsupported configuration schema');
  check(policy.haltResetAt === null || typeof policy.haltResetAt === 'string', 'haltResetAt must be null or an ISO time');
  const c = policy.celestrak;
  check(c.maxRequestsPerRun >= 1 && c.maxRequestsPerRun <= 60, 'CelesTrak per-run request cap must be 1 to 60');
  check(c.requestSpacingMs >= 1000, 'CelesTrak requests must be spaced at least 1 second apart');
  check(c.haltAfterCountedErrors >= 1 && c.haltAfterCountedErrors <= 3, 'CelesTrak must halt after at most 3 counted errors');
  check(c.haltAfterConsecutive403 >= 1 && c.haltAfterConsecutive403 <= 2, 'CelesTrak must halt after at most 2 consecutive 403s');
  check(c.errorCooldownMinutes >= 120, 'CelesTrak error cooldown must be at least 120 minutes');
  check(c.maxBytesPerDay <= 50 * 1024 * 1024, 'CelesTrak daily byte budget must stay far below 100 MB');

  const nea = new Set(NEA_DENYLIST);
  const ids = roster.catnr.map((entry) => entry.noradCatId);
  check(ids.every((id) => Number.isInteger(id) && id > 0), 'Roster catalog numbers must be positive integers');
  check(new Set(ids).size === ids.length, 'Roster catalog numbers must be unique');
  check(ids.every((id) => !nea.has(id)), 'Roster names a withheld (NEA) catalog number');
  check(roster.intdes.every((entry) => !NEA_LAUNCH_DESIGNATORS.includes(entry.intdes)), 'Roster names a withheld launch');
  const withheld = roster.withheld.map((entry) => entry.noradCatId).sort((a, b) => a - b);
  check(JSON.stringify(withheld) === JSON.stringify([...NEA_DENYLIST].sort((a, b) => a - b)), 'Withheld list must equal the hard-coded NEA denylist');

  const layerGroups = layers.groups.map((entry) => entry.group).sort();
  const layerSources = policy.sources.filter((source) => source.kind === 'layer').map((source) => source.group).sort();
  check(JSON.stringify(layerGroups) === JSON.stringify(layerSources), 'Layer sources must match config/layers.json groups');
  check(layers.groups.every((entry) => Number.isInteger(entry.sampleEvery) && entry.sampleEvery >= 1), 'sampleEvery must be a positive integer');

  const seen = new Set();
  for (const source of policy.sources) {
    check(/^[a-z0-9-]{2,40}$/.test(source.id) && !seen.has(source.id), `Invalid or repeated source id ${source.id}`);
    seen.add(source.id);
    check(['celestrak', 'swpc'].includes(source.provider), `Unknown provider for ${source.id}`);
    check(Number.isInteger(source.pollMinutes) && source.pollMinutes >= 60, `${source.id} pollMinutes too small`);
    if (source.provider === 'celestrak') {
      check(source.pollMinutes >= MIN_CELESTRAK_POLL_MINUTES, `${source.id} polls CelesTrak more often than every ${MIN_CELESTRAK_POLL_MINUTES} minutes`);
    }
    check(Number.isInteger(source.maxResponseBytes) && source.maxResponseBytes > 0 && source.maxResponseBytes <= 16 * 1024 * 1024, `${source.id} needs a response byte cap`);
    const requests = allRequests(source, { roster, layers });
    check(requests.length <= c.maxRequestsPerRun, `${source.id} needs ${requests.length} requests, above the per-run cap`);
    for (const req of requests) {
      const allowed = assertRequestAllowed(req.url);
      check(allowed.provider === source.provider, `${source.id} request host does not match its provider`);
    }
  }
  return true;
}
