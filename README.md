# Orbital Policy Simulator public data

Public data feed for the Orbital Policy Simulator on projects.brandonernst.com. A scheduled GitHub Action collects a small, cited subset of public orbital and space weather data and publishes it on the append-only `public-data` branch, which browsers read from `raw.githubusercontent.com`. See [NOTICE.md](NOTICE.md) for credits and limits: the data is a subset, not a catalog mirror, and it is not for conjunction assessment.

## Reading the data

Start at the manifest:

```
https://raw.githubusercontent.com/brand-on-fire/orbital-policy-simulator-data/public-data/manifest.json
```

`manifest.json` lists every current file with its `path`, `sha256`, `bytes`, `objectCount`, `retrievedAt`, epoch range and source URLs. Every data file is content-addressed (`<directory>/<sha256>.json`, canonical JSON), so a client verifies the hash before use and an unchanged file never produces a new blob. The previous generation of each file is kept in the tree so a cached manifest still resolves.

| Manifest id | Directory | Contents | Refresh |
|---|---|---|---|
| `roster` | `roster/` | 38 catalog numbers plus SCS-01 A to M (INTDES 2025-100) and AETHER-3 to 12 (INTDES 2026-004), full OMM per object with a status (`current`, `retained`, `stale-elements`, `decaying`, `quarantined`) | 6 h |
| `stations` | `stations/` | SupGP ISS-E and CSS-E: 6-hour segments fitted forward (planned maneuvers included) | 6 h |
| `shells:<group>` | `shells/` | Every object in the group binned by altitude and inclination: counts, means and representative plane RAANs | daily |
| `layer-sampled:<group>` | `layers-sampled/` | Columnar elements for catalog numbers divisible by `sampleEvery` (every 10th Starlink; small constellations in full) | daily |
| `satcat:roster`, `satcat-layer:<group>` | `satcat/` | SATCAT owner, launch site, launch date, status and decay for the roster and the sampled layers | weekly |
| `spaceweather:kp`, `:f107`, `:cycle` | `spaceweather/` | NOAA SWPC planetary Kp, F10.7 flux, predicted solar cycle | 3 h, daily, weekly |

Groups: starlink, oneweb, kuiper, qianfan, hulianwang (Guowang), gps-ops, glo-ops, galileo, beidou. `manifest.withheld` lists the catalogued objects whose elements are withheld (NEA); they are never requested.

`status.json` reports the last run: `outcome` (`complete`, `degraded`, `failed`, `no-sources-due`), `scheduleGuarantee: false`, run provenance, the CelesTrak block (requests, counted errors, halt state, quarantine) and every source's health. Collection is best effort: GitHub's scheduler is not a guarantee, so the app shows data age instead of promising a cadence. A tick where nothing is due makes no commit.

## How collection works

- `.github/workflows/collect.yml` ticks at minutes 17 and 47. It runs only in this exact public repository on its default branch, with top-level `contents: read` and job-level `contents: write`, one concurrency group without cancellation, no secrets, no cache, no artifacts and a standard runner.
- Node 22 on the runner, no install step. SGP4 is the vendored satellite.js 7.1.0 bundle in `vendor/` (WASM runtimes stubbed), checked against `VENDOR.json` by `scripts/verify-vendor.mjs` before every run.
- `scripts/publish.mjs restore` fetches the last publication and the committed collector state (`state/collector-state.json`) from `public-data`.
- `scripts/collect.mjs` requests only the sources that are due: `now >= lastAttemptAt + max(pollMinutes, backoff)`. CelesTrak sources run in policy order inside a per-run cap of 45 requests; anything that does not fit waits for a later tick. The very first run requests only the roster.
- `scripts/publish.mjs publish` runs the storage guard and pushes an ordinary commit whose parent is the restored head. Nothing is ever force-pushed.

## CelesTrak safety

- Only `https://celestrak.org` (never `.com`), `FORMAT=CSV` only (6-digit catalog numbers exist; TLE cannot carry them), every CelesTrak source polled no more often than every 120 minutes (a test enforces it).
- About 168 requests and 3 to 5 MB per day at most, against CelesTrak's 100 MB per day threshold.
- The first non-200 stops every further CelesTrak request in the run and starts a 120-minute cooldown.
- Every 403 counts as an error; 2 consecutive 403s halt. A 404 quarantines that query. A 301 halts. 3 counted errors (consecutive, or within 24 hours) halt.
- The NEA denylist is hard-coded in `scripts/lib/constants.mjs`; the URL builders and the final request check refuse those catalog numbers and their launch designators.
- A failed run emails the owner through GitHub notifications; that is the "report to a human" path.

**Clearing a halt or a quarantine:** read `status.json` and the run summary, fix the cause, then commit `haltResetAt` in `config/collection-policy.json` as an ISO UTC time that is later than the event and not in the future. Only events before that time are cleared.

## Validation (fail closed, keep last good)

Exact CSV header lock per format, strict RFC 4180 parsing, range checks on every field, epoch sanity (GP no more than 5 minutes ahead, SupGP no more than 15 days), per-object epoch monotonicity, count-drop rejection (more than 10 percent, or 5 objects for 50 or fewer), and SGP4 smoke propagation of every record at retrieval time and +90 minutes (roster objects also at +72 hours to flag decay). Anything that fails keeps the last good data; `status.json` is still published.

## Storage and keepalive

- The storage guard allows only the published paths, refuses symlinks, checks every manifest hash and size, and stops with "MAINTENANCE REQUIRED" at a 10 MiB payload or 200 MiB repository size (layers stop at 150 MiB). Storage is never paid for.
- GitHub disables schedules in public repositories after 60 days without activity. The job commits `keepalive/HEARTBEAT.md` to `main` at most once every 30 days (outside the push path filter, so it never triggers a run).

## Development

```bash
node scripts/verify-vendor.mjs
```

```bash
node --test tests/*.test.mjs
```

Tests are offline and use fixtures with provenance in `tests/fixtures/PROVENANCE.json` (real CelesTrak and SWPC captures from 2026-10-15). The publish commands refuse to run outside the approved GitHub workflow.
