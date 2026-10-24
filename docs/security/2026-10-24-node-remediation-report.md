# Node.js October 2026 TEST remediation report

Repository implementation and structural validation are complete. The containing pull request supplies the reviewed commit and publication identity. No LIVE mutation, merge, service deployment, operational workflow dispatch or cloud-resource change is performed.

## Changes and enforcement

40 configuration files: six Ingest files and 34 Ops workflows. Non-authoritative repository handovers, this report, a modified-file manifest and a separate promotion assessment accompany them. 2026-10-24-node-modified-files.csv lists every path with before/after runtime, repository, branch, commit and PR.

All 26 previously explicit Node selections (24 in Ingest; 22/24 in Ops) and 12 formerly implicit selections now request exact 24.22.1. No Node 22 compatibility exception remains in these two workflow sets. The exact installer fails rather than falling back below the floor. Previously TEST already contained all 12 LIVE Node-20 workflow corrections at major 24 and both root/container major-24 changes; this patch establishes patch identity rather than repeating those upgrades.

Sensor.Community uses node:24.22.1-slim and a build assertion requiring >=24.22.1 <25, reporting patch/platform/arch before COPY. The existing deployment build uses --pull --progress=plain and prints pushed RepoDigests. Official Docker source metadata confirms 24.22.1 in the bookworm-slim variant on amd64/arm64v8/ppc64le. Registry digest/build/runtime observations remain outstanding. Exact pins require a coordinated reviewed update for future security releases; mutable OS layers require retained build/digest evidence.

The twelve added setup steps close existing implicit PATH exposure in scheduler, Wrangler, Supabase, JSONgen read-only and latest-snapshot npm preparation jobs. Newly introduced action references use verified setup-node v7.0.0 SHA 820762786026740c76f36085b0efc47a31fe5020; existing action references/cache settings remain intact. Reviewed invoked action definitions already use embedded node24; Supabase is composite. No unsupported embedded Node declaration was found in these current TEST workflows. Actual runner-bundled patch remains unverified, independent of application Node selection.

Ops root Dockerfile has no tracked active deployment reference or supported current build procedure in the inspected sources. It remains node:24-alpine, unchanged, with external/manual use unverified. It must gain patch enforcement before any supported reuse. No rebuild or retirement is performed.

## Structural checks

- Parsed all 60 current TEST workflows; checked 39 changed YAML files and 38 exact runtime selections in execution order.
- Parsed before/after equality after removing only the intended Node selections/new setup steps and Sensor build flags/digest output: all triggers, inputs, env, secrets references, permissions, concurrency, timeout, lock/data commands and failure handlers are preserved.
- Inspected four Sensor Docker COPY sources, Dockerfile-specific allowlist, module import layout, supplier architecture/base-OS identity and unchanged command/environment.
- node --check passed for all four Sensor modules and the new inline assertion. Running only that assertion on the actual host Node 24.19.0 rejected it as required; no application code was executed.
- Examined root and two dashboard/history nested lockfile engine constraints with semver for Node 24.22.1. All relevant Linux amd64 packages admit it; only optional Windows/ia32 sharp artifacts exclude it. No install or dependency upgrade was needed.
- Reviewed branch/PR triggers: privileged deployments are main-push/manual-only; scheduler PR paths validate locally and gate remote D1 work. Ingest env-target validation may run on branch push/PR and CodeQL may run on PR. No operational dispatch is made. Merging later can activate existing main-push deployment/scheduler paths and requires separate coordination.
- Whitespace/diff and remote changed-path checks are recorded with publication below. No speculative tests, Docker build, package installation or functional validation is claimed. No archive is needed for configuration-only low-risk changes; application sources are unchanged.

## Post-deployment TEST checks (operator only, separately authorized)

After review/merge or a separately approved workflow ref, use existing operational workflows. These commands are examples of the exact existing paths and inputs, not actions performed here:

```bash
gh workflow run uk_aq_scomm_cloud_run_deploy.yml --repo TEST-uk-aq/uk-aq-ingest --ref main
gh workflow run uk_aq_stations_daily.yml --repo TEST-uk-aq/uk-aq-ingest --ref main
gh workflow run uk_aq_prune_daily.yml --repo TEST-uk-aq/uk-aq-ops --ref main -f dry_run=true
gh workflow run uk_aq_r2_core_snapshot.yml --repo TEST-uk-aq/uk-aq-ops --ref main -f dry_run=true
gh workflow run uk_aq_r2_history_dropbox_backup.yml --repo TEST-uk-aq/uk-aq-ops --ref main -f dry_run=true
gh workflow run uk_aq_r2_history_restore_from_dropbox.yml --repo TEST-uk-aq/uk-aq-ops --ref main -f dry_run=true
gh workflow run uk_aq_supabase_db_dump_backup.yml --repo TEST-uk-aq/uk-aq-ops --ref main
gh workflow run uk_aq_who_2021_daily.yml --repo TEST-uk-aq/uk-aq-ops --ref main -f run_mode=daily -f trigger_mode=manual
```

Preserve all existing paused/activation states and verify correct TEST account/resource configuration before authorizing execution. Dry runs can still read services and report health; they do not establish successful writes/deletion. Do not dispatch the LIVE-targeted inventory-generation migration for TEST acceptance. Other changed deployment/diagnostic paths use their existing workflow and authorization inputs; do not blanket-dispatch all workflows for runtime evidence.

For each accepted actual run retain run URL/source SHA, selected Node version and executable path, action-host Node patch and runner identity. For Sensor retain base/final digests and serving Cloud Run revision/traffic before observing one normal ingest. Check expected task health and artifacts, polling restoration, lock release and failure propagation. Exercise actual protected writes only when independently authorized; retain normal scientific/history/backup/deletion contracts. 2026-10-24-node-promotion-readiness.md details per-operation evidence and complete-file blockers.

## Promotion, rollback and handover

The separate 2026-10-24-node-promotion-readiness.md maps all 12 LIVE Node-20 workflows and both Dockerfiles, lists complete Sensor source/context files, identifies other complete-file differences and acceptance gates. Current LIVE files were inspected read-only. No newer LIVE file is overwritten. Prune literal TEST identity/JSONgen wiring and Sensor egress defaults block unqualified complete-file promotion. Restore's newer verification support and partition generation configuration need separate approval if included. Never copy TEST archives.

Rollback uses a reviewed revert of the relevant TEST commit; leave destructive operations stopped if no patched compatible runtime exists. Reverting source does not undo data writes. Cloud Run rollback must choose an already accepted patched immutable image/revision, not the old Node-20 image. Follow existing operational rollback contracts for stateful jobs.

No schema, environment key or authoritative behavioural contract changes. The two repository docs provide a Chat-mode handover for recording runtime floors and deployment evidence; system_docs remains read-only and unchanged.

Deferred findings: Node 22 major-only selections in TEST Media, Integrity Factory and sensors; website major-only Node 24; shared development host 24.19.0; hosted action-binary patches; inactive Ops image enforcement before reuse; optional Windows/ia32 sharp toolchain; Deno pins, npm affected graphs/SheetJS and Wrangler upgrades from later inventory batches. Other repositories and all LIVE sources remain unchanged. No claim of full-system patch acceptance is made.

## Publication

Both TEST repositories use branch `codex/node-october-2026-security` targeting `main`. See each pull request head for the published commit; the completion response records the exact commits and PR URLs. Publication uses GitHub Git-data APIs because the workspace Git HTTP proxy is unavailable; only the bounded changed files are overlaid onto each pinned GitHub base tree. The older provided checkouts remain untouched.
