# Latest snapshot system area

## Purpose

This directory is the authoritative documentation for the UK AQ latest-snapshot pipeline used by the website homepage, map and station search.

The system consumes observation messages through a dedicated Pub/Sub subscription, maintains latest-valid-per-timeseries state in R2, publishes one physical `window=all` snapshot per supported pollutant, and serves the public finite windows through the private R2 API Worker. The cache proxy exposes the unchanged v2 API to the website.

The Cloud Run builder may reuse validated container-local copies of its durable state, metadata-cache and manifest objects while a container remains warm. R2 remains the durable authority. Successful scheduled builds do not create a permanent R2 run-report object by default, while structured logging remains available for every completed run.

R2 History Integrity may also supply final verified observation candidates through the authenticated owner-service boundary defined in [`integrity_reconciliation.md`](integrity_reconciliation.md). Integrity does not write Latest Snapshot R2 state or products directly.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`integrity_reconciliation.md`](integrity_reconciliation.md) for final verified candidates supplied by R2 History Integrity
3. [`homepage-consumer-contract.md`](homepage-consumer-contract.md) for the public homepage `Highest sensor readings` refresh and layout behaviour
4. [`data_flow.md`](data_flow.md)
5. [`state_model.md`](state_model.md)
6. [`interfaces.md`](interfaces.md)
7. [`operations.md`](operations.md)
8. [`recovery.md`](recovery.md)
9. [`validation.md`](validation.md)
10. Relevant files under [`decisions/`](decisions/)

For Integrity reconciliation changes, also read:

- [`../r2_history/current_state_reconciliation.md`](../r2_history/current_state_reconciliation.md);
- [`decisions/0004-integrity-reconciliation-through-owner-service.md`](decisions/0004-integrity-reconciliation-through-owner-service.md).

## Implementation ownership

This area governs the behaviour of:

- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`;
- `workers/uk_aq_latest_snapshot_cloud_run/run_service.ts`;
- `workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts`;
- `workers/uk_aq_latest_snapshot_cloud_run/Dockerfile`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/wrangler.toml`;
- the `/api/aq/latest-snapshot` boundary in `workers/uk_aq_cache_proxy/src/index.ts`;
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`;
- latest-snapshot state seed, repair and rebuild scripts under `scripts/backup_r2/`;
- the authenticated Integrity reconciliation operation in the existing Latest Snapshot Cloud Run service;
- the public homepage latest-readings consumer in `TEST-uk-aq/TEST-uk-aq.github.io/index.html` and `dashboard.js`, within the limits defined by [`homepage-consumer-contract.md`](homepage-consumer-contract.md).

The raw observation publisher and raw observation-history writer are upstream systems. They are not owned by this area and MUST continue preserving source observations, including invalid or sentinel values.

## Current contracts

### Public request matrix

- Pollutants: `pm25`, `pm10`, `no2`
- Windows: `3h`, `6h`, `1d`, `7d`, `all`
- Network group: `all`
- Public snapshot contract: `v2`

### Homepage consumer

- The `Highest sensor readings` dashboard uses the existing six-hour finite latest-snapshot responses.
- Its automatic refreshes align to wall-clock five-minute boundaries only while the document is visible and the browser window is focused.
- It does not perform periodic refreshes while hidden or unfocused.
- It performs one immediate catch-up refresh on becoming active when the previous dashboard request cycle is older than five minutes.
- Manual and focus-triggered refreshes may occur off-boundary without changing the next normal boundary.
- The top-right refresh control reuses the hex map button treatment, while the network selector sits in a lower controls row.

### Physical R2 matrix

The builder stores exactly three current snapshot objects:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

The R2 API Worker reads the relevant physical `all` object for every request. It returns `window=all` directly and derives `3h`, `6h`, `1d` and `7d` responses from `last_value_at`.

The physical manifest describes only the three stored objects. Public finite responses are virtual API representations and are not manifest entries.

### Integrity reconciliation

- Integrity supplies only final verified canonical candidates after the R2 History verification boundary.
- The existing Latest Snapshot Cloud Run service remains the sole durable-state and product writer.
- Reconciliation applies only to `pm25`, `pm10` and `no2`.
- Older candidates cannot replace newer state.
- Identical same-timestamp canonical content is a no-op.
- A different final verified same-timestamp value, binary value identity or status may be applied once as a correction.
- Retrying the same correction is a no-op.
- Public v2 routes, fields and finite-window behaviour do not change.

### Durable authority and warm local cache

R2 remains authoritative for:

- `latest_snapshots_state/v1/latest_state.json`;
- `latest_snapshots_state/v1/core_metadata_cache_v2.json`;
- `latest_snapshots/v2/manifest.json`.

When enabled, the Cloud Run builder keeps disposable copies of those three objects under `/tmp/uk-aq-latest-snapshot-cache` while its container remains warm. A local copy is reused only when:

- its sidecar matches the expected R2 key;
- its local SHA-256 matches its body;
- the body is valid JSON;
- the current R2 ETag still matches the sidecar ETag.

Cold starts, missing or corrupt files, ETag mismatches and validation failures fall back to the normal R2 load path. Durable R2 writes complete before local write-through.

### Run-report policy

`UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE` accepts:

- `all`: write a report for every completed run;
- `failures`: write reports for completed runs with failed matrix items and every completed manual run;
- `off`: do not write R2 run-report objects.

The default is `failures`. A successful scheduled run therefore retains its structured `latest_snapshot_job_summary` log and current manifest but creates no `_runs` object.

The older `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` setting is a compatibility fallback only when the new mode is absent. `true` maps to `all` and `false` maps to `off`.

## Current object families

- Physical snapshot objects: `latest_snapshots/v2/network_group=all/pollutant={pollutant}/window=all.json`
- Physical family manifest: `latest_snapshots/v2/manifest.json`
- Conditional run reports: `latest_snapshots/v2/_runs/...`
- Latest state: `latest_snapshots_state/v1/latest_state.json`
- Core metadata cache: `latest_snapshots_state/v1/core_metadata_cache_v2.json`

Old finite-window R2 objects may remain from the previous architecture. They are inert historical artefacts, are not updated, and MUST NOT be used as runtime fallbacks.

## Current implementation status

As of 29 July 2026:

- decoded observations are resolved and checked against the latest-current-value policy before they can replace state;
- invalid or sentinel pollutant values do not create or replace latest state;
- the previous valid state row remains until a newer valid row arrives;
- the builder publishes only the three physical `all` objects;
- the R2 API Worker derives finite windows at request time;
- the builder uses an optional ETag-validated local cache for state, metadata cache and the previous manifest;
- R2 remains the durable authority and local cache failures remain non-authoritative;
- the default run-report mode is `failures`, so successful scheduled runs do not create per-minute `_runs` objects;
- the public v2 route, parameters and response fields remain unchanged;
- the TEST backend implementation is reported complete;
- the homepage consumer refresh and layout behaviour is approved in [`homepage-consumer-contract.md`](homepage-consumer-contract.md) and is pending implementation;
- Integrity reconciliation through the owner service is approved in [`integrity_reconciliation.md`](integrity_reconciliation.md) and is pending implementation.

## Decisions

- [`0001-latest-valid-observation-state.md`](decisions/0001-latest-valid-observation-state.md): state retains the latest valid pollutant observation.
- [`0002-finite-windows-from-all-snapshot.md`](decisions/0002-finite-windows-from-all-snapshot.md): finite public windows are derived from the physical `all` snapshot.
- [`0003-warm-local-cache-and-run-report-policy.md`](decisions/0003-warm-local-cache-and-run-report-policy.md): validated container-local copies reduce R2 body reads and successful scheduled run reports are omitted by default.
- [`0004-integrity-reconciliation-through-owner-service.md`](decisions/0004-integrity-reconciliation-through-owner-service.md): final verified Integrity candidates are applied only by the existing Latest Snapshot owner service.

## Documentation migration

The previous broad flat document has been replaced by this area structure. Worker-local READMEs remain implementation guides, but they do not override the contract in this directory.
