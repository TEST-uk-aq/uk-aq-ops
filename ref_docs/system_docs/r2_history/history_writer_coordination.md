# R2 v2 shared history writer coordination

## Authority and scope

This document defines the authoritative coordination contract for canonical R2 v2 observation-history writers and their shared writer/finaliser ownership.

It applies to:

- Prune Daily Phase B observation-history work;
- all Integrity modes that inspect or mutate canonical observation history;
- SOS-light;
- Integrity-backed R2 structure migration/backfill;
- explicit observation-history repair or maintenance commands;
- the normal R2-to-Dropbox history backup while it establishes and publishes the canonical observation backup generation.

It supplements:

- [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md);
- [`integrity.md`](integrity.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`timeseries_binding_contract.md`](timeseries_binding_contract.md).

For cross-run observation coordination, [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md) is authoritative.

The previous model that allowed Prune Daily and Integrity to run concurrently under connector-day, day-finalisation and global-index advisory locks is retired as the target observation coordination model.

Existing implementation may temporarily retain those finer locks while code is brought into line, but they MUST NOT be treated as the long-term cross-run observation safety boundary.

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

Before source acquisition, Dropbox comparison, proposal generation or live R2 mutation, every Integrity mode MUST determine the earliest UTC day represented in IngestDB for every connector included in the request.

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
- wait for Prune Daily to move the boundary while holding the global observation operation lock.

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
- SOS-light;
- Integrity-backed R2 structure migration;
- future Integrity Factory runs.

Prune Daily moves a connector's boundary forwards by safely writing and verifying connector-day observation history and then deleting the corresponding IngestDB observations.

## One cross-run observation operation lock

Prune Daily, Integrity and the normal R2-to-Dropbox observation backup MUST NOT operate against the canonical observation generation at the same time.

They share the one database-local session advisory lock defined by [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md):

```text
uk_aq:r2_history:v2:observations_global_operation
```

The high-level rule is:

```text
Prune Daily owns the canonical observation generation
OR
Integrity owns the canonical observation generation
OR
Dropbox backup owns the canonical observation generation
```

Observation migration/maintenance also uses the same lock while active.

A process that cannot acquire the lock within the bounded acquisition period fails or defers cleanly.

This global lock is deliberately broader than the exact connector/day/pollutant mutation unit. The system does not need concurrent observation mutation/backup throughput enough to justify the additional cross-run coordination complexity.

Normal public/private history readers do not participate in this lock.

## Dropbox backup ownership

The R2-to-Dropbox history backup is treated differently from an ordinary reader because it publishes the persistent observation backup generation later used by Integrity and SOS-light.

The backup MUST acquire the global observations operation lock before selecting the R2 observations-root generation used for its observation inventory/copy.

It holds the lock through successful publication of a complete Dropbox checkpoint for that same stable observations-root generation.

The minimum protected sequence is:

```text
acquire global observations operation lock
-> pin current R2 observations-root identity
-> build/refresh observation backup inventory
-> copy required observation changes
-> verify required copied observation objects/state
-> publish fully processed Dropbox observations-root checkpoint
-> release global observations operation lock
```

The backup MAY hold the lock for the complete history-backup workflow, including non-observation domains, when that is structurally simpler.

If the backup cannot acquire or retain the lock, it MUST fail or defer the observation backup. It MUST NOT advance the fully processed observations-root checkpoint for a generation that was not held stable throughout the required observation backup work.

## Integrity starting-state gate

Integrity acquires the global observation operation lock before establishing Dropbox currentness.

After acquisition and after the request-level IngestDB boundary precondition has passed, Integrity MUST establish that the selected complete Dropbox checkpoint has fully processed the same committed observations-root content identity currently present in live R2.

The normal equality is:

```text
live R2 observations-root content_hash
    ==
Dropbox checkpoint fully processed observations-root content hash
```

The backup/checkpoint completeness rules are defined in [`../backup_and_recovery/r2_history_dropbox_backup_contract.md`](../backup_and_recovery/r2_history_dropbox_backup_contract.md).

If the equality/currentness proof cannot be established, Integrity releases the global lock and stops before normal comparison/repair work.

The accepted backup/checkpoint/root identities are pinned for the run. The global lock then prevents Prune Daily from changing canonical observation history and prevents the normal Dropbox backup from changing the pinned Dropbox observation baseline during source comparison, proposal construction, repair, finalisation or verification.

A write-enabled Integrity run may legitimately leave live R2 newer than Dropbox when it finishes. The next Integrity run remains blocked until a later complete Dropbox backup again matches the current committed observations root. Prune Daily remains allowed to run in that interval, but each Prune/backup operation remains mutually exclusive through the same global lock.

## Shared canonical observation writer

Prune Daily and Integrity use different authoritative sources, but they MUST converge on one canonical observation writer implementation.

The caller owns:

- source selection;
- source acquisition;
- Integrity boundary checking;
- Dropbox-currentness checking where Integrity applies;
- Prune Daily candidate selection;
- prune-gate updates;
- IngestDB deletion;
- run-specific audit/reporting.

The shared observation writer owns:

- canonical observation normalisation;
- canonical `verification_status` handling;
- observation-content hashing;
- deterministic Parquet serialisation and physical writer version;
- pollutant manifests;
- connector manifests;
- target observation indexes;
- connector-scoped read-back verification;
- post-v3 exact segment/scoped index metadata where applicable.

The shared writer MUST NOT:

- decide whether an Integrity request crosses the IngestDB boundary;
- decide whether Dropbox is current enough for an Integrity run;
- set or clear prune gates;
- delete IngestDB observations;
- infer a whole-day connector set from the current caller except where the active SOS-light contract explicitly defines a complete-day replacement;
- run chart metrics maintenance.

A shared lock wrapper around different writer implementations is not sufficient. Canonical physical/data/index semantics must remain shared.

## Deterministic parent finalisation

The global observation operation lock means there is no second Prune/Integrity process racing the owning run's observation parent publication.

Writers MUST still finalise deterministically and bottom-up.

For normal non-SOS observation updates:

1. write and verify changed pollutant data/manifests;
2. rebuild and verify the affected connector manifest from the complete valid child set;
3. rebuild and verify each affected day manifest from the complete committed connector set;
4. rebuild affected month manifests from current committed day manifests;
5. rebuild affected year manifests from current committed month manifests;
6. rebuild the observations-root manifest from current committed year manifests;
7. publish dependent observation indexes/latest metadata in the order required by their active contracts.

A parent MUST NOT be constructed solely from the children changed by the current operation when its contract represents a broader complete child set.

Sparse affected-day sets remain exact. They MUST NOT be expanded into all intervening calendar days merely because the earliest and latest affected dates are far apart.

## Internal parallelism

The global observation operation lock is a cross-run boundary, not a prohibition on internal parallelism.

One owning Integrity invocation MAY prepare or build independent day/connector/pollutant work concurrently when its own orchestration guarantees:

- immutable run identity;
- deterministic dependency ordering;
- no two workers silently publish incompatible versions of the same parent;
- parent work waits for required child work;
- final verification sees the complete run result.

Future Integrity Factory queue claims or worker claims are internal ownership controls. They are not additional cross-run observation advisory locks.

Prune Daily may continue processing multiple connector-day candidates sequentially or with carefully bounded internal work as its own contract permits, while retaining sole cross-run ownership through the global operation lock.

## Fine-grained advisory locks during transition

The previous observation writer implementation used:

```text
connector-day writer lock
day-finalisation lock
global-index-finalisation lock
```

These locks may remain temporarily while the global operation lock is introduced, so the index-v3 cut-over does not require an unnecessary writer rewrite at the same time.

Once the global observation operation lock has been accepted through real TEST operation, observation-only uses of the finer locks SHOULD be retired rather than maintained as a parallel locking architecture.

A fine-grained lock that remains solely because of the retired calculated-AQI R2 pipeline is legacy implementation. It MUST NOT be preserved or described as a current coordination requirement merely because old AQI code or objects still exist. Retirement/removal is governed by [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md) and normal implementation review.

## SOS-light coordination

SOS-light retains the current complete-day replacement behaviour defined by [`sos_light_model.md`](sos_light_model.md).

The global lock plus Dropbox-currentness gate provide its external safety boundary:

```text
acquire global observation operation lock
-> prove/pin current Dropbox generation
-> build SOS replacement day
-> delete/rebuild/verify selected day
-> finalise required observation parents/indexes
-> release global observation operation lock
```

The current SOS-light complete-day model is not being redesigned merely to complete the index-v3 migration. A future Integrity Factory may deliberately replace it with narrower DCP repair units.

Because the Dropbox backup shares the same lock, the pinned Dropbox baseline cannot change during SOS-light.

## Prune-gate ownership

The connector-day deletion gate belongs exclusively to Prune Daily.

Only Prune Daily may establish/invalidate completion evidence in:

```text
uk_aq_ops.prune_connector_day_gates
```

Its meaning remains narrowly:

> Prune Daily has written and verified the permanent R2 observation history corresponding to this exact IngestDB connector-day and may delete those IngestDB observations.

Integrity, migration and shared writer code MUST NOT create, backfill, clear or complete prune connector-day gates.

Historical R2 connector-days with no corresponding IngestDB observations require no prune gate.

The shared writer returns verified connector evidence to Prune Daily. Prune Daily owns the subsequent gate update and deletion decision.

Calculated AQI is not part of connector-day deletion authority or completion. No AQI R2 success, failure, skip state, manifest, index or output is required or permitted as a normal prerequisite under [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md) and [`prune_connector_day_gate.md`](prune_connector_day_gate.md).

## AQI R2 retirement boundary

This document coordinates canonical observation-history operation only.

Calculated AQI / `aqilevels` is permanently retired as an active R2 history writer domain under [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md). There is therefore no current combined Prune Daily operation that writes both canonical observations and calculated-AQI R2 history, and no separate active AQI R2 publication lock requirement to preserve.

Calculated AQI for station-history or website display remains a derived consumer outside this R2 persistence boundary and is governed by the active `aqi-levels` contracts.

SOS-light remains observation-only.

## Migration ownership

Observation structure migration is historical work and uses the same shared physical writer/index builders as steady-state operation.

The index-v3 hard cut-over remains an offline maintenance operation with an explicit scheduler/writer freeze under [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md).

The required current Dropbox backup completes under the global operation lock first and then releases it. Migration subsequently acquires the same global lock before its final current-backup/pre-state gate and holds it for the complete canonical observation rewrite/index build/cut-over preparation. The explicit writer freeze remains required.

Migration MUST never create Prune Daily connector-day gates merely because migrated R2 history is valid.

## Structured diagnostics

Every covered run should record bounded global observation-lock evidence equivalent to:

```text
observations_global_operation_lock
 owner
 run_id
 acquired
 wait_ms
 outcome
```

Integrity additionally records:

```text
requested IngestDB boundary result by connector
selected Dropbox checkpoint identity
Dropbox processed observations-root hash
live R2 observations-root content_hash
root identity match yes/no
```

The Dropbox backup additionally records the stable R2 observations-root identity it owned while producing the fully processed observation checkpoint.

Legacy fine-lock diagnostics may remain during transition but are not the target cross-run coordination evidence.

## Validation policy

Before deployment, use only the smallest structural checks needed to prove:

- Prune Daily, Integrity and the Dropbox history backup derive the same global observation advisory-lock identity;
- a second covered process cannot enter while the first owns the lock;
- environment-label spelling does not change database-local lock identity;
- lock-session loss fails closed;
- the request-level IngestDB boundary still blocks the complete Integrity request before prohibited work;
- the Dropbox-currentness gate occurs after global lock acquisition and blocks normal Integrity work on mismatch;
- the Dropbox backup publishes a fully processed observation checkpoint only for the stable root generation protected by its lock ownership;
- the shared canonical observation writer remains common to Prune Daily and Integrity;
- Integrity/migration do not update Prune Daily connector-day gates.

Do not add a broad speculative pre-deployment test suite.

Functional acceptance occurs through real TEST operation by demonstrating that overlapping Prune Daily, Integrity and Dropbox backup invocations cannot more than one at a time enter their covered observation operation, that a completed backup produces a checkpoint matching its stable source root, and that a stale Dropbox observations generation prevents Integrity from starting normal comparison/repair work.