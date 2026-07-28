# R2 history implementation safety contract

## Authority and scope

This document is an authoritative amendment to:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`integrity.md`](integrity.md).

It records implementation requirements that must be explicit before Prune Daily or Integrity performs another real R2 mutation or IngestDB deletion.

Where older wording conflicts with this document, this document is authoritative for:

- advisory-lock environment identity;
- what qualifies as the shared canonical connector-day writer;
- exact affected-day index finalisation;
- deletion-time connector-gate validation;
- current connector-day source identity, as detailed by [`prune_connector_source_identity.md`](prune_connector_source_identity.md);
- aggregate day-gate totals;
- active Phase B AQI history version;
- Integrity boundary-preflight call order.

## Advisory-lock identity

TEST and LIVE isolation is provided by their separate Supabase projects and PostgreSQL advisory-lock managers.

All writers connected to the same Supabase project MUST derive the same advisory-lock identity for the same logical R2 resource, regardless of environment-label spelling.

Environment labels such as `TEST`, `LIVE` and `CIC-Test`:

- MAY appear in diagnostics;
- MUST NOT be advisory-lock key input.

The canonical fixed application namespace and logical resource identity are defined in [`lock_environment_boundary.md`](lock_environment_boundary.md).

Any older requirement that different environment labels must produce different advisory-lock identities is superseded.

## Shared canonical connector-day writer

Prune Daily and Integrity use different authoritative source-selection and acquisition paths, but canonical live R2 mutation MUST converge on one implementation.

The shared implementation owns the active canonical behaviour for:

- observation row normalisation;
- `verification_status` normalisation;
- observation-content hashing;
- Parquet serialisation and physical schema;
- pollutant manifests;
- connector manifests;
- observation-derived AQI calculation helpers when AQI is required;
- AQI data and debug connector outputs;
- connector-targeted observation and AQI indexes;
- connector-scoped read-back verification;
- connector-day advisory-lock acquisition and release.

A generic helper that merely accepts arbitrary caller-provided `write` and `verify` callbacks under a shared lock does not, by itself, satisfy this contract. Such a wrapper may coordinate execution, but it does not prevent Prune Daily and Integrity from retaining divergent canonical writers.

Callers may adapt their authoritative source into the shared canonical input contract. They MUST NOT independently implement competing Parquet, manifest, AQI, hash or connector-index semantics.

The implementation may expose separate observation and AQI stages so that Prune Daily can complete its verified observation deletion gate before AQI. Those stages must still use the same shared canonical builders and validators used by Integrity or migration where applicable.

The shared writer MUST NOT set, clear or validate deletion authority in `uk_aq_ops.prune_connector_day_gates`. Gate ownership remains exclusively with Prune Daily.

## Exact affected-day finalisation

A run MUST retain the exact sorted set of UTC days affected by its successful connector-day writes or repairs.

For example:

```text
2025-07-27
2026-06-27
2026-07-21
2026-07-22
```

This sparse set MUST NOT be converted into one continuous range from the earliest day to the latest day.

The routine finalisation path MUST:

1. update connector and pollutant leaf indexes only for changed connector-days;
2. finalise each exact affected day once under its day-finalisation lock;
3. preserve connectors already present in each current day manifest;
4. update global/latest discovery indexes once under the global index-finalisation lock;
5. merge the exact affected day summaries into current aggregate metadata;
6. use byte-stable put-if-changed behaviour and read-back verification.

An API that accepts only `from_day_utc` and `to_day_utc` is insufficient for sparse Integrity profiles unless it also accepts and honours an exact affected-day filter. It MUST NOT enumerate or rewrite unrelated intervening days merely because they fall between the minimum and maximum affected dates.

A full continuous-range or whole-history index builder may remain as an explicit repair or maintenance command. It is not the routine shared finaliser.

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

## Aggregate day gate

`uk_aq_ops.prune_day_gates` is not connector-hour deletion authority.

If it remains in use as whole-day completion metadata, its manifest identity and aggregate row, file and byte totals MUST describe the final merged day manifest, including valid connectors preserved from earlier Integrity, migration or Prune Daily runs.

Totals calculated only from the current run's candidate rows are invalid when the final day manifest also contains pre-existing connectors.

The aggregate day gate may be audited and removed if it has no necessary consumer. Until then, it must remain internally consistent with the complete merged day manifest it references.

## Active Phase B AQI version

The only supported active Prune Daily AQI output is canonical R2 v2:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

Active Phase B code and configuration MUST NOT retain an executable v1 AQI writer branch, v1 AQI output prefix, legacy AQI RPC exporter or fallback selector.

A broader history-version helper may retain v1 support for an explicitly documented non-Phase-B legacy reader or migration tool, but the active Phase B AQI path MUST require `UK_AQ_R2_HISTORY_VERSION=v2` and fail closed otherwise.

## Integrity boundary-preflight call order

For every Integrity mode, the request-wide earliest-IngestDB-day check is a hard precondition before backup validation, source work, comparison or R2 work.

### Explicitly scoped requests

For a request whose date scope is supplied directly by arguments or another already-resolved input, the boundary check MUST complete after argument and local configuration validation sufficient to connect to the operational database and before:

- Dropbox readiness or mirror inspection;
- source-cache inspection or source acquisition;
- source-file enumeration or download;
- R2 reads;
- comparison;
- proposal creation;
- canonical apply;
- any live R2 mutation.

### Automatic `daily` profile scope discovery

The `daily` profile cannot evaluate the boundary until it has constructed its exact requested date set under [`daily_profile_selection.md`](daily_profile_selection.md).

The following narrow local scope-discovery work is therefore permitted before the boundary check:

1. list only the direct child names under the configured local Dropbox mirror path for `history/v2/observations`;
2. accept only names strictly matching `day_utc=YYYY-MM-DD`;
3. derive the latest represented day and represented historical months from those names only;
4. read only the local Integrity SQLite `daily_profile_state` rows needed to calculate missed logical-date catch-up;
5. construct and de-duplicate the exact selected UTC date set and its reasons;
6. derive the request start and end dates used by the boundary check.

This exception is scope construction only. Before the boundary passes, the daily profile MUST NOT:

- run general Dropbox readiness, freshness, inventory or placeholder checks;
- open, parse, hash or validate any Dropbox manifest, Parquet or other history object;
- inspect connector or pollutant child directories;
- inspect source-cache files beyond configuration needed to locate later stages;
- enumerate or download authoritative source files;
- read live R2;
- compare source with the Dropbox mirror;
- create findings or proposals;
- apply a repair or migration.

Directory metadata beyond what the operating system needs to enumerate the direct child names is not date-selection evidence. The selected scope and reasons may be held in memory until the boundary passes. The run MUST NOT mark daily-profile catch-up state complete or caught up during pre-boundary scope discovery.

After the exact daily scope is known, the request-wide boundary check MUST run for the complete requested connector set. Only after it succeeds may normal Dropbox readiness and all later Integrity stages begin.

If automatic daily scope discovery cannot determine a valid exact selection, the run fails before the boundary rather than inventing a range.

### Boundary failure

If any requested connector overlaps its boundary, the complete request exits with all blockers and none of the prohibited later adapters is called.

The boundary is queried once for the complete requested connector set. A second routine pre-write query is not required under the continuous-boundary invariant.

## Required focused structural checks

Before deployment, only the smallest directly relevant deterministic checks are required. They must prove:

- environment-label spelling does not change a database-local lock identity;
- shared resource namespaces remain distinct;
- the real Prune Daily and Integrity mutation paths use the same canonical builders and validators, not merely the same lock wrapper;
- sparse affected days do not expand into intervening calendar days;
- deletion-gate reads require `completion_source=prune_daily_phase_b`, complete count evidence and complete source identity;
- current, candidate and gate source identities are compared in one deletion transaction;
- aggregate day totals are derived from the final merged connector set when the day gate is retained;
- the active Phase B AQI path cannot execute a v1 writer branch;
- an explicitly scoped boundary failure exits before any Dropbox, source or R2 adapter is called;
- automatic daily scope discovery performs only permitted direct-name and `daily_profile_state` reads before the boundary;
- after daily scope construction, a boundary failure prevents Dropbox readiness, content inspection, source and R2 stages.

Run syntax, import and SQL-structure checks needed to establish viability. Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment, validate through real TEST operation:

1. run a boundary-blocked explicitly scoped Integrity request and confirm no Dropbox, source or R2 work starts;
2. run a boundary-blocked automatic daily request and confirm only scope discovery occurs before the block;
3. run Prune Daily and Integrity concurrently on non-conflicting connector-days;
4. confirm a same-connector-day conflict fails closed through the shared lock;
5. confirm an existing connector is preserved when another connector is added to the same day;
6. confirm only exact affected days and connector/pollutant indexes are updated;
7. confirm only a valid `prune_daily_phase_b` connector gate with matching current source identity authorises IngestDB deletion;
8. confirm a value-only or `verification_status`-only source change invalidates old evidence and retains observations;
9. confirm AQI failure remains separate from verified observation pruning;
10. confirm retained aggregate day metadata matches the complete merged day manifest.
