// Constellation shell summaries and the deterministic 1-in-N sampled layer.
import { meanAltitudeKm } from './smoke.mjs';
import { LAYER_FIELDS } from './constants.mjs';

const round = (value, places) => Number(value.toFixed(places));

// Bins every object by mean altitude (from mean motion) and inclination. Each shell
// reports its count, means and representative orbital planes: RAAN histogram bins
// with their mean RAAN and object count.
export function summarizeShells(records, bins) {
  const shells = new Map();
  for (const record of records) {
    const altitude = meanAltitudeKm(record.MEAN_MOTION);
    const altitudeStep = altitude < bins.leoCeilingKm ? bins.leoAltitudeKm : bins.highAltitudeKm;
    const altitudeMin = Math.floor(altitude / altitudeStep) * altitudeStep;
    const inclinationMin = round(Math.floor(record.INCLINATION / bins.inclinationDeg) * bins.inclinationDeg, 3);
    const key = `${altitudeMin}|${inclinationMin}`;
    if (!shells.has(key)) {
      shells.set(key, { altitudeMin, altitudeStep, inclinationMin, count: 0, altitudeSum: 0, inclinationSum: 0, eccentricitySum: 0, planes: new Map() });
    }
    const shell = shells.get(key);
    shell.count += 1;
    shell.altitudeSum += altitude;
    shell.inclinationSum += record.INCLINATION;
    shell.eccentricitySum += record.ECCENTRICITY;
    const planeKey = Math.floor(record.RA_OF_ASC_NODE / bins.raanDeg);
    const plane = shell.planes.get(planeKey) ?? { count: 0, raanSum: 0 };
    plane.count += 1;
    plane.raanSum += record.RA_OF_ASC_NODE;
    shell.planes.set(planeKey, plane);
  }
  return [...shells.values()]
    .sort((a, b) => a.altitudeMin - b.altitudeMin || a.inclinationMin - b.inclinationMin)
    .map((shell) => ({
      altitudeKmMin: shell.altitudeMin,
      altitudeKmMax: shell.altitudeMin + shell.altitudeStep,
      inclinationDegMin: shell.inclinationMin,
      inclinationDegMax: round(shell.inclinationMin + bins.inclinationDeg, 3),
      count: shell.count,
      meanAltitudeKm: round(shell.altitudeSum / shell.count, 1),
      meanInclinationDeg: round(shell.inclinationSum / shell.count, 3),
      meanEccentricity: round(shell.eccentricitySum / shell.count, 6),
      planes: [...shell.planes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, plane]) => ({ raanDeg: round(plane.raanSum / plane.count, 2), count: plane.count })),
    }));
}

// Deterministic sample: every object whose catalog number is a multiple of N.
// Membership is stable across refreshes (it does not shift when objects decay).
export function sampleRecords(records, every) {
  if (!Number.isInteger(every) || every < 1) throw new TypeError('sampleEvery must be a positive integer');
  return records.filter((record) => record.NORAD_CAT_ID % every === 0);
}

export function layerRow(record) {
  return LAYER_FIELDS.map((field) => record[field]);
}

export function rowRecord(row) {
  return Object.fromEntries(LAYER_FIELDS.map((field, index) => [field, row[index]]));
}
