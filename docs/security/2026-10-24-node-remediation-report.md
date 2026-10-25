# Node.js October 2026 TEST remediation: stage 1 report

## Post-merge security rollout status (25 October 2026)

This dated addendum updates the **deployment/acceptance status** of the historical stage-1 report below. It does not rewrite the original PR #126 diff or its 12-file deferred manifest.

| TEST batch | GitHub evidence | Verified scope and outstanding work |
|---|---|---|
| Ingest PR [#17](https://github.com/TEST-uk-aq/uk-aq-ingest/pull/17) | Merged at [`511ed605697c822fc0d6928838a491802c9a7308`](https://github.com/TEST-uk-aq/uk-aq-ingest/commit/511ed605697c822fc0d6928838a491802c9a7308); [Sensor.Community Cloud Run run 40114963676](https://github.com/TEST-uk-aq/uk-aq-ingest/actions/runs/40114963676) successful | Container build log reports Linux x64 **Node 24.22.1**, new Cloud Run revision `uk-aq-scomm-ingest-00014-gxf` received 100% traffic at deployment; independent subsequent normal ingestion acceptance remains unverified. |
| Ops PR [#126](https://github.com/TEST-uk-aq/uk-aq-ops/pull/126) | Merged at [`c5fcd85b39bbc516bd748c2c4187549923a458e4`](https://github.com/TEST-uk-aq/uk-aq-ops/commit/c5fcd85b39bbc516bd748c2c4187549923a458e4); [scheduler config run 40138570719](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40138570719) successful | 23 TEST workflow runtime selections pinned to **24.22.1**. The merge-triggered scheduler job was validation-only; routine scheduled/manual operational workflows are not thereby fully accepted. |
| Ops PR [#129](https://github.com/TEST-uk-aq/uk-aq-ops/pull/129), Latest Snapshot R2 API | Merged at [`d88b54f0c4678269b5404996b598a4e928444ceb`](https://github.com/TEST-uk-aq/uk-aq-ops/commit/d88b54f0c4678269b5404996b598a4e928444ceb); [deployment run 40141259040](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40141259040) successful | Deployer installed and used **Node 24.22.1**; Cloudflare TEST Worker version **21** (`8ca1821c-ab63-4508-8a83-13254cbc7419`) deployed at 100% traffic. R2 binding remained `uk-aq-history-cic-test`, required secret binding present. Retained pre-change version **18** (`0e2de28e-ab48-48ce-999b-ea04719a764a`) is a recovery reference. An operator-authenticated post-deployment finite Latest Snapshot request returned HTTP **200**, PM2.5 `3h`, `network_group=all`, `count=190` and `data.length=190`; visible Hex Map readings rendered. This is **bounded real TEST operational acceptance** of the deployed API, not blanket acceptance of all windows, headers or builders. |

**Remaining Ops deployment-specific batch:** **11** workflows remain from the original 12-file deferred set after the completed Latest Snapshot R2 API workflow. **Postcode Lookup cross-environment safety correction (operator clarification, 25 October 2026):** The Postcode Lookup Worker belongs to the separate `chronicillnesschannel.co.uk` Cloudflare account, **not** the connected `sleepercar.co.uk` account. The operator confirms that this one Worker serves **both TEST and LIVE**. The earlier absence from the `sleepercar.co.uk` Worker list was therefore expected and must not be interpreted as a missing resource or an instruction to create it there. That other account's actual deployment, bindings, permissions, routing and versions have not been independently inspected here. **Do not merge or dispatch the TEST Postcode Lookup deployment workflow** until its effective account/Worker/bucket/secret target is verified and shared TEST/LIVE impact is explicitly approved. An automatic merge deployment or rollback of the shared Worker could affect LIVE, violating the ordinary TEST-only isolation assumption. Map the shared topology and design/approve an environment-safe TEST-first deployment and rollback procedure before any runtime pin rollout; do not hard-code environment IDs or create LIVE-specific source patches. The workflow's existing account/bucket fallbacks require particular scrutiny. The preferred next independent candidate is `.github/workflows/uk_aq_blog_feed_worker_deploy.yml`: the existing TEST `uk-aq-blog-feed` Worker was read-only verified serving version **3** (ID `73145f5f-98aa-4e1b-b325-ad690bcd8775`) at 100%, with `BLOG_FEED_KV`, `BROWSER` and `UK_AQ_BLOG_WORKER_HTTP_SECRET` bindings; older versions 2 and 1 are retained. Before any merge, verify actual deployment credential/account and KV identity, secret compatibility, baseline `/health` and `/feed` behaviour and usable rollback. Do not force a `/refresh` merely for validation. The DB/R2 Metrics Worker is also present but has broader secret synchronisation and a separate environment-target guard, so needs its own admission checks. Do not redeploy it merely to demonstrate a tooling version.

The source pin changes neither Cloudflare's managed Worker runtime nor Deno in the Latest Snapshot builder. The outstanding dashboard duplicate-deployment path, GCP secret lifecycle effects, scheduler migration admission, cache activation preservation, legacy AQI generation constraints, later Deno/npm/SheetJS security work and complete-file LIVE promotion restrictions remain **open**.

The user confirmed TEST currently runs only the two Breathe London networks, not OpenAQ or Sensor.Community source feeds. Network distribution on the Hex Map must not be misdiagnosed as an API regression from this Node rollout. No LIVE change or deployment is authorised by this documentation update.

## Reconciliation with latest TEST main

Refreshed main is `2d18e847235cfa58f114597a9ac25839cde73156`; previous PR head is `7ead204f3eb8443700067bcd4185bc9702602711`; their merge base is `483d333eb0a334dc40a9a8be35ff3014ccffa27c`. Main independently added signer repository admission and the manual preflight in PR #127 (`0488eb7a92babcc0769bb7f6f4d51589b4479b04`, merged at the refreshed main). The branches are reconciled by one normal merge commit with the previous PR head as first parent and current main as second parent; no history rewrite. The only overlapping file is Prune Daily, where main's repository-variable addition and the security runtime pin are non-overlapping changes. No material semantic conflict was found.

All nine newer-main file changes are retained: Prune's `UK_AQ_GITHUB_REPO: ${{ vars.UK_AQ_GITHUB_REPO }}` with no fallback, variable target mapping, README and three signer handover documents, the existing dated archive, and the new signer-preflight workflow/implementation. The implementation, configuration mapping, handovers and archive are exact current-main blobs. Prune Daily and the preflight each differ from current main by only `node-version: "24"` to `"24.22.1"`.

The new preflight remains manual-only, contents-read-only, five-minute timeout, checkout with persisted credentials disabled, and the same local admission command/environment/secret references. It does not install dependencies, invoke Prune, contact the signer or data services, upload, or apply configuration. No preflight is dispatched here. A later separately authorised run supplies structural configuration admission only; it cannot establish remote authentication, target ownership, successful handover or VERIFIED evidence. Preserve Prune's existing dry-run defaults, retention/batch bounds, lock/concurrency, temporary timeout, canonical publication/deletion gates and optional JSONgen failure isolation. Main's variable mapping is preserved, not applied to GitHub settings.

PR #126 now contains **23 workflow changes and four non-authoritative security documents** in TEST Ops only. It does not include the 12 deployment-affecting runtime changes from the original full batch. Each of those 12 files is restored byte-for-byte to current main `2d18e847235cfa58f114597a9ac25839cde73156`. They are deferred, not abandoned: their complete patched contents remain at original security commit `5da944d1b0660c8cbe818afcecaebb5b2e350cbd`, which remains an ancestor of the reconciliation commit. No history rewrite or archive copy is required.

The file CSV contains only these 27 current PR paths. The promotion assessment contains the separate 12-file deferred manifest, original blob identities and pinned complete-file links. Original cross-repository findings and full-batch reports remain historical evidence at [5da944d1b0660c8cbe818afcecaebb5b2e350cbd](https://github.com/TEST-uk-aq/uk-aq-ops/commit/5da944d1b0660c8cbe818afcecaebb5b2e350cbd); they are not claims about the reduced PR's scope.

Baseline main: `2d18e847235cfa58f114597a9ac25839cde73156`. First parent: `7ead204f3eb8443700067bcd4185bc9702602711`; second parent: `2d18e847235cfa58f114597a9ac25839cde73156`. Original full security source remains `5da944d1b0660c8cbe818afcecaebb5b2e350cbd`. Publication appends a normal merge commit on the existing branch; it does not rewrite security history. See PR #126 head for the final published commit.

## Included change and security minimum

All 23 in-scope workflow runtime selections are exact **Node.js 24.22.1**. Existing explicit 22/24 selections are pinned to 24.22.1; the two retained formerly implicit jobs receive the original setup-node steps in scheduler config validation and JSONgen R2 read-only checking. Those new steps use verified actions/setup-node v7.0.0 commit `820762786026740c76f36085b0efc47a31fe5020` with automatic package-manager caching disabled. Other action references and existing cache settings remain unchanged. The newly inherited Prune signer preflight retains actions/setup-node@v7 and changes only its Node selection from 24 to 24.22.1.

Exact setup-node resolution fails rather than silently selecting an older patch. Future security releases require a reviewed coordinated pin update. setup-node controls the job's application/tooling Node, not the embedded Node binary used by JavaScript Actions. Referenced action declarations already use node24; actual runner-bundled patch identity still needs independent runtime evidence. Do not claim that the deferred deployment jobs or all repositories now enforce the patch floor.

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
| `.github/workflows/uk_aq_prune_signer_preflight.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_core_snapshot.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_inventory_generation_migration.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_supabase_db_dump_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_v3_reader_version_urls.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_who_2021_daily.yml` | 24 | 24.22.1 |

## Verified automatic consequences

For an isolated merge of the revised PR against the checked main, exactly two automatic workflow definitions match:

| Workflow | Trigger match | Executed work | Skipped work / mutations |
|---|---|---|---|
| `.github/workflows/codeql-noarchive.yml` | `push` to `main`, `.github/workflows/**` matches retained YAML changes | Checkout and CodeQL analysis for Actions, JavaScript/TypeScript and Python; GitHub security-analysis uploads | No cloud deployment or operational data job. Workflow/ref concurrency cancels older matching analysis. |
| `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` | Its changed workflow path matches `push` to `main` (also PR validation) | Checkout, patched Node, Python, local jobs.toml validation/payload generation, push-range comparison and validation-only report | `jobs.toml` is unchanged, so `remote_sync=false`. Credential checks, remote D1 schema wait, job sync and remote verification remain skipped. Ref-scoped concurrency retains cancellation. |

No deployment workflow or the history/dashboard coordinator matches the revised changed-path set. No Cloudflare Worker, Cloud Run or Pages deployment, D1 migration, secret synchronization, route/IAM change or other remote infrastructure mutation is initiated by this isolated merge. This conclusion depends on the exact checked diff: recheck after any additional file or main change. Repository/workflow availability and existing platform conditions still govern actual check execution.

The new Prune signer preflight remains workflow_dispatch-only and cannot run from this merge. No workflow_run/check_run/check_suite/pull_request_target chain is present. Feature-branch pushes have no matching push workflow; PR updates match the same two validation workflows. CodeQL retains its separate weekly schedule.

Manual dispatch of scheduler config sync is different: it sets `remote_sync=true` and can change D1 job activation/configuration. Do not dispatch it merely to collect Node evidence. No triggers, job conditions, permissions, inputs, environment references or concurrency controls are removed or disabled to achieve this scope.

## Focused structural verification

- Parse all 38 candidate workflow definitions and all 23 changed YAML files; verify the 23 in-scope selections equal 24.22.1 and the two retained original setup additions are intact.
- Compare parsed workflow semantics against current main after normalizing only intended runtime selections/new setup steps. All operational commands, authentication, permissions, inputs, scheduling, concurrency, locks, deletion/failure controls and environment references remain unchanged.
- Verify each deferred file's exact Git blob/mode equals current main; the original 22 runtime updates are preserved. Twenty-one retained workflows equal their previous PR versions byte-for-byte; Prune retains main's repository-variable addition plus its original pin, and the new preflight has only the exact pin change.
- Verify the complete candidate tree differs from current main only in the 23 in-scope workflow files and these four documents. Explicitly preserve writer/test, all application and lock/schema/settings blobs.
- Recompute merge/branch/PR event matching over all workflow definitions, including unchanged coordinator/reusable-workflow relationships. Confirm jobs.toml is unchanged and remote_sync=false for this isolated push/PR.
- Check CSV scope (27 unique included-only paths), the 12-file deferred manifest, immutable source links and whitespace/diff. No functional/new test suite, install, Docker build, operational service/database call or workflow dispatch is performed.

## Outstanding normal TEST acceptance

Functional acceptance remains outstanding. Merging workflow definitions changes which Node version later **existing external schedules** or separately authorized manual operations use. It does not authorize a new execution. Preserve current runtime scheduler/Prune/JSONgen activation states; canonical jobs.toml is not proof of currently applied D1 state.

- On each next already-authorized normal TEST run, retain source SHA/run URL, setup-node's 24.22.1 log, executable/tool versions when available and independent embedded-action runtime evidence.
- For existing backup, retention, partition, core, WHO and chart tasks, retain normal task-health/report outputs and unchanged lock, safety, scientific and failure semantics. Do not run destructive paths just for version evidence.
- Keep paused Prune and independently gated JSONgen paths paused. JSONgen transport/deployment/version-upload workflows can mutate resources despite manual or diagnostic naming; do not blanket-dispatch them.
- The retained inventory-generation migration still contains LIVE-labelled targeting. Do not use it for TEST acceptance or silently change its target. Generic restore remains limited recovery authority.
- One historical PR config-validation run at the original full head reported Node 24.22.1, runner 2.338.0 and remote_sync=false ([run 40127332867](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40127332867)). It is installer/validation evidence, not acceptance of this new head, deployed images or operational jobs.

## Later rollout and separate prerequisites

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

## Original findings, LIVE restrictions and rollback

No LIVE promotion is recommended by this PR. TEST operational evidence, complete-file comparison and operator approval remain separate. Never overwrite newer LIVE code with an older TEST version or copy TEST archives. Environment values must remain externally configured; do not introduce a separate LIVE implementation or cross-environment fallback.

Retained complete-file blockers include the existing literal TEST identity and JSONgen wiring in Prune; partition-generation mapping/validation differences; newer restore verification-overlay support and its dependency closure; LIVE-labelled inventory migration; TEST-only JSONgen/reconciliation/version tools; and independent review of each file's application/lock/configuration dependencies. The exact runtime pin alone does not make those complete files promotable.

Deferred deployment files retain the dashboard direct/coordinator overlap, scheduler migration/secret effects, GCP secret cleanup/reference effects, cache activation behavior and AQI generation issue. Those are later-stage prerequisites, not fixed or deployed by stage 1.

The original full inventory also includes Ingest/Sensor.Community, both old LIVE Docker selections, Deno, npm/SheetJS/Wrangler graphs, other repositories' major-only selections and shared-host runtime evidence. Sensor promotion still requires its complete Docker/context/module/deploy set and review of existing metrics/environment defaults. Those findings remain open outside this reduced Ops PR. The inactive Ops root Dockerfile is unchanged and requires patch enforcement before any supported reuse. Optional Windows/ia32 tooling and embedded runner patches remain separate evidence/remediation items.

Rollback is a reviewed TEST forward correction or revert that preserves a supported patched runtime; do not downgrade operational runtimes simply to restore an older workflow definition. Reverting source cannot undo any later data writes, secret changes, deployments or migrations. No external rollback action is needed for this rescope itself because none is performed. The deferred originals remain available in immutable Git history.

No application source, dependency manifest/lock, schema, environment setting or authoritative system_docs contract is changed. The observation-history writer and its existing test remain exactly current main. No code-style archive is needed for these ordinary workflow/documentation edits. Documentation handover: record stage 1's runtime scope and acceptance evidence in Chat mode if authoritative deployment documentation needs updating; this PR does not edit it.

Original full reports: [remediation](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/docs/security/2026-10-24-node-remediation-report.md), [promotion assessment](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/docs/security/2026-10-24-node-promotion-readiness.md), [full original CSV](https://github.com/TEST-uk-aq/uk-aq-ops/blob/5da944d1b0660c8cbe818afcecaebb5b2e350cbd/docs/security/2026-10-24-node-modified-files.csv). The current [included-only CSV](2026-10-24-node-modified-files.csv) and [stage-aware promotion/deferred manifest](2026-10-24-node-promotion-readiness.md) supersede their scope claims for PR #126.
