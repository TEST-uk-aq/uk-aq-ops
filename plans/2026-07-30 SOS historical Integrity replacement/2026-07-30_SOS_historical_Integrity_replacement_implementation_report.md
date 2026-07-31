# SOS historical Integrity replacement implementation report

## 31 July 2026 cross-month run-scoped acquisition correction

### Confirmed root cause and correction

The dedicated SOS coordinator already issued one acquisition request for the complete selected range, but `scripts/uk_aq_backfill_local.sh` unconditionally divided every request into calendar-month windows. The first worker invocation created and completed the immutable run-owned acquisition root; a second invocation for the next month then correctly failed with `sos_source_acquisition_root_already_exists`. The worker root guard, exclusive partition writes and completed-manifest hash behaviour were correct and remain unchanged.

The local wrapper now recognizes `UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE=acquire` and supplies exactly one execution window containing the complete requested `from` and `to` dates. Every non-acquisition mode continues to use the existing calendar-month generator. A calendar-year boundary requires no special case because acquisition mode bypasses the generator for the whole range.

The durable dedicated-run audit and Markdown summary now explicitly record the complete range and pollutant set, acquisition invocation and root-creation counts, acquisition run/root/manifest identity and status, selected day/pollutant/partition counts, source years, and calendar-month/year boundary flags. These values are derived only after the existing completed acquisition manifest has passed its scope, identity, file, partition and completion-hash validation; the hashed manifest schema was not redesigned.

### Focused regression evidence

The focused `2026-06-30` through `2026-07-02`, `no2,pm25` regression establishes:

- acquisition mode invokes the worker once with the complete three-day range;
- the acquisition owner creates one completed manifest containing all three selected days and six day/pollutant partition datasets;
- the one relevant annual source CSV is opened once;
- a second acquisition against that root is rejected by the unchanged existing-root guard before reopening the source;
- acquisition-only wrapper execution uses a no-write runner and reports `objects_written_r2=0`;
- the same ordinary non-acquisition range still invokes two windows: `2026-06-30..2026-06-30` and `2026-07-01..2026-07-02`.

### Files changed for this correction

- `scripts/uk_aq_backfill_local.sh`
  - bypasses monthly window splitting only for dedicated SOS acquisition mode.
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
  - adds the contract-required run audit fields and summary output after validated acquisition completion.
- `tests/uk_aq_backfill_local_acquisition_windows.test.mjs`
  - covers the acquisition and ordinary wrapper window contracts without external writes.
- `workers/uk_aq_backfill_local/run_job_v2_writer_test.ts`
  - extends the existing acquisition regression across the June/July boundary and verifies one manifest, six partitions, one source open and the retained root guard.
- `scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py`
  - verifies the new successful-acquisition audit fields through the existing dedicated replacement path.
- this implementation report.

Repository-required pre-edit snapshots were added under `archive/2026-07-31/` for the two changed active implementation files. No active `system_docs/` file, schema, worker acquisition implementation, cloud resource or operational configuration changed.

### Focused validation

- Wrapper Bash syntax: passed.
- Integrity coordinator Python compilation: passed.
- Cross-month wrapper acquisition/ordinary-window regression: passed.
- Cross-month acquisition worker regression: passed (`1` test; `17` filtered out).
- Existing dedicated replacement coordinator regression with audit assertions: passed (`1` test).
- `git diff --check`: passed.

An optional whole-file `deno fmt --check` was not used as a gate because the existing worker test file contains broad pre-existing formatting differences. The new block was aligned locally; no unrelated bulk reformat was applied.

## 31 July 2026 current-state reconciliation correction

### Confirmed root cause

The successful 1–16 June four-pollutant run exposed two coordinator-side defects after ordered R2 verification:

1. `_current_state_candidates_from_verified_evidence()` grouped scope only by `day_utc + connector_id`, queried `source_connector_day_evidence ORDER BY id DESC`, and consumed only the first row. Dedicated SOS persists one immutable evidence row for each pollutant operation, so the last persisted pollutant won for every connector-day. PM2.5 ran last, which explains the exact 147 Timeseries candidates.
2. The same function compacted raw Timeseries rows by timeseries but appended every distinct supported historical row to the Latest Snapshot payload. The retained PM2.5 evidence contained 55,761 canonical rows, so all 55,761 were submitted in 112 owner-service calls rather than one candidate per timeseries.

All successful dedicated entries already retained their pollutant-scoped evidence path, row path, identity and SHA-256 in `partition_source_evidence` and `source_evidence_partitions`; candidate derivation ignored that available evidence. The final ordered-apply result establishes the verified R2 state for the complete dedicated scope, so no broad R2 rescan is needed.

No Integrity-side Timeseries state gate was present: the coordinator already submitted Timeseries candidates directly to `uk_aq_rpc_timeseries_current_state_reconcile`. That RPC owns newer, older, equal and same-timestamp correction decisions atomically. Latest Snapshot submission also already ran after the Timeseries attempt regardless of its result. The Latest Snapshot owner service re-applies `evaluateLatestCurrentValue()` and `applyIntegrityCandidatesToLatestState()`, which own public eligibility, monotonic ordering, identical no-op and same-timestamp correction behaviour.

### Corrected candidate assembly

For the dedicated SOS path, `run_current_state_reconciliation()` now receives every selected partition result after successful ordered R2 verification. It:

- includes only `status=ok` partitions with immutable pollutant-scoped evidence whose identity, paths, retained hashes, canonical-row hash, byte count, row count, day, connector and pollutant scope all validate;
- excludes all-unmapped unchanged partitions and failed or unverified partitions;
- accepts authoritative no-data as verified zero-row evidence;
- unions the retained canonical rows across every successful selected day and pollutant;
- derives one latest raw candidate per Timeseries identity across PM2.5, PM10, NO2 and O3;
- uses the existing Latest Snapshot `evaluateLatestCurrentValue()` helper to exclude ineligible values, then derives one latest eligible candidate per supported PM2.5, PM10 and NO2 Timeseries;
- selects an earlier eligible Latest Snapshot row when a newer raw row is negative or otherwise ineligible;
- fails closed if verified evidence contains irreconcilable content for the same timeseries and timestamp;
- submits both compacted candidate sets independently to their existing owners without reading or gating on `timeseries.last_value_at`.

The Timeseries payload retains raw finite negative values. O3 remains excluded from Latest Snapshot. Source acquisition, the run-scoped source cache, R2 replacement, tombstones, Parquet/manifests/indexes, ordered apply and GET-once verification are unchanged.

### Reconciliation audit

The durable current-state result and Markdown report now record:

- verified partition evidence count and identities;
- verified partitions, canonical rows and represented timeseries by pollutant;
- authoritative no-data, all-unmapped and failed/unverified partition counts;
- raw/supported rows examined and candidate counts before and after compaction;
- Timeseries and Latest Snapshot candidates by pollutant;
- ineligible Latest Snapshot rows by reason;
- latest-raw-ineligible fallbacks to an earlier eligible candidate;
- equal-timestamp/duplicate resolutions;
- planned payload chunk counts, actual submitted counts and owner outcome counts.

For unchanged authoritative evidence and mappings from the known successful run, acceptance is:

```text
Timeseries candidates: 531
Latest Snapshot candidates: 436
```

Expected pollutant coverage is Timeseries `no2=154, o3=95, pm10=135, pm25=147` and Latest Snapshot `no2=154, pm10=135, pm25=147`, with no O3 Latest Snapshot candidate.

### Files changed for this correction

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
  - loads all verified dedicated pollutant-scoped evidence;
  - compacts Timeseries and Latest Snapshot independently;
  - retains independent owner submission and adds reconciliation audit metrics.
- `scripts/uk-aq-history-integrity/bin/integrity/current_state/latest_snapshot_policy.mjs`
  - provides the Python coordinator with one local batch invocation of the existing owner-service eligibility helper; it adds no second policy implementation.
- `scripts/uk-aq-history-integrity/tests/test_current_state_reconciliation.py`
  - adds focused two-day, four-pollutant evidence, compaction, ineligible-fallback, verified-only and independent-target regressions.
- this implementation report.

No owner-service implementation, schema, RPC, operator configuration or external dependency changed. No additional full-file archive copy was created.

### Focused validation

- Python compilation for the touched Integrity implementation and focused test: passed.
- JavaScript syntax for the local eligibility-policy bridge: passed.
- Focused current-state reconciliation tests: 4 passed.
- Existing dedicated SOS evidence-selection tests: passed.
- Existing Timeseries owner-submission regression: passed.
- Existing Latest Snapshot eligibility and same-timestamp correction regressions: passed.
- `git diff --check`: passed.

### CIC-Test acceptance command and metrics

Run the existing four-pollutant command on the dedicated Integrity machine:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source sos --from-day 2026-06-01 --to-day 2026-06-16 --history-version v2 --run-backfill --repair-pollutants pm25,pm10,no2,o3 --allow-stale-dropbox
```

Inspect the `Current-state reconciliation` report section and durable JSON. Confirm:

- `verified_partition_evidence_count=64`, with 16 verified partitions for each pollutant unless a partition is legitimately authoritative no-data;
- canonical row and represented-timeseries counts cover all four pollutants;
- `Timeseries candidates=531` and `candidate_count_after_compaction=531`;
- `Latest Snapshot candidates=436` and `candidate_count_after_compaction=436`;
- Timeseries includes all four pollutants while Latest Snapshot has no O3;
- submitted counts equal compacted counts and payload chunks are compact rather than a full historical replay;
- Timeseries owner outcomes do not suppress Latest Snapshot submission;
- the existing SOS source-acquisition audit still reports one open per annual CSV;
- ordered apply still reports one post-PUT verification GET and no broad final R2 scan.

## 31 July 2026 source-acquisition optimisation

The dedicated SOS route now performs one run-scoped annual-CSV acquisition before any selected partition is built. The acquisition owner receives the complete inclusive date range, connector `1` and the complete explicit pollutant set. It opens every relevant annual CSV once, parses its CSV/timestamp structure once, derives the selected partition rows and warning evidence from that immutable structure, and completes a run-local spool before detector or proposal work can continue.

### Confirmed previous scan pattern

`build_dedicated_sos_selected_partitions()` creates one work item per explicit `day_utc + connector_id=1 + pollutant_code`. Before this optimisation, `run_v2_gap_backfills()` launched two complete-connector-day source workers for every work item:

1. the detector worker enumerated, opened, parsed and canonicalised all annual SOS files relevant to that partition;
2. the proposal worker independently repeated the same enumeration, file reads, parsing and canonicalisation.

The 1–16 June four-pollutant scope therefore created 64 partition operations and 128 full source-worker scans. A source file relevant to every selected partition could be opened up to 128 times in that run. The detector's canonical rows, source identities, classifications, counts and warnings were safe to reuse; none depends on mutable proposal or apply state. Mutable state begins with proposal staging, tombstone recording and later apply bookkeeping.

### New cache owner, format and lifecycle

The acquisition owner is `buildDedicatedSosSourceAcquisition()` in `workers/uk_aq_backfill_local/run_job.ts`, invoked once by the dedicated branch of `run_v2_gap_backfills()`. Its run-owned layout is:

```text
<run-root>/sos-source-cache/
  acquisition-manifest.json
  partitions/
    day_utc=<day>/
      connector_id=1/
        pollutant_code=<pollutant>/
          source-partition.json
```

The manifest is written first with `acquisition_status=building`. Partition files are then created exclusively and hashed. Only after every requested partition exists does the owner replace the manifest with `acquisition_status=complete` and a deterministic completion SHA-256. The cache is never reused across Integrity runs. A pre-existing cache root, incomplete manifest, run/scope mismatch, partition-path mismatch or hash mismatch fails closed.

The manifest records the Integrity run ID, selected dates, connector and pollutants; source paths, sizes, modification times and SHA-256 identities; unique file count, files opened, maximum opens per file, bytes read and source rows scanned; selected-range rows; warning count and bounded samples; partition paths, hashes and row counts; and avoided detector/proposal rescans.

Each partition file contains only that exact day/connector/pollutant's canonical source rows plus its file-scoped counts, classifications, units, missing-binding warnings and pinned source identity. It can therefore represent all three non-failure outcomes independently:

- non-empty canonical replacement evidence;
- authoritative empty evidence when no selected source observation exists;
- non-empty source evidence with zero canonical rows and positive missing-binding counts for the existing all-unmapped skip.

Detector and proposal workers run in `consume` mode and read only the completed, hash-validated partition dataset. They do not stat, open or parse annual CSV files. The existing detector persists and retains its pollutant-scoped `source-evidence.json` and `obs_history_rows.json`; the proposal worker independently rebuilds and validates the selected replacement from the same immutable partition input. Final Python agreement checks and the final JavaScript pollutant-scoped evidence validator remain unchanged.

### Files changed for this optimisation

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
  - invokes one range-scoped acquisition before the partition loop;
  - validates the completion manifest and every partition hash/path;
  - supplies acquisition identity to detector and proposal consumers;
  - adds dedicated acquisition audit fields and report output.
- `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
  - preserves the run-scoped acquisition mode, root and run ID across the existing repository `.env` load.
- `workers/uk_aq_backfill_local/run_job.ts`
  - separates one annual-CSV structural parse from partition canonicalisation;
  - builds the immutable run-scoped acquisition spool;
  - consumes cached partition results without reopening annual CSV files.
- `workers/uk_aq_backfill_local/run_job_v2_writer_test.ts`
  - adds the deterministic 2-day × 2-pollutant single-read regression, including authoritative no-data and all-unmapped evidence.
- `scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py`
  - retains direct-selection/multi-pollutant regressions and proves detector and proposal calls use acquisition `consume` mode.
- this implementation report.

No JavaScript apply module, shared manifest/index writer, Timeseries reconciliation, Latest Snapshot reconciliation, generic Integrity, check-only/dry-run path or Prune Daily code changed. No new external dependency, service, schema, environment configuration or operator argument was added. As requested, no additional archived full-file copy was created.

### Focused validation

- Python compilation for the touched Integrity implementation and focused test: passed.
- Shell syntax for the touched repository backfill wrapper: passed.
- Deno type checking for the touched source worker and focused test: passed.
- New 2-day × 2-pollutant acquisition regression: passed; four independent partition files were produced, one annual CSV was opened once, distinct paths and hashes were retained, authoritative empty and all-unmapped evidence were represented, and four detector plus four proposal rescans were reported avoided.
- Existing dedicated SOS Python regressions: 6 passed, including direct selection, exact tombstone behaviour, distinct pollutant evidence, all-unmapped preservation, legacy diagnostics and AQI/broad-scan bypass.
- Existing final JavaScript proposal validator regression for distinct pollutant-scoped evidence: passed.
- `git diff --check`: passed.

The direct replacement unit remains `day + connector + pollutant`. Exact tombstones, complete replacement, ordered live apply, GET-once verification and downstream Timeseries/Latest Snapshot boundaries are unchanged.

## Outcome

Qualifying real CIC-Test SOS v2 repairs now select the dedicated observation-history replacement path automatically. Check-only, dry-run, non-SOS and generic repair paths retain their existing routing.

The dedicated path is selected only for `--source sos --run-backfill --history-version v2` with explicit `--from-day`, `--to-day`, `--repair-pollutants`, and a resolved mutation scope of connector `1`. A qualifying SOS scope that resolves outside connector `1` fails before source acquisition begins.

The dedicated path now derives every executable replacement partition directly from the inclusive selected dates, connector `1`, and the explicit repair-pollutant set. It does not use observation gaps, mismatch classifications, Dropbox comparison results, or observation content-hash comparisons to decide whether a selected partition is rebuilt. A selected partition therefore reaches the existing complete source-evidence and replacement owners even when the Dropbox baseline already matches the authoritative source.

For this route, observation gap detection and source-versus-Dropbox content-hash comparison are recorded as bypassed. The run records `target_authority=explicit_selected_scope`, the selected partition count, dates, pollutants, per-partition outcomes, complete and authoritative-no-data replacement counts, all-unmapped skips, source-invalid blocks, and exact tombstone count. Success depends on every explicit partition outcome and the ordered apply verification, not on a zero gap count.

The suspected same-day multi-pollutant source-evidence collision was confirmed in commit `f5b5ed4`. Each pollutant worker wrote and later removed the same connector-day `source-evidence.json` and `obs_history_rows.json` paths, while the final JavaScript proposal validator also resolved evidence only by day and connector. The last pollutant therefore replaced the earlier files, and final proposal validation would compare earlier pollutant objects with the last pollutant's evidence. That mismatch failed closed before the apply executor could issue an R2 DELETE or PUT.

Dedicated SOS evidence is now retained immutably under:

```text
<overlay>/source-evidence/day_utc=<day>/connector_id=1/pollutant_code=<pollutant>/
  source-evidence.json
  obs_history_rows.json
```

Run state records each `day_utc + connector_id + pollutant_code` identity with its exact evidence and rows paths and SHA-256 values. The final proposal and live semantic validators require that exact mapping and verify the retained hashes before comparing the pollutant's staged or live content. A later pollutant can still reuse the worker's temporary connector-day directory, but it cannot remove or mutate an earlier pollutant's retained evidence.

## Files changed

The source-evidence collision correction changes the Python Integrity implementation and focused test, the JavaScript apply validator and focused safety test, the shared observation-content-hash helper's explicit empty-evidence function, and this report. The shared index module remains unchanged from the original implementation.

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
  - strict route selection and run-summary audit;
  - direct explicit selected-partition target ownership for the dedicated route;
  - dedicated observation gap and Dropbox content-hash comparison bypass;
  - immutable pollutant-scoped evidence retention and run-state identity records;
  - all-unmapped partition preservation;
  - legacy R2-only identity diagnostic handling;
  - AQI detection/proposal bypass;
  - ordered-apply evidence accepted without a second broad final scan;
  - existing Timeseries and Latest Snapshot reconciliation retained.
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`
  - exact pollutant-scoped source-evidence resolution and retained-hash checks;
  - dedicated authoritative no-data evidence validation without weakening generic empty-partition rejection;
  - connector-1 observation-only proposal guard;
  - verified-body cache capacity preflight;
  - exact post-PUT GET bookkeeping;
  - observation-only apply domains and delegated live latest-index finalisation.
- `workers/shared/uk_aq_r2_history_index.mjs`
  - narrow `writePollutantIndexes` option so the global finaliser can merge and verify the live observations latest index without rewriting already verified scoped indexes.
- `scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py`
  - focused route, single-pollutant matching-baseline, same-day two-pollutant evidence retention, all-unmapped, legacy-ID and AQI-bypass checks.
- `scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs`
  - focused two-pollutant evidence-to-proposal validation, authoritative no-data, exact-tombstone, connector-scope and GET-once checks.
- `workers/shared/uk_aq_observation_content_hash.mjs`
  - an explicit empty-partition metadata owner used only by proven authoritative no-data handling; normal content-hash calls still reject empty partitions.

Required pre-change archive snapshots from the original implementation remain under `archive/2026-07-30/`. As explicitly requested for this correction, no additional full-file archive copy was created. No file under `system_docs/` was changed.

## Existing modules reused

- SOS annual-file discovery, cache, timestamp parsing, source-label registry, identity pinning and immutable source evidence.
- Shared canonical observation row, Parquet, manifest and observation-content-hash owners.
- Existing exact pollutant-prefix tombstones and final proposal graph validation.
- Canonical connector-day, day-finalisation and global-index advisory locks.
- Existing observation metadata/index builder and canonical apply executor.
- Existing private Timeseries reconciliation RPC and authenticated Latest Snapshot owner-service route.

No second writer, dispatcher, transaction system, schema migration or new environment variable was added.

## Selection and bypass point

`select_sos_historical_replacement_route()` runs at the repository entrypoint. It first recognises the qualifying public arguments, then confirms the imported core resolves SOS mutation scope to connector `1` only. The selected execution path is recorded as:

```text
dedicated_sos_historical_observation_replacement
```

In this mode the coordinator does not call AQI integrity detection, AQI queueing, AQI generation, AQI metadata/index planning or AQI debug work. It also does not call the generic broad final-verification scan. Existing AQI objects remain untouched.

`build_dedicated_sos_selected_partitions()` owns the dedicated executable target set. It expands the inclusive selected day scope across connector `1` and every explicit repair pollutant, then feeds each selected partition independently into the existing immutable source-evidence, canonical proposal and exact-tombstone owners. `run_v2_gap_backfills()` retains its original gap-derived branch for every non-dedicated caller; only the dedicated branch accepts the explicit target list.

Immediately after each dedicated detector result is validated and persisted, `_retain_dedicated_sos_partition_source_evidence()` copies its evidence and canonical rows once into the pollutant-scoped immutable layout and records the identity in `source_evidence_partitions`. Generic Integrity continues to use the existing connector-day worker paths and evidence loading semantics.

The dedicated entrypoint does not call `run_v2_observations_integrity_checks()` or `run_v2_observation_content_hash_checks()` as repair prerequisites. Their dedicated report entries are bypass records. Check-only, dry-run, non-SOS and generic Integrity execution still use the existing comparison and gap-derived logic unchanged.

## Replacement and legacy identity behaviour

The existing complete selected-pollutant proposal owner remains responsible for immutable source rows, complete canonical Parquet, pollutant manifests, exact tombstones and parent/index proposals.

- Fresh groups without an authoritative active binding remain warning-only and are excluded consistently.
- If every non-empty source group in a selected partition is excluded for that reason, the partition is audited as `all_groups_excluded_no_authoritative_binding` and left unchanged.
- Legacy R2-only timeseries IDs are retained as bounded diagnostics but do not change otherwise complete current SOS source evidence to `mapping_unavailable`.
- Ambiguous, contradictory or invalid fresh source mappings still fail closed before mutation.

## Ordered live apply and GET-once enforcement

Before mutation, the final proposal graph still proves immutable SOS source evidence equals staged Parquet semantics and the staged pollutant manifest. The dedicated apply guard rejects AQI objects, non-connector-1 mutations, non-observation tombstones and a connector-day Parquet set that cannot fit the bounded verified-body cache.

Each changed object records one `post_put_verification_get_attempt_count` and one successful `post_put_verification_get_count`. A second apply attempt for that object is rejected. The returned Parquet body is retained only in the bounded connector-day cache, used for the pollutant-manifest semantic check, then discarded. Dedicated semantic verification refuses a fallback second GET.

Scoped observation indexes are published once from the validated proposal. Under the global lock, the shared targeted index owner rereads current live metadata, leaves those scoped indexes untouched, and conditionally publishes only the merged observations latest index. A changed latest index is PUT and GET-verified once by that shared owner. Required pre-PUT reads of current day/latest parents for concurrency-safe merging are distinct from the single post-PUT verification GET.

The ordered apply audit becomes the final R2 history evidence. `second_broad_r2_scan_invoked` is recorded as `false`. Timeseries and Latest Snapshot reconciliation run only after the canonical apply has completed its child-to-parent verification sequence.

## Structural checks run

- Python compilation for the touched Integrity implementation and focused test file: passed.
- JavaScript syntax checks for the apply module, shared index module and focused test: passed.
- Public Python entrypoint import and `--help`: passed; supported arguments are unchanged.
- Repository dispatcher and runner shell syntax: passed.
- Repository runner `--help`: passed and still identifies the established local dispatcher path.
- Focused Python dedicated SOS checks: 6 passed, including the retained single-pollutant matching-baseline case and a same-day `no2,pm25` case with two evidence identities, tombstones and replacement object sets.
- Focused canonical apply safety checks: 15 passed, including successful final proposal validation of two same-day pollutants against their own evidence and authoritative no-data evidence.
- Existing focused observation metadata repair check: 1 passed.
- `git diff --check`: passed.

The deployed `/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh` is intentionally absent on this development laptop, so its real selector-to-checkout resolution remains a CIC-Test Integrity-machine acceptance check. No replacement local executable was created.

## CIC-Test functional acceptance commands

Run these on the dedicated Integrity machine through the existing local dispatcher after the repository changes are available there.

Known 1 June 2026 NO2 scope:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source sos --from-day 2026-06-01 --to-day 2026-06-01 --history-version v2 --run-backfill --repair-pollutants no2 --allow-stale-dropbox
```

Same-scope rerun, without requiring an intervening Dropbox backup:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source sos --from-day 2026-06-01 --to-day 2026-06-01 --history-version v2 --run-backfill --repair-pollutants no2 --allow-stale-dropbox
```

Intended 1-16 June range for the full supported SOS observation subset:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source sos --from-day 2026-06-01 --to-day 2026-06-16 --history-version v2 --run-backfill --repair-pollutants pm25,pm10,no2,o3 --allow-stale-dropbox
```

For each run, confirm the report selects the dedicated path, names connector `1`, records no AQI invocation, reports exact selected-prefix tombstones, shows one post-PUT verification GET per changed object, records no broad final scan, and separates R2 history, Timeseries, Latest Snapshot and overall outcomes.

Also inspect the new `SOS source acquisition` audit section. It must report `single_run_scoped_sos_annual_csv_pass`, `source_files_opened == unique_source_file_count`, `maximum opens per source file == 1`, a complete cache SHA-256, the expected date × pollutant partition count and row-count map, and detector/proposal rescans avoided equal to the explicit selected partition count.

Both the single-pollutant command and the multi-pollutant range command are now structurally supported: every selected pollutant retains a separate immutable evidence identity through final proposal validation, ordered apply and live verification.

## Deployment and operator handover

- No operator command change is required.
- No new configuration, database migration or cloud resource is required.
- Make this repository revision available to the CIC-Test Integrity checkout selected by its existing local selector.
- Run the three functional acceptance commands in order.
- Take a fresh Dropbox history backup after meaningful repair work as the normal recovery copy.
- Do not deploy or run this path against LIVE as part of this change.
