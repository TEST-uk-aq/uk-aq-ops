# Node.js October 2026 security: Ops stage 1

PR #126 now contains **22 workflow changes and four non-authoritative security documents** in TEST Ops only. It does not include the 12 deployment-affecting runtime changes from the original full batch. Each of those 12 files is restored byte-for-byte to current main `483d333eb0a334dc40a9a8be35ff3014ccffa27c`. They are deferred, not abandoned: their complete patched contents remain at original security commit `5da944d1b0660c8cbe818afcecaebb5b2e350cbd`, which remains an ancestor of the corrective commit. No history rewrite or archive copy is required.

The file CSV contains only these 26 current PR paths. The promotion assessment contains the separate 12-file deferred manifest, original blob identities and pinned complete-file links. Original cross-repository findings and full-batch reports remain historical evidence at [5da944d1b0660c8cbe818afcecaebb5b2e350cbd](https://github.com/TEST-uk-aq/uk-aq-ops/commit/5da944d1b0660c8cbe818afcecaebb5b2e350cbd); they are not claims about the reduced PR's scope.

## Runtime enforcement

All 22 retained workflow runtime selections are exact **Node.js 24.22.1**. Existing explicit 22/24 selections are pinned to 24.22.1; the two retained formerly implicit jobs receive the original setup-node steps in scheduler config validation and JSONgen R2 read-only checking. Those new steps use verified actions/setup-node v7.0.0 commit `820762786026740c76f36085b0efc47a31fe5020` with automatic package-manager caching disabled. Other action references and existing cache settings remain unchanged.

Exact setup-node resolution fails rather than silently selecting an older patch. Future security releases require a reviewed coordinated pin update. setup-node controls the job's application/tooling Node, not the embedded Node binary used by JavaScript Actions. Referenced action declarations already use node24; actual runner-bundled patch identity still needs independent runtime evidence. Do not claim that the deferred deployment jobs or all repositories now enforce the patch floor.

## Retained workflows

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

## Merge behavior

For an isolated merge of the revised PR against the checked main, exactly two automatic workflow definitions match:

| Workflow | Trigger match | Executed work | Skipped work / mutations |
|---|---|---|---|
| `.github/workflows/codeql-noarchive.yml` | `push` to `main`, `.github/workflows/**` matches retained YAML changes | Checkout and CodeQL analysis for Actions, JavaScript/TypeScript and Python; GitHub security-analysis uploads | No cloud deployment or operational data job. Workflow/ref concurrency cancels older matching analysis. |
| `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` | Its changed workflow path matches `push` to `main` (also PR validation) | Checkout, patched Node, Python, local jobs.toml validation/payload generation, push-range comparison and validation-only report | `jobs.toml` is unchanged, so `remote_sync=false`. Credential checks, remote D1 schema wait, job sync and remote verification remain skipped. Ref-scoped concurrency retains cancellation. |

No deployment workflow or the history/dashboard coordinator matches the revised changed-path set. No Cloudflare Worker, Cloud Run or Pages deployment, D1 migration, secret synchronization, route/IAM change or other remote infrastructure mutation is initiated by this isolated merge. This conclusion depends on the exact checked diff: recheck after any additional file or main change. Repository/workflow availability and existing platform conditions still govern actual check execution.

Manual dispatch of scheduler config sync is different: it sets `remote_sync=true` and can change D1 job activation/configuration. Do not dispatch it merely to collect Node evidence. No triggers, job conditions, permissions, inputs, environment references or concurrency controls are removed or disabled to achieve this scope.

## Acceptance and safeguards

Functional acceptance remains outstanding. Merging workflow definitions changes which Node version later **existing external schedules** or separately authorized manual operations use. It does not authorize a new execution. Preserve current runtime scheduler/Prune/JSONgen activation states; canonical jobs.toml is not proof of currently applied D1 state.

- On each next already-authorized normal TEST run, retain source SHA/run URL, setup-node's 24.22.1 log, executable/tool versions when available and independent embedded-action runtime evidence.
- For existing backup, retention, partition, core, WHO and chart tasks, retain normal task-health/report outputs and unchanged lock, safety, scientific and failure semantics. Do not run destructive paths just for version evidence.
- Keep paused Prune and independently gated JSONgen paths paused. JSONgen transport/deployment/version-upload workflows can mutate resources despite manual or diagnostic naming; do not blanket-dispatch them.
- The retained inventory-generation migration still contains LIVE-labelled targeting. Do not use it for TEST acceptance or silently change its target. Generic restore remains limited recovery authority.
- One historical PR config-validation run at the original full head reported Node 24.22.1, runner 2.338.0 and remote_sync=false ([run 40127332867](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40127332867)). It is installer/validation evidence, not acceptance of this new head, deployed images or operational jobs.

## Recovery and handover

Rollback is a reviewed TEST forward correction or revert that preserves a supported patched runtime; do not downgrade operational runtimes simply to restore an older workflow definition. Reverting source cannot undo any later data writes, secret changes, deployments or migrations. No external rollback action is needed for this rescope itself because none is performed. The deferred originals remain available in immutable Git history.

No application source, dependency manifest/lock, schema, environment setting or authoritative system_docs contract is changed. The observation-history writer and its existing test remain exactly current main. No code-style archive is needed for these ordinary workflow/documentation edits. Documentation handover: record stage 1's runtime scope and acceptance evidence in Chat mode if authoritative deployment documentation needs updating; this PR does not edit it.
