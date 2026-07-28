# Prune Daily atomic connector-day deletion

## Authority and scope

This document is an authoritative amendment to:

- [`prune_connector_source_identity.md`](prune_connector_source_identity.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

Where older wording, code, tests, plans or reports conflict with this document, this document is authoritative for:

- the unit of committed IngestDB observation deletion;
- coordination between pre-repair and post-repair eligibility;
- equivalence between the canonical source-identity row set and the SQL deletion target;
- handling of delete-batch limits;
- final connector-day drain and deleted-row-count verification;
- rollback, evidence preservation and retry behaviour;
- per-transaction and aggregate atomic-deletion diagnostics.

This contract applies to normal Prune Daily deletion and every late-arrival deletion path. Phase A repair-only operation remains non-deleting.

This contract does not change:

- the version-1 connector-day source hash;
- the candidate or connector-gate schema unless implementation analysis proves a schema change is structurally required;
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

A second safety problem exists when deletion authority is calculated from a canonical joined row set but the delete SQL targets a broader raw-table set. Rows that were not represented by the source identity could then be deleted without verified R2 evidence.

## Load-bearing deletion-set invariant

For one exact connector-day, the following MUST describe the same logical canonical observation row set:

```text
fresh current source-identity rows
=
rows covered by final hourly fingerprint eligibility
=
rows targeted by deletion SQL
=
rows counted by post-delete drain verification
```

The active deletion implementation MUST NOT calculate deletion authority from one canonical row set and then execute a broader raw observation-table deletion.

If the canonical v2 observation source requires successful joins through:

```text
observations
→ timeseries
→ phenomena
→ observed_properties
```

and requires a non-null canonical pollutant code, the deletion target and drain verification MUST use the same joins and filters, or a shared database relation that is demonstrably equivalent.

A raw observation outside the canonical source-identity row set because of missing, invalid or unmapped metadata:

- MUST NOT be silently deleted under a source identity that did not include it;
- MUST remain for diagnosis or an explicitly authorised recovery path;
- MUST cause the affected connector-day to fail closed when the raw and canonical scopes cannot be proven equivalent.

Code-level similarity or matching date predicates are not sufficient. The active SQL paths must structurally prove that identity, eligibility, deletion and drain checks describe the same set.

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
4. re-fetch the complete UTC connector-day from IngestDB and ObsAQIDB;
5. perform the required final recheck for every current canonical hour;
6. construct one final deletion plan grouped by exact `day_utc + connector_id`;
7. execute at most one deletion transaction for that connector-day in the run.

The final plan MUST combine buckets that were already matched before repair with buckets that became matched after repair.

Prune Daily MUST NOT:

- commit pre-repair buckets and then open a second transaction for post-repair buckets from the same connector-day;
- commit a subset merely because those hours were eligible earlier in the run;
- treat a successful hour as independent deletion authority when another current hour in the same connector-day remains mismatched or unverified.

## Final whole-connector-day eligibility

Immediately before opening the deletion transaction, Prune Daily MUST have a final connector-day eligibility result covering the complete current canonical IngestDB connector-day.

Every current hour bucket represented by the connector-day source identity MUST be deletion-eligible under the existing ObsAQIDB comparison and repair rules.

The final plan is eligible only when:

- every current canonical hour appears exactly once;
- no duplicate, missing or extra planned hour exists;
- every planned hourly row count equals the final current canonical hourly count;
- every current canonical hour is fingerprint-matched with ObsAQIDB after repair;
- no unresolved mismatch remains for the connector-day;
- the connector gate authorises deletion under the current gate and source-identity contracts;
- current, candidate and gate source identities match;
- no pollutant subset or other narrower deletion filter is active under the full connector-day identity.

If any current bucket is:

- missing from the required comparison evidence;
- still mismatched;
- blocked by the connector gate;
- unresolved after repair;
- duplicated, count-different or outside an exact complete-day plan;
- otherwise ineligible under the existing prune contract;

then the complete connector-day deletion MUST be skipped and no observation row for that connector-day may be deleted in that run.

ObsAQIDB-only extra buckets retain their existing classification. This amendment does not redefine their treatment.

The final eligibility check and any ObsAQIDB network work occur before the PostgreSQL deletion transaction. No external call belongs inside the deletion transaction.

The outer run may use bounded processing windows, but a partial-day processing batch MUST NOT authorise deletion from only the hours that happened to fall within that batch. Before deletion, final eligibility is always evaluated against the complete UTC connector-day.

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
6. validate exact complete-hour plan coverage against that same transaction snapshot;
7. delete only rows in the exact canonical deletion scope, using bounded internal batches where required;
8. count the rows actually deleted by all internal batches;
9. verify that no canonical row from the validated transaction snapshot remains for that connector-day;
10. verify all required row-count equalities;
11. commit only after every condition succeeds.

The implementation MAY retain hour-oriented internal batches and reporting. Those batches are implementation details inside one connector-day transaction and MUST NOT be committed independently.

No R2, Dropbox, Supabase HTTP API, ObsAQIDB call or other external network work belongs inside the deletion transaction.

## Required row-count equalities

Before commit, the transaction MUST prove:

```text
total rows actually deleted
=
fresh current source_content_hash_row_count
=
candidate source_content_hash_row_count
=
gate source_content_hash_row_count
=
validated complete connector-day plan row total
```

It MUST also prove:

```text
remaining canonical connector-day rows = 0
```

A zero remaining canonical count alone is insufficient when the delete SQL could have targeted a broader set. Actual deleted-row equality is a separate mandatory commit condition.

A difference in any required count rolls back the whole connector-day and reports zero committed rows.

## Delete caps and incomplete drain

Existing delete batch size and maximum-batches-per-hour controls remain safety limits.

If any hour or internal batch reaches its cap while a row from the validated connector-day snapshot remains, if the final canonical scope is not empty, or if the deleted-row count does not equal the validated source-identity row count:

1. roll back the complete connector-day transaction;
2. report a controlled connector-specific failure result;
3. report zero committed deleted rows for that connector-day;
4. retain all IngestDB observations through rollback;
5. retain the candidate and gate evidence when their source identity still matches;
6. allow a later Prune Daily run to retry.

A delete-cap, incomplete-drain, scope or deleted-row-count rollback is not by itself a source-identity mismatch and MUST NOT invalidate otherwise valid candidate or gate evidence.

If the current source identity does not match the persisted evidence, the existing fail-closed source-identity invalidation rules still apply.

Recommended distinct failure reasons include:

```text
connector_day_not_fully_eligible
connector_day_scope_mismatch
connector_day_delete_cap_reached
connector_day_not_fully_drained
connector_day_deleted_row_count_mismatch
source_identity_transaction_conflict
```

## Evidence invalidation versus rollback preservation

Evidence is invalidated only when it no longer describes the current canonical source, including:

- current, candidate or gate source-identity mismatch;
- missing or malformed required identity;
- unsupported source-identity contract version;
- value-only or `verification_status`-only current-source change;
- canonicalisation failure that prevents trustworthy identity comparison.

Operational inability to complete an otherwise valid deletion attempt preserves valid candidate and gate evidence while retaining observations. This includes:

- delete-cap rollback;
- incomplete-drain rollback;
- deleted-row-count rollback;
- transaction conflict;
- temporary database error;
- partial or malformed deletion plan rejected before deletion;
- connector-day scope mismatch.

Only the affected connector-day may be invalidated or rolled back. Other connector-days remain independent.

## Rows inserted after the transaction snapshot

Rows inserted after the `REPEATABLE READ` snapshot are not represented by the validated source identity and MUST not be deleted by that transaction.

They remain for a later Prune Daily run. The later run will detect that current connector-day source identity no longer matches the old completed evidence and will reprocess the affected connector-day under the existing source-identity contract.

## Successful completion

A connector-day deletion result is successful only when:

- candidate, gate and current source identities matched;
- the deletion target was the exact canonical source-identity scope;
- every planned internal deletion batch completed;
- actual deleted rows equalled every required source-identity and plan count;
- the validated canonical connector-day snapshot was fully drained;
- the transaction committed;
- committed deleted-row totals are reported only after commit.

After a successful full drain, the completed candidate and gate may remain as audit evidence. No empty replacement source identity is required.

## Required diagnostics

Each connector-day result MUST emit bounded diagnostics equivalent to:

```text
day_utc
connector_id
source_identity_contract_version
source_identity_match
source_identity_failure_reason
source_identity_rows
candidate_source_identity_present
gate_source_identity_present
source_identity_invalidated_connector_days
connector_day_atomic_delete_planned
connector_day_atomic_delete_committed
connector_day_atomic_delete_rolled_back
connector_day_atomic_delete_failure_reason
connector_day_current_bucket_count
connector_day_eligible_bucket_count
connector_day_committed_deleted_rows
connector_day_remaining_snapshot_rows
```

A rolled-back connector-day always reports:

```text
connector_day_atomic_delete_committed=false
connector_day_atomic_delete_rolled_back=true
connector_day_committed_deleted_rows=0
```

Run summaries MUST distinguish:

- blocked before transaction;
- committed;
- rolled back after transaction start;
- source-evidence invalidation;
- delete-cap rollback;
- incomplete-drain rollback;
- deleted-row-count rollback;
- transaction conflict.

When normal Prune is split into multiple processing batches, the top-level aggregate summary MUST preserve and aggregate atomic deletion outcomes. Per-batch outcomes MUST NOT disappear from the final run report.

At minimum, the top-level summary retains totals equivalent to:

```text
connector_day_atomic_delete_planned_count
connector_day_atomic_delete_committed_count
connector_day_atomic_delete_rolled_back_count
connector_day_atomic_delete_blocked_bucket_count
```

It also retains bounded previews of connector-day plans and results.

Do not log raw observations.

## Focused structural validation

Before deployment, only narrow deterministic checks are required. They MUST prove:

- one connector-day containing an initially matched hour and a repaired hour uses one deletion transaction and one commit;
- no pre-repair partial commit occurs;
- one remaining mismatched hour blocks deletion of every hour for that connector-day;
- another connector on the same day may commit independently;
- final source revalidation, all internal deletes and drain verification use the same PostgreSQL session and transaction;
- the deletion target uses the same canonical joins and filters as the source-identity row set;
- a raw observation outside canonical scope is not deleted under the canonical connector-day identity;
- duplicate, missing, extra or count-different hours are rejected before deletion;
- pollutant-scoped deletion is rejected under the full connector-day identity;
- reaching a per-hour or per-run delete cap rolls back every deletion for that connector-day;
- rollback reports zero committed deleted rows;
- a non-empty final canonical snapshot rolls back;
- a deleted-row total different from the validated source-identity row count rolls back;
- valid candidate and gate evidence is retained after cap, drain, count, scope and transaction-conflict rollback;
- source-identity mismatch still invalidates only the affected connector-day;
- late-arrival deletion uses the same transaction helper and safety conditions;
- top-level multi-batch summaries aggregate planned, committed, rolled-back and blocked outcomes;
- no R2, Dropbox, HTTP, Supabase REST or ObsAQIDB call occurs inside the deletion transaction.

Run only the smallest syntax, import, SQL-structure and directly relevant deterministic checks required to establish structural viability. Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment to TEST:

1. identify a connector-day with at least two populated hours;
2. create or identify a run where one hour is initially matched and another requires repair;
3. confirm no row is deleted before repair and final recheck finish;
4. confirm the complete connector-day is deleted by one committed transaction only after every current bucket is eligible;
5. confirm actual committed deleted rows equal the persisted source-identity row count;
6. force a low delete cap in a controlled TEST run and confirm the complete connector-day rolls back with zero committed deletion;
7. confirm the valid source candidate and gate remain available for retry after cap, drain, count or transaction-conflict rollback;
8. force a final-drain or deleted-row-count mismatch and confirm full rollback;
9. introduce or identify a raw row outside canonical metadata scope and confirm it is not silently deleted;
10. confirm a mismatched connector remains untouched while another eligible connector on the same UTC day can still commit;
11. exercise a late-arrival deletion and confirm it uses the same exact scope and atomic transaction;
12. confirm per-connector and top-level batched reports distinguish atomic commit, rollback, invalidation, mismatch and cap outcomes.

Do not enable LIVE deletion until these TEST operations are clean.