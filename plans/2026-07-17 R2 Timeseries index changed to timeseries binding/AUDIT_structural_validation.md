# Structural audit — v2 timeseries metadata to stable binding

**Scope:** active non-archive paths in `TEST-uk-aq-ops`, audited 2026-07-17.  No runtime code, configuration, tests, data, or external service was changed.  The pre-existing `PLAN_timeseries_binding_index_migration.md` was preserved.

## Recommendation

**GO for Phase 1, subject to one implementation gate:** publish bindings from a validated, selected v2 core snapshot, not from daily observation/AQI indexes.  The snapshot contains enough identity data, but no active component currently materialises it into R2 binding objects.  The implementation must add that publisher/loader before removing cumulative metadata writes.

This reduces R2/Dropbox index-object churn.  It does not change website polling, raw-history granularity, or Supabase endpoint egress; it reduces R2 Class-B inventory reads and Dropbox copies only when a stable binding is unchanged.

## 1. Authoritative core snapshot and identity map

### Publisher and objects

- Publisher: `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs` (`main`, `exportTableToGzip`).
- Workflow: `.github/workflows/uk_aq_r2_core_snapshot.yml`, dispatched by `cloudflare/scheduler/jobs.toml` job `uk_aq_r2_core_snapshot` at `15 4 * * *` UTC.  The workflow comment still says `31 13 * * *`; that comment is stale.
- Source: `uk_aq_core` (or `UK_AQ_CORE_SNAPSHOT_SCHEMA`), with deterministic `select * ... order by ...` table exports.
- v2 root: `history/v2/core/day_utc=YYYY-MM-DD/` (selected by `UK_AQ_R2_HISTORY_VERSION=v2` and `UK_AQ_R2_HISTORY_V2_CORE_PREFIX`).
- Required binding inputs:
  - `table=timeseries/rows.ndjson.gz`;
  - `table=phenomena/rows.ndjson.gz`;
  - `table=observed_properties/rows.ndjson.gz` for canonical code resolution.
- Snapshot also writes `manifest.json` and `checksums.sha256`.  The manifest schema is `uk_aq_core_snapshot`, version `1`, and contains `generated_at_utc`, `day_utc`, `source_schema`, `prefix`, `file_format`, per-table `{table, order_by, key, relative_path, row_count, uncompressed_bytes, compressed_bytes, sha256, sha256_uncompressed}`, totals, checksums, and `manifest_hash`.

### Authoritative map

The most exact active implementation of the required map is `scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs#loadCoreTimeseriesBindings`: it joins snapshot `timeseries` to `phenomena` and `observed_properties`, then normalizes a pollutant from row/phenomenon/property labels or refs.  Integrity uses the same source in `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py#_authoritative_v2_core_timeseries_bindings`.

| Required field | Core source status |
|---|---|
| `timeseries_id` | Yes: `timeseries.id` |
| `connector_id` | Yes: `timeseries.connector_id` |
| `station_id` | Yes: `timeseries.station_id` |
| `phenomenon_id` | Yes: `timeseries.phenomenon_id` |
| `observed_property_id` | Yes, via `phenomena.observed_property_id` |
| canonical `pollutant_code` | **Derived, not a direct authoritative column.** It must be normalized deterministically from the snapshot's timeseries/phenomenon/observed-property labels/refs and rejected when absent or ambiguous. |

The existing shared resolver, `workers/shared/uk_aq_r2_history_index.mjs#resolveAuthoritativeTimeseriesBinding`, accepts `timeseries_id`, `connector_id`, `pollutant_code`, `phenomenon_id`, and `observed_property_id`, but omits `station_id`.  Phase 1 must extend it or add the binding-specific equivalent.

## 2. Current cumulative index contract

- Object key: `history/_index_v2/timeseries/timeseries_id=<id>.json`.
- Profile declaration: `workers/shared/uk_aq_r2_history_profile.mjs#PROFILES.v2.timeseries_metadata_index_prefix`.
- Payload producer: `workers/shared/uk_aq_r2_history_index.mjs#buildHistoryV2TimeseriesMetadataIndexPayload`.
- Schema: `{schema_version: 1, generated_at, source: "r2_history_v2_timeseries_indexes", history_version: "v2", index_kind: "timeseries_metadata", timeseries_id, connector_id, connector_ids, pollutant_codes, index_prefix, timeseries_metadata_index_prefix, observations_coverage, aqi_coverage, backed_up_at_utc}`.  Each coverage contains aggregate counts/ranges plus daily `entries` keyed by `(domain, day_utc, connector_id, pollutant_code)`.

### Writers

1. `workers/shared/uk_aq_r2_history_index.mjs`
   - `updateR2HistoryV2TimeseriesMetadataIndexesTargeted` merges changed daily coverage with the existing object.
   - `rebuildR2HistoryV2TimeseriesMetadataIndexes` reconstructs all objects from daily observation/AQI timeseries indexes.
   - `updateR2HistoryIndexesTargeted` calls either targeted or full metadata maintenance according to `timeseriesMetadataMode`; `rebuildR2HistoryIndexes` always invokes the full rebuild for v2.
2. `workers/uk_aq_prune_daily/phase_b_history_r2.mjs#buildAqilevelDayIndexes` calls the targeted path with `timeseriesMetadataMode: "targeted"`.
3. `workers/uk_aq_prune_daily/server.mjs#runPrune` then calls `rebuildR2HistoryIndexes` after Phase B, which invokes the full v2 metadata rebuild.
4. `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` exposes both shared rebuild modes to the operator.
5. `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs#runV2ObservationsRepair` calls the targeted path and tracks metadata proposals/verification.

### Readers

1. `workers/uk_aq_observs_history_r2_api_worker/worker.mjs#handleTimeseriesMetadataRequest` serves protected `GET /v1/timeseries-metadata`; `resolveTimeseriesMetadataIndexPrefix` uses `UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX` or the index-root default.
2. `workers/uk_aq_cache_proxy/src/station_history/observations.mjs#loadTimeseriesMetadataFromR2` and `#connectorIdFromTimeseriesMetadata` call that route only when a v2 chart request lacks `connector_id`. `workers/uk_aq_cache_proxy/src/index.ts#handleTimeseriesV2` is the live caller.  Same-named local functions in `index.ts` are not called; the imported module is used.
3. `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs#readTimeseriesWindowContextFromR2Metadata` reads the object directly when a v2 AQI request lacks `connector_id`.  It derives the path from `UK_AQ_R2_HISTORY_INDEX_V2_PREFIX`; it has no metadata-prefix override.

### Backup, integrity, repair, and configuration coupling

- Backup inventory: `scripts/backup_r2/lib/inventory.mjs#V2_INDEX_TREE_KEYS` contains `timeseries_metadata_v2`; `scripts/backup_r2/build_backup_inventory.mjs#indexTreeScanConfig` maps it to `history/_index_v2/timeseries` with one object per timeseries. `scripts/backup_r2/sync_history_to_dropbox.mjs` copies all configured inventory tree units generically.
- Integrity: `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` tracks `timeseries_metadata_operations` and validates all coverage and aggregates in `_validate_timeseries_metadata_payload` / `_validate_changed_timeseries_metadata`. `docs/history-integrity.md` documents the same merge/verification contract.
- Repair executor: `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs` treats cumulative objects as dynamic exact-key dependencies, proposal kind `timeseries_metadata`, and blocked/success criteria.
- Environment: `.env`, `env-vars-master.csv`, and `config/uk_aq_github_env_targets.csv` define `UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX`; the target map is `local`. The value is also consumed by shared index code, Phase B, the index CLI, and the observations Worker. `scripts/uk_aq_sync_github_secrets.sh` is map-driven and has no direct reference.
- Workflows: `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` does **not** inject the metadata-prefix override despite the Worker supporting it. Core snapshot, backup, and index build workflows are otherwise coupled through their paths/data, not this variable.

## 3. `/api/aq/timeseries?v=2` callers and connector behaviour

No active production code in this repository constructs a website request to `/api/aq/timeseries?v=2`; the cache proxy is the receiver.  First-party request constructors/fixtures are:

- `scripts/uk_aq_cache_proxy/check_timeseries_v2_skeleton.mjs` — includes `connector_id` in its primary fixture and has a connector-less fixture.
- `tests/uk_aq_cache_proxy_station_history_modules.test.mjs` — includes a connector-less v2 fixture.
- `tests/uk_aq_cache_proxy.timeseries_v2_stitch.test.mjs` — source-order assertion only.

The only direct out-of-repository reference found in active source/configuration is the website test-root path in `tests/network_contract_phase9.test.mjs` (`../../CIC-UK-AQ Webpage/CIC-test-uk-aq-webpage`); it does not identify a v2 request builder.  Active docs/configuration name no website caller.  Therefore this audit cannot prove that **every normal website caller** supplies `connector_id`; the runtime intentionally accepts omission and falls back to R2 binding/then Supabase.  Phase 1 must retain that compatibility path or obtain a website-repository audit before making `connector_id` mandatory.

## 4. Minimum proposed binding

Key: `history/_index_v2/timeseries_binding/timeseries_id=<id>.json`

```json
{
  "schema_version": 1,
  "history_version": "v2",
  "index_kind": "timeseries_binding",
  "timeseries_id": 3742,
  "connector_id": 6,
  "pollutant_code": "pm25",
  "station_id": 17081,
  "phenomenon_id": 123,
  "observed_property_id": 456
}
```

`timeseries_id`, `connector_id`, and canonical `pollutant_code` are required; the remaining fields are included only when valid in the selected core snapshot.  Do not include timestamps, hashes, run IDs, coverage, counts, manifests, or any daily data.  Serialize with stable key order and only rewrite when bytes differ.

## 5. Documentation conflict

The current authoritative AQI documents require cumulative metadata, contradicting the proposed binding-only behaviour:

- `system_docs/aqi-levels/data-flow.md` stage 8;
- `system_docs/aqi-levels/interfaces.md` v2 metadata prefix/key;
- `system_docs/aqi-levels/operations.md` historical persistence;
- `system_docs/aqi-levels/recovery.md` index rebuild steps;
- `system_docs/aqi-levels/validation.md` Phase B validation.

`workers/uk_aq_observs_history_r2_api_worker/README.md` also omits its implemented `/v1/timeseries-metadata` route and metadata-prefix environment variable.  Separately, the core-snapshot workflow's schedule comment conflicts with the authoritative scheduler configuration noted above.

Non-runtime historical references remain in `docs/r2_first_aqi_migration_report_2026-07-14.md`, `system_docs_legacy/`, and prior `plans/` files.  They describe the current cumulative implementation and should be retained as historical records, not silently rewritten as Phase 1 documentation.

## 6. Phase 1 archive and change set

Before implementation, archive the then-current versions under `archive/2026-07-17/`, preserving relative paths.  Archive files are read-only and must never be used as runtime fallbacks.

**Runtime/index and consumers:**

- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/shared/uk_aq_r2_history_profile.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/wrangler.toml`
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_aqi_history_r2_api_worker/README.md`
- `workers/uk_aq_cache_proxy/src/index.ts`
- `workers/uk_aq_cache_proxy/src/station_history/observations.mjs`

**Backup/repair/integrity:**

- `scripts/backup_r2/lib/inventory.mjs`
- `scripts/backup_r2/build_backup_inventory.mjs`
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`
- `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
- `docs/history-integrity.md`

**Configuration, deployment, documentation, and existing contract tests:**

- `.env`, `env-vars-master.csv`, `config/uk_aq_github_env_targets.csv`
- `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `workers/uk_aq_observs_history_r2_api_worker/README.md`
- `system_docs/aqi-levels/{data-flow.md,interfaces.md,operations.md,recovery.md,validation.md}`
- `tests/uk_aq_r2_history_index.test.mjs`
- `tests/uk_aq_r2_history_profile.test.mjs`
- `tests/uk_aq_prune_phase_b_paths.test.mjs`
- `tests/uk_aq_observs_history_r2_api_worker.test.mjs`
- `tests/uk_aq_aqi_history_r2_api_worker.test.mjs`
- `tests/uk_aq_cache_proxy.timeseries_v2_stitch.test.mjs`
- `tests/uk_aq_phase_3_repair_executor.test.mjs`
- `tests/backfill_v2_source_to_r2_writer_static.test.mjs`
- `scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py`

The binding publisher can live in the shared index module or as a narrowly scoped core-snapshot companion.  It must select a manifest-validated core day and resolve all binding fields before any binding PUT; the current Phase B path supplies no `authoritativeTimeseriesById`, and the full rebuild does not accept one.  That is the sole structural implementation blocker.

## Phase 1 exit criteria

- Daily observation/AQI index maintenance never reads, merges, or writes cumulative coverage objects.
- Binding publication is derived only from one validated core snapshot and is byte-stable when that mapping is unchanged.
- Observations API, cache proxy fallback, and AQI API fallback read the binding path/schema.
- Backup inventory tracks `timeseries_binding_v2` instead of `timeseries_metadata_v2`.
- Integrity/repair validates bindings against core identity, not daily coverage.
- Authoritative AQI docs and existing tests are updated in the same change; no speculative new suite is required.
