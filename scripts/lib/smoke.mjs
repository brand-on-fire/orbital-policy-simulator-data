// SGP4 smoke propagation with the vendored satellite.js 7.1.0 (pure JavaScript path).
import { json2satrec, propagate } from '../../vendor/satellite.js-7.1.0/satellite.mjs';
import { MINUTE } from './constants.mjs';

export const EARTH_MU_KM3_S2 = 398600.4418;
export const EARTH_RADIUS_KM = 6378.137;
const HEIGHT_MIN_KM = 100;
const HEIGHT_MAX_KM = 60000;
const RADIUS_SLACK_KM = 100;

export function semiMajorAxisKm(meanMotionRevPerDay) {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  return Math.cbrt(EARTH_MU_KM3_S2 / (n * n));
}

export function meanAltitudeKm(meanMotionRevPerDay) {
  return semiMajorAxisKm(meanMotionRevPerDay) - EARTH_RADIUS_KM;
}

function satrecFor(record) {
  return json2satrec({
    OBJECT_NAME: record.OBJECT_NAME,
    OBJECT_ID: record.OBJECT_ID,
    EPOCH: record.EPOCH,
    MEAN_MOTION: record.MEAN_MOTION,
    ECCENTRICITY: record.ECCENTRICITY,
    INCLINATION: record.INCLINATION,
    RA_OF_ASC_NODE: record.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: record.ARG_OF_PERICENTER,
    MEAN_ANOMALY: record.MEAN_ANOMALY,
    EPHEMERIS_TYPE: record.EPHEMERIS_TYPE ?? 0,
    CLASSIFICATION_TYPE: record.CLASSIFICATION_TYPE ?? 'U',
    NORAD_CAT_ID: record.NORAD_CAT_ID,
    ELEMENT_SET_NO: record.ELEMENT_SET_NO ?? 999,
    REV_AT_EPOCH: record.REV_AT_EPOCH ?? 0,
    BSTAR: record.BSTAR,
    MEAN_MOTION_DOT: record.MEAN_MOTION_DOT,
    MEAN_MOTION_DDOT: record.MEAN_MOTION_DDOT,
  });
}

// Propagates at baseMs plus each offset (minutes). The mean perigee must be at least
// 100 km up; every result must be finite, its height must lie in [100, 60000] km and
// its radius within a(1 +/- e) +/- 100 km.
export function smokeTest(record, baseMs, offsetsMinutes = [0, 90]) {
  let satrec;
  try { satrec = satrecFor(record); } catch (error) { return { ok: false, reason: `json2satrec threw ${error.name}` }; }
  if (!satrec || satrec.error !== 0) return { ok: false, reason: `json2satrec error ${satrec?.error}` };
  const a = semiMajorAxisKm(record.MEAN_MOTION);
  const e = record.ECCENTRICITY;
  if (a * (1 - e) - EARTH_RADIUS_KM < HEIGHT_MIN_KM) return { ok: false, reason: `perigee ${(a * (1 - e) - EARTH_RADIUS_KM).toFixed(1)} km is below ${HEIGHT_MIN_KM} km` };
  for (const offset of offsetsMinutes) {
    let result;
    try { result = propagate(satrec, new Date(baseMs + offset * MINUTE)); } catch (error) {
      return { ok: false, reason: `propagate threw ${error.name} at +${offset} min` };
    }
    if (!result || satrec.error !== 0 || typeof result.position !== 'object' || typeof result.velocity !== 'object') {
      return { ok: false, reason: `propagate failed at +${offset} min (error ${satrec.error})` };
    }
    const { x, y, z } = result.position;
    const v = result.velocity;
    if (![x, y, z, v.x, v.y, v.z].every(Number.isFinite)) return { ok: false, reason: `non-finite state at +${offset} min` };
    const r = Math.hypot(x, y, z);
    const height = r - EARTH_RADIUS_KM;
    if (height < HEIGHT_MIN_KM || height > HEIGHT_MAX_KM) return { ok: false, reason: `height ${height.toFixed(1)} km at +${offset} min` };
    if (r < a * (1 - e) - RADIUS_SLACK_KM || r > a * (1 + e) + RADIUS_SLACK_KM) {
      return { ok: false, reason: `radius ${r.toFixed(1)} km outside a(1+/-e) at +${offset} min` };
    }
  }
  return { ok: true };
}
