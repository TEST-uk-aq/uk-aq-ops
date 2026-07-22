# R2 history integrity

## Authority and scope

This document defines the required v2 Integrity detection, repair-planning and repair-execution contract. It supplements the stable binding-index contract and does not reintroduce retired cumulative timeseries metadata.

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the orchestrator for the UK-AQ history Integrity run.

Where active code differs from this document, this document is authoritative and the code must be brought into line before a real repair run.

## Supported pollutant scope

Active observation Integrity is limited to these four canonical pollutant codes:

- `pm25`
- `pm10`
- `no2`
- `o3`

This four-pollutant scope applies to observation detection, source comparison, repair planning, observation data repair, observation manifests and indexes, and final verification.

A connector is checked and repaired only for the pollutants in this list that it actually provides. A connector not providing one of the four pollutants is not itself an Integrity fault. For example, Sensor.Community may be repaired for `pm25,pm10` without being required to provide `no2` or `o3`.

Observation data for any other observed property that already exists in the Dropbox R2 mirror or live R2 is outside the active Integrity scope. Integrity must:

- ignore it during detection and source comparison;
- not create findings or repair actions for it;
- not require source completeness, mapping or canonical-row evidence for it;
- not allow it to block a repair of one or more of the four supported pollutants;
- not delete, rewrite or relocate it;
- preserve its existing canonical objects and existing parent-manifest child entries when rebuilding metadata for an affected connector-day.

Existing out-of-scope pollutant objects are treated as opaque preserved baseline content. Integrity does not validate their Parquet bodies, counts or indexes. When parent metadata must be rebuilt, existing out-of-scope child entries and their recorded aggregate values are carried forward from the chosen Dropbox baseline. If that preservation cannot be proven structurally, the repair must block rather than broaden its deletion scope.

Integrity must not create new out-of-scope pollutant data.

AQI eligibility remains separate from observation Integrity scope. AQI rebuilds remain limited to `pm25`, `pm10` and `no2`. An `o3` observation repair or metadata-only finding does not queue AQI work.

## Supported runtime model

Run history Integrity from a complete `uk-aq-ops` repository checkout. The checkout location is operator-specific and is not part of the system contract.

A complete checkout is the only supported runtime model because the orchestrator uses shared source-adapter, R2 writer, manifest and index code from elsewhere in the repository. Do not copy a partial `bin/` or `env/` directory and do not rely on an undocumented runtime bundle.

`--history-version v2` is the only accepted history version. `v1` and `both` remain rejected. `--check-only` and `--run-backfill` are mutually exclusive.

Source, connector, day-range, pollutant and other scope filters must have the same meaning in every mode. Changing mode must not silently broaden the requested scope.

A destructive observation repair must use an explicit pollutant subset through `--repair-pollutants`. Accepted values are limited to `pm25`, `pm10`, `no2` and `o3`. The selected set must pass unchanged through detection evidence, proposal generation, validation, tombstone planning, apply and final verification.

## Authoritative inputs

Integrity uses these inputs:

1. The relevant historical connector gateway or its existing local source cache for authoritative historical observations within the selected four-pollutant scope.
2. The Dropbox `R2_history_backup` mirror for the R2 v2 data, manifests and indexes being checked.
3. The committed v2 core snapshot in Dropbox for connector, station, timeseries and observed-property identity.
4. The local Integrity SQLite database for source snapshots, findings, repair planning and audit evidence.

Source acquisition must happen before comparison. When the required historical source file is already cached locally, Integrity reuses it. Otherwise the relevant source adapter fetches it. Source unavailability or an uncertain empty result must block the affected selected-pollutant repair scope.

Source files must still be enumerated and identity-pinned sufficiently to prove that all rows for the selected pollutants have been considered. Rows for other observed properties may be ignored after parsing and must not become selected-row blocking evidence.

### UK-AIR CSV source-label registry

The Integrity SQLite database owns the approval registry for UK-AIR annual CSV headings. A heading is `mapped`, `ignore` or `review`: only explicitly approved `mapped` labels may target `pm25`, `pm10`, `no2` or observation-only `o3`; `ignore` labels are known non-target fields; newly discovered labels are `review` and are skipped with an aggregated warning. Python discovers cached headings, updates the registry and writes an immutable per-run snapshot for the source-to-R2 worker. The worker never opens the Integrity SQLite database.

Review and ignored labels do not block selected-pollutant repair. Approved mapped labels remain fail-closed for inactive or ambiguous mappings, missing timeseries, invalid rows and incompatible units. Operators use `scripts/uk-aq-history-integrity/bin/manage_uk_air_source_labels.py` to list reviews and set an approved `ignore` or `mapped` decision. Ozone registry mapping does not add ozone to AQI rebuilds.

Integrity detection and repair planning do not use live R2 as a comparison source.

## Current flow

1. Load the v2-only Integrity environment and the configured source/backfill environment.
2. Check Dropbox backup readiness unless `--allow-stale-dropbox` is supplied.
3. Import the current `R2_history_backup/history/v2/core` snapshot.
4. Read or fetch the relevant historical connector data through the configured source adapters and caches.
5. Read the scoped R2 v2 mirror from Dropbox.
6. Compare source/cache truth with the Dropbox Parquet, manifests, indexes and stable bindings for the four supported pollutants.
7. Build a deterministic repair plan after all detection has completed.
8. Stop after reporting when running `--check-only`.
9. With `--run-backfill --dry-run`, calculate the exact local repair proposals without writing R2.
10. With a real `--run-backfill`, build and validate corrected objects locally, apply the repair to R2 in the required order, and GET-verify every written object.
11. For a real repair, run one final read-only verification and write the SQLite, JSON, Markdown and task-health evidence.

Equivalent source/cache input, selected pollutant scope and chosen Dropbox baseline must produce the same findings, repair plan and canonical replacement content.

## Run mode contracts

### `--check-only`

`--check-only` is the normal scheduled detection mode. It answers: **what is wrong within the four-pollutant scope, and what repair would be required?**

It must:

1. Apply the backup readiness gate unless `--allow-stale-dropbox` is supplied.
2. Import the Dropbox core snapshot and scoped R2 v2 mirror.
3. Read or fetch the relevant authoritative connector source/cache before comparison.
4. Check all relevant parts of the seven logical v2 areas for `pm25`, `pm10`, `no2` and `o3` within the requested source, connector and day scope.
5. Record source snapshots, findings and audit evidence in the local Integrity SQLite database.
6. Build the deterministic, deduplicated repair plan.
7. Write JSON, Markdown and task-health reports.

It must not:

- invoke an R2 repair writer, deletion path or metadata executor;
- build replacement Parquet or other local repair output merely for later upload;
- create a repair overlay that represents uploaded or verified objects;
- HEAD, GET, list, PUT or DELETE anything in live R2;
- change the Dropbox backup;
- report out-of-scope observed properties as Integrity faults;
- perform post-write verification, because nothing was written.

A completed check-only run must distinguish at least:

- no actionable four-pollutant Integrity fault found;
- actionable Integrity fault found and represented in the repair plan;
- blocked because the Dropbox readiness gate failed;
- incomplete or unreliable checking because a selected-pollutant source, cache, reader or mapping was unavailable.

An actionable finding is a failed Integrity result even though detection itself completed successfully.

### `--run-backfill --dry-run`

`--run-backfill --dry-run` answers: **given the detected faults and explicit repair pollutant set, what exact repair actions and object changes would be attempted?**

It performs the same acquisition, Dropbox comparison, findings and repair planning as check-only. It may additionally run local-only builders and proposal logic needed to calculate exact canonical replacement files, manifests, deletions, indexes and dependencies.

It may write only disposable local files, Integrity SQLite evidence and run reports. It must not:

- read live R2;
- write or delete live R2;
- change Dropbox;
- claim that any proposed object was uploaded or GET-verified.

Its report must keep planned deletions, writes and verifications separate from completed operations.

### Real `--run-backfill`

A real `--run-backfill` performs the same acquisition, comparison and repair planning, then applies the repair execution contract in this document.

It must not mutate R2 until every local replacement object and preserved-baseline dependency required for the first affected selected-pollutant mutation scope has been structurally validated. It must record actual deletions, writes, post-write verification and final verification separately from the original findings and plan.

## Temporary repair overlay

The repair overlay is a run-specific local working directory. It combines objects created or changed by the current run with unchanged objects from the chosen Dropbox baseline while later repair stages are planned and built.

`--check-only` must not create a repair overlay. `--run-backfill --dry-run` and real `--run-backfill` may create one only after detection and repair planning have completed.

The overlay must:

- be sparse, containing only objects created, changed or marked for deletion by the current run;
- use the same relative object keys as the canonical R2 v2 paths;
- contain only local working files and local run-state evidence;
- never contain `generation=<transaction>` paths or permanent transaction receipts;
- never be copied into Dropbox or treated as an authoritative backup.

Later local stages resolve an object in this order:

1. a structurally validated replacement object in the current run overlay;
2. a current-run exact pollutant-prefix tombstone, which means the canonical object is absent from the proposed final state;
3. otherwise the matching object from the chosen Dropbox baseline.

A tombstone is only a local marker during planning and building. It prevents an old Dropbox object scheduled for deletion from reappearing in the combined local view. It does not prove that the corresponding live R2 object has been deleted.

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

Integrity checks seven logical areas within the four-pollutant scope. These are not necessarily seven broad scans:

1. Core snapshot.
2. Observation data and manifests.
3. Observation timeseries indexes, including the latest index.
4. AQI hourly data and manifests for AQI-eligible pollutants.
5. AQI debug data and manifests for AQI-eligible pollutants.
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

The v2 checks start from actual day, connector, supported-pollutant and Parquet paths in the scoped Dropbox mirror. They validate target parent-manifest content against valid target child manifests instead of trusting a single parent representation.

DuckDB reads the actual Dropbox Parquet for the supported pollutants and calculates whole-partition and per-timeseries row counts. The report keeps these comparisons separate:

1. source/cache counts versus actual Dropbox Parquet counts;
2. actual Parquet counts versus pollutant manifest counts;
3. supported-pollutant manifests versus connector and day hierarchy representations;
4. committed supported-pollutant entries versus pollutant and latest indexes;
5. stable binding objects versus imported core identities.

Existing out-of-scope pollutant partitions, manifest entries and indexes are ignored as findings. Extra out-of-scope children in a connector or day manifest are permitted and must be carried through unchanged when that parent is rebuilt. Their presence must not alter the target-pollutant counts used for comparison.

An unavailable reader, unreadable selected-pollutant Parquet, unavailable selected-pollutant source/cache or ambiguous selected-pollutant source mapping is reported explicitly and fails closed for the affected scope.

Findings distinguish data, pollutant-manifest, connector-manifest, day-manifest, index, source-mapping and source-unavailable faults. Both source-only and Dropbox-only per-timeseries differences remain visible for the supported pollutants.

## Repair planning

Each v2 run includes a deterministic, deduplicated `repair_plan` array. The plan records whether each supported-pollutant scope needs data replacement, metadata repair, index repair, AQI rebuild or operator action.

A readable valid selected-pollutant Parquet partition with a missing or invalid manifest is a metadata-only fault. Metadata-only repair must not rewrite valid Parquet. O3 findings do not queue AQI.

An observation data fault is repaired from the authoritative connector source/cache. The destructive repair unit is one connector-day plus an explicit subset of `pm25`, `pm10`, `no2` and `o3`.

A pollutant-scoped repair must:

- enumerate and identity-pin the source files required to prove every selected-pollutant row;
- compare detector and proposal evidence exactly for the selected pollutant set;
- build and validate complete replacement content for each selected pollutant partition;
- delete only the exact selected pollutant prefixes;
- preserve every unselected supported pollutant and every existing out-of-scope pollutant object;
- rebuild parent metadata and indexes from selected replacements plus preserved baseline children.

It must never tombstone or delete the complete observation connector-day prefix.

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

## Repair execution contract

Before any R2 mutation, Integrity must build all corrected files for the selected repair scope locally and validate that they are structurally complete.

For an observation data repair:

1. Read or fetch and identity-pin all source files required for the selected connector-day pollutants.
2. Build canonical source evidence containing only the selected pollutants.
3. Fail on any missing, malformed, unmapped, ambiguous, duplicate or otherwise blocked selected-pollutant row.
4. Ignore non-selected source rows for repair blocking, while retaining enough file identity evidence to prove the selected rows came from the expected source files.
5. Build the complete corrected Parquet and pollutant manifests for every selected pollutant locally.
6. Validate selected source-to-Parquet row identity, counts, pollutant set, object keys, hashes and detector/proposal equality.
7. Resolve preserved unselected children from the chosen Dropbox baseline and prove that reconstructed connector and day metadata retain them.
8. Create tombstones only for exact selected prefixes of the form `history/v2/observations/day_utc=<day>/connector_id=<connector>/pollutant_code=<pollutant>`.
9. During real apply, delete and verify absence of only those exact selected prefixes.
10. Upload and GET-verify the selected canonical pollutant Parquet files.
11. Upload and GET-verify the selected pollutant manifests.
12. Rebuild and GET-verify the connector and day manifests from selected replacements plus preserved baseline children.
13. Rebuild and GET-verify the affected supported-pollutant indexes, then the global latest index without dropping preserved out-of-scope entries.
14. Run the required AQI repair stages only for changed `pm25`, `pm10` or `no2` observations.

For a metadata-only repair, preserve the Dropbox Parquet and rebuild only the required supported-pollutant manifests or indexes from the chosen Dropbox baseline and any corrected local overlay objects.

When a day-manifest repair encounters a non-canonical observation connector manifest, Integrity may include a connector-manifest correction in the same proposal set only when all of the following are true:

- the existing connector manifest has the exact expected v2 observations domain, manifest kind, object key, day and numeric connector identity;
- every discovered pollutant child manifest is independently valid under the current canonical contract;
- every declared child manifest and every existing baseline Parquet object under that connector-day is represented by the validated child set;
- the replacement connector manifest is rebuilt exclusively from those validated child manifests, rather than trusting the legacy connector aggregates, child summaries or stored hash;
- an apparently empty connector is accepted only when its existing zero-row, zero-file and empty-files evidence is internally explicit.

The connector correction must be reported as its own proposal, including the failed canonical validation rules. A wrong domain, kind, key, day or connector identity, an unavailable child set, or any invalid pollutant child remains a blocked dependency. The canonical connector proposal must be staged before the day manifest is rebuilt from the final child hierarchy.

The apply order is always selected child data first, then selected child manifests, parent manifests, scoped indexes and global latest indexes last.

## R2 access rules

Integrity detection and repair planning must not HEAD, GET or list live R2.

Check-only and dry-run must not access live R2 at all.

A data repair does not read existing live R2 before writing because the authoritative replacement and preserved-child plan are built from source/cache and the chosen Dropbox baseline.

Live R2 reads during real apply are limited to post-mutation verification:

- confirm required selected-prefix deletions;
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

A manual rerun may use `--allow-stale-dropbox` to reuse the same chosen Dropbox baseline without waiting for another Dropbox backup. The rerun may overwrite selected canonical files already written correctly by the interrupted attempt. That is expected and safe because the selected corrected scope is rebuilt deterministically from the same authoritative source/cache.

The successful rerun must complete all writes, post-write GET verification, parent metadata, indexes and final verification. A failed or interrupted run remains failed in the audit trail.

## Empty and unavailable source results

A gateway failure, missing cache file, parse failure or uncertain empty response must never be interpreted as authoritative no-data for a selected pollutant.

Integrity may replace a selected connector-day pollutant partition with no observation rows only when the relevant source adapter explicitly classifies that selected-pollutant result as authoritative no-data under its documented source contract. Otherwise it must make no R2 changes for that selected scope.

## Audit evidence

Every mode records its mode, requested source, connector, day and pollutant scope, chosen Dropbox baseline, whether `--allow-stale-dropbox` was used, source acquisition result, findings, repair plan and final mode result.

For a real repair, SQLite, task logs and JSON/Markdown reports must additionally record at least:

- environment, source, day, connector and selected pollutant set;
- selected-pollutant source and replacement row counts;
- preserved baseline pollutant children;
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
