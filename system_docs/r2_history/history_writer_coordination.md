# R2 v2 shared history writer coordination

## Authority and scope

This document defines the authoritative coordination contract for every component that writes canonical R2 v2 history or its manifests and indexes.

It applies to:

- Prune Daily Phase B;
- real Integrity repair runs;
- Integrity-backed R2 structure migration;
- any explicit R2 v2 history repair or maintenance command that uses the canonical writer.

It supplements:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`integrity.md`](integrity.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`timeseries_binding_contract.md`](timeseries_binding_contract.md).

Where older wording conflicts with this document, this document is authoritative for:

- the IngestDB-to-R2 boundary used by Integrity;
- concurrent Prune Daily and Integrity operation;
- connector-day, day-finalisation and global-index locking;
- shared writer and finaliser ownership;
- prune-gate ownership;
- preservation of connectors already present in an R2 day.

## Storage ownership boundary

For each connector, observation retention has one continuous boundary:

```text
earlier UTC days              earliest IngestDB day and later
R2 History                    IngestDB
Integrity-owned region        Prune Daily-owned region
```

The boundary is connector-specific because different connectors may be pruned at different times.

The intended storage state is not patchy. Integrity MUST NOT treat an individually empty connector-day inside or beyond a connector's IngestDB region as eligible historical space.

### Integrity request-level boundary check

Before source acquisition, Dropbox comparison, proposal generation or live R2 access, every Integrity mode MUST determine the earliest UTC day represented in IngestDB for every connector included in the request.

For a requested inclusive range ending on `requested_end_day`, the complete request is valid only when, for every requested connector that has any IngestDB rows:

```text
requested_end_day < earliest_ingestdb_day
```

If this condition fails for any requested connector, Integrity MUST fail the entire request immediately.

Integrity MUST NOT:

- clip the requested range;
- skip only the blocking connector;
- process a valid prefix of the range;
- continue with non-blocking connectors;
- treat an empty later connector-day as eligible;
- wait for Prune Daily to move the boundary.

The failure report MUST identify every blocking connector and include at least:

```text
requested_start_day
requested_end_day
connector_id
earliest_ingestdb_day
blocked_reason=integrity_range_overlaps_ingestdb_boundary
```

If a requested connector has no rows anywhere in IngestDB, it has no IngestDB boundary for this check and the requested end date remains the applicable limit.

This request-level boundary rule applies equally to:

- `--check-only`;
- `--run-backfill --dry-run`;
- real `--run-backfill`;
- Integrity-backed R2 structure migration.

Prune Daily moves a connector's boundary forwards by safely writing and verifying connector-day observation history and then deleting the corresponding IngestDB observations.

### No routine second boundary check

The boundary is an operational invariant, not a per-day race detector. Once the request-level check has passed, Integrity does not need to repeat the full boundary query immediately before live writes merely because Prune Daily may be running on unrelated work.

Prune Daily deleting older rows can only move a valid boundary forwards. An observation arriving unexpectedly behind an established boundary is a separate system fault and MUST be reported and reconciled explicitly rather than normalised into a patchy storage model.

## Concurrent operation

Integrity MUST NOT require a global check that all Prune Daily work has stopped.

The following is valid and supported:

```text
Integrity writes SOS history
while
Prune Daily writes or prunes another connector
```

The system prevents conflicting mutations by locking the exact shared resources rather than excluding a whole process.

Check-only and dry-run Integrity do not mutate live R2 and do not acquire writer locks.

Real writers MUST use the common lock namespaces and key derivation defined below.

## Lock implementation contract

The canonical implementation uses PostgreSQL advisory locks in the operational Supabase database.

A shared helper MUST own:

- lock namespaces;
- environment identity;
- deterministic advisory-lock key derivation;
- bounded acquisition;
- structured diagnostics;
- release in `finally` paths.

All writers MUST call that shared helper. They MUST NOT independently derive competing advisory-lock keys.

Lock identities MUST include the deployment environment so TEST and LIVE cannot share an advisory-lock identity accidentally.

The implementation SHOULD use non-blocking advisory-lock attempts with a short bounded retry period. It MUST NOT wait indefinitely. Failure to acquire a required lock within the configured bound is a controlled fail-closed result.

The database session holding a session-level advisory lock MUST remain open for the whole protected section. Connection loss releases the lock automatically. Every normal exit, error and cancellation path MUST attempt explicit release.

Locks coordinate writers. They do not prove data validity and do not replace manifest, hash, count, read-back, prune-gate or final-verification requirements.

## Lock scope 1: connector-day writer lock

The connector-day writer lock protects one exact:

```text
day_utc + connector_id
```

It is required for live mutation by:

- Prune Daily Phase B;
- real Integrity repair;
- Integrity-backed migration;
- explicit canonical history repair tools.

The lock protects the affected connector-day's:

- observation Parquet objects;
- observation pollutant manifests;
- observation connector manifest;
- AQI data and debug connector objects and manifests when produced;
- connector-targeted observation indexes;
- connector-targeted AQI indexes;
- exact-prefix cleanup or replacement performed by the same operation.

The lock MUST be acquired before the first live mutation for the connector-day and held until the final connector-scoped write and read-back verification has completed or failed safely.

A writer that cannot acquire this lock MUST NOT mutate that connector-day.

The connector-day lock allows unrelated work to continue. For example:

```text
Integrity:   day 2026-07-26, connector 1
Prune Daily: day 2026-07-20, connector 2
```

These operations do not conflict.

Two operations targeting the same connector-day do conflict, regardless of whether they are Prune Daily, Integrity, migration or maintenance runs.

## Lock scope 2: day-finalisation lock

Different connectors may be written concurrently for the same UTC day, but they share parent day manifests and day-level aggregate metadata.

The day-finalisation lock protects one exact:

```text
day_utc
```

It serialises updates to:

- the observation day manifest;
- the AQI data day manifest;
- the AQI debug day manifest;
- any day-level aggregate metadata that represents more than one connector.

The finaliser MUST acquire the day lock before reading the current parent manifests used for the merge.

After acquiring the lock it MUST:

1. read the latest valid current day manifest or current canonical connector-manifest set;
2. merge connector results produced by the current run;
3. preserve valid connectors already present for the day;
4. replace only connector references deliberately changed by the current run;
5. write the updated parent manifest once;
6. read back and verify the final parent manifest;
7. release the day lock.

The finaliser MUST NOT construct a day manifest solely from:

- the current Prune Daily candidate rows;
- the current Integrity repair actions;
- the connectors written by the current run;
- a single source system's expected connector set.

This prevents a lost update such as:

```text
Integrity adds connector 1
Prune Daily adds connector 2
last writer accidentally drops the other connector
```

### Normal parent-manifest read cost

The normal merge path reads the existing small JSON day manifest after acquiring the lock. It does not reread unchanged connectors' Parquet files.

The finaliser may trust valid unchanged connector references already present in the current day manifest. It verifies the connectors changed by the current run and the newly written combined parent manifest.

If the parent manifest is absent or structurally invalid, the finaliser may use a bounded prefix listing and connector-manifest rediscovery as a recovery path. Prefix discovery is not the normal path.

## Lock scope 3: global index-finalisation lock

Some latest and discovery indexes aggregate more than one day or connector. Concurrent writers on different days can therefore target the same small global index objects.

A single environment-scoped global index-finalisation lock protects updates to:

- observation latest indexes;
- AQI latest indexes;
- other global discovery metadata built from multiple day or connector manifests.

A run MUST:

1. finish its connector-scoped writes and indexes;
2. finish each affected day finalisation;
3. acquire the global index lock;
4. reread the current metadata required for the aggregate update;
5. update the affected aggregate/latest payloads once;
6. use deterministic byte-stable put-if-changed behaviour;
7. read back and verify changed payloads;
8. release the global lock.

The global lock MUST be held only for aggregate finalisation. It MUST NOT surround source acquisition, Parquet generation or the complete Prune Daily or Integrity run.

## Lock ordering and deadlock prevention

Writers MUST use this lifecycle:

```text
connector-day write lock
acquire, write, verify, release

then

day-finalisation lock
acquire, merge, verify, release

then

global index-finalisation lock
acquire, rebuild aggregates, verify, release
```

A process MUST NOT hold a connector-day lock while waiting for a day-finalisation lock. It MUST NOT hold a day-finalisation lock while waiting for the global index lock.

When a run affects multiple connector-days, connector-day locks SHOULD be acquired and released one unit at a time in deterministic `day_utc, connector_id` order. Parent finalisation occurs afterwards once per distinct affected day.

This sequential non-nested policy is the primary deadlock prevention rule.

## Shared connector-day writer

Prune Daily and Integrity use different authoritative sources, but they MUST converge on one canonical R2 v2 writer implementation.

The caller owns:

- source selection;
- source acquisition;
- the Integrity boundary check;
- Prune Daily candidate selection;
- prune-gate updates;
- IngestDB deletion;
- run-specific audit and reporting.

The shared connector-day writer owns:

- canonical observation normalisation;
- canonical `verification_status` handling;
- observation-content hashing;
- Parquet serialization;
- pollutant manifests;
- connector manifests;
- observation-derived AQI calculation when required;
- AQI data and debug connector outputs;
- connector-targeted indexes;
- connector-scoped read-back verification;
- connector-day lock acquisition and release.

The shared writer MUST NOT:

- decide whether an Integrity request crosses IngestDB;
- set or clear prune gates;
- delete IngestDB observations;
- infer a whole-day connector set from the current caller alone;
- run chart metrics maintenance.

## Shared day finaliser and indexes

Connector and pollutant leaf indexes remain scoped by day, connector and pollutant. They are updated only for connectors changed by the run.

After all connector writes for a run:

```text
collect affected days
finalise each affected day once
update global/latest indexes once
```

A day may be finalised again in a later run when another connector is added or repaired. "Once" means once per affected day within one run, not once forever.

The routine path MUST NOT perform a second unconditional full history-index rebuild after the targeted shared finaliser has completed successfully. A full index builder may remain as an explicit repair or maintenance command.

New manifests MUST contain the timeseries row-count metadata needed to build targeted indexes without rereading newly written Parquet. Reading Parquet to reconstruct missing legacy metadata is a recovery operation, not the normal writer path.

## Prune-gate ownership

The connector-day deletion gate belongs exclusively to Prune Daily.

Only Prune Daily may set or clear:

```text
uk_aq_ops.prune_connector_day_gates
```

Its meaning is narrowly:

> Prune Daily has written and verified the permanent R2 observation history corresponding to this exact IngestDB connector-day and may delete those IngestDB observations.

Integrity, migration and shared writer code MUST NOT create, backfill, clear or complete prune connector-day gates.

Historical R2 connector-days with no corresponding IngestDB observations require no prune gate.

The shared writer returns verified connector evidence to Prune Daily. Prune Daily owns the subsequent gate update and deletion decision.

AQI success is not a prerequisite for the connector observation deletion gate. The detailed separation is defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) and [`prune_connector_day_gate.md`](prune_connector_day_gate.md).

## Migration ownership

R2 structure migration is historical work and is performed by Integrity or an Integrity migration mode through the shared writer and finalisers.

Migration MUST:

- obey the request-level IngestDB boundary;
- use the same connector-day, day-finalisation and global-index locks for live writes;
- preserve existing valid connectors and out-of-scope children;
- write canonical v2 manifests and indexes;
- perform read-back verification;
- never create prune gates merely because migrated R2 history is valid.

Prune Daily does not participate in historical structure migration unless it is independently archiving an eligible connector-day from IngestDB through its normal path.

## Structured diagnostics

Every live writer report MUST distinguish:

```text
connector_day_lock
 day_utc
 connector_id
 acquired
 wait_ms
 outcome

day_finalisation_lock
 day_utc
 acquired
 wait_ms
 outcome

global_index_lock
 acquired
 wait_ms
 outcome
```

Integrity reports additionally record the complete request-level IngestDB boundary result for every requested connector.

Lock-unavailable outcomes MUST identify the exact lock scope without exposing database credentials or raw internal lock keys unnecessarily.

## Validation policy

This is a concurrent-writer and deletion-safety contract. A narrow deterministic structural check is genuinely required before deployment.

It MUST prove:

- identical logical resources derive identical advisory-lock identities;
- different connector-days do not share a connector-day lock;
- different connectors on the same day share the day-finalisation lock but not the connector-day lock;
- all environments use distinct lock identities;
- parent-manifest merging preserves an existing connector when a new connector is added;
- two serialised day finalisations cannot lose the first finaliser's connector;
- a request crossing any requested connector's IngestDB boundary fails as one complete request;
- Integrity and migration never update prune connector-day gates.

Before deployment, run only the smallest syntax, SQL-structure and directly relevant deterministic checks required to establish structural viability. Do not add a broad speculative pre-implementation test suite.

Functional acceptance occurs through real TEST operation:

1. run Prune Daily and Integrity concurrently on non-conflicting connector-days;
2. confirm both connector writes complete and their parent manifests retain all connectors;
3. confirm a same-connector-day collision fails closed through the shared lock;
4. confirm a request crossing one connector's IngestDB boundary fails before source or R2 work;
5. confirm only Prune Daily writes connector-day prune gates;
6. confirm targeted indexes and aggregate/latest indexes remain complete without an unconditional full rebuild.
