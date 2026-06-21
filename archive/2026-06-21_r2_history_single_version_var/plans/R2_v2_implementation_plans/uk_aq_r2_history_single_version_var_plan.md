# UK AQ R2 History Single Version Variable Plan

Date: 2026-06-21

Scope: CIC-Test ops planning only. Do not touch LIVE. Do not deploy. Do not run real R2 writes, Dropbox writes, Supabase writes, source downloads, backfills, repairs, GitHub workflow dispatches, or Cloudflare deploys while executing this plan unless a later implementation phase explicitly says to do so and the operator approves that phase.

## Purpose

Replace the split runtime selectors:

```bash
UK_AQ_R2_HISTORY_BACKUP_VERSION=v2
UK_AQ_R2_HISTORY_WRITE_VERSION=v2
UK_AQ_R2_HISTORY_READ_VERSION=v2
```

with one canonical active-environment selector:

```bash
UK_AQ_R2_HISTORY_VERSION=v2
```

`UK_AQ_R2_HISTORY_VERSION` must control normal R2 history read, write, backup, core snapshot, scheduler dispatch, and dashboard behavior for the active environment.

`UK_AQ_R2_HISTORY_INDEX_VERSION` remains an explicit index-builder selector, and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` remains an explicit integrity default selector. They must not be used to split normal read/write/backup runtime behavior.

Allowed environment values:

- `v1`
- `v2`

No environment value of `both`.

Manual integrity checks may keep:

```bash
--history-version v1
--history-version v2
--history-version both
```

In that context, `both` is an explicit validation mode only. It must not be derived from `UK_AQ_R2_HISTORY_VERSION` and must not become a scheduler or runtime operating mode.

## Plan Location

This file is in `plans/R2_v2_implementation_plans/` instead of `docs/plans/...` because this repo already stores the active R2 v2 plans and runbooks there:

- `plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_cic_test_build_validation_runbook.md`
- `plans/R2_v2_implementation_plans/uk_aq_history_integrity_v1_v2_plan.md`
- `plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_pollutant_split_plan_and_codex_prompts.md`

Keeping this plan beside those files avoids splitting the R2 v2 implementation trail across two documentation roots.

## Current Findings

### Existing Active Values

Current CIC-Test ops `.env` contains:

```bash
UK_AQ_R2_HISTORY_BACKUP_VERSION=v2
UK_AQ_R2_HISTORY_WRITE_VERSION=v2
UK_AQ_R2_HISTORY_READ_VERSION=v2
```

No `UK_AQ_R2_HISTORY_VERSION` references were found in active ops source.

### Scheduler Cause Of Double Runs

The current Cloudflare scheduler source dispatches four version-specific jobs:

- `uk_aq_r2_core_snapshot_v1` with `history_version=v1`
- `uk_aq_r2_core_snapshot_v2` with `history_version=v2`
- `uk_aq_r2_history_dropbox_backup_v1` with `backup_version=v1`
- `uk_aq_r2_history_dropbox_backup_v2` with `backup_version=v2`

Files:

- `cloudflare/workflow-scheduler/worker.js`
- `cloudflare/workflow-scheduler/wrangler.toml`
- `cloudflare/workflow-scheduler/README.md`
- `tests/workflow_scheduler.test.mjs`

The test crons in `wrangler.toml` were temporary and intentionally used to observe behavior. The standard times should be:

```text
04:15 UTC  uk_aq_r2_core_snapshot
04:35 UTC  uk_aq_r2_history_dropbox_backup
```

Desired standard model:

```text
0 3 * * *    uk_aq_stations_daily
15 4 * * *   uk_aq_r2_core_snapshot
35 4 * * *   uk_aq_r2_history_dropbox_backup
49 5 * * *   uk_aq_dropbox_prune_raw
```

The scheduler must dispatch each logical job once. It must not dispatch v1 and v2 variants automatically.

Final scheduler job keys must be:

- `uk_aq_r2_core_snapshot`
- `uk_aq_r2_history_dropbox_backup`

The Worker must not keep baked-in v1/v2 job variants. The active version should come from `UK_AQ_R2_HISTORY_VERSION` at workflow/runtime configuration time, not from the scheduler job name.

## Archive Policy For This Implementation

Before changing any active file for this implementation plan, create a one-time archive snapshot of that file under an implementation-specific archive directory, for example:

```text
archive/2026-06-21_r2_history_single_version_var/
```

Rules:

- Archive each changed file only once for this implementation plan.
- If a file has already been archived for this implementation, do not create another archive copy of that same file in later phases.
- If a later phase changes a file that was not previously archived for this implementation, archive that file once before editing it.
- Preserve the file's repo-relative path inside the archive directory so restore/diff is straightforward.
- Do not modify an archive copy after creating it.
- Do not archive generated logs, dependency folders, `.venv`, `node_modules`, or external runtime data.
- Do not archive routine generated test output unless it is intentionally committed source material.

Suggested archive command pattern:

```bash
archive_root="archive/2026-06-21_r2_history_single_version_var"
file="path/to/file.ext"
if [ ! -e "${archive_root}/${file}" ]; then
  mkdir -p "${archive_root}/$(dirname "${file}")"
  cp -p "${file}" "${archive_root}/${file}"
fi
```

This archive policy is local to this implementation plan. It does not change the project-wide rule that existing `archive/` files are read-only after creation.

## Required Analysis Answers

1. Where are the old read/write/backup vars currently read?

- `UK_AQ_R2_HISTORY_READ_VERSION`
  - `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`
  - `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
  - `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml`
  - `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
  - `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
  - `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
  - `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
  - `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`
  - `workers/uk_aq_dashboard_online_api_worker/src/lib/upstream.ts`
  - `local/dashboard/server/uk_aq_dashboard_api.py`
  - `scripts/dashboard/check_r2_history_read_version.mjs`
  - `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` as `site_read_version` context only
  - tests and docs listed in later sections.

- `UK_AQ_R2_HISTORY_WRITE_VERSION`
  - `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`
  - `.github/workflows/uk_aq_r2_core_snapshot.yml`
  - `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`
  - `.github/workflows/uk_aq_r2_initial_build_inventory.yml`
  - `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
  - `scripts/backup_r2/lib/inventory.mjs` fallback for backup version
  - `scripts/backup_r2/uk_aq_validate_aqi_from_dropbox_observs.mjs`
  - `scripts/report_daily_task_health.mjs`
  - `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
  - `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
  - `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
  - `workers/uk_aq_backfill_local/run_job.ts`
  - tests and docs listed in later sections.

- `UK_AQ_R2_HISTORY_BACKUP_VERSION`
  - `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`
  - `.github/workflows/uk_aq_r2_initial_build_inventory.yml`
  - `scripts/backup_r2/lib/inventory.mjs`
  - `scripts/report_daily_task_health.mjs`
  - `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
  - `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
  - tests and docs listed in later sections.

2. Which scripts/workflows use separate read/write/backup concepts?

- Read: API Worker deploy workflows, metrics API deploy workflow, dashboard API deploy workflow, local and online dashboard code.
- Write: prune daily deploy workflow, core snapshot workflow, prune Phase B worker, local backfill runner, core snapshot script.
- Backup: Dropbox backup workflow, initial inventory workflow, backup inventory/sync helper library.
- Integrity: separate `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` and `--history-version`, plus repair/backfill commands that currently emit write/backup/index env vars.
- Index: `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` currently uses `UK_AQ_R2_HISTORY_INDEX_VERSION`. Keep this as an explicit index-builder selector; it is not part of the read/write/backup split removal.

3. Which jobs genuinely needed separate read/write values during migration, and are those still needed?

- They were useful during v2 build/soak:
  - write v2 while API readers stayed v1
  - build v2 backup inventory without switching readers
  - validate v2 integrity while production-like reads stayed on v1
- Under the new operating model, this flexibility is no longer desired for scheduled runtime. Normal jobs should use one active version.
- Manual historical rebuild and manual integrity validation can still accept explicit CLI `--history-version` values. That keeps migration tooling possible without retaining split environment variables as long-term aliases.

4. Which workflows accept `history_version`, `backup_version`, or similar workflow dispatch inputs?

- `.github/workflows/uk_aq_r2_core_snapshot.yml` accepts `history_version`.
- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` accepts `backup_version`.
- `.github/workflows/uk_aq_r2_initial_build_inventory.yml` has no version input and uses vars/env.
- `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` accepts restore inputs, but its active env shown in the inspected section is prefix-based rather than a version selector.
- Scheduler passes `history_version` to core snapshot and `backup_version` to Dropbox backup.

5. Which workflow inputs should be consolidated?

- Replace Dropbox backup input `backup_version` with `history_version`.
- Keep core snapshot input `history_version`, but change default semantics from `v1` to the active canonical env var.
- Consider adding `history_version` to initial inventory only if manual inventory rebuilds need a one-off version override. If added, it should map to `UK_AQ_R2_HISTORY_VERSION` inside that workflow.

6. Should workflow input names also move to one canonical `history_version` input?

Yes. All versioned workflow dispatch inputs should use `history_version`. `backup_version` should be removed after the scheduler and tests move to `history_version`.

7. Which code currently defaults to v1?

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `scripts/backup_r2/lib/inventory.mjs`
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/run_job.ts`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`
- `local/dashboard/server/uk_aq_dashboard_api.py`
- `scripts/dashboard/check_r2_history_read_version.mjs`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` defaults integrity to v1 unless overridden.

8. Which code would break if the three old vars were removed immediately?

- API worker deploys would no longer inject the selected read version into `wrangler.toml`.
- Observations and AQI history API workers would default to v1 instead of current CIC-Test v2.
- Metrics and dashboard APIs would default or report incorrectly.
- Prune daily and backfill would default to v1 writes.
- Core snapshot workflow/script would default to v1 core prefix.
- Backup inventory/sync would default to v1 inventory and state paths.
- Daily task health would stop reporting split backup/write context unless updated.
- Integrity repair commands and wrapper would emit old vars.
- Tests asserting old env names would fail.

9. Which docs/runbooks still tell operators to set separate variables?

Known active docs and plans include:

- `system_docs/uk-aq-r2-history-dropbox-backup.md`
- `system_docs/uk-aq-ingestdb-prune.md`
- `system_docs/uk-aq-r2-history-layout.md`
- `system_docs/uk_aq_scripts.md`
- `workers/uk_aq_observs_history_r2_api_worker/README.md`
- `workers/uk_aq_aqi_history_r2_api_worker/README.md`
- `workers/uk_aq_db_size_metrics_api_worker/README.md`
- `workers/uk_aq_dashboard_online_api_worker/README.md`
- `plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_cic_test_build_validation_runbook.md`
- `plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_cic_test_build_validation_runbook_tracking.md`
- `plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_pollutant_split_plan_and_codex_prompts.md`
- `plans/R2_v2_implementation_plans/uk_aq_history_integrity_v1_v2_plan.md`

10. Which tests assume separate variables?

- `tests/core_snapshot_version_paths.test.mjs`
- `tests/uk_aq_prune_phase_b_paths.test.mjs`
- `tests/uk_aq_r2_history_backup_inventory.test.mjs`
- `tests/workflow_scheduler.test.mjs`
- `tests/uk_aq_db_size_metrics_api_worker.test.mjs`
- `tests/uk_aq_observs_history_r2_api_worker.test.mjs`
- `tests/uk_aq_aqi_history_r2_api_worker.test.mjs`
- `tests/dashboard_storage_coverage_dropbox_version.test.mjs`
- `scripts/uk-aq-history-integrity/tests/test_history_version_paths.py`
- `scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py`
- `scripts/checks/check_dashboard_r2_version_calendar_counts.mjs`
- `scripts/dashboard/check_r2_history_read_version.mjs`

11. Which deploy/prep scripts inject or validate version-specific job inputs?

- `.github/workflows/uk_aq_workflow_scheduler_deploy.yml` validates job keys and injects cron map from `wrangler.toml`.
- `cloudflare/workflow-scheduler/worker.js` stores job inputs.
- `cloudflare/workflow-scheduler/wrangler.toml` maps crons to job keys.
- `.github/workflows/uk_aq_r2_core_snapshot.yml` validates `UK_AQ_R2_HISTORY_WRITE_VERSION`.
- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` validates `UK_AQ_R2_HISTORY_BACKUP_VERSION`.
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml` validates write version.
- API worker deploy workflows inject read version into Worker config/secrets.
- `config/uk_aq_github_env_targets.csv` syncs old version vars.
- `env-vars-master.csv` documents old vars.

12. Which R2 prefix resolvers depend on separate version variables?

- `resolveCoreSnapshotPrefix()` in `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `resolvePhaseBHistoryWritePrefixes()` in `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- top-level history prefix constants/resolution in `workers/uk_aq_backfill_local/run_job.ts`
- `resolveDomainPrefixes()` in `scripts/backup_r2/build_backup_inventory.mjs`
- `resolveBackupVersion()`, `defaultInventoryRelPathForBackupVersion()`, and `defaultStateRelPathForBackupVersion()` in `scripts/backup_r2/lib/inventory.mjs`
- `resolveR2HistoryLayoutConfig()` in `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
- `handleRequest()` path resolution in both history API workers
- `resolveR2HistoryReadVersion()` and Dropbox state path resolution in dashboard direct APIs
- `resolve_history_path_config()` in integrity for check paths
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` via `UK_AQ_R2_HISTORY_INDEX_VERSION`

13. Which Dropbox backup inventory/state paths depend on backup version?

- v1 inventory: `history/_index/backup_inventory_v1.json`
- v2 inventory: `history/_index_v2/backup_inventory_v2.json`
- v1 state: `_ops/checkpoints/r2_history_backup_state_v1.json`
- v2 state: `_ops/checkpoints/r2_history_backup_state_v2.json`

These come from `scripts/backup_r2/lib/inventory.mjs`.

14. Which integrity reports/preflight paths depend on read or integrity version?

- Integrity check paths depend on `--history-version` or `UK_AQ_R2_HISTORY_INTEGRITY_VERSION`.
- Core preflight path uses the selected integrity history version via `resolve_core_history_version_for_mode()`.
- The report includes `site_read_version` from `UK_AQ_R2_HISTORY_READ_VERSION`, currently context only.
- Backfill repair command strings currently emit `UK_AQ_R2_HISTORY_WRITE_VERSION`, `UK_AQ_R2_HISTORY_BACKUP_VERSION`, and `UK_AQ_R2_HISTORY_INDEX_VERSION`. After consolidation they should emit `UK_AQ_R2_HISTORY_VERSION=<v>` for runtime targeting and may continue emitting `UK_AQ_R2_HISTORY_INDEX_VERSION=<v>` for explicit index rebuild targeting.

15. How should `--history-version v1|v2|both` in integrity behave after consolidation?

- `v1`: validate only v1 paths.
- `v2`: validate only v2 paths.
- `both`: validate v1 and v2 as an explicit manual comparison/check mode.
- The default should be reconsidered in implementation. Recommended: default to `UK_AQ_R2_HISTORY_VERSION` for normal active-environment checks, while allowing `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` only as an integrity-specific override if kept. `both` remains CLI/manual only.

16. Should `both` remain only as explicit CLI check mode?

Yes. Do not allow `UK_AQ_R2_HISTORY_VERSION=both`. Scheduler and normal runtime code should reject `both`.

17. How should rollback to v1 work?

- Change `UK_AQ_R2_HISTORY_VERSION=v1` in the active environment.
- Sync env vars/secrets.
- Redeploy affected Workers/services/workflows that bake env into config.
- Scheduler continues dispatching one logical core snapshot and one logical Dropbox backup. Those jobs now operate on v1.
- No scheduler changes are needed for rollback beyond any redeploy needed to pick up env/config.

18. How should manual historical rebuilds work with one active env var?

- Normal rebuilds use `UK_AQ_R2_HISTORY_VERSION`.
- Exceptional rebuilds use explicit CLI `--history-version v1|v2` where the tool already has a manual selector, or a workflow `history_version` input for manual dispatch.
- Manual overrides should not persist as separate environment aliases. They should be one-off CLI/workflow inputs and clearly logged.

19. Safest implementation order?

Use the phased plan below. The key rule is to introduce the canonical resolver with fail-fast guards for old split vars, then remove the old read/write/backup vars and scheduler split dispatch after tests prove the new path. Do not add fallback behavior.

20. Validation commands after each phase?

Listed in each phase. Commands are read-only or local tests unless a later implementation phase explicitly needs deployment.

## Design Options

### Option A: Immediate Hard Cut To `UK_AQ_R2_HISTORY_VERSION`

Replace old read/write/backup env reads with the canonical env var in one change, and fail fast if the old split vars are still present.

Pros:

- Lowest long-term ambiguity.
- Old split selectors cannot silently disagree.
- Scheduler can be simplified immediately.
- No silent fallback to v1.
- Egress impact: neutral in normal operation; could reduce duplicate scheduled R2/Dropbox work by stopping automatic v1+v2 dispatch.
- Database-size impact: neutral; no schema/table data changes.

Cons:

- Large blast radius.
- Many tests and docs change at once.
- Any missed old-var read defaults to v1 and could cause wrong-path operations.
- Requires careful deploy ordering so Workers and GitHub env vars move together.

### Option B: Two-Step Fail-Fast Bridge, Then Cleanup

Add canonical resolver first. It reads only `UK_AQ_R2_HISTORY_VERSION` and rejects old split variables if present. Then remove any remaining old-var references in the next phase.

Pros:

- Safer sequencing.
- Easier to prove each subsystem before removing old vars.
- Can update tests by subsystem.
- No fallback ambiguity.
- Egress impact: neutral during guard rollout; final scheduler cleanup reduces duplicate scheduled R2/Dropbox reads/writes caused by v1+v2 dispatch.
- Database-size impact: neutral.

Cons:

- More phases and more temporary code.
- Guard code must not become long-term compatibility.

### Option C: Keep Old Vars As Permanent Aliases

Add `UK_AQ_R2_HISTORY_VERSION` but keep old read/write/backup vars as supported aliases.

Pros:

- Lowest short-term deploy risk.
- Fewer immediate operator changes.
- Egress impact: no direct improvement unless scheduler is also fixed.
- Database-size impact: neutral.

Cons:

- Fails the desired end state.
- Keeps the exact ambiguity that caused the recent issues.
- Operators can still create read/write/backup divergence.

Recommendation: Option A with fail-fast guards. The implementation should add the canonical resolver, immediately reject `UK_AQ_R2_HISTORY_READ_VERSION`, `UK_AQ_R2_HISTORY_WRITE_VERSION`, and `UK_AQ_R2_HISTORY_BACKUP_VERSION` when they are present, update the scheduler to dispatch one active logical job, and remove the old split variables from code, workflows, env maps, and docs. Keep `UK_AQ_R2_HISTORY_INDEX_VERSION` and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` as explicit selectors. The key cost win is not lower Supabase egress; it is avoiding duplicate scheduled R2/Dropbox work and duplicate Worker/GitHub workflow volume. Database size should not change.

## Implementation Phases

### Phase 0: Baseline Audit And No-Write Validation

Goal: Confirm the exact active references before edits.

Changes:

- No code changes.
- Record current old-var references.
- Confirm `.env` has `v2` for all three old selectors.
- Confirm standard crons should be `04:15` and `04:35` UTC.

Validation commands:

```bash
git status --short
grep -RIn --exclude-dir=.git --exclude-dir=archive --exclude-dir=node_modules --exclude-dir=.venv -E 'UK_AQ_R2_HISTORY_(READ|WRITE|BACKUP|INDEX|INTEGRITY)?_?VERSION|backup_version|history_version' .
python3 --version
node --version
```

Codex prompt:

```text
Read AGENTS.md and the R2 single-version plan. Do not implement changes. Re-run the baseline grep for all R2 history version selectors, excluding archive, node_modules, logs, artifacts, and .venv. Summarize active code, workflow, docs, env map, and test references. Do not touch LIVE and do not run any R2, Dropbox, Supabase, dispatch, backfill, or deploy operation.
```

### Phase 1: Add Canonical Resolver With Deprecated Var Guard

Goal: Introduce a single runtime resolver and fail fast if old split read/write/backup vars are present.

Changes:

- Before editing, archive each to-be-changed active file once under `archive/2026-06-21_r2_history_single_version_var/` if it has not already been archived for this implementation.
- Add a shared JS resolver where practical, for example `workers/shared/uk_aq_r2_history_version.mjs`.
- Add equivalent small resolvers for Python/Deno code where shared JS cannot be imported.
- Resolver contract:
  - primary: `UK_AQ_R2_HISTORY_VERSION`
  - accepted: `v1|v2`
  - reject: missing in active runtime and workflow code paths; do not silently default to v1
  - deprecated var guard: if `UK_AQ_R2_HISTORY_READ_VERSION`, `UK_AQ_R2_HISTORY_WRITE_VERSION`, or `UK_AQ_R2_HISTORY_BACKUP_VERSION` is present, fail fast with a clear error telling the operator to use `UK_AQ_R2_HISTORY_VERSION`
  - no fallback: do not silently fall back to old vars
- Preserve `--history-version` CLI overrides for manual tools.
- Keep `UK_AQ_R2_HISTORY_INDEX_VERSION` and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` as explicit selectors.

Files likely touched:

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `scripts/backup_r2/lib/inventory.mjs`
- `scripts/backup_r2/build_backup_inventory.mjs`
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/run_job.ts`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`
- `local/dashboard/server/uk_aq_dashboard_api.py`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
- `scripts/dashboard/check_r2_history_read_version.mjs`
- `scripts/report_daily_task_health.mjs`

Validation commands:

```bash
npm test -- --test-reporter=spec tests/core_snapshot_version_paths.test.mjs
npm test -- --test-reporter=spec tests/uk_aq_r2_history_backup_inventory.test.mjs
npm test -- --test-reporter=spec tests/uk_aq_prune_phase_b_paths.test.mjs
npm test -- --test-reporter=spec tests/uk_aq_observs_history_r2_api_worker.test.mjs
npm test -- --test-reporter=spec tests/uk_aq_aqi_history_r2_api_worker.test.mjs
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests
```

Codex prompt:

```text
Implement Phase 1 from plans/R2_v2_implementation_plans/uk_aq_r2_history_single_version_var_plan.md. Add canonical UK_AQ_R2_HISTORY_VERSION resolution and fail fast if UK_AQ_R2_HISTORY_READ_VERSION, UK_AQ_R2_HISTORY_WRITE_VERSION, or UK_AQ_R2_HISTORY_BACKUP_VERSION is present. Do not add fallback to old vars. Keep UK_AQ_R2_HISTORY_INDEX_VERSION and UK_AQ_R2_HISTORY_INTEGRITY_VERSION as explicit selectors. Do not deploy. Do not run R2, Dropbox, Supabase, dispatch, backfill, or source-download operations. Update focused tests only.
```

### Phase 2: Consolidate Workflow Inputs And Scheduler Jobs

Goal: Stop automatic v1+v2 dispatch and standardize workflow input names.

Changes:

- Before editing, archive each to-be-changed active file once under the implementation archive directory if it has not already been archived for this implementation.
- In `uk_aq_r2_core_snapshot.yml`, keep workflow input `history_version`; set `UK_AQ_R2_HISTORY_VERSION` from input or repo var.
- In `uk_aq_r2_history_dropbox_backup.yml`, replace `backup_version` input with `history_version`; set `UK_AQ_R2_HISTORY_VERSION` from input or repo var.
- In `uk_aq_r2_initial_build_inventory.yml`, use `UK_AQ_R2_HISTORY_VERSION`; optionally add `history_version` input for manual rebuilds.
- In scheduler:
  - Replace `uk_aq_r2_core_snapshot_v1` and `_v2` with one `uk_aq_r2_core_snapshot`.
  - Replace `uk_aq_r2_history_dropbox_backup_v1` and `_v2` with one `uk_aq_r2_history_dropbox_backup`.
  - Remove baked-in v1/v2 scheduler job variants from the Worker source.
  - For normal scheduled core snapshot and Dropbox backup dispatches, pass one `history_version` value derived from the active deploy/config value `UK_AQ_R2_HISTORY_VERSION`. Do not create v1/v2 job variants.
  - Set standard crons to `04:15` and `04:35` UTC.
- Update `tests/workflow_scheduler.test.mjs`.
- Update `cloudflare/workflow-scheduler/README.md`.

Validation commands:

```bash
npm test -- --test-reporter=spec tests/workflow_scheduler.test.mjs
python3 - <<'PY'
from pathlib import Path
txt = Path('cloudflare/workflow-scheduler/wrangler.toml').read_text()
assert '15 4 * * *' in txt
assert '35 4 * * *' in txt
assert '_v1' not in txt
assert '_v2' not in txt
print('scheduler cron shape ok')
PY
```

Codex prompt:

```text
Implement Phase 2 from the R2 single-version plan. Consolidate scheduler jobs so core snapshot and Dropbox backup each dispatch once at the standard UTC times 04:15 and 04:35. Replace Dropbox backup workflow_dispatch input backup_version with history_version. Do not deploy or dispatch workflows. Update scheduler tests and docs only as needed.
```

### Phase 3: Update Env Maps And Local Env Shape

Goal: Make `UK_AQ_R2_HISTORY_VERSION` the only active runtime version variable in ops config.

Changes:

- Before editing, archive each to-be-changed active file once under the implementation archive directory if it has not already been archived for this implementation.
- `.env`: replace old three selectors with `UK_AQ_R2_HISTORY_VERSION=v2`.
- `env-vars-master.csv`: add canonical row; remove old read/write/backup selector rows or mark them for removal in the implementation change. Keep `UK_AQ_R2_HISTORY_INDEX_VERSION`.
- `config/uk_aq_github_env_targets.csv`: add `UK_AQ_R2_HISTORY_VERSION`; remove old read/write/backup selector targets. Keep `UK_AQ_R2_HISTORY_INDEX_VERSION`.
- `scripts/uk_aq_sync_github_secrets.sh`: update only if it has any explicit handling tied to the removed env vars.
- Keep prefix variables for v1/v2 layouts unless a separate path-prefix simplification plan is approved.

Validation commands:

```bash
grep -n 'UK_AQ_R2_HISTORY_VERSION' .env env-vars-master.csv config/uk_aq_github_env_targets.csv
grep -nE 'UK_AQ_R2_HISTORY_(READ|WRITE|BACKUP)_VERSION' .env env-vars-master.csv config/uk_aq_github_env_targets.csv || true
```

Codex prompt:

```text
Implement Phase 3 from the R2 single-version plan. Update ops env documentation and GitHub env target maps to use UK_AQ_R2_HISTORY_VERSION as the only runtime history version selector. Do not sync secrets, deploy, dispatch workflows, or touch LIVE. Leave Test Value and Live Value columns blank in env-vars-master.csv.
```

### Phase 4: Remove Remaining Old Runtime Var References

Goal: Remove any remaining old read/write/backup references after the fail-fast resolver has proved active paths are clean.

Changes:

- Before editing, archive each to-be-changed active file once under the implementation archive directory if it has not already been archived for this implementation.
- Remove any remaining references to:
  - `UK_AQ_R2_HISTORY_READ_VERSION`
  - `UK_AQ_R2_HISTORY_WRITE_VERSION`
  - `UK_AQ_R2_HISTORY_BACKUP_VERSION`
- Error messages and docs should name `UK_AQ_R2_HISTORY_VERSION`.
- Update integrity repair/backfill command generation to emit `UK_AQ_R2_HISTORY_VERSION=<v>` and use CLI `--history-version` for manual override where needed.
- Keep `UK_AQ_R2_HISTORY_INDEX_VERSION` and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION`.

Validation commands:

```bash
grep -RIn --exclude-dir=.git --exclude-dir=archive --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=logs --exclude-dir=artifacts -E 'UK_AQ_R2_HISTORY_(READ|WRITE|BACKUP)_VERSION' . || true
npm test -- --test-reporter=spec tests/core_snapshot_version_paths.test.mjs tests/uk_aq_prune_phase_b_paths.test.mjs tests/uk_aq_r2_history_backup_inventory.test.mjs tests/workflow_scheduler.test.mjs
npm test -- --test-reporter=spec tests/uk_aq_db_size_metrics_api_worker.test.mjs tests/dashboard_storage_coverage_dropbox_version.test.mjs tests/uk_aq_observs_history_r2_api_worker.test.mjs tests/uk_aq_aqi_history_r2_api_worker.test.mjs
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests
```

Codex prompt:

```text
Implement Phase 4 from the R2 single-version plan. Remove remaining references to UK_AQ_R2_HISTORY_READ_VERSION, UK_AQ_R2_HISTORY_WRITE_VERSION, and UK_AQ_R2_HISTORY_BACKUP_VERSION. Keep UK_AQ_R2_HISTORY_INDEX_VERSION and UK_AQ_R2_HISTORY_INTEGRITY_VERSION. Keep manual --history-version v1|v2|both for integrity, with both as explicit CLI-only mode. Do not deploy or run external data operations.
```

### Phase 5: Update Docs And Runbooks

Goal: Make operator instructions match the one-active-version model.

Changes:

- Before editing, archive each to-be-changed active file once under the implementation archive directory if it has not already been archived for this implementation.
- Update docs listed in Required Analysis Answer 9.
- Replace split examples with:

```bash
UK_AQ_R2_HISTORY_VERSION=v2
```

- Rollback examples should use:

```bash
UK_AQ_R2_HISTORY_VERSION=v1
```

- Scheduler docs must say one logical job is dispatched at 04:15 and 04:35 UTC.
- Dropbox backup docs must describe inventory/state path selection from the active history version.
- Integrity docs must state `both` is CLI/manual only.

Validation commands:

```bash
grep -RIn --exclude-dir=.git --exclude-dir=archive --exclude-dir=node_modules --exclude-dir=.venv -E 'UK_AQ_R2_HISTORY_(READ|WRITE|BACKUP)_VERSION|backup_version' README.md docs system_docs plans/R2_v2_implementation_plans workers/*/README.md scripts/uk-aq-history-integrity/env || true
grep -RIn 'UK_AQ_R2_HISTORY_VERSION' README.md docs system_docs plans/R2_v2_implementation_plans workers/*/README.md scripts/uk-aq-history-integrity/env
```

Codex prompt:

```text
Implement Phase 5 from the R2 single-version plan. Update active operator docs and runbooks from split R2 history read/write/backup variables to UK_AQ_R2_HISTORY_VERSION. Keep UK_AQ_R2_HISTORY_INDEX_VERSION as an explicit index-builder selector and keep explicit manual integrity --history-version v1|v2|both documented as a check mode only. Do not modify archive files and do not touch LIVE.
```

### Phase 6: Full Local Test Sweep

Goal: Prove local contracts after consolidation.

Validation commands:

```bash
npm test
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests
python3 -m unittest discover -s tests || true
```

Use the Python `tests/` command only if Python tests are present and configured. Do not run commands that contact R2, Dropbox, Supabase, sources, GitHub dispatch, or Cloudflare deploy.

Codex prompt:

```text
Run the Phase 6 local validation sweep from the R2 single-version plan. Do not run any external write/read operation against R2, Dropbox, Supabase, source APIs, GitHub Actions dispatch, or Cloudflare. Report failures with file/test names and propose the smallest fixes.
```

### Phase 7: Apply/Deploy Runbook For Later Operator Use

This phase is not part of the current analysis-only task. It is the future deployment checklist after code is merged.

Required commands/actions, to be run only when explicitly approved:

1. Sync GitHub vars/secrets from ops env after `UK_AQ_R2_HISTORY_VERSION` is present and old vars are removed.
2. Redeploy affected Workers/services:
   - observations history R2 API Worker
   - AQI history R2 API Worker
   - DB size metrics API Worker
   - ops dashboard API Worker
   - prune daily Cloud Run service
   - workflow scheduler Worker
3. Manually inspect scheduler deploy logs to confirm only one core snapshot job and one Dropbox backup job exist.
4. Let the next standard `04:15` and `04:35` UTC jobs run, or run a manual dry-run dispatch only if explicitly approved.

No deployment command is included here because deployment was explicitly out of scope for this task.

## Cross-Repo Notes

- Ingest repo: no active source references to the old R2 history version env vars were found during the narrowed scan.
- Webpage repo: no active source references to the old R2 history version env vars were found during the narrowed scan.
- Schema repo: no active env-var references were found. However, non-archive SQL still has hard-coded `history/v1` regexes in `schemas/ingest_db/uk_aq_rpc.sql` for R2 history window/backup-days logic. That is separate from env var consolidation but should be reviewed if runtime dashboard/history-window behavior must become v2-aware.
- Dropbox app-folder workspace contains generated integrity logs/reports with old variable names. These are historical outputs, not source-of-truth code; do not edit them.

## Egress And Database-Size Assessment

- Supabase billable egress: no direct endpoint-response egress reduction is claimed from this env-var consolidation. Any read-path egress changes must be measured through endpoint response metrics, not write/upload payload metrics.
- R2/Cloudflare cost: final scheduler consolidation should reduce duplicate scheduled Worker/GitHub workflow volume and avoid redundant v1+v2 R2/Dropbox backup work. R2 cost impact is mostly operation-count related, not bandwidth egress.
- Dropbox/R2 backup cost: stopping automatic v1+v2 backup dispatch should reduce duplicate inventory/sync scans and Dropbox operation pressure for normal days.
- Database size: neutral. This plan does not add tables, indexes, or stored observations and does not change raw-history granularity.
- HistoryDB granularity: unchanged. No rollups, downsampling, or aggregation are proposed.

## Final Desired State Checklist

- `UK_AQ_R2_HISTORY_VERSION=v2` is the only active runtime selector.
- Old read/write/backup version env vars are removed from active code, workflows, config maps, and docs.
- `UK_AQ_R2_HISTORY_INDEX_VERSION` and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` remain explicit selectors.
- Scheduler dispatches:
  - one core snapshot workflow at `04:15` UTC
  - one Dropbox backup workflow at `04:35` UTC
- Both scheduled jobs use the active history version.
- Manual workflow inputs use `history_version`.
- `backup_version` is removed from long-term workflow inputs.
- Integrity keeps `--history-version both` only as explicit manual validation.
- Rollback is a single env change to `UK_AQ_R2_HISTORY_VERSION=v1` plus redeploy/sync of affected services.
