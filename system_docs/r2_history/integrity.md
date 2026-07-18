# R2 history integrity

## Authority and scope

This document defines the required v2 Integrity detection, repair-planning and repair-execution contract. It supplements the stable binding-index contract and does not reintroduce retired cumulative timeseries metadata.

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the orchestrator for the UK-AQ history Integrity run.

Where active code differs from this document, this document is authoritative and the code must be brought into line before a real repair run.

## Supported runtime model

Run history Integrity from a complete `uk-aq-ops` repository checkout. The checkout location is operator-specific and is not part of the system contract.

A complete checkout is the only supported runtime model because the orchestrator uses shared source-adapter, R2 writer, manifest and index code from elsewhere in the repository. Do not copy a partial `bin/` or `env/` directory and do not rely on an undocumented runtime bundle.

`--history-version v2` is the only accepted history version. `v1` and `both` remain rejected. `--check-only` and `--run-backfill` are mutually exclusive.

## Authoritative inputs

Integrity uses these inputs:

1. The relevant historical connector gateway or its existing local source cache for authoritative historical observations.
2. The Dropbox `R2_history_backup` mirror for the R2 v2 data, manifests and indexes being checked.
3. The committed v2 core snapshot in Dropbox for connector, station, timeseries and observed-property identity.
4. The local Integrity SQLite database for source snapshots, findings, repair planning and audit evidence.

Source acquisition must happen before comparison. When the required historical source file is already cached locally, Integrity reuses it. Otherwise the relevant source adapter fetches it. Source unavailability or an uncertain empty result must block the affected repair scope.

Integrity detection and repair planning do not use live R2 as a comparison source.

## Current flow

1. Load the v2-only Integrity environment and the configured source/backfill environment.
2. Check Dropbox backup readiness unless `--allow-stale-dropbox` is supplied.
3. Import the current `R2_history_backup/history/v2/core` snapshot.
4. Read or fetch the relevant historical connector data through the configured source adapters and caches.
5. Read the scoped R2 v2 mirror from Dropbox.
6. Compare source/cache truth with the Dropbox Parquet, manifests, indexes and stable bindings.
7. Build a deterministic repair plan after all detection has completed.
8. With `--run-backfill --dry-run`, report the plan without writing R2.
9. With a real `--run-backfill`, build and validate corrected objects locally, apply the repair to R2 in the required order, and GET-verify every written object.
10. Run one final read-only verification and write the SQLite, JSON, Markdown and task-health evidence.

## Seven logical v2 areas

Integrity checks seven logical areas. These are not necessarily seven broad scans:

1. Core snapshot.
2. Observation data and manifests.
3. Observation timeseries indexes, including the latest index.
4. AQI hourly data and manifests.
5. AQI debug data and manifests.
6. AQI timeseries indexes, including the latest index.
7. Stable timeseries bindings.

Stable bindings live under `history/_index_v2/timeseries_binding`. They are checked independently against the imported core snapshot and are not rewritten by an observation data repair. The dedicated core-snapshot binding reconciliation path owns binding repair.

## Backup gate and stale-backup override

Repair runs call the Integrity-specific Obs AQI DB RPC `uk_aq_public.uk_aq_rpc_history_integrity_readiness(timestamptz)` before scanning the Dropbox history base.

For a normal repair run:

- the latest successful non-dry-run `ops.r2_history_dropbox_backup` must have started after the latest finished relevant R2 writer attempts;
- unfinished relevant writers or an unfinished Dropbox backup block the run;
- the qualifying backup must have finished before the current Integrity run started;
- a failed readiness check exits with `status=blocked_backup_not_ready`.

`--allow-stale-dropbox` has one meaning only: it bypasses the Dropbox readiness gate and uses the available Dropbox mirror as the chosen repair baseline.

The override does not change fault classification, does not force a data rebuild, and does not disable metadata-only repair. It must be recorded clearly in SQLite, JSON and Markdown reports.

The operator is responsible for using the override only when the selected Dropbox state is appropriate. A common supported use is rerunning an interrupted Integrity repair from the same Dropbox baseline without waiting for another backup.

The RPC's canonical SQL definition is owned by `TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_history_integrity_readiness.sql`. No ops SQL mirror is maintained.

## Detection and hierarchy validation

The v2 checks start from actual day, connector, pollutant and Parquet paths in the scoped Dropbox mirror. They validate parent manifest content against valid child manifests instead of trusting a single parent representation.

DuckDB reads the actual Dropbox Parquet and calculates whole-partition and per-timeseries row counts. The report keeps these comparisons separate:

1. source/cache counts versus actual Dropbox Parquet counts;
2. actual Parquet counts versus pollutant manifest counts;
3. pollutant manifests versus connector and day hierarchy representations;
4. committed manifests versus pollutant and latest indexes;
5. stable binding objects versus imported core identities.

An unavailable reader, unreadable Parquet, unavailable source/cache or ambiguous source mapping is reported explicitly and fails closed for the affected scope.

Findings distinguish data, pollutant-manifest, connector-manifest, day-manifest, index, source-mapping and source-unavailable faults. Both source-only and Dropbox-only per-timeseries differences remain visible in the report.

## Repair planning

Each v2 run includes a deterministic, deduplicated `repair_plan` array. The plan records whether each scope needs data replacement, metadata repair, index repair, AQI rebuild or operator action.

A readable valid Parquet partition with a missing or invalid manifest is a metadata-only fault. Metadata-only repair must not rewrite valid Parquet. Manifest-only O3 findings do not queue AQI.

An observation data fault is repaired from the authoritative connector source/cache. The repair scope is the complete observation connector-day, not a selected fragment of one Parquet file. This keeps replacement and interruption recovery deterministic.

Relevant repair kinds include:

- `observation_data_repair`
- `observation_pollutant_manifest_repair`
- `observation_connector_manifest_repair`
- `observation_day_manifest_repair`
- `observation_index_repair`
- `aqi_rebuild`
- `aqi_pollutant_manifest_repair`
- `aqi_connector_manifest_repair`
- `aqi_day_manifest_repair`
- `aqi_index_repair`

## Simplified repair execution contract

Before any R2 mutation, Integrity must build all corrected files for the affected repair scope locally and validate that they are structurally complete.

For an observation data repair:

1. Read or fetch the complete authoritative connector-day from the relevant source/cache.
2. Build the complete corrected connector-day observation Parquet locally.
3. Build all required pollutant and connector manifests locally.
4. Validate local row counts, pollutant partitions, object keys, manifest aggregates and hashes.
5. Delete the existing canonical observation connector-day prefix only after the local replacement has passed validation.
6. Verify that stale surplus canonical files under that connector-day prefix have been removed.
7. Upload the canonical pollutant Parquet files.
8. GET each uploaded Parquet object and confirm exact bytes or SHA-256 against the local file.
9. Upload and GET-verify pollutant manifests, then the connector manifest.
10. Rebuild and GET-verify the day manifest using the corrected connector and the unaffected connector children from the chosen Dropbox baseline.
11. Rebuild and GET-verify the affected pollutant indexes, then the global latest index.
12. Run the required AQI repair stages for AQI-eligible changed observation data.

For a metadata-only repair, preserve the Dropbox Parquet and rebuild only the required manifests or indexes from the chosen Dropbox baseline and any corrected local overlay objects.

The apply order is always child data first, then child manifests, parent manifests, scoped indexes, and global latest indexes last.

## R2 access rules

Integrity detection and repair planning must not HEAD, GET or list live R2.

A data repair does not read the existing live R2 connector-day before writing because the authoritative replacement is built from source/cache and the chosen Dropbox baseline.

Live R2 reads during apply are limited to post-mutation verification:

- confirm required deletions;
- GET every written Parquet, manifest and index object;
- verify exact bytes or SHA-256 and canonical structure.

The final read-only verification may read the exact affected live R2 keys needed to prove the completed repair. It must not use broad live R2 discovery as an alternative repair baseline.

## No generation or receipt contract

Active Integrity repair must use the canonical R2 v2 paths directly.

It must not:

- create `generation=<transaction>` Parquet directories;
- create permanent R2 transaction receipts under `transactions/`;
- preserve old canonical Parquet on R2 for rollback;
- inventory special transaction receipts for Dropbox backup;
- attempt to resume an interrupted internal transaction from a receipt;
- select between multiple historical repair generations.

Repair audit information belongs in Integrity SQLite, task logs and JSON/Markdown run reports.

## Interrupted repair recovery

An interrupted repair is rerun from the beginning. Integrity does not resume individual internal write stages.

A manual rerun may use `--allow-stale-dropbox` to reuse the same chosen Dropbox baseline without waiting for another Dropbox backup. The rerun may overwrite canonical files that were already written correctly by the interrupted attempt. That is expected and safe because the complete corrected scope is rebuilt deterministically from the same authoritative source/cache.

The successful rerun must complete all writes, post-write GET verification, parent metadata, indexes and final verification. A failed or interrupted run remains failed in the audit trail.

## Empty and unavailable source results

A gateway failure, missing cache file, parse failure or uncertain empty response must never be interpreted as authoritative no-data.

Integrity may replace a connector-day with no observation rows only when the relevant source adapter explicitly classifies the result as authoritative no-data under its documented source contract. Otherwise it must make no R2 changes for that scope.

## Audit evidence

SQLite, task logs and JSON/Markdown reports must record at least:

- environment, source, day and connector;
- whether `--allow-stale-dropbox` was used;
- pre-repair findings and repair-plan actions;
- local source and replacement row counts;
- object keys deleted and written;
- post-write GET verification results;
- manifests and indexes rebuilt;
- AQI work queued or completed;
- final verification status;
- stopped, failed and blocked scopes.

The main reported v2 status after a real repair reflects the final verification result. A failed final verification or stopped run is a failed task, not a completed task.

## Validation model

Before implementation, only confirm that the proposed code paths, configuration and data contracts are structurally viable.

After deployment to CIC-Test, functional validation is performed through one real scoped Integrity operation, followed by its post-write verification and a later normal check against the next successful Dropbox backup. Do not add broad speculative pre-implementation test suites.

## Related authoritative documents

- [`README.md`](README.md)
- [`contract.md`](contract.md)
- [`operations.md`](operations.md)
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md)
- [`timeseries_binding_contract.md`](timeseries_binding_contract.md)
