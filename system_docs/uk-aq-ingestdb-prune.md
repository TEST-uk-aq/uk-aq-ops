# uk-aq-ingestdb-prune behavior

This document describes what the prune function does at runtime.

## Purpose

`POST /run` verifies that ingest observations older than the configured ingest retention window are present in history with identical content, then deletes only verified ingest buckets.

Bucket key is:

- `connector_id`
- `hour_start` (`date_trunc('hour', observed_at)` in UTC)

## Core flow

1. Build UTC window:
- `window_end = UTC midnight today - INGESTDB_RETENTION_DAYS`
- `window_start = window_end - MAX_HOURS_PER_RUN`
- If `MAX_HOURS_PER_RUN > 24`, split into sequential 24-hour internal batches and process each batch in order.

0. Phase B pre-prune history gate:
- Before fingerprint compare/delete work, the service runs Phase B R2 History export for closed UTC days through `utc_today - (INGESTDB_RETENTION_DAYS + 1 days)`.
- Example: on `2026-03-17`, with `INGESTDB_RETENTION_DAYS=7`, latest eligible day is `2026-03-09`; with `INGESTDB_RETENTION_DAYS=5`, latest eligible day is `2026-03-11`.
- Observations source rows are streamed through server-side projection function `uk_aq_ops.uk_aq_phase_b_history_rows` by `(day_utc, connector_id)` and written to R2 Parquet with ZSTD compression.
- The default v2 observations write allow-list is `pm25,pm10,no2,pm25index,pm10index,no2index`, preserving raw PM/NO2 concentration observations and Breathe London source-provided DAQI/index observations. `UK_AQ_R2_HISTORY_OBSERVATIONS_POLLUTANT_CODES` may override the list, but narrowing it to `pm10,pm25` excludes source-provided index observations and is not the intended default.
- Do not treat source-provided DAQI/index observation rows as disposable derived noise. They are retained source observations and are used for later comparison against UK AQ calculated DAQI/AQI outputs.
- Source-provided DAQI/index observations are different from UK AQ calculated AQI/DAQI history, which belongs under the separate aqilevels history path. Weather/metadata-style rows such as humidity, pressure, and temperature are not automatically equivalent to DAQI/index rows and may be excluded from public/history observations unless explicitly required.
- With v2 observation history, Phase B candidate `expected_row_count`, streamed rows, checkpoint/adoption row counts, Dropbox prune comparison exports, ingest/observs fingerprint comparison, and prune delete all use the same allow-list. Rows outside that list are reported as excluded and are not allowed to satisfy or block the v2 observations history gate, and are not deleted by the prune delete RPC.
- Observations part rollover defaults to `1,000,000` rows per file.
- Observations write each part directly to the version-selected committed prefix (`history/v1/observations/...` or, with `UK_AQ_R2_HISTORY_WRITE_VERSION=v2`, `history/v2/observations/...`) and persist resume checkpoint state after each part so retries continue from the last committed tuple instead of re-reading full-day rows.
- If failure cleanup has already removed a v2 candidate's partial objects and no connector manifest exists, a retry discards the stale saved checkpoint and restarts that connector/day from zero.
- AQI levels are exported in the same run for completed observation days that are missing AQI day manifests; AQI rows are streamed from `uk_aq_aqilevels.timeseries_aqi_hourly` grouped by connector and written to the version-selected AQI prefix. In v1 this is `history/v1/aqilevels/hourly/...`; in v2 the export writes both required profiles, `history/v2/aqilevels/hourly/data/...` and `history/v2/aqilevels/hourly/debug/...`, with separate profile manifests. V2 AQI discovery treats a day as pending if either the data or debug day manifest is missing, so data-present/debug-missing days are repaired by the next export run.
- AQI export preserves rows where `station_id` is null (instead of dropping them), so connector/day row-count validation stays aligned with source RPC totals.
- Phase B writes manifests, verifies object existence, and updates:
  - `uk_aq_ops.history_candidates`
  - `uk_aq_ops.prune_day_gates.history_done`
- After a successful non-dry Phase B history export, the service rebuilds derived R2 index manifests from committed day manifests and connector manifests:
  - `history/_index/observations_latest.json`
  - `history/_index/aqilevels_latest.json`
  - `history/_index/observations_timeseries_latest.json`
  - `history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
- Index rebuild is best-effort:
  - failures are logged as `phase_b_history_index_rebuild_failed`
  - prune compare/delete work continues, so core prune safety is not blocked by index refresh drift
- `uk_aq_ops.prune_day_gates.history_done` continues to gate prune deletes using observation backup completion.
- The prune history gate also requires a non-empty day-level manifest key and `history_completed_at`. Accepted day manifest paths are legacy v1 observation/AQI hourly manifests and v2 observation manifests, including `history/v2/observations/day_utc=YYYY-MM-DD/manifest.json`. Connector-level or pollutant-level manifests under a day do not satisfy the day gate.
- Legacy staging objects are still cleaned up by retention policy (`history/v1/_ops/observations/staging/...`) to drain old runs.
- Prune deletion for an hour bucket is allowed only when that bucket day has `history_done=true`.

2. Fetch hourly summaries via RPC from both DBs:
- ingest: `uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint`
- history: `uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint`
- Hash inputs include `connector_id`, `timeseries_id`, `observed_at`, and `value` (status is excluded in both DBs).

3. Compare buckets by `(connector_id, hour_start)`:
- missing in history -> mismatch
- count differs -> mismatch
- fingerprint differs -> mismatch
- count and fingerprint equal -> deletable

Comparison scope rule:

- A bucket must exist in ingest to be checked for parity and considered for deletion.
- Buckets that exist only in history are not treated as mismatches for delete gating.

4. Log structured results:
- mismatches at `ERROR`
- deletable plan at `INFO`
- history-only buckets at `INFO` with event `history_extra_buckets`

5. Late-arrival cleanup pass (code-only, no new env vars):
- After the main window run, the service scans stale observations directly by `observed_at` and looks for any rows older than the current prune window start.
- Discovery bounds:
  - page size `1000`
  - max discovery pages `100`
  - discovery scan cap `100,000` stale rows per run
  - max targeted day windows per run `14`
- The late-arrival target list is split by the obs_aqidb retention cutover:
  - days older than `OBS_AQIDB_OBSERVS_RETENTION_DAYS` (default `14`, overrideable via `obsAqidbObservsRetentionDays`) are deleted directly from ingest by hour bucket, without compare/repair
  - younger days still run the normal targeted 24-hour compare/repair/delete flow and the same history gate checks
  - the `14`-day cap now applies only to the repair-eligible subset, not to the direct-delete subset
- If the backlog is larger than the discovery scan cap, rerunning the prune job will continue from the remaining stale rows.
- This catches backfilled historical observations that arrived recently without widening the normal daily prune window.

## Dry-run behavior

When `INGESTDB_PRUNE_DRY_RUN=true`, no delete RPC is called.

If `REPAIR_ONE_MISMATCH_BUCKET=true`, dry-run also runs a repair pilot for one mismatch bucket:

1. Enqueue that bucket’s rows to ingest outbox via:
- `uk_aq_public.uk_aq_rpc_observs_outbox_enqueue_hour_bucket`

2. Flush outbox immediately, inside the prune run itself:
- claim: `uk_aq_public.uk_aq_rpc_observs_outbox_claim`
- upsert to history: `uk_aq_public.uk_aq_rpc_observs_observations_upsert`
- receipts upsert: `uk_aq_public.uk_aq_rpc_observs_sync_receipt_daily_upsert`
- resolve: `uk_aq_public.uk_aq_rpc_observs_outbox_resolve`
- upsert behavior is timeout-safe: retries transient errors, and on statement timeout recursively splits payload batches before failing.
- duplicate rows across claimed outbox entries are de-duplicated in-memory by `(connector_id, timeseries_id, observed_at)` before history upsert.

3. Recheck that same bucket with hourly fingerprint RPCs.

Important:

- The prune function does its own outbox flush logic in-process.
- It does not call the separate `uk-aq-observs-outbox-flush-service` endpoint.

## Live delete behavior

When `INGESTDB_PRUNE_DRY_RUN=false`, the flow is:

1. First compare pass and first delete pass:
- delete all buckets that already match
- log mismatches

2. Repair phase:
- enqueue all repairable mismatch buckets into history outbox
- flush outbox in-process (same RPC chain as dry-run pilot)

3. Recheck phase:
- group the original mismatch buckets by UTC hour
- re-run the fingerprint compare sequentially for each distinct repaired hour, rather than
  re-hashing the full 24-hour batch window
- delete buckets that are now verified
- log buckets that still mismatch after repair

Only one repair/recheck cycle is executed per run.

Delete RPC:

- `uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket`
- In v2 history mode the worker passes `p_pollutant_codes`, so the RPC deletes only observations whose timeseries resolves to an allowed observed property code. Without `p_pollutant_codes`, the RPC retains its legacy all-observations behavior.
- The same `p_pollutant_codes` list is passed to ingest and observs hourly fingerprint RPCs. This keeps delete eligibility aligned with R2 `history/v2/observations` eligibility and prevents humidity/pressure/temperature-style rows from blocking or satisfying the v2 observations gate unless those codes are explicitly allow-listed.

Each bucket is deleted in bounded batches until:

- delete RPC returns `0` (drained), or
- `MAX_DELETE_BATCHES_PER_HOUR` is reached (warning + alert condition)

## Guardrails

- All date/hour logic is UTC.
- No raw row comparison is moved out of DBs for verification; only bucket aggregates are compared.
- Buckets with any mismatch are skipped from delete in each pass.
- `history_count > ingest_count` is logged as a specific error condition and not deleted.

## Logging details

- Logs are structured JSON on Cloud Run stdout/stderr and appear in Cloud Logging.
- On fatal run errors (`ingestdb_prune_run_error`, HTTP `500`), the service also attempts a Dropbox error upload when Dropbox env/secrets are configured.
- Dropbox error path format: `<UK_AQ_DROPBOX_ROOT>/error_log/YYYY-MM-DD/uk_aq_error_cloud_run_ingestdb_prune_<timestamp>_<uuid>.json`.
- Dropbox upload uses:
  - `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
  - optional `UK_AQ_DROPBOX_ROOT`
  - optional `UK_AIR_ERROR_DROPBOX_FOLDER` (default `/error_log`)
  - optional allowlist gate `UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (must match `SUPABASE_URL`/`SB_URL` when set)
- For batched runs (`MAX_HOURS_PER_RUN > 24`), the service logs:
  - `ingestdb_prune_batch_plan` at run start
  - per-batch `ingestdb_prune_run_start`
  - one final aggregate summary event (`ingestdb_prune_dry_run_batched_summary` or `ingestdb_prune_delete_batched_summary`)
- Late-arrival pass logs:
  - `ingestdb_late_arrival_discovery_summary`
  - `ingestdb_late_arrival_cleanup_plan`
  - `ingestdb_late_arrival_cleanup_summary`
  - optional per-day failure event: `ingestdb_late_arrival_cleanup_day_error`
- History-only buckets (present in history, missing in ingest) are logged once per run as:
  - `severity=INFO`
  - `event=history_extra_buckets`
  - fields: `count` and `sample` (sample bucket list)
- They are informational only and do not block deletes.
- This is expected after successful prune runs, because deleted ingest buckets will remain in history.

## Runtime inputs

Required:

- `SUPABASE_URL`
- `OBS_AQIDB_SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SECRET_KEY`

Key optional controls:

- `INGESTDB_PRUNE_DRY_RUN` (default `true`)
- `INGESTDB_RETENTION_DAYS` (default `5`)
- `MAX_HOURS_PER_RUN` (default `48`)
- `DELETE_BATCH_SIZE` (default `50000`)
- `MAX_DELETE_BATCHES_PER_HOUR` (default `10`)
- `REPAIR_ONE_MISMATCH_BUCKET` (default `true`)
- `REPAIR_BUCKET_OUTBOX_CHUNK_SIZE` (default `1000`)
- `FLUSH_CLAIM_BATCH_LIMIT` (default `20`)
- `MAX_FLUSH_BATCHES` (default `30`)
- `UK_AQ_R2_HISTORY_PHASE_B_ENABLED` (default `true`)
- `UK_AQ_R2_HISTORY_PART_MAX_ROWS` (default `1000000`; shared fallback used by AQI exports when AQI-specific overrides are unset)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS` (default `500000`; observations override, falls back to `UK_AQ_R2_HISTORY_PART_MAX_ROWS`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS` (default shared fallback above)
- `UK_AQ_R2_HISTORY_CURSOR_FETCH_ROWS` (default `20000`)
- `UK_AQ_R2_HISTORY_ROW_GROUP_SIZE` (default `100000`; shared fallback used by AQI exports when AQI-specific overrides are unset)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE` (default `50000`; observations override, falls back to `UK_AQ_R2_HISTORY_ROW_GROUP_SIZE`)
- `UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE` (default shared fallback above)
- `UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN` (default `500`)
- `UK_AQ_R2_HISTORY_ADOPT_EXISTING_MANIFEST_ENABLED` (default `true`; adopt existing committed connector manifest/day when present instead of rewriting connector parquet/manifest)
- `UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_ENABLED` (default `false`; optional Dropbox comparison export for adopted connectors)
- `UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_REQUIRED` (default `false`; fail adoption if comparison upload fails when enabled)
- `UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_DIR` (default `prune_r2_check`)
- `UK_AQ_R2_HISTORY_STAGING_RETENTION_DAYS` (default `7`)
- `UK_AQ_R2_HISTORY_STAGING_PREFIX` (default `history/v1/_ops/observations/staging`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels/hourly`)
- `UK_AQ_R2_HISTORY_WRITE_VERSION` (default `v1`; allowed `v1|v2`; controls Phase B observation, AQI-level, and run-manifest write paths)
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX` (default `history/v2/observations`)
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX` (default `history/v2/aqilevels/hourly/data`)
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX` (default `history/v2/aqilevels/hourly/debug`)
- `UK_AQ_R2_HISTORY_RUNS_PREFIX` (v1 run-manifest prefix; default `history/v1/_ops/observations/runs`)
- `UK_AQ_R2_HISTORY_V2_RUNS_PREFIX` (v2 run-manifest prefix; default `history/v2/_ops/observations/runs`)
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX` (default `history/_index/observations_timeseries`)

R2 history v2 writer support:
- v1 remains the default write path.
- v2 observations are pollutant-partitioned and use `connector_id`, `station_id`, `timeseries_id`, `pollutant_code`, `observed_at_utc`, `value`.
- v2 daily prune rows come from `uk_aq_ops.uk_aq_phase_b_history_rows_v2(...)`,
  which resolves `pollutant_code` in Postgres via
  `observations -> timeseries -> phenomena -> observed_properties`.
- v2 daily prune includes all observations with a known pollutant code; it is
  not limited to AQI pollutants.
- v2 AQI hourly writes are split into compact `data` parquet and richer `debug` parquet.
- v2 AQI debug parquet intentionally excludes old wide compatibility fields such as `pm25_rolling24h_mean_ugm3` and `updated_at`.
- Validate the writer schema with `node --test tests/phase_b_history_r2.test.mjs`.

Website observation API note:
- `uk_aq_timeseries` now uses `INGESTDB_RETENTION_DAYS` as the single split control. The freshest retention window comes from ingestdb, and older observation history comes from R2 history. ObsAQIDB is not used for observation line chart data.

Phase B required env/secrets:

- `SUPABASE_DB_URL` (direct Postgres URL for streaming cursor reads)
- `CFLARE_R2_ENDPOINT`
- `CFLARE_R2_REGION` (default `auto`)
- `CFLARE_R2_BUCKET` (or fallback `R2_BUCKET`; Test and LIVE use separate Cloudflare/R2 accounts, so no deploy-env bucket selector is needed)
- `CFLARE_R2_ACCESS_KEY_ID`
- `CFLARE_R2_SECRET_ACCESS_KEY`

## Related SQL scripts

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/ingest_db_ops_rpcs.sql`
- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`
- Fingerprint RPCs depend on `pgcrypto.digest`; keep `pgcrypto` installed and accessible via function `search_path` (for example `extensions` and/or `public`).

For deployment and scheduler wiring, use:

- `README.md`
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`
- Scheduler attempt deadline variable: `GCP_UK_AQ_PRUNE_DAILY_SCHEDULER_ATTEMPT_DEADLINE` (fallback aliases accepted), default `15m`.

Are you sure that the builder runs in uk_aq_prune_daily?

Good push — let me actually verify rather than asserting.

Yes — confirmed with three pieces of evidence:

The caller exists. workers/uk_aq_prune_daily/server.mjs:1922 invokes rebuildR2HistoryIndexes after Phase B completes successfully.

prune-daily runs daily at 02:00 UTC. system_docs/uk_aq_cron_schedules.csv:17:


CIC-test-uk-aq-ops, GCP Cloud Scheduler, uk-aq-prune-daily, 0 2 * * *, Daily @ 02:00 UTC, Prune old observations
That's 2.5 hours before your 04:35 UTC backup workflow — fits the symptom exactly.

The rebuild is unconditional. workers/shared/uk_aq_r2_history_index.mjs:1151-1157 does an unconditional r2PutObject for every day × connector — no "skip if content matches existing" check. With generated_at: new Date().toISOString() baked into the payload at line 616, every PUT writes a different MD5 even when underlying data is identical.

So every daily prune-daily run rewrites every tree-unit manifest (1059 days × ~4 connectors × 2 domains ≈ ~3930 R2 PUTs) regardless of whether anything actually changed.

One nuance I should have stated up front
There's no separate "index rebuild" scheduled job — it's a side effect of uk_aq_prune_daily's Phase B success path. The rebuild fires:

✅ Daily, when Phase B runs and completes (the common case)
❌ NOT if Phase B is disabled or errors out
❌ NOT in dry-run mode
So if Phase B were ever to be disabled or skipped, the daily churn would stop and the inventory builder would suddenly become fast. The user could test this hypothesis by temporarily disabling Phase B for one prune-daily run — the next day's backup would have full reuse on tree units (proving the churn is the index rebuild, not something else).

But I'd recommend the fix (Option A.3: stop including generated_at in the hashable payload, or use a data-driven timestamp) rather than that test, since the test breaks the index for one day.

Was there something specific about the prune-daily connection that didn't feel right? I want to make sure I'm answering the actual concern.

I was just checking that it actually did. I suppose there is a good reason to also rebuild it there, because the R2 data has changed, so it keeps the inventory fresh. 

## Diagnosing prune daily v2 Phase B history timeouts

Use this focused check when `uk-aq-prune-daily` reaches the Cloud Run request limit while writing v2 observations history.

1. Read structured logs for the affected Phase B run id:

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 resource.labels.service_name="uk-aq-prune-daily"
 jsonPayload.run_id="<PHASE_B_RUN_ID>"' \
--project project-53835517-a266-48e3-8d9 \
--limit 300 \
--order asc \
--format='table(timestamp,severity,jsonPayload.event,jsonPayload.run_id,jsonPayload.day_utc,jsonPayload.connector_id,jsonPayload.pollutant_code,jsonPayload.message,textPayload)'
```

2. Check for partial v2 observations output and missing manifests in CIC-Test R2:

```sh
rclone lsl "uk_aq_r2_test:uk-aq-history-cic-test/history/v2/observations/day_utc=2026-06-12/"
rclone lsf "uk_aq_r2_test:uk-aq-history-cic-test/history/v2/observations/day_utc=2026-06-12/" --recursive --files-only | grep -i manifest || echo "NO MANIFEST"
```

3. Before rerunning the affected CIC-Test day, remove manifestless partial output so the next run starts from a clean final prefix:

```sh
rclone purge "uk_aq_r2_test:uk-aq-history-cic-test/history/v2/observations/day_utc=2026-06-12"
```

For CIC-Test investigation runs, keep Phase B bounded and force explicit manifest validation with deployment environment overrides such as:

```sh
UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN=1
UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS=1000
UK_AQ_R2_HISTORY_ADOPT_EXISTING_MANIFEST_ENABLED=false
UK_AQ_R2_HISTORY_MAX_SECONDS_PER_RUN=840
UK_AQ_R2_HISTORY_STOP_BEFORE_TIMEOUT_SECONDS=60
```

A successful rerun for `2026-06-12` should leave `history/v2/observations/day_utc=2026-06-12/connector_id=<id>/pollutant_code=<code>/part-*.parquet`, pollutant `manifest.json` files, connector `manifest.json` files, and the day-level `history/v2/observations/day_utc=2026-06-12/manifest.json`. Parquet files without their corresponding manifests are partial garbage and must not be treated as complete.
