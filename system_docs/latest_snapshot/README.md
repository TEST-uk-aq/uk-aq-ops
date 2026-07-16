# Latest snapshot system area

## Purpose

This directory is the authoritative documentation for the UK AQ latest-snapshot pipeline used by the website map and station search.

The system consumes observation messages through a dedicated Pub/Sub subscription, maintains latest-valid-per-timeseries state in R2, generates deterministic pollutant/window snapshot objects, serves them through a private R2 API Worker, and exposes them to the website through the cache proxy.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`data_flow.md`](data_flow.md)
3. [`state_model.md`](state_model.md)
4. [`interfaces.md`](interfaces.md)
5. [`operations.md`](operations.md)
6. [`validation.md`](validation.md)
7. Relevant files under [`decisions/`](decisions/)

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

## Current matrix

- Pollutants: `pm25`, `pm10`, `no2`
- Windows: `3h`, `6h`, `1d`, `7d`, `all`
- Network group: `all`
- Public snapshot contract: `v2`

## Current object families

- Snapshot objects: `latest_snapshots/v2/...`
- Family manifest: `latest_snapshots/v2/manifest.json`
- Optional run reports: `latest_snapshots/v2/_runs/...`
- Latest state: `latest_snapshots_state/v1/latest_state.json`
- Core metadata cache: `latest_snapshots_state/v1/core_metadata_cache_v2.json`

## Known implementation defect at document creation

As of 16 July 2026, the current builder applies a newer decoded observation to latest state before applying pollutant value eligibility. A newer negative value can therefore replace a valid state row and then be removed only while snapshot rows are built.

The result is that the timeseries disappears from all generated snapshots, including `window=all`, because the previous valid state row has already been lost.

The authoritative required behaviour is defined in [`contract.md`](contract.md):

- invalid pollutant observations remain available in raw storage;
- invalid pollutant observations MUST NOT create or replace latest-snapshot state;
- the previous valid state row MUST remain current until a newer valid observation arrives;
- snapshot row and API contracts MUST otherwise remain unchanged.

This documentation records the intended behaviour before the implementation fix so the fix can be reviewed against an explicit contract.

## Documentation migration

The previous broad document `system_docs/uk-aq-latest-snapshot.md` contained architecture, interface, environment, troubleshooting and bootstrap material in one file.

Its current content is being split into this area so that:

- required behaviour is separated from operational instructions;
- state transitions are explicit;
- public interfaces are protected from accidental changes;
- decision rationale is retained separately;
- future implementation work has one authoritative reading order.

Worker-local READMEs remain implementation guides and should link back to this directory when they are next updated.
