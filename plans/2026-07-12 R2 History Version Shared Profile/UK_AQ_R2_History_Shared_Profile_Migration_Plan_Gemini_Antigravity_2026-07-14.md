# UK AQ R2 History Shared Profile Migration Plan

**Date:** 12 July 2026  
**Primary implementation repo:** `TEST-uk-aq/uk-aq-ops`  
**Downstream test repos to audit and smoke-test:**

- `TEST-uk-aq/uk-aq-ingest`
- `TEST-uk-aq/uk-aq-schema`
- `TEST-uk-aq/TEST-uk-aq-root.github.io`

**Target configuration:** one required runtime switch:

```text
UK_AQ_R2_HISTORY_VERSION=v1|v2
```

All active R2 history paths must be selected from a shared history profile. Normal TEST and LIVE configuration must not require separate observation, AQI, core, run-manifest or index-prefix variables.


## Revision note: 14 July 2026

A live dashboard discrepancy exposed another active R2 history consumer that was not included in the original confirmed-consumer list:

```text
workers/uk_aq_db_size_logger_cloud_run/run_job.ts
.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml
```

The DB-size logger directly lists and totals the configured observations and AQI R2 prefixes. On 13 July 2026, a redeployment caused its recorded observations total to fall sharply because the deployed observations prefix resolved to `history/v1/observations` while the active history version was `v2`.

### Immediate operational correction before the shared-profile migration

Until the shared profile is implemented and deployed, the CIC-Test variables should be internally consistent with v2:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_R2_HISTORY_INDEX_VERSION=v2

UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX=history/v2/observations
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v2/aqilevels/hourly/data
UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index_v2
UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX=history/_index_v2/observations_timeseries
```

Any other active history prefix variables must be checked against the canonical v2 profile before redeployment. Correcting repository variables alone does not update an already deployed Cloud Run revision. The DB-size logger must be redeployed or otherwise receive a new revision after the variables are corrected.

This is a temporary consistency repair. It does not replace the shared-profile implementation.

This plan deliberately does **not** introduce v1/v2 mirroring or dual writes. LIVE can remain on v1 while the existing migration tools build v2 explicitly. After cutover, v1 may become stale. If rollback to v1 is required, missing v1 observations can be rebuilt using the retained older integrity/backfill tooling.

---

## 1. Goals

1. Make `UK_AQ_R2_HISTORY_VERSION` the single authoritative version setting for all active production and test services.
2. Put the complete v1 and v2 storage layouts in one shared profile implementation.
3. Remove duplicated version-to-prefix selection from workers, scripts and workflows.
4. Prevent another service from being missed during a history version change.
5. Allow TEST and LIVE to run different versions from the same code.
6. Keep manual migration tools able to read v1 and write v2 while the active LIVE version remains v1.
7. Keep destructive retention fail-closed and tied to the same profile as the writer and readers.
8. Make a future v2-to-v1 rollback possible while v1 still exists, with any post-cutover gap repaired separately rather than maintained by a mirror.
9. Make eventual v1 retirement a controlled final phase rather than an implicit side effect of the v2 cutover.

## 2. Non-goals

- Do not dual-write every new observation to v1 and v2.
- Do not create separate read, write and backup version variables again.
- Do not convert HTTP API route names such as `/v1/observations` or `/v1/aqi-history`. Those are API contract versions, not R2 storage versions.
- Do not blindly replace every string containing `v1`. Some values may be API versions, schema versions, static lookup versions or archived migration records.
- Do not delete v1 R2 data as part of this implementation.
- Do not make a runtime service accept a request-level history-version override.

---

## 3. Current repository state

The repository already has a good base:

- `workers/shared/uk_aq_r2_history_version.mjs` is the canonical parser for `UK_AQ_R2_HISTORY_VERSION`.
- It requires `v1` or `v2` and rejects the deprecated split variables:
  - `UK_AQ_R2_HISTORY_READ_VERSION`
  - `UK_AQ_R2_HISTORY_WRITE_VERSION`
  - `UK_AQ_R2_HISTORY_BACKUP_VERSION`
- Commit `2b97bab291cf9c1354909640fcf55cc1e5f640ffd` previously consolidated the codebase around the single canonical version variable.

However, path selection is still duplicated or bypassed in several places.

### 3.1 Confirmed current consumers and gaps

| Area | Current implementation | Required change |
|---|---|---|
| Shared version parser | `workers/shared/uk_aq_r2_history_version.mjs` validates the version only | Extend with a complete shared history profile resolver |
| Prune/history writer | `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` manually loads v1 and v2 prefixes and selects between them | Replace its local profile selection with the shared resolver |
| Observations history API | `workers/uk_aq_observs_history_r2_api_worker/worker.mjs` manually selects v1/v2 data and index prefixes | Use the shared profile |
| AQI history API | `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` manually defines v1/v2 AQI and index defaults | Use the shared profile |
| Shared index code | `workers/shared/uk_aq_r2_history_index.mjs` returns both v1 and v2 paths but does not use one canonical active profile | Resolve the requested profile centrally |
| Manual index builder | `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` still uses `UK_AQ_R2_HISTORY_INDEX_VERSION` and defaults to v1 | Remove the independent environment version; use canonical version or explicit CLI override |
| Backup inventory | `scripts/backup_r2/build_backup_inventory.mjs` and `scripts/backup_r2/lib/inventory.mjs` manually map versions to domains, prefixes, inventories and state files | Move all path mapping to the shared profile |
| Dropbox backup workflow | `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` passes both v1 and v2 path variables | Pass the version and let code resolve paths |
| Local backfill | `scripts/uk_aq_backfill_local.sh` mostly understands the canonical version, but still describes and passes individual path variables | Use the profile and retain an explicit CLI target for manual migration/rebuild operations |
| Observs partition maintenance | Worker reads only generic `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX`; workflow currently forces that value from the v2 variable | Make worker version-aware and remove the hardwired v2 workflow mapping |
| AQI-level retention | Worker and deploy workflow still default directly to `history/v1/aqilevels/hourly` | Urgent conversion to shared profile before relying on v2 retention |
| History integrity | Python/shell tooling validates v2 but TEST and LIVE env examples still hardcode `history/v1/core` | Resolve relative history paths from the shared profile |
| GitHub variable registry | `config/uk_aq_github_env_targets.csv` contains the canonical version plus many path variables | Retire normal path-variable targets after compatibility phase |
| R2 DB-size logger | `workers/uk_aq_db_size_logger_cloud_run/run_job.ts` directly totals configured observations and AQI prefixes; its workflow still supplies independent prefix variables and defaults | Migrate to the shared profile, remove silent v1 fallback, log the selected profile and add it to coordinated redeployment |
| Website/cache proxy | Uses the history APIs and does not need to know the R2 path | Smoke-test only; do not expose storage-version paths to website code |
| Ingest/schema repos | No confirmed active path selection found in this review | Perform a formal audit; only change if an active R2 history consumer is found |

### 3.2 Immediate safety observation

Before the full refactor is complete:

- observs partition maintenance is now effectively tied to v2 through its workflow;
- AQI-level retention is still tied to the v1 AQI prefix;
- changing `UK_AQ_R2_HISTORY_VERSION` alone therefore does not currently make the destructive retention services consistent.

The DB-size logger is also not controlled solely by the canonical version. A redeployment can overwrite a previously correct manual prefix with workflow defaults. Until it is migrated, treat its R2 domain-size metrics as configuration-dependent rather than authoritative.

Until Phase 4 is deployed and validated, keep retention dry-run controls available and do not assume that the global version setting controls both retention services.

---

## 4. Target architecture

## 4.1 One canonical active version

Every long-running worker, scheduled service and normal backup job must require:

```text
UK_AQ_R2_HISTORY_VERSION=v1|v2
```

Missing or invalid values must fail startup or deployment. There must be no silent fallback to v1.

## 4.2 One shared history profile module

Add:

```text
workers/shared/uk_aq_r2_history_profile.mjs
```

The existing version parser should remain responsible for parsing and validating the version. The new module should import it and return a complete immutable profile.

Suggested public interface:

```javascript
getR2HistoryProfile(version)
resolveR2HistoryProfile(env, options = {})
assertR2HistoryProfile(profile)
```

Suggested use:

```javascript
const profile = resolveR2HistoryProfile(env, {
  context: "R2 observations history API",
});
```

The returned object should use stable, unambiguous field names. For example:

```javascript
{
  version: "v2",
  observations_prefix: "history/v2/observations",
  aqilevels_hourly_data_prefix: "history/v2/aqilevels/hourly/data",
  aqilevels_hourly_debug_prefix: "history/v2/aqilevels/hourly/debug",
  core_prefix: "history/v2/core",
  observations_runs_prefix: "history/v2/_ops/observations/runs",
  index_root_prefix: "history/_index_v2",
  observations_timeseries_index_prefix:
    "history/_index_v2/observations_timeseries",
  aqilevels_timeseries_index_prefix:
    "history/_index_v2/aqilevels_hourly_data_timeseries",
  timeseries_metadata_index_prefix:
    "history/_index_v2/timeseries",
  backup_inventory_rel_path:
    "history/_index_v2/backup_inventory_v2.json",
  backup_state_rel_path:
    "_ops/checkpoints/r2_history_backup_state_v2.json"
}
```

Fields not present in a version should be explicitly `null`, not silently borrowed from the other version. For example, v1 has no separate AQI debug profile or v2 timeseries metadata tree.

## 4.3 Canonical profile values

The initial profiles should capture the current established layout.

### v1

```text
observations_prefix:
  history/v1/observations

aqilevels_hourly_data_prefix:
  history/v1/aqilevels/hourly

aqilevels_hourly_debug_prefix:
  null

core_prefix:
  history/v1/core

observations_runs_prefix:
  history/v1/_ops/observations/runs

index_root_prefix:
  history/_index

observations_timeseries_index_prefix:
  history/_index/observations_timeseries

aqilevels_timeseries_index_prefix:
  history/_index/aqilevels_timeseries

timeseries_metadata_index_prefix:
  null

backup_inventory_rel_path:
  history/_index/backup_inventory_v1.json

backup_state_rel_path:
  _ops/checkpoints/r2_history_backup_state_v1.json
```

### v2

```text
observations_prefix:
  history/v2/observations

aqilevels_hourly_data_prefix:
  history/v2/aqilevels/hourly/data

aqilevels_hourly_debug_prefix:
  history/v2/aqilevels/hourly/debug

core_prefix:
  history/v2/core

observations_runs_prefix:
  history/v2/_ops/observations/runs

index_root_prefix:
  history/_index_v2

observations_timeseries_index_prefix:
  history/_index_v2/observations_timeseries

aqilevels_timeseries_index_prefix:
  history/_index_v2/aqilevels_hourly_data_timeseries

timeseries_metadata_index_prefix:
  history/_index_v2/timeseries

backup_inventory_rel_path:
  history/_index_v2/backup_inventory_v2.json

backup_state_rel_path:
  _ops/checkpoints/r2_history_backup_state_v2.json
```

During Phase 0, classify the current staging and any auxiliary paths. Decide explicitly whether each is:

1. versioned history data;
2. shared operational control data;
3. an API/schema version unrelated to R2 history.

Do not leave a v2 writer using a path named `history/v1/...` merely because the path is temporary. Either include it in the selected profile or move it to an intentionally version-neutral `_ops` path.

## 4.4 Manual tools may select an explicit profile

The single environment switch controls active services. Manual migration and repair tools need a safe way to work on a non-active version.

Use explicit CLI arguments rather than additional global environment variables:

```text
--history-version v1|v2
--source-history-version v1|v2
--target-history-version v1|v2
```

Rules:

- Runtime APIs and scheduled services must not accept a request-level version override.
- A normal manual tool may default to `UK_AQ_R2_HISTORY_VERSION`.
- A migration tool that reads one version and writes another must require explicit source and target versions, or have hardcoded purpose-specific source/target with a clear confirmation report.
- Every report must record the resolved version and all relevant selected prefixes.

This allows LIVE to remain actively on v1 while migration scripts build v2.

## 4.5 Cross-language access

Most active workers are JavaScript/TypeScript and can import the shared module directly. The history-integrity runner is Python/shell.

Add a small shared CLI:

```text
scripts/uk_aq_r2_history_profile.mjs
```

Suggested interface:

```text
node scripts/uk_aq_r2_history_profile.mjs --version v2 --format json
node scripts/uk_aq_r2_history_profile.mjs --version v2 --format env
node scripts/uk_aq_r2_history_profile.mjs --version v2 --show
```

The Python integrity process can call it once during preflight and parse JSON. Dropbox paths should then be constructed by joining the environment-specific Dropbox root to the selected relative profile prefix.

This keeps one path map in JavaScript rather than copying the v1/v2 map into Python, shell and every workflow.

## 4.6 Prefix overrides

Normal TEST and LIVE operation should not need prefix variables.

During the transition, the shared resolver may support the existing prefix variables as deprecated compatibility overrides, but only if necessary to avoid a large single release. If retained temporarily:

- log each override in structured startup output;
- reject an override that points outside the selected version unless a manual tool explicitly opts into compatibility mode;
- do not reinterpret the ambiguous v1 variable as a v2 variable;
- remove the compatibility path in Phase 9.

Preferred final state:

```text
UK_AQ_R2_HISTORY_VERSION
```

plus R2 credentials and bucket name, with no normal GitHub repository variables for standard history prefixes.

---

# 5. Phased implementation

## Phase 0: Complete the consumer and path audit

### Purpose

Create an authoritative inventory before moving code. Avoid repeating the partition-maintenance omission.

### Work

1. Search all active files in:
   - `TEST-uk-aq/uk-aq-ops`
   - `TEST-uk-aq/uk-aq-ingest`
   - `TEST-uk-aq/uk-aq-schema`
   - `TEST-uk-aq/TEST-uk-aq-root.github.io`
2. Search for:

```text
UK_AQ_R2_HISTORY_VERSION
UK_AQ_R2_HISTORY_INDEX_VERSION
UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX
UK_AQ_R2_HISTORY_CORE_PREFIX
UK_AQ_R2_HISTORY_RUNS_PREFIX
UK_AQ_R2_HISTORY_V2_
history/v1/
history/v2/
history/_index
history/_index_v2
```

3. Exclude from active migration scope only after classification:
   - `archive/**`
   - historical plans and completed runbooks;
   - API routes such as `/v1/observations`;
   - unrelated schema/version strings.
4. Produce a checked-in inventory table listing:
   - file;
   - runtime/job;
   - read/write/delete role;
   - selected version mechanism;
   - paths used;
   - whether destructive;
   - migration phase.
5. Identify all workflows that deploy or run each consumer.
6. Identify all workflow `paths:` filters that must include the new shared module.
7. Classify staging, bands and other auxiliary paths.
8. Confirm whether any code outside `uk-aq-ops` directly reads R2 history. Current evidence suggests the website consumes APIs rather than R2 paths, but this must be recorded rather than assumed.

### Safety action

Until the destructive services are profile-aware:

- keep `AQILEVELS_RETENTION_DROP_DRY_RUN` available;
- keep `OBSERVS_PARTITION_DROP_DRY_RUN` available;
- document that the two services currently do not follow one common version selector.

### Acceptance criteria

- Every active R2 history consumer has an owner and migration phase.
- Every direct `history/v1` or `history/v2` reference is classified.
- No destructive service is omitted.

---

## Phase 1: Add the shared profile and compatibility contract

### Files

Create:

```text
workers/shared/uk_aq_r2_history_profile.mjs
scripts/uk_aq_r2_history_profile.mjs
tests/uk_aq_r2_history_profile.test.mjs
```

Update:

```text
workers/shared/uk_aq_r2_history_version.mjs
package.json
system_docs or docs for R2 history configuration
```

### Work

1. Implement the immutable v1 and v2 profile objects.
2. Use `resolveR2HistoryVersion()` as the only version parser.
3. Validate every required profile field.
4. Represent unsupported fields as `null`.
5. Add optional context text to errors.
6. Add a profile-report CLI for JSON, env and human-readable output.
7. Add deterministic structured output suitable for CI and Python preflight.
8. Decide and document temporary legacy-prefix override behaviour.
9. Add a clear error for deprecated split version variables.
10. Standardise logging field names:

```text
history_version
history_observations_prefix
history_aqilevels_data_prefix
history_aqilevels_debug_prefix
history_core_prefix
history_index_root_prefix
```

### Tests

- exact v1 profile values;
- exact v2 profile values;
- missing version fails;
- invalid version fails;
- deprecated version variables fail;
- profile is immutable;
- `null` fields behave predictably;
- CLI JSON output parses;
- CLI env output is shell-safe;
- compatibility overrides, if retained, are validated and logged.

### Acceptance criteria

- A single unit-tested function returns every standard R2 history path for v1 or v2.
- No consumer has been migrated yet, so deployment behaviour is unchanged.

---

## Phase 2: Migrate non-destructive readers and index configuration

### Purpose

Move readers first because they are easier to compare and cannot delete source database data.

### Confirmed files

```text
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
workers/uk_aq_observs_history_r2_api_worker/wrangler.toml
.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml

workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
workers/uk_aq_aqi_history_r2_api_worker/wrangler.toml
.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml

workers/shared/uk_aq_r2_history_index.mjs
scripts/backup_r2/uk_aq_build_r2_history_index.mjs
```

Also migrate any history-window, coverage, metrics or dashboard consumers found in Phase 0.

### Work

1. Replace local v1/v2 default constants used for selection with `resolveR2HistoryProfile()`.
2. Keep API routes unchanged.
3. Remove `UK_AQ_R2_HISTORY_INDEX_VERSION` as an independent environment selector.
4. Make the manual index builder resolve:
   - explicit `--history-version`, if supplied;
   - otherwise `UK_AQ_R2_HISTORY_VERSION`;
   - never an implicit v1 default.
5. Use profile fields for:
   - data prefixes;
   - index roots;
   - observations timeseries indexes;
   - AQI timeseries indexes;
   - v2 timeseries metadata.
6. Keep explicit CLI selection for manual index repair of the non-active version.
7. Remove normal prefix substitutions from the Cloudflare deploy workflows once runtime profile resolution is proven.
8. Ensure shared profile changes trigger all relevant deployment workflows.
9. Include selected profile fields in request-start diagnostics and response metadata where already exposed.
10. Migrate the DB-size logger to resolve `observations_prefix` and `aqilevels_hourly_data_prefix` from the selected shared profile.
11. Remove its direct v1 defaults and normal workflow wiring for the two domain prefixes.
12. Keep the metrics meaning unchanged: observations totals the selected observations data tree, and AQI totals the selected hourly data tree, not the v2 debug tree or index trees.
13. Include the selected version and exact counted prefixes in the DB-size logger startup and summary logs.
14. Ensure changes to the shared profile module trigger the DB-size logger deployment workflow.

### Tests

For both v1 and v2:

- observations worker selects the correct data and index paths;
- AQI worker selects the correct data and index paths;
- API cache keys remain version-separated;
- `/v1/...` API routes remain unchanged;
- index builder targets the selected profile;
- explicit manual `--history-version` overrides the active environment only for the manual command;
- missing version fails before any R2 request;
- DB-size logger counts `history/v1/observations` and `history/v1/aqilevels/hourly` for v1;
- DB-size logger counts `history/v2/observations` and `history/v2/aqilevels/hourly/data` for v2;
- DB-size logger never counts the v2 AQI debug tree as the AQI domain size;
- DB-size logger has no silent v1 fallback when the canonical version is missing.

### Acceptance criteria

- Switching the version in a test invocation changes every reader/index path together.
- No runtime reader still has independent path-selection logic.

---

## Phase 3: Migrate backup, migration and writer tooling

### Confirmed files

```text
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
scripts/backup_r2/lib/inventory.mjs
.github/workflows/uk_aq_r2_history_dropbox_backup.yml

workers/uk_aq_prune_daily/phase_b_history_r2.mjs
.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml

scripts/uk_aq_backfill_local.sh
workers/uk_aq_backfill_local/run_job.ts

scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs
scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs
scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh
scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs
```

Include other active builders found in Phase 0.

### Work

1. Replace `resolvePhaseBHistoryWritePrefixes()` with the shared profile resolver, or make it a thin compatibility wrapper around the shared resolver and then remove it.
2. Use profile fields for observations, AQI data/debug, core, run manifests, indexes, inventory and state paths.
3. Remove duplicated backup domain/path maps from `build_backup_inventory.mjs` and `inventory.mjs`.
4. Keep version-specific domain lists in the profile or a closely related shared capability map:
   - v1: observations, AQI, core;
   - v2: observations, AQI data, AQI debug, core.
5. Make the normal Dropbox backup workflow use only the active `UK_AQ_R2_HISTORY_VERSION`.
6. Preserve the workflow-dispatch `history_version` input only as an explicit manual override, and report prominently when it differs from the repository setting.
7. Convert migration scripts to explicit source and target profiles. They must not depend on changing the active LIVE version.
8. Update the v2 migration runbook to remove old `READ_VERSION` and `WRITE_VERSION` examples.
9. Preserve the established migration order:
   1. build v2 core;
   2. ensure local Dropbox has v2 core;
   3. build v2 observations from v1;
   4. build/refresh v2 observations inventory;
   5. sync v2 observations to Dropbox;
   6. build v2 AQI data/debug;
   7. build v2 indexes;
   8. build final inventory and sync;
   9. validate.
10. Standardise reports to include source and target profile information.

### Tests

- prune writes v1 when selected v1;
- prune writes v2 when selected v2;
- v2 debug and data prefixes cannot be swapped;
- backup inventory and state paths follow the selected profile;
- v2 backup includes AQI debug and v1 does not;
- migration command can read v1 and write v2 while the environment active version remains v1;
- no manual migration command can accidentally write to its source profile without an explicit replace/target confirmation;
- existing partial-run and manifest-resume behaviour remains intact.

### Acceptance criteria

- Normal writers and backups use one active profile.
- Manual migration tools can target v2 independently of the active LIVE version.
- Old split version variables no longer appear in active commands or docs.

---

## Phase 4: Migrate destructive retention services

### Priority

This phase must be complete before the shared version switch is considered authoritative for deletion safety.

### Observs partition maintenance

Files:

```text
workers/uk_aq_observs_partition_maintenance_service/server.mjs
.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml
system_docs/uk-aq-observs-partition-maintenance.md
```

Work:

1. Import `resolveR2HistoryProfile()`.
2. Require `UK_AQ_R2_HISTORY_VERSION`.
3. Select `profile.observations_prefix`.
4. Remove the workflow workaround that passes the v2 value under the generic v1-era variable name.
5. Pass only the canonical version and R2 credentials during normal deployment.
6. Log selected version and prefix at run start.
7. Retain HEAD, GET, `day_utc` and `manifest_hash` validation.
8. Retain fail-closed behaviour for missing or invalid manifests.
9. Retain empty-partition-only fallback behaviour.
10. Add the shared profile module to workflow path triggers.

### AQI-level retention

Files:

```text
workers/uk_aq_aqilevels_retention_service/server.mjs
.github/workflows/uk_aq_aqilevels_retention_cloud_run_deploy.yml
related system documentation and tests
```

Work:

1. Import `resolveR2HistoryProfile()`.
2. Require `UK_AQ_R2_HISTORY_VERSION`.
3. Select `profile.aqilevels_hourly_data_prefix`.
4. For v2, confirm the retention gate checks:

```text
history/v2/aqilevels/hourly/data/day_utc=<day>/manifest.json
```

5. Do not use the debug profile as the deletion gate unless the existing retention contract is intentionally changed and documented.
6. Remove the current direct default to `history/v1/aqilevels/hourly`.
7. Log selected version and prefix at run start.
8. Preserve fail-closed manifest behaviour.
9. Consider upgrading AQI retention from HEAD-only to the same manifest body/hash validation used by observs retention. Treat this as a safety improvement, not a prerequisite for profile selection, if it would expand the phase too much.
10. Add shared profile changes to workflow path triggers.

### Tests

For both retention services and both versions:

- correct selected manifest key;
- missing version fails startup;
- invalid version fails startup;
- missing manifest prevents populated-data deletion;
- invalid manifest prevents deletion where body validation applies;
- dry run never deletes;
- empty-partition fallback remains limited to observations;
- run-start log contains version and prefix;
- workflow deploys the canonical version variable.

### Acceptance criteria

- Both destructive services follow the same active profile as prune, APIs and backup.
- There is no hardwired v1 or v2 deployment mapping.
- Retention can be placed in dry-run, switched between v1/v2, and verified without code changes.

---

## Phase 5: Migrate history integrity and cross-language tooling

### Confirmed files

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/env/CIC-Test.env.example
scripts/uk-aq-history-integrity/env/LIVE.env.example
docs/history-integrity.md
system_docs/uk-aq-history-integrity.md
```

Include AQI gap-check scripts and other local integrity utilities found in Phase 0.

### Work

1. Add `UK_AQ_R2_HISTORY_VERSION` to each deployed integrity environment.
2. Remove hardcoded `history/v1/core` from TEST and LIVE examples.
3. During launcher preflight, invoke the shared profile CLI once.
4. Pass the resolved JSON/profile fields to Python.
5. Derive Dropbox paths from:

```text
UK_AQ_R2_HISTORY_DROPBOX_ROOT + selected relative profile prefix
```

6. Keep source-to-target migration checks explicit. The integrity run for the active system uses the active profile; migration validation may explicitly request v2 while LIVE remains active on v1.
7. Record `history_version` and selected relative roots in reports and SQLite run metadata.
8. Update guardrails so TEST and LIVE path checks still prevent cross-environment access.
9. Preserve the v2 hierarchy validation contract.
10. Preserve an archived/tagged v1-capable integrity version and a rollback runbook, because the chosen no-mirror strategy may require rebuilding missing v1 days after a rollback.

### Tests

- TEST v1 and TEST v2 profile path resolution;
- LIVE v1 and LIVE v2 profile path resolution;
- cross-environment guardrails;
- missing profile CLI or invalid output fails preflight;
- no scan begins before profile resolution succeeds;
- explicit non-active v2 migration validation is clearly reported;
- current v2 connector/day/pollutant validation remains unchanged.

### Acceptance criteria

- Integrity no longer hardcodes a storage version in environment paths.
- The same profile source used by workers determines the integrity Dropbox layout.

---

## Phase 6: Simplify workflows and GitHub configuration

### Work

1. Update all history-dependent workflows to pass:

```text
UK_AQ_R2_HISTORY_VERSION
```

2. Remove normal workflow wiring for standard history prefixes after every consumer uses the shared profile.
3. Update `config/uk_aq_github_env_targets.csv`:
   - retain `UK_AQ_R2_HISTORY_VERSION`;
   - mark old path variables deprecated during transition;
   - remove them after Phase 9.
4. Add the shared profile/version files to every relevant workflow `paths:` trigger.
5. Add a CI validation script that scans active code and workflow files for prohibited direct history layout references outside an allowlist.
6. Add a deployment/profile report command that shows, for each history-dependent deployment:
   - selected version;
   - selected observations prefix;
   - selected AQI data prefix;
   - selected index root;
   - deployment revision or worker version.
7. Create a coordinated rollout runbook or workflow that redeploys all history-dependent components after the repository variable changes.

Suggested deployment group:

```text
uk-aq-prune-daily
uk-aq-observs-history-r2-api
uk-aq-aqi-history-r2-api
uk-aq-r2-history-dropbox-backup
uk-aq-db-size-logger
uk-aq-observs-partition-maintenance-service
uk-aq-aqilevels-retention-service
history coverage/metrics/dashboard workers identified in Phase 0
```

8. Do not assume that changing the GitHub variable updates already deployed Cloud Run or Cloudflare services. The rollout must redeploy them.

### Static CI rules

Fail when active code introduces:

- a deprecated split version variable;
- `UK_AQ_R2_HISTORY_INDEX_VERSION` as an active environment selector;
- a direct standard `history/v1/...` or `history/v2/...` path outside the shared profile and approved migration/test files;
- a history-dependent deployment without `UK_AQ_R2_HISTORY_VERSION`;
- a workflow that deploys a profile consumer but does not trigger on shared profile changes.

Allowlist examples:

- profile definitions;
- migration scripts that explicitly name source and target layouts;
- tests;
- archived files;
- historical runbooks;
- API route versions unrelated to storage.

### Acceptance criteria

- The normal repository/environment configuration has one history version variable.
- A version change has a documented redeployment list and verification command.

---

## Phase 7: TEST migration and cutover validation

TEST already has significant v2 data and tooling. Use this phase to prove the final shared-profile behaviour, not merely to copy files.

### Preparation

1. Merge profile-aware code while preserving current TEST behaviour.
2. Put both retention services into dry-run for the first coordinated deployment.
3. Record current v1 and v2 coverage, inventory and API samples.
4. Confirm migration scripts resolve explicit source `v1` and target `v2` profiles.

### Build/catch-up sequence

Use the existing migration tooling and tracked runbook, updated to the shared profile interface:

1. Build/confirm latest v2 core.
2. Ensure local Dropbox has v2 core.
3. Build missing v2 observations from v1 in manageable date chunks.
4. Build observations inventory and sync.
5. Build missing v2 AQI data/debug.
6. Build/repair v2 indexes and timeseries metadata.
7. Build final v2 inventory and sync.
8. Run history-integrity v2 validation.
9. Compare representative API results and website charts.

### Cutover

1. Set:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

2. Redeploy all history-dependent services using the coordinated runbook.
3. Verify each service logs or reports v2 and the expected profile paths.
4. Run prune in a controlled invocation.
5. Run both retention services in dry-run.
6. Confirm candidates and manifest paths.
7. Enable retention only after dry-run output is correct.
8. Verify website observation lines, AQI bars, range stitching and gap metadata.

### Rollback drill

Before LIVE migration, perform a controlled TEST drill:

1. set version to v1;
2. redeploy all history-dependent services;
3. confirm all resolve v1, including both retention services;
4. keep retention dry-run during the drill;
5. identify any v1 gap created while v2 was active;
6. prove the retained older integrity/backfill route can rebuild or plan that gap;
7. switch TEST back to v2 and redeploy all services;
8. confirm no manual path variables were needed.

### Acceptance criteria

- One variable plus coordinated redeployment switches the complete TEST history stack.
- No service remains on the previous version.
- A rollback gap can be identified and repaired without a mirror.

---

## Phase 8: LIVE code preparation and v1-to-v2 migration

### Step 1: Deploy profile-aware code while LIVE remains v1

1. Port the tested commits to the LIVE ops repo.
2. Set or retain:

```text
UK_AQ_R2_HISTORY_VERSION=v1
```

3. Deploy all profile-aware services.
4. Verify behaviour is unchanged:
   - v1 writer;
   - v1 APIs;
   - v1 backup;
   - v1 retention gates;
   - v1 integrity paths.
5. Keep retention dry-run for the first profile-aware LIVE deployment, then restore normal operation after verification.

### Step 2: Build v2 without changing active LIVE version

Use explicit manual migration profiles:

```text
source=v1
target=v2
```

Recommended order:

1. build v2 core;
2. build historical v2 observations;
3. build observations inventory and sync;
4. build historical v2 AQI data/debug;
5. build v2 indexes and metadata;
6. build final inventory and Dropbox backup;
7. run full v2 integrity validation;
8. compare v1/v2 counts and representative API outputs.

### Step 3: Final catch-up

Because there is no mirror, v1 may continue receiving new days while the historical v2 migration runs.

Immediately before cutover:

1. stop or avoid overlapping prune/history runs for the cutover window;
2. migrate the remaining recent days into v2;
3. rebuild affected v2 indexes;
4. refresh inventory and Dropbox backup;
5. validate the final recent-day overlap;
6. confirm v2 manifests exist for every day that retention may delete.

### Step 4: Cut over LIVE

1. Set:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

2. Redeploy the whole history-dependent deployment group.
3. Verify every service reports the v2 profile.
4. Run API and website smoke tests.
5. Run retention in dry-run.
6. Enable retention after the candidate paths and manifests are confirmed.
7. Keep v1 R2 data read-only and undeleted.

### Step 5: Rollback position

After cutover, v1 will stop receiving new data and will become stale.

If a rollback is required:

1. disable or dry-run destructive retention;
2. set the canonical version back to v1;
3. redeploy the complete history stack;
4. use the retained v1 integrity/backfill tooling to rebuild the missing post-cutover observation days;
5. rebuild corresponding v1 AQI and indexes as required;
6. validate before restoring normal retention.

Create and retain before cutover:

- a git tag or immutable branch for the final known-good v1 integrity/backfill tooling;
- a v1 rebuild runbook;
- a list of required credentials and local paths;
- a smoke-test set for v1 observations and AQI.

### Acceptance criteria

- LIVE code can run v1 or v2 from the same branch.
- v2 is fully built and validated before the active version changes.
- the final catch-up closes the no-mirror gap at cutover.
- rollback steps are documented and tested in TEST.

---

## Phase 9: Retire legacy variables and eventually v1

This phase should not start immediately after cutover.

### First cleanup: remove ambiguous configuration

After TEST and LIVE have both operated successfully with shared profiles:

1. remove deprecated prefix variables from normal workflows;
2. remove them from GitHub repository/environment variables;
3. remove them from `config/uk_aq_github_env_targets.csv`;
4. remove compatibility override code;
5. remove `UK_AQ_R2_HISTORY_INDEX_VERSION`;
6. update all docs to show only the canonical active version and explicit manual CLI versions.

### Later cleanup: retire v1 runtime support

Only after v2 has been stable for an agreed period and v1 rollback is no longer required:

1. freeze a final v1 inventory and validation report;
2. confirm no scheduled service resolves v1;
3. remove v1 from the accepted active version values, or keep it available only to offline migration tools for a defined period;
4. remove v1 runtime branches from APIs, writer and retention services;
5. remove v1 data only through a separate approved deletion plan;
6. retain archived code/runbooks long enough to meet recovery requirements.

A future v3 should be added by creating a new profile and capability set, not by adding another family of independent path variables.

---

# 6. Testing and validation matrix

## 6.1 Unit tests

| Component | v1 | v2 | Invalid/missing |
|---|---:|---:|---:|
| Shared profile | Required | Required | Required |
| Prune writer | Required | Required | Required |
| Observations API | Required | Required | Required |
| AQI API | Required | Required | Required |
| Index builder | Required | Required | Required |
| Backup inventory/sync | Required | Required | Required |
| Observs retention | Required | Required | Required |
| AQI retention | Required | Required | Required |
| Integrity profile bridge | Required | Required | Required |
| Migration source/target | v1→v2 required | v2→v1 optional repair case | same-version accident guard |

## 6.2 Integration checks

For each selected version verify:

- day manifest key;
- connector manifest key;
- pollutant manifest key where applicable;
- Parquet data prefix;
- index root;
- timeseries index prefix;
- backup inventory path;
- backup checkpoint path;
- API response metadata;
- run-start structured logs;
- retention dry-run manifest paths.

## 6.3 Downstream smoke tests

- PM2.5/PM10/NO2 line history through cache proxy;
- pollutant propagation for v2 observations;
- AQI history bars;
- R2-first stitching and recent Supabase tail;
- missing-manifest partial/gap metadata;
- history coverage/dashboard endpoints;
- Dropbox backup readiness gate;
- daily task health status.

## 6.4 Destructive safety tests

- populated observations partition plus missing selected-version manifest: skip;
- populated observations partition plus invalid selected-version manifest: skip;
- empty observations partition plus missing manifest: empty-only fallback may drop;
- AQI day plus missing selected-version manifest: skip;
- dry-run: no drops;
- selected v2 while only v1 manifest exists: skip;
- selected v1 while only v2 manifest exists: skip.

---

# 7. Deployment order for a version change

A version variable change must be followed by deployment. Recommended order:

1. disable or dry-run destructive retention;
2. deploy shared-profile code and normal writer/prune service;
3. deploy observations and AQI history APIs;
4. run/rebuild selected indexes as required;
5. run selected-version backup inventory and Dropbox sync;
6. deploy history coverage/metrics/dashboard consumers;
7. deploy observs partition maintenance;
8. deploy AQI-level retention;
9. verify all resolved-version reports;
10. run retention dry-runs;
11. re-enable normal retention.

The exact deployment list must be generated from the Phase 0 consumer inventory and kept in the system documentation.

---

# 8. Recommended implementation split

To keep reviews manageable, use separate PRs or Codex tasks:

1. **Profile foundation and audit**
2. **Reader/API migration**
3. **Index and backup migration**
4. **Writer/backfill/migration-tool migration**
5. **Observs and AQI retention migration**
6. **Integrity cross-language bridge**
7. **Workflow/env cleanup and CI drift guard**
8. **TEST cutover and rollback drill documentation**
9. **LIVE migration runbook**
10. **Legacy variable removal after successful rollout**

Do not combine the profile foundation, all consumers and the TEST cutover into one unreviewable change.

---

# 9. Final acceptance criteria

The project is complete when:

1. `UK_AQ_R2_HISTORY_VERSION` is the only required active history layout setting.
2. All standard paths come from one shared profile implementation.
3. All active Node/TypeScript consumers import the shared profile directly.
4. Python/shell integrity obtains the same profile through the shared CLI.
5. Manual migration tools can explicitly read v1 and write v2 without changing LIVE's active version.
6. Both destructive retention services use the selected profile and fail closed.
7. No active workflow hardwires v1 or v2 for a normal service.
8. No independent index version environment variable remains.
9. CI prevents new active direct path mappings outside the profile.
10. TEST can switch v2→v1→v2 using one variable plus coordinated redeployment.
11. LIVE can receive the same code while staying on v1, build v2 separately, then cut over using the same switch.
12. v1 remains untouched until a separate retirement decision.
13. The DB-size logger resolves and reports the same profile as the rest of the active stack, so a redeployment cannot silently revert one domain metric to v1.

---

# 10. Current-code references used for this plan

Primary confirmed files in `TEST-uk-aq/uk-aq-ops`:

```text
workers/shared/uk_aq_r2_history_version.mjs
workers/shared/uk_aq_r2_history_index.mjs
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
workers/uk_aq_observs_history_r2_api_worker/wrangler.toml
workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
workers/uk_aq_aqi_history_r2_api_worker/wrangler.toml
workers/uk_aq_observs_partition_maintenance_service/server.mjs
workers/uk_aq_aqilevels_retention_service/server.mjs
workers/uk_aq_db_size_logger_cloud_run/run_job.ts
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/lib/inventory.mjs
scripts/backup_r2/uk_aq_build_r2_history_index.mjs
scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs
scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs
scripts/uk_aq_backfill_local.sh
workers/uk_aq_backfill_local/run_job.ts
scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs
scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh
scripts/uk-aq-history-integrity/
.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml
.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml
.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml
.github/workflows/uk_aq_r2_history_dropbox_backup.yml
.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml
.github/workflows/uk_aq_aqilevels_retention_cloud_run_deploy.yml
.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml
config/uk_aq_github_env_targets.csv
plans/R2_v2_implementation_plans/uk_aq_r2_history_v2_cic_test_build_validation_runbook_tracking.md
```

The Phase 0 audit must expand this list before implementation begins.

---

# 11. Gemini Pro in Antigravity execution protocol

## 11.1 Suitability and limits

Gemini Pro in Antigravity is suitable for this migration when the work is divided into small, reviewable phases. It must not be asked to implement Phases 0 to 9 in one autonomous task.

The highest-risk areas are:

- destructive retention;
- version and prefix defaults;
- workflow deployment wiring;
- migration tools that deliberately read one profile and write another;
- preservation of existing uncommitted work;
- direct R2, Supabase, Cloud Run, Cloudflare or GitHub configuration changes.

No prompt can guarantee an error-free implementation. The controls below are intended to make mistakes visible before they affect deployed services or R2 data.

## 11.2 Mandatory operating rules for every Antigravity task

Paste this block at the start of every phase prompt:

```text
You are working on the UK AQ R2 history shared-profile migration.

Authoritative plan:
plans/2026-07-12 R2 History Version Shared Profile/UK_AQ_R2_History_Shared_Profile_Migration_Plan_2026-07-12.md

Writable repository:
TEST-uk-aq/uk-aq-ops

Read-only audit repositories, only when the phase explicitly requires them:
TEST-uk-aq/uk-aq-ingest
TEST-uk-aq/uk-aq-schema
TEST-uk-aq/TEST-uk-aq-root.github.io

Hard safety rules:

1. Work only on the named phase. Do not implement later phases.
2. Before editing, read the relevant plan section, inspect git status, and report any pre-existing uncommitted changes.
3. Preserve all pre-existing user changes. Never reset, restore, discard, overwrite or reformat unrelated files.
4. Exclude archive/** from searches that drive changes. Archives are read-only historical records.
5. Do not use broad search-and-replace across the repository.
6. Do not commit, push, open a pull request, deploy, change GitHub variables or secrets, invoke Cloud Run, invoke Cloudflare deployment, alter Supabase, alter GCP, or write/delete R2 objects.
7. Do not run migration, retention, prune, backfill or repair commands that can contact live services or mutate data.
8. Do not change API route versions such as /v1/observations. They are unrelated to R2 storage versions.
9. Do not introduce a silent v1 fallback. Missing or invalid UK_AQ_R2_HISTORY_VERSION must fail closed for active services.
10. Do not add a request-level history-version override to runtime APIs or scheduled services.
11. Manual migration tools may use explicit CLI source/target version options only where the plan authorises them.
12. Keep TEST and LIVE selectable from the same code. Do not hardwire v2 globally.
13. Prefer the smallest coherent change. Do not refactor unrelated code.
14. Add or update focused tests for every changed selection or safety boundary.
15. Run syntax checks, the focused tests for the phase, and git diff --check.
16. At the end, stop and report:
    - findings confirmed against current code;
    - files changed;
    - exact behaviour before and after;
    - tests and checks run with results;
    - unresolved risks or follow-up work;
    - confirmation that no deployment or external mutation occurred.
17. If the current code contradicts the plan, stop before implementing the contradictory part and explain the evidence. Do not guess.
18. If a required file, environment contract or test cannot be confirmed, stop and ask for review rather than inventing it.
```

## 11.3 Prompt A: Phase 0 consumer and path audit

```text
[Paste the mandatory operating rules above.]

Perform Phase 0 only. This is an audit and plan-update task, not an implementation task.

Required work:

1. Search active, non-archive files for all version variables, prefix variables and direct R2 history paths listed in Phase 0.
2. Include the newly discovered DB-size logger:
   - workers/uk_aq_db_size_logger_cloud_run/run_job.ts
   - .github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml
3. For each consumer, record:
   - runtime or job;
   - read, write, list or delete role;
   - whether it is destructive;
   - current version selector;
   - current default and override behaviour;
   - exact data, manifest, index, core, run, inventory and checkpoint paths;
   - deployment workflow;
   - workflow paths trigger coverage;
   - proposed migration phase.
4. Distinguish R2 storage versions from API route versions and unrelated schema versions.
5. Audit the three downstream repositories read-only. Do not modify them.
6. Update only the authoritative plan and a dedicated checked-in Phase 0 inventory file.
7. Explicitly identify every place that can silently fall back to v1 or combine a v2 version with a v1 prefix.
8. Explicitly identify every service that must be redeployed when the shared profile changes.
9. Do not implement the shared profile or migrate consumers.

Acceptance evidence:

- a complete inventory table;
- a list of direct path literals that remain allowed and why;
- a list of unclassified references, if any;
- no code changes outside the plan and inventory;
- no deployment or external mutation.

Stop after the audit report and plan diff.
```

## 11.4 Prompt B: Phase 1 shared-profile foundation

```text
[Paste the mandatory operating rules above.]

Implement Phase 1 only after confirming Phase 0 is complete.

Required behaviour:

1. Create workers/shared/uk_aq_r2_history_profile.mjs.
2. Keep workers/shared/uk_aq_r2_history_version.mjs as the only parser and validator for UK_AQ_R2_HISTORY_VERSION.
3. Implement exact immutable v1 and v2 profiles from the authoritative plan.
4. Use explicit null for unsupported fields.
5. Add:
   - getR2HistoryProfile(version)
   - resolveR2HistoryProfile(env, options = {})
   - assertR2HistoryProfile(profile)
6. Create scripts/uk_aq_r2_history_profile.mjs with deterministic json, env and human-readable output.
7. Missing or invalid version must fail. Do not default to v1.
8. Deprecated split version variables must fail with a clear message.
9. Do not migrate any runtime consumer in this phase.
10. Do not retain compatibility prefix overrides unless the current code proves they are required for a staged release. If they are required, stop and present the exact compatibility design before implementing it.

Required tests:

- exact v1 profile;
- exact v2 profile;
- missing and invalid version;
- deprecated split variables;
- immutability;
- null fields;
- deterministic CLI JSON;
- shell-safe CLI env output;
- exact error messages where callers rely on them.

Run only focused tests, syntax checks and git diff --check. Stop after reporting the Phase 1 diff.
```

## 11.5 Prompt C: Phase 2 readers, indexes and DB-size logger

```text
[Paste the mandatory operating rules above.]

Implement Phase 2 only. The Phase 1 profile must already exist and pass its focused tests.

Migrate only:

- observations history R2 API;
- AQI history R2 API;
- shared index selection;
- manual history index builder;
- DB-size logger and its deployment workflow;
- any additional non-destructive reader confirmed by the Phase 0 inventory and explicitly assigned to Phase 2.

DB-size logger requirements:

1. Resolve observations_prefix and aqilevels_hourly_data_prefix from the shared profile.
2. For v2, count:
   - history/v2/observations
   - history/v2/aqilevels/hourly/data
3. Do not count history/v2/aqilevels/hourly/debug as the AQI domain size.
4. For v1, retain:
   - history/v1/observations
   - history/v1/aqilevels/hourly
5. Remove silent v1 defaults from active selection.
6. Log history_version and the two exact counted prefixes at startup and in the summary.
7. Update the workflow paths trigger to include both shared history modules.
8. Pass UK_AQ_R2_HISTORY_VERSION during deployment.
9. Do not change GitHub variables or deploy.

General requirements:

- preserve API routes;
- remove UK_AQ_R2_HISTORY_INDEX_VERSION as an independent active selector only where Phase 2 authorises it;
- retain explicit --history-version only for the manual index command;
- do not change writer, backup, retention or integrity consumers yet.

Tests must prove v1, v2 and missing-version behaviour for every migrated consumer. Stop after the focused tests and diff report.
```

## 11.6 Prompt D: Phase 3 backup, writer and migration tooling

```text
[Paste the mandatory operating rules above.]

Implement Phase 3 only. Do not touch retention or history-integrity code.

Before editing, classify every named tool as one of:

- normal active writer or backup, controlled by UK_AQ_R2_HISTORY_VERSION;
- manual single-profile tool, with optional explicit --history-version;
- migration tool, requiring explicit source and target profiles.

Requirements:

1. Replace duplicated path maps with the shared profile.
2. Preserve v1 and v2 output formats and established migration ordering.
3. Normal backup and prune jobs must use one active profile.
4. Migration tools must be able to read v1 and write v2 while the active environment remains v1.
5. A migration tool must reject ambiguous or accidental same-source/same-target operation unless the existing command has a separately documented safe purpose.
6. Reports must include resolved source and target profile values.
7. Do not contact R2, Supabase, GCP, Cloudflare or GitHub during tests.
8. Use fakes or existing local unit fixtures for write-path tests.
9. Do not run real backfills, prune, migration or backup sync commands.

Stop after focused tests, syntax checks and a precise before/after report.
```

## 11.7 Prompt E: Phase 4 destructive retention

```text
[Paste the mandatory operating rules above.]

Implement Phase 4 only. This is a high-risk destructive-safety phase.

Additional restrictions:

- Do not run either service against Supabase or R2.
- Do not weaken or bypass any existing fail-closed gate.
- Do not change drop eligibility, retention age or partition selection except where profile selection requires it.
- Do not enable non-dry-run behaviour.
- Do not deploy.

Observations retention must select profile.observations_prefix.
AQI retention must select profile.aqilevels_hourly_data_prefix.
For v2, AQI deletion readiness must use the data manifest, not the debug tree.

Tests must prove:

- exact v1 and v2 manifest keys;
- missing or invalid version fails before external access;
- a manifest from the wrong version never authorises deletion;
- missing or invalid manifest blocks populated deletion;
- dry run never deletes;
- existing observations empty-partition fallback remains unchanged and limited;
- no other deletion criteria changed.

Use mocked or fake external interfaces and inspect every changed call site. Stop after the test evidence and request human review before any deployment.
```

## 11.8 Prompt F: Phase 5 history-integrity bridge

```text
[Paste the mandatory operating rules above.]

Implement Phase 5 only.

Requirements:

1. Use the shared Node profile CLI as the only cross-language path source.
2. The shell launcher must resolve the profile once during preflight.
3. Python must receive and validate the resolved profile rather than maintain a duplicate v1/v2 map.
4. Construct Dropbox paths from the environment-specific Dropbox root plus selected relative profile fields.
5. Preserve TEST/LIVE cross-environment protections.
6. Preserve current v2 hierarchy validation.
7. Explicit non-active migration validation must be reported as an override and must not alter the active environment.
8. Missing CLI, invalid JSON, missing fields or a version mismatch must fail before scanning.
9. Do not run real integrity repair, backfill or R2-write modes.

Use fixtures and temporary directories for tests. Stop after focused tests and a full list of removed hardcoded history paths.
```

## 11.9 Prompt G: Phase 6 workflow cleanup and drift guard

```text
[Paste the mandatory operating rules above.]

Implement Phase 6 only after all active consumers have been migrated.

Requirements:

1. Use the Phase 0 inventory as the authoritative deployment list.
2. Remove normal workflow wiring for standard history prefixes only after proving each corresponding runtime resolves the shared profile.
3. Retain UK_AQ_R2_HISTORY_VERSION.
4. Remove UK_AQ_R2_HISTORY_INDEX_VERSION from active workflow configuration only after confirming no active consumer requires it.
5. Add shared profile/version files to every relevant workflow paths trigger.
6. Add a static CI drift guard with a narrow, reviewed allowlist.
7. The drift guard must ignore archive/** and must not confuse /v1 API routes with storage paths.
8. Add a report command that shows each deployment and its selected profile fields without deploying.
9. Include the DB-size logger in the coordinated deployment list.
10. Do not alter repository variables, secrets or deployed services.

Stop after tests for the drift guard, workflow validation where available, and git diff --check.
```

## 11.10 Prompt H: independent review after each implementation phase

Run this in a fresh Antigravity task or with a different model from the implementation task:

```text
Review the current uncommitted diff for the completed R2 shared-profile phase.

Do not edit files initially.

Check specifically for:

1. silent v1 fallbacks;
2. mixed v1/v2 paths;
3. direct path literals outside the shared profile;
4. API route versions accidentally changed;
5. workflow paths triggers missing shared modules;
6. a normal runtime accepting a request-level version override;
7. migration source and target confusion;
8. v2 AQI data/debug prefixes swapped;
9. v1 behaviour unintentionally changed;
10. destructive retention gates weakened;
11. tests that merely assert mocks rather than the selected keys and prefixes;
12. archive files or unrelated user changes touched;
13. deployment, external mutation or credential exposure;
14. DB-size logger counting the wrong AQI tree.

Return findings ordered by severity with file and line references. If there are no findings, state what you inspected and what remains unverified. Do not make fixes until the user approves the review findings.
```

## 11.11 Prompt I: TEST cutover preparation, no deployment

```text
[Paste the mandatory operating rules above.]

Prepare the Phase 7 TEST cutover runbook only. Do not deploy or change variables.

Use the completed Phase 0 inventory to produce:

- the exact repository variable change;
- the exact list and order of services to redeploy;
- the expected v2 prefix report for every service;
- pre-cutover checks;
- retention dry-run steps;
- API and website smoke tests;
- DB-size logger verification;
- rollback to v1 steps;
- commands that are read-only versus commands that mutate;
- explicit human approval gates before every mutating command.

Do not execute any command that contacts or mutates GitHub settings, Cloud Run, Cloudflare, Supabase or R2. Stop with the runbook for review.
```

## 11.12 Recommended Antigravity workflow

For each phase:

1. Start a fresh task with the mandatory operating rules and one phase prompt.
2. Require a plan or task-list artifact before edits.
3. Review and comment on that artifact.
4. Allow implementation only for the named phase.
5. Run the independent review prompt in a separate task.
6. Inspect the Git diff yourself before committing.
7. Deploy only through a separately reviewed deployment or cutover task.

Do not give Antigravity unrestricted autonomous permission for the whole migration or for destructive production commands.

