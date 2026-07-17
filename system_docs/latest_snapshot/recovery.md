# Latest snapshot recovery

## Purpose

This document defines how to recover latest-valid state and regenerate current physical snapshot products without changing raw observation history or the public v2 API contract.

It also defines the limited recovery and rollback actions for the disposable local cache and R2 run-report policy.

## Recovery source of truth

A state recovery must rebuild the newest eligible valid raw observation for each `(connector_id, timeseries_id)`.

The recovery source must contain sufficient observation history to find a preceding valid value when the newest raw row is invalid.

Do not use the following as sole authority when state may be poisoned:

- the existing latest-state object;
- any `/tmp` local-cache file;
- existing Latest Snapshot objects;
- `timeseries.last_value` without confirming that it already means latest valid value;
- a latest-value RPC that removes an invalid newest row without falling back to the preceding valid observation.

The container-local cache is never recovery evidence. R2 remains durable authority during normal operation, and raw history is required when durable latest state itself is being repaired.

## Existing seed scripts

The repository contains:

- `scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs`;
- `scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs`.

The R2 script now defaults to the v2 physical manifest and therefore reads the three physical `window=all` objects. It is useful for bootstrap or deterministic reconstruction from an already-correct snapshot family, but it can reproduce omissions already present in that family.

The Supabase script reads the physical `all` request once per pollutant from the configured RPC. It is suitable only when the RPC semantics are confirmed to return the latest eligible valid row rather than merely excluding an invalid newest row.

Neither script replaces an authoritative raw-history repair unless its source semantics satisfy this document.

## Required state-repair semantics

For each supported pollutant timeseries:

1. identify connector and timeseries identity;
2. read historical observations in descending timestamp order;
3. choose the newest numeric finite value greater than or equal to zero;
4. apply the current pollutant-specific maximum;
5. retain the source timestamp, value, float representation and status;
6. write at most one state entry for the identity;
7. omit identities with no valid historical observation;
8. serialise state using the normal deterministic state model.

A repair must not:

- delete or rewrite raw observations;
- convert invalid raw values to null in history;
- refresh a retained valid timestamp to the timestamp of an invalid row;
- change public row fields;
- change network or metadata eligibility;
- create finite-window state or snapshot objects;
- use a local `/tmp` copy as the write source.

## Safe state-recovery sequence

### 1. Preserve current evidence

Before write mode, preserve or download:

- `latest_snapshots_state/v1/latest_state.json`;
- `latest_snapshots/v2/manifest.json`;
- the three physical `window=all` objects;
- a bounded report of affected identities.

Do not preserve local cache files as authoritative evidence. Their body and sidecar may be copied only as optional diagnostic material when investigating a cache defect.

### 2. Produce a dry report

The recovery tool should report:

- current and rebuilt state entry counts;
- unchanged entries;
- entries restored to an earlier valid observation;
- invalid entries removed;
- identities with insufficient history;
- per-pollutant counts;
- a bounded sample of changes.

The report must not expose credentials or unrelated raw data.

### 3. Review known affected identities

For the historical Manchester Piccadilly PM2.5 example, the expected repaired state before any later valid observation was:

```text
connector_id=1
timeseries_id=360
observed_at=2026-07-16T08:00:00Z
value=21.793
```

The later `-99` remains in raw history but is not latest state.

### 4. Write repaired state

Write the rebuilt state only after the dry report confirms the expected eligibility and counts.

Use the existing state key and schema version unless an approved migration says otherwise.

A direct external R2 state repair changes the R2 ETag. On the next builder run, a warm local copy with the old ETag is rejected and refreshed from R2. No manual local-cache invalidation is required.

### 5. Regenerate physical products

Run the normal builder. It regenerates only:

```text
pm25/window=all
pm10/window=all
no2/window=all
```

and the three-entry physical manifest.

Do not hand-edit snapshot JSON objects and do not create finite objects.

### 6. Validate through the public TEST path

One representative check is normally sufficient:

- the repaired identity appears in `window=all`;
- it appears in a finite response only when `last_value_at` is inside the requested cutoff;
- the public response never emits the invalid value;
- the website map or search path displays the row when otherwise eligible.

## Runtime prevention and self-healing

The current runtime classifies value eligibility before state application, so new invalid rows cannot poison state.

A future valid observation can replace an old poisoned entry, but this is not a reliable substitute for explicit recovery when a timeseries remains silent or invalid for a long period.

## Local-cache fault handling

### Expected automatic recovery

The builder automatically abandons a local entry when:

- either local file is missing;
- the sidecar is malformed or names another key;
- the local body is invalid JSON;
- the local SHA-256 does not match;
- the R2 object does not exist;
- the R2 ETag is unavailable or differs;
- R2 validation fails.

The normal R2 GET path is then used. When successful, it may replace the local entry.

### Manual diagnostic reset

The local cache can be reset by either:

- deploying a new Cloud Run revision or allowing the current container to be replaced;
- deleting the configured cache directory inside a diagnostic environment;
- setting `UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false` and redeploying.

No R2 objects, Pub/Sub messages or public snapshots need to be changed.

### Persistent local-cache warnings

If `corrupt`, `validation_error`, `write_failure` or `skipped_missing_etag` continue increasing:

1. disable the local cache;
2. confirm direct R2 operation succeeds;
3. inspect R2 HEAD/GET response ETags and container filesystem permissions;
4. restore the previous Cloud Run revision if the cache implementation is implicated.

Do not use an unvalidated local body to keep the builder running during an R2 failure.

## Run-report recovery and rollback

Run reports are diagnostic artefacts, not durable system state.

A missing report for a successful scheduled run is normal when mode is `failures`. First inspect the structured `latest_snapshot_job_summary` fields:

```text
run_reports.mode
run_reports.source
run_reports.write
run_reports.reason
```

Expected normal decision:

```text
mode=failures
write=false
reason=scheduled_success
```

To restore the former every-completed-run report frequency, set:

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

and redeploy. This does not change state, snapshots or the manifest.

To disable R2 report objects completely, use `off`.

Old `_runs` objects are not deleted or reconstructed by recovery. Early exceptions that occurred before a completed build summary cannot be recreated as run-report objects and remain available through service logging where retained.

## Snapshot-architecture rollback

The current public API depends on the deriving R2 API Worker and the all-only builder.

If only the deriving Worker has been deployed, roll back that Worker.

If both components must be rolled back:

1. roll back the builder first so the previous finite objects resume being updated;
2. roll back the R2 API Worker;
3. confirm the previous public path works.

Old finite objects are not used as fallbacks by the current Worker. They may support a deliberate code rollback only after the previous builder has resumed updating them.

## State-recovery rollback

If a repaired state produces unexpected coverage or metadata behaviour:

1. restore the preserved previous R2 state object;
2. run the normal builder to regenerate the three physical `all` objects and manifest;
3. allow ETag validation to refresh any stale local state or manifest copy;
4. restore the previous runtime revision only if the state-transition implementation is implicated;
5. retain reports and hashes for diagnosis.

Raw history is not modified and is not part of rollback.

## Warm-cache amendment rollback

The cache and report changes are independently reversible:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

Redeploying these values restores direct R2 body loads and previous report frequency.

The rollback must not:

- restore local files into R2;
- alter the state schema;
- replay acknowledged Pub/Sub messages;
- change the three physical snapshot objects;
- change the public R2 API Worker;
- delete old run reports.

## Recovery-tool contract

A new or amended recovery tool must:

- default to report-only mode;
- require an explicit write flag;
- use the same value-eligibility rules as normal runtime;
- produce deterministic state for identical source history;
- avoid archive execution paths;
- document its exact source semantics;
- support bounded targeted repair where practical;
- generate only current physical `all` products through the normal builder;
- ignore local `/tmp` cache files as recovery sources.
