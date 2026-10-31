# Legacy R2 observation staging retirement assessment — 31 October 2026

## Executive conclusion

**The recurring Prune staging mechanism is obsolete. Recommend Option A for the subsequent TEST implementation: remove it completely. Treat any historical objects through the independent v2 retirement process (Option C's separation of responsibilities), without adding a replacement cleaner. Option B is not supported by the traced code.**

Current v3 Prune does not write, read, copy, recover or publish receipts through `history/v2/_ops/observations/staging/`, or through its configured staging prefix. Its run-specific `staging_prefix` is constructed but never consumed. The base prefix survives solely for an age-based LIST/DELETE sweep. The original staging-and-copy producer was removed on 3 March 2026; this is stronger evidence than an empty recent listing.

Removing that sweep does not remove canonical publication, verification, locks, finalisation, READY/CONSUMED deletion authority or recovery protection. It removes unnecessary legacy storage access and a possible unrelated failure after canonical gate completion but before downstream source deletion. Do not redirect the sweep to v3.

**Safe to proceed to a separately reviewed TEST implementation PR.** No new functional operation or remote inventory is needed to establish this code-removal design. Real TEST acceptance remains required before promotion. Historical namespace deletion is a separate unresolved decision: no R2 inventory was taken here, no objects are approved for deletion, and [PR #152](https://github.com/TEST-uk-aq/uk-aq-ops/pull/152)'s category-A manifest remains **0 objects / 0 bytes**.

This PR is documentation only. Application code, authoritative `system_docs/`, operational configuration and remote data remain unchanged. No Prune, workflow dispatch, backup, repair, lock acquisition or deployment was executed.

## Evidence identity and method

Current GitHub sources were pinned to:

| Source | Commit |
|---|---|
| TEST Ops | [`fad44fecb0a33cd869945d74f69099850ac362fc`](https://github.com/TEST-uk-aq/uk-aq-ops/tree/fad44fecb0a33cd869945d74f69099850ac362fc) |
| Authoritative TEST system docs | [`bd3edb6cf100626284789958c120957574ed78f0`](https://github.com/TEST-uk-aq/uk-aq-system-docs/tree/bd3edb6cf100626284789958c120957574ed78f0) |
| LIVE Ops, read-only comparison | [`2aeec5ec33124619b69fcb9c487bd8a0e5682829`](https://github.com/UK-AQ/uk-aq-ops/tree/2aeec5ec33124619b69fcb9c487bd8a0e5682829) |
| Existing retirement report, PR #152 | [`9cfd074185a774ba20d1030d99efb205b55ba8a0`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/9cfd074185a774ba20d1030d99efb205b55ba8a0/docs/investigations/r2-v2-retirement-assessment-2026-10-31.md) |

The supplied workspace was older (Ops `ea7212e8`, system docs `3276ae32`). Shell Git fetch failed because the session proxy was unreachable. Current reads and PR delivery therefore use the GitHub connector; the older checkout is not presented as current main. Read-only source evidence was materialised under `work/` for `grep`, without replacing application files or creating a system-doc mirror.

Before delivery, TEST main advanced to `d6cd1fc74f9ff9ad923e0654798b0bd9446b0b63`. The two intervening commits changed only `workers/uk_aq_blog_feed/worker.mjs`; that file has no staging reference. The investigation's pinned Prune/configuration evidence is unchanged, and the report branch uses that newer main as its parent.

Followed Ops and Prune `AGENTS.md`, `SYSTEM_OVERVIEW.md`, the R2-history router and the backup router. Searched tracked active workspace code/configuration, excluding archives, for both environment names, constants, runtime properties, cleanup names, `historyStagingRetentionDays` and literal observation-staging paths. Refreshed the current Ops writer/helper, migration, Integrity, JSONgen, workflow/configuration and reporting closure; inspected remaining changed active Ops source/configuration for the same references. Historical plans and archives were classified separately, not used as runtime authority. GitHub code search returned `incomplete_results=true`; its empty results were **not** used as absence evidence.

Cross-repository searches covered Ingest, Schema, Integrity Factory, Sensors Ingest, Population Ingest and the website after reading their agent rules. Current tree identities were respectively `b57d7ada`, `ee8a5ab5`, `22eb3435`, `ad1d2281`, `063a775e`, `654b9f51`. Compared these trees with the workspace blobs and checked changed active source/configuration text; no observation-staging producer, configuration consumer or cleanup-summary consumer was found outside Ops. Factory and Population trees were unchanged. A supplemental available Media checkout search also found no matching reference; Media is outside the observation-history ownership route.

This proves the inspected repository relationships, not the absence of an unknown installed/manual writer. No configured R2/Dropbox credentials or direct service access were available; no R2 LIST/GET/HEAD or Dropbox read was performed. Installed launchd jobs, private operator catalogues and external reporting consumers are not independently inventoried here. Those limitations matter to deletion/promotion acceptance, not to stopping an obsolete recurring deleter.

## Contracts and structural viability

All contract paths below are in authoritative TEST system docs at the pinned revision:

- `r2_history/observation_history_v3_side_by_side_generation_contract.md` and `observation_history_v3_website_cutover_scope_amendment.md`: one required `UK_AQ_R2_HISTORY_VERSION` selects complete observations, runs, Core, indexes, bindings and backup authority. The older mixed-prefix examples in compatibility documents do not supersede these amendments.
- `r2_history/prune_daily_observation_only_phase_b_contract.md`, `prune_daily_complete_snapshot_child_set_contract.md` and `history_writer_coordination.md`: exact frozen first-publication source, admission before PUT, verified canonical children, complete connector child set, bottom-up parents and exact-v3 finalisation before gate completion.
- `r2_history/prune_connector_day_gate.md`, `implementation_safety_contract.md` and `observations_run_exclusion_contract.md`: original source/run identity, single-use READY to CONSUMED authority, atomic matching-source deletion, retained-session global operation exclusion and fail-closed loss handling.
- `r2_history/prune_daily_runtime_budget.md`: controlled stops preserve retry-safe durable output or a valid checkpoint. Its generic cleanup wording does not require this R2 age sweep. Partial publication must not become completed authority.
- `r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md` and `observation_history_v3_live_completion_decision_2026-10-21.md`: immutable migration evidence remains distinct from steady state; the specific LIVE waiver of an additional archive-wide verifier must not be turned into a TEST exemption or a claim that the incomplete verifier passed. PR #152 establishes later successful operations separately from older pending-status prose.
- `backup_and_recovery/r2_history_dropbox_backup_contract.md` and `r2_history_backup_inventory_contract.md`: generation-coherent canonical backup and authenticated checkpoint authority; no arbitrary `_ops` scratch inclusion. Generic restore is not complete recovery authority.
- `r2_history/integrity.md` and `sos_light_three_phase_authority_contract.md`: pinned canonical Dropbox baseline plus local overlay/source authority; staging/overlay files are distinct from Prune's R2 prefix. Fixed-v2 Integrity/SOS-light retirement does not prove installed launchers have stopped.

No reviewed active contract requires this staging namespace, its retention variable or its cleanup report. No contract conflict blocks removal. The proposed change must leave all listed canonical and recovery requirements intact. A separate ChatGPT handover accompanies this report; no authoritative document is edited. This work does not change `_index_v3`, exact-only indexing, writer concurrency, timeouts or generation selection.

## Exact active staging/configuration references

Unless stated otherwise, links refer to TEST Ops `fad44fecb`.

| File / location | Current role |
|---|---|
| [`workers/uk_aq_prune_daily/phase_b_history_r2.mjs:195`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L195) | `DEFAULT_STAGING_RETENTION_DAYS=7`; `DEFAULT_STAGING_PREFIX=history/v1/_ops/observations/staging`. |
| [Same file:6863](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L6863) | Entire `cleanupStaging()` implementation and batch-error warning. |
| [Same file:6983](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L6983) | `resolvePhaseBRuntimeConfig()` normalises the optional prefix with the v1 fallback; lines 7142–7148 return retention/base fields. |
| [Same file:7222](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7222) | Constructs `${phaseB.staging_prefix_base}/run_id=${runId}`. No subsequent read of `runtime.staging_prefix`. |
| [Same file:7774](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7774) | Executes/skips cleanup, attaches `summary.staging_cleanup`, then writes the canonical generation-selected run manifest and summary log. |
| [`workers/uk_aq_prune_daily/server.mjs:1702`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/server.mjs#L1702) | Additional consumer: HTTP `historyStagingRetentionDays` override of `phaseB.staging_retention_days`. |
| [`.github/workflows/uk_aq_prune_daily.yml:66`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/.github/workflows/uk_aq_prune_daily.yml#L66) | Supplies retention from `vars` or `7`, prefix from `vars` or v1. Required-config checks at line 104 onward do not require either staging variable. |
| [`config/uk_aq_github_env_targets.csv:262`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/config/uk_aq_github_env_targets.csv#L262) | Declares both names as GitHub variables; neither is a secret or generation selector. |
| [`README.md:130`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/README.md#L130), [`ops_vars.txt:188`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/ops_vars.txt#L188) | Documented controls and a July TEST variable export (v1, seven days). No code reads `ops_vars.txt`; it is not current LIVE configuration evidence. |
| [`scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.mjs:35`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.mjs#L35) | `CONTROLLED_STAGING_RETENTION_DAYS=365000`; line 452 sets it directly, lines 519–521 reject nonzero cleanup deletions, lines 754 and 810 include it in controlled-limit reports. This suppresses historical cleanup; it is not a producer/recovery requirement. |
| `tests/index_v3_controlled_phase_b_acceptance.test.mjs:42,127,196`; `tests/uk_aq_prune_history_gate.test.mjs:1729` | Retention fixture/assertion, cleanup-summary fixture and unused staging-base fixture. These are test compatibility, not storage consumers. |

`env-vars-master.csv` is ignored and absent from this workspace/current tracked tree. Its private rows must be retired by the catalogue owner during subsequent TEST configuration housekeeping; this report cannot certify their contents. Historical plans/archives/PR #152 records should retain their original evidence, not be rewritten to erase old names.

## Producer, consumer and recovery trace

### Historical origin

[`a39e7633080ee78acf45321f5a701cb99dd5011b`](https://github.com/TEST-uk-aq/uk-aq-ops/commit/a39e7633080ee78acf45321f5a701cb99dd5011b), 2 March 2026, introduced `workers/uk_aq_prune_daily/phase_b_backup_r2.mjs`. It PUT parts under `runtime.staging_prefix`, verified staged parts, copied them to committed keys using `r2CopyObject`, verified committed objects and published manifests. Its original default was `backup/staging`.

[`3d1dd32ffba63075e16392c968cd9bfddabdf167`](https://github.com/TEST-uk-aq/uk-aq-ops/commit/3d1dd32ffba63075e16392c968cd9bfddabdf167), 3 March 2026, explicitly removed the staging-copy flow and `r2CopyObject` use. Parts were written directly to committed keys with database resume checkpoints. The unused staging configuration, run field and cleaner survived; a later module rename retained them. These historical producers explain the mechanism, but do not prove any particular old R2 key still exists or is disposable.

### Current normal publication

1. [`phase_b_history_r2.mjs:3018`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L3018) creates an OS-local temporary directory and `target_day_observations.ndjson`. Frozen source caps and source identity apply. `cleanupPhaseBTargetDaySourceTemp()` removes local files on normal/error paths; no staging R2 key is involved.
2. `exportCandidateToR2()` at line 5131 selects observation export. V3 dispatch reaches `publishFrozenV3Observations()` at line 3797 and its explicit call at line 3949 to `runOperationalPruneDailyObservationHistoryV3ConnectorPublication()`. Arguments are generation, canonical observation prefix, scoped rows, R2 client, locks, budget/readback adapters and diagnostics. Neither staging field nor the full runtime object is forwarded into the shared writer.
3. [`workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs:622`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L622) builds canonical file intents directly from the validated observation prefix. At line 1430 those exact intents go through checksum-aware PUT/HEAD verification. Canonical manifests and exact-v3 scopes are published from verified children, without a staging/copy adapter.
4. `finalizeSelectedObservationRun()` passes explicit canonical scope/publication evidence to the operational finaliser at Phase B line 4126. `validatePhaseBV3RunFinalizationResult()` precedes protected candidate/connector gate completion. Its captured metadata and same-run verification cache concern canonical keys, not staging.
5. `writeRunManifest()` at line 6916 uses the generation-selected **runs** prefix, distinct from staging. Optional JSONgen pending bundles use `managed/jsongen/v1/pending/unverified/prune_daily_v3` in its separate private derived bucket (`scripts/jsongen/prune-signed-upload.mjs:9`); original immutable evidence/outbox, signed upload, receipts and retries do not consume the legacy prefix. Do not remove those systems or their own cleanup/recovery rules.

### Failure, restart and other services

- `cleanupCandidatePartialOutput()` at Phase B line 3001 deliberately skips canonical deletion with reason `checksum_publication_is_retry_safe_and_existing_authority_must_not_be_deleted`. Candidate failures/budget stops retain or invalidate the appropriate gates, remove local source files and preserve retry-safe durable canonical objects. This function is separate from `cleanupStaging()` and must remain.
- Same-attempt retry depends on authenticated original source/admission, canonical parent-child state and exact verification. Ambiguous prior authority and unproven gate-only recovery remain blocked. No staged R2 object supplies the missing original proof. Removing the sweep neither enables nor repairs automatic gate-only recovery.
- Migration has real **local** staging: [`scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs:2223`](https://github.com/TEST-uk-aq/uk-aq-ops/blob/fad44fecb0a33cd869945d74f69099850ac362fc/scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs#L2223) roots it at `<checkpoint-out>.staging`; lines 2288–2344 durably write/read/release local files with path, SHA and size checks. `staging_ref` in the migration library is that local evidence, not Prune configuration. Preserve it and its authenticated journal/replay rules.
- Integrity/SOS-light uses its own run-local overlay/proposal files and the pinned Dropbox canonical baseline. Neither the shared writers nor these wrappers read either staging environment variable. Local Integrity working-file disposal and acquisition caches are separate ownership boundaries.
- Backup inventory validates generation-selected prefixes (`scripts/backup_r2/build_backup_inventory.mjs:161`) and inventories canonical observations, Core, bindings/pack authority, compact latest and **runs**. `scanRunManifests()` at line 369 scans only `args.runs_prefix` and accepts `run_id=.../run_manifest.json`. It does not back up the sibling staging prefix. Sync/restore cannot make arbitrary historical scratch into verified recovery material merely because it lies below `_ops/observations`.
- Scheduler configuration dispatches the existing workflow; there is no staging-specific scheduler job. Current remaining Ops runtime/configuration and related TEST repository searches found no independent reader, producer or validator. Installed/manual historical jobs remain an operator inventory concern before historical deletion.

## What cleanup actually does

| Question | Established behaviour |
|---|---|
| Exact scan scope | `normalizePrefix(configured value or v1 default) + '/'`; lists the **base**, all run IDs and descendants, not this run's `staging_prefix`. `r2ListAllObjects()` (`workers/shared/r2_sigv4.mjs:917`) follows continuation tokens, 1,000 keys per page. |
| Selection | Threshold is `Date.now() - staging_retention_days * 86400000`. Selects every listed key with parseable `last_modified` strictly **older** than threshold. Missing/invalid timestamps and exactly-equal timestamps are retained. No suffix, manifest, producer, run-state, reference, checksum, hold or recovery test. |
| Retention | Normal resolver defaults to seven days and clamps numeric input to 1–90; malformed nonnumeric input falls back. HTTP override uses the same bounds. The controlled acceptance harness bypasses that parser and directly sets 365,000 days. These are cleanup knobs, not canonical retention authority. |
| Deletes | Batches up to 1,000 stale keys using `r2DeleteObjects()` (`r2_sigv4.mjs:978`). DELETE uses keys without expected object identity. Newly rewritten keys can therefore race the list for a non-participating writer. |
| Selected generation | No staging-prefix generation or canonical-overlap assertion. A v3 run can scan/delete v2 or v1. Correctly configured legacy staging is disjoint from current v3 output; a misconfigured base could target canonical v3, runs or another domain. Shared generation checks validate canonical destinations, not this sweep. |
| Coordination | Standard `job.mjs:103` supervisor owns the global observation lock through child execution, including Phase B cleanup and later deletion. Controlled apply checks its lock context. Cleanup itself neither acquires nor asserts a lock; a direct library/legacy HTTP invocation is not made safe merely by calling it. No lock excludes an unknown non-participating manual producer. Do not broaden this change into lock-entrypoint repair. |
| When executed | Reached non-dry-run Phase B tail, including a no-work run. Disabled/dry-run returns and earlier fatal exceptions do not clean up. `status=stopped_budget` attaches a skipped result (`reserved_for_final_reporting`) instead. Handled candidate failures/partial-attention results can still reach the sweep. It is not a crash-recovery finally block. |
| Error effect | LIST/request/non-2xx DELETE exceptions propagate: no local cleanup catch at the tail, so run-manifest/summary completion and downstream source deletion can be prevented **after** gates were committed. Per-key DELETE errors instead produce a warning and `staging_cleanup.error_count`; this nested count is not added to candidate failures or the top-level error count checked by `server.mjs:2882`. |
| Cost | At least one unnecessary LIST per reached ordinary run, more if paginated, plus DELETE requests when old keys exist. No application-level cleanup budget admission protects the final reporting reserve on this normal path. Removing it saves requests and latency; no measured monetary saving is claimed. |

An interrupted original staging-era operation could in principle depend on an old object selected by this age-only sweep: age is not evidence of abandonment. No current inspected v3 operation depends on those objects. The sweep is redundant for current operations and poorly suited to deliberate historical recovery/retirement. Its removal preserves potential historical evidence instead of disposing of it silently.

## Why LIVE still references v2

Read-only LIVE source comparison found the Phase B module, `job.mjs` and Prune workflow byte-identical to current TEST (Phase B blob `16f6f6a328168259142dae96f17ef6cac530fe18`; job `7e046bdd50ad2ea81875c6500349d4aa489df4ed`; workflow `d27cce287638c28f349e185cf0fc3576474094e3`). Thus there is no separate LIVE staging implementation to preserve.

Independently read the existing [31 October LIVE Prune run 41160319017](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41160319017), job `124416238788`. Its environment export reports `UK_AQ_R2_HISTORY_STAGING_PREFIX=history/v2/_ops/observations/staging` and retention `7`; its Phase B start selects `v3`. At 02:56:56 UTC, run `d2b9035d-79df-4d3e-8573-e4470d0c89b0` reports `status=completed`, three completed candidates / 38,347 written rows, and `staging_cleanup={scanned_count:0,deleted_count:0,error_count:0}`. The run manifest is under `history/v3/_ops/observations/runs/`. PR #152 separately records matching successful source deletion, Core and backup evidence and the recent Phase A qualification.

The workflow's fallback is **v1**, so the observed v2 value comes from its configured `vars` value, not v3 generation resolution. The independent staging setting survived removal of its producer and subsequent generation changes; no shared selector derives or validates it. The exact setting-change author/date and repository-versus-inherited variable ownership were not audited. The July TEST `ops_vars.txt` export cannot establish those LIVE facts.

The zero scan supports only that observed cleanup response at that time. It is not a fresh independent namespace inventory, proof of no historical objects, or deletion approval.

## Smallest complete subsequent TEST fix

Apply one environment-independent removal, with no new setting, v3 staging prefix, replacement cleaner or permanent legacy compatibility path.

| Complete TEST file to change | Bounded proposed edit |
|---|---|
| `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` | Remove both `DEFAULT_STAGING_*` constants; staging environment parsing; `staging_retention_days`, `staging_prefix_base` and run `staging_prefix`; `cleanupStaging()`; tail invocation/skip object; `summary.staging_cleanup`; obsolete warning. Remove the now-unused `r2DeleteObjects` import (its only call in this module is the sweep). Keep shared `r2ListAllObjects`, `normalizePrefix`, `DAY_MS` and other helpers still used elsewhere. |
| `workers/uk_aq_prune_daily/server.mjs` | Remove the `historyStagingRetentionDays` query override and associated assignment. Preserve all canonical configuration, publication/deletion outcome evaluation and task-health handling. |
| `.github/workflows/uk_aq_prune_daily.yml` | Remove the two staging environment declarations and both fallbacks. Keep generation, bucket/credential checks, locks, runtime limits, concurrency and report upload unchanged. |
| `config/uk_aq_github_env_targets.csv` | Remove the two obsolete variable mappings. |
| `README.md` | Remove the two staging controls; explain briefly that normal publication is canonical and legacy scratch disposition is separate. Avoid adjacent README/AQI/default cleanup. |
| `scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.mjs` | Remove `CONTROLLED_STAGING_RETENTION_DAYS`, its override, both controlled-limit report fields and the obsolete cleanup-deletion assertion. Retain every publication/source-retention/no-downstream-deletion/lock/postflight acceptance check. |
| `tests/index_v3_controlled_phase_b_acceptance.test.mjs` | Remove obsolete retention expectation and staging fixtures; retain the real controlled-acceptance safety assertions. |
| `tests/uk_aq_prune_history_gate.test.mjs` | Remove the unused staging-base fixture; preserve finalisation/gate/deletion assertions. |
| `ops_vars.txt` | Retire the two obsolete rows from this tracked informational export, or replace it with an explicitly dated refreshed export during authorised TEST catalogue housekeeping. Do not fabricate a new remote-state observation. Git retains the historical snapshot. |

These are the complete known tracked implementation/configuration/documentation/test edits. No shared writer/index, backup, Integrity, schema or scheduler file requires a functional change. Subsequent code edits must use the pre-change archive policy for active non-test code; this documentation-only investigation needs no code archive.

Also retire both rows in the owner's ignored `env-vars-master.csv`, remove the unused TEST GitHub variables using the established configuration process, and check installed TEST launchers/env files. Removing target-map rows alone does **not** prove remotely stored variables were deleted; verify the actual result. None of these operational configuration mutations is authorised now. Retained stale variables become inert once their readers are removed, allowing safe sequencing: reviewed TEST source change, separately authorised configuration cleanup/deployment, then real acceptance. LIVE promotion/configuration cleanup remains a separate operator action after TEST acceptance; use identical complete source files.

### Reporting compatibility

Remove `staging_cleanup` from new Phase B JSON logs, persisted run summaries and job-report nesting; leave historical reports intact. Preserve all candidate/row/byte/day counts, finalisation status, source/gate outcomes, run-manifest key and global-lock evidence. `compactPruneHealthSummary()` does not consume the cleanup field, nor do inspected dashboard/metrics consumers. Task-health semantics remain unchanged for canonical failures; removal intentionally eliminates failures caused solely by obsolete cleanup requests and their batch-error warning.

The controlled acceptance reader already treats a missing `staging_cleanup.deleted_count` as zero, so removing the producer does not break its existing parser. Remove its obsolete suppression/reporting scaffolding in the same PR instead of leaving permanent compatibility code. No known repository consumer needs a synthetic zero-success cleanup field. Before deployment, notify/check any external report consumer identified by the operator; if one actually requires the field, document a bounded reporting migration without retaining R2 access or inventing another cleanup mode.

## Historical staging and PR #152

Do not delete objects or expand the existing manifest. Until a later implementation has been deployed and accepted in LIVE, keep PR #152's explicit exclusion for `history/v2/_ops/observations/staging/`. A TEST merge alone does not resolve that LIVE dependency.

For any future request to remove the namespace, record separately: accepted TEST change and eventual LIVE source/runtime identity; absence of recurring staging access; exact account/bucket/prefix and capture time; complete paginated final per-key inventory with size, LastModified and identity; ownership/hold/recovery disposition of any objects; and absence/exclusion of installed/manual legacy producers. An empty final inventory can close the exclusion with a dated evidence record and **zero** deletion entries. A nonempty inventory requires independent per-object assessment/approval; it must not silently become eligible through this report or a broader `history/v2/` rule.

Protect v3 observations and run evidence, `_index_v3`, Core, bindings, backup inventories/checkpoints/packs and every Dropbox object. Do not infer backup coverage of staging from canonical v2 backup completion. Removal of the recurring sweep may leave historical scratch indefinitely; eventual cost recovery belongs to the separately approved retirement process. The other recovery/rollback/retention gaps in PR #152 remain unchanged.

## Validation and acceptance proposal

### Investigation validation performed

Completed static producer/consumer/configuration tracing, pinned current-source comparison, historical staging-removal review and bounded existing LIVE-log inspection. Confirmed that v3 writer/finaliser interfaces do not accept staging fields, shared generation authority has no staging domain, and no schema migration or new configuration is structurally required. Checked report diff/links and documentation-only change scope. No new automated test suite, application import, functional test or operational run was created/executed.

### During the subsequent implementation, before deployment

1. Repeat the focused `git grep` reference inventory against then-current TEST main, including the HTTP override, controlled harness, tests and configuration; inspect every residual active reference. Archive changed active non-test code as required. Historical evidence references may remain.
2. Run `node --check` on every changed JavaScript module/test; parse the edited workflow YAML with the existing tooling; validate target CSV shape/uniqueness and absence of both obsolete mappings. No new type system is needed for these `.mjs` removals. Run `git diff --check`.
3. This removes a Phase B stage, so apply the worker `AGENTS.md` regression-sensitive exception: adjust/run the existing focused controlled-acceptance and Prune gate/path/lock/failure regressions, then the complete local **Node** suite once after stable focused success. Do not use broad `npm test` merely to add unrelated Python work. Preserve observable successful canonical finalisation/deletion reachability and fail-closed failed/budget/ambiguous-authority branches. If existing seams require a new check, add only a narrow deterministic assertion that obsolete staging operations are never invoked while required publication/gates remain reachable; do not create source-text mirror tests or a parallel fake writer.
4. Review the actual patch to prove no gate, lock, checksum, canonical temporary-file handling, migration journal/overlay or JSONgen evidence path was removed with similarly named cleanup code. Configuration with missing/malformed required generation/bucket/credentials must still fail explicitly; removal of an optional unused staging setting must not add any environment fallback.

No additional pre-implementation service check is required: an R2 inventory cannot strengthen proof that a fully removed deleter has no runtime call site. Destructive/error recovery branches cannot safely be established by deliberately corrupting operational data; preserve their existing deterministic checks during implementation. Fresh historical inventory is required before **deletion**, and private catalogue/external consumer verification before the relevant **configuration/deployment** acceptance, not permission to run anything during this investigation.

### Separately authorised real TEST acceptance after deployment

- Record deployed revision, selected generation `v3`, explicit TEST target and configuration cleanup. Observe one normal successful Prune with eligible source rows: canonical Parquet/manifest verification, exact required index/parent finalisation, original connector gate READY and matching-source full drain/CONSUMED in the atomic transaction. Require truthful internal success and source-deletion counts, not workflow green alone.
- Use existing request tracing/audit evidence where available plus the removal review to establish **no staging-prefix LIST/GET/PUT/COPY/DELETE**, including v1/v2 fallback paths. Zero objects scanned is insufficient. Keep legitimate canonical/finaliser LISTs and all normal run evidence/report uploads.
- Check normal/no-work/dry-run/budget summaries for correct omission of obsolete cleanup fields, unchanged canonical counters/status/task health and no staging warning. Collect actual run report and generation-selected run-manifest identity; distinguish unrelated Phase A problems.
- If a genuine retry/interruption naturally occurs, confirm it uses current canonical/source authority, preserves incomplete gates/source rows and either recovers through existing authenticated rules or blocks with an actionable report. Do not manufacture R2/source corruption, force gate-only recovery or require a speculative operational failure campaign for this removal.
- Confirm the accepted global-lock lifecycle still encloses publication, gates and source deletion, and that the next normally authorised v3 backup succeeds with its existing complete checkpoint authority. Preserve current Integrity/SOS baseline/overlay behaviour; no extra repair invocation or archive-wide verifier is introduced by this cleanup change.

If acceptance fails, stop promotion and retain evidence/source rows under the existing fail-closed rules. Revert the bounded TEST source/configuration change if required; do not delete historical objects or switch history generations as a rollback. Restoring an old revision also restores its obsolete sweep, so review its configured target before any later authorised operation.

**Recommendation:** remove the legacy staging dependency completely in a subsequent TEST implementation PR using the file list above. No missing repository evidence blocks that implementation. TEST operational acceptance and explicit later LIVE promotion are still required; historical R2 inventory, installed/manual ownership and recovery disposition remain required only for the separate namespace-retirement decision.
