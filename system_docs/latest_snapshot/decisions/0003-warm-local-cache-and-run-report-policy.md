# ADR 0003: use a validated warm local cache and failures-by-default run reports

- Status: Accepted and implemented
- Date: 17 July 2026
- Area: latest snapshot
- Implementation commit: `1557133debc6d8ab426eb55bce9043bca2a5ff55`

## Context

The Latest Snapshot Cloud Run service is invoked every minute.

The long-running HTTP parent starts a new `run_job.ts` child for each accepted invocation. Before this amendment, every child downloaded these JSON bodies from R2:

- latest-valid state;
- the core metadata cache;
- the previous physical family manifest.

The same warm Cloud Run container can handle successive invocations, but a normal module-level cache inside `run_job.ts` would disappear with each child process.

The builder also wrote one timestamped successful `_runs` report object for every completed scheduled run. This created up to 1,440 successful report objects per day even though the structured job summary and current physical manifest already represented normal operation.

The optimisation had to preserve:

- R2 as durable authority;
- child-process timeout and termination isolation;
- Pub/Sub acknowledgement ordering;
- metadata freshness;
- deterministic state and manifest bytes;
- the all-only physical snapshot matrix;
- the public v2 API.

## Decision

Implement the warm cache and report reduction as one Cloud Run amendment with independently reversible settings.

## Warm local cache decision

### Scope

Cache only these durable R2 JSON objects:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots_state/v1/core_metadata_cache_v2.json
latest_snapshots/v2/manifest.json
```

Default local directory:

```text
/tmp/uk-aq-latest-snapshot-cache
```

The physical PM2.5, PM10 and NO2 snapshot objects are not builder-local cache entries.

### Process model

Retain `run_service.ts` as the long-running parent and `run_job.ts` as the per-invocation child.

The parent and each child share the same container filesystem. Successive children can therefore reuse `/tmp` while the container remains warm without removing the existing child timeout, `SIGTERM` and `SIGKILL` boundary.

### Local identity and integrity

For each R2 key, derive the local filename stem as the SHA-256 of the complete key. Store:

```text
{stem}.bin
{stem}.json
```

The sidecar schema contains:

```json
{
  "schema_version": 1,
  "key": "<complete R2 key>",
  "etag": "<R2 ETag>",
  "sha256": "<SHA-256 of local body>"
}
```

A local body can be reused only when:

1. body and sidecar exist;
2. sidecar schema and key are valid;
3. the body parses as JSON;
4. the body SHA-256 matches the sidecar;
5. an R2 HEAD confirms the object still exists;
6. the current R2 ETag is present and matches the sidecar.

Any failure falls back to the normal R2 GET path. An unvalidated stale local body is never treated as authoritative during an R2 failure.

### Write order

After an R2 GET, the returned body and ETag may populate the local cache.

After an R2 PUT of state, metadata cache or manifest:

1. the R2 PUT must succeed;
2. only then may the same bytes and returned ETag update the local cache.

Local files use temporary-file-and-rename writes. A local write failure is a cache warning and does not change the result of the already completed durable R2 operation.

Pub/Sub acknowledgement never depends on a local cache write.

### Configuration

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_DIR=/tmp/uk-aq-latest-snapshot-cache
```

Disabling the cache returns to direct R2 body loading with no data migration.

## Run-report decision

Add:

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE
```

Accepted modes:

```text
all
failures
off
```

Default:

```text
failures
```

Behaviour:

- `all`: write the existing report for every completed run;
- `failures`: write a report for every completed manual run and every completed run with one or more failed matrix items, but not a successful scheduled run;
- `off`: write no R2 run-report objects.

The legacy setting remains a fallback only when the new mode is absent:

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED=true  -> all
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED=false -> off
```

An explicit invalid new mode is a configuration error.

The existing report schema and key naming remain unchanged for reports that are written. Existing `_runs` objects are retained.

Every completed build still emits the structured `latest_snapshot_job_summary`, including:

- normal build summary;
- local cache counters;
- resolved report mode and source;
- report write decision and reason.

Early exceptions before a completed build report exists remain represented by service logs and normal failure status rather than a new exception-report object.

## Durable authority

R2 remains the sole runtime authority for:

- latest-valid state;
- the metadata cache;
- the physical manifest;
- physical pollutant snapshots;
- optional run-report objects that are actually written.

The local cache is not:

- a backup;
- a recovery source;
- durable state;
- a replacement for R2 validation;
- an input to public API behaviour.

## Consequences

### Positive

- Warm invocations can replace repeated R2 state, metadata-cache and manifest body downloads with smaller HEAD validation requests.
- Child-process isolation and timeout handling remain unchanged.
- External R2 updates invalidate local entries through ETag mismatch.
- Successful scheduled `_runs` growth is removed by default.
- Structured operational evidence remains available for every completed build.
- The physical manifest and public API remain unchanged.
- Each optimisation can be disabled separately.

### Trade-offs

- Every attempted local hit still performs an R2 HEAD request.
- Cloud Run may discard the container at any time, so cache hits are opportunistic rather than guaranteed.
- The two local files for an entry are not transactionally replaced as one unit. An interrupted or mismatched pair is safely rejected on the next read.
- Failure reports are produced only for failures that reach the completed matrix-build decision. Earlier exceptions rely on service logging.
- A successful scheduled run no longer has a timestamped `_runs` object unless mode is changed to `all`.

## Alternatives considered

### Keep direct R2 GETs for every invocation

Rejected because the same large JSON bodies can be downloaded every minute while the same container remains warm.

### Keep the cache only in `run_job.ts` memory

Rejected because each invocation starts a new child process and module memory does not survive between children.

### Move the whole job into the long-running parent

Rejected because it would weaken the existing timeout, signal and process-isolation boundary solely to obtain an in-memory cache.

### Use local files without R2 validation

Rejected because `/tmp` is not authoritative and could become stale after an external state repair, metadata refresh or manifest update.

### Use a local TTL without ETag comparison

Rejected because age alone does not prove that the durable object is unchanged.

### Stop all run reports

Rejected as the default because completed manual runs and completed failed matrix builds remain useful bounded diagnostic artefacts.

### Retain every successful scheduled report

Rejected as the default because it creates a permanent object every minute while duplicating normal evidence already present in structured logs and the current manifest.

## Deployment and rollback

Normal deployed settings:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=failures
```

Configuration-only rollback:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

This restores direct R2 body loads and the previous every-completed-run report policy without changing state, snapshots, manifest, public API or existing reports.

Local files require no cleanup and disappear with the container.

## Validation outcome

The amendment was implemented in the TEST repository on 17 July 2026 and reported complete.

Validation follows the minimal TEST policy:

- syntax/type and workflow structure only before deployment;
- one normal successful build;
- one warm invocation showing a validated hit when the same container is reused;
- one successful scheduled run showing `scheduled_success` and no `_runs` write;
- one representative public or website check;
- no induced failure, broad suite or soak period.

Ongoing rules are defined in [`../validation.md`](../validation.md).
