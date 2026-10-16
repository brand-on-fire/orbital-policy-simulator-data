// The only place request URLs are built. Every builder and the final request
// check refuse withheld (NEA) catalog numbers and their launch designators, and
// every CelesTrak request is pinned to https://celestrak.org with FORMAT=CSV.
import {
  CELESTRAK_ORIGIN, SWPC_ORIGIN, ALLOWED_HOSTS, NEA_DENYLIST, NEA_LAUNCH_DESIGNATORS,
} from './constants.mjs';

export class NeaGuardError extends Error {
  constructor(message) { super(message); this.name = 'NeaGuardError'; }
}

export class RequestGuardError extends Error {
  constructor(message) { super(message); this.name = 'RequestGuardError'; }
}

const NEA = new Set(NEA_DENYLIST);
const NEA_LAUNCHES = new Set(NEA_LAUNCH_DESIGNATORS);

const CELESTRAK_PATHS = Object.freeze({
  gp: '/NORAD/elements/gp.php',
  satcat: '/satcat/records.php',
  supgp: '/NORAD/elements/supplemental/sup-gp.php',
});
const SELECTORS = Object.freeze({
  gp: ['CATNR', 'INTDES', 'GROUP'],
  satcat: ['CATNR', 'INTDES', 'GROUP'],
  supgp: ['SOURCE'],
});

export const SWPC_PATHS = Object.freeze({
  kp: '/products/noaa-planetary-k-index.json',
  f107: '/json/f107_cm_flux.json',
  cycle: '/json/solar-cycle/predicted-solar-cycle.json',
});

export function isWithheld(noradCatId) {
  return NEA.has(Number(noradCatId));
}

function catalogNumber(value) {
  const text = String(value);
  if (!/^[1-9]\d{0,8}$/.test(text)) throw new RequestGuardError(`Invalid catalog number ${JSON.stringify(text)}`);
  if (NEA.has(Number(text))) throw new NeaGuardError(`Catalog number ${text} is withheld (NEA) and is never requested`);
  return text;
}

function launchDesignator(value) {
  const text = String(value);
  if (!/^\d{4}-\d{3}$/.test(text)) throw new RequestGuardError(`Invalid launch designator ${JSON.stringify(text)}`);
  if (NEA_LAUNCHES.has(text)) throw new NeaGuardError(`Launch ${text} carries a withheld (NEA) object and is never requested`);
  return text;
}

function groupName(value) {
  const text = String(value);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(text)) throw new RequestGuardError(`Invalid group ${JSON.stringify(text)}`);
  return text;
}

function supSource(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/.test(text)) throw new RequestGuardError(`Invalid SupGP source ${JSON.stringify(text)}`);
  return text;
}

const NORMALIZE = { CATNR: catalogNumber, INTDES: launchDesignator, GROUP: groupName, SOURCE: supSource };

function onlySelector(endpoint, selector) {
  const keys = Object.keys(selector ?? {});
  if (keys.length !== 1 || !SELECTORS[endpoint].includes(keys[0])) {
    throw new RequestGuardError(`${endpoint} requires exactly one of ${SELECTORS[endpoint].join(', ')}`);
  }
  const key = keys[0];
  return [key, NORMALIZE[key](selector[key])];
}

function celestrakUrl(endpoint, selector) {
  const [key, value] = onlySelector(endpoint, selector);
  return `${CELESTRAK_ORIGIN}${CELESTRAK_PATHS[endpoint]}?${key}=${encodeURIComponent(value)}&FORMAT=CSV`;
}

export const gpUrl = (selector) => celestrakUrl('gp', selector);
export const satcatUrl = (selector) => celestrakUrl('satcat', selector);
export const supgpUrl = (selector) => celestrakUrl('supgp', selector);

export function swpcUrl(product) {
  const pathname = SWPC_PATHS[product];
  if (!pathname) throw new RequestGuardError(`Unknown SWPC product ${JSON.stringify(product)}`);
  return `${SWPC_ORIGIN}${pathname}`;
}

export function selectorKey(selector) {
  const [key] = Object.keys(selector);
  return `${key}=${selector[key]}`;
}

// Last check before any network call: re-parses the URL independently of the builders.
export function assertRequestAllowed(urlText) {
  let url;
  try { url = new URL(urlText); } catch { throw new RequestGuardError('Unparseable request URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new RequestGuardError(`Request URL must be plain https: ${urlText}`);
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) throw new RequestGuardError(`Host ${url.hostname} is not allowed`);
  if (url.hostname === 'services.swpc.noaa.gov') {
    if (!Object.values(SWPC_PATHS).includes(url.pathname) || url.search) throw new RequestGuardError(`SWPC path ${url.pathname} is not allowed`);
    return { provider: 'swpc' };
  }
  const endpoint = Object.keys(CELESTRAK_PATHS).find((name) => CELESTRAK_PATHS[name] === url.pathname);
  if (!endpoint) throw new RequestGuardError(`CelesTrak path ${url.pathname} is not allowed`);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 2 || url.searchParams.get('FORMAT') !== 'CSV') {
    throw new RequestGuardError('CelesTrak requests carry exactly one selector and FORMAT=CSV');
  }
  const selectorEntries = entries.filter(([key]) => key !== 'FORMAT');
  if (selectorEntries.length !== 1) throw new RequestGuardError('CelesTrak requests carry exactly one selector');
  const [key, value] = selectorEntries[0];
  if (!SELECTORS[endpoint].includes(key)) throw new RequestGuardError(`Selector ${key} is not allowed on ${endpoint}`);
  NORMALIZE[key](value);
  return { provider: 'celestrak', endpoint, key, value };
}
