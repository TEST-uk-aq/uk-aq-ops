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

Current scheduling defaults are:

- cron `* * * * *`;
- timezone `Etc/UTC`;
- no scheduler retries.

An invalid-value state fix MUST NOT change the schedule.

## Overlap and timeout safety

The service uses an in-memory overlap lock and therefore MUST run with exactly one maximum Cloud Run instance.

Current defaults are:

- CPU `0.25`;
- memory `256Mi`;
- concurrency `1`;
- maximum instances `1`;
- minimum instances `0`;
- request timeout `300` seconds;
- child timeout `240000` milliseconds.

The child timeout must remain at least 30 seconds below the request timeout.

The invalid-value fix MUST NOT change overlap, concurrency, timeout or process-termination behaviour.

## Main configuration groups

### Matrix and contract

- `UK_AQ_LATEST_SNAPSHOT_POLLUTANTS`;
- `UK_AQ_LATEST_SNAPSHOT_WINDOWS`;
- `UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP`;
- `UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION`.

### R2 object layout

- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY`;
- `UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX`;
- `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX`.

### Pub/Sub and metadata

- `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION`;
- `OBSERVS_PUBSUB_SUBSCRIPTION`, used only for the subscription safety comparison;
- `UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS`.

The latest-snapshot subscription must be dedicated and must not equal the raw observs-writer subscription.

## R2 objects

Persistent state:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

Snapshot family:

```text
latest_snapshots/v2/manifest.json
latest_snapshots/v2/network_group=all/pollutant={pollutant}/window={window}.json
latest_snapshots/v2/_runs/{timestamp}.json
```

The invalid-value fix MUST NOT rename or version these objects.

## Normal run sequence

1. Validate configuration.
2. Load the previous manifest.
3. Load latest state.
4. Pull and decode observation messages.
5. Load or refresh core metadata needed for classification.
6. Apply only eligible valid observations to state.
7. Persist changed state.
8. Acknowledge successfully handled decoded messages.
9. Build metadata-eligible source rows.
10. Build and hash the pollutant/window matrix.
11. Write changed snapshot objects.
12. Write the family manifest and optional run report.

Acknowledgement MUST NOT move ahead of failed state handling.

## Operational telemetry

Run reporting should expose:

- pulled, decoded, malformed and acknowledged message counts;
- new and newer valid state applications;
- older and duplicate skips;
- invalid current-value skips;
- state entry count and state-write status;
- metadata refresh status;
- missing metadata count;
- per-matrix success, failure, changed and unchanged counts;
- total duration and trigger mode.

Skipped invalid values are operational information, not automatically a failed run.

## Failure behaviour

Existing bounded request retries, child timeout and TERM/KILL escalation MUST remain unchanged.

A failed matrix key preserves its previous manifest entry when one exists and records the error.

The API Worker remains v2-only and fail-closed. The cache proxy continues requiring a successful v2 contract marker from the upstream Worker.

## Routine checks

When snapshots are missing or stale, check:

1. builder invocation status and structured logs;
2. dedicated Pub/Sub subscription backlog;
3. latest-state object timestamp and entry count;
4. metadata-cache source day;
5. family manifest generation time and per-key errors;
6. expected snapshot object existence;
7. R2 API health and v2 contract marker;
8. cache-proxy upstream status.

Recovery and state repair are defined separately in [`recovery.md`](recovery.md).
