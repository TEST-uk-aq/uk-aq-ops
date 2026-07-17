# Latest snapshot recovery

## Purpose

This document defines how to recover latest-valid state and regenerate current physical snapshot products without changing raw observation history or the public v2 API contract.

## Recovery source of truth

A state recovery must rebuild the newest eligible valid raw observation for each `(connector_id, timeseries_id)`.

The recovery source must contain sufficient observation history to find a preceding valid value when the newest raw row is invalid.

Do not use the following as sole authority when state may be poisoned:

- the existing latest-state object;
- existing Latest Snapshot objects;
- `timeseries.last_value` without confirming that it already means latest valid value;
- a latest-value RPC that removes an invalid newest row without falling back to the preceding valid observation.

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
- create finite-window state or snapshot objects.

## Safe state-recovery sequence

### 1. Preserve current evidence

Before write mode, preserve or download:

- `latest_snapshots_state/v1/latest_state.json`;
- `latest_snapshots/v2/manifest.json`;
- the three physical `window=all` objects;
- a bounded report of affected identities.

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

1. restore the preserved previous state object;
2. run the normal builder to regenerate the three physical `all` objects and manifest;
3. restore the previous runtime revision only if the state-transition implementation is implicated;
4. retain reports and hashes for diagnosis.

Raw history is not modified and is not part of rollback.

## Recovery-tool contract

A new or amended recovery tool must:

- default to report-only mode;
- require an explicit write flag;
- use the same value-eligibility rules as normal runtime;
- produce deterministic state for identical source history;
- avoid archive execution paths;
- document its exact source semantics;
- support bounded targeted repair where practical;
- generate only current physical `all` products through the normal builder.