# TEST-to-LIVE promotion and deferred rollout: Ops stage 1

PR #126 now contains **22 workflow changes and four non-authoritative security documents** in TEST Ops only. It does not include the 12 deployment-affecting runtime changes from the original full batch. Each of those 12 files is restored byte-for-byte to current main `483d333eb0a334dc40a9a8be35ff3014ccffa27c`. They are deferred, not abandoned: their complete patched contents remain at original security commit `5da944d1b0660c8cbe818afcecaebb5b2e350cbd`, which remains an ancestor of the corrective commit. No history rewrite or archive copy is required.

The file CSV contains only these 26 current PR paths. The promotion assessment contains the separate 12-file deferred manifest, original blob identities and pinned complete-file links. Original cross-repository findings and full-batch reports remain historical evidence at [5da944d1b0660c8cbe818afcecaebb5b2e350cbd](https://github.com/TEST-uk-aq/uk-aq-ops/commit/5da944d1b0660c8cbe818afcecaebb5b2e350cbd); they are not claims about the reduced PR's scope.

## Current first-stage candidates

| Retained workflow | Current main selection | Stage 1 selection |
|---|---|---|
| `.github/workflows/uk_aq_chart_metrics.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` | implicit runner PATH | 24.22.1 |
| `.github/workflows/uk_aq_dropbox_prune_raw.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_consumer_readonly.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_first_operation_preflight.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_reader_readiness.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_stage_d_readiness.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_r2_readonly_check.yml` | implicit runner PATH | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_bundle_r2_transport.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_intents_readonly.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_observs_partition_maintenance.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_prune_daily.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_core_snapshot.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_inventory_generation_migration.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_supabase_db_dump_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_v3_reader_version_urls.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_who_2021_daily.yml` | 24 | 24.22.1 |

No LIVE promotion is recommended by this PR. TEST operational evidence, complete-file comparison and operator approval remain separate. Never overwrite newer LIVE code with an older TEST version or copy TEST archives. Environment values must remain externally configured; do not introduce a separate LIVE implementation or cross-environment fallback.

Retained complete-file blockers include the existing literal TEST identity and JSONgen wiring in Prune; partition-generation mapping/validation differences; newer restore verification-overlay support and its dependency closure; LIVE-labelled inventory migration; TEST-only JSONgen/reconciliation/version tools; and independent review of each file's application/lock/configuration dependencies. The exact runtime pin alone does not make those complete files promotable.

Deferred deployment files retain the dashboard direct/coordinator overlap, scheduler migration/secret effects, GCP secret cleanup/reference effects, cache activation behavior and AQI generation issue. Those are later-stage prerequisites, not fixed or deployed by stage 1.

The original full inventory also includes Ingest/Sensor.Community, both old LIVE Docker selections, Deno, npm/SheetJS/Wrangler graphs, other repositories' major-only selections and shared-host runtime evidence. Sensor promotion still requires its complete Docker/context/module/deploy set and review of existing metrics/environment defaults. Those findings remain open outside this reduced Ops PR. The inactive Ops root Dockerfile is unchanged and requires patch enforcement before any supported reuse. Optional Windows/ia32 tooling and embedded runner patches remain separate evidence/remediation items.

## Deferred complete-file manifest: excluded from the current PR diff

The following 12 files are identical to main `483d333eb0a334dc40a9a8be35ff3014ccffa27c` in the reduced branch. Each link points to the complete **deferred patched version** at `5da944d1b0660c8cbe818afcecaebb5b2e350cbd`, not the reduced branch. Main and original blob IDs provide exact recovery/provenance checks. Reapply only a separately reviewed file/delta onto then-current TEST main; never restore the whole old tree.

| Deferred workflow | Current-main blob restored | Original patched blob retained in Git | Original change |
|---|---|---|---|
| [.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml) | `c9652c65d3e40cb7451419f68b2752a3ea7e2297` | `3cbe50f6c616380784de25c962097a1fcd0d36b4` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_blog_feed_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_blog_feed_worker_deploy.yml) | `db51936b24cffa187b4720fab71420ec599bc677` | `1414fc7ca013f81818caf3611cebc29894f89d2b` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_cache_proxy_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_cache_proxy_deploy.yml) | `4059117efa452cf79e59f40509f4075819e03155` | `63a268d466ed8bbacc592890c0bacb54ca967f4c` | 22 -> exact 24.22.1 |
| [.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml) | `8515ef6cddab3ca9d260aed2f780db0ac19802a4` | `79660e0e19feaac3b2102ba8f8c1f8f874e24810` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml) | `0007e38b614f29958dbd7a6baa649d2f4d81a513` | `3bc03ebf3f6a4011d1098cea3665eb4ad59a48b0` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml) | `e2895dd96c61610ead6e8e474c3319cf9812ad49` | `8d68575116a1c690c61453318910c483179f5a4b` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml) | `15f2a47c1ce52039a57ac393e2f324f2a934e1dd` | `27022df677573833a099f3d75124398a63712005` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml) | `6625406b1b786c7221ecb838a706e883d1d7b354` | `0add5796cb621f08ad25c03be60814ea0a3b947f` | 22 -> exact 24.22.1 |
| [.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml) | `b48dac58e50c13e56f6a00396b63206a1fb3a12c` | `19e88245f5bd2103f2ec084953528526e4d24658` | 22 -> exact 24.22.1 |
| [.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml) | `52d896246559428b36447caeb9d7a933104d7e4c` | `7cc2b861d8516c632b45a4bac9fbe33801e2b417` | 24 -> exact 24.22.1 |
| [.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml) | `ec876c6835929680f18c8d530d2e9e7f19c2649f` | `80647a2ef55acc8a1ed46ecd92d18b4853ac138b` | add explicit pinned setup-node step for 24.22.1 |
| [.github/workflows/uk_aq_station_history_deploy.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/.github/workflows/uk_aq_station_history_deploy.yml) | `c3fcbea1ae88483a5596e1bc48d679202731b725` | `abee88493955cb139fc703335672edb367e23486` | 22 -> exact 24.22.1 |

For any manifest path, the original complete file and bounded runtime diff can be inspected without changing a checkout:

```bash
git show 5da944d1b0660c8cbe818afcecaebb5b2e350cbd:<workflow-path-from-table>
git diff 483d333eb0a334dc40a9a8be35ff3014ccffa27c 5da944d1b0660c8cbe818afcecaebb5b2e350cbd -- <workflow-path-from-table>
```

The path placeholders refer to the exact manifest paths above; these are inspection examples, not operational dispatches. Do not include deferred files in the current PR's modified-file inventory.

## Remaining rollout order

The 12 deferred complete workflow changes must be reapplied only in later independently reviewed TEST PRs. Recommended next deployment-specific PR: the Latest Snapshot R2 API workflow pin alone, after confirming its existing TEST target, authentication, bucket and rollback evidence. Its reader acceptance precedes the later Cloud Run builder rollout. Do not merge the original full batch again or copy the whole old tree over newer main.

| Proposed group | Deferred files | Separate prerequisites / order |
|---|---|---|
| Independent readers and metrics | `uk_aq_latest_snapshot_r2_api_worker_deploy.yml`, `uk_aq_postcode_lookup_r2_api_worker_deploy.yml`, `uk_aq_db_r2_metrics_api_worker_deploy.yml`, `uk_aq_blog_feed_worker_deploy.yml` | One mutating merge at a time; verify existing TEST account/resource/bucket/KV identities and rollback evidence. Metrics is a dashboard prerequisite where its service binding is enabled. |
| AQI legacy deployment | `uk_aq_aqi_history_r2_api_worker_deploy.yml` | Resolve the v1/v2-only validation versus configured v3 history authority under the current AQI-retirement contract. Do not change global history generation merely to pass validation. |
| Observations provider | `uk_aq_observs_history_r2_api_worker_deploy.yml` | Its child-workflow path triggers the coordinator even without a direct push trigger. Provider acceptance must precede dependent consumers. |
| Dashboard API, then Pages | `uk_aq_ops_dashboard_api_worker_deploy.yml`, then `uk_aq_ops_dashboard_pages_deploy.yml` | Before the API rollout, use a separate PR for its runtime pin with narrowly reviewed duplicate-trigger correction so automatic API deployment is owned by the existing coordinator, retaining reusable/manual entry points. This corrective merge itself can deploy the API and needs separate authorization. Preserve provider-before-consumer ordering; Pages follows accepted API behavior. |
| Private station history, then cache | `uk_aq_station_history_deploy.yml`, then `uk_aq_cache_proxy_deploy.yml` | Verify stable observations service and binding. Normal cache deployment sets compressed-chart activation false; verify current state or independently correct preservation before rollout. |
| Latest Snapshot builder | `uk_aq_latest_snapshot_cloud_run_deploy.yml` | R2 API accepted first. GCP secret preflight must prove the intended effect: helper can destroy old secret versions and update other services' numeric references. Verify full consumer inventory independently, revision/rollback secret usability, singleton/timeout/subscription safety and scheduler state. Node here is tooling; service remains Deno 2.7.13. |
| Ops scheduler | `uk_aq_cloudflare_scheduler_ops_deploy.yml` | Verify actual D1 identity/schema/migration ledger, no pending migration, recovery evidence, current activation and matching secrets. Migration 0003 rebuilds tables and is not independently repeatable. Observe existing due work without forcing operations or syncing canonical activation values. |

Existing manual dispatch controls do not suppress future merge-triggered deployments. No later-stage correction, deployment, scheduler change or dependency upgrade is implemented in stage 1.

## Required evidence and recovery

Functional acceptance remains outstanding. Merging workflow definitions changes which Node version later **existing external schedules** or separately authorized manual operations use. It does not authorize a new execution. Preserve current runtime scheduler/Prune/JSONgen activation states; canonical jobs.toml is not proof of currently applied D1 state.

- On each next already-authorized normal TEST run, retain source SHA/run URL, setup-node's 24.22.1 log, executable/tool versions when available and independent embedded-action runtime evidence.
- For existing backup, retention, partition, core, WHO and chart tasks, retain normal task-health/report outputs and unchanged lock, safety, scientific and failure semantics. Do not run destructive paths just for version evidence.
- Keep paused Prune and independently gated JSONgen paths paused. JSONgen transport/deployment/version-upload workflows can mutate resources despite manual or diagnostic naming; do not blanket-dispatch them.
- The retained inventory-generation migration still contains LIVE-labelled targeting. Do not use it for TEST acceptance or silently change its target. Generic restore remains limited recovery authority.
- One historical PR config-validation run at the original full head reported Node 24.22.1, runner 2.338.0 and remote_sync=false ([run 40127332867](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40127332867)). It is installer/validation evidence, not acceptance of this new head, deployed images or operational jobs.

Rollback is a reviewed TEST forward correction or revert that preserves a supported patched runtime; do not downgrade operational runtimes simply to restore an older workflow definition. Reverting source cannot undo any later data writes, secret changes, deployments or migrations. No external rollback action is needed for this rescope itself because none is performed. The deferred originals remain available in immutable Git history.

No application source, dependency manifest/lock, schema, environment setting or authoritative system_docs contract is changed. The observation-history writer and its existing test remain exactly current main. No code-style archive is needed for these ordinary workflow/documentation edits. Documentation handover: record stage 1's runtime scope and acceptance evidence in Chat mode if authoritative deployment documentation needs updating; this PR does not edit it.

Original historical complete-file TEST/LIVE comparisons, Sensor supporting set and original snapshot SHAs are preserved in the [full assessment at 5da944d1b0660c8cbe818afcecaebb5b2e350cbd](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/docs/security/2026-10-24-node-promotion-readiness.md). They are historical evidence, not a refreshed LIVE source/deployment claim. Recompare current LIVE read-only before any separately authorized promotion. The merged 24 October software inventory remains in TEST System Docs PR #3 and its plans report/CSV. No inventory finding is closed merely by this rescope.
