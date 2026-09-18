# R2 history implementation safety contract

## Authority and scope

This document is an authoritative amendment to:

- [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`integrity.md`](integrity.md).

It records implementation requirements that must be explicit before Prune Daily or Integrity performs another real R2 mutation or IngestDB deletion, and before the Dropbox history backup is relied upon as the current Integrity/SOS observation baseline.

Where older wording conflicts with this document, this document is authoritative for:

- advisory-lock environment identity;
- global observations operation exclusion;
- what qualifies as the shared canonical observation writer;
- exact affected-day finalisation;
- deletion-time connector-gate validation;
- current connector-day source identity, as detailed by [`prune_connector_source_identity.md`](prune_connector_source_identity.md);
- aggregate day-gate totals;
- retirement of calculated AQI / `aqilevels` from active R2 Phase B operation, as owned by [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md);
- Integrity boundary/current-backup preflight order.

## Global observations operation exclusion

Canonical observation-history cross-run coordination is defined by [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md).

Prune Daily, Integrity and the normal R2-to-Dropbox history backup MUST use the same database-local session advisory lock for their covered observation operation:

```text
uk_aq:r2_history:v2:observations_global_operation
```

TEST and LIVE isolation is provided by their separate Supabase projects and PostgreSQL advisory-lock managers.

Environment labels such as `TEST`, `LIVE` and `CIC-Test`:

- MAY appear in diagnostics;
- MUST NOT be advisory-lock key input.

The lock session MUST remain open for the complete covered operation. Loss of that session is fail-closed.

For the Dropbox backup, the protected period begins before selecting the R2 observation source generation and continues through publication of a complete verified Dropbox checkpoint for that same observations-root generation. The backup MAY retain the lock for the complete history-backup workflow when that is structurally simpler.

Existing connector-day, day-finalisation and global-index advisory locks may remain temporarily during transition, but they are not the target cross-run observation safety model. Observation-only uses should be retired after the global lock is operationally accepted on TEST. A fine-grained lock or coordination path that exists solely for the retired calculated-AQI R2 writer is legacy implementation and is governed by [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md), not part of the current observation-operation lock model.

## Shared canonical observation writer

Prune Daily and Integrity use different authoritative source-selection and acquisition paths, but canonical live R2 observation mutation MUST converge on one implementation.

The shared implementation owns the active canonical behaviour for:

- observation row normalisation;
- `verification_status` normalisation;
- observation-content hashing;
- Parquet serialisation and physical schema;
- pollutant manifests;
- connector manifests;
- observation exact/scoped index generation where applicable;
- connector-scoped read-back verification;
- shared canonical builders/validators used by observation finalisers.

A generic helper that merely accepts arbitrary caller-provided `write` and `verify` callbacks under a shared lock does not, by itself, satisfy this contract. Such a wrapper may coordinate execution, but it does not prevent Prune Daily and Integrity from retaining divergent canonical writers.

Callers may adapt their authoritative source into the shared canonical input contract. They MUST NOT independently implement competing Parquet, manifest, observation-hash or exact-index semantics.

Calculated AQI outside R2 may consume canonical observations under the active `aqi-levels` contracts. It is not an active R2 mutation/completion domain and MUST NOT be introduced into the shared canonical observation writer merely because it derives from observation data.

The shared writer MUST NOT set, clear or validate deletion authority in `uk_aq_ops.prune_connector_day_gates`. Gate ownership remains exclusively with Prune Daily.

## Exact affected-day finalisation

A run MUST retain the exact sorted set of UTC days affected by its successful observation writes or repairs.

For example:

```text
2025-07-27
2026-06-27
2026-07-21
2026-07-22
```

This sparse set MUST NOT be converted into one continuous range from the earliest day to the latest day.

While the run owns the global observations operation lock, the routine observation finalisation path MUST:

1. update connector and pollutant leaf/index state only for changed observation scopes;
2. finalise each exact affected day once from its complete committed connector set;
3. preserve connectors already present in each valid current day unless the active mode, such as SOS-light, deliberately replaces the complete day from a separately authorised pinned baseline;
4. rebuild affected month manifests once from current committed day manifests;
5. rebuild affected year manifests once from current committed month manifests;
6. rebuild the observations-root manifest once from current committed year manifests;
7. update observation exact/scoped/latest discovery metadata according to the active index-generation contract;
8. use deterministic byte-stable put-if-changed behaviour and required read-back/HEAD verification.

An API that accepts only `from_day_utc` and `to_day_utc` is insufficient for sparse Integrity profiles unless it also accepts and honours an exact affected-day filter. It MUST NOT enumerate or rewrite unrelated intervening days merely because they fall between the minimum and maximum affected dates.

A full continuous-range or whole-history index builder may remain as an explicit repair or maintenance command. It is not the routine shared finaliser.

The absence of per-day/global observation advisory locks does not remove parent dependency ordering. It means the one global operation owner performs or internally coordinates those deterministic finalisation stages without a competing Prune/Integrity run.

## Connector-day deletion-gate validation

A connector-day gate is deletion authority only when every required field is selected from the database and validated at deletion time.

The read used by Prune Daily's pre-repair and post-repair deletion filters MUST include at least:

```text
day_utc
connector_id
history_done
history_manifest_key
history_manifest_hash
history_row_count
history_file_count
history_total_bytes
history_completed_at
completion_source
source_content_hash
source_content_hash_contract_version
source_content_hash_row_count
```

A gate authorises deletion only when:

- `history_done=true`;
- `completion_source` is exactly `prune_daily_phase_b`;
- the manifest key is the canonical v2 observation connector-manifest key for the same `day_utc + connector_id`;
- the manifest hash is valid and matches the verified final connector manifest;
- completion time is valid;
- row, file and byte counts are present, non-negative and internally consistent with the verified manifest evidence;
- the versioned source identity is present, valid and supported;
- the gate source identity matches the candidate source identity;
- both persisted identities match a fresh current canonical IngestDB identity immediately before deletion;
- source revalidation and deletion occur within the same transaction and database session under [`prune_connector_source_identity.md`](prune_connector_source_identity.md).

A gate with missing completion source, `completion_source=history_integrity`, another legacy/adoption source, missing counts, malformed counts, missing source identity, unsupported source-identity version or current source mismatch MUST fail closed even when `history_done=true` and the key/hash/timestamp look plausible.

Historical Integrity-created gate rows and existing null-identity gate rows do not need to be bulk-deleted solely for this correction. They MUST simply be ineligible as deletion authority. Integrity, migration and the shared writer MUST NOT create or update them.

Focused deletion-gate checks MUST explicitly prove rejection of:

- `history_integrity` completion source;
- missing completion source;
- missing count fields;
- negative or malformed counts;
- missing or malformed source identity;
- unsupported source-identity contract version;
- candidate/gate source-identity mismatch;
- fresh current source mismatch caused by a value-only change;
- fresh current source mismatch caused by a `verification_status`-only change;
- a plausible historical manifest identity that was not completed by Prune Daily.

## Current source identity and deletion atomicity

The full authoritative connector-day source identity contract is [`prune_connector_source_identity.md`](prune_connector_source_identity.md).

Count and minimum/maximum timestamp aggregates MAY remain an initial change detector. They MUST NOT preserve completed candidate status or deletion authority without a complete matching versioned source identity.

The connector-day identity MUST use the shared canonical observation row encoder and cover:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

The identity is persisted on both:

```text
uk_aq_ops.history_candidates
uk_aq_ops.prune_connector_day_gates
```

Existing rows with null identity fail closed and are reprocessed when matching IngestDB observations remain. They are not backfilled from R2 or aggregate evidence.

Both deletion paths require:

```text
fresh current source identity
=
candidate source identity
=
gate source identity
```

That revalidation and deletion MUST occur in one PostgreSQL transaction and database session at `REPEATABLE READ` isolation or stronger. External R2, Dropbox or HTTP work MUST NOT occur inside that transaction.

The global observations operation advisory lock and this deletion transaction serve different purposes. The global lock excludes competing canonical observation operations; the deletion transaction proves the source rows being deleted still match the exact archived evidence.

## Aggregate day gate

`uk_aq_ops.prune_day_gates` is not connector-hour deletion authority.

If it remains in use as whole-day completion metadata, its manifest identity and aggregate row, file and byte totals MUST describe the final complete day manifest, including valid connectors retained from earlier history state or deliberately rebuilt by the current mode.

Totals calculated only from the current run's candidate rows are invalid when the final day manifest also contains pre-existing connectors.

The aggregate day gate may be audited and removed if it has no necessary consumer. Until then, it must remain internally consistent with the complete day manifest it references.

## AQI R2 retirement boundary

Calculated AQI / `aqilevels` is not an active R2 history product. The authoritative retirement rules are in [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md).

Normal Prune Daily Phase B and Integrity observation-history operation MUST NOT create, update, manifest, index, finalise, back up as current authority, or require completion of calculated AQI objects under legacy paths such as:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

There is no supported active v1-or-v2 AQI R2 writer branch. A legacy AQI helper, prefix or retained historical object may remain only for explicitly historical/recovery purposes where separately documented; it MUST NOT be reachable as normal Phase B or Integrity completion behaviour.

Calculated AQI display and station-history calculation remain active outside this R2 persistence boundary under the `aqi-levels` contracts.

## Integrity preflight call order

For every Integrity mode, the request-wide earliest-IngestDB-day check remains a hard semantic precondition.

The global observation operation lock must then be held before the run establishes that its Dropbox observation baseline is current with live R2.

For an explicitly scoped request, the preferred order is:

```text
argument/local config validation
-> request-wide IngestDB boundary check
-> acquire global observations operation lock
-> validate complete Dropbox backup/checkpoint
-> read current live R2 observations-root content_hash
-> require Dropbox checkpoint processed observations-root hash == live root hash
-> pin accepted baseline identities
-> source/comparison/proposal/apply/final verification
-> release lock
```

It is also structurally valid to acquire the global lock immediately before the boundary query when implementation shape makes that simpler, provided a boundary failure releases the lock promptly and no Dropbox/source/R2 comparison work occurs before the boundary passes.

### Automatic `daily` profile scope discovery

The `daily` profile cannot evaluate the boundary until it has constructed its exact requested date set under [`daily_profile_selection.md`](daily_profile_selection.md).

The following narrow local scope-discovery work is permitted before the boundary check and before lock acquisition:

1. list only the direct child names under the configured local Dropbox mirror path for `history/v2/observations`;
2. accept only names strictly matching `day_utc=YYYY-MM-DD`;
3. derive the latest represented day and represented historical months from those names only;
4. read only the local Integrity SQLite `daily_profile_state` rows needed to calculate missed logical-date catch-up;
5. construct and de-duplicate the exact selected UTC date set and its reasons;
6. derive the request start and end dates used by the boundary check.

This exception is scope construction only. Before the boundary and global-currentness gates pass, the daily profile MUST NOT:

- run general Dropbox readiness/freshness/content validation;
- open, parse, hash or validate Dropbox manifest/Parquet content for comparison;
- inspect source-cache data beyond configuration needed to locate later stages;
- enumerate or download authoritative source files;
- read live R2 observation content for comparison;
- create findings or proposals;
- apply a repair or migration.

After exact daily scope is known, the request-wide boundary check runs for the complete connector set. Then the run acquires the global observation operation lock and performs the current-backup/live-root equality gate.

If either gate fails, the run stops before normal source/comparison/repair stages.

## Dropbox currentness gate

The active backup contract records the fully processed observation source-root identity in the Dropbox hierarchical checkpoint state.

Integrity MUST accept its normal pinned observation baseline only when, while holding the global observation operation lock:

```text
selected Dropbox checkpoint is complete/current under the backup contract
AND
current live R2 observations-root manifest is structurally valid enough to establish content_hash
AND
Dropbox checkpoint fully processed observations-root content hash
    ==
current live R2 observations-root content_hash
```

The normal Dropbox history backup itself acquires the same global operation lock before choosing its R2 observation source generation and retains the lock through successful publication of the fully processed observation checkpoint for that generation.

Therefore, once Integrity owns the global operation lock and accepts the checkpoint/live-root equality, neither Prune Daily nor the normal backup can change its R2 or Dropbox observation baseline underneath the run.

A mismatch means Dropbox is stale relative to the committed live observation hierarchy. Integrity releases the global lock and stops.

A write-enabled Integrity run may make live R2 newer than Dropbox. An immediate backup is not required by this contract. A subsequent Integrity run remains blocked until a later complete locked backup catches up.

## Required focused structural checks

Before deployment, only the smallest directly relevant deterministic checks are required. They must prove:

- environment-label spelling does not change the database-local global observation lock identity;
- Prune Daily, Integrity and the normal Dropbox history backup contend on exactly that same lock;
- lock acquisition is bounded and retained-session loss fails closed;
- the real Prune Daily and Integrity mutation paths use the same canonical observation builders/validators, not merely the same lock wrapper;
- sparse affected days do not expand into intervening calendar days;
- deletion-gate reads require `completion_source=prune_daily_phase_b`, complete count evidence and complete source identity;
- current, candidate and gate source identities are compared in one deletion transaction;
- aggregate day totals are derived from the final complete connector set when the day gate is retained;
- the active Phase B and Integrity observation call graphs cannot write `history/v2/aqilevels/...` or AQI-specific R2 manifests/indexes;
- an explicitly scoped boundary failure exits before Dropbox/source/normal R2 comparison work;
- automatic daily scope discovery performs only permitted direct-name and `daily_profile_state` reads before the boundary;
- Dropbox currentness is evaluated only while the global operation lock is held;
- a Dropbox/live-root mismatch blocks normal Integrity work;
- the backup cannot publish a fully processed observations-root checkpoint for an observation generation it did not hold stable under the global lock.

Run syntax, import and SQL-structure checks needed to establish viability. Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment, validate through real TEST operation:

1. run a boundary-blocked explicitly scoped Integrity request and confirm no prohibited Dropbox/source/R2 work starts;
2. run a boundary-blocked automatic daily request and confirm only scope discovery occurs before the block;
3. demonstrate that Prune Daily, Integrity and the normal Dropbox history backup cannot overlap their covered observation operation;
4. confirm one completed locked backup produces a fully processed Dropbox observations-root checkpoint matching the stable R2 root it owned;
5. demonstrate that a stale Dropbox observations generation causes Integrity to stop after acquiring/releasing the global lock and before normal comparison/repair work;
6. confirm a current Dropbox generation allows the Integrity run to proceed while Prune Daily and backup remain excluded;
7. confirm only exact affected observation scopes/days/indexes are updated by the owning run;
8. confirm only a valid `prune_daily_phase_b` connector gate with matching current source identity authorises IngestDB deletion;
9. confirm a value-only or `verification_status`-only source change invalidates old prune evidence and retains observations;
10. confirm normal Prune Daily/Integrity observation work creates no new AQI/`aqilevels` R2 output and does not require AQI completion;
11. confirm retained aggregate day metadata matches the complete day manifest.