# SOS historical Integrity replacement implementation report

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

Both the single-pollutant command and the multi-pollutant range command are now structurally supported: every selected pollutant retains a separate immutable evidence identity through final proposal validation, ordered apply and live verification.

## Deployment and operator handover

- No operator command change is required.
- No new configuration, database migration or cloud resource is required.
- Make this repository revision available to the CIC-Test Integrity checkout selected by its existing local selector.
- Run the three functional acceptance commands in order.
- Take a fresh Dropbox history backup after meaningful repair work as the normal recovery copy.
- Do not deploy or run this path against LIVE as part of this change.
