# Latest snapshot data flow

## Overview

```text
Connector ingest
  -> shared observation Pub/Sub topic
      -> raw observation consumer subscription
          -> raw observs/history systems
      -> dedicated latest-snapshot subscription
          -> latest-snapshot Cloud Run builder
              -> latest valid state in R2
              -> core metadata cache in R2
              -> snapshot objects in R2
              -> latest family manifest in R2
                  -> latest-snapshot R2 API Worker
                      -> cache proxy /api/aq/latest-snapshot
                          -> website map and search
```

The topic may be shared by multiple consumers. Subscription state is not shared. The latest-snapshot builder MUST use its dedicated subscription.

## Stage 1: observation publication

### Input

Observation rows emitted by connector ingestion.

### Responsibility

The upstream publisher transports source observations. It does not decide whether a value is eligible to become a latest public value.

### Required boundary

Negative, sentinel and otherwise invalid source values remain publishable because raw observation consumers must preserve what the source supplied.

The latest-snapshot fix MUST NOT filter the shared publication stream.

## Stage 2: dedicated Pub/Sub pull

### Component

`workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`

### Behaviour

The builder pulls from `UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION`, currently defaulting to `uk-aq-latest-snapshot-sub`.

The configured subscription MUST differ from `OBSERVS_PUBSUB_SUBSCRIPTION` when that variable is present.

The current pull loop:

- requests up to 1,000 messages per pull;
- performs up to 8 pull batches per run;
- decodes Base64 JSON payloads;
- requires positive integer `connector_id` and `timeseries_id`;
- requires a parseable `observed_at`;
- accepts `value=null` or a finite numeric value at decode time;
- acknowledges malformed messages separately;
- holds successfully decoded message acknowledgement until state handling succeeds.

Decode validity and current-value eligibility are different checks. A decoded `-99` row is a well-formed message but is not eligible for current pollutant state.

## Stage 3: latest valid state application

### Identity

`(connector_id, timeseries_id)`

### Inputs

- existing R2 state;
- decoded observation rows;
- current core metadata needed to identify the observed property and pollutant.

### Required processing order

1. Load existing state.
2. Load or refresh the core metadata index needed for value classification.
3. Resolve each decoded row to its timeseries, phenomenon and observed property.
4. Determine whether it is a supported pollutant current value.
5. Apply only eligible valid values to state using timestamp ordering.
6. Persist changed state.
7. Acknowledge successfully handled decoded messages.
8. Generate snapshot source rows from the resulting state and metadata.

The implementation MAY load metadata earlier for efficiency, but it MUST classify value eligibility before an invalid row can replace state.

### Invalid row outcome

For a well-formed invalid pollutant row:

- raw history remains unaffected;
- no latest state entry is created or replaced;
- state apply telemetry records the skip;
- the Pub/Sub message is acknowledged after successful handling;
- the retained valid state remains available for snapshot generation.

## Stage 4: state persistence

### Key

`latest_snapshots_state/v1/latest_state.json`

### Behaviour

- serialise state deterministically;
- sort entries by connector and timeseries identity;
- calculate a SHA-256 hash;
- write only when the state bytes change;
- preserve the existing state schema unless a separate migration is approved.

## Stage 5: core metadata cache

### Source

Latest available committed core snapshot under `history/v2/core` within the configured lookback.

### Required tables

- `connectors`;
- `networks`;
- `stations`;
- `timeseries`;
- `phenomena`;
- `observed_properties`.

### Cache key

`latest_snapshots_state/v1/core_metadata_cache_v2.json`

### Behaviour

The cache is refreshed when missing, invalid or older than the configured refresh interval, currently 86,400 seconds by default.

The invalid-value fix MUST NOT weaken metadata requirements or introduce connector-based network fallbacks.

## Stage 6: source row construction

For each retained valid state entry, the builder:

1. resolves timeseries metadata;
2. resolves the observed property code and matrix pollutant;
3. confirms pollutant value eligibility as defence in depth;
4. resolves station, connector and network metadata;
5. applies network visibility and existing geography eligibility;
6. builds the v2 `LatestItem` row.

State application is the primary protection against invalid latest values. Source-row validation remains as defence in depth and MUST NOT be removed.

## Stage 7: window matrix generation

For each configured pollutant and window:

1. select rows for the pollutant;
2. apply the finite-window cutoff to the retained valid `last_value_at`;
3. sort rows using the existing pollutant/station ordering;
4. derive the existing next cursor;
5. produce the stable payload;
6. hash the payload;
7. write only when changed.

`window=all` has no time cutoff.

## Stage 8: manifest and run report

The builder writes the family manifest with:

- source and state identity;
- configured matrix;
- per-snapshot object metadata;
- row counts and observed-at bounds;
- changed/error state;
- overall success and partial-failure information.

A failed key retains the previous manifest entry when one exists.

Optional run reports are written under the configured runs prefix.

## Stage 9: private R2 API Worker

### Component

`workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`

### Behaviour

- validates upstream authentication;
- accepts only the canonical v2 standard paths;
- reads deterministic snapshot objects and manifest from R2;
- returns the v2 contract marker header;
- does not fall back to v1.

The API Worker does not reclassify values. It serves the already-built snapshot product.

## Stage 10: cache proxy and website

### Component boundary

`workers/uk_aq_cache_proxy/src/index.ts`

### External route

`/api/aq/latest-snapshot`

### Behaviour

The cache proxy:

- forwards to `UK_AQ_LATEST_SNAPSHOT_R2_API_URL`;
- uses the existing private v2 cache-key namespace;
- requires successful upstream responses to declare the v2 snapshot contract;
- preserves existing cache and error behaviour.

The website map and search operate on the same snapshot family. A timeseries absent from `window=all` cannot be found through that source, which is why retaining the last valid state is load-bearing.
