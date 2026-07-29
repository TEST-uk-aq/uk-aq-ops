# Integrity current-state reconciliation contract

## Authority

This document defines the required orchestration contract when R2 History Integrity has authoritative observation evidence that is newer than, or corrects, downstream current-state records.

It supplements:

```text
system_docs/r2_history/integrity.md
system_docs/latest_snapshot/contract.md
```

The R2 History Integrity contract remains authoritative for source evidence, canonical observation rows, R2 mutation and final observation-history verification.

The Latest Snapshot contract remains authoritative for public-current-value eligibility, state identity, state ordering, metadata eligibility, snapshot generation and public response behaviour.

This document owns only the boundary between those systems and the reconciliation of `timeseries` freshness.

## Purpose

A source outage may prevent normal ingestion while authoritative historical source files remain available.

Integrity may therefore establish canonical R2 observations that are newer than:

```text
timeseries.last_value_at
latest_snapshots_state/v1/latest_state.json
```

A successful history repair must be able to reconcile those derived current-state products without:

* replaying raw ingestion;
* introducing duplicate observation rows;
* bypassing Latest Snapshot policy;
* moving current state backwards;
* making Integrity a second independent Latest Snapshot writer.

## State ownership

### Canonical observation history

R2 v2 observation history is the authoritative historical observation record for this workflow.

Integrity owns detection, repair and verification of that record.

### Timeseries freshness

The database `timeseries` row owns discovery and operational freshness fields:

```text
last_value_at
last_value
```

These fields are derived metadata. They are not authoritative observation history.

### Latest valid public state

Latest Snapshot durable R2 state owns the retained latest valid public observation for each:

```text
connector_id + timeseries_id
```

The physical Latest Snapshot pollutant objects are derived from that durable state.

Integrity is not an owner of Latest Snapshot state or products.

## Definitions

### Final verified canonical observations

The canonical observation collection that has passed the normal Integrity source comparison, proposal validation, R2 apply verification and final source-to-R2 verification for the selected scope.

### Raw latest candidate

The observation with the greatest canonical `observed_at` for one affected timeseries.

It may contain a finite value that is not eligible for public Latest Snapshot use.

### Latest valid candidate

The observation with the greatest canonical `observed_at` for one affected timeseries after application of the authoritative Latest Snapshot pollutant and value-eligibility policy.

### Same-timestamp correction

A final verified canonical observation whose timestamp equals the stored current timestamp but whose canonical value, binary value identity or status differs.

### Monotonic update

An update that never replaces current state with an observation having an earlier `observed_at`.

## Reconciliation trigger boundary

Integrity may mutate downstream current-state records only when all of the following are true:

1. the run is not `--check-only`;
2. the run is not `--dry-run`;
3. authoritative source evidence is available;
4. source mapping and identity evidence are not ambiguous;
5. the selected observation scope has passed final source-to-R2 verification;
6. affected parent manifests and indexes required by the Integrity repair contract are valid;
7. the reconciliation target is explicitly enabled for the environment.

A source failure, uncertain empty source result, blocked mapping or failed R2 verification blocks reconciliation for the affected scope.

Current-state reconciliation must not be used to make an unverified R2 repair appear successful.

## Scope

Timeseries reconciliation applies only to timeseries represented by final verified canonical observations within the selected Integrity scope.

Latest Snapshot reconciliation applies only to:

```text
pm25
pm10
no2
```

An O3 observation repair may reconcile `timeseries.last_value_at` and `timeseries.last_value`, but it must not create or update Latest Snapshot state or products.

Integrity must not broaden a connector, pollutant, day or timeseries scope merely because current-state reconciliation is enabled.

## Timeseries candidate contract

For each affected timeseries, Integrity derives exactly one raw latest candidate from the final verified canonical observations.

The candidate contains:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
```

The candidate value must be the exact finite canonical observation value.

Negative finite source values are retained because timeseries freshness describes the latest raw observation, not the latest valid public value.

Integrity must not create a missing timeseries, station, phenomenon or connector identity.

## Timeseries update contract

Timeseries reconciliation must occur through a private schema-owned RPC.

For an existing target timeseries, the RPC must:

1. update when stored `last_value_at` is null;
2. update when candidate `observed_at` is later than stored `last_value_at`;
3. update `last_value` when the timestamp is equal but the canonical value differs;
4. perform no update when timestamp and value are equal;
5. perform no update when the candidate timestamp is earlier;
6. apply the comparison and update atomically;
7. return deterministic outcome counts.

The RPC must not alter:

```text
first_value_at
station_id
connector_id
phenomenon_id
timeseries_ref
catalog lifecycle fields
checkpoint fields
```

A current-state reconciliation must not be used as evidence that the source connector was polled successfully.

## Latest Snapshot candidate contract

For each affected Latest Snapshot-supported timeseries, Integrity supplies final verified canonical observations to the Latest Snapshot owner.

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

For compatibility with Latest Snapshot state schema version 1, Integrity resolves canonical status using:

1. `verification_status`;
2. legacy `status`;
3. otherwise null.

The resolved value is supplied through the existing state field named `status`.

Integrity must not independently copy or reinterpret Latest Snapshot upper bounds or pollutant aliases. Candidate eligibility must be applied through the authoritative Latest Snapshot policy implementation.

For each timeseries, only the latest eligible valid candidate needs to be applied.

A newer invalid or unsupported observation must not remove or refresh a previously retained valid current value.

## Latest Snapshot mutation contract

Integrity must call an authenticated reconciliation mode owned by the existing Latest Snapshot service.

Integrity must not directly PUT, patch or delete:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots/v2/manifest.json
latest_snapshots/v2/network_group=all/pollutant=*/window=all.json
```

The Latest Snapshot reconciliation mode must:

1. load durable R2 state;
2. fail closed if durable state cannot be read reliably;
3. load or refresh metadata under the existing metadata contract;
4. resolve each candidate to the established timeseries, station, network, phenomenon and observed property;
5. apply the authoritative current-value policy;
6. preserve state identity as `(connector_id, timeseries_id)`;
7. prevent an older candidate replacing newer state;
8. treat identical same-timestamp canonical content as a no-op;
9. permit a final verified same-timestamp correction to replace stale content;
10. write durable state before reporting successful state persistence;
11. rebuild the physical `window=all` products through the normal builder;
12. rebuild the physical manifest through the normal builder;
13. preserve existing public v2 response fields, routes and finite-window derivation.

A local cache write is not durable success.

## Same-timestamp ordering

The existing observed-time ordering remains primary.

Before applying an `ingested_at` tie-break, state handling must compare canonical content.

When the current and candidate rows have the same observation timestamp:

```text
same value + same value_float8_hex + same status
  -> no-op

different verified canonical content
  -> correction may replace current content
```

Retrying an already applied correction must be a no-op.

This requirement applies to Integrity reconciliation and must not cause endless state rewrites merely because a retry has a later wall-clock execution time.

Any change to normal Pub/Sub same-timestamp ordering must be documented explicitly in the Latest Snapshot contract and decision records.

## Single-writer requirement

Normal scheduled Latest Snapshot processing and Integrity reconciliation must use the same owning service and the same serialised durable-state mutation path.

The architecture must retain the established protection against concurrent state writers.

A second Cloud Run service, local Integrity script or GitHub workflow must not independently mutate Latest Snapshot state.

## Execution order

After final R2 observation verification, Integrity executes:

1. raw latest-candidate derivation;
2. timeseries reconciliation;
3. latest-valid-candidate derivation;
4. authenticated Latest Snapshot reconciliation;
5. response verification;
6. audit recording.

Timeseries and Latest Snapshot are separate durable targets.

Failure of either target:

* does not roll back verified R2 observation history;
* does not roll back a successful update to the other target;
* prevents the Integrity run reporting complete success;
* remains safely retryable.

## Check-only and dry-run behaviour

Check-only and dry-run may:

* derive candidates;
* compare candidate timestamps with available current-state metadata;
* report proposed update counts;
* report unsupported or unresolved candidates.

They must not:

* invoke the mutating timeseries RPC;
* invoke the mutating Latest Snapshot reconciliation mode;
* publish candidate messages;
* write Latest Snapshot R2 state or products.

Planned and completed reconciliation counts must remain separate in reports.

## Retry and recovery

Reconciliation must be idempotent.

A later real Integrity run may retry current-state reconciliation after R2 history has already been repaired, provided the selected source evidence and final R2 verification still agree.

An interrupted or failed current-state reconciliation does not require restoring older R2 history.

No permanent reconciliation receipt is required in R2. Integrity SQLite and normal task reports own reconciliation audit evidence.

## Failure classification

The following are reconciliation failures:

* database RPC failure;
* missing target timeseries;
* Latest Snapshot authentication failure;
* Latest Snapshot durable-state read failure;
* Latest Snapshot durable-state write failure;
* unresolved required metadata;
* unsupported candidate identity;
* snapshot-product or manifest rebuild failure;
* response verification failure;
* non-idempotent retry behaviour.

An individual unresolved candidate may be reported separately, but the run must not silently report full success when a required newer current state was not reconciled.

## Audit evidence

Every reconciliation-capable run records:

```text
enabled
mode
integrity_run_id
selected connector scope
selected pollutant scope
candidate timeseries count
candidate timestamp bounds
timeseries outcomes
latest snapshot outcomes
same-timestamp corrections
older candidates skipped
identical candidates skipped
missing identities
warnings
failures
final status
```

The report must preserve separate statuses for:

```text
R2 observation history
timeseries freshness
Latest Snapshot
```

## Line-chart relationship

Current-state reconciliation is not a prerequisite for the station-history worker to read canonical R2 history when the requested sensor identity is known.

The line chart continues using the established recent-head and R2 history interfaces.

Nevertheless, Latest Snapshot reconciliation remains required because stale finite-window snapshot rows can remove a sensor from the map or sensor list and prevent the normal user journey into the chart.

No browser-side direct R2 fallback or special SOS fallback is introduced by this contract.

## Explicit non-goals

This work must not:

* republish repaired observations through the shared raw observation topic;
* insert repaired rows into IngestDB solely for chart availability;
* alter observation-history retention;
* change Prune Daily ownership;
* add O3 to Latest Snapshot;
* change AQI or WHO calculation contracts;
* create missing core identities;
* rewrite connector checkpoints;
* claim that Integrity performed a successful source poll;
* change website route names or chart rendering behaviour;
* make Integrity a general current-data ingestion service.

## Validation model

Before implementation, confirm only structural viability and the one targeted deterministic same-timestamp/idempotency check required by this contract.

Functional validation occurs after deployment through real CIC-Test operation:

1. one recent SOS repair from authoritative cached flat files;
2. one timeseries freshness advance;
3. one Latest Snapshot state and product advance;
4. one idempotent repeat;
5. one older-range no-rollback operation;
6. one normal website line-chart request that reads a repaired R2 observation.

Do not add a broad speculative pre-implementation test suite.

## Contract-change rule

Changes to any of the following require coordinated updates to this document and the owning area contract:

* current-state ownership;
* candidate derivation;
* monotonic database ordering;
* Latest Snapshot state identity;
* latest-value eligibility;
* same-timestamp correction ordering;
* single-writer behaviour;
* mutation boundary;
* retry semantics;
* failure classification;
* public Latest Snapshot compatibility.
