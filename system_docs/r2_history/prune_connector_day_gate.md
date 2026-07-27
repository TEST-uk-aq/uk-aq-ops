# Prune Daily connector-day deletion gate

## Authority and purpose

This document defines the authoritative deletion-safety gate used by Prune Daily when deleting observations from IngestDB after R2 v2 history has been written.

It supplements:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`integrity.md`](integrity.md).

For prune eligibility, this document clarifies any older wording that refers only to a whole-day `history_done` gate. A failure for one connector MUST block that connector, but MUST NOT by itself block deletion for another connector whose own connector-day history is complete and verified.

The required design has two separate gates:

1. a connector-day deletion gate for IngestDB observation pruning;
2. an aggregate day gate for whole-day history completion.

These gates have different purposes and MUST NOT be substituted for one another.

## Safety objective

Prune Daily compares and deletes observations by:

```text
connector_id + UTC hour
```

The R2 backup safety decision MUST therefore be made at:

```text
day_utc + connector_id
```

The system MUST satisfy both of these rules:

- no IngestDB observation bucket may be deleted unless the same connector-day has complete, verified permanent R2 v2 observation history;
- an incomplete, unavailable or failed connector-day must not prevent independently complete connector-days for the same date from being pruned.

The presence of any R2 object, a latest R2 date, a complete day for a different connector, or a true aggregate day gate is not sufficient evidence for a connector-day deletion.

## Connector-day gate

The connector-specific gate is stored in:

```text
uk_aq_ops.prune_connector_day_gates
```

Its logical primary key is:

```text
(day_utc, connector_id)
```

The relation MUST remain private to operational database roles. It MUST NOT be exposed as an anonymous or authenticated public API.

The canonical schema must store at least:

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

`history_manifest_hash` binds the gate to the verified connector-manifest content. A gate row without a non-empty canonical manifest key, a valid manifest hash and a completion timestamp MUST be treated as incomplete even when `history_done=true` was stored incorrectly.

`completion_source` records the trusted writer that established the gate, such as:

```text
prune_daily_phase_b
history_integrity
```

Additional audit columns may be added, but they MUST remain deterministic operational evidence and MUST NOT weaken the required checks.

## What the connector-day gate authorises

A true connector-day gate authorises deletion only for IngestDB observation buckets with the exact same:

```text
day_utc + connector_id
```

It does not authorise:

- another connector on the same day;
- another day for the same connector;
- AQI deletion;
- whole-day completion;
- replacement of day manifests or global indexes;
- deletion based only on an aggregate day gate.

The gate protects permanent observation retention. AQI is derived from canonical observation history and is governed separately by the aggregate completion contract. An AQI or whole-day metadata failure MUST keep the aggregate day gate incomplete, but it MUST NOT revoke a connector-day observation gate whose permanent observation history and required observation indexes have already been verified.

## Requirements before setting `history_done=true`

A trusted writer may set the connector-day gate to complete only after all of the following succeed for the exact connector-day:

1. Every canonical observation pollutant partition selected for that connector-day has been written or safely adopted.
2. Every referenced Parquet object and pollutant manifest exists and has passed required read-back validation.
3. Observation row counts, `verification_status_counts` and `observation_content_hash` metadata satisfy the active contracts.
4. The canonical observation connector manifest has been rebuilt or validated from the final child manifests.
5. The connector manifest key and `manifest_hash` have been read back and verified.
6. Required connector-targeted observation indexes have been updated and verified without dropping unrelated entries.
7. Any mandatory prune comparison or other configured connector-scoped safety check has succeeded.
8. No connector-scoped write, validation or index failure remains unresolved.

Whole-day observation manifests, AQI day manifests and global whole-day completion are not prerequisites for the connector-day deletion gate. They remain prerequisites for the aggregate day gate where required by their own contracts.

Object existence alone is insufficient. A manifest that cannot be parsed, does not match its identity, references missing children, contains invalid hashes or counts, or fails the active schema contract MUST leave the connector-day gate incomplete.

## Prune Daily Phase B ownership

For the normal Phase B writer:

1. Mark the affected connector-day gate incomplete before replacing or materially revalidating its canonical observation history.
2. Write and verify the connector-day observation history.
3. Update and verify required connector-targeted observation indexes.
4. Upsert the connector-day gate as complete with the exact final connector manifest identity and audit evidence.
5. Continue whole-day observation, AQI, manifest and index finalisation.
6. Set the aggregate day gate only when the separate whole-day contract succeeds.

If the connector write, validation or index stage fails, the connector-day gate MUST remain false or be invalidated. A failed run MUST NOT preserve a stale true gate for content that was being replaced.

A previously complete Phase B candidate may populate a missing connector-day gate only after its existing canonical connector manifest and required evidence are validated. The implementation MUST NOT bulk-copy aggregate day-gate truth into connector-day rows without connector-level validation.

## Normal-run priority and existing-gate adoption

The primary purpose of the normal Prune Daily Phase B path is to complete the current eligible connector-day candidates needed for safe pruning. Existing-gate adoption is secondary maintenance and MUST NOT consume the time needed to process those current candidates.

The normal run MUST:

1. identify and prioritise the exact current connector-days that are active Phase B candidates or are immediately required by the current prune window;
2. limit any adoption of already-written connector history to that bounded active scope;
3. start current candidate processing before unrelated historical gate population;
4. leave unrelated missing historical connector-day gates incomplete for a separate explicit maintenance or Integrity operation;
5. avoid issuing one warning per unrelated historical connector-day when a bounded summary is sufficient.

A normal Prune Daily run MUST NOT scan or revalidate a broad historical backlog merely because connector-day gate rows are missing. In particular, it MUST NOT use the normal candidate limit as an implicit historical gate-migration batch that runs before live candidates.

If historical gate population is required, it MUST be an explicit, bounded and resumable maintenance operation. It must preserve progress across runs and MUST NOT retry a known incompatible connector-day on every normal Prune Daily execution unless its R2 evidence, validation contract or explicit retry state has changed.

A legacy connector-day that fails the active manifest, hash or object contract remains safely incomplete. That failure MUST NOT block current unrelated candidates and MUST NOT turn the normal Prune Daily workflow into a historical repair job.

## Integrity ownership

A real Integrity repair may establish the connector-day gate because Integrity is an approved R2 v2 writer using the same canonical observation, hash, status, manifest and index contracts.

Integrity MUST:

1. mark the affected connector-day gate incomplete before the first live R2 mutation for that connector-day;
2. complete the selected observation repair and preserve unselected canonical children;
3. perform the required live R2 read-back, hash, status-count, manifest and index verification;
4. rebuild or verify the final canonical observation connector manifest;
5. set the connector-day gate true only after the connector-level final verification succeeds;
6. leave the gate false when the repair is interrupted, blocked or fails.

`--check-only` and `--run-backfill --dry-run` MUST NOT change connector-day gate rows because they do not establish verified live R2 completion.

An Integrity run scoped to one connector MUST affect only that connector's gate rows. It MUST NOT mark another connector complete merely because it rewrote a shared day manifest or index.

## Aggregate day gate

The existing aggregate relation remains:

```text
uk_aq_ops.prune_day_gates
```

It continues to represent whole-day history completion. It may remain dependent on:

- every expected connector-day being complete;
- canonical day observation manifests;
- required AQI data and debug outputs;
- AQI day manifests;
- affected day and global indexes;
- other whole-day finalisation checks.

The aggregate day gate MUST remain false when any required connector or whole-day output is incomplete.

Prune Daily MUST NOT use `prune_day_gates.history_done` as the deletion-safety filter for individual connector-hour observation buckets after the connector-day gate is deployed. The aggregate gate remains available for workflows that genuinely require the complete day.

## Prune filtering contract

The normal pre-repair and post-repair deletion paths MUST apply the connector-day gate independently to every candidate bucket.

The filter must:

1. derive `day_utc` from the bucket's UTC `hour_start`;
2. retain the bucket's exact `connector_id`;
3. query gate evidence for the distinct `(day_utc, connector_id)` pairs;
4. allow a bucket only when the exact pair has valid completed evidence;
5. block only the incomplete pair;
6. never fall back to a day-only lookup.

The map key used in application code must include both values, for example:

```text
<day_utc>|<connector_id>
```

A blocked bucket should use a connector-specific reason such as:

```text
history_not_complete_for_connector_day
```

The same rules apply after a fingerprint repair and recheck. A connector repaired in ObsAQIDB is not deletable until its own R2 connector-day gate also permits deletion.

## Failure and invalidation rules

The connector-day gate MUST fail closed.

Set or keep `history_done=false` when:

- source aggregates change and the previous connector history is no longer proven current;
- a connector manifest or child manifest is missing or invalid;
- observation content hashes or verification-status counts fail validation;
- a required connector-targeted observation index is missing, stale or unverifiable;
- a live R2 replacement starts but does not finish successfully;
- a mandatory configured connector-scoped comparison fails;
- gate evidence does not match the canonical connector manifest identity.

A failure for connector A on day D MUST NOT clear a valid gate for connector B on day D unless B's own content or evidence was changed or invalidated.

## Phase B run budget and graceful stopping

The Phase B internal run budget is the primary operational deadline. The outer shell or GitHub Actions timeout is only a final guard and MUST NOT be the normal mechanism that stops Phase B.

The implementation MUST reserve enough time before the outer timeout to:

- stop starting new work;
- leave incomplete connector-day gates false;
- perform required partial-output cleanup or preserve a safe resumable checkpoint;
- write the Prune Daily report and task-health result;
- close database and external-service clients cleanly.

Budget checks MUST occur before every potentially long or externally bounded stage, including:

- existing-gate adoption;
- starting a connector-day candidate;
- a large observation write segment that cannot finish within the remaining allowance;
- AQI calculation and AQI object writes;
- targeted index finalisation;
- the mandatory Dropbox prune comparison.

A stage MUST NOT start when the remaining budget is below its conservative minimum completion allowance. Long external operations MUST receive a deadline, abort signal or bounded timeout derived from the remaining run budget so that they cannot continue beyond the internal deadline.

When the budget is exhausted, Phase B MUST stop cleanly with a controlled `stopped_budget` or equivalent partial outcome. It MUST NOT:

- mark an unverified connector-day gate complete;
- continue into another expensive stage after the internal deadline;
- rely on exit code 124 or forced process termination;
- lose the final structured report solely because work remains.

A budget stop is retry-safe. The next normal TEST run may resume or reprocess the incomplete connector-day using the existing candidate, checkpoint and idempotency contracts.

## Existing data and migration

The schema migration MUST be additive. The existing aggregate day gate remains in place.

Existing connector-day gate rows MUST NOT be created solely from:

- the maximum date found in R2;
- the existence of a day manifest;
- `prune_day_gates.history_done=true`;
- another connector's complete candidate;
- a broad assumption that all historical connectors were complete.

Safe initial population may use existing complete connector candidates only after validating the canonical connector manifest and required connector-level evidence. Otherwise the missing connector-day gate remains false until Phase B or a real Integrity run proves it.

No automatic destructive cleanup is part of the migration.

## Structured diagnostics

Prune summaries and logs MUST distinguish connector gate results from aggregate day completion. They should expose bounded fields equivalent to:

```text
connector_history_gate_enabled
connector_history_gate_allowed_bucket_count
connector_history_gate_blocked_bucket_count
connector_history_gate_blocked_buckets_preview
```

Blocked previews include both `day_utc` and `connector_id`.

Whole-day completion diagnostics remain separate and MUST NOT be reported as the reason an independently complete connector bucket was blocked.

Existing-gate adoption diagnostics MUST be bounded and distinguish:

```text
active_scope_adoption_attempted
active_scope_adoption_completed
active_scope_adoption_blocked
historical_adoption_skipped
stopped_for_budget
```

Equivalent names are acceptable, but a normal run MUST make clear that unrelated historical adoption was not allowed to delay current candidates.

## Validation policy

This is a deletion-safety change, so one narrow deterministic pre-deployment check is genuinely required.

The focused check MUST prove that, for the same UTC day:

- connector 1 with an incomplete connector-day gate remains blocked;
- connector 2 with a complete and valid connector-day gate is allowed;
- a true aggregate day gate cannot substitute for a missing connector-day gate;
- a false aggregate day gate does not block connector 2;
- the same separation applies to post-repair deletion candidates;
- a failed connector-day write invalidates only the affected connector gate.

The same focused check set MUST also prove that:

- current active connector-day candidates are processed before unrelated historical gate adoption;
- a broad historical backlog is not scanned by a normal run;
- insufficient budget prevents AQI, index or Dropbox-comparison work from starting;
- budget exhaustion leaves the connector gate incomplete and returns a controlled reportable outcome rather than requiring forced process termination.

Before deployment, run only the smallest syntax, SQL-structure and directly relevant deterministic checks required to establish structural viability. Do not add a broad speculative test suite.

Functional acceptance occurs through real TEST operation:

1. Deploy the additive schema and Prune Daily code to TEST.
2. Run one normal non-dry-run Prune Daily operation.
3. Confirm a connector with valid R2 connector-day history is pruned even when another connector on the same day is incomplete.
4. Confirm the incomplete connector remains present in IngestDB and is reported with the connector-specific blocked reason.
5. Confirm the aggregate day gate remains false until all required connector and whole-day work completes.
6. Confirm a later successful Phase B or real Integrity repair sets only the relevant connector-day gate.
7. Confirm the normal run does not spend its live-candidate budget scanning unrelated historical connector-days.
8. If the configured budget is reached, confirm the workflow writes its report, leaves unfinished gates false and exits through the controlled budget-stop path rather than exit code 124.

## Rollback

The safe operational rollback is:

1. set Prune Daily to dry-run if deletion behaviour is uncertain;
2. revert the code to the previous day-gate filter;
3. leave the additive connector-day gate table in place but unused;
4. investigate and correct gate evidence before re-enabling deletion.

Rollback MUST NOT drop verified R2 history or delete gate audit evidence as part of an urgent code rollback.
