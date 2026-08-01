# SOS historical Integrity replacement implementation report

## 1 August 2026 proposal dependency provenance correction

### Failure and root cause

The 44-day SOS-light run completed its single source acquisition, all 176 selected connector `1` partition builds, complete-day assembly including the absent 30 July Dropbox day, and metadata planning. Final local proposal validation then correctly stopped before the first R2 mutation because the changed latest Timeseries index claimed this unchanged dependency was staged:

```text
history/_index_v2/observations_timeseries_latest.json
->
history/_index_v2/observations_timeseries/day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json
source=planned_overlay
```

The child index had a byte-identical `changed=false` planning record and therefore was not copied into the mutation overlay. `createStagedObjectMap()` nevertheless treated every record in its `proposals` map as a staged object when resolving dependencies, exact GET/HEAD lookup, listings and local dependency snapshots. The resulting graph contradicted itself: `planned_overlay` provenance named an object absent from the changed write set. The existing validator rejected that contradiction as designed, which is why the run recorded zero day deletions, PUTs, changed objects and post-PUT verification GETs.

### Corrected planning and mutation distinction

Proposal existence and mutation staging are now separate:

```text
proposal.changed=true
-> planned_overlay
-> proposed SHA-256 and bytes
-> included in metadata write set

proposal.changed=false
-> planning/audit record only
-> exact underlying combined-local source, SHA-256 and bytes
-> status=skipped_unchanged
-> excluded from metadata write set
```

`resolveDependencyIdentities()` and `stagedObject()` now use a proposal body only when `changed === true`. Unchanged records fall through to the combined-local store and retain the real source, which is Dropbox for the failed index but may legitimately be `overlay` for another object. GET, HEAD and listing use the same rule; a changed proposal replaces its baseline listing entry, while an unchanged record leaves the single baseline entry and provenance intact.

`localDependencySnapshot()` now marks `staged=true` only for a changed proposal and records every child's source, SHA-256 and bytes. Snapshot validation checks that this identity equals the parent dependency identity, that every `planned_overlay` child has a changed proposal, and that an unchanged child cannot be labelled `planned_overlay`. Diagnostic proposal entries expose `changed`, `status`, `included_in_write_set`, dependency identities and detailed child snapshots.

A latest index may therefore depend on both:

```text
changed child index   -> planned_overlay -> written and GET-verified
unchanged child index -> dropbox         -> skipped, no PUT or post-PUT GET
```

The latest index remains publishable only after every changed dependency succeeds. Planning audit now records changed/skipped proposal counts, changed/baseline dependency-edge counts, metadata mutation-write count, zero planning-time verification operations and the expected changed-object verification count. Runtime write and post-PUT GET counts continue to use the existing canonical apply and final-verification evidence; no duplicate apply counter or validator fallback was added.

The final transition into `runState.objects` was traced and retained: `_record_metadata_executor_overlay()` already stages only proposals with `changed=true`. A focused behavioral check proves the unchanged planning record remains visible as `skipped_unchanged` but is absent from the mutation overlay. Complete-day observation objects remain unchanged: they are still all written after their day prefix is deleted.

### Files changed

- `scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs`: truthful changed-only proposal shadowing, exact baseline fallback, mixed dependency provenance, strengthened snapshots and proposal-graph audit.
- `scripts/backup_r2/tests/uk_aq_execute_v2_observations_repair.test.mjs`: mixed changed/unchanged dependency, GET, HEAD, listing, snapshot, baseline-source and write-set coverage.
- `scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs`: strict final local validation for the correct mixed graph and the original false-`planned_overlay` contradiction.
- `tests/test_uk_aq_history_integrity_repair_planning.py`: actual metadata planning-to-`runState.objects` changed-only transition coverage.
- this implementation report.

The changed active planner was snapshotted at `archive/2026-08-01/scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs` before editing. The apply validator, complete-day apply implementation, `system_docs/`, `TODO-IMPORTANT-UKAQ.txt`, source acquisition, reconciliation, generic Integrity, Prune Daily and AQI paths were not changed.

### Focused structural validation

- JavaScript syntax checks: passed.
- Mixed latest-index dependency provenance, exact lookup, HEAD, listing, snapshot, actual baseline-source and metadata write-set regression: passed.
- Strict final local proposal validation accepts the correct mixed graph and still rejects an unstaged dependency falsely labelled `planned_overlay`: passed.
- Python changed-only metadata overlay transition regression: passed.
- Directly relevant existing absent-Dropbox-day, O3 child-set, ascending per-day apply, later-day protection, indexes-last and generic proposal-safety checks: retained and passed.
- `git diff --check`: passed.

No actual Integrity command, R2/Dropbox/Supabase/GCP/SOS access, deployment, commit, push or pull request was performed.

### CIC-Test operator rerun

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source sos \
  --from-day 2026-06-17 \
  --to-day 2026-07-30 \
  --history-version v2 \
  --run-backfill \
  --repair-pollutants pm25,pm10,no2,o3 \
  --allow-stale-dropbox
```

Acceptance requires changed child indexes to appear as `planned_overlay` and enter the write set; unchanged child indexes to retain pinned Dropbox provenance, remain `skipped_unchanged`, and receive no PUT or post-PUT GET; and the changed latest index to retain both dependency classes and publish only after all changed child indexes verify.

## 1 August 2026 absent-Dropbox-day and per-day apply corrections

### Root causes and corrected behaviour

The SOS-light metadata planner already allowed a selected day with no Dropbox observation objects and could build the strict connector `1` and day parents from current-run source evidence. The later Python materialisation step contradicted that result by requiring the selected Dropbox day directory to exist and raising `FileNotFoundError`. It now treats an absent directory as an empty baseline, copies the existing best-effort Dropbox content only when the directory is present, and continues with the staged connector `1` objects. It does not inspect or recover any other connector from live R2. The durable JSON and Markdown audit record per-day `dropbox_day_present` / `dropbox_day_absent`, the absent-day list and count, a dedicated absent-day warning count, and the existing bounded warning detail.

Connector `1` remains strict. Every selected source-built child must already be staged and structurally validated; its final parent dependencies must equal the complete final child set, including O3; the final day parent must depend on the connector parents actually present; and the complete local proposal, source evidence, parent graph, dependencies, deletion scope and preplanned indexes still validate before the first remote mutation. Index planning continues to use the chosen Dropbox index baseline plus the assembled selected-day result and does not require a Dropbox observation-day directory.

The canonical SOS-light apply path previously completed the deletion loop for every selected day before entering the upload loop. A later upload failure could therefore leave all selected days deleted. Apply now pre-validates every per-day operation unit before any remote callback, then processes selected days in ascending order:

```text
acquire day-finalisation coordination
delete the complete observation day and verify deletion
release day-finalisation coordination
acquire each required connector-day writer lock
upload and GET-verify Parquet children, pollutant manifests and connector parents
release each connector-day writer lock
acquire day-finalisation coordination
publish and GET-verify the prevalidated day parent
release day-finalisation coordination
continue to the next selected day

after every selected day succeeds:
acquire global-index coordination
publish and GET-verify the preplanned affected observation indexes
```

If a day fails, its deletion and object entries plus `apply.sos_light_day_publication[day]` retain the completed publication level and failure detail. The exception stops the ascending loop, so the next day is not deleted and affected indexes are not published. Previously completed days remain fully published and verified. Timeseries and Latest Snapshot reconciliation remains downstream of successful complete R2 replacement and index verification.

### Files changed

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`: accepts an absent Dropbox day as an audited empty baseline and exposes the absent-day evidence in the run summary.
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`: applies SOS-light as prevalidated ascending per-day units and publishes affected indexes only after all units succeed; generic Integrity ordering is unchanged.
- `tests/test_uk_aq_history_integrity_repair_planning.py`: covers connector-1-only absent-day assembly, strict parent dependencies, warning evidence and no live-R2 cross-check call.
- `scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs`: covers first-day upload failure stopping later deletion and successful two-day day-complete-before-next-delete/indexes-last ordering.
- this implementation report.

The two changed active runtime files were snapshotted under `archive/2026-08-01/` before editing. No `system_docs/`, schema, shared writer/index module, generic Integrity, Prune Daily, AQI or `TODO-IMPORTANT-UKAQ.txt` file changed.

### Focused structural validation

- Python syntax compilation: passed.
- JavaScript syntax checks: passed.
- Absent-Dropbox-day connector-1-only assembly and warning/audit regression: passed.
- Two-day first-upload-failure regression: passed; day 2 was never deleted and indexes were not published.
- Successful two-day ordering regression: passed; each day was deleted, published and verified before the next deletion, with affected indexes last.
- Existing focused O3 final-child-set, exact `[1]` scope, complete-day deletion, invalid connector `1` pre-mutation and generic apply-safety checks: retained and passed.
- `git diff --check`: passed.

No real Integrity command was run. No R2, Supabase, Dropbox, GCP or other external operation, deployment, commit or push was performed.

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

## 31 July 2026 protected-connector preservation amendment

The 17 June through 30 July CIC-Test SOS run completed construction of all 176 selected connector `1` partitions, then failed during local canonical proposal preparation before the first R2 mutation. The observation metadata planner rebuilt the shared day hierarchy and passed it to the targeted index builder. That builder correctly traversed every connector advertised by the day and failed closed when the existing connector `7` parent referenced this missing child:

```text
history/v2/observations/day_utc=2026-07-12/connector_id=7/pollutant_code=humidity/manifest.json
```

The failure surfaced as `required_pollutant_index_unreadable`. Catching that final error would have left a dangling reference in the proposal, so the correction is earlier in the dedicated preservation graph.

### Protected connector configuration

`UK_AQ_HISTORY_INTEGRITY_PROTECTED_CONNECTOR_IDS` now owns the dedicated-route protection policy. Its repository default is `1`. An explicit value is parsed as a unique comma-separated set of positive integer connector IDs and sorted deterministically, so a deliberate future value of `1,2,3` needs no preservation-algorithm change. Explicit empty, duplicate or invalid values fail. A write-enabled dedicated replacement also fails before mutation if any selected mutation connector is outside the protected set.

The resolved `protected_connector_ids` and `selected_mutation_connector_ids` are recorded in route evidence, run state, the JSON report and the human-readable report.

### Omission and mutation behaviour

Only `dedicated_sos_historical_observation_replacement` uses the warning-and-quarantine policy. Generic Integrity and the shared targeted index builder retain their existing fail-closed behaviour.

For each affected dedicated day, the planner now inspects the existing referenced connector graph before mutation. Protected connector children remain strict. For an unreadable or invalid unprotected pollutant child, it records a structured warning, rebuilds that connector parent from its remaining readable and valid referenced children, and rebuilds the shared day and latest discovery metadata without the broken reference. If no safe connector parent can be produced, the existing connector parent is left untouched and that connector is omitted from the exact dedicated day publication set.

The dedicated day finalizer publishes the exact prevalidated proposed connector set. It does not union quarantined connectors back in from the old live day and does not fall back to a broad connector listing. Generic day finalisation still uses its existing bounded merge behaviour.

An omitted unprotected child is never a deletion authority. The final dedicated apply guard proves that each omitted child has no proposed object overwrite and is outside every exact tombstone prefix, that every declared parent rewrite is present and permitted, and that no proposed parent body contains the omitted object key. Connector `7` humidity Parquet, its missing/broken manifest location and all other child objects remain untouched. Healthy connector `7` siblings remain dependencies of the rebuilt connector parent.

Machine-readable audit fields are:

```text
protected_connector_ids
selected_mutation_connector_ids
protected_connector_validation_status
healthy_unprotected_children_preserved
unprotected_pollutant_omission_count
unprotected_connector_omission_count
unprotected_day_omission_count
unprotected_omissions
permitted_parent_metadata_rewrites
```

Each omission records the known day, connector, pollutant and object key, classification, reason, omission level, actual parent metadata rewrites, and explicit `child_deleted=false`, `child_overwritten=false`, and `child_tombstoned=false` evidence. The human-readable report presents these as prominent warnings. These warnings increase `warnings_count` without making an otherwise fully verified run fail.

### Files changed for this amendment

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`: protected-set parsing, pre-mutation scope validation, run-state/report propagation, warning accounting and human-readable omission reporting.
- `scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs`: dedicated referenced-graph inspection, narrow unprotected pollutant/connector quarantine, deterministic parent rebuilding and complete preservation audit.
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`: final no-mutation/no-dangling-reference proof and exact dedicated day finalisation.
- `env-vars-master.csv`: repository default and operational meaning for the protected connector setting.
- `tests/test_uk_aq_history_integrity_repair_planning.py`: compact default/custom/empty/invalid/outside-protected configuration checks.
- `scripts/backup_r2/tests/uk_aq_execute_v2_observations_repair.test.mjs`: missing unprotected child warning/omission with healthy sibling retention and protected equivalent blocking.
- `scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs`: protected audit scope and exact dedicated day-publication safety.

The active non-test implementation snapshots taken before this amendment are under `archive/2026-07-31/`. No `system_docs/` file was changed.

### Focused validation

- Python compilation of the touched implementation and focused Python test: passed.
- Dedicated preservation test: passed for connector `7` humidity omission, healthy connector `7` sibling retention, false delete/overwrite/tombstone evidence, and equivalent connector `1` failure.
- Protected configuration test: passed for default `[1]`, deterministic `1,2,3`, explicit empty/invalid/duplicate rejection and selected-outside-protected rejection.
- Direct canonical apply safety checks: passed for the dedicated proposal scope and exact day finalizer with no broad listing.
- `git diff --check`: passed.

No Integrity process, R2, Dropbox, Supabase, GCP or other external service was accessed during implementation or validation.

### Exact CIC-Test rerun

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source sos \
  --from-day 2026-06-17 \
  --to-day 2026-07-30 \
  --history-version v2 \
  --run-backfill \
  --repair-pollutants pm25,pm10,no2,o3 \
  --allow-stale-dropbox
```

Expected audit: protected connector IDs `[1]`; connector `7` humidity reported as an unprotected pollutant omission warning; its child objects untouched; connector `1` completes ordered apply and final verification; Timeseries and Latest Snapshot reconciliation run; overall status may be `ok` with a non-zero warning count.

## 31 July 2026 SOS-light correction

This section supersedes the protected-preservation amendment above. That design was retired because it treated the previous live R2 graph as preservation input and allowed unrelated connector defects to veto connector `1`. The operator-facing mode and run-state value is now `sos-light`.

For every selected day, the only local assembly authorities are the current run's identity-pinned SOS source for selected connector `1` pollutants and the chosen Dropbox history baseline for the rest of the day. Planning does not GET, compare, merge, or preserve old live R2 observation bodies. Connector `1` remains strict; other connectors are Dropbox-only and warning-only. A usable Dropbox connector parent may be retained without certifying every descendant. An unusable unprotected connector parent is warned and omitted locally without blocking connector `1`.

The planner constructs connector `1` from every final pollutant manifest actually present in the assembled local tree, not from the old Dropbox parent child list. Therefore a source-built O3 child is included in the final connector body, `pollutant_codes`, hashes, counts, proposal dependencies and local dependency snapshot alongside PM2.5, PM10 and NO2. The day parent is then rebuilt from the final assembled connector parents.

Python materialises the complete replacement day in the proposal: source-built selected connector `1` objects plus every retained Dropbox day object. Only after that complete local graph and the Dropbox-baseline-derived affected index proposal pass validation are the selected pollutant tombstones replaced with one destructive target per day:

```text
history/v2/observations/day_utc=<day>/
```

Apply acquires the existing writer locks, lists and deletes the complete day, verifies deletion, uploads the assembled child objects and connector parents, publishes the prevalidated day parent, and publishes the preplanned affected observation indexes last. Every object written by the run receives one post-PUT verification GET. SOS-light does not recompute the index proposal from live observation bodies and does not perform a final broad R2 scan. AQI data and indexes remain outside this route.

Current-state reconciliation remains downstream of verified R2 publication. Timeseries and Latest Snapshot candidates come only from final verified connector `1` source evidence; Latest Snapshot remains limited to PM2.5, PM10 and NO2, with O3 excluded.

### SOS-light files changed

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`: `mode=sos-light`, exact protected/selected `[1]` enforcement, complete source-plus-Dropbox day materialisation, full-day destructive scope, audit/report fields and verification accounting.
- `scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs`: final connector `1` child-set construction and warning-only Dropbox parent selection, with no live planning adapter.
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`: complete-day validation/deletion ordering, local final-graph validation, complete-day publication and planned-index-last application.
- `tests/test_uk_aq_history_integrity_repair_planning.py` and `scripts/backup_r2/tests/uk_aq_integrity_apply_safety.test.mjs`: focused SOS-light scope, O3 child-set, Dropbox warning and pre-mutation validation coverage.

No shared writer or shared index implementation was changed. Generic Integrity and Prune Daily retain their existing behaviour. No `system_docs/` file was changed.

### Focused structural validation

Passed locally on 31 July 2026: old connector `1` PM2.5/PM10/NO2 parent versus a final four-child PM2.5/PM10/NO2/O3 parent; identical four-child body/dependency evidence; an unusable Dropbox connector warning and omission without blocking connector `1`; source-plus-Dropbox complete-day materialisation; complete-day deletion scope; invalid connector `1` source/parent failure before remote adapters; exact `[1]` protection enforcement; and one existing generic-path apply-safety check. Python compilation, JavaScript syntax checks and `git diff --check` also passed. The actual Integrity command and all external services remained outside structural validation.

### CIC-Test rerun

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source sos \
  --from-day 2026-06-17 \
  --to-day 2026-07-30 \
  --history-version v2 \
  --run-backfill \
  --repair-pollutants pm25,pm10,no2,o3 \
  --allow-stale-dropbox
```

Expected audit fields include `mode=sos-light`, selected days and pollutants, Dropbox baseline, source identities, the two assembly authorities, `old_live_r2_observation_bodies_used=false`, final connector `1` child sets, final assembled connector sets, Dropbox warning/omission counts, complete-day deletion/upload counts, changed-object verification, affected index results, and separate R2, Timeseries, Latest Snapshot and overall statuses.
