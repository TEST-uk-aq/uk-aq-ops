
> **Important revision, 17 July 2026:** The direct-cutover addendum at the end of this document supersedes the original dual-read, backwards-compatibility and rollback-window instructions. The cumulative `history/_index_v2/timeseries/` index is to be removed from active reads, writes and Dropbox backup during the binding implementation.

# Replace cumulative timeseries metadata with stable timeseries bindings

**Repository:** `TEST-uk-aq/uk-aq-ops`  
**Target environment:** TEST only  
**Plan date:** 17 July 2026  
**Status:** Proposed  
**Recommended Codex model for every implementation prompt:** **GPT-5.6 Sol, High reasoning**

## 1. Decision

Replace the high-churn cumulative files:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

with stable binding files:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

The binding files will provide only stable timeseries identity and routing information. They will not contain daily observation or AQI coverage.

Keep the two daily file-location index trees unchanged:

```text
history/_index_v2/observations_timeseries/
history/_index_v2/aqilevels_hourly_data_timeseries/
```

Those daily indexes remain required for fast R2 chart reads.

## 2. Why this change is needed

The current cumulative metadata file for each timeseries contains observation and AQI entries for every covered day. A normal prune-daily run therefore changes the metadata file for nearly every active timeseries.

That creates several avoidable costs:

1. Thousands of R2 metadata objects receive new etags after one new history day.
2. The Dropbox inventory builder re-reads those objects.
3. The Dropbox sync uploads those objects individually.
4. A backup that should primarily copy one new day's data can take several hours.
5. The cumulative files duplicate coverage already represented by the daily file-location indexes.

The cache proxy does not need the cumulative coverage during a normal website chart request. When the caller supplies `connector_id`, the proxy uses it directly and calls the observations history API with:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
```

The cumulative metadata route is currently used only as a fallback when `connector_id` is absent.

## 3. Confirmed current implementation

### 3.1 Normal line-chart reads

The cache proxy currently:

1. accepts `connector_id` from the incoming v2 timeseries request;
2. uses the request value directly when present;
3. only calls the R2 `/v1/timeseries-metadata` endpoint when `connector_id` is missing;
4. falls back to a Supabase lookup if the R2 metadata lookup does not provide a connector;
5. calls the R2 observations history API with the resolved connector, pollutant, timeseries and time range.

Relevant files:

```text
workers/uk_aq_cache_proxy/src/index.ts
workers/uk_aq_cache_proxy/src/station_history/observations.mjs
```

### 3.2 Actual R2 file-location indexes

The observations history Worker requires `connector_id` for `/v1/observations`. It reads the daily pollutant-partitioned index:

```text
history/_index_v2/observations_timeseries/
  day_utc=<day>/
  connector_id=<connector>/
  pollutant_code=<code>/
  manifest.json
```

The AQI history path uses the corresponding daily AQI file-location index:

```text
history/_index_v2/aqilevels_hourly_data_timeseries/
```

These indexes locate candidate Parquet files and remain part of the required read path.

Relevant file:

```text
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
```

### 3.3 Current cumulative metadata writer

The shared history index library currently:

- builds cumulative observation and AQI coverage per timeseries;
- merges daily replacement entries into existing per-timeseries objects;
- rewrites affected files during targeted daily index updates;
- performs full metadata reconstruction during a full v2 index rebuild.

Relevant file:

```text
workers/shared/uk_aq_r2_history_index.mjs
```

Key current functions to retire or replace include:

```text
buildR2HistoryV2TimeseriesMetadataIndexKey
buildHistoryV2TimeseriesMetadataIndexPayload
extractHistoryV2TimeseriesMetadataEntry
mergeHistoryV2TimeseriesMetadataEntries
updateR2HistoryV2TimeseriesMetadataIndexesTargeted
rebuildR2HistoryV2TimeseriesMetadataIndexes
```

The same library already contains an authoritative core-binding resolver that expects:

```text
timeseries_id
connector_id
pollutant_code
phenomenon_id
observed_property_id
```

This means the proposed binding contract fits the existing authoritative-core approach and does not need to infer identity from observation values.

### 3.4 Prune daily

The Phase B AQI finalisation currently calls the targeted history-index updater with:

```text
timeseriesMetadataMode: "targeted"
```

It also includes cumulative metadata warnings in its index verification gate.

Relevant file:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
```

That coupling is the reason daily history finalisation can rewrite thousands of cumulative metadata files.

### 3.5 Dropbox backup

The v2 backup inventory currently treats this as an index tree:

```text
timeseries_metadata_v2
```

mapped to:

```text
history/_index_v2/timeseries/
```

Relevant files:

```text
scripts/backup_r2/lib/inventory.mjs
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
```

## 4. Target binding contract

### 4.1 Object path

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

### 4.2 Minimum payload

```json
{
  "schema_version": 1,
  "history_version": "v2",
  "index_kind": "timeseries_binding",
  "timeseries_id": 3742,
  "connector_id": 6,
  "pollutant_code": "pm25"
}
```

### 4.3 Optional stable fields

Include these only when they are present in the authoritative core snapshot:

```json
{
  "station_id": 17081,
  "phenomenon_id": 123,
  "observed_property_id": 456
}
```

Do not infer an optional field from daily observations or AQI output.

### 4.4 Fields that must not be included

Do not include:

```text
generated_at derived from wall-clock time
backed_up_at_utc that changes every daily history run
observation day coverage
AQI day coverage
row counts
first or last observation timestamps
source daily index keys
daily manifest hashes
run IDs
```

The binding must remain byte-identical while the authoritative mapping is unchanged.

### 4.5 Identity rules

A valid binding must have:

- one positive `timeseries_id`;
- one positive `connector_id`;
- one canonical safe `pollutant_code`;
- no conflicting connector or property assignment;
- values matching the authoritative core snapshot.

For observation history, `pollutant_code` must support all canonical observation property codes already permitted by the v2 observation history. AQI remains restricted to `pm25`, `pm10` and `no2` in its own data/index path.

## 5. Target runtime behaviour

### 5.1 Normal website request

```text
website supplies connector_id
        |
        v
cache proxy uses request connector
        |
        v
no binding read
        |
        v
daily observations/AQI index lookup
```

Website line-chart performance should therefore be unchanged.

### 5.2 Missing-connector fallback

```text
connector_id absent
        |
        v
read timeseries binding from R2
        |
        +--> found: use binding.connector_id
        |
        +--> missing/invalid: use existing Supabase connector lookup
                               |
                               +--> unresolved: clear connector lookup error
```

The binding is a routing fallback, not a source of coverage.

### 5.3 Binding lifecycle

Bindings should be published from the authoritative R2 core snapshot process, not from prune daily.

Recommended lifecycle:

1. A core snapshot is published.
2. The binding publisher reads the complete authoritative timeseries mapping from that snapshot.
3. It builds deterministic binding payloads.
4. It uses `r2PutObjectIfChanged`.
5. It reports new, changed, unchanged and stale binding counts.
6. Stale binding deletion remains separately gated.
7. Prune daily does not update binding objects.

A full binding reconciliation command must also be available for initial backfill, repair and disaster recovery.

## 6. Required targeted pre-check before implementation

This is a genuine structural pre-check, not a speculative functional test suite.

Before Phase 1 code changes, Codex must confirm:

1. the exact active worker/script and R2 object path that publish the v2 core snapshot;
2. the exact authoritative timeseries fields available in that snapshot;
3. whether `station_id`, `phenomenon_id` and `observed_property_id` are always present, sometimes present or absent;
4. every first-party builder of `/api/aq/timeseries?v=2` requests and whether it supplies `connector_id`;
5. every active reference to the legacy cumulative metadata path, route, environment variable and function names;
6. every integrity, repair, backup and documentation dependency on `timeseries_metadata_v2`.

Use repository `grep`, as required by `AGENTS.md`. Do not broaden this into a pre-implementation test project.

Structural viability is already supported by the current code because:

- the observations API requires a connector for actual R2 reads;
- the cache proxy already bypasses metadata when the connector is supplied;
- the shared library already accepts authoritative core timeseries bindings;
- the daily file-location indexes are independent of cumulative coverage.

If the core snapshot does not contain a complete authoritative mapping, stop and report the missing fields before implementing the binding publisher.

## 7. Scope

### In scope

- stable R2 binding payload and key;
- binding publication from the authoritative core snapshot;
- binding backfill/reconciliation command;
- binding read endpoint;
- cache-proxy binding fallback;
- removal of daily cumulative metadata updates;
- backup inventory migration;
- integrity and repair migration;
- environment and deployment configuration;
- system documentation;
- TEST rollout, operational validation and rollback;
- later deletion of retired R2 and Dropbox objects.

### Out of scope

- redesigning the daily observation or AQI file-location indexes;
- changing Parquet layouts;
- changing website line-chart response formats;
- removing the Supabase fallback in the same migration;
- changing LIVE repositories or services;
- deleting legacy files before successful TEST cutover;
- optimising the wider Dropbox copy implementation in this plan.

## 8. Phased implementation

# Phase 0: structural audit and contract freeze

## Objective

Resolve the remaining source and consumer details before runtime edits.

## Work

1. Read:
   - `AGENTS.md`;
   - `system_docs/README.md`;
   - all active R2 history, cache-proxy, API, backup and recovery documentation identified by repository search.
2. Run repository-wide `grep` across all non-archive paths for:
   ```text
   timeseries_metadata_v2
   history/_index_v2/timeseries
   timeseries-metadata
   UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
   buildR2HistoryV2TimeseriesMetadataIndexKey
   buildHistoryV2TimeseriesMetadataIndexPayload
   updateR2HistoryV2TimeseriesMetadataIndexesTargeted
   rebuildR2HistoryV2TimeseriesMetadataIndexes
   loadTimeseriesMetadataFromR2
   connectorIdFromTimeseriesMetadata
   timeseriesMetadataMode
   ```
3. Identify the authoritative v2 core snapshot publisher, object paths and schema.
4. Identify all first-party website and diagnostic callers of the v2 timeseries route.
5. Record the final binding schema and cutover flags.
6. Identify which existing documents are authoritative. If no R2-history area contract is yet authoritative, create the minimum authoritative `system_docs/r2_history/` set as part of Phase 1.

## Deliverable

A concise audit report listing:

- exact files to change;
- exact core snapshot source;
- exact binding fields;
- all first-party callers;
- all legacy dependencies;
- any blocker.

## Exit gate

Proceed only when the authoritative core snapshot can provide at least:

```text
timeseries_id
connector_id
pollutant_code
```

# Phase 1: add stable bindings alongside legacy metadata

## Objective

Introduce the new contract without removing the existing fallback.

## Shared index library

In:

```text
workers/shared/uk_aq_r2_history_index.mjs
```

add:

```text
DEFAULT_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX
HISTORY_V2_TIMESERIES_BINDING_SCHEMA_VERSION
buildR2HistoryV2TimeseriesBindingKey
buildHistoryV2TimeseriesBindingPayload
reconcileR2HistoryV2TimeseriesBindings
```

Requirements:

- binding input comes only from the authoritative core snapshot;
- payload is deterministic and byte-stable;
- no cumulative coverage is included;
- unchanged objects are skipped using `r2PutObjectIfChanged`;
- reconciliation reports:
  ```text
  authoritative_timeseries_count
  binding_candidate_count
  binding_written_count
  binding_changed_count
  binding_unchanged_count
  invalid_binding_count
  stale_binding_count
  ```
- stale objects are reported but not deleted by default;
- deletion requires a separate explicit option added later.

Retain the legacy cumulative metadata functions temporarily.

## Core snapshot publisher

Integrate binding publication with the active v2 core snapshot publisher identified in Phase 0.

The core snapshot must be written and verified before bindings are published. A failed binding publication must not invalidate an otherwise complete core snapshot unless the existing system contract explicitly makes derived indexes part of core snapshot completion.

Add a separate full reconcile/backfill command so bindings can be rebuilt without republishing core data.

## Observations history R2 API

In:

```text
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
```

add:

```text
GET /v1/timeseries-binding?timeseries_id=<id>
```

Return:

```json
{
  "ok": true,
  "timeseries_id": 3742,
  "binding_index_prefix": "history/_index_v2/timeseries_binding",
  "binding_key": "history/_index_v2/timeseries_binding/timeseries_id=3742.json",
  "binding": {
    "schema_version": 1,
    "history_version": "v2",
    "index_kind": "timeseries_binding",
    "timeseries_id": 3742,
    "connector_id": 6,
    "pollutant_code": "pm25"
  }
}
```

Use an immutable cache policy. The route and cache key must be separate from `/v1/timeseries-metadata`.

Keep `/v1/timeseries-metadata` during Phase 1 for rollback only.

## Cache proxy

In:

```text
workers/uk_aq_cache_proxy/src/station_history/observations.mjs
workers/uk_aq_cache_proxy/src/index.ts
```

implement this temporary lookup order:

```text
request connector_id
R2 timeseries binding
legacy R2 cumulative metadata
Supabase connector lookup
```

Add explicit diagnostics:

```text
connector_id_source=request
connector_id_source=r2_binding
connector_id_source=r2_metadata_legacy
connector_id_source=supabase_lookup
```

Recommended feature flags:

```text
UK_AQ_TIMESERIES_BINDING_LOOKUP_ENABLED=true
UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED=true
```

Do not read the binding when `connector_id` is already present.

## Backup

Add the binding tree to the v2 inventory while retaining the legacy tree during Phase 1:

```text
timeseries_binding_v2
timeseries_metadata_v2
```

The binding mapping should be:

```text
timeseries_binding_v2
  -> history/_index_v2/timeseries_binding/
```

Do not remove legacy checkpoint state yet.

## Integrity

Add binding contract validation based on the authoritative core snapshot:

- positive IDs;
- canonical property code;
- key and payload timeseries IDs agree;
- connector and property agree with core;
- no volatile or coverage fields;
- duplicate or conflicting bindings are failures;
- missing bindings are repairable from core;
- stale bindings are reported separately from missing bindings.

Keep legacy metadata checks during Phase 1 only where needed to protect rollback.

## Documentation and configuration

Update:

- active R2 history system documentation;
- API interface documentation;
- backup and recovery documentation;
- environment variable catalogues;
- Worker replacement maps;
- workflow deployment configuration;
- command help text.

Archive every affected file before editing, following `AGENTS.md`.

## Local checks after implementation

Run only fast, deterministic, non-destructive checks needed to validate the edits, including:

- syntax/type checks for changed files;
- focused binding key and payload contract checks;
- byte-stability check using identical core input;
- cache-proxy route and fallback-order checks;
- backup inventory parser checks.

Do not deploy or call R2, Dropbox, Supabase, Cloudflare or GCP from Codex.

## Exit gate

Phase 1 code is ready when:

- the binding publisher is structurally wired to authoritative core data;
- both new and legacy lookup paths compile;
- backup understands both trees;
- rollback flags are present;
- exact manual TEST deployment and backfill commands are documented.

# Phase 2: deploy to TEST and validate through real operations

## Objective

Validate the migration using actual TEST services and the normal daily workflow.

This phase is manual. Codex may prepare commands but must not run deployments or external operations unless explicitly granted Level 4.

## Deployment order

1. Deploy the component that publishes or reconciles bindings.
2. Run the one-off binding backfill against TEST R2.
3. Confirm binding count and invalid count.
4. Deploy the observations history R2 API Worker.
5. Deploy the cache proxy.
6. Deploy the backup inventory changes.
7. Do not disable the legacy path yet.

## Real operational validation

### Binding backfill

Confirm:

- binding count matches the authoritative core timeseries count, allowing only explicitly documented exclusions;
- invalid binding count is zero;
- sampled bindings match core connector and property values;
- repeated reconciliation reports unchanged objects rather than rewritten objects.

### Normal website charts

Using TEST website operations, load representative:

- PM2.5 charts;
- PM10 charts;
- NO2 charts;
- multiple networks;
- recent and historical windows;
- any station-snapshot or admin chart that uses the same route.

Confirm in request logs or diagnostics:

```text
connector_id is present
connector_id_source=request
```

The binding route should not be called for normal website requests.

### Missing-connector fallback

Make one controlled TEST request with a valid `timeseries_id` and pollutant but no connector.

Confirm:

```text
connector_id_source=r2_binding
```

and that the returned observations match the normal request with an explicit connector.

### Prune daily

Allow or manually run one normal TEST prune-daily cycle.

Confirm:

- the new day's observation and AQI daily indexes are produced;
- no binding file changes solely because a day was added;
- repeated binding reconciliation leaves existing binding etags unchanged;
- normal chart reads remain complete.

### Dropbox backup

Run the TEST Dropbox backup after the daily cycle.

Record:

```text
inventory duration
sync duration
changed observations_timeseries units
changed aqilevels_hourly_data_timeseries units
changed timeseries_binding units
changed legacy timeseries_metadata units
```

During Phase 1, legacy metadata may still churn because it remains enabled. The purpose is to prove the new binding tree itself is stable before cutover.

## Phase 2 exit gate

Proceed to Phase 3 only when:

- normal website requests consistently use `connector_id_source=request`;
- the missing-connector fallback uses `r2_binding`;
- chart results are correct through real TEST use;
- binding reconciliation is byte-stable;
- no active first-party caller depends on cumulative coverage;
- a complete rollback path has been recorded.

# Phase 3: cut over and stop cumulative metadata churn

## Objective

Make bindings authoritative for the missing-connector R2 fallback and stop writing cumulative metadata.

## Shared index library

Change v2 daily and full index flows so that:

- daily observation/AQI index updates do not call any cumulative metadata updater;
- full daily file-location index rebuilds do not rebuild cumulative metadata;
- binding reconciliation is a separate core-derived operation;
- legacy cumulative functions are no longer reachable from active execution.

Retain legacy code only if needed for the rollback window. Clearly mark it retired and keep it outside active defaults.

## Prune daily

Remove:

```text
timeseriesMetadataMode
UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
legacy metadata warning aggregation
legacy metadata completion dependency
```

Preserve:

```text
observations_timeseries index construction
aqilevels_hourly_data_timeseries index construction
AQI day-index verification
history completion gates
```

Prune daily must not write bindings. At most, it may report that a timeseries has no binding, but the actual repair source must remain the authoritative core snapshot process.

## Cache proxy

Change the fallback order to:

```text
request connector_id
R2 timeseries binding
Supabase connector lookup
```

Set:

```text
UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED=false
```

After the rollback window, remove the flag and legacy branch entirely.

## Observations history R2 API

Keep:

```text
/v1/observations
/v1/timeseries-binding
```

Retire:

```text
/v1/timeseries-metadata
```

During the rollback window, the old endpoint may remain available but must not be called by active first-party code.

## Backup inventory

Replace:

```text
timeseries_metadata_v2
```

with:

```text
timeseries_binding_v2
```

Because this changes inventory and checkpoint semantics, Codex must inspect whether an additive transition is safe. If not, bump the inventory/checkpoint schema and provide a deterministic migration path.

Do not silently discard legacy checkpoint data.

## Integrity and repair

Make binding validation authoritative and remove cumulative metadata from active required checks.

Keep the daily file-location index checks unchanged.

## TEST operational validation

After deployment, allow at least one normal complete TEST daily cycle and Dropbox backup.

Expected daily behaviour:

- the two daily index trees gain or change only the necessary new-day units;
- binding changes are zero unless the authoritative core mapping changed;
- the legacy cumulative tree is not rewritten;
- Dropbox backup no longer processes thousands of per-timeseries updates;
- website charts remain correct.

## Phase 3 exit gate

Proceed to destructive cleanup only after successful TEST operations and a successful Dropbox backup.

# Phase 4: retire and delete legacy objects

## Objective

Remove the unused cumulative metadata files from active storage and code after the rollback window.

## Cleanup tooling

Add a gated, non-default cleanup command that:

1. lists all keys under:
   ```text
   history/_index_v2/timeseries/
   ```
2. records:
   ```text
   key count
   total bytes
   etag or hash where available
   generated cleanup manifest
   ```
3. defaults to dry-run;
4. requires an explicit execute flag and confirmation token for deletion;
5. deletes in bounded batches;
6. reports successes and failures;
7. can be safely rerun.

Prepare an equivalent Dropbox cleanup procedure for the mirrored legacy tree.

Do not point an active runtime at archive copies.

## Code cleanup

After the rollback window, remove:

```text
legacy cumulative metadata builders
legacy merge logic
legacy route and cache helpers
legacy environment variables
legacy backup inventory tree key
legacy tests that only validate retired behaviour
```

Retain archived pre-change copies according to repository policy.

## Restore documentation

Update the restore sequence:

1. restore the latest authoritative core snapshot;
2. restore or rebuild stable bindings;
3. restore daily observation and AQI file-location indexes;
4. restore history Parquet and manifests;
5. validate bindings against core;
6. validate daily indexes against manifests;
7. bring API routes back into service.

Bindings should remain in Dropbox because they make recovery faster, even though they can be rebuilt from core.

## 9. Expected performance result

After Phase 3, a normal daily prune should change:

- the new day's observation file-location indexes;
- the new day's AQI file-location indexes;
- their small latest summary files;
- any data/manifests created for the day;
- zero binding files unless the core mapping actually changed.

It should not change thousands of per-timeseries files merely because a new history day exists.

The website chart read path remains:

```text
request connector
daily file-location index
candidate Parquet files
filtered timeseries rows
```

The stable binding is used only when the request connector is absent.

## 10. Rollback

### Phase 1 rollback

- disable `UK_AQ_TIMESERIES_BINDING_LOOKUP_ENABLED`;
- retain legacy metadata lookup and Supabase fallback;
- leave binding objects in R2 because they are additive and harmless;
- revert Workers without deleting data.

### Phase 3 rollback

During the rollback window:

- re-enable `UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED`;
- redeploy the previous shared-index/prune code if cumulative metadata writing must resume;
- do not delete legacy R2 or Dropbox objects until the rollback window has passed.

### Phase 4 rollback

Before deletion:

- preserve a cleanup manifest;
- confirm the binding backfill command can reconstruct all bindings;
- confirm daily indexes and core snapshots are backed up;
- retain repository archive copies of removed implementation files.

The legacy cumulative metadata is derived data. If deletion has completed, rollback should rebuild or restore it only if the old runtime must temporarily be reinstated.

## 11. Likely files affected

The Phase 0 audit must produce the definitive list. The known likely set is:

```text
AGENTS.md                                  # read, normally not changed
system_docs/README.md                      # read
system_docs/r2_history/...                 # create/update as required
system_docs/api_services/...               # create/update as required
system_docs/cache_proxy/...                # create/update as required
system_docs/backup_and_recovery/...        # create/update as required

workers/shared/uk_aq_r2_history_index.mjs

workers/uk_aq_prune_daily/phase_b_history_r2.mjs

workers/uk_aq_observs_history_r2_api_worker/worker.mjs
workers/uk_aq_observs_history_r2_api_worker/wrangler.toml

workers/uk_aq_cache_proxy/src/index.ts
workers/uk_aq_cache_proxy/src/station_history/observations.mjs

scripts/backup_r2/lib/inventory.mjs
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
scripts/backup_r2/uk_aq_build_r2_history_index.mjs

scripts/uk-aq-history-integrity/...

config/uk_aq_github_env_targets.csv
env-vars-master.csv                         # only if present and authoritative
.github/workflows/...                      # exact workflows from Phase 0

tests/uk_aq_r2_history_index.test.mjs
tests/uk_aq_prune_phase_b_paths.test.mjs
tests/uk_aq_observs_history_r2_api_worker.test.mjs
tests/uk_aq_cache_proxy.timeseries_v2_stitch.test.mjs
scripts/backup_r2/tests/...
scripts/uk-aq-history-integrity/tests/...
```

The active v2 core snapshot publisher and its tests must be added after Phase 0 identifies them.

## 12. Codex prompts

# Codex prompt 1: Phase 0 structural audit

**Recommended model: GPT-5.6 Sol, High reasoning**

```text
Work in the TEST repository only:

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops

Use GPT-5.6 Sol with High reasoning.

Permission level: Level 1, read-only audit except for a concise Markdown audit report if the repository has an appropriate plans directory. Do not deploy, run cloud jobs, access R2/Dropbox/Supabase/GCP/Cloudflare, or modify runtime code.

Read AGENTS.md and system_docs/README.md first. Follow their rules. Use grep, not rg. Ignore archive paths when identifying active execution, but note archive policy for later implementation.

Goal:
Prepare the structural audit required to replace the cumulative v2 per-timeseries metadata index:

history/_index_v2/timeseries/timeseries_id=<id>.json

with a stable binding index:

history/_index_v2/timeseries_binding/timeseries_id=<id>.json

The binding will contain stable authoritative identity/routing fields only and will not contain observation/AQI daily coverage.

Audit all active non-archive references to:

timeseries_metadata_v2
history/_index_v2/timeseries
timeseries-metadata
UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
buildR2HistoryV2TimeseriesMetadataIndexKey
buildHistoryV2TimeseriesMetadataIndexPayload
extractHistoryV2TimeseriesMetadataEntry
mergeHistoryV2TimeseriesMetadataEntries
updateR2HistoryV2TimeseriesMetadataIndexesTargeted
rebuildR2HistoryV2TimeseriesMetadataIndexes
loadTimeseriesMetadataFromR2
connectorIdFromTimeseriesMetadata
timeseriesMetadataMode

Also inspect:

workers/shared/uk_aq_r2_history_index.mjs
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/uk_aq_observs_history_r2_api_worker/
workers/uk_aq_cache_proxy/
scripts/backup_r2/
scripts/uk-aq-history-integrity/
config/
.github/workflows/
system_docs/
tests/

Identify and report:

1. The exact active v2 core snapshot publisher, workflow, object paths and payload schema.
2. The exact source of the authoritative timeseries map.
3. Whether the core source supplies timeseries_id, connector_id, pollutant_code, station_id, phenomenon_id and observed_property_id.
4. Every first-party caller that builds /api/aq/timeseries?v=2 requests, including any caller outside this repo that is directly referenced by docs/config.
5. Whether every normal website caller supplies connector_id.
6. Every writer, reader, integrity check, repair path, backup path, environment variable, workflow and document coupled to cumulative metadata.
7. The exact files that Phase 1 must archive and change.
8. Any conflict between current code and authoritative system documentation.
9. Any structural blocker to publishing bindings from the core snapshot.

Do not create a speculative pre-implementation test suite. This phase is only structural source/configuration validation.

Return a compact audit report with:
- findings;
- exact file paths and symbols;
- proposed minimum binding schema;
- unresolved blockers;
- go/no-go recommendation for Phase 1.

Do not implement the migration in this task.
```

# Codex prompt 2: Phase 1 additive binding implementation

**Recommended model: GPT-5.6 Sol, High reasoning**

```text
Work in the TEST repository only:

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops

Use GPT-5.6 Sol with High reasoning.

Permission level: Level 1 code changes plus Level 3 preparation of exact manual commands. Do not deploy, run migrations, access cloud services, run backfills, or alter R2, Dropbox, Supabase, GCP, Cloudflare or GitHub settings.

Read AGENTS.md, system_docs/README.md, all relevant authoritative documents, and the completed Phase 0 audit first. Use grep, not rg. Before editing, archive every file that will change under archive/YYYY-MM-DD/ while preserving relative paths. Do not modify archive copies after creating them.

Implement Phase 1 of the stable timeseries binding migration.

Current legacy object:
history/_index_v2/timeseries/timeseries_id=<id>.json

New additive object:
history/_index_v2/timeseries_binding/timeseries_id=<id>.json

Keep these daily read indexes unchanged:
history/_index_v2/observations_timeseries/
history/_index_v2/aqilevels_hourly_data_timeseries/

Binding requirements:
- authoritative source is the v2 core snapshot identified in Phase 0;
- minimum fields: schema_version=1, history_version=v2, index_kind=timeseries_binding, timeseries_id, connector_id, pollutant_code;
- include station_id, phenomenon_id and observed_property_id only when present in authoritative core;
- never infer identity from observation or AQI values;
- no daily coverage, row counts, first/last timestamps, run IDs or wall-clock generated_at;
- byte-identical output when authoritative core mapping is unchanged;
- use r2PutObjectIfChanged;
- report new, changed, unchanged, invalid and stale counts;
- report stale bindings but do not delete them in Phase 1.

Implement:

1. Shared binding key, payload and reconciliation helpers in workers/shared/uk_aq_r2_history_index.mjs.
2. Binding publication from the authoritative core snapshot publisher identified in Phase 0.
3. A full dry-run/write-gated binding reconcile/backfill command.
4. GET /v1/timeseries-binding?timeseries_id=<id> in the observations history R2 API Worker, with a separate immutable cache key.
5. Cache-proxy fallback order:
   request connector_id
   R2 binding
   legacy R2 metadata
   Supabase lookup
6. Diagnostics:
   connector_id_source=request
   connector_id_source=r2_binding
   connector_id_source=r2_metadata_legacy
   connector_id_source=supabase_lookup
7. Feature flags:
   UK_AQ_TIMESERIES_BINDING_LOOKUP_ENABLED
   UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED
8. Backup inventory support for timeseries_binding_v2 while retaining timeseries_metadata_v2 during Phase 1.
9. Binding integrity validation against core while retaining legacy rollback checks.
10. Environment catalogues, workflow replacement maps, CLI help, reports and system documentation.

Do not stop legacy cumulative metadata generation or delete any legacy object in this phase.

Update or add focused implementation checks for:
- binding key and payload contract;
- byte stability with identical core input;
- invalid/conflicting authoritative mappings;
- binding endpoint response and cache separation;
- cache-proxy fallback order and no binding read when request connector_id is present;
- backup inventory recognition of both trees.

Only run fast, local, non-destructive checks. Do not perform functional cloud testing. Functional validation will happen after deployment through real TEST operations.

Provide:
- files changed;
- archived paths;
- local checks run and results;
- exact manual TEST deployment order and commands;
- exact binding dry-run and write commands;
- expected output fields;
- rollback flags and commands;
- post-deploy real-operation checklist.

Do not make commits.
```

# Codex prompt 3: Phase 3 cutover after TEST evidence

**Recommended model: GPT-5.6 Sol, High reasoning**

```text
Work in the TEST repository only:

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops

Use GPT-5.6 Sol with High reasoning.

Permission level: Level 1 code changes plus Level 3 preparation of manual commands. Do not deploy or execute external operations.

This task may begin only after the user provides Phase 2 TEST evidence showing:
- normal website requests use connector_id_source=request;
- a controlled missing-connector request uses connector_id_source=r2_binding;
- binding reconciliation is byte-stable;
- website charts work through normal TEST operations;
- no first-party caller requires cumulative coverage.

Read AGENTS.md, system_docs/README.md, relevant contracts, the Phase 0 audit and Phase 1 implementation report. Use grep, not rg. Archive every file before changing it under archive/YYYY-MM-DD/.

Implement the active cutover from cumulative metadata to stable bindings.

Required behaviour:

1. Keep unchanged:
   history/_index_v2/observations_timeseries/
   history/_index_v2/aqilevels_hourly_data_timeseries/
2. Daily prune/index updates must not write:
   history/_index_v2/timeseries/timeseries_id=<id>.json
3. Full v2 daily file-location index rebuilds must not rebuild cumulative metadata.
4. Binding publication remains separate and core-derived.
5. Cache-proxy fallback order becomes:
   request connector_id
   R2 binding
   Supabase connector lookup
6. Disable and retire active legacy R2 metadata fallback.
7. Remove cumulative metadata warnings and completion dependencies from prune daily.
8. Replace the backup inventory tree timeseries_metadata_v2 with timeseries_binding_v2.
9. Inspect checkpoint compatibility. Use an additive migration only if it is unambiguous and deterministic; otherwise bump the inventory/checkpoint schema and provide a migration command.
10. Make binding integrity checks authoritative and remove cumulative metadata from active required integrity checks.
11. Update active documentation, configuration, workflow replacements, command help and reports.

Do not delete the existing legacy R2 or Dropbox objects in this phase. Preserve them for the rollback window.

Remove or make unreachable active calls to:
buildHistoryV2TimeseriesMetadataIndexPayload
updateR2HistoryV2TimeseriesMetadataIndexesTargeted
rebuildR2HistoryV2TimeseriesMetadataIndexes
timeseriesMetadataMode
UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX

Update focused local checks to prove structurally:
- daily targeted index update results no longer include cumulative metadata operations;
- prune-day AQI index verification still requires the daily AQI file-location indexes;
- cache proxy no longer calls the legacy route;
- backup inventory selects bindings and excludes cumulative metadata;
- binding payload remains byte-stable.

Only run fast local checks. Do not claim functional success until deployed and exercised through real TEST operations.

Provide:
- files changed;
- archived paths;
- local check results;
- exact manual deployment order;
- expected TEST operational observations;
- rollback procedure;
- Dropbox backup metrics to record after the first complete daily cycle.

Do not make commits.
```

# Codex prompt 4: Phase 4 cleanup tooling and retirement

**Recommended model: GPT-5.6 Sol, High reasoning**

```text
Work in the TEST repository only:

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops

Use GPT-5.6 Sol with High reasoning.

Permission level: Level 1 code changes plus Level 3 preparation of manual commands. Do not execute deletions or cloud operations.

Begin only after the user confirms:
- Phase 3 has completed at least one successful normal TEST daily cycle;
- the TEST Dropbox backup completed without cumulative metadata churn;
- website charts remain correct;
- the rollback window may close.

Read AGENTS.md and all relevant authoritative documents. Use grep, not rg. Archive every file before changing it.

Implement safe retirement and cleanup support for:

history/_index_v2/timeseries/

Requirements:

1. Add a dedicated cleanup command that defaults to dry-run.
2. It must list and report legacy key count, total bytes and hashes/etags where available.
3. It must write a cleanup manifest before any delete operation.
4. Execution must require an explicit execute flag and confirmation token.
5. Delete in bounded batches and report every failure.
6. Make reruns safe.
7. Prepare the equivalent Dropbox legacy-tree cleanup command/procedure.
8. Remove remaining inactive legacy cumulative metadata code, endpoint helpers, environment variables, backup keys and tests.
9. Keep archive paths for reference only and never use them in active execution.
10. Update restore documentation so bindings are restored or rebuilt from the authoritative core snapshot before API recovery.
11. Update system documentation and any architecture decision record to record why cumulative coverage was retired.

Do not execute cleanup. Provide exact manual dry-run, review, execute and verification commands for the user.

Only run fast local structural checks.

Report:
- files changed;
- archived paths;
- local checks;
- dry-run commands;
- expected manifest/report fields;
- execute commands;
- verification commands;
- rollback limitations after deletion.

Do not make commits.
```

## 13. Final recommendation

Use the phased dual-read migration rather than deleting the cumulative index immediately.

The load-bearing choices are:

1. bindings come only from authoritative core;
2. normal website requests continue supplying `connector_id`;
3. daily file-location indexes remain unchanged;
4. prune daily never writes bindings;
5. binding payloads contain no coverage or volatile timestamps;
6. legacy objects are deleted only after real TEST operational validation;
7. bindings remain included in Dropbox for faster recovery.

This should remove the thousands of routine per-timeseries Dropbox updates without changing the fast R2 line-chart read path.

---

# Addendum: direct TEST cutover with no legacy metadata compatibility

**Date:** 17 July 2026  
**Status:** Supersedes the dual-read and rollback-window parts of the original plan  
**Recommended Codex model:** **GPT-5.6 Sol, High reasoning**

## Decision change

The migration will no longer keep the cumulative v2 per-timeseries metadata index as a compatibility path.

Retire this active index immediately during the binding implementation:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

Replace it with:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

There will be:

- no dual-read period;
- no legacy R2 metadata fallback;
- no legacy metadata feature flag;
- no continued cumulative metadata generation;
- no `timeseries_metadata_v2` entry in the active Dropbox inventory;
- no requirement to preserve the legacy index for backwards compatibility.

The existing Supabase connector lookup may remain as a separate last-resort fallback if it is already part of the current API contract. This decision only removes fallback to the cumulative R2 metadata index.

## Revised implementation scope

Codex Phase 1 must now implement the complete active cutover, not an additive compatibility phase.

### Required active read path

```text
connector_id supplied by caller
        |
        v
use request connector_id directly
```

When `connector_id` is absent:

```text
R2 timeseries binding
        |
        +--> found: use binding.connector_id
        |
        +--> missing: existing Supabase lookup, only if that fallback remains part of the current contract
```

The proxy must never call:

```text
/v1/timeseries-metadata
```

### Required active write path

Daily and full v2 index updates must continue writing:

```text
history/_index_v2/observations_timeseries/
history/_index_v2/aqilevels_hourly_data_timeseries/
```

They must stop writing:

```text
history/_index_v2/timeseries/
```

Bindings must be derived separately from the authoritative core snapshot. Prune daily must not create or update bindings.

### Required backup behaviour

The active v2 backup inventory must include:

```text
timeseries_binding_v2
```

and must exclude:

```text
timeseries_metadata_v2
```

Existing legacy checkpoint entries may remain harmlessly in the checkpoint JSON, but active inventory planning and copying must ignore them. Do not spend implementation time building a backwards-compatible migration for unused checkpoint entries unless the current parser would otherwise fail structurally.

### Required code retirement

Remove active uses of:

```text
buildR2HistoryV2TimeseriesMetadataIndexKey
buildHistoryV2TimeseriesMetadataIndexPayload
extractHistoryV2TimeseriesMetadataEntry
mergeHistoryV2TimeseriesMetadataEntries
updateR2HistoryV2TimeseriesMetadataIndexesTargeted
rebuildR2HistoryV2TimeseriesMetadataIndexes
timeseriesMetadataMode
UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
/v1/timeseries-metadata
timeseries_metadata_v2
```

Functions may be deleted immediately when no active code or focused local check requires them. There is no need to retain dead compatibility code in active paths.

## Revised deployment and cleanup order

Because this is the TEST system, use a direct cutover:

1. Implement the stable binding publisher and binding endpoint.
2. Remove all active cumulative metadata readers and writers in the same branch.
3. Change the backup inventory from `timeseries_metadata_v2` to `timeseries_binding_v2`.
4. Deploy the binding publisher or reconciliation command.
5. Backfill TEST bindings.
6. Deploy the observations history Worker and cache proxy.
7. Deploy prune/index and backup changes.
8. Exercise normal TEST website chart requests.
9. Run one normal TEST prune-daily operation.
10. Run the TEST Dropbox backup.
11. After those operations succeed, delete:
    ```text
    R2:      history/_index_v2/timeseries/
    Dropbox: the mirrored history/_index_v2/timeseries/ tree
    ```

The deletion command must still default to dry-run and report key count and total bytes before execution. This is operational safety, not backwards compatibility.

## Minimal pre-deployment checks

Keep local checking narrow:

- changed files parse and type-check;
- stable binding payload is deterministic;
- explicit `connector_id` bypasses binding lookup;
- missing `connector_id` uses the binding route;
- no active code references `/v1/timeseries-metadata`;
- prune/index code no longer calls cumulative metadata builders;
- active backup inventory includes bindings and excludes legacy metadata.

Do not create a broad speculative test suite.

Functional validation happens after deployment through real TEST operations:

- representative website charts;
- one controlled request without `connector_id`;
- one prune-daily run;
- one Dropbox backup;
- confirmation that adding a day changes zero binding files unless core mappings changed.

## Revised Codex instruction for work already in progress

Send this instruction to the Codex task currently implementing Phase 1:

```text
Change of plan for the Phase 1 work currently in progress.

Use GPT-5.6 Sol with High reasoning.

This is a TEST-only direct cutover. Do not implement dual-read compatibility for the old cumulative timeseries metadata index.

Retire this active index now:

history/_index_v2/timeseries/timeseries_id=<id>.json

Replace it with:

history/_index_v2/timeseries_binding/timeseries_id=<id>.json

Update your current implementation as follows:

1. Do not keep or add a legacy R2 metadata fallback.
2. Do not add UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED.
3. The cache-proxy lookup order must be:
   - request connector_id;
   - R2 timeseries binding;
   - existing Supabase lookup only if it remains part of the current API contract.
4. Remove active calls to /v1/timeseries-metadata.
5. Remove /v1/timeseries-metadata from the active observations history Worker routes.
6. Stop targeted and full v2 index updates from building cumulative per-timeseries metadata.
7. Remove cumulative metadata from prune-daily warnings, verification and completion dependencies.
8. Keep observations_timeseries and aqilevels_hourly_data_timeseries unchanged.
9. Bindings must be derived from the authoritative core snapshot and must not be written by prune daily.
10. Replace timeseries_metadata_v2 with timeseries_binding_v2 in the active Dropbox inventory immediately.
11. Existing legacy checkpoint fields may be ignored if they do not break parsing. Do not add compatibility machinery solely to preserve unused checkpoint entries.
12. Remove legacy cumulative metadata functions, environment variables, help text, tests and documentation where they are no longer referenced.
13. Add a dry-run-first cleanup command or exact manual command for deleting the legacy R2 and Dropbox trees after the first successful TEST chart, prune and backup operations.
14. Keep pre-deployment checks minimal and local. Functional validation happens through real TEST operations after deployment.

Before editing any newly affected file, follow the AGENTS.md archive requirement.

Do not deploy or delete cloud objects. Provide exact manual deployment, backfill, validation and cleanup commands.
```

## Effect on the original phases

The original Phase 0 audit remains useful.

The original Phase 1 and Phase 3 are merged into one implementation phase:

```text
binding creation + active cutover + legacy code retirement
```

The original Phase 2 remains the real TEST operational validation stage.

The original Phase 4 is reduced to immediate post-validation deletion of the old R2 and Dropbox object trees. There is no extended rollback window.
