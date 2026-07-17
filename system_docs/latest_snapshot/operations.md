# Latest snapshot operations

## Runtime components

The active components are:

- Cloud Run builder: `workers/uk_aq_latest_snapshot_cloud_run/`;
- builder local-cache helper: `workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts`;
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

The all-only and warm-cache amendments did not change the schedule.

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

`run_service.ts` remains the long-running HTTP parent and starts a fresh `run_job.ts` child for each accepted invocation. The parent and child share the container filesystem, allowing successive children in the same warm container to reuse `/tmp`. The local cache MUST NOT be implemented by removing the child-process boundary.

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

### Warm local cache

- `UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED`, default `true`;
- `UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_DIR`, default `/tmp/uk-aq-latest-snapshot-cache`.

The cache is disposable and bounded to three known durable objects. It has no eviction or retention process.

Setting:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
```

restores the direct R2 load path without deleting or migrating any data.

A custom cache directory is mainly useful for local execution. Production should normally retain the `/tmp` default.

### Run reports

- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE`, default `failures`;
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED`, legacy fallback only.

Accepted modes:

```text
all
failures
off
```

Resolution order:

1. explicit valid `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE`;
2. explicit legacy boolean when the new mode is absent;
3. default `failures`.

Legacy mapping:

```text
true  -> all
false -> off
```

An invalid explicit new mode fails configuration rather than silently changing behaviour.

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

Persistent state and metadata:

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
```

Conditional diagnostic reports:

```text
latest_snapshots/v2/_runs/{timestamp}.json
```

With the default `failures` mode, a normal successful scheduled run does not create the timestamped object. Existing reports are retained.

Old finite-window objects may remain after cutover. They are not read or updated and are not current recovery or fallback paths.

## Current local files

When enabled, the builder may maintain:

```text
/tmp/uk-aq-latest-snapshot-cache/{sha256-of-r2-key}.bin
/tmp/uk-aq-latest-snapshot-cache/{sha256-of-r2-key}.json
```

for latest state, the core metadata cache and the physical manifest only.

The `.json` sidecar records the full R2 key, R2 ETag and local body SHA-256. Local files can be deleted at any time. They must not be backed up, restored or copied between containers.

## Normal builder run sequence

1. Validate v2 paths and required configuration.
2. Resolve warm-cache and run-report settings.
3. Try to load the previous physical manifest from a locally valid copy, otherwise use R2 GET.
4. Try to load latest-valid state from a locally valid copy, otherwise use R2 GET.
5. Try to load the core metadata cache from a locally valid copy, otherwise use R2 GET.
6. Apply the existing metadata freshness check and refresh from core snapshots when required.
7. Pull and decode observation messages.
8. Resolve each decoded row to a supported pollutant and apply current-value eligibility.
9. Apply only eligible rows to state.
10. Persist changed state to R2, then update its local copy.
11. Acknowledge successfully handled decoded messages.
12. Build metadata-eligible v2 source rows.
13. Group source rows by pollutant.
14. Sort and build one `window=all` payload per pollutant.
15. Write changed physical objects.
16. Write the three-entry physical manifest to R2, then update its local copy.
17. Resolve and optionally write the R2 run report.
18. Emit the structured job summary with cache and report-decision telemetry.

Acknowledgement MUST NOT move ahead of failed durable state handling. Local cache writes do not gate acknowledgement.

## Warm-cache behaviour

### Cold or missing cache

A missing body or sidecar is a cold miss. The builder performs the normal R2 GET and attempts to store the returned bytes and ETag locally.

### Warm hit

A hit requires:

- valid sidecar and JSON body;
- matching local SHA-256;
- successful R2 HEAD;
- matching current R2 ETag.

A HEAD request is still made for every attempted local reuse. The optimisation saves repeated R2 body downloads, not all R2 requests.

### R2 mismatch or external update

If the R2 object is missing, has no usable ETag or has a different ETag, the local copy is not used. The normal R2 GET path refreshes it when possible.

### Local corruption or write failure

Invalid sidecars, invalid JSON, local hash failures and local I/O errors are treated as misses or warnings. They do not make `/tmp` authoritative and do not hide an R2 failure.

### Metadata expiry

A valid local metadata body is still parsed and checked against `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS`. Local caching cannot extend its effective lifetime.

## Run-report behaviour

### `failures`, current default

- successful scheduled run: no R2 `_runs` object;
- completed scheduled run with failed matrix items: report written;
- completed manual run: report written whether successful or failed.

### `all`

Preserves the previous behaviour of one R2 report for every completed run.

### `off`

Writes no R2 run-report object.

In all modes:

- the manifest is still written according to its existing rules;
- `latest_snapshot_job_summary` remains logged for every completed build;
- report creation does not decide build success or failure;
- early exceptions before build completion remain visible in service logs and status rather than a newly invented report object.

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

Builder reporting exposes:

- pulled, decoded, malformed and acknowledged message counts;
- new and newer valid state applications;
- older and duplicate skips;
- invalid current-value skips;
- state transition count and state-write result;
- metadata refresh status;
- missing metadata count;
- physical snapshot success, failure, changed and unchanged counts;
- total duration and trigger mode;
- local-cache counters;
- resolved report mode and source;
- report write decision and reason.

A normal fully successful physical build reports `success_count=3` and `failure_count=0`.

Skipped invalid values and local cache misses are operational information, not automatically a failed run.

Normal cache telemetry after a new revision may show cold misses. A later invocation in the same warm container may show warm hits. Cloud Run may replace a container at any time, so a later cold miss is not itself a defect.

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

When investigating the warm cache, also inspect the `local_cache` summary:

- repeated `cold_miss` without any `warm_hit` may simply indicate container replacement;
- `fingerprint_mismatch` should cause an R2 refresh;
- `corrupt`, `validation_error`, `write_failure` or `skipped_missing_etag` should be investigated if persistent;
- disabling the cache is the first configuration-only diagnostic step.

When investigating run reports, inspect `run_reports.mode`, `source`, `write` and `reason` in the structured summary before treating a missing `_runs` object as a failure.

## Deployment order

For the warm-cache and run-report amendment, only the Cloud Run builder changes. Use the existing Cloud Run deployment workflow and retain:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=failures
```

No R2 API Worker deployment is required unless its own code changes.

For a future architecture change involving both the deriving Worker and builder:

1. deploy the R2 API Worker first;
2. confirm one representative finite response;
3. deploy the Cloud Run builder;
4. observe one normal scheduled run;
5. confirm one website output.

## Rollback

### Configuration-only rollback for this amendment

The two features are independently reversible:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

After redeployment this restores direct R2 body loads and the former every-completed-run report policy. It does not alter latest state, metadata, snapshots, manifest or old reports.

Local `/tmp` files need no cleanup and disappear with the container.

### Code rollback

Restore the previous Cloud Run revision. Make one representative normal request after the rollback.

### All-only architecture rollback

If both the all-only builder and deriving Worker must be rolled back:

1. roll back the builder first so old finite objects resume being updated;
2. roll back the R2 API Worker;
3. confirm the previous public route works.

Rollback does not modify latest state or raw observations.

## TEST validation policy

This is a TEST system. For reversible changes, perform only the smallest structural check before deployment. Functional validation should normally use one successful normal operation and one representative output check. Do not add broad suites, all-window comparisons, shadow mode or soak testing unless explicitly requested.

For the warm cache, one cold/miss path and one confirmed warm hit in the same container are sufficient when available. For reporting, one successful scheduled run with `reason=scheduled_success` and no new `_runs` object is sufficient. Do not induce a failure merely to test failure reporting.

State recovery procedures are defined in [`recovery.md`](recovery.md).
