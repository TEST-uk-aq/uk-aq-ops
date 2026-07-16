# Latest snapshot recovery

## Purpose

This document defines how to recover latest-snapshot state and generated snapshot objects without changing raw observation history or the public v2 contract.

## Recovery source of truth

A recovery must rebuild current state from the newest eligible valid raw observation for each `(connector_id, timeseries_id)`.

The recovery source must contain historical observation rows, not only the already-derived current value.

Do not use the following as sole authority when state may be poisoned:

- the existing latest-state object;
- existing latest snapshot objects;
- `timeseries.last_value` without confirming that it already means latest valid value;
- a latest-value RPC that removes invalid current rows but does not fall back to the preceding valid observation.

## Existing seed scripts

The repository contains scripts that seed latest state from existing R2 snapshots or a Supabase latest RPC.

Before using either for this defect, inspect its source semantics:

- seeding from existing snapshot objects can reproduce omissions already present in those objects;
- seeding from a latest RPC can omit a timeseries whose stored current value is invalid rather than restoring its previous valid observation.

A script is suitable only if it explicitly selects the latest eligible valid historical observation per identity.

## Required repair semantics

For each supported pollutant timeseries:

1. identify its connector and timeseries identity;
2. read historical observations in descending timestamp order;
3. choose the newest finite value greater than or equal to zero;
4. apply any existing pollutant-specific upper bound;
5. retain the source timestamp, value, float representation and status for that valid row;
6. write at most one state entry for the identity;
7. omit identities with no valid historical observation;
8. serialise state deterministically using the normal state model.

The repair must not:

- delete or rewrite raw observations;
- convert invalid raw values to null in history;
- refresh a retained valid timestamp to the timestamp of an invalid row;
- change snapshot object keys or row fields;
- change network or metadata eligibility.

## Safe recovery sequence

### 1. Preserve current objects

Before write mode, preserve or download:

- `latest_snapshots_state/v1/latest_state.json`;
- `latest_snapshots/v2/manifest.json`;
- the affected snapshot objects or a complete object inventory.

This provides rollback evidence and a before/after comparison.

### 2. Produce a dry report

The recovery tool should report:

- current state entry count;
- rebuilt state entry count;
- entries unchanged;
- entries replaced with an earlier valid value;
- invalid entries removed;
- missing-history identities;
- per-pollutant counts;
- a bounded sample of changed identities.

The report must not expose credentials or unrelated raw data.

### 3. Review known affected identities

For the Manchester Piccadilly PM2.5 example, the expected repaired state is:

```text
connector_id=1
timeseries_id=360
observed_at=2026-07-16T08:00:00Z
value=21.793
```

The later `-99` observation remains in raw history but is not state.

### 4. Write repaired state

Write the rebuilt state only after the dry report confirms the expected eligibility and counts.

Use the same state key and schema version unless a separately approved migration requires otherwise.

### 5. Regenerate the snapshot family

Run the normal builder so it regenerates changed matrix objects and the family manifest from repaired state.

Do not hand-edit individual snapshot JSON objects.

### 6. Validate through the TEST website path

Confirm the repaired identity:

- appears in `window=all`;
- appears in finite windows only when the retained valid timestamp is in range;
- is searchable through the website's snapshot-backed search;
- appears on the hex map where otherwise eligible;
- never displays `-99` as its latest value.

## Runtime self-healing

After the normal state-transition fix is deployed, a future valid observation will replace a poisoned entry. That is useful but is not an adequate immediate recovery plan because:

- a sensor may not send another valid row promptly;
- invalid-only periods could keep the website incomplete;
- the `all` snapshot remains wrong until recovery or a future valid row.

Existing poisoned state should therefore be repaired explicitly.

## Rollback

If repaired state produces unexpected coverage or metadata behaviour:

1. restore the preserved previous state object;
2. run the normal builder to regenerate the previous snapshot family;
3. restore the previous code revision if the runtime transition logic is also implicated;
4. retain the dry report and object hashes for diagnosis.

Rollback must not restore a changed raw observation history because raw history is not modified by this recovery.

## Recovery-tool contract

Any new or amended recovery tool must:

- default to report-only mode;
- require an explicit write flag;
- use the same central value-eligibility rule as the normal builder;
- produce deterministic output for identical source history;
- avoid archive code paths;
- document the exact historical source used;
- support bounded targeted repair before broad repair where practical.
