// Fixed identities and formats. Anything a human may tune lives in config/;
// anything that protects CelesTrak or the publication contract lives here.

export const REPOSITORY = 'brand-on-fire/orbital-policy-simulator-data';
export const DATA_BRANCH = 'public-data';
export const DEFAULT_BRANCH = 'main';

export const CELESTRAK_ORIGIN = 'https://celestrak.org';
export const SWPC_ORIGIN = 'https://services.swpc.noaa.gov';
export const ALLOWED_HOSTS = Object.freeze(['celestrak.org', 'services.swpc.noaa.gov']);

// Catalogued objects whose elements are withheld (SATCAT DATA_STATUS_CODE NEA).
// A request for one returns HTTP 404, which CelesTrak counts toward its firewall
// threshold, so no GP or SATCAT URL may ever name these numbers.
export const NEA_DENYLIST = Object.freeze([37348, 39232, 43941, 43866, 63156, 36608, 45860, 56083, 65432]);

// Launch designators of the denylisted objects. An INTDES query for one of these
// launches would return the withheld object's SATCAT record, so INTDES is refused too.
export const NEA_LAUNCH_DESIGNATORS = Object.freeze([
  '2011-002', // USA 224
  '2013-043', // USA 245
  '2019-004', // USA 290
  '2018-106', // CSO-1
  '2025-044', // CSO-3
  '2010-031', // OFEQ 9
  '2020-044', // OFEQ 16
  '2023-044', // OFEQ 13
  '2025-193', // OFEQ 19
]);

export const GP_HEADER = Object.freeze([
  'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID',
  'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
]);

// SupGP CSV carries the GP columns plus the fit residual and the data source.
export const SUPGP_HEADER = Object.freeze([...GP_HEADER, 'RMS', 'DATA_SOURCE']);

export const SATCAT_HEADER = Object.freeze([
  'OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'OBJECT_TYPE', 'OPS_STATUS_CODE', 'OWNER', 'LAUNCH_DATE',
  'LAUNCH_SITE', 'DECAY_DATE', 'PERIOD', 'INCLINATION', 'APOGEE', 'PERIGEE', 'RCS', 'DATA_STATUS_CODE',
  'ORBIT_CENTER', 'ORBIT_TYPE',
]);

// Columns published in the columnar sampled layers: exactly what json2satrec reads, plus labels.
export const LAYER_FIELDS = Object.freeze([
  'NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
]);

export const SATCAT_LAYER_FIELDS = Object.freeze([
  'NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'OBJECT_TYPE', 'OPS_STATUS_CODE', 'OWNER', 'LAUNCH_DATE',
  'LAUNCH_SITE', 'DECAY_DATE',
]);

export const GP_CITATION = 'GP/SATCAT: USSPACECOM via Space-Track.org, distributed by CelesTrak (celestrak.org)';
export const SWPC_CITATION = 'Space weather: NOAA Space Weather Prediction Center (services.swpc.noaa.gov)';

export const CONTENT_DIRECTORIES = Object.freeze(['roster', 'stations', 'satcat', 'spaceweather', 'shells', 'layers-sampled']);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
