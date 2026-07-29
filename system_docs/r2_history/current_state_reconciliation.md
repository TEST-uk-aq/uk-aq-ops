# Integrity current-state reconciliation

## Authority and scope

This document is the authoritative cross-system contract for reconciling current-state records after R2 History Integrity has established final verified canonical observations.

It supplements:

- [`integrity.md`](integrity.md) for source evidence, canonical observation repair and final R2 verification;
- [`../latest_snapshot/contract.md`](../latest_snapshot/contract.md) for latest-valid public-state policy;
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md) for the Latest Snapshot owner-service mutation boundary.

Where this document conflicts with an implementation plan, worker README, script comment or archive, this document is authoritative for the reconciliation boundary.

## Purpose

A source outage may prevent normal ingestion while authoritative historical source files remain available.

Integrity may therefore repair R2 v2 observation history through a timestamp that is newer than:

```text
timeseries.last_value_at
latest_snapshots_state/v1/latest_state.json
```

The repaired observation history may already be readable by station-history routes, but stale current-state records can leave sensor discovery, map rows and finite Latest Snapshot responses out of date.

Integrity must be able to reconcile those derived current-state records without:

- replaying the normal raw-ingest pipeline;
- inserting duplicate IngestDB observations;
- moving current state backwards;
- bypassing Latest Snapshot eligibility or metadata rules;
- making Integrity a second independent Latest Snapshot writer.

## State ownership

### Canonical observation history

R2 v2 observation history remains the authoritative historical observation record for this workflow.

Integrity owns detection, repair planning, scoped R2 mutation, final manifest and index repair, and source-to-R2 verification.

### Timeseries freshness

The database `timeseries` row owns these derived freshness fields:

```text
last_value_at
last_value
```

They are discovery and operational metadata. They are not authoritative observation history.

### Latest valid public state

The Latest Snapshot system owns:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
latest_snapshots/v2/manifest.json
```

Integrity is not an owner of those objects and must not write them directly.

## Definitions

### Final verified canonical observations

The canonical observation collection that has passed the normal Integrity source comparison, proposal validation, real R2 apply verification and final source-to-R2 verification for the selected scope.

### Raw latest candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries.

It may contain a finite source value that is not eligible for public Latest Snapshot use.

### Latest valid candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries after the authoritative Latest Snapshot pollutant and value-eligibility policy has been applied.

### Same-timestamp correction

A final verified canonical observation whose `observed_at` equals the stored current timestamp but whose canonical value, binary value identity or preserved status differs.

### Monotonic update

An update that never replaces current state with an observation having an earlier `observed_at`.

## Reconciliation trigger boundary

Integrity may mutate downstream current-state records only when all of the following are true:

1. the run is not `--check-only`;
2. the run is not `--dry-run`;
3. authoritative source evidence is available;
4. mapping and identity evidence are not ambiguous;
5. the selected observation scope has passed final source-to-R2 verification;
6. required affected parent manifests and indexes are valid;
7. the reconciliation target is enabled for the current environment.

A source failure, uncertain empty result, blocked mapping, failed R2 mutation or failed final verification blocks reconciliation for the affected scope.

Current-state reconciliation must not make an unverified history repair appear successful.

## Pollutant scope

Timeseries freshness reconciliation may apply to all four active Integrity pollutants:

```text
pm25
pm10
no2
o3
```

Latest Snapshot reconciliation applies only to its current public matrix:

```text
pm25
pm10
no2
```

An `o3` observation repair may advance `timeseries.last_value_at` and `timeseries.last_value`, but it must not create or update Latest Snapshot state or products.

Integrity must not broaden connector, pollutant, day or timeseries scope merely because reconciliation is enabled.

## Timeseries candidate contract

For each affected timeseries, Integrity derives exactly one raw latest candidate from final verified canonical observations.

The candidate contains:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
```

The value must be the exact finite canonical source value.

Finite negative source values are retained because `timeseries.last_value` describes the latest raw observation, not the latest valid public value.

Integrity must not create a missing timeseries, station, phenomenon, connector or observed-property identity.

## Timeseries mutation boundary

Timeseries reconciliation must occur through one private schema-owned RPC.

Integrity must not issue unrestricted direct updates to `timeseries`.

For an existing target timeseries, the RPC must atomically:

1. update when stored `last_value_at` is null;
2. update when candidate `observed_at` is later than stored `last_value_at`;
3. update `last_value` when the timestamp is equal but the canonical value differs;
4. perform no update when timestamp and value are equal;
5. perform no update when the candidate timestamp is earlier;
6. return deterministic outcome counts.

The RPC must not alter:

```text
first_value_at
station_id
connector_id
phenomenon_id
timeseries_ref
catalog lifecycle fields
connector checkpoints
ingest-run evidence
```

A reconciliation update must not be treated as evidence that the source connector was polled successfully.

## Timeseries RPC outcome contract

The response must include at least:

```text
candidate_count
updated_newer_count
updated_same_timestamp_correction_count
skipped_equal_count
skipped_older_count
missing_timeseries_count
failed_count
```

A missing target timeseries is not created. It is reported and prevents full reconciliation success for that candidate.

## Latest Snapshot candidate contract

For each affected Latest Snapshot-supported timeseries, Integrity supplies final verified candidate data to the Latest Snapshot owner service.

The candidate representation contains:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
value_float8_hex
status
pollutant_code
```

For compatibility with Latest Snapshot state schema version 1, canonical source status is resolved in this order:

1. `verification_status`;
2. legacy `status`;
3. otherwise null.

The resolved value is supplied through the existing Latest Snapshot state field named `status`.

Integrity must not independently copy or reinterpret Latest Snapshot pollutant aliases, upper bounds or value eligibility. The owning service must apply the authoritative implementation.

A newer invalid or unsupported observation must not remove or refresh a previously retained valid current value.

## Latest Snapshot mutation boundary

Integrity must call an authenticated reconciliation mode owned by the existing Latest Snapshot Cloud Run service.

Integrity must not directly PUT, patch or delete Latest Snapshot durable state, physical pollutant objects or the manifest.

The owner service must use the same:

- durable state loader and writer;
- metadata resolution;
- current-value eligibility;
- state identity;
- ordering rules;
- physical snapshot builder;
- manifest writer;
- single-writer runtime protection

used by normal scheduled processing.

The detailed owner-service contract is defined in [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md).

## Same-timestamp ordering

The existing observation timestamp remains the primary ordering field.

For an Integrity reconciliation candidate with the same `observed_at` as retained state, canonical content must be compared before applying a wall-clock `ingested_at` tie-break.

Required behaviour is:

```text
same value + same value_float8_hex + same status
  -> no-op

different final verified canonical content
  -> correction may replace retained content
```

Retrying an already applied correction must be a no-op.

Integrity reconciliation must not cause endless state rewrites merely because a retry has a later execution time.

Any broader change to normal Pub/Sub same-timestamp ordering requires an explicit Latest Snapshot contract and decision update.

## Single-writer requirement

Normal scheduled Latest Snapshot processing and Integrity reconciliation must use the same owning service and serialised durable-state mutation path.

A second Cloud Run service, local Integrity script, GitHub workflow or schema function must not independently mutate Latest Snapshot R2 state.

## Execution order

After final R2 observation verification, Integrity executes:

1. derive one raw latest candidate per affected timeseries;
2. call the timeseries reconciliation RPC;
3. derive one latest-valid candidate per affected supported timeseries;
4. call the authenticated Latest Snapshot reconciliation mode;
5. verify both reconciliation responses;
6. record results in Integrity SQLite and normal reports.

Timeseries freshness and Latest Snapshot are separate durable targets.

Failure of either target:

- does not roll back verified R2 observation history;
- does not roll back a successful update to the other target;
- prevents the Integrity run reporting complete success;
- remains safely retryable.

## Check-only and dry-run behaviour

Check-only and dry-run may:

- derive candidates;
- report candidate timestamp bounds;
- compare against current metadata where a non-mutating read already exists;
- report proposed outcome counts.

They must not:

- invoke the mutating timeseries RPC;
- invoke the mutating Latest Snapshot reconciliation mode;
- publish candidate messages;
- write Latest Snapshot state or products.

Planned and completed outcomes must remain separate in reports.

## Retry and recovery

Reconciliation must be idempotent.

A later real Integrity run may retry current-state reconciliation after R2 history has already been repaired, provided authoritative source evidence is available and final source-to-R2 verification still agrees.

An interrupted or failed current-state reconciliation does not require restoring older R2 history.

No permanent reconciliation receipt is required in R2. Integrity SQLite and normal task reports own audit evidence.

## Run status contract

The Integrity result must distinguish:

```text
r2_history_status
timeseries_reconciliation_status
latest_snapshot_reconciliation_status
overall_status
```

A run must not report full `status=ok` when a required reconciliation target failed.

Correct verified R2 history remains committed and must be reported as successful even when the overall result is failed or partial because reconciliation failed.

## Audit evidence

Every reconciliation-capable run records:

```text
enabled
mode
integrity_run_id
selected connector scope
selected pollutant scope
candidate timeseries count
candidate observed_at minimum and maximum
timeseries outcome counts
Latest Snapshot outcome counts
same-timestamp corrections
older candidates skipped
identical candidates skipped
missing identities
warnings
failures
final component statuses
```

Large per-timeseries detail may remain in Integrity SQLite or a bounded diagnostic attachment rather than expanding the normal Markdown report without limit.

## Line-chart relationship

Current-state reconciliation is not required for the station-history worker to read canonical R2 history when the requested sensor identity is already known.

The line chart continues using the established recent-head and R2 observation-history interfaces, continuity bindings and server-side merge behaviour.

Latest Snapshot reconciliation is still required because stale finite-window rows can remove a sensor from the map or sensor list and prevent the normal user journey into the chart.

No browser-side direct R2 fallback, SOS-specific chart path or duplicate IngestDB insert is introduced by this contract.

## Explicit non-goals

This work must not:

- republish repaired observations through the shared raw observation topic;
- insert repaired observations into IngestDB solely for chart availability;
- change R2 history retention;
- change Prune Daily deletion ownership or gate evidence;
- add O3 to Latest Snapshot;
- change AQI or WHO calculation contracts;
- create missing core identities;
- rewrite connector checkpoints;
- claim a successful source poll;
- change website route names or chart rendering behaviour;
- turn Integrity into a general current-data ingestion service.

## Validation model

Before implementation, validate only structural viability and the one targeted deterministic same-timestamp and idempotency check required by this contract.

Functional validation occurs after deployment through real CIC-Test operation:

1. one recent SOS repair from authoritative cached flat files;
2. one monotonic timeseries freshness advance;
3. one Latest Snapshot state and product advance;
4. one idempotent repeat;
5. one older-range no-rollback operation;
6. one normal website chart request that reads a repaired R2 observation.

Do not add a broad speculative pre-implementation test suite.

## Implementation status

Approved for CIC-Test implementation as of 29 July 2026. Code, schema and deployment changes are pending.

## Contract-change rule

Changes to any of the following require coordinated updates to this document and the owning area contract:

- current-state ownership;
- candidate derivation;
- monotonic database ordering;
- Latest Snapshot state identity;
- latest-value eligibility;
- same-timestamp correction ordering;
- single-writer behaviour;
- mutation boundary;
- retry semantics;
- failure classification;
- public Latest Snapshot compatibility.
