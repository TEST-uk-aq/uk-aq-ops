# Prune Daily connector-day deletion gate

## Authority and purpose

This document defines the authoritative deletion-safety gate used by Prune Daily when deleting observations from IngestDB after R2 v2 observation history has been written and verified.

It supplements:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`integrity.md`](integrity.md).

Where older wording conflicts with this document, this document is authoritative for connector-day prune-gate ownership, observation-deletion eligibility and the separation between observation retention and AQI completion.

## Safety objective

Prune Daily compares and deletes observations by:

```text
connector_id + UTC hour
```

The permanent-history deletion decision MUST therefore be made at:

```text
day_utc + connector_id
```

The system MUST satisfy both rules:

- no IngestDB observation bucket may be deleted unless the same connector-day has complete, verified permanent R2 v2 observation history;
- an incomplete or failed connector-day MUST NOT by itself block deletion for another connector whose own connector-day history is complete and verified.

The presence of any R2 object, a latest R2 date, a complete different connector, a true whole-day gate or successful AQI output is not sufficient evidence for connector-day deletion.

## Connector-day gate

The connector-specific gate is stored in:

```text
uk_aq_ops.prune_connector_day_gates
```

Its logical primary key is:

```text
(day_utc, connector_id)
```

The relation MUST remain private to operational database roles and MUST NOT be exposed as an anonymous or authenticated public API.

The canonical schema stores at least:

```text
day_utc
connector_id
history_done
history_run_id
history_manifest_key
history_manifest_hash
history_row_count
history_file_count
history_total_bytes
history_completed_at
completion_source
updated_at
```

`history_manifest_key` identifies the canonical observation connector manifest:

```text
history/v2/observations/day_utc=<D>/connector_id=<connector>/manifest.json
```

`history_manifest_hash` binds the gate to the exact verified connector-manifest content.

A gate row without a non-empty canonical manifest key, valid manifest hash, valid completion timestamp and internally consistent counts MUST be treated as incomplete even if `history_done=true` was stored incorrectly.

The only supported normal completion source is:

```text
prune_daily_phase_b
```

Integrity, migration and generic shared-writer code do not establish prune gates.

## What the connector-day gate means

A true connector-day gate means:

> Prune Daily has written and verified the permanent R2 observation history corresponding to this exact IngestDB connector-day and may delete those IngestDB observations.

It authorises deletion only for IngestDB observation buckets with the exact same:

```text
day_utc + connector_id
```

It does not authorise:

- another connector on the same day;
- another day for the same connector;
- AQI deletion;
- whole-day completion;
- replacement of parent day manifests or global indexes;
- deletion based only on an aggregate day gate;
- historical gate creation for R2 data that no longer exists in IngestDB.

## Observation retention and AQI are separate

Observation retention follows:

```text
IngestDB observations
        ↓
verified R2 v2 observation history
        ↓
connector-day prune gate
        ↓
delete matching IngestDB observations
```

AQI is derived afterwards from canonical observation data.

AQI calculation, AQI data/debug writes, AQI parent manifests or AQI indexes are not prerequisites for the connector-day observation deletion gate.

Therefore:

- an AQI failure MUST NOT prevent a successfully verified observation connector-day gate from becoming true;
- an AQI failure MUST NOT revoke an already valid observation connector-day gate;
- an AQI failure MAY keep the aggregate day gate or AQI-specific completion state incomplete;
- an AQI data/debug connector-set mismatch is an AQI-history fault, not evidence that verified observation retention failed.

The observation-derived AQI contract is defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

## Requirements before setting `history_done=true`

Prune Daily may set the connector-day gate complete only after all of the following succeed for the exact connector-day:

1. The frozen IngestDB source rows for the connector-day are identity-pinned for the current Phase B attempt.
2. Every canonical observation pollutant partition selected for the connector-day has been written through the canonical R2 v2 writer.
3. Every referenced Parquet object and pollutant manifest exists and has passed the required read-back validation.
4. Observation row counts, `verification_status_counts` and `observation_content_hash` metadata satisfy the active contracts.
5. The canonical observation connector manifest has been built from the final child manifests.
6. The connector manifest key and `manifest_hash` have been read back and verified.
7. Required connector-targeted observation indexes have been updated and verified without dropping unrelated entries.
8. Any mandatory connector-scoped prune comparison or equivalent configured safety check has succeeded.
9. No connector-scoped write, validation or index failure remains unresolved.

Whole-day observation manifests, AQI outputs, AQI day manifests and global whole-day completion are not prerequisites for this connector-day deletion gate.

Object existence alone is insufficient. A manifest that cannot be parsed, does not match its identity, references missing children, contains invalid hashes or counts, or fails the active schema contract MUST leave the gate incomplete.

## Prune Daily ownership and sequence

Only Prune Daily owns this gate.

For each Phase B connector-day candidate, Prune Daily MUST:

1. acquire the shared connector-day writer lock defined in [`history_writer_coordination.md`](history_writer_coordination.md);
2. mark or keep the affected connector-day gate incomplete before replacing its canonical observation history;
3. write and verify the connector-day observation history through the shared writer;
4. update and verify required connector-targeted observation indexes;
5. release the connector-day writer lock after connector-scoped verification;
6. upsert the connector-day gate as complete with the exact final connector manifest identity and audit evidence;
7. calculate and write observation-derived AQI separately;
8. perform day and global finalisation through their own locks;
9. allow deletion only through the exact completed connector-day gate.

The gate update MUST remain a Prune Daily caller responsibility. The shared writer returns verified evidence but MUST NOT set or clear the gate itself.

If the connector write, validation, required observation index or mandatory comparison fails, the gate MUST remain false or be invalidated. A failed replacement MUST NOT preserve stale true evidence for content that was being changed.

## Integrity ownership

Integrity operates only in the continuous historical region before each requested connector's earliest IngestDB day, as defined in [`history_writer_coordination.md`](history_writer_coordination.md).

Integrity MUST NOT:

- create connector-day prune gates;
- set a connector-day prune gate true;
- set a connector-day prune gate false;
- backfill historical connector-day gates;
- use prune gates as proof of R2 history correctness;
- make gate completion part of historical migration.

Integrity check-only and dry-run do not mutate live R2 or prune gates. Real Integrity and migration use the shared R2 writer and locking contract but remain outside prune-gate ownership.

A historical R2 connector-day with no corresponding IngestDB observations requires no prune gate because no IngestDB deletion is awaiting authorisation.

The manual historical gate-completion path is not part of the supported steady-state contract. `scripts/backup_r2/uk_aq_complete_integrity_connector_gates.mjs` should be retired when implementation is brought into line with this contract.

## Existing historical gate rows

Existing gate rows previously created from Integrity or historical adoption do not need to be bulk-deleted as part of an urgent change.

However:

- no new historical rows may be created merely because R2 history exists;
- normal Prune Daily MUST NOT scan a historical backlog of missing gates;
- a historical row is irrelevant when no corresponding IngestDB observations remain;
- a gate used for deletion MUST still match the exact current connector manifest and current Prune Daily source evidence.

No historical gate migration is required for the R2 structure migration.

## Aggregate day gate

The separate aggregate relation remains:

```text
uk_aq_ops.prune_day_gates
```

It represents broader whole-day completion and may remain dependent on:

- all expected connector-day observation work;
- canonical observation day manifests;
- AQI data and debug outputs;
- AQI day manifests;
- affected day and global indexes;
- other whole-day finalisation checks.

It MUST NOT be used as the deletion-safety filter for individual connector-hour observation buckets.

A false aggregate day gate MUST NOT block deletion for an independently complete connector-day. A true aggregate day gate MUST NOT substitute for a missing or invalid connector-day gate.

The aggregate day gate may be audited or removed separately if it has no remaining necessary consumer. That audit does not change connector-specific deletion safety.

## Prune filtering contract

The normal pre-repair and post-repair deletion paths MUST apply the connector-day gate independently to every candidate bucket.

The filter MUST:

1. derive `day_utc` from the bucket's UTC `hour_start`;
2. retain the exact `connector_id`;
3. query evidence for distinct `(day_utc, connector_id)` pairs;
4. allow a bucket only when the exact pair has valid completed evidence;
5. block only the incomplete pair;
6. never fall back to a day-only lookup;
7. ignore AQI completion when deciding observation deletion.

The application map key MUST include both values, for example:

```text
<day_utc>|<connector_id>
```

A blocked bucket should use a connector-specific reason such as:

```text
history_not_complete_for_connector_day
```

The same rules apply after an ObsAQIDB fingerprint repair and recheck.

## Failure and invalidation rules

The connector-day gate fails closed.

Set or keep `history_done=false` when:

- the frozen IngestDB source identity changes before completion;
- a connector manifest or child manifest is missing or invalid;
- observation content hashes or verification-status counts fail validation;
- a required connector-targeted observation index is missing, stale or unverifiable;
- a live connector-day replacement starts but does not finish successfully;
- a mandatory connector-scoped comparison fails;
- gate evidence does not match the final canonical connector manifest identity;
- the connector-day writer lock cannot be acquired.

An AQI-only failure after verified observation completion does not invalidate the connector observation gate.

A failure for connector A on day D MUST NOT clear a valid gate for connector B on day D unless B's own content or evidence changed.

## Locking contract

Prune Daily follows the common lock hierarchy in [`history_writer_coordination.md`](history_writer_coordination.md):

```text
connector-day writer lock
then release

day-finalisation lock
then release

global index-finalisation lock
then release
```

Prune Daily and Integrity may run concurrently when they do not target the same locked resource.

The connector-day gate itself is not a concurrency lock. Advisory locks prevent concurrent R2 mutation; the gate authorises later IngestDB deletion after verified completion.

## Run budget and graceful stopping

The Phase B internal budget is the primary operational deadline. The outer workflow timeout is a final guard only.

The implementation MUST reserve enough time to:

- stop starting new connector-days;
- release held locks;
- leave incomplete connector-day gates false;
- clean up partial output or preserve a safe resumable checkpoint;
- write the Prune Daily report and task-health result;
- close database and external-service clients cleanly.

A stage MUST NOT start when the remaining budget is below its conservative minimum completion allowance.

A budget stop is retry-safe and MUST return a controlled reportable outcome rather than relying on forced process termination.

## Structured diagnostics

Prune summaries and logs MUST distinguish connector deletion gates from AQI and aggregate day completion.

They should expose bounded fields equivalent to:

```text
connector_history_gate_allowed_bucket_count
connector_history_gate_blocked_bucket_count
connector_history_gate_blocked_buckets_preview
connector_day_lock_outcomes
aqi_history_outcome
aggregate_day_outcome
```

Blocked previews include both `day_utc` and `connector_id`.

An AQI-only failure MUST be reported as AQI history incomplete rather than as an observation deletion-gate failure.

## Validation policy

This is deletion-safety behaviour, so one narrow deterministic pre-deployment check is genuinely required.

It MUST prove that, for the same UTC day:

- connector 1 with an incomplete connector-day gate remains blocked;
- connector 2 with a complete and valid connector-day gate is allowed;
- a true aggregate day gate cannot substitute for connector 1's missing gate;
- a false aggregate day gate does not block connector 2;
- AQI failure does not block or revoke connector 2's verified observation gate;
- a failed connector-day observation write invalidates only the affected connector gate;
- Integrity and the shared writer cannot update prune gates.

Before deployment, run only the smallest syntax, SQL-structure and directly relevant deterministic checks required to establish structural viability. Do not add a broad speculative test suite.

Functional acceptance occurs through real TEST operation:

1. run one normal non-dry-run Prune Daily operation;
2. confirm a connector with valid R2 observation history is pruned even if AQI or another connector on the same day is incomplete;
3. confirm an incomplete connector remains in IngestDB with a connector-specific blocked reason;
4. confirm only Prune Daily created or changed the relevant connector-day gate;
5. confirm concurrent non-conflicting Integrity work does not block Prune Daily;
6. confirm AQI failure is reported separately and does not revoke successful observation retention.

## Rollback

The safe operational rollback is:

1. set Prune Daily to dry-run if deletion behaviour is uncertain;
2. revert the deletion filter and gate-writing code to the last known safe implementation;
3. leave the additive connector-day gate table in place but unused;
4. investigate gate evidence before re-enabling deletion.

Rollback MUST NOT delete verified R2 history or gate audit evidence as part of an urgent code rollback.
