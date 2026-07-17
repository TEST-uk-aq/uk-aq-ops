# Latest snapshot data flow

## Overview

```text
Connector ingest
  -> shared observation Pub/Sub topic
      -> raw observation consumer subscription
          -> raw observs/history systems
      -> dedicated latest-snapshot subscription
          -> Latest Snapshot Cloud Run builder
              -> R2 latest-valid state (durable)
              -> R2 core metadata cache (durable)
              -> R2 physical family manifest (durable)
              -> optional validated /tmp copies while container is warm
              -> three physical pollutant/all snapshots in R2
              -> conditional R2 run report
                  -> Latest Snapshot R2 API Worker
                      -> direct all response or derived finite response
                          -> cache proxy /api/aq/latest-snapshot
                              -> website map and search
```

The shared topic may have multiple consumers. Subscription state is not shared. The Latest Snapshot builder MUST use its dedicated subscription.

R2 remains authoritative for state, metadata and the physical manifest. The local filesystem is an optional read-through and write-through optimisation only.

## Stage 1: observation publication

Connector ingestion publishes source observation rows.

The publisher transports source data. It does not decide whether a value is eligible to become latest public state. Negative, sentinel and otherwise invalid source values remain publishable so raw consumers can preserve what the source supplied.

## Stage 2: dedicated Pub/Sub pull

### Component

`workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`

### Behaviour

The builder pulls from `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION`, defaulting to `uk-aq-latest-snapshot-sub`.

The configured subscription MUST differ from `OBSERVS_PUBSUB_SUBSCRIPTION` when that variable is present.

The pull loop:

- requests up to 1,000 messages per pull;
- performs up to 8 pull batches per run;
- decodes Base64 JSON payloads;
- requires positive integer `connector_id` and `timeseries_id`;
- requires a parseable `observed_at`;
- accepts `value=null` or a finite numeric value at decode time;
- acknowledges malformed messages separately;
- holds successfully decoded message acknowledgement until state handling succeeds.

Decode validity and current-value eligibility are separate. A decoded `-99` row is well formed but is not eligible for latest pollutant state.

## Stage 3: durable-object load and local-cache validation

### Components

- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`
- `workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts`

Before using latest state, the core metadata cache or the previous physical manifest, the builder may try a local cached copy.

For each local candidate:

1. derive a deterministic local filename from the SHA-256 of the full R2 key;
2. read the cached body and sidecar;
3. validate sidecar schema, object key and local body SHA-256;
4. confirm the body parses as JSON;
5. HEAD the R2 object;
6. require the R2 object to exist and its ETag to match the sidecar ETag;
7. reuse the local bytes only when every check succeeds.

On a cold start, missing file, corrupt file, validation error, absent ETag or ETag mismatch, the builder uses the normal R2 GET path. A successful R2 GET may then populate the local cache.

The builder does not use an unvalidated stale local copy when R2 validation fails.

## Stage 4: metadata resolution

Before pulling messages, the builder loads or refreshes the core metadata index needed to classify incoming observations.

The index resolves:

```text
timeseries -> phenomenon -> observed_property
timeseries -> station -> network
timeseries / station -> connector
```

Loading metadata before the pull prevents an unavailable metadata source from consuming or acknowledging messages that cannot be classified safely.

A local metadata-cache hit does not bypass the existing `generated_at` freshness check. When the configured refresh interval has expired, the normal core-snapshot refresh path still runs.

## Stage 5: latest-valid state application

### Identity

`(connector_id, timeseries_id)`

### Processing order

1. Load existing state through the durable-object path.
2. Load or refresh core metadata through the durable-object path.
3. Pull and decode observation messages.
4. Resolve each decoded row to its observed property and supported matrix pollutant.
5. Apply the latest-current-value policy.
6. Apply only eligible rows to state using timestamp ordering.
7. Persist changed state to R2.
8. After successful R2 persistence, update the local state cache.
9. Acknowledge successfully handled decoded messages.

For a well-formed invalid row:

- raw history remains unaffected;
- no latest-state entry is created or replaced;
- telemetry records the skip;
- the message is acknowledged after successful handling;
- the previous valid state remains available.

## Stage 6: state persistence

### Key

```text
latest_snapshots_state/v1/latest_state.json
```

### Behaviour

- state entries are sorted by connector and timeseries identity;
- serialisation is deterministic;
- a SHA-256 hash is calculated;
- the R2 object is written only when state bytes change;
- the schema remains version `1`;
- local write-through occurs only after the R2 PUT succeeds;
- a local write failure produces a warning but does not replace R2 durability.

Pub/Sub acknowledgement does not depend on a local cache write.

## Stage 7: core metadata cache

### Source

The latest committed core snapshot under `history/v2/core` within the configured lookback.

### Required tables

- `connectors`;
- `networks`;
- `stations`;
- `timeseries`;
- `phenomena`;
- `observed_properties`.

### R2 key

```text
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

The R2 cache is refreshed when missing, invalid or older than the configured refresh interval, currently 86,400 seconds by default. After the refreshed object is written to R2, the same bytes and returned ETag may be stored locally.

## Stage 8: public source-row construction

For each retained valid state entry, the builder:

1. resolves timeseries and pollutant metadata;
2. confirms value eligibility as defence in depth;
3. resolves station, connector and network metadata;
4. applies network visibility and geography eligibility;
5. builds the v2 latest row;
6. exposes state `observed_at` as row `last_value_at`.

Missing required metadata is counted and skipped. Connector-derived network fallbacks are not used.

## Stage 9: physical snapshot generation

The builder groups source rows by pollutant once and creates one physical payload for each supported pollutant.

For each of `pm25`, `pm10` and `no2` it:

1. selects that pollutant's rows;
2. sorts them using the existing ordering;
3. derives the existing next cursor;
4. sets `window` to `all`;
5. stable-JSON serialises and hashes the payload;
6. writes the object only when its hash changed.

Physical keys are:

```text
latest_snapshots/v2/network_group=all/pollutant={pollutant}/window=all.json
```

The builder does not calculate or write finite-window objects. The warm local cache does not cache these physical pollutant objects inside the builder.

## Stage 10: physical manifest

The manifest describes stored products only.

A fully successful manifest contains:

- `matrix.pollutants = [pm25, pm10, no2]`;
- `matrix.windows = [all]`;
- three snapshot entries;
- per-object hashes, row counts, byte counts and observed-at bounds;
- source, state, timing, changed and error information.

A failed pollutant preserves its previous physical `all` entry when one exists.

The previous manifest may be read from a validated local copy. The new manifest is always written to R2 before its local copy is replaced.

## Stage 11: run-report decision

After the manifest is written, the builder resolves whether to write a timestamped R2 run report.

The resolved mode is:

- `all`: every completed run;
- `failures`: every completed manual run and every completed run with one or more failed matrix items;
- `off`: no run-report object.

The default is `failures`. A successful scheduled run therefore skips the `_runs` write.

Regardless of mode, every completed build emits `latest_snapshot_job_summary` with:

- the normal build report;
- local cache counters;
- resolved report mode and configuration source;
- report write decision and reason.

Run-report creation does not determine manifest success or final build status.

## Stage 12: private R2 API Worker

### Component

`workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`

### Source selection

Every accepted request reads the requested pollutant's physical `window=all` object.

### `window=all`

The Worker returns the stored object directly, including its physical ETag.

### Finite windows

For `3h`, `6h`, `1d` and `7d`, the Worker:

1. calculates the start of the current UTC minute;
2. subtracts the requested window duration;
3. filters rows where parseable `last_value_at >= cutoff`;
4. preserves physical row order;
5. changes the response `window`;
6. recalculates `count`, `next_since` and `next_since_id`;
7. preserves all other v2 fields.

The finite response ETag is derived from the physical object ETag, requested window and effective UTC minute. This allows rows to age out without a new physical object write.

The Worker validates authentication and v2 paths, returns the v2 contract marker, fails closed on malformed physical payloads, and never falls back to v1 or old finite objects.

## Stage 13: cache proxy and website

The cache proxy route is:

```text
/api/aq/latest-snapshot
```

It forwards the unchanged public query to `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`, retains the existing private v2 cache-key namespace, and requires a successful upstream v2 contract marker.

The website continues requesting `3h`, `6h`, `1d`, `7d` or `all` without knowing whether the representation is physically stored or derived.
