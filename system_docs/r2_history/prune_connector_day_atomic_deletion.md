# Prune Daily atomic connector-day deletion

## Authority and scope

This document is an authoritative amendment to:

- [`prune_connector_source_identity.md`](prune_connector_source_identity.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md).

Where older wording, code, tests, plans or reports conflict with this document, this document is authoritative for:

- the unit of committed IngestDB observation deletion;
- coordination between pre-repair and post-repair eligibility;
- handling of delete-batch limits;
- final connector-day drain verification;
- rollback and retry behaviour.

This contract does not change:

- the version-1 connector-day source hash;
- the candidate or connector-gate schema;
- the R2 manifest format;
- the connector-day writer lock hierarchy;
- AQI separation;
- the ability for different connectors on the same UTC day to proceed independently.

## Safety problem

The persisted source identity covers every canonical observation row for one exact:

```text
day_utc + connector_id
```

It does not cover one hour or one subset of the connector-day.

Therefore the following sequence is unsafe:

```text
validate full connector-day source identity
commit deletion of some eligible hours
recalculate current connector-day identity later
```

After the first partial commit, the remaining IngestDB rows no longer have the persisted full connector-day identity. A later pre-repair, post-repair or late-arrival deletion attempt would incorrectly invalidate otherwise valid candidate and gate evidence.

A full connector-day source identity MUST NOT authorise independently committed hour-bucket deletion.

## Unit of committed deletion

The committed deletion unit is:

```text
one exact day_utc + connector_id
```

For one connector-day, Prune Daily MUST either:

```text
delete every current canonical IngestDB observation row represented by the validated connector-day identity
```

or:

```text
delete none of those rows
```

Deletion remains connector-specific. A blocked connector A on day D MUST NOT block connector B on day D when B independently satisfies this contract.

The aggregate whole-day gate remains irrelevant to this connector-specific decision.

## Eligibility discovery before deletion

Pre-repair and post-repair are eligibility and repair stages. They are not separate commit points for the same connector-day.

Prune Daily MUST:

1. perform the normal initial IngestDB versus ObsAQIDB comparison;
2. identify all repairable mismatches;
3. complete the allowed repair and receipt work;
4. perform the required final recheck;
5. construct one final deletion plan grouped by exact `day_utc + connector_id`;
6. execute at most one committed deletion transaction for that connector-day in the run.

The final plan MUST combine buckets that were already matched before repair with buckets that became matched after repair.

Prune Daily MUST NOT:

- commit pre-repair buckets and then open a second transaction for post-repair buckets from the same connector-day;
- commit a subset merely because those hours were eligible earlier in the run;
- treat a successful hour as independent deletion authority when another current hour in the same connector-day remains mismatched or unverified.

## Final whole-connector-day eligibility

Immediately before opening the deletion transaction, Prune Daily MUST have a final connector-day eligibility result covering the current IngestDB hour buckets for the exact connector-day.

Every current hour bucket represented by the connector-day source identity MUST be deletion-eligible under the existing ObsAQIDB comparison and repair rules.

If any current bucket is:

- missing from the required comparison evidence;
- still mismatched;
- blocked by the connector gate;
- unresolved after repair;
- otherwise ineligible under the existing prune contract;

then the complete connector-day deletion MUST be skipped and no observation row for that connector-day may be deleted in that run.

ObsAQIDB-only extra buckets retain their existing classification. This amendment does not redefine their treatment.

The final eligibility check and any ObsAQIDB network work occur before the PostgreSQL deletion transaction. No external call belongs inside the deletion transaction.

## Atomic deletion transaction

For each eligible connector-day, Prune Daily MUST use one retained PostgreSQL session and one transaction at:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
```

Within that transaction it MUST:

1. lock and validate the exact `history_candidates` row;
2. lock and validate the exact `prune_connector_day_gates` row;
3. read the complete current canonical IngestDB connector-day source;
4. calculate the current versioned connector-day source identity;
5. require equality between current, candidate and gate identities;
6. delete all current connector-day observations represented by that identity, using bounded internal batches where required;
7. verify that no row from the validated transaction snapshot remains for that connector-day;
8. commit only after the connector-day is fully drained.

The implementation MAY retain hour-oriented internal batches and reporting. Those batches are implementation details inside one connector-day transaction and MUST NOT be committed independently.

## Delete caps and incomplete drain

Existing delete batch size and maximum-batches-per-hour controls remain safety limits.

If any hour or internal batch reaches its cap while a row from the validated connector-day snapshot remains:

1. roll back the complete connector-day transaction;
2. report a controlled connector-specific incomplete-drain result;
3. report zero committed deleted rows for that connector-day;
4. retain all IngestDB observations from the rolled-back transaction;
5. retain the candidate and gate evidence when their source identity still matches;
6. allow a later Prune Daily run to retry.

A delete-cap rollback is not a source-identity mismatch and MUST NOT by itself invalidate valid candidate or gate evidence.

If the current source identity does not match the persisted evidence, the existing fail-closed source-identity invalidation rules still apply.

## Rows inserted after the transaction snapshot

Rows inserted after the `REPEATABLE READ` snapshot are not represented by the validated source identity and MUST not be deleted by that transaction.

They remain for a later Prune Daily run. The later run will detect that current connector-day source identity no longer matches the old completed evidence and will reprocess the affected connector-day under the existing source-identity contract.

## Successful completion

A connector-day deletion result is successful only when:

- candidate, gate and current source identities matched;
- every planned internal deletion batch completed;
- the validated connector-day snapshot was fully drained;
- the transaction committed;
- committed deleted-row totals are reported only after commit.

After a successful full drain, the completed candidate and gate may remain as audit evidence. No empty replacement source identity is required.

## Required diagnostics

Prune Daily should emit bounded connector-day diagnostics equivalent to:

```text
connector_day_atomic_delete_planned
connector_day_atomic_delete_committed
connector_day_atomic_delete_rolled_back
connector_day_atomic_delete_failure_reason
connector_day_current_bucket_count
connector_day_eligible_bucket_count
connector_day_committed_deleted_rows
connector_day_remaining_snapshot_rows
```

Failure reasons should distinguish at least:

```text
connector_day_not_fully_eligible
connector_day_delete_cap_reached
connector_day_not_fully_drained
source_identity_mismatch
source_identity_transaction_conflict
```

Do not log raw observations.

## Focused structural validation

Before deployment, only narrow deterministic checks are required. They MUST prove:

- one connector-day containing an initially matched hour and a repaired hour uses one deletion transaction and one commit;
- no pre-repair partial commit occurs;
- one remaining mismatched hour blocks deletion of every hour for that connector-day;
- reaching a per-hour or per-run delete cap rolls back every deletion for that connector-day;
- rollback reports zero committed deleted rows;
- valid candidate and gate evidence is retained after an incomplete-drain rollback;
- source-identity mismatch still invalidates only the affected connector-day;
- another connector on the same day may commit independently;
- final source revalidation, all internal deletes and drain verification use the same PostgreSQL session and transaction;
- no R2, Dropbox, HTTP, Supabase REST or ObsAQIDB call occurs inside the deletion transaction.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment to TEST:

1. identify a connector-day with at least two populated hours;
2. create or identify a run where one hour is initially matched and another requires repair;
3. confirm no row is deleted before repair and final recheck finish;
4. confirm the complete connector-day is deleted by one committed transaction only after every current bucket is eligible;
5. force a low delete cap in a controlled TEST run and confirm the complete connector-day rolls back with zero committed deletion;
6. confirm the valid source candidate and gate remain available for retry after the cap rollback;
7. confirm a mismatched connector remains untouched while another eligible connector on the same UTC day can still commit;
8. confirm the final report distinguishes atomic commit, rollback, mismatch and cap outcomes.
