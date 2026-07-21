# LIVE beta migration to UK-AQ repositories and ukaq.co.uk

**Date:** 21 July 2026  
**Target environment:** LIVE beta  
**Planning repository:** `TEST-uk-aq/uk-aq-ops`  
**Plan path:** `plans/2026-07-21_LIVE_beta_to_UK-AQ_migration/2026-07-21_LIVE_beta_to_UK-AQ_migration_plan.md`  
**Status:** Implementation and cutover plan

## 1. Purpose

Move the LIVE beta from:

- repositories in the legacy `Chronic-Illness-Channel` organisation;
- the `chronicillnesschannel.co.uk` domain;
- R2 history v1;

to:

- repositories in the `UK-AQ` organisation;
- the `ukaq.co.uk` domain;
- the new LIVE R2 history v2 bucket.

The migration will continue to use the existing LIVE Supabase projects, tables, schemas and data.

The new LIVE R2 bucket already contains LIVE observation history in v2 format, generated from the legacy LIVE R2 v1 data. Before cutover it still needs:

1. any observation-history delta created since the v2 conversion;
2. v2 AQI-level history;
3. v2 observation and AQI indexes;
4. core and timeseries-binding verification;
5. a completed Dropbox backup before changes and another after completion;
6. targeted integrity validation.

The old and new operational stacks must never run their writers concurrently against the same Supabase tables.

## 2. Recommended end state

```text
UK-AQ GitHub organisation
  ├── UK-AQ/uk-aq-root.github.io
  ├── UK-AQ/uk-aq-ingest
  ├── UK-AQ/uk-aq-ops
  ├── UK-AQ/uk-aq-schema
  └── UK-AQ/uk-aq-population-ingest

ukaq.co.uk
  ├── website
  ├── public AQ API route
  ├── Cloudflare cache proxy
  └── R2-backed API Workers

Existing LIVE Supabase projects
  ├── IngestDB
  ├── ObsAQIDB
  └── existing schemas, RPCs, tables and data

New LIVE R2 v2 bucket
  ├── history/v2/core
  ├── history/v2/observations
  ├── history/v2/aqilevels/hourly/data
  ├── history/_index_v2
  └── current backup inventory and Dropbox mirror
```

The legacy repositories, website, schedules, Cloudflare resources and R2 v1 data remain available but disabled during the rollback window.

## 3. Fixed decisions

### 3.1 Supabase remains unchanged

- Continue using the current LIVE Supabase projects and credentials.
- Do not create a second LIVE Supabase environment.
- Do not run schema migrations merely because the repository owner or domain changes.
- Change Supabase data only if a configuration row stores an old hostname, repository URL, callback URL or service endpoint that must change.
- Because both stacks use the same databases, only one set of writers may be active.

### 3.2 R2 v2 is the target history authority

- Set `UK_AQ_R2_HISTORY_VERSION=v2`.
- Do not cut over while required v2 AQI history or indexes are missing.
- Do not delete or rewrite the legacy R2 v1 tree during this migration.
- Preserve R2 index byte stability.
- Do not use `--compute-missing-timeseries-counts` unless a dry-run proves it is required. It can patch source manifests and cause another inventory and Dropbox backup cycle.

### 3.3 Backup before R2 mutation

Before generating AQI history, rebuilding manifests, repairing indexes or replacing any v2 object:

- complete a Dropbox backup of the new LIVE R2 v2 data;
- confirm the inventory completed successfully;
- confirm no backup or R2 writer is still running;
- record the backup run ID and completion time;
- retain the pre-change inventory and reports.

After AQI history, bindings and indexes are complete, run a second Dropbox backup.

### 3.4 Single-writer cutover

The following must not run from both organisations at the same time:

- network ingests;
- observations outbox flush;
- AQI generation;
- Prune Daily;
- observations partition maintenance;
- R2 core snapshot;
- R2 Dropbox backup;
- integrity repair or backfill;
- any other workflow that writes to the shared Supabase databases or history bucket.

Read-only websites and APIs may run in parallel during preparation.

### 3.5 Keep rollback resources

Until the migration is accepted:

- do not delete the legacy repositories;
- do not delete legacy Cloud Run services;
- do not delete legacy Cloudflare Workers;
- do not delete R2 v1 objects;
- do not revoke old deployment identities;
- do not remove the old domain;
- keep old schedules present but disabled.

### 3.6 Keep the existing GCP project initially

This plan assumes the current LIVE GCP project and deployed services remain in use initially.

Repository authentication and deployment ownership may move to `UK-AQ`, but a GCP account or project migration should be handled separately unless it is unavoidable. Combining both changes would make fault isolation and rollback harder.

### 3.7 Validation policy

Do not create broad speculative test suites.

Before deployment, use only structural checks such as:

- syntax checks;
- YAML parsing;
- Wrangler configuration parsing or generation;
- shell syntax checks;
- `git diff --check`;
- secret scanning;
- confirmation that repository, bucket and hostname values point to the intended LIVE resources.

Functional validation should happen through real beta operation after deployment.

A targeted pre-cutover R2 validation is required because AQI generation, manifest replacement and index writes are bulk data operations.

## 4. Repository mapping

Confirm all local remotes before committing.

| System | TEST source | New LIVE target |
|---|---|---|
| Website | `TEST-uk-aq/TEST-uk-aq-root.github.io` | `UK-AQ/uk-aq-root.github.io` |
| Ingest | `TEST-uk-aq/uk-aq-ingest` | `UK-AQ/uk-aq-ingest` |
| Ops | `TEST-uk-aq/uk-aq-ops` | `UK-AQ/uk-aq-ops` |
| Schema | `TEST-uk-aq/uk-aq-schema` | `UK-AQ/uk-aq-schema` |
| Population ingest | confirm the local TEST repository name | `UK-AQ/uk-aq-population-ingest` |

The new ops, ingest, schema and population repositories are currently empty on GitHub. The website repository exists and its `CNAME` is already:

```text
ukaq.co.uk
```

Treat the local copies populated by `sync_to_live.sh` as uncommitted migration inputs until each repository has been inspected.

## 5. Acceptance criteria

The migration is accepted only when:

1. All intended code is committed to the correct `UK-AQ` repositories.
2. No TEST secrets, TEST buckets or TEST service identities remain active in the new LIVE configuration.
3. The new R2 bucket contains complete v2 core, observations, AQI and indexes for the intended range.
4. The v2 timeseries binding index resolves all active history timeseries.
5. A post-build Dropbox backup completes.
6. R2 observation and AQI APIs return expected data.
7. `ukaq.co.uk` serves the intended website.
8. Supabase authentication returns to `ukaq.co.uk`.
9. Recent data uses the existing Supabase system and older history uses new R2 v2.
10. Only the new writer stack is enabled.
11. One normal ingest cycle succeeds.
12. One normal AQI generation succeeds.
13. One normal Prune Daily run succeeds.
14. One normal observations partition-maintenance run succeeds.
15. One normal core snapshot and Dropbox backup cycle succeeds.
16. Task health identifies the new repository and shows successful runs.
17. No duplicate writer pattern appears.
18. The legacy stack remains available but disabled for rollback.

## 6. Phase 0: record the baseline

**Owner:** User, assisted by ChatGPT  
**Permission:** Read-only inventory and local preparation

Record:

- exact old LIVE repository URLs;
- exact new `UK-AQ` repository URLs;
- current TEST source commit SHAs;
- `git status --short` and `git remote -v` for each local target;
- LIVE Supabase project URLs and refs, without secret values;
- current GCP project ID and region;
- Cloudflare account IDs used for domain, R2, scheduler and D1;
- old and new LIVE R2 bucket names;
- oldest and newest committed v2 observation days;
- the last day included in the original conversion;
- current website, API and Worker hostnames;
- current scheduler jobs and enabled states;
- latest successful task-health records;
- latest successful Dropbox backup.

Do not store secret values in the plan, migration log or Git history.

### Phase 0 gate

Do not continue until:

- target remotes are unambiguous;
- old and new buckets are unambiguous;
- the conversion high-water mark is known;
- rollback controls are known;
- the pre-change Dropbox backup has completed.

## 7. Phase 1: prepare and commit the UK-AQ repositories

**Owner:** User  
**Recommended coding assistance:** GPT-5.6 Codex with High reasoning  
**Permission:** Local changes and GitHub commits only

### 7.1 Prevent accidental workflow execution

Before the first push:

1. Temporarily disable GitHub Actions in each empty target repository, or otherwise guarantee copied workflows cannot run.
2. Keep Pages deployment disabled until the website is inspected.
3. Do not enable scheduled or push-triggered LIVE workflows.
4. Do not populate scheduler tokens until targets are ready.
5. Do not enable Cloudflare scheduler jobs merely because code has been pushed.

### 7.2 Inspect each local sync

Run:

```bash
git status --short
git remote -v
git branch --show-current
git diff --stat
git diff --check
```

Confirm:

- the remote is the intended `UK-AQ` repository;
- the branch is `main`;
- no `.env`, `.env.supabase`, credential, log, state or Dropbox file is staged;
- no nested `.git` directory was copied;
- generated output was not copied unnecessarily;
- the website `CNAME` was preserved;
- the sync did not delete target-specific configuration.

### 7.3 Commit a baseline

Commit the synced code separately in each repository.

Suggested message:

```text
Initial LIVE beta code sync from TEST
```

Do not combine secret provisioning, cloud deployment or R2 data changes with the baseline commit.

### Phase 1 gate

- All target repositories have a committed baseline.
- Working trees are clean except for documented migration changes.
- Actions remain disabled or inert.
- No deployment has occurred.

## 8. Phase 2: make the copied code environment-correct

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1, with Level 2 only for narrow structural checks

This is an environment migration, not a business-logic rewrite.

### 8.1 Required reading

Read the relevant:

- `AGENTS.md`;
- authoritative `system_docs/`;
- deployment workflows;
- environment and secret-sync scripts;
- Worker `wrangler.toml` files;
- scheduler configuration;
- website configuration and domain files.

In `uk-aq-ops`, include:

- `config/uk_aq_github_env_targets.csv`;
- `scripts/uk_aq_sync_github_secrets.sh`;
- `cloudflare/scheduler/jobs.toml`;
- `cloudflare/scheduler/wrangler.toml`;
- cache proxy and R2 API Worker Wrangler files;
- active deploy workflows;
- R2 core, backup, index and integrity scripts.

### 8.2 Search for environment-specific values

Use `grep`, not `rg`.

Inspect active files for:

```text
TEST-uk-aq
Chronic-Illness-Channel
ChronicChannel
chronicillnesschannel.co.uk
CIC-Test
uk-aq-history-cic-test
history/v1
old repository names
old Worker names
old Pages project names
old R2 buckets
old API hostnames
old scheduler targets
```

Do not perform a blind global replacement.

Classify each match as:

- active configuration that must change;
- historical documentation that should remain;
- test-only configuration that must remain;
- compatibility behaviour that must remain;
- obsolete active configuration that should be removed.

### 8.3 Required LIVE changes

Prepare configuration so that:

- repository references use `UK-AQ/...`;
- the environment name is `LIVE`;
- the website domain is `ukaq.co.uk`;
- allowed origins contain the exact new origins;
- the old beta origin may remain temporarily for rollback;
- all history readers and writers use the new bucket;
- `UK_AQ_R2_HISTORY_VERSION=v2`;
- v2 prefixes follow the active contract;
- Worker names are unique in their Cloudflare account;
- Pages, dashboard and scheduler names are LIVE-specific;
- scheduler jobs target the `UK-AQ` repositories;
- scheduler jobs remain disabled until cutover;
- no TEST bypass is enabled;
- no bucket safety guard is casually weakened.

### 8.4 LIVE v1-to-v2 guard

The current TEST observation conversion script refuses writes unless the bucket is the exact TEST bucket.

Do not simply remove this protection.

If a final LIVE observation delta requires that script, implement either:

1. a separate LIVE migration wrapper that allow-lists the exact LIVE bucket and requires a confirmation flag; or
2. a generalised guard requiring:
   - `--confirm-live`;
   - `UK_AQ_ENV_NAME=LIVE`;
   - the exact expected LIVE bucket;
   - explicit source and target prefixes;
   - a dry-run report before write mode.

The change must remain narrow and must not permit arbitrary R2 writes.

### 8.5 Structural checks

Run only:

- `git diff --check`;
- syntax checks for changed files;
- YAML parsing;
- Wrangler configuration parsing or generation;
- one focused configuration check if needed.

Do not deploy, dispatch workflows, call Supabase, mutate R2 or run broad suites.

### Phase 2 gate

Codex must report:

- files changed;
- environment values changed;
- values deliberately preserved;
- checks run;
- exact manual secret and deployment commands;
- rollback implications;
- affected `system_docs/` files.

## 9. Phase 3: configure GitHub and GCP authentication

**Owner:** User  
**Recommended command preparation:** GPT-5.6 Codex with High reasoning  
**Permission:** Manual external configuration

### 9.1 Repository settings

For each `UK-AQ` repository:

- confirm default branch `main`;
- configure required Actions permissions;
- configure Pages permissions for the website;
- optionally place deployment workflows behind a `LIVE` approval;
- do not put recurring runtime workflows behind manual approval;
- retain old organisation access during rollback.

### 9.2 Sync secrets and variables

Start with a dry-run from the LIVE ops repository:

```bash
scripts/uk_aq_sync_github_secrets.sh   --repo UK-AQ/uk-aq-ops   --env-file .env   --supabase-env-file .env.supabase   --targets-file config/uk_aq_github_env_targets.csv   --dry-run
```

Review:

- every workflow-referenced secret and variable;
- R2 account ID, endpoint, bucket and credentials;
- Cloudflare account IDs and tokens;
- Supabase URLs and keys;
- Dropbox credentials and LIVE root;
- GCP authentication;
- scheduler dispatch token;
- `SUPABASE_SECRETS_ENV`.

Then perform the actual sync.

Repeat the equivalent review for:

- `UK-AQ/uk-aq-ingest`;
- `UK-AQ/uk-aq-schema`;
- `UK-AQ/uk-aq-population-ingest`;
- `UK-AQ/uk-aq-root.github.io`, where required.

Do not assume the ops target map covers other repositories.

### 9.3 Scheduler token

The scheduler token must:

- be authorised for the private `UK-AQ` repositories;
- be able to dispatch Actions workflows;
- be stored as a Cloudflare Worker secret;
- remain unavailable to website code;
- replace the old token only when the new scheduler is ready.

Update scheduler targets to `UK-AQ/...`, but keep jobs disabled.

### 9.4 GCP authentication

Inspect the current deployment workflows.

If they use Workload Identity Federation:

- add trust for the exact new repository subjects;
- retain the old repository subjects during rollback;
- confirm service-account impersonation and Artifact Registry access;
- do not broaden trust to all GitHub repositories.

If they use `GCP_SA_KEY`:

- add it only to repositories that require it;
- do not commit the JSON;
- retain the current authentication method during this migration.

### Phase 3 gate

- Secret and variable inventories are complete.
- No TEST credential is active in new LIVE repositories.
- New repositories can authenticate to the existing GCP project.
- No runtime workflow is enabled.

## 10. Phase 4: complete the new LIVE R2 v2 history

**Owner:** User, assisted by ChatGPT  
**Recommended coding assistance for a required repair:** GPT-5.6 Codex with High reasoning  
**Permission:** Explicit data operations

This is a hard cutover gate.

### 10.1 Confirm the pre-change backup

Record:

- backup run ID;
- start and completion timestamps;
- inventory path;
- v2 core and observation coverage;
- object and byte counts;
- skipped, invalid or missing objects.

Do not mutate the bucket until this backup is accepted.

### 10.2 Inventory v2

Confirm valid objects under:

```text
history/v2/core
history/v2/observations
history/v2/aqilevels/hourly/data
history/_index_v2
```

For observations, record:

- oldest and newest committed day;
- connector and pollutant coverage;
- day, connector and pollutant manifest counts;
- timeseries row-count availability;
- whether the conversion has become stale.

### 10.3 Catch up observations

If old LIVE has written new v1 days since conversion:

1. identify the missing day range;
2. refresh the old R2 Dropbox backup;
3. dry-run conversion for only the missing range;
4. review object counts and target bucket;
5. write only the missing range;
6. avoid `--replace` unless a specific invalid object is known;
7. record the new high-water mark.

A final delta is still required after old writers are paused in Phase 6.

### 10.4 Generate v2 AQI history

Use the active LIVE backfill path that reads v2 observations and writes only v2 AQI.

First run one representative closed day:

```bash
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh   --env LIVE   --aqi-only   --history-version v2   --from-day YYYY-MM-DD   --to-day YYYY-MM-DD   --dry-run
```

Review:

- selected days and connectors;
- expected AQI objects;
- PM rolling-context availability;
- missing observations;
- blocked dependencies;
- target bucket and prefixes;
- zero planned observation writes.

Then run that day without `--dry-run`.

After it succeeds, process the remaining history in bounded, non-overlapping day ranges:

```bash
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh   --env LIVE   --aqi-only   --history-version v2   --from-day YYYY-MM-DD   --to-day YYYY-MM-DD
```

Do not run overlapping batches concurrently.

The wrapper disables the nested full index rebuild. Build indexes only after required AQI manifests are written and verified.

### 10.5 Build v2 indexes

Run:

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs   --history-version v2   --domain both   --strict-missing-timeseries-counts   --dry-run
```

Review:

- observation day and connector coverage;
- observation timeseries index coverage;
- AQI day and connector coverage;
- AQI timeseries index coverage;
- invalid manifests;
- missing timeseries row counts;
- blocked dependencies;
- planned writes and unchanged objects.

If the only blocker is missing `timeseries_row_counts`, stop and inspect the affected manifests. Use `--compute-missing-timeseries-counts` only for confirmed affected data with an explicit write plan.

When clean, write:

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs   --history-version v2   --domain both   --strict-missing-timeseries-counts   --write-r2
```

Run the strict dry-run again. It should report no unresolved dependency and skip byte-identical unchanged objects.

### 10.6 Reconcile bindings

Run:

```bash
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --dry-run
```

If required:

```bash
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --write-r2
```

Confirm the current core snapshot covers all referenced timeseries IDs.

### 10.7 Targeted integrity validation

Check:

- oldest migrated day;
- one middle day;
- newest complete day;
- every active connector on a representative day;
- PM2.5, PM10 and NO2;
- other v2 observation properties expected in history;
- both observations and AQI.

Validate:

- manifest schema and child relationships;
- hashes;
- row counts;
- min and max timeseries IDs;
- observation time bounds;
- timeseries row counts;
- binding resolution;
- AQI rolling context;
- index coverage.

Do not run broad repair unless a specific defect is identified.

### 10.8 Post-build backup

After observations, AQI, bindings and indexes are complete:

- run the core snapshot if required;
- build the backup inventory;
- complete Dropbox backup;
- confirm it contains v2 observations, AQI, core and `_index_v2`;
- record run ID and counts.

### Phase 4 gate

Do not proceed unless:

- v2 is complete to the agreed high-water mark;
- AQI history exists;
- strict index validation is clean;
- bindings are reconciled;
- targeted integrity checks pass;
- post-build Dropbox backup succeeds.

## 11. Phase 5: deploy the new read path with writers disabled

**Owner:** User  
**Recommended implementation assistance:** GPT-5.6 Codex with High reasoning  
**Permission:** Deployment only, no writer enablement

### 11.1 Confirm Cloudflare account boundaries

Record which account owns:

- `ukaq.co.uk`;
- the new history bucket;
- R2 API Workers;
- cache proxy;
- postcode and geography Workers;
- latest snapshot Worker;
- scheduler and D1.

Do not assume R2 bindings can cross accounts.

If postcode, geography or latest-snapshot products have not moved, either migrate them or keep their existing API Workers and point the new cache proxy to them. Record every retained legacy dependency.

### 11.2 Deploy R2 API Workers

Deploy with unique LIVE names and the new bucket binding:

- observations history API;
- AQI history API;
- latest snapshot API where applicable;
- postcode and geography APIs where applicable;
- metrics or dashboard APIs where applicable.

Required v2 values include:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
UK_AQ_R2_HISTORY_INDEX_V2_PREFIX
UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX
```

### 11.3 Deploy the cache proxy

Configure:

- observation and AQI history API URLs;
- postcode and geography URLs;
- latest snapshot API or service binding;
- station-history binding;
- Supabase URLs and keys;
- cache and upstream secrets;
- LIVE session and Turnstile values;
- Dropbox debug-log configuration where retained;
- exact allowed origins.

Normally include:

```text
https://ukaq.co.uk
https://www.ukaq.co.uk
```

The old beta origin may remain temporarily.

Do not enable a LIVE local-development bypass.

### 11.4 Prepare scheduler with jobs disabled

If moving scheduler account:

- create or select LIVE D1;
- update `database_id`;
- deploy the scheduler Worker;
- set dispatch token and manual trigger key;
- sync job configuration;
- keep every job disabled.

Update job targets to `UK-AQ/...`.

### 11.5 Prepare website

In `UK-AQ/uk-aq-root.github.io`:

- preserve `CNAME` as `ukaq.co.uk`;
- inspect hard-coded API, domain, OAuth, asset and canonical URLs;
- update application references to the old domain;
- retain historical editorial links where appropriate;
- confirm the intended API route;
- remove TEST titles and flags;
- confirm analytics and debug logging use LIVE settings.

Validate the build against new APIs using a Pages-generated URL, controlled preview hostname or local hosting before changing the apex route.

### 11.6 Supabase auth configuration

In existing LIVE Supabase:

- set or prepare Site URL for `ukaq.co.uk`;
- add `https://ukaq.co.uk` to redirect URLs;
- add `https://www.ukaq.co.uk` only if served;
- retain the old beta redirect temporarily;
- verify Google OAuth return flow;
- update Edge Function allowed origins;
- inspect configuration tables for old service URLs.

### Phase 5 gate

- New APIs are directly reachable.
- They read new R2 v2.
- Website build is structurally valid.
- Authentication accepts the new domain.
- Scheduler and writers remain disabled.
- The old beta remains public.

## 12. Phase 6: final delta and cutover

**Owner:** User  
**Permission:** Explicit LIVE operations

Choose a quiet window.

### 12.1 Before cutover

- reduce DNS TTL where applicable;
- confirm latest successful old writer runs;
- confirm no backup, integrity or backfill is running;
- confirm rollback controls;
- confirm new APIs and website build;
- prepare a timestamped cutover log.

### 12.2 Pause old writers

Disable:

1. old scheduler jobs;
2. old GitHub runtime automation;
3. old ingest schedules;
4. old AQI schedule;
5. old Prune Daily and partition-maintenance schedules;
6. old R2 snapshot and backup schedules.

Keep old read-only APIs and website available.

Record freeze time as `T0`.

Confirm no old writer remains active.

### 12.3 Final observation and AQI delta

After old writers stop:

1. run final old R2 v1 backup;
2. identify complete data after the previous v2 high-water mark;
3. convert or backfill only that delta;
4. verify observation manifests;
5. generate AQI for the same delta;
6. update targeted indexes;
7. run strict validation;
8. run targeted integrity;
9. record final v2 high-water mark.

### 12.4 Switch read path

- publish the new website;
- configure `ukaq.co.uk` DNS;
- enable the Cloudflare API route or custom domain;
- confirm TLS;
- confirm apex and optional `www`;
- confirm canonical URL and redirects;
- keep old beta domain unchanged until verification.

### 12.5 Enable new writers

Enable one family at a time:

1. ingests;
2. outbox flush;
3. latest snapshot;
4. AQI generation;
5. observations partition maintenance;
6. Prune Daily;
7. core snapshot;
8. Dropbox backup;
9. other daily operations.

For each:

- enable only the new target;
- observe one normal operation;
- confirm task health;
- confirm no duplicate old run;
- stop if it writes to the wrong bucket, repository or environment.

Do not enable Prune Daily until the new backup gate and Phase B target are healthy.

### Phase 6 gate

- `ukaq.co.uk` serves the new site.
- All active writers come from the new stack.
- Old writers remain disabled.
- Recent observations advance.
- New R2 v2 advances.
- No duplicate writer is detected.

## 13. Phase 7: real beta validation

**Owner:** User  
**Permission:** Normal operation and read-only checks

### 13.1 Website

Check:

- map and home page;
- no old-domain asset failures;
- no unexpected 401, 403, 404 or CORS errors;
- sensor search and filters;
- latest values;
- station charts;
- recent data;
- older R2 data;
- DAQI and EAQI;
- postcode and geography;
- mobile and desktop;
- canonical and social metadata.

### 13.2 History

Use:

- one PM2.5 timeseries;
- one PM10 timeseries;
- one NO2 timeseries;
- one long-history timeseries;
- one recently active timeseries.

Confirm:

- recent data uses Supabase;
- older observations use v2 R2;
- older AQI uses v2 R2;
- no duplicate or missing boundary exists;
- expected non-AQI properties remain available;
- caching does not alter content.

### 13.3 Operations

Observe one normal run of:

- each ingest;
- outbox flush;
- AQI generation;
- latest snapshot;
- partition maintenance;
- Prune Daily;
- core snapshot;
- Dropbox backup.

Confirm:

- repository is `UK-AQ/...`;
- environment is `LIVE`;
- target bucket is correct;
- task-health keys are unchanged;
- no old workflow ran concurrently;
- Dropbox uses the intended LIVE root;
- manifests and indexes advance.

### 13.4 Supabase and auth

Check:

- expected observation arrival;
- no duplicate scheduled pattern;
- no connector loss;
- no repeated outbox claims;
- no unexplained AQI amplification;
- no unexpected deletion;
- HTTPS;
- intentional apex and `www` behaviour;
- Google login returns to `ukaq.co.uk`;
- logout and session expiry;
- Turnstile and session endpoints accept new origin.

One successful normal operation and representative output check for each reversible component is sufficient.

## 14. Rollback

### 14.1 Website or routing rollback

Use when writers and data are healthy but the website or route is faulty.

1. Keep new writers running.
2. Restore previous DNS or Worker route.
3. Serve the old beta site temporarily.
4. Keep new R2 v2 APIs available.
5. Fix presentation, CORS or routing without changing data.

### 14.2 Writer rollback

1. Disable all new writer jobs.
2. Confirm no new writer is running.
3. Re-enable legacy writers one family at a time.
4. Keep only one writer set active.
5. Verify legacy credentials.
6. Catch up v1 history before destructive retention if required.
7. Keep new v2 unchanged for investigation.

The same Supabase tables mean observations written by the new stack remain visible to the old stack.

R2 histories may diverge. Writer rollback is simplest while the missing v1 range remains recoverable from retained Supabase data. Do not resume destructive legacy retention until any v1 gap is repaired or its safety gate is proved.

### 14.3 Data rollback

Do not restore Supabase merely because repository or domain migration failed.

For R2:

- retain the pre-change backup;
- retain old v1;
- retain post-build v2 backup;
- repair specific objects rather than replacing the bucket.

### 14.4 Rollback triggers

Pause or roll back if:

- old and new writers are both active;
- writes target the wrong bucket;
- bindings fail;
- AQI history is materially incomplete;
- Prune Daily cannot prove backup readiness;
- unexpected deletions occur;
- observation arrival stops;
- authentication cannot return to new domain;
- scheduler dispatches TEST or old-organisation workflows;
- a required supporting R2 product is unavailable.

## 15. Phase 8: acceptance and retirement

**Owner:** User and ChatGPT  
**Permission:** Cleanup after acceptance

After one complete successful daily cycle:

1. run another Dropbox backup;
2. retain the disabled old stack for a short rollback window;
3. redirect the old beta domain to `https://ukaq.co.uk`;
4. preserve deep links where practical;
5. remove old allowed origins after rollback window;
6. remove old Supabase redirect URLs after rollback window;
7. revoke old scheduler PATs and deployment credentials;
8. remove old GCP Workload Identity repository subjects;
9. archive old GitHub repositories as read-only rather than deleting immediately;
10. disable or delete old Workers and schedules only after replacement is confirmed;
11. retain R2 v1 until a separate retention decision;
12. record final ownership and commit SHAs.

Do not delete R2 v1 in this migration.

## 16. System documentation

**Owner:** ChatGPT in Chat mode

After implementation:

1. collect Codex handovers;
2. update authoritative `system_docs/` in TEST source repositories;
3. document:
   - `UK-AQ` repository ownership;
   - `ukaq.co.uk` route boundary;
   - LIVE R2 v2 authority;
   - scheduler targets;
   - Cloudflare account boundaries;
   - retained legacy dependencies;
   - deployment authentication;
   - backup and rollback;
4. do not edit `system_docs/` through Codex;
5. propagate documentation with the normal TEST-to-LIVE sync process;
6. commit documentation separately where practical.

Likely affected areas include:

- `system_docs/r2_history/`;
- `system_docs/latest_snapshot/`;
- cache proxy documentation;
- scheduling documentation;
- backup and recovery;
- monitoring;
- website and dashboard operations.

## 17. Work packages

### A. Repository and configuration preparation

**Codex model:** GPT-5.6 Codex with High reasoning

- inspect sync result;
- identify hard-coded environment values;
- prepare focused LIVE changes;
- keep writers disabled;
- provide exact secret and deployment commands;
- run structural checks only.

### B. R2 v2 completion

**Codex model:** GPT-5.6 Codex with High reasoning

Use only if code repair or a guarded LIVE wrapper is required.

- preserve v2 contracts;
- do not weaken bucket safety;
- provide dry-run and write commands;
- preserve byte-stable indexes;
- provide recovery commands.

Actual R2 writes remain manual.

### C. Cloudflare and website deployment

**Codex model:** GPT-5.6 Codex with High reasoning

- prepare Worker names, bindings, routes and variables;
- prepare Pages and website changes;
- prepare scheduler with jobs disabled;
- provide exact deploy commands;
- do not enable writers.

### D. Cutover

**Owner:** User, assisted by ChatGPT

- execute final delta;
- switch routes and domain;
- enable writers one family at a time;
- record results;
- stop at the first single-writer or integrity violation.

## 18. Operator checklist

### Before commit

- [ ] Confirm target remotes.
- [ ] Confirm no secret files are staged.
- [ ] Disable Actions in empty targets.
- [ ] Preserve website `CNAME`.

### Before R2 write

- [ ] Complete pre-change Dropbox backup.
- [ ] Record exact bucket and prefix.
- [ ] Confirm `UK_AQ_ENV_NAME=LIVE`.
- [ ] Run dry-run.
- [ ] Confirm no concurrent writer.
- [ ] Confirm rollback data exists.

### Before domain cutover

- [ ] Complete v2 observations.
- [ ] Complete v2 AQI.
- [ ] Complete v2 indexes.
- [ ] Reconcile bindings.
- [ ] Pass targeted integrity.
- [ ] Complete post-build backup.
- [ ] Deploy read APIs.
- [ ] Validate website build.
- [ ] Add Supabase redirects.
- [ ] Keep new writers disabled.

### During cutover

- [ ] Pause old writers.
- [ ] Record `T0`.
- [ ] Build final v2 delta.
- [ ] Update targeted indexes.
- [ ] Validate final delta.
- [ ] Switch website and API route.
- [ ] Enable new writers one family at a time.
- [ ] Confirm old writers remain disabled.

### After cutover

- [ ] Verify recent and historical charts.
- [ ] Verify auth.
- [ ] Verify ingest.
- [ ] Verify AQI generation.
- [ ] Verify Prune Daily.
- [ ] Verify partition maintenance.
- [ ] Verify core snapshot.
- [ ] Verify Dropbox backup.
- [ ] Verify task health identifies `UK-AQ`.
- [ ] Keep old resources disabled for rollback.
- [ ] Update authoritative system documentation.
