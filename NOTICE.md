# Notice

This repository publishes a small, curated subset of public orbital and space weather data for the Orbital Policy Simulator (projects.brandonernst.com). It is a subset, not a catalog mirror.

## Orbital elements and catalog data

GP elements (OMM), supplemental GP (SupGP) and SATCAT records: **USSPACECOM via Space-Track.org, distributed by CelesTrak** (celestrak.org).

USSPACECOM has given express blanket approval to redistribute basic SSA data accessed via Space-Track.org (two-line elements and orbital mean-element messages, SATCAT, and decay and reentry data), conditioned on appropriate citation. The citation above is that condition. Source: https://www.space-track.org/documentation#/user_agree

What is collected:

- Only the objects listed in `config/roster.json` and the nine constellation groups listed in `config/layers.json`.
- Constellation groups are published only as shell summaries (counts by altitude and inclination with representative orbital planes) and a deterministic 1-in-N sampled layer. Full group element sets are not republished.
- Objects whose elements are withheld (SATCAT data status NEA) are excluded. The collector never requests them.

## Space weather

Planetary K index, F10.7 cm solar radio flux and the predicted solar cycle: **NOAA Space Weather Prediction Center** (services.swpc.noaa.gov).

## Not for conjunction assessment

These data are not for conjunction assessment. Space-Track.org warns that publicly available element sets should not be used for conjunction assessment prediction. Positions derived from these files are approximate: SGP4 error grows with element age. They are for education and policy illustration only.

## No endorsement

USSPACECOM, Space-Track.org, CelesTrak and NOAA do not endorse this project.

## No delivery guarantee

Collection runs on GitHub's best-effort scheduler. Every file records when it was retrieved, and `status.json` reports the last run and the health of every source.
