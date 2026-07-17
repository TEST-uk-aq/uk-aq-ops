# Latest snapshot system area

## Purpose

This directory is the authoritative documentation for the UK AQ latest-snapshot pipeline used by the website map and station search.

The system consumes observation messages through a dedicated Pub/Sub subscription, maintains latest-valid-per-timeseries state in R2, publishes one physical `window=all` snapshot per supported pollutant, and serves the public finite windows through the private R2 API Worker. The cache proxy exposes the unchanged v2 API to the website.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`data_flow.md`](data_flow.md)
3. [`state_model.md`](state_model.md)
4. [`interfaces.md`](interfaces.md)
5. [`operations.md`](operations.md)
6. [`recovery.md`](recovery.md)
7. [`validation.md`](validation.md)
8. Relevant files under [`decisions/`](decisions/)

## Implementation ownership

This area governs the behaviour of:

- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`;
- `workers/uk_aq_latest_snapshot_cloud_run/run_service.ts`;
- `workers/uk_aq_latest_snapshot_cloud_run/Dockerfile`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/wrangler.toml`;
- the `/api/aq/latest-snapshot` boundary in `workers/uk_aq_cache_proxy/src/index.ts`;
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`;
- latest-snapshot state seed, repair and rebuild scripts under `scripts/backup_r2/`.

The raw observation publisher and raw observation-history writer are upstream systems. They are not owned by this area and MUST continue preserving source observations, including invalid or sentinel values.

## Current contracts

### Public request matrix

- Pollutants: `pm25`, `pm10`, `no2`
- Windows: `3h`, `6h`, `1d`, `7d`, `all`
- Network group: `all`
- Public snapshot contract: `v2`

### Physical R2 matrix

The builder stores exactly three current snapshot objects:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

The R2 API Worker reads the relevant physical `all` object for every request. It returns `window=all` directly and derives `3h`, `6h`, `1d` and `7d` responses from `last_value_at`.

The physical manifest describes only the three stored objects. Public finite responses are virtual API representations and are not manifest entries.

## Current object families

- Physical snapshot objects: `latest_snapshots/v2/network_group=all/pollutant={pollutant}/window=all.json`
- Physical family manifest: `latest_snapshots/v2/manifest.json`
- Optional run reports: `latest_snapshots/v2/_runs/...`
- Latest state: `latest_snapshots_state/v1/latest_state.json`
- Core metadata cache: `latest_snapshots_state/v1/core_metadata_cache_v2.json`

Old finite-window R2 objects may remain from the previous architecture. They are inert historical artefacts, are not updated, and MUST NOT be used as runtime fallbacks.

## Current implementation status

As of 17 July 2026:

- decoded observations are resolved and checked against the latest-current-value policy before they can replace state;
- invalid or sentinel pollutant values do not create or replace latest state;
- the previous valid state row remains until a newer valid row arrives;
- the builder publishes only the three physical `all` objects;
- the R2 API Worker derives finite windows at request time;
- the public v2 route, parameters and response fields remain unchanged;
- the TEST deployment is running successfully.

## Decisions

- [`0001-latest-valid-observation-state.md`](decisions/0001-latest-valid-observation-state.md): state retains the latest valid pollutant observation.
- [`0002-finite-windows-from-all-snapshot.md`](decisions/0002-finite-windows-from-all-snapshot.md): finite public windows are derived from the physical `all` snapshot.

## Documentation migration

The previous broad flat document has been replaced by this area structure. Worker-local READMEs remain implementation guides, but they do not override the contract in this directory.