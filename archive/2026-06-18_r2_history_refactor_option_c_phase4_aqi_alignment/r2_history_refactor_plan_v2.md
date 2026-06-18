# UK AQ R2 History Refactor Plan v2

## Purpose

This plan refactors the UK AQ historical chart and diagnostic data path so that historical observations and AQI rows can be read from R2 without unnecessary Supabase/IngestDB dependency.

This version supersedes the first `r2_history_refactor_plan.md`. It incorporates the later R2 index v1/v2 analysis and the cache proxy pollutant check.

Downsampling is deliberately excluded from this refactor. It will be handled later as a separate chart-performance and long-range rendering project.

## Plan assessment

This plan is a good direction and should improve the system if implemented with the constraints below.

The strongest parts are:

1. It keeps raw historical granularity and leaves downsampling out of scope.
2. It recognises that `_index_v2` is intentionally different from `_index`.
3. It keeps pollutant mandatory for v2, which matches the pollutant-partitioned index layout.
4. It separates historical-only, recent-only, and stitched requests before fetching data.
5. It reduces unnecessary Supabase dependency for historical chart reads.
6. It keeps observations history and AQI history as separate data products with separate coverage.

The plan should be tightened in four places:

1. Station Snapshot v2 must be included as a first-class refactor target, not only as a caller note.
2. The local Station Snapshot v2 server currently builds `/api/aq/timeseries` probes without forwarding `connector_id` or `debug=1`; this must be fixed.
3. Station Snapshot v2 comparison reads should be separated from chart-route source-routing probes so diagnostic DB reads do not hide whether the chart path itself is R2-only.
4. Any R2 metadata index must obey the R2 history index byte-stability policy. Generated fields must be derived from source manifests, not wall-clock time, otherwise backup inventory and Dropbox sync churn will be expensive.

## Implementation options and recommendation

### Option A: Minimal caller fix only

Make chart and Station Snapshot v2 callers pass `connector_id` and `pollutant`, but leave current source routing mostly unchanged.

Pros:

1. Lowest implementation risk.
2. Immediate reduction in avoidable Supabase connector lookups where callers already know `connector_id`.
3. Smallest code change surface.
4. Supabase endpoint response egress may fall slightly if debug/coverage payloads are also trimmed.
5. Database-size impact is effectively none because no new tables or indexes are required.

Cons:

1. Historical-only requests can still call Supabase/IngestDB for recent or fallback logic.
2. It does not fully deliver the older line-chart behaviour.
3. R2 operation volume may remain higher than needed if routing still performs unnecessary probes.
4. Supabase billable egress improvement is limited because the main historical request path is not fully separated.
5. Station Snapshot v2 would still risk mixing diagnostic comparison DB reads with chart-route source diagnostics.

### Option B: R2-first source routing without R2 metadata index

Implement source-mode routing and skip Supabase for historical-only requests when callers provide `connector_id`.

Pros:

1. Delivers the main behavioural improvement for modern callers.
2. Supabase endpoint response egress should drop for historical-only chart windows because Supabase is no longer called for those responses.
3. Database CPU/query load should drop for historical-only requests with complete caller metadata.
4. Database-size impact is none, aside from any existing metric rows produced by the route.
5. R2/Cloudflare cache effectiveness improves because historical-only URLs can be stable and longer-lived.

Cons:

1. Older callers that omit `connector_id` still need a fallback unless rejected.
2. Source routing becomes dependent on callers being correctly updated.
3. Station Snapshot search still needs metadata from Supabase/IngestDB unless a separate search index exists.
4. R2 Class B reads and Worker requests may increase as traffic moves from Supabase to R2, though Cloudflare cache should absorb repeated stable requests.

### Option C: R2-first routing plus R2 timeseries metadata index

Implement source-mode routing and add or consume an R2 metadata index for `timeseries_id -> connector_id/pollutant/coverage`.

Pros:

1. Best long-term decoupling from Supabase for historical-only reads.
2. Handles older callers that only pass `timeseries_id` and `pollutant`.
3. Improves Station Snapshot v2 diagnostics because it can show whether R2 itself has enough metadata.
4. Supabase endpoint response egress should drop most for historical-only chart/API requests, because both row reads and connector lookups can avoid Supabase.
5. Database query load drops for historical-only requests, especially repeated line-chart requests.

Cons:

1. More implementation and test surface.
2. Adds R2 index objects, so R2 object count and backup inventory surface increase.
3. R2 Class B reads can increase for cold metadata/index lookups, though stable cache keys should keep repeated requests cheap.
4. Database-size impact is still low if the metadata index is only in R2, but any additional DB metrics will add small metric-table growth.
5. If metadata payloads are not byte-stable, backup inventory and Dropbox sync can churn heavily.

### Option D: Add v1-style root summary files under `_index_v2`

Add `_index_v2/observations_latest.json`, `_index_v2/aqilevels_latest.json`, or `_index_v2/aqilevels_timeseries_latest.json`.

Pros:

1. May make some old diagnostics look familiar.
2. Could be easy to inspect manually.

Cons:

1. Conflicts with the current v2 design.
2. Creates misleading parity with v1 semantics.
3. Adds R2 object and backup inventory surface without a proven consumer need.
4. Does not solve pollutant-partitioned v2 reads.
5. Supabase endpoint response egress and database-size impact are effectively not improved.

Recommended option: Option C, implemented in phases, with Option B as the first deployable milestone.

The reason is mainly egress and database load: Option B is enough to stop Supabase endpoint response egress for modern historical-only chart requests that include `connector_id`, while Option C also removes the connector-lookup fallback for older callers. The database-size impact stays low because the main new storage is in R2 metadata, not Postgres, but the R2 object-count and backup churn risk means the metadata index must be generated only if consumed and must be byte-stable.

## Current conclusion

The v2 R2 index root is not missing files by accident. v2 intentionally uses a different layout from v1.

v1 root latest files:

```text
history/_index/observations_latest.json
history/_index/aqilevels_latest.json
history/_index/observations_timeseries_latest.json
history/_index/aqilevels_timeseries_latest.json
```

v2 root latest files:

```text
history/_index_v2/observations_timeseries_latest.json
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
```

v2 does not currently define or generate root equivalents of:

```text
history/_index_v2/observations_latest.json
history/_index_v2/aqilevels_latest.json
history/_index_v2/aqilevels_timeseries_latest.json
```

Do not add those v1-style files to `_index_v2` unless a future consumer genuinely needs them.

v2 read acceleration is based on pollutant-partitioned timeseries file-range indexes:

```text
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

The canonical v2 AQI index name is:

```text
aqilevels_hourly_data_timeseries_latest.json
```

not:

```text
aqilevels_timeseries_latest.json
```

## Current pollutant conclusion

The cache proxy already has pollutant handling. It normalises the public `pollutant` parameter, includes it in the cache key, and forwards it to the R2 observations history Worker.

Therefore this refactor should not add duplicate pollutant handling to `workers/uk_aq_cache_proxy/src/index.ts` unless the code has changed.

The rule for this refactor is:

```text
Do not add pollutant handling where it already exists.
Verify it, enforce it, and make sure every active R2-first path and caller supplies it.
```

For v2 R2 reads, pollutant remains mandatory because the v2 indexes are pollutant-partitioned.

Accepted public pollutant values should remain:

```text
pm25
pm10
no2
```

Optional aliases may be accepted internally if already supported, for example:

```text
pm2.5
pm2_5
pm2p5
```

but the public chart and diagnostic contract should prefer `pm25`, `pm10`, and `no2`.

## Problem to solve

At the moment the chart data path still has unnecessary coupling between historical R2 reads and Supabase/IngestDB.

The desired older line-chart behaviour is:

```text
Historical-only range outside retention + overlap:
  Use R2 only.
  Do not call Supabase.
  Do not require IngestDB.

Recent range inside retention:
  Use Supabase/IngestDB recent data.

Range crossing boundary:
  Use R2 for historical window.
  Use Supabase/IngestDB for retention tail.
  Use a one-day overlap for stitching/deduplication.
```

The current system also needs clearer separation between observations history and AQI history. They are separate R2 data products and their coverage can differ. The v2 export showed observations one day ahead of AQI, which is plausible for a derived AQI pipeline but must be handled explicitly.

## Goals

1. Make historical-only chart and diagnostic reads R2-only.
2. Keep Supabase/IngestDB only for the recent retention window and one-day overlap.
3. Avoid Supabase connector lookups when `connector_id` is supplied by the caller or resolvable from R2 metadata.
4. Keep pollutant mandatory and enforced for v2 R2 reads.
5. Keep the v2 index root layout unchanged.
6. Align observations and AQI R2 history APIs around a common request contract.
7. Add enough R2 metadata/index support to make old chart reads reliable without Supabase.
8. Move heavy debug/coverage output behind `debug=1` or equivalent.
9. Reduce response size and egress by returning only fields needed for charting unless diagnostics request more.
10. Add deployment and smoke tests that detect route drift between cache proxy, Supabase Edge Functions, and Workers.
11. Include Station Snapshot v2 in the refactor so it can verify the same R2-first observations and AQI paths used by the chart.
12. Keep Station Snapshot v2 diagnostic comparison reads explicit, so intentional DB comparison queries are not confused with chart-route Supabase dependency.

## Non-goals

The following are intentionally out of scope for this refactor:

1. Downsampling or adaptive chart resolution.
2. Redesigning the visual chart UI.
3. Adding v1-style root latest files to `_index_v2`.
4. Removing Supabase/IngestDB from the live/recent path.
5. Changing AQI colour palettes.
6. Backfilling all v2 history in the same code refactor, unless a phase explicitly confirms that is safe and quick.
7. Replacing Station Snapshot v2 search with a full R2 station-search index. The rows/history probes can become R2-first; station search can keep using the current metadata source until a separate search-index project exists.

## Key terms

### Retention window

The recent data period still served from Supabase/IngestDB. In recent code this has been around 4 to 5 days, controlled by environment configuration.

### Overlap day

A one-day overlap before the retention start. It allows R2 and IngestDB data to be stitched safely, with deduplication by timestamp.

### Historical-only request

A request where the full requested `end_utc` is older than the retention start, or older than `retention_start - overlap` depending on the final boundary definition.

### Stitched request

A request crossing the historical/recent boundary and requiring both R2 and IngestDB.

### R2-first path

A request path that tries R2 as the primary source for historical data and uses Supabase only when the request requires recent/retention data or a compatibility fallback.

## Existing layout to preserve

### v1 index root

```text
history/_index/
  observations_latest.json
  aqilevels_latest.json
  observations_timeseries_latest.json
  aqilevels_timeseries_latest.json
  observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
  aqilevels_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

### v2 index root

```text
history/_index_v2/
  observations_timeseries_latest.json
  aqilevels_hourly_data_timeseries_latest.json
  observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
  aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

The refactor must keep this distinction clear in docs, tests, diagnostics, and inventory tooling.

## Recommended final request contracts

### Observations history R2 Worker

Preferred request:

```text
GET /v1/observations
  ?timeseries_id=<id>
  &connector_id=<id>
  &pollutant=pm25|pm10|no2
  &start_utc=<ISO>
  &end_utc=<ISO>
  [&since_utc=<ISO>]
  [&limit=<n>]
  [&debug=1]
```

Required for v2:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
```

Compatibility fallback:

If `connector_id` is missing, the Worker may use an R2 timeseries metadata index to resolve it. It should not call Supabase.

If `pollutant` is missing in v2 mode, return a clear 400 or structured partial response. Do not scan all pollutant partitions.

### AQI history R2 Worker

Preferred request:

```text
GET /v1/aqi
  ?timeseries_id=<id>
  &connector_id=<id>
  &pollutant=pm25|pm10|no2
  &start_utc=<ISO>
  &end_utc=<ISO>
  [&since_utc=<ISO>]
  [&limit=<n>]
  [&debug=1]
```

Required for v2:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
```

AQI Worker must use:

```text
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
history/_index_v2/aqilevels_hourly_data_timeseries/...
```

It must not look for `aqilevels_timeseries_latest.json` under `_index_v2`.

### Cache proxy `/api/aq/timeseries`

Preferred public request:

```text
/api/aq/timeseries
  ?timeseries_id=<id>
  &connector_id=<id>
  &pollutant=pm25|pm10|no2
  &start=<ISO>
  &end=<ISO>
  &format=compact
```

Compatibility:

`connector_id` may remain optional for older callers, but the proxy should skip Supabase connector lookup when `connector_id` is provided.

### Cache proxy `/api/aq/aqi-history` or equivalent

If an AQI history endpoint exists or is added, use a parallel contract:

```text
/api/aq/aqi-history
  ?timeseries_id=<id>
  &connector_id=<id>
  &pollutant=pm25|pm10|no2
  &start=<ISO>
  &end=<ISO>
  &format=compact
```

If the existing chart fetches AQI through a different route, align that route rather than creating an unnecessary duplicate endpoint.

## Recommended response shapes

### Compact observations response

For public chart calls:

```json
{
  "timeseries_id": 3742,
  "columns": ["observed_at", "value"],
  "data_format": "compact",
  "count": 24,
  "source": "r2_history",
  "response_complete": true,
  "meta": {
    "source_mode": "history_only",
    "r2_row_count": 24,
    "ingest_row_count": 0,
    "has_gap": false
  },
  "data": [
    ["2026-05-21T09:00:00.000Z", 10.9]
  ]
}
```

### Compact AQI response

For public chart calls, avoid sending colour strings if the frontend can derive them from levels:

```json
{
  "timeseries_id": 3742,
  "columns": [
    "observed_at",
    "hourly_mean_ugm3",
    "rolling24h_mean_ugm3",
    "daqi_index_level",
    "eaqi_index_level"
  ],
  "data_format": "compact",
  "count": 24,
  "source": "r2_aqi_history",
  "response_complete": true,
  "meta": {
    "source_mode": "history_only",
    "r2_row_count": 24,
    "has_gap": false
  },
  "data": [
    ["2026-05-21T09:00:00.000Z", 10.9, 8.4, 2, 1]
  ]
}
```

For Station Snapshot v2 or diagnostics, `debug=1` can return richer coverage and index details.

## R2 metadata/index additions

To avoid Supabase outside the retention path, add a lightweight R2 metadata index if it does not already exist.

### Timeseries metadata index

Proposed key pattern:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

or sharded for scale:

```text
history/_index_v2/timeseries/id_prefix=<prefix>/timeseries_id=<id>.json
```

Example payload:

```json
{
  "history_version": "v2",
  "timeseries_id": 3742,
  "timeseries_ref": "14153308",
  "station_id": 17081,
  "station_ref": "5200392",
  "connector_id": 6,
  "service_ref": "openaq",
  "pollutant_code": "pm25",
  "first_observed_at": "2026-03-18T00:00:00.000Z",
  "last_observed_at": "2026-06-07T23:00:00.000Z",
  "observations_coverage": {
    "first_day_utc": "2026-03-18",
    "last_day_utc": "2026-06-13",
    "row_count": 1960
  },
  "aqi_coverage": {
    "first_day_utc": "2026-03-18",
    "last_day_utc": "2026-06-12",
    "row_count": 1960
  },
  "updated_at": "2026-06-18T00:00:00.000Z"
}
```

This allows R2-only historical reads when callers omit `connector_id`, and it supports diagnostics without Supabase.

### Connector and pollutant coverage summary

Optional but useful for diagnostics and cache planning:

```text
history/_index_v2/coverage/observations/connector_id=<id>/pollutant_code=<pollutant>.json
history/_index_v2/coverage/aqilevels_hourly_data/connector_id=<id>/pollutant_code=<pollutant>.json
```

Example payload:

```json
{
  "history_version": "v2",
  "domain": "observations",
  "connector_id": 6,
  "pollutant_code": "pm25",
  "first_day_utc": "2026-03-18",
  "last_day_utc": "2026-06-13",
  "manifest_count": 88,
  "timeseries_count": 1234,
  "row_count": 1234567
}
```

This is not a v1-style root summary. It is a targeted v2 coverage helper.

### Important constraint

Do not add these unless they are generated by the index builder and consumed by real read paths or diagnostics. Avoid extra index files that duplicate v1 semantics and increase confusion.

## Source routing logic

The cache proxy, or the central timeseries route, should classify every request before fetching data.

Pseudo-logic:

```text
retention_start = now - retention_days
overlap_start = retention_start - 1 day

if request_end <= overlap_start:
  source_mode = history_only
  fetch R2 observations and/or AQI only
  do not call Supabase

else if request_start >= overlap_start:
  source_mode = recent_only
  fetch Supabase/IngestDB recent data only

else:
  source_mode = recent_history_stitched
  fetch R2 for [request_start, retention_start]
  fetch Supabase/IngestDB for [overlap_start, request_end]
  dedupe by observed_at, with R2 preferred for history/overlap where appropriate
```

The precise overlap boundary should match existing production behaviour, but the principle is:

```text
Supabase must not be required for requests wholly outside retention + overlap.
```

Station Snapshot v2 should reuse the same routing decision for its chart-history probe. Its separate all-source comparison table may still query ingestdb and ObsAQIDB, but that must be reported as diagnostic comparison work, not as source routing required by `/api/aq/timeseries`.

## Supabase usage policy

Allowed Supabase use:

1. Live/recent observations inside retention.
2. Retention tail for stitched requests.
3. One-day overlap for stitching/deduplication.
4. Compatibility fallback only when older callers omit metadata and R2 metadata index does not yet exist.
5. Station Snapshot v2 `compare_all_sources` diagnostics, when explicitly labelled as comparison queries.

Disallowed Supabase use after this refactor:

1. Historical-only R2 reads.
2. Resolving `connector_id` for historical-only reads when caller supplied `connector_id`.
3. AQI historical reads outside retention.
4. Station Snapshot v2 `chart_probe` diagnostics outside retention, except where explicitly testing Supabase fallback.
5. Treating Station Snapshot v2 comparison DB reads as proof that the production chart route needs Supabase.

## Caller requirements

### Hex map chart

For every line-chart observations request, include:

```text
timeseries_id
connector_id
pollutant
start/end or window
format=compact
```

For every AQI history request, include:

```text
timeseries_id
connector_id
pollutant
start/end or window
format=compact
```

### Station Snapshot v2

For every rows request and debug probe, include:

```text
station_id
timeseries_id when selected
connector_id when known
station_ref when known
service_ref when known
pollutant
range or start/end
debug=1 for diagnostic probes
```

Station Snapshot v2 should request `debug=1` so it receives detailed route/source/index diagnostics.

Current local files to update during this refactor:

```text
_codex_context/serve.py
station_snapshot_v2/index.html
```

Related deployed/local API implementation to audit during the same phase:

```text
workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts
workers/uk_aq_dashboard_online_api_worker/src/index.ts
```

Current Station Snapshot v2 findings from the local files:

1. `station_snapshot_v2/index.html` calls `/api/station-snapshot-v2/rows` with `station_id`, `pollutant`, `range`, and optional `timeseries_id`.
2. It does not currently pass `connector_id`, `station_ref`, `service_ref`, or `debug=1` from the selected station/timeseries metadata.
3. `_codex_context/serve.py` resolves the selected timeseries metadata and builds `r2_params` with `connector_id`, `station_ref`, `service_ref`, `phenomenon_id`, `from_utc`, and `to_utc`.
4. `_codex_context/serve.py` then calls `_v2_fetch_chart_history_rows()`, but that helper currently forwards only `timeseries_id`, `pollutant`, `start`, `end`, and `format=compact` to `/api/aq/timeseries`.
5. Therefore the local Station Snapshot v2 chart-history probe can still force the cache proxy to resolve `connector_id` itself, even though the local server already knows the connector.
6. The direct optional R2 API calls use `from_utc`/`to_utc`; the refactor should either standardise them to `start_utc`/`end_utc` or keep backwards-compatible aliases at the Worker boundary.
7. The rows endpoint currently fetches ingestdb, ObsAQIDB, R2 observations, and R2 AQI for the same row table. That comparison view is useful, but it must be labelled as diagnostic comparison work and must not be used as evidence that the chart route still needs Supabase.

Station Snapshot v2 implementation requirements:

1. Update the HTML rows request to include selected `connector_id`, `station_ref`, `service_ref`, and `debug=1` when those values are available.
2. Update `_v2_fetch_chart_history_rows()` to forward `connector_id` and `debug=1` to `/api/aq/timeseries`.
3. Add `start_utc`/`end_utc` to Station Snapshot v2 R2 API probes, while keeping current `from_utc`/`to_utc` aliases if the Workers still accept them.
4. Ensure AQI R2 probes also include `connector_id` and `pollutant`.
5. Add explicit debug fields distinguishing:

```text
chart_route_used_supabase
chart_route_used_r2
snapshot_comparison_queried_ingestdb
snapshot_comparison_queried_obsaqidb
snapshot_comparison_queried_r2
```

6. Keep the comparison table available, but add a route/source mode such as:

```text
source_mode=chart_probe
source_mode=compare_all_sources
```

`chart_probe` should verify the production chart route behaviour. `compare_all_sources` may intentionally query ingestdb and ObsAQIDB for diagnostics.

### Backwards compatibility

Do not break callers that only pass `timeseries_id` and `pollutant`, but record debug/metadata when a Supabase fallback was needed because `connector_id` was missing.

## Debug policy

Normal public chart responses should be small.

Default response metadata should include only summary fields:

```text
source_mode
response_complete
has_gap
r2_row_count
ingest_row_count
query_from_utc
query_to_utc
r2_coverage_start
r2_coverage_end
ingest_tail_start
```

Verbose fields should require:

```text
debug=1
```

Verbose debug may include:

```text
history_index_prefix
timeseries_index_prefix
pollutant_partition
candidate_manifest_keys_checked
candidate_manifest_match_count
r2_object_reads
parquet_files_scanned
parquet_row_groups_scanned
partial_reasons
missing_manifest_keys
missing_parquet_keys
used_supabase_connector_lookup
used_r2_timeseries_metadata_lookup
source_routing_decision
```

Station Snapshot v2 can always request debug. Public hex map chart calls should not request full debug unless a local debug flag is enabled.

## Caching policy

Historical R2 responses are much more cacheable than recent Supabase responses.

Recommended cache split:

### Historical-only R2 response

```text
Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800
```

Use ETags based on:

```text
history_version
index_version
timeseries_id
connector_id
pollutant
start/end
format
latest descriptor/version or manifest updated_at
```

### Recent-only response

Keep existing short-lived realtime caching.

Example:

```text
Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=30, stale-if-error=300
```

### Stitched response

Use a conservative cache because it includes recent data:

```text
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=900
```

Exact numbers can be adjusted, but historical-only should be cached more aggressively than live/recent.

## Response-size and egress improvements

1. Keep `format=compact` for chart paths.
2. Do not include heavy coverage/debug by default.
3. Do not send AQI colour hex values in normal chart responses if the frontend maps AQI levels to colours.
4. Avoid duplicate fields that the caller already knows, such as station name and connector label, in per-point rows.
5. Prefer one R2 request per timeseries/pollutant/range over many small R2 object reads when the index can group candidate files.
6. Use conditional requests and ETags for stable historical windows.
7. Keep cache keys canonical and include pollutant, connector_id, timeseries_id, range, and format.

## Deployment drift checks

Because there has been confusion between older Supabase Edge Function code and the cache proxy Worker, add explicit drift checks.

### Required checks

1. Confirm the deployed public `/api/aq/timeseries` route is served by the intended cache proxy Worker.
2. Confirm the old Supabase Edge Function path is not still serving chart requests, unless deliberately retained as fallback.
3. Confirm deployed cache proxy includes:

```text
normalizeTimeseriesPollutantKey
endpoint.searchParams.set("pollutant", ...)
pollutant_required_for_v2_r2
```

4. Confirm deployed response headers identify the expected route/source where possible.
5. Add a smoke test that fails if `pollutant=pm25` produces `pollutant_partition: null` in v2 history coverage when `debug=1` is requested.

## Phased implementation

## Phase 0: Baseline and safety report

Purpose: Confirm current production/source state before changing anything.

Tasks:

1. Identify the files likely to change in Option C.
2. Create a new dated directory under `archive/` and copy the current versions of those files there before any implementation edits.
3. If a later phase discovers additional files that need amendment, archive their current versions before editing them.
4. Record current deployed URLs and route ownership.
5. Confirm whether `/api/aq/timeseries` is served by cache proxy Worker, Supabase Edge Function, or another layer.
6. Capture baseline responses for known test cases.
7. Confirm v2 index root files and coverage.
8. Confirm v2 coverage start date and whether it is expected.
9. Confirm observations/AQI one-day lag is expected or explain it.
10. Capture current Station Snapshot v2 local rows behaviour for `/api/station-snapshot-v2/rows`.
11. Confirm whether Station Snapshot v2 chart-history probes forward `connector_id`, `pollutant`, and `debug=1`.
12. Confirm whether deployed `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts` has the same metadata gaps as the local server.

Known test case:

```text
timeseries_id=3742
connector_id=6
station_id=17081
station_ref=5200392
service_ref=openaq
pollutant=pm25
range includes 2026-05-21T09:00:00Z
```

Baseline curl:

```bash
curl -s "http://localhost:8080/api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact&debug=1" | python3 -m json.tool
```

Acceptance:

1. No runtime code changes.
2. Archive snapshot directory exists with a manifest of files copied before implementation edits.
3. Written report of route ownership and current behaviour.
4. Known failing/successful cases documented.
5. Current v2 index layout confirmed as intentional.
6. Station Snapshot v2 baseline documents local HTML request params, local server chart-history params, direct R2 API params, and deployed dashboard Worker params.

### VS Code Codex prompt for Phase 0

```text
You are working in the UK AQ repo in VS Code. Analyse only. Do not edit files, do not deploy, and do not write to R2.

Task: produce a baseline report for the R2 history refactor.

Context:
We are preparing a refactor so historical chart data can be served from R2 without Supabase outside the retention window plus one-day overlap. Downsampling is out of scope.

Important current conclusions:
- _index_v2 intentionally has two root latest descriptors only:
  - history/_index_v2/observations_timeseries_latest.json
  - history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
- Do not add v1-style root files to _index_v2.
- v2 reads are pollutant-partitioned by pollutant_code.
- The cache proxy appears to already normalise and forward pollutant for /api/aq/timeseries.

Please inspect the repo and report:
1. Which code currently serves /api/aq/timeseries in production and local dev.
2. Whether any old Supabase Edge Function route can still serve chart timeseries requests.
3. Whether the deployed/source cache proxy normalises pollutant and forwards it to the observations R2 Worker.
4. Whether the AQI history route also requires and forwards pollutant.
5. Whether any code expects v1-style root files under _index_v2.
6. Current v2 coverage start/end for observations and AQI if available from local exports/docs.
7. Whether the known test case timeseries_id=3742, connector_id=6, pollutant=pm25 should be answerable from v2 R2.
8. Whether Station Snapshot v2 local server forwards connector_id/debug=1 to /api/aq/timeseries.
9. Whether Station Snapshot v2 deployed dashboard Worker forwards connector_id/pollutant to observations and AQI R2 APIs.
10. Any risks before implementing the refactor.

Use grep if ripgrep is not available.

Useful grep commands:
grep -RInE "pollutant_required_for_v2_r2|normalize.*pollutant|searchParams.*pollutant|endpoint.searchParams.set\(\"pollutant\"" workers supabase functions 2>/dev/null

grep -RInE "observations_latest\.json|aqilevels_latest\.json|observations_timeseries_latest\.json|aqilevels_timeseries_latest\.json|aqilevels_hourly_data_timeseries_latest\.json|_index_v2|pollutant_code|pollutant_partition" workers scripts supabase functions system_docs 2>/dev/null

Output a report only. Include exact files/functions inspected and commands run.
```

## Phase 1: Add or verify caller metadata, especially connector_id

Purpose: Ensure chart and diagnostic callers send enough metadata to avoid Supabase connector lookup.

Implementation note, 2026-06-18:

- Local Station Snapshot v2 now sends `debug=1` plus available `connector_id`, `station_ref`, and `service_ref` on rows requests.
- The local `_codex_context/serve.py` chart-history probe now forwards `connector_id`, `debug=1`, `start_utc`, and `end_utc` to `/api/aq/timeseries`.
- The deployed dashboard API Worker Station Snapshot v2 R2 probes now share one R2 parameter set that includes `timeseries_id`, `connector_id`, `pollutant`, UTC range aliases, and `debug=1`.
- The cache proxy v2 path now treats caller-supplied `connector_id` as part of canonical request parsing/cache identity and only falls back to the Supabase connector lookup when the caller omits it.

Tasks:

1. Audit hex map chart observations requests.
2. Audit hex map AQI history requests.
3. Audit Station Snapshot v2 rows and debug requests.
4. Ensure all relevant requests include `connector_id` when available.
5. Ensure all relevant requests include `pollutant`.
6. Ensure cache keys include `connector_id` where it materially affects source routing.
7. Keep backwards compatibility for older callers without `connector_id`.
8. Update `station_snapshot_v2/index.html` to send selected metadata when available.
9. Update `_codex_context/serve.py` so `_v2_fetch_chart_history_rows()` forwards `connector_id` and `debug=1`.
10. Audit and align `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts` so deployed Station Snapshot v2 does not lag the local diagnostic server.

Acceptance:

1. Hex map observations requests include `timeseries_id`, `connector_id`, and `pollutant`.
2. Hex map AQI requests include `timeseries_id`, `connector_id`, and `pollutant`.
3. Station Snapshot v2 rows/debug requests include `connector_id` where known.
4. Existing chart behaviour is unchanged.
5. No downsampling added.
6. Local Station Snapshot v2 chart-history debug shows `connector_id=6` for the known case instead of requiring a cache proxy connector lookup.
7. Station Snapshot v2 direct observations and AQI R2 probes include `pollutant` and `connector_id` where known.

### VS Code Codex prompt for Phase 1

```text
Task: Ensure UK AQ chart and Station Snapshot callers send connector_id and pollutant for R2-first history reads.

Do not change R2 Worker internals in this phase.
Do not add downsampling.
Do not change _index_v2 root layout.

Context:
The cache proxy already handles pollutant for /api/aq/timeseries. This phase is about making sure callers provide enough metadata to avoid Supabase connector lookups when possible.

Inspect:
- hex_map.html or current chart source
- shared chart modules if present
- station_snapshot_v2/index.html
- _codex_context/serve.py local diagnostic route
- workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts
- workers/uk_aq_cache_proxy/src/index.ts cache key/request parsing

Required:
1. Observations chart requests should include:
   - timeseries_id
   - connector_id when known
   - pollutant
   - start/end or window
   - format=compact
2. AQI history requests should include:
   - timeseries_id
   - connector_id when known
   - pollutant
   - start/end or window
   - format=compact
3. Station Snapshot v2 rows/debug should include connector_id when selected station/timeseries metadata has it.
4. Station Snapshot v2 local chart-history probe must forward connector_id and debug=1 to /api/aq/timeseries.
5. Station Snapshot v2 direct R2 probes should send start_utc/end_utc as well as any backwards-compatible from_utc/to_utc aliases needed by current Workers.
6. Do not break callers that lack connector_id.
7. Add debug logging, behind existing debug flags, showing whether connector_id was supplied.
8. Update tests or add grep-based checks if no test harness exists.

Acceptance:
- Known Surbiton case builds requests with timeseries_id=3742, connector_id=6, pollutant=pm25.
- Station Snapshot v2 rows request includes connector_id where known and its chart-history equivalent includes debug=1.
- No downsampling implementation.
- No v2 root index files added.
- git diff --check passes.
```

## Phase 2: Refactor source routing to avoid Supabase for historical-only requests

Purpose: Make `/api/aq/timeseries` or the central cache proxy route classify the source mode before fetching.

Implementation note, 2026-06-18:

- Added a unit-tested source-routing helper for `history_only`, `recent_only`, and `recent_history_stitched`.
- Updated the cache proxy v2 stitch path so `history_only` requests use R2 only and do not create Supabase/IngestDB fallback slices.
- Updated `recent_only` requests to return through the existing Supabase/IngestDB origin path without R2 fetches.
- Added summary metadata and headers for `source_mode`, `used_r2`, and `used_supabase`; verbose `source_routing_decision` is only included when `debug=1`.
- Updated Station Snapshot v2 debug propagation so chart probes can display `source_mode`, `used_r2`, and `used_supabase` from `/api/aq/timeseries`.

Tasks:

1. Add a source-routing function with clear inputs and outputs.
2. Classify `history_only`, `recent_only`, and `recent_history_stitched`.
3. For `history_only`, do not call Supabase RPC.
4. For `history_only`, do not call Supabase connector lookup when `connector_id` is supplied.
5. For `recent_only`, preserve existing recent behaviour.
6. For stitched requests, preserve existing overlap/dedupe behaviour.
7. Add `used_supabase` and `used_r2` summary metadata.
8. Add `source_routing_decision` only under `debug=1`.
9. Apply the same source-routing metadata to Station Snapshot v2 chart probes.
10. Keep Station Snapshot v2 all-source comparison reads explicit as diagnostic reads.

Acceptance:

1. Historical-only request uses R2 only.
2. Recent-only request uses Supabase/IngestDB only.
3. Boundary-crossing request stitches R2 and recent data.
4. Existing short-range chart still works.
5. No Supabase call occurs for historical-only known case when `connector_id` is supplied.
6. Station Snapshot v2 `chart_probe` for the known historical-only case reports `used_supabase=false`.
7. Station Snapshot v2 `compare_all_sources` may query ingestdb/ObsAQIDB but reports those as comparison queries.

### VS Code Codex prompt for Phase 2

```text
Task: Refactor UK AQ timeseries source routing so historical-only requests use R2 only and do not call Supabase/IngestDB.

Do not implement downsampling.
Do not change _index_v2 root layout.
Do not add duplicate pollutant handling to cache proxy if it already exists.

Context:
Historical chart reads should be answerable from R2 without Supabase when the requested range is outside the recent retention window plus one-day overlap.

Required source modes:
- history_only: request ends before the retention/overlap boundary. Use R2 only.
- recent_only: request starts inside the recent/overlap boundary. Use Supabase/IngestDB only.
- recent_history_stitched: request crosses the boundary. Use R2 for historical part and Supabase/IngestDB for recent tail/overlap.

Required:
1. Create or refactor a source-routing helper with unit-testable logic.
2. Use connector_id supplied by the caller to skip Supabase connector lookup.
3. Only fall back to Supabase connector lookup when connector_id is missing and no R2 metadata index can resolve it.
4. Preserve current dedupe/stitching logic for boundary-crossing ranges.
5. Add summary meta fields:
   - source_mode
   - used_r2
   - used_supabase
   - r2_row_count
   - ingest_row_count
   - response_complete
   - has_gap
6. Put verbose routing/debug details behind debug=1.
7. Add tests or local scripts proving historical-only does not call Supabase when connector_id is supplied.
8. Update Station Snapshot v2 so its chart_probe mode reports the same source_mode/used_r2/used_supabase fields as the chart route.
9. Keep compare_all_sources mode for the current side-by-side diagnostic table, but label DB reads explicitly.

Known test:
/api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-01T00:00:00Z&format=compact&debug=1

Expected:
- source_mode=history_only
- used_r2=true
- used_supabase=false
- no Supabase connector lookup
- no Supabase recent RPC
- no pollutant_required_for_v2_r2

Also test a recent-only range and a boundary-crossing range.

Station Snapshot v2 expected:
- /api/station-snapshot-v2/rows for the same selected station/timeseries can show compare_all_sources rows, but its embedded chart-history debug must show source_mode=history_only and used_supabase=false.
```

## Phase 3: Add R2 timeseries metadata index or consume existing equivalent

Purpose: Make historical-only reads possible even when older callers omit `connector_id`, without using Supabase.

Tasks:

1. Check whether an equivalent R2 timeseries metadata index already exists.
2. If it exists, use it.
3. If it does not exist, add a generator path to create it from v2 index manifests or data manifests.
4. Add Worker helper to resolve `timeseries_id -> connector_id/pollutant/coverage` from R2 metadata.
5. Use the R2 metadata resolver before any Supabase fallback for historical-only requests.
6. Add coverage fields for observations and AQI separately.
7. Ensure metadata index generation is idempotent.
8. Ensure metadata index payloads are byte-stable when source manifests do not change.
9. Derive metadata timestamps from source manifest fields such as max `backed_up_at_utc`; do not use wall-clock generation time.

Acceptance:

1. `timeseries_id=3742` resolves connector_id 6 from R2 metadata.
2. R2-only historical reads work when connector_id is omitted, if metadata exists.
3. Supabase fallback remains for compatibility only and is reported in debug.
4. Index builder docs updated.
5. No v1-style root files added to `_index_v2`.
6. Re-running the metadata index builder without source-data changes produces byte-identical metadata payloads.

Implementation notes:

- Existing `_index_v2` manifests were found to contain per-timeseries row counts, but only under day/connector/pollutant paths. They are not a direct `timeseries_id -> connector_id` lookup, so using them at request time would require broad manifest scans.
- The refactor therefore adds direct metadata objects at `history/_index_v2/timeseries/timeseries_id=<id>.json`.
- The metadata objects are generated from existing v2 observations and AQI timeseries index manifests, not from raw data and not from wall-clock timestamps.
- Caller-supplied `connector_id` remains the first path. The R2 metadata resolver only runs when older callers omit `connector_id`.
- The observations history R2 API exposes a protected `/v1/timeseries-metadata?timeseries_id=<id>` route using the same upstream secret as `/v1/observations`.
- The cache proxy tries R2 metadata before the Supabase compatibility lookup and reports `connector_id_source` as `request`, `r2_metadata`, or `supabase_lookup`.

### VS Code Codex prompt for Phase 3

```text
Task: Add or use an R2 v2 timeseries metadata index so historical-only reads do not need Supabase to resolve connector_id.

Do not implement downsampling.
Do not add v1-style root latest files to _index_v2.
Do not remove existing v2 latest descriptors.

Context:
For historical-only chart reads, the system should not need Supabase. If callers provide connector_id, use it. If they do not, resolve metadata from R2 where possible.

First inspect whether an equivalent metadata index already exists. If it does, use it and do not create a duplicate.

If no equivalent exists, implement a lightweight v2 metadata index with a pattern similar to:
history/_index_v2/timeseries/timeseries_id=<id>.json
or a sharded equivalent if needed.

Suggested payload fields:
- history_version
- timeseries_id
- timeseries_ref
- station_id
- station_ref
- connector_id
- service_ref
- pollutant_code
- first_observed_at
- last_observed_at
- observations_coverage
- aqi_coverage
- updated_at

Required:
1. Add generator/index-builder support for the metadata index.
2. Make generation idempotent.
3. Add R2 Worker helper to resolve metadata by timeseries_id.
4. Use R2 metadata resolver before Supabase fallback for historical-only requests.
5. Record debug fields:
   - used_r2_timeseries_metadata_lookup
   - used_supabase_connector_lookup
   - metadata_index_key
6. Keep generated metadata byte-stable run-to-run when source manifests do not change. Do not use wall-clock generated_at values.
7. Update system docs.

Acceptance:
- timeseries_id=3742 resolves connector_id=6 from R2 metadata.
- Historical-only request without connector_id can use R2 metadata and avoid Supabase.
- Historical-only request with connector_id does not perform metadata lookup unless debug or validation requires it.
- No new _index_v2/observations_latest.json or _index_v2/aqilevels_latest.json files are introduced.
- Rebuilding the metadata index twice with unchanged source manifests produces the same hashes.
```

## Phase 4: Align AQI history path with observations history path

Purpose: Make AQI history follow the same R2-first principles as observations.

Tasks:

1. Audit AQI history requests from chart and Station Snapshot v2.
2. Ensure AQI history requests include `timeseries_id`, `connector_id`, `pollutant`, `start/end`, and `format`.
3. Ensure AQI Worker uses v2 canonical prefix and latest descriptor.
4. Ensure historical-only AQI does not use Supabase.
5. Ensure AQI coverage is treated independently from observations coverage.
6. Remove colour hex fields from normal AQI chart response if frontend derives colours from levels.
7. Keep richer fields available for diagnostics if needed.
8. Ensure Station Snapshot v2 AQI probes include `connector_id`, `pollutant`, and the same time-window parameter names as observations probes.
9. Ensure Station Snapshot v2 labels R2 AQI rows and ObsAQIDB AQI rows separately in debug and overlap reporting.

Acceptance:

1. AQI history reads use `aqilevels_hourly_data_timeseries_latest.json` in v2 mode.
2. AQI history requires pollutant in v2 mode.
3. Historical-only AQI read uses R2 only.
4. Normal chart AQI response is compact.
5. Station Snapshot v2 can still display detailed AQI diagnostics with `debug=1`.
6. Station Snapshot v2 AQI R2 probe does not silently omit `connector_id` when the selected timeseries metadata has it.

### VS Code Codex prompt for Phase 4

```text
Task: Align UK AQ AQI history reads with the R2-first observations history path.

Do not implement downsampling.
Do not add v1-style files to _index_v2.

Context:
v2 AQI history uses the canonical index name:
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
and the index prefix:
history/_index_v2/aqilevels_hourly_data_timeseries/...

Required:
1. Audit chart and Station Snapshot AQI history requests.
2. Ensure all AQI history requests include timeseries_id, connector_id where known, pollutant, start/end, and format=compact where appropriate.
3. Ensure AQI Worker uses the v2 canonical index names and pollutant-partitioned manifest paths.
4. Ensure historical-only AQI requests do not call Supabase.
5. Treat observations and AQI coverage independently.
6. Keep AQI colour derivation in the frontend where possible. Normal AQI chart responses should return levels, not repeated colour hex strings, unless a compatibility path requires them.
7. Put heavy AQI coverage/debug behind debug=1.
8. Update Station Snapshot v2 local and deployed diagnostic code so AQI R2 probes send connector_id and debug=1 where supported.

Known test:
AQI history for timeseries_id=3742, connector_id=6, pollutant=pm25, range covering 2026-05-21.

Expected:
- v2 AQI timeseries index path uses aqilevels_hourly_data_timeseries.
- pollutant partition is pm25.
- no Supabase call for historical-only range.
- compact response contains hourly/rolling means and DAQI/EAQI levels.
- debug=1 reports coverage and source routing.
- Station Snapshot v2 rows debug shows the AQI R2 probe parameters and whether AQI came from R2, ObsAQIDB, or both.
```

## Phase 5: Move verbose coverage/debug behind debug=1

Purpose: Reduce normal response size and egress while preserving diagnostics.

Tasks:

1. Identify heavy metadata currently returned by default.
2. Keep small summary meta by default.
3. Return full coverage/index details only when `debug=1` or local debug flag is present.
4. Ensure Station Snapshot v2 requests debug explicitly.
5. Ensure public hex map chart does not request full debug unless debug mode is enabled.
6. Add tests for response shape with and without debug.
7. Ensure Station Snapshot v2 debug output includes source-routing summaries without exposing secrets.

Acceptance:

1. Normal chart response is materially smaller.
2. `debug=1` preserves enough detail for diagnostics.
3. Station Snapshot v2 still has detailed debug panel.
4. No secret values in debug.
5. Station Snapshot v2 local server and deployed dashboard Worker use `debug=1` for diagnostic probes, not normal public chart traffic.

### VS Code Codex prompt for Phase 5

```text
Task: Move verbose R2 history coverage/debug output behind debug=1.

Do not implement downsampling.
Do not change chart visuals.

Required:
1. Audit /api/aq/timeseries, observations R2 Worker, and AQI R2 Worker response metadata.
2. Keep only summary metadata by default:
   - source_mode
   - response_complete
   - has_gap
   - r2_row_count
   - ingest_row_count where relevant
   - query_from_utc
   - query_to_utc
   - r2_coverage_start/end
   - ingest_tail_start where relevant
3. Move detailed coverage/index fields behind debug=1:
   - index prefixes
   - candidate keys
   - object read counts
   - parquet scan metrics
   - missing manifests/parquet keys
   - partial reasons detail
   - source routing decision internals
4. Update Station Snapshot v2 to request debug=1 for diagnostic rows.
5. Ensure public chart calls do not request debug=1 unless a local debug flag is enabled.
6. Ensure no secret values appear in debug output.
7. Ensure Station Snapshot v2 compact debug panel includes source_mode, used_r2, used_supabase, pollutant_partition, and connector_id supplied/resolved.

Acceptance:
- Same data rows with and without debug=1.
- Normal response is smaller.
- Debug response includes enough details to diagnose R2 index and route decisions.
- Station Snapshot v2 debug panel still works.
- Station Snapshot v2 debug output includes routing/source summaries but no service tokens or secrets.
```

## Phase 6: Cache and egress improvements

Purpose: Use stronger caching for stable historical R2 responses and keep recent responses realtime.

Tasks:

1. Split cache policy by `source_mode`.
2. Strengthen historical-only cache TTLs.
3. Keep recent-only TTL short.
4. Use conservative cache for stitched responses.
5. Ensure cache keys include `pollutant`, `connector_id`, `timeseries_id`, range, and format.
6. Ensure ETags account for index version/latest descriptor.
7. Avoid caching debug responses too aggressively, or separate debug cache keys.
8. Ensure Station Snapshot v2 diagnostic requests cannot poison or share normal public chart cache entries.

Acceptance:

1. Historical-only responses have longer `s-maxage`.
2. Recent-only responses preserve realtime behaviour.
3. Stitched responses cache safely.
4. Cache keys are canonical and pollutant-aware.
5. Debug and normal responses do not conflict in cache.
6. Station Snapshot v2 `debug=1` and `compare_all_sources` responses are `no-store` or use a clearly separate diagnostic cache key.

### VS Code Codex prompt for Phase 6

```text
Task: Improve cache policy and egress behaviour for R2-first history responses.

Do not implement downsampling.

Required:
1. Apply source-mode-specific cache policies:
   - history_only: longer CDN cache and stale-if-error
   - recent_only: existing realtime short cache
   - recent_history_stitched: conservative intermediate cache
2. Ensure cache keys include:
   - timeseries_id
   - connector_id when present
   - pollutant
   - start/end or canonical window
   - format
   - debug flag
3. Ensure ETags for historical-only responses include enough index/version information to invalidate when R2 history/index changes.
4. Avoid caching debug=1 responses under the same key as normal responses.
5. Do not include secret values in logs or debug.
6. Keep Station Snapshot v2 diagnostic comparison responses out of normal chart caches.

Acceptance:
- curl headers show longer cache for historical-only than recent-only.
- Same request with debug=1 has a distinct cache key or no unsafe cache sharing.
- Existing chart refresh behaviour is not made stale for recent windows.
- Station Snapshot v2 diagnostics do not change the cached normal chart response.
```

## Phase 7: Tests, deployment, and rollback

Purpose: Deploy safely and prove the refactor works.

Tasks:

1. Add local tests or scripts for source routing.
2. Add smoke tests for observations history.
3. Add smoke tests for AQI history.
4. Add tests for missing pollutant in v2 mode.
5. Add tests for missing connector_id with and without R2 metadata index.
6. Add tests for historical-only no-Supabase behaviour.
7. Add rollback notes.
8. Deploy in small steps if practical.
9. Add Station Snapshot v2 smoke tests for local server and deployed dashboard Worker routes.

Acceptance tests:

### Historical-only observations

```bash
curl -s "https://cic-test.chronicillnesschannel.co.uk/api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-01T00:00:00Z&format=compact&debug=1" | python3 -m json.tool
```

Expected:

```text
source_mode=history_only
used_r2=true
used_supabase=false
pollutant_partition=pm25
r2_row_count > 0 if data exists
no pollutant_required_for_v2_r2
```

### Missing pollutant in v2 mode

```bash
curl -s "https://cic-test.chronicillnesschannel.co.uk/api/aq/timeseries?timeseries_id=3742&connector_id=6&start=2026-05-18T00:00:00Z&end=2026-06-01T00:00:00Z&format=compact&debug=1" | python3 -m json.tool
```

Expected:

```text
clear error or partial reason saying pollutant is required for v2 R2 reads
no broad all-pollutant scan
```

### Recent-only observations

Use a range inside the retention window.

Expected:

```text
source_mode=recent_only
used_supabase=true
used_r2=false or only false for observations history
```

### Boundary-crossing observations

Use a range that crosses retention start.

Expected:

```text
source_mode=recent_history_stitched
used_r2=true
used_supabase=true
no duplicate observed_at rows
```

### AQI historical-only

Use the AQI history route or chart path for:

```text
timeseries_id=3742
connector_id=6
pollutant=pm25
range covering 2026-05-21
```

Expected:

```text
source_mode=history_only
v2 AQI index prefix = aqilevels_hourly_data_timeseries
pollutant_partition=pm25
used_supabase=false
```

### v2 pre-coverage range

Use a range before 2026-03-18.

Expected:

```text
clear source/coverage response
fallback behaviour documented
no misleading success with empty rows unless truly no data exists
```

### Station Snapshot v2 local rows

```bash
curl -s "http://localhost:8080/api/station-snapshot-v2/rows?station_id=17081&timeseries_id=3742&connector_id=6&station_ref=5200392&service_ref=openaq&pollutant=pm25&range=31d&debug=1" | python3 -m json.tool
```

Expected:

```text
selected_timeseries_id=3742
selected_connector_id=6
chart_history_params_equivalent.connector_id=6
chart_history_params_equivalent.pollutant=pm25
chart_history_params_equivalent.debug=1
chart-route source_mode and used_supabase reported when upstream returns debug
compare_all_sources DB reads labelled separately from chart-route source routing
AQI source distinguishes r2 versus ObsAQIDB when overlap exists
```

### VS Code Codex prompt for Phase 7

```text
Task: Add smoke tests and deployment checks for the UK AQ R2-first history refactor.

Do not implement new features in this phase unless required to make tests runnable.

Required tests:
1. Historical-only observations with connector_id and pollutant uses R2 only.
2. Missing pollutant in v2 mode gives clear error/partial reason and does not scan all pollutants.
3. Recent-only observations preserve Supabase/IngestDB recent behaviour.
4. Boundary-crossing observations stitch R2 and recent data with no duplicate observed_at rows.
5. Historical-only AQI uses the v2 aqilevels_hourly_data_timeseries index and does not use Supabase.
6. Pre-v2-coverage range reports coverage/fallback clearly.
7. debug=1 response contains detailed diagnostics, normal response does not.
8. No secret values are printed in logs/debug.
9. Station Snapshot v2 local rows route forwards connector_id/debug=1 to /api/aq/timeseries.
10. Station Snapshot v2 deployed dashboard Worker route forwards connector_id and pollutant to observations and AQI R2 probes.

Add a local script if useful, for example:
scripts/smoke_tests/r2_history_refactor_smoke.sh

Use grep-compatible commands, not only rg, because some local environments do not have ripgrep installed.

Output:
- test script(s)
- short README/runbook update
- rollback notes

Acceptance:
- Tests can run locally against localhost and optionally against cic-test.
- Tests identify source_mode, used_r2, used_supabase, pollutant_partition, row counts, and warnings/partial reasons.
- Station Snapshot v2 tests identify selected connector_id, chart_history_params_equivalent, comparison-source flags, and AQI source.
```

## Backfill and coverage follow-up

The exported v2 coverage currently starts at 2026-03-18. That is much shorter than v1 coverage, which starts at 2025-01-01 in the exported index.

Before relying on R2-first for older chart ranges, decide one of these:

1. Backfill v2 to the required historical start date.
2. Keep v1 fallback for older data.
3. Return clear coverage messages for pre-v2 ranges.

Recommended approach:

```text
Short term:
  R2-first v2 for dates covered by v2.
  Clear coverage response before v2 starts.

Medium term:
  Backfill v2 to the required start date.
  Rebuild v2 indexes.
  Re-run integrity checks.

Long term:
  Retire v1 historical reads only after v2 coverage and integrity are confirmed.
```

## Documentation updates

Update or add docs covering:

1. v1 versus v2 R2 index root layout.
2. Why `_index_v2` intentionally has two root latest descriptors.
3. Canonical v2 AQI latest descriptor name.
4. Pollutant requirement for v2 reads.
5. Source routing rules.
6. Supabase usage policy.
7. R2 metadata index, if added.
8. Cache policy by source mode.
9. Smoke tests and deployment checks.
10. Backfill/coverage status.
11. Station Snapshot v2 diagnostic modes and source-routing interpretation.
12. Difference between chart-route R2-only probes and all-source comparison diagnostics.

Suggested doc path:

```text
system_docs/uk-aq-r2-history-refactor.md
```

or update existing:

```text
system_docs/uk-aq-r2-history-layout.md
system_docs/uk-aq-r2-history-dropbox-backup.md
```

## Rollback strategy

1. Keep existing recent Supabase path unchanged.
2. Keep a feature flag for R2-only historical routing if possible, for example:

```text
UK_AQ_TIMESERIES_R2_HISTORY_ONLY_ENABLED=1
```

3. Allow fallback to previous stitched behaviour if R2-only path fails.
4. Keep old cache keys valid until new cache keys have warmed.
5. Do not delete v1 indexes or v1 read paths during this refactor.
6. Deploy observations changes before AQI changes if that reduces risk.
7. Test on `cic-test` before promoting.

## Open questions

1. Is 2026-03-18 the intended v2 backfill start date?
2. Should v2 be backfilled to 2025-01-01 before older line-chart work starts?
3. Is the one-day observations/AQI max-day difference expected from job order?
4. Does an R2 timeseries metadata index already exist under another name?
5. Which exact route serves production `/api/aq/timeseries` today?
6. Should AQI history have its own public endpoint, or continue through existing chart internals?
7. Should old Supabase Edge Function timeseries code be removed, archived, or marked legacy?
8. What minimum debug fields are needed for Station Snapshot v2 after verbose debug moves behind `debug=1`?
9. Should Station Snapshot v2 default to `compare_all_sources`, or should it expose a UI/API toggle for `chart_probe` versus `compare_all_sources`?
10. Should Station Snapshot v2 search remain DB-backed, or should a later project add an R2 search/metadata index for stations?
11. Which direct R2 Worker time-window parameter names are canonical after the refactor: `start_utc`/`end_utc`, `from_utc`/`to_utc`, or both for compatibility?

## Final recommendation

Proceed with the refactor, but adjust the original plan as follows:

1. Do not add pollutant handling to the cache proxy if the existing code already has it.
2. Keep pollutant mandatory for v2 R2 reads and verify every caller sends it.
3. Do not add v1-style root files to `_index_v2`.
4. Treat v2 observations and AQI coverage independently.
5. Prioritise source routing and Supabase-free historical-only reads.
6. Add an R2 metadata index only if no equivalent already exists.
7. Move verbose diagnostics behind `debug=1`.
8. Leave downsampling for a later project.
9. Update Station Snapshot v2 in the same refactor: HTML caller metadata, local server chart-history forwarding, deployed dashboard Worker parity, and smoke tests.
10. Keep Station Snapshot v2 DB comparison reads explicit and separate from chart-route R2-only source routing.
