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
```

A gate authorises deletion only when:

- `history_done=true`;
- `completion_source` is exactly `prune_daily_phase_b`;
- the manifest key is the canonical v2 observation connector-manifest key for the same `day_utc + connector_id`;
- the manifest hash is valid and matches the verified final connector manifest;
- completion time is valid;
- row, file and byte counts are present, non-negative and internally consistent with the verified manifest evidence;
- the gate still represents the current frozen Prune Daily source identity for that connector-day.

A gate with missing completion source, `completion_source=history_integrity`, another legacy/adoption source, missing counts or malformed counts MUST fail closed even when `history_done=true` and the key/hash/timestamp look plausible.

Historical Integrity-created gate rows do not need to be bulk-deleted solely for this correction. They MUST simply be ineligible as deletion authority. Integrity, migration and the shared writer MUST NOT create or update them.

Focused deletion-gate checks MUST explicitly prove rejection of:

- `history_integrity` completion source;
- missing completion source;
- missing count fields;
- negative or malformed counts;
- a plausible historical manifest identity that was not completed by Prune Daily.

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

For every Integrity mode, the request-wide earliest-IngestDB-day check is a hard precondition.

After argument and local configuration validation sufficient to connect to the operational database, the boundary check MUST complete before:

- Dropbox readiness or mirror inspection;
- source-cache inspection or source acquisition;
- source-file enumeration or download;
- R2 reads;
- comparison;
- proposal creation;
- canonical apply;
- any live R2 mutation.

If any requested connector overlaps its boundary, the complete request exits with all blockers and none of those later adapters is called.

The boundary is queried once for the complete requested connector set. A second routine pre-write query is not required under the continuous-boundary invariant.

## Required focused structural checks

Before deployment, only the smallest directly relevant deterministic checks are required. They must prove:

- environment-label spelling does not change a database-local lock identity;
- shared resource namespaces remain distinct;
- the real Prune Daily and Integrity mutation paths use the same canonical builders and validators, not merely the same lock wrapper;
- sparse affected days do not expand into intervening calendar days;
- deletion-gate reads require `completion_source=prune_daily_phase_b` and complete count evidence;
- aggregate day totals are derived from the final merged connector set when the day gate is retained;
- the active Phase B AQI path cannot execute a v1 writer branch;
- a blocked Integrity boundary exits before Dropbox, source or R2 adapters are called.

Run syntax, import and SQL-structure checks needed to establish viability. Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment, validate through real TEST operation:

1. run a boundary-blocked Integrity request and confirm no Dropbox, source or R2 work starts;
2. run Prune Daily and Integrity concurrently on non-conflicting connector-days;
3. confirm a same-connector-day conflict fails closed through the shared lock;
4. confirm an existing connector is preserved when another connector is added to the same day;
5. confirm only exact affected days and connector/pollutant indexes are updated;
6. confirm only a valid `prune_daily_phase_b` connector gate authorises IngestDB deletion;
7. confirm AQI failure remains separate from verified observation pruning;
8. confirm retained aggregate day metadata matches the complete merged day manifest.
