# Latest snapshot operations

## Runtime components

The active components are:

- Cloud Run builder: `workers/uk_aq_latest_snapshot_cloud_run/`;
- private R2 API Worker: `workers/uk_aq_latest_snapshot_r2_api_worker/`;
- cache-proxy route boundary: `workers/uk_aq_cache_proxy/src/index.ts`.

Deployment workflows:

- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`;
- `.github/workflows/uk_aq_cache_proxy_deploy.yml`.

## Normal schedule

The builder is triggered every minute through Cloud Scheduler by default.

Current defaults:

- cron `* * * * *`;
- timezone `Etc/UTC`;
- scheduler retries `0`.

The all-only cutover did not change the schedule.

## Cloud Run resource and overlap safety

The service uses an in-memory overlap lock and MUST run with exactly one maximum Cloud Run instance.

Current defaults:

- CPU `0.25`;
- memory `256Mi`;
- concurrency `1`;
- maximum instances `1`;
- minimum instances `0`;
- request timeout `300` seconds;
- child timeout `240000` milliseconds.

The child timeout must remain at least 30 seconds below the request timeout. Existing TERM/KILL escalation and request timeouts remain load-bearing.

## Configuration

### Physical matrix and contract

- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS`, default `pm25,pm10,no2`;
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP`, default `all`;
- `UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION`, required `v2`.

The builder's physical window is code-owned as `all`. `UK_AQ_LATEST_SNAPSHOT_WINDOWS` is no longer a builder variable and is not passed by the deployment workflow.

Public accepted windows remain code-owned by the R2 API Worker:

```text
3h, 6h, 1d, 7d, all
```

### R2 layout

- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY`;
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX`.

### Pub/Sub and metadata

- `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION`;
- `OBSERVS_PUBSUB_SUBSCRIPTION`, used only for the subscription safety comparison;
- `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS`.

The Latest Snapshot subscription must be dedicated and must not equal the raw observs-writer subscription.

### R2 API Worker

- `UK_AQ_EDGE_UPSTREAM_SECRET`;
- R2 binding `UK_AQ_HISTORY_BUCKET`;
- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX`, canonical `latest_snapshots/v2`;
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY`, canonical `latest_snapshots/v2/manifest.json`;
- `UK_AQ_LATEST_SNAPSHOT_R2_CACHE_MAX_AGE_SECONDS`, default `60`.

The Worker fails closed if the standard prefix or manifest key is configured outside the canonical v2 paths.

## Current R2 objects

Persistent state:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

Current physical snapshot family:

```text
latest_snapshots/v2/manifest.json
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
latest_snapshots/v2/_runs/{timestamp}.json
```

Old finite-window objects may remain after cutover. They are not read or updated and are not current recovery or fallback paths.

## Normal builder run sequence

1. Validate v2 paths and required configuration.
2. Load the previous physical manifest.
3. Load latest-valid state.
4. Load or refresh core metadata before pulling messages.
5. Pull and decode observation messages.
6. Resolve each decoded row to a supported pollutant and apply current-value eligibility.
7. Apply only eligible rows to state.
8. Persist changed state.
9. Acknowledge successfully handled decoded messages.
10. Build metadata-eligible v2 source rows.
11. Group source rows by pollutant.
12. Sort and build one `window=all` payload per pollutant.
13. Write changed physical objects.
14. Write the three-entry physical manifest and optional run report.

Acknowledgement MUST NOT move ahead of failed state handling.

## Normal API request sequence

For every accepted request, the R2 API Worker reads the pollutant's physical `window=all` object.

### `window=all`

- return the physical object directly;
- retain its ETag and object metadata;
- return the v2 contract marker.

### Finite windows

- floor current time to the start of the UTC minute;
- calculate the requested cutoff;
- filter by parseable `last_value_at` with an inclusive cutoff;
- preserve row order;
- recalculate `window`, `count`, `next_since` and `next_since_id`;
- derive an ETag from source ETag, window and effective minute;
- return the v2 contract marker.

A malformed physical payload returns `invalid_snapshot_payload`. There is no old finite-object or v1 fallback.

## Operational telemetry

Builder reporting should expose:

- pulled, decoded, malformed and acknowledged message counts;
- new and newer valid state applications;
- older and duplicate skips;
- invalid current-value skips;
- state transition count and state-write result;
- metadata refresh status;
- missing metadata count;
- physical snapshot success, failure, changed and unchanged counts;
- total duration and trigger mode.

A normal fully successful physical build reports `success_count=3` and `failure_count=0`.

Skipped invalid values are operational information, not automatically a failed run.

## Routine checks

When snapshots are missing or stale, check:

1. builder invocation status and structured logs;
2. dedicated Pub/Sub backlog;
3. latest-state object timestamp and entry count;
4. metadata-cache source day;
5. manifest generation time, `matrix.windows`, entry count and per-key errors;
6. existence of the three physical `all` objects;
7. R2 API health and v2 marker;
8. one representative finite response and its `last_value_at` cutoff;
9. cache-proxy upstream status;
10. website map or search output.

## Deployment order for this architecture

When both components must change:

1. deploy the R2 API Worker first, because existing physical `all` objects can immediately support every public window;
2. confirm one representative finite response;
3. deploy the Cloud Run builder;
4. observe one normal scheduled run;
5. confirm one website output.

## Rollback order

If only the new Worker has been deployed, roll back the Worker.

If both the all-only builder and deriving Worker have been deployed:

1. roll back the builder first so old finite objects resume being updated;
2. roll back the R2 API Worker;
3. confirm the previous public route works.

Rollback does not modify latest state or raw observations.

## TEST validation policy

This is a TEST system. For reversible changes, perform only the smallest structural check before deployment. Functional validation should normally be one successful normal operation and one representative output check. Do not add broad suites, all-window comparisons, shadow mode or soak testing unless explicitly requested.

State recovery procedures are defined in [`recovery.md`](recovery.md).