# Phase 0 Baseline Report: Option C R2 History Refactor

Date: 2026-06-18

## Scope

Phase 0 covers baseline inspection and safety archiving only. No runtime code, schemas, workflows, or deployed services were changed.

Option C target:

```text
R2-first source routing plus an R2 timeseries metadata index.
```

First deployable milestone remains Option B behavior:

```text
Historical-only requests with caller-supplied connector_id should avoid Supabase/IngestDB.
```

## Archive snapshot

Created:

```text
archive/2026-06-18_r2_history_refactor_option_c_phase0_snapshot/
```

Manifest:

```text
archive/2026-06-18_r2_history_refactor_option_c_phase0_snapshot/MANIFEST.txt
```

The snapshot contains current copies of likely amendment files before implementation starts. If later phases discover additional files that need edits, snapshot their current versions into this archive before changing them.

Archived file groups:

1. Cache proxy route and deploy config.
2. Observations and AQI R2 history Workers.
3. Shared R2 history index builder.
4. R2 backup inventory/index tooling.
5. R2 history integrity config/tests.
6. Station Snapshot v2 local and dashboard Worker code.
7. Relevant R2/cache docs.
8. Env master CSV.
9. Current refactor plan.

## Likely files to change

Runtime and route logic:

```text
workers/uk_aq_cache_proxy/src/index.ts
workers/uk_aq_cache_proxy/wrangler.toml
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
workers/shared/uk_aq_r2_history_index.mjs
workers/uk_aq_dashboard_online_api_worker/src/index.ts
workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts
_codex_context/serve.py
station_snapshot_v2/index.html
```

Tooling, tests, workflows, docs:

```text
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/lib/inventory.mjs
scripts/backup_r2/uk_aq_build_r2_history_index.mjs
scripts/uk_aq_cache_proxy/check_timeseries_v2_skeleton.mjs
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/tests/test_history_version_paths.py
.github/workflows/uk_aq_cache_proxy_deploy.yml
.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml
.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml
env-vars-master.csv
system_docs/uk-aq-r2-history-layout.md
system_docs/uk-aq-r2-history-dropbox-backup.md
system_docs/uk-aq-cache-proxy.md
system_docs/uk_aq_scripts.md
```

Potential new files:

```text
scripts/smoke_tests/r2_history_refactor_smoke.sh
system_docs/uk-aq-r2-history-refactor.md
```

## Current route ownership

Source inspection shows `/api/aq/timeseries` is handled by the cache proxy Worker route mapping:

```text
workers/uk_aq_cache_proxy/src/index.ts
```

The route key maps `timeseries` to `uk_aq_timeseries`. The v2 path is gated by:

```text
UK_AQ_TIMESERIES_V2_ENABLED
UK_AQ_TIMESERIES_PROXY_FIRST
UK_AQ_TIMESERIES_R2_FIRST
```

Local `.env` has these enabled:

```text
UK_AQ_TIMESERIES_V2_ENABLED=true
UK_AQ_TIMESERIES_PROXY_FIRST=true
UK_AQ_TIMESERIES_R2_FIRST=true
UK_AQ_R2_HISTORY_READ_VERSION=v2
```

Deploy workflows default `UK_AQ_R2_HISTORY_READ_VERSION` to `v1` unless GitHub variables override it. Treat this as a deployment drift check in later phases.

## Live probe result

Attempted test route:

```text
https://cic-test.chronicillnesschannel.co.uk/api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-01T00:00:00Z&format=compact&debug=1&v=2
```

Result:

```text
403 Cloudflare Error 1010: Access denied
```

The source baseline is still valid, but Phase 1/2 live smoke tests need either an allowed client signature/path or a test route that is not blocked by Cloudflare bot/access policy.

## Cache proxy baseline

Current behavior:

1. `normalizeTimeseriesPollutantKey()` accepts public v2 pollutant keys `pm25`, `pm10`, and `no2`.
2. v2 request canonicalization includes `pollutant`, but does not preserve caller-supplied `connector_id`.
3. `stitchTimeseriesV2FromR2AndIngest()` calls `loadTimeseriesConnectorId()` before R2 reads.
4. `loadTimeseriesConnectorId()` queries Supabase `uk_aq_core.timeseries` for `connector_id`.
5. If pollutant is missing, the route records `pollutant_required_for_v2_r2`.
6. If connector lookup fails, the route records `connector_id_lookup_failed`.
7. Source modes currently include `r2_only`, `r2_plus_ingest_tail`, `r2_plus_ingest_tail_and_repairs`, `ingest_only_on_r2_error`, and `ingest_only_fallback`.

Phase 1/2 implication:

```text
Even when a caller supplies connector_id=6, the current v2 cache proxy path does not use it and still performs a Supabase connector lookup.
```

This is the main behavior Option C must change.

## R2 v2 index baseline

The current v2 layout is intentional:

```text
history/_index_v2/observations_timeseries_latest.json
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

Do not add v1-style root files under `_index_v2`.

Source inspection found no existing project metadata index such as:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

Only unrelated `metadata_index` strings were found inside vendored Wrangler/Vectorize code in `node_modules`.

Phase 3 implication:

```text
Option C needs a new byte-stable R2 timeseries metadata index, unless live R2 contains an undocumented equivalent outside this repo.
```

## Observations R2 Worker baseline

Current behavior:

1. `UK_AQ_R2_HISTORY_READ_VERSION=v2` selects v2 prefixes.
2. v2 observations reads require pollutant to build the pollutant-partitioned index key.
3. Missing pollutant skips v2 scan and reports that pollutant is required.
4. v2 coverage reports `pollutant_partition`.

Relevant defaults:

```text
history/_index_v2
history/v2/observations
history/_index_v2/observations_timeseries
```

## AQI R2 Worker baseline

Current behavior:

1. `UK_AQ_R2_HISTORY_READ_VERSION=v2` selects v2 prefixes.
2. v2 AQI uses the canonical subprefix `aqilevels_hourly_data_timeseries`.
3. Missing pollutant stops v2 scanning with `v2_requires_pollutant_partition`.
4. v2 AQI coverage reports `pollutant_partition`.

Relevant defaults:

```text
history/_index_v2
history/v2/aqilevels/hourly/data
history/_index_v2/aqilevels_hourly_data_timeseries
```

## Station Snapshot v2 baseline

Local HTML:

```text
station_snapshot_v2/index.html
```

Current behavior:

1. Search request sends `q` and `pollutant`.
2. Rows request sends `station_id`, `pollutant`, `range`, and optional `timeseries_id`.
3. Rows request does not send selected `connector_id`, `station_ref`, `service_ref`, or `debug=1`.
4. Debug panel expects `chart_history_params_equivalent`, R2 row counts, AQI row counts, and selected metadata.

Local server:

```text
_codex_context/serve.py
```

Current behavior:

1. Resolves selected timeseries metadata, including `connector_id`, `station_ref`, `service_ref`, and `phenomenon_id`.
2. Builds `r2_params` with that metadata.
3. `_v2_fetch_chart_history_rows()` then calls `/api/aq/timeseries` with only:

```text
timeseries_id
pollutant
start
end
format=compact
```

4. It does not forward `connector_id` or `debug=1` to the chart route.
5. It also performs all-source comparison reads from ingestdb, ObsAQIDB, R2 observations, and R2 AQI.

Local `localhost:8080` probe:

```text
http://localhost:8080/api/station-snapshot-v2/rows?station_id=17081&timeseries_id=3742&pollutant=pm25&range=31d
```

Result:

```text
Timed out within 3 seconds.
```

Treat local server availability as unconfirmed in Phase 0.

Dashboard Worker:

```text
workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts
```

Current behavior:

1. `/api/station-snapshot-v2/search-stations` and `/api/station-snapshot-v2/rows` are routed in `src/index.ts`.
2. Rows route fetches timeseries metadata from Supabase.
3. Observations R2 probe includes `connector_id`, `pollutant`, `from_utc`, and `read_version=v2`.
4. AQI R2 probe includes `timeseries_id`, `pollutant`, `from_utc`, `format=objects`, and `read_version=v2`, but does not include `connector_id`.
5. Rows route does not expose chart-route `source_mode`, `used_r2`, or `used_supabase` diagnostics.

Phase implication:

```text
Station Snapshot v2 must split chart-route probing from all-source comparison diagnostics.
```

## Known test case baseline

Known test case from plan:

```text
timeseries_id=3742
connector_id=6
station_id=17081
station_ref=5200392
service_ref=openaq
pollutant=pm25
range includes 2026-05-21T09:00:00Z
```

Source-level expectation:

1. It should be answerable from v2 R2 if the exported v2 coverage contains the requested day and timeseries.
2. The current cache proxy still does a Supabase connector lookup before R2.
3. The current local Station Snapshot chart probe does not forward the known connector.
4. The current AQI Snapshot R2 probe does not forward connector metadata.

## Egress and database-size baseline

Current likely egress behavior:

1. Historical-only chart requests can still call Supabase for connector lookup and ingest fallback/tail behavior.
2. Response egress from Supabase can be reduced by routing historical-only requests to R2 when `connector_id` is supplied or resolved from R2 metadata.
3. Write/upload payload metrics are not evidence of Supabase billable egress improvement.
4. R2/Cloudflare cost impact is mainly Worker request volume and R2 operation counts, not R2 bandwidth egress.

Current database-size impact:

1. Phase 0 has no DB-size impact.
2. Option C should avoid new Postgres tables unless metrics or run logs are added later.
3. The R2 metadata index increases R2 object count and backup inventory surface.
4. Metadata payloads must be byte-stable, otherwise backup inventory and Dropbox sync can churn.

## Risks before implementation

1. Cloudflare live test endpoint is blocked by Error 1010 from this environment.
2. GitHub workflow defaults may deploy R2 Workers in v1 unless repo variables override them.
3. Existing cache proxy v2 source modes do not explicitly classify `history_only`, `recent_only`, and `recent_history_stitched`.
4. Caller-supplied `connector_id` is not currently preserved by v2 canonicalization/source routing.
5. Station Snapshot v2 diagnostic DB reads can obscure whether the chart route itself is R2-only.
6. No source-backed R2 timeseries metadata index exists yet.

## Commands run

Representative commands:

```bash
find . -path './archive' -prune -o -type f ...
grep -RInE "station-snapshot-v2|/api/aq/timeseries|UK_AQ_R2_HISTORY_READ_VERSION|aqilevels_hourly_data_timeseries|connector_id_lookup|pollutant_required_for_v2_r2" ...
sed -n '1180,1905p' workers/uk_aq_cache_proxy/src/index.ts
sed -n '1905,2165p' workers/uk_aq_cache_proxy/src/index.ts
grep -nE "pollutant|required|v2_requires|pollutant_code|readVersion|_index_v2" workers/uk_aq_observs_history_r2_api_worker/worker.mjs
grep -nE "pollutant|required|v2_requires|aqilevels_hourly_data_timeseries" workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
python3 - <<'PY'  # live route status probe, no secrets printed
python3 - <<'PY'  # localhost Station Snapshot status probe
```

## Phase 0 result

Phase 0 is complete enough to proceed to Phase 1.

Required next actions:

1. Update callers to forward `connector_id`, starting with Station Snapshot v2 and cache proxy canonicalization.
2. Add explicit source-mode routing in cache proxy.
3. Add or consume a byte-stable R2 metadata index for `timeseries_id -> connector_id/pollutant/coverage`.
4. Add smoke tests that can run against localhost and, once Cloudflare access is resolved, `cic-test`.
