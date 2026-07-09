# Populate Live Core DB From Test

This note describes the prerequisites for loading live `uk_aq_core` metadata from the test/source dataset before restoring R2 history.

## Purpose

Use this only for initial live bootstrap, where the live core metadata must match the source/test IDs used in the restored history files.

The critical IDs are:

- `connectors.id`
- `stations.id`
- `timeseries.id`

Other core IDs referenced by those rows must also be preserved.

## Required Preconditions

### 1. Target Schema Must Already Exist

The live database must already have the expected `uk_aq_core` schema and tables in place.

The main identity-backed tables involved in history alignment are:

- `connectors`
- `stations`
- `timeseries`

These are defined in:

- `schemas/ingest_db/uk_aq_core_schema.sql`

## 2. Target Data Should Be Empty Or Disposable

This is not a safe merge into an already populated live core dataset.

If live already contains independently created rows, internal IDs can diverge from the source/test dataset, and restored history will no longer line up correctly.

## 3. Explicit IDs Must Be Preserved

The import must preserve source/test IDs exactly.

That includes at least:

- `connectors.id`
- `stations.id`
- `timeseries.id`

It also includes the related identity-backed rows those records reference, such as:

- `categories.id`
- `observed_properties.id`
- `phenomena.id`
- `offerings.id`
- `features.id`
- `procedures.id`
- `networks.id`

## 4. Import The Full Core Table Set

The import should cover the same core snapshot table set used by the R2 core snapshot script:

- `connectors`
- `categories`
- `observed_properties`
- `phenomena`
- `offerings`
- `features`
- `procedures`
- `networks`
- `sos_networks`
- `sos_network_pollutants`
- `stations`
- `station_metadata`
- `timeseries`

This is the same table set exported by:

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`

## 5. Respect FK Dependencies

The import order must respect the foreign-key relationships in `uk_aq_core`.

In practice, that means loading parent/reference tables before dependent tables, and loading `station_metadata` and `timeseries` only after the referenced base rows exist.

## 6. Reset Identity Sequences After Import

Because the import uses explicit IDs, the live identity sequences must be reset afterward to `max(id)`.

If this is skipped, future inserts can collide with imported IDs.

There is already an example pattern for this in:

- `seeds/uk_aq_connectors_seed.sql`

## 7. Keep Polling / Writes Quiet During Bootstrap

Do not let the live environment start normal ingest or metadata mutation before the bootstrap is complete.

At minimum, avoid any live process that could:

- insert new core rows
- mutate connector/runtime state mid-import
- create conflicting IDs before sequence reset

Operational fields in `connectors` such as `poll_enabled`, `scheduler_backend`, `last_polled_at`, and `last_run_*` should be reviewed as part of the import.

## 8. Use A Role With Direct SQL Write Access

This is a direct SQL/bootstrap operation.

The import role must be able to:

- insert explicit IDs into `uk_aq_core`
- update dependent rows
- reset identity sequences afterward

## Recommended High-Level Order

1. Deploy the expected live schema.
2. Confirm the target `uk_aq_core` dataset is empty or safe to replace.
3. Import the source/test `uk_aq_core` table set with explicit IDs preserved.
4. Reset identity sequences.
5. Verify key row counts and a few known IDs.
6. Generate live `history/v1/core`.
7. Restore history domains into live R2.
8. Rebuild live `history/_index`.

## Validation Checklist

After the DB import and before R2 restore:

- Confirm known connector IDs match source/test.
- Confirm known station IDs match source/test.
- Confirm known timeseries IDs match source/test.
- Confirm FK-dependent tables such as `station_metadata` and `timeseries` loaded cleanly.
- Confirm identity sequences have been advanced to at least `max(id)`.

## Short Version

The live core DB import is ready only when:

- schema is deployed
- target core data is empty or replaceable
- explicit IDs are preserved
- sequences are reset afterward
- normal live ingest is still effectively paused

If any of those conditions are missing, do not restore history into live R2 yet.
