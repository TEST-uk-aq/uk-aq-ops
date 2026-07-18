# R2 history integrity

## Authority and scope

This document defines the required v2 Integrity detection, repair-planning and repair-execution contract. It supplements the stable binding-index contract and does not reintroduce retired cumulative timeseries metadata.

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the orchestrator for the UK-AQ history Integrity run.

Where active code differs from this document, this document is authoritative and the code must be brought into line before a real repair run.

## Supported runtime model

Run history Integrity from a complete `uk-aq-ops` repository checkout. The checkout location is operator-specific and is not part of the system contract.

A complete checkout is the only supported runtime model because the orchestrator uses shared source-adapter, R2 writer, manifest and index code from elsewhere in the repository. Do not copy a partial `bin/` or `env/` directory and do not rely on an undocumented runtime bundle.

`--history-version v2` is the only accepted history version. `v1` and `both` remain rejected. `--check-only` and `--run-backfill` are mutually exclusive.

Source, connector, day-range and other scope filters must have the same meaning in every mode. Changing mode must not silently broaden the requested scope.

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
8. Stop after reporting when running `--check-only`.
9. With `--run-backfill --dry-run`, calculate the exact local repair proposals without writing R2.
10. With a real `--run-backfill`, build and validate corrected objects locally, apply the repair to R2 in the required order, and GET-verify every written object.
11. For a real repair, run one final read-only verification and write the SQLite, JSON, Markdown and task-health evidence.

Equivalent source/cache input and the same chosen Dropbox baseline must produce the same findings, repair plan and canonical replacement content.

## Run mode contracts

### `--check-only`

`--check-only` is the normal scheduled detection mode. It answers: **what is wrong, and what repair would be required?**

It must:

1. Apply the backup readiness gate unless `--allow-stale-dropbox` is supplied.
2. Import the Dropbox core snapshot and scoped R2 v2 mirror.
3. Read or fetch the relevant authoritative connector source/cache before comparison.
4. Check all relevant parts of the seven logical v2 areas within the requested scope.
5. Record source snapshots, findings and audit evidence in the local Integrity SQLite database.
6. Build the deterministic, deduplicated repair plan.
7. Write JSON, Markdown and task-health reports.

It must not:

- invoke an R2 repair writer, deletion path or metadata executor;
- build replacement Parquet or other local repair output merely for later upload;
- create a repair overlay that represents uploaded or verified objects;
- HEAD, GET, list, PUT or DELETE anything in live R2;
- change the Dropbox backup;
- perform post-write verification, because nothing was written.

A completed check-only run must distinguish at least:

- no actionable integrity fault found;
- actionable integrity fault found and represented in the repair plan;
- blocked because the Dropbox readiness gate failed;
- incomplete or unreliable checking because a source, cache, reader or mapping was unavailable.

An actionable finding is a failed Integrity result even though detection itself completed successfully.

### `--run-backfill --dry-run`

`--run-backfill --dry-run` answers: **given the detected faults, what exact repair actions and object changes would be attempted?**

It performs the same acquisition, Dropbox comparison, findings and repair planning as check-only. It may additionally run local-only builders and proposal logic needed to calculate exact canonical replacement files, manifests, deletions, indexes and dependencies.

It may write only disposable local files, Integrity SQLite evidence and run reports. It must not:

- read live R2;
- write or delete live R2;
- change Dropbox;
- claim that any proposed object was uploaded or GET-verified.

Its report must keep planned deletions, writes and verifications separate from completed operations.

### Real `--run-backfill`

A real `--run-backfill` performs the same acquisition, comparison and repair planning, then applies the simplified repair execution contract in this document.

It must not mutate R2 until all local replacement objects required for the first affected mutation scope have been built and structurally validated. It must record actual deletions, writes, post-write verification and final verification separately from the original findings and plan.

## Temporary repair overlay

The repair overlay is a run-specific local working directory. It exists only to combine objects created or changed by the current run with unchanged objects from the chosen Dropbox baseline while later repair stages are planned and built.

`--check-only` must not create a repair overlay. `--run-backfill --dry-run` and real `--run-backfill` may create one only after detection and repair planning have completed.

The overlay must:

- be sparse, containing only objects created, changed or marked for deletion by the current run;
- use the same relative object keys as the canonical R2 v2 paths;
- contain only local working files and local run-state evidence;
- never contain `generation=<transaction>` paths or permanent transaction receipts;
- never be copied into Dropbox or treated as an authoritative backup.

Later local stages resolve an object in this order:

1. a structurally validated replacement object in the current run overlay;
2. a current-run tombstone, which means the canonical object is absent from the proposed final state;
3. otherwise the matching object from the chosen Dropbox baseline.

A tombstone is only a local marker during planning and building. It prevents an old Dropbox object that is scheduled for deletion from reappearing in the combined local view. It does not prove that the corresponding live R2 object has been deleted.

Only structurally validated overlay objects may be used as input to later manifest, parent-manifest, AQI or index stages. A merely proposed, partially built or failed object must not become authoritative within the current run.

Local run state must keep these states distinct where applicable:

- proposed write or deletion;
- locally built;
- structurally validated;
- uploaded;
- GET-verified;
- deleted and deletion-verified;
- failed or blocked.

An uploaded object is not treated as successfully repaired until its post-write GET verification has succeeded. A planned deletion is not treated as complete until absence has been verified during the real apply.

Dry-run may record proposed, locally built and structurally validated objects and tombstones. It must never mark anything as uploaded, deleted, GET-verified or deletion-verified.

The overlay is not a resume mechanism. An interrupted or failed repair is rerun from the beginning with a new overlay. A retained failed-run overlay may be inspected for diagnosis, but must not be used as input to a later repair.

After a successful repair, completed final verification and completed reports, the overlay may be deleted. Durable audit evidence remains in Integrity SQLite, task logs and JSON/Markdown reports.

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

Every normal Integrity mode that inspects the Dropbox history base, including check-only, dry-run and real repair, calls the Integrity-specific Obs AQI DB RPC `uk_aq_public.uk_aq_rpc_history_integrity_readiness(timestamptz)` first.

For a normal run:

- the latest successful non-dry-run `ops.r2_history_dropbox_backup` must have started after the latest finished relevant R2 writer attempts;
- unfinished relevant writers or an unfinished Dropbox backup block the run;
- the qualifying backup must have finished before the current Integrity run started;
- a failed readiness check exits with `status=blocked_backup_not_ready`.

`--allow-stale-dropbox` has one meaning only: it bypasses the Dropbox readiness gate and uses the available Dropbox mirror as the chosen comparison and repair baseline.

The override does not change fault classification, does not force a data rebuild, does not disable metadata-only repair and does not permit live R2 to become an alternative comparison baseline. It must be recorded clearly in SQLite, JSON and Markdown reports.

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

Check-only and dry-run must not access live R2 at all.

A data repair does not read the existing live R2 connector-day before writing because the authoritative replacement is built from source/cache and the chosen Dropbox baseline.

Live R2 reads during real apply are limited to post-mutation verification:

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

Every mode records its mode, requested scope, chosen Dropbox baseline, whether `--allow-stale-dropbox` was used, source acquisition result, findings, repair plan and final mode result.

For a real repair, SQLite, task logs and JSON/Markdown reports must additionally record at least:

- environment, source, day and connector;
- local source and replacement row counts;
- object keys deleted and written;
- post-write GET verification results;
- manifests and indexes rebuilt;
- AQI work queued or completed;
- final verification status;
- stopped, failed and blocked scopes.

Check-only and dry-run reports must not populate actual-write or actual-delete fields with planned operations. Planned and completed evidence must remain distinct.

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