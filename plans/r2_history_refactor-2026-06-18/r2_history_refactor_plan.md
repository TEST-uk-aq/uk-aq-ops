# UK AQ R2 History Refactor Plan

## Purpose

This plan refactors the UK AQ historical time-series path so older chart data comes from R2 without unnecessary Supabase dependency. It keeps the recent live/retention window in Supabase/IngestDB for now, but makes R2 the first-class source for historical observations and AQI rows.

Downsampling is intentionally excluded from this refactor. It should be added later as a separate chart-performance project.

## Current problem

The current `uk_aq_timeseries` path accepts chart requests such as:

```text
/api/aq/timeseries?timeseries_id=3742&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact
```

but the Supabase Edge Function does not read or forward the `pollutant` parameter into the observations R2 history worker.

The R2 v2 reader is pollutant-partitioned and returns a warning:

```text
Skipped v2 observations history scan: pollutant is required for pollutant-partitioned v2 reads.
```

This means the client is already sending the correct pollutant, but the upstream function drops it before calling the R2 worker.

There is also an architectural problem: the historical R2 path currently uses Supabase to resolve `timeseries_id → connector_id`, even when the requested range is entirely historical and should be answerable from R2 alone.

## Desired end state

1. Historical observation and AQI reads use R2 only when the requested range is outside the recent retention window plus overlap.
2. Supabase/IngestDB is used only for the live/recent retention path and the overlap day used for stitching.
3. `pollutant` is part of the public and internal request contract for observations and AQI history.
4. Chart requests include enough metadata to avoid Supabase connector lookups where possible.
5. R2 indexes can resolve the metadata needed for historical reads.
6. Debug output is available when requested, but normal public chart responses stay small.
7. Existing chart and Station Snapshot v2 behaviour remains compatible.

## Definitions

### Retention window

The recent window still served by Supabase/IngestDB. The current code uses:

```text
INGESTDB_RETENTION_DAYS
INGEST_SOURCE_OF_TRUTH_HOURS = INGESTDB_RETENTION_DAYS * 24
```

### Overlap day

The 1-day buffer before the retention boundary where R2 and IngestDB can overlap so stitching can prefer the correct source and fill gaps.

### Historical-only request

A request whose `end_utc` is earlier than or equal to the start of the overlap window:

```text
request_end <= overlap_start
```

This should be answerable from R2 without Supabase.

### Recent-only request

A request whose `start_utc` is inside the retention window:

```text
request_start >= retention_start
```

This can use Supabase/IngestDB only.

### Stitched request

A request crossing the overlap/retention boundary. It should use R2 for the older segment and Supabase/IngestDB for the recent tail plus overlap fill.

## Request contract

### Observations history worker

The R2 observations history worker should accept:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
since_utc optional
limit optional
debug optional
```

`pollutant` should be required for v2 pollutant-partitioned reads.

Accepted public pollutant values should be normalised:

```text
pm25, pm2.5, pm2_5, pm2p5 → pm25
pm10 → pm10
no2 → no2
```

### AQI history worker

The AQI history worker should mirror the observations worker contract:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
since_utc optional
limit optional
debug optional
```

It should return AQI/hourly fields only, not derived colours unless there is a specific reason to include them.

Recommended AQI fields:

```text
observed_at
aqi_source
hourly_mean_ugm3
rolling24h_mean_ugm3
hourly_sample_count
daqi_index_level
eaqi_index_level
```

Frontend code should map DAQI/EAQI levels to colours using the shared palette.

### `/api/aq/timeseries`

The public chart endpoint should continue accepting:

```text
timeseries_id
pollutant
connector_id optional
start/end or window/days
format
limit optional
since optional
source optional
debug optional
```

`connector_id` should be optional for backwards compatibility, but when supplied it should prevent a Supabase connector lookup.

`source` should support:

```text
source=stitched  default, current behaviour
source=history   R2 only
source=recent    Supabase/IngestDB only
```

If `source=history`, the endpoint should not call Supabase/IngestDB.

## R2 index recommendations

### Add a timeseries metadata index

Add a compact R2 metadata object for each timeseries:

```text
history/_index_v2/timeseries/{timeseries_id}.json
```

Example:

```json
{
  "timeseries_id": 3742,
  "timeseries_ref": "14153308",
  "connector_id": 6,
  "pollutant": "pm25",
  "station_id": 17081,
  "station_ref": "5200392",
  "service_ref": "openaq",
  "phenomenon_id": 10,
  "first_observed_at": "2026-01-01T00:00:00Z",
  "last_observed_at": "2026-05-21T09:00:00Z",
  "index_version": "v2"
}
```

This lets the R2 path resolve `connector_id` and pollutant without a Supabase lookup, provided `timeseries_id` is known.

### Keep the pollutant-partitioned timeseries index

The current debug output suggests an intended index path like:

```text
history/_index_v2/observations_timeseries
```

This should be pollutant-aware and connector-aware, for example:

```text
history/_index_v2/observations_timeseries/pollutant=pm25/connector_id=6/{timeseries_id}.json
```

or an equivalent manifest structure.

The worker should use this index to avoid scanning irrelevant pollutants, connectors, or date chunks.

### Add monthly or range manifests for long windows

For 31d, 90d, and future multi-year charting, avoid reading one manifest per day when a monthly manifest can route to the correct chunks.

Suggested hierarchy:

```text
history/_index_v2/observations_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json
history/_index_v2/aqi_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json
```

Each monthly manifest can list chunks/files that contain matching timeseries data and min/max observed timestamps.

Keep daily manifests if they are useful for repair, diagnostics, or recent backfill, but do not make long chart requests depend on scanning daily manifests one by one.

## Debug policy

Normal chart responses should be slim.

Use:

```text
debug=1
```

or:

```text
debug=summary
debug=full
```

Recommended default:

```text
debug absent → minimal meta only
debug=summary → counts, source decisions, partial reasons
debug=full → candidate keys, manifests, chunk reads, warnings
```

Station Snapshot v2 should request debug. Public charts should not request full debug by default.

## Caching policy

Historical R2 results should cache more aggressively than recent/stiched results.

Suggested response cache policy:

```text
Historical-only R2 responses:
Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=86400

Recent-only responses:
Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=30, stale-if-error=300

Stitched responses:
Cache-Control based on the recent segment, unless the request is entirely historical.
```

Use ETags based on:

```text
endpoint version
request params
R2 index version
chunk manifest versions
row count / max observed_at
```

## Phased implementation

## Phase 1: Pass pollutant through the existing observations history path

### Goal

Fix the immediate bug where the public API receives `pollutant=pm25` but the R2 observations worker receives no pollutant.

### Changes

In `uk_aq_timeseries`:

1. Parse `pollutant` from incoming query params.
2. Normalise pollutant values.
3. Add pollutant to request fields and meta.
4. Add pollutant to `StitchedFetchOptions`.
5. Pass pollutant to `fetchTimeseriesRowsStitched()`.
6. Add pollutant to `ObservsHistoryWindowCallOptions`.
7. Pass pollutant into `callObservsHistoryWindow()`.
8. Pass pollutant through chunked/bisect retry paths.
9. Add pollutant to the R2 observations API request.
10. Add debug fields showing incoming and normalised pollutant.

### Acceptance tests

```bash
curl -s "http://localhost:8080/api/aq/timeseries?timeseries_id=3742&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact" | python3 -m json.tool
```

Expected:

```text
HTTP 200
meta.coverage.history_coverage.pollutant_partition is not null
No “pollutant is required” warning
history_coverage.days_scanned > 0 or a clear non-pollutant reason
```

### Codex prompt

```text
We need to fix the upstream uk_aq_timeseries Supabase Edge Function so it forwards pollutant into the v2 R2 observations history worker.

Evidence:
/api/aq/timeseries?timeseries_id=3742&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact returns HTTP 200, but meta.coverage.history_coverage shows pollutant_partition: null and warnings: ["Skipped v2 observations history scan: pollutant is required for pollutant-partitioned v2 reads."].

The request contains pollutant=pm25, but the Edge Function currently parses timeseries_id, window, days, start, end, limit, since, and format only. It does not read pollutant. callObservsHistoryWindow sends timeseries_id, connector_id, start_utc, and end_utc to OBSERVS_HISTORY_R2_API_URL, but not pollutant.

Implement:
1. Parse rawPollutant from url.searchParams.get("pollutant").
2. Add normalizePollutantKey(value) supporting:
   - pm25, pm2.5, pm2_5, pm2p5 → pm25
   - pm10 → pm10
   - no2 → no2
3. Include raw and normalised pollutant in requestFields/meta/debug.
4. Add pollutant to StitchedFetchOptions.
5. Pass pollutant from the serve handler to fetchTimeseriesRowsStitched.
6. Add pollutant to ObservsHistoryWindowCallOptions.
7. Pass pollutant through callObservsHistoryWindow, callObservsHistoryWindowChunked, fetchHistoryChunkWithBisectRetry, and any retry path that calls the observations R2 API.
8. In callObservsHistoryWindow, set endpoint.searchParams.set("pollutant", pollutant) when pollutant is present.
9. Do not change the public API contract. Clients should continue sending pollutant=pm25, pollutant=pm10, and pollutant=no2.

Acceptance test:
curl /api/aq/timeseries?timeseries_id=3742&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact

Expected:
- HTTP 200
- meta.coverage.history_coverage.pollutant_partition is not null
- no warning saying pollutant is required
- days_scanned > 0 or a clear non-pollutant reason if no files are scanned
- pm10 and no2 also normalise correctly with known timeseries

Run:
deno check or the repo’s Edge Function type check command
any existing tests
```

## Phase 2: Let chart requests pass connector_id and skip Supabase connector lookup

### Goal

Avoid Supabase calls for `timeseries_id → connector_id` when the client or Station Snapshot already knows connector metadata.

### Changes

1. Update hex map/chart request construction to include `connector_id` where available.
2. Update Station Snapshot v2 chart-history-equivalent calls to include `connector_id`.
3. Update `uk_aq_timeseries` to parse optional `connector_id`.
4. If `connector_id` is supplied and valid, use it.
5. Only call `resolveTimeseriesConnectorId()` when `connector_id` is missing.
6. Include `connector_id_source` in debug/meta:

```text
connector_id_source: request | supabase_lookup | r2_index | unresolved
```

### Acceptance tests

For a request with `connector_id=6`:

```text
Supabase connector lookup is not called.
meta.coverage.connector_id = 6
meta.coverage.connector_id_source = request
```

For a request without `connector_id`, existing compatibility still works.

### Codex prompt

```text
Refactor uk_aq_timeseries and chart callers so connector_id can be supplied by the client and Supabase connector lookup is skipped when it is present.

Context:
The current uk_aq_timeseries function calls resolveTimeseriesConnectorId(timeseriesId), which queries Supabase, before calling the observations R2 history API. For historical chart requests, the chart UI and Station Snapshot v2 often already know connector_id. We should pass it through and avoid a database call.

Implement:
1. In uk_aq_timeseries, parse optional connector_id from url.searchParams.
2. Validate connector_id as a positive integer.
3. Add connectorId to StitchedFetchOptions.
4. In fetchTimeseriesRowsStitched, use the supplied connectorId when valid.
5. Only call resolveTimeseriesConnectorId(timeseriesId) if connector_id was not supplied.
6. Add meta/debug field connector_id_source with one of: request, supabase_lookup, unresolved.
7. Update _codex_context/hex_map.html or the chart request builder so /api/aq/timeseries requests include connector_id when the selected sensor metadata has it.
8. Update Station Snapshot v2 chart-history-equivalent/debug request params to include connector_id when available.
9. Keep backwards compatibility for older callers that only send timeseries_id.

Acceptance tests:
- Request with timeseries_id=3742&connector_id=6&pollutant=pm25 should not call resolveTimeseriesConnectorId.
- Response meta should show connector_id=6 and connector_id_source=request.
- Request without connector_id should continue to resolve connector_id through the existing Supabase lookup.
- Pollutant forwarding from Phase 1 must continue to work.

Run the repo’s type checks and tests.
```

## Phase 3: Add `source=history|recent|stitched` and avoid Supabase for historical-only windows

### Goal

Make old chart requests R2-only and explicitly avoid Supabase when the requested window does not need the recent retention tail.

### Source decision rules

```text
source=history:
  Use R2 only. Do not call Supabase/IngestDB.

source=recent:
  Use Supabase/IngestDB only. Do not call R2.

source=stitched or omitted:
  If request_end <= overlap_start:
    Use R2 only.
  Else if request_start >= retention_start:
    Use Supabase/IngestDB only.
  Else:
    Use R2 for historical part and Supabase/IngestDB for recent tail plus overlap.
```

### Changes

1. Parse optional `source` param.
2. Add explicit source planning before any data fetch.
3. Do not call `callTimeseriesRpc()` when the plan is historical-only.
4. Do not call `resolveTimeseriesConnectorId()` if connector_id is supplied.
5. If `source=history` and connector_id is missing, try R2 timeseries metadata index in Phase 4; until then, return a clear 400/partial error saying connector_id is required for Supabase-free historical reads.
6. Add source plan debug:

```json
{
  "requested_source": "history",
  "resolved_source_plan": "history_only",
  "uses_r2": true,
  "uses_supabase": false,
  "uses_ingest_rpc": false,
  "uses_connector_lookup": false
}
```

### Acceptance tests

```bash
curl -s ".../api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&source=history&start=2026-05-18T00:00:00Z&end=2026-06-01T00:00:00Z&format=compact&debug=summary" | python3 -m json.tool
```

Expected:

```text
uses_r2: true
uses_supabase: false
uses_ingest_rpc: false
uses_connector_lookup: false
```

### Codex prompt

```text
Add explicit source planning to uk_aq_timeseries so historical-only chart requests do not use Supabase/IngestDB.

Do not implement downsampling.

Implement source param:
- source=stitched default, existing compatibility mode
- source=history R2 only
- source=recent Supabase/IngestDB only

Rules:
- If source=history, do not call callTimeseriesRpc and do not call Supabase unless connector_id is missing and no R2 metadata index is available yet. Prefer returning a clear error over doing an accidental DB lookup.
- If source=recent, do not call R2.
- If source=stitched or omitted:
  - request_end <= overlap_start → history_only, R2 only
  - request_start >= retention_start → recent_only, Supabase/IngestDB only
  - otherwise → stitched, R2 historical segment plus Supabase recent tail and overlap.

Add debug/meta fields:
requested_source
resolved_source_plan
uses_r2
uses_supabase
uses_ingest_rpc
uses_connector_lookup
retention_start_utc
overlap_start_utc

Acceptance test:
Request source=history with timeseries_id=3742&connector_id=6&pollutant=pm25 and a fully historical date range. The response must not call Supabase connector lookup or ingest RPC. Debug should show uses_supabase=false and uses_ingest_rpc=false.

Keep existing chart compatibility when source is omitted.
Run type checks and existing tests.
```

## Phase 4: Add R2 timeseries metadata index to remove connector lookup dependency

### Goal

Allow R2 history requests to resolve connector and pollutant metadata from R2 when the client provides only `timeseries_id`.

### Changes

1. Create/write metadata index objects during R2 history build/backfill.
2. Add worker read helper:

```text
GET history/_index_v2/timeseries/{timeseries_id}.json
```

3. Use it to resolve:

```text
connector_id
pollutant
station_id
station_ref
timeseries_ref
coverage start/end
```

4. In `uk_aq_timeseries`, for `source=history`, use this index before any Supabase fallback.
5. In the observations and AQI workers, use this index for diagnostics and fallback routing where helpful.

### Acceptance tests

Request:

```text
source=history&timeseries_id=3742&pollutant=pm25&start=...&end=...
```

without `connector_id`.

Expected:

```text
connector_id_source: r2_index
uses_supabase: false
```

### Codex prompt

```text
Add an R2 timeseries metadata index so historical R2 reads do not need Supabase to resolve connector_id.

Required index object:
history/_index_v2/timeseries/{timeseries_id}.json

Example fields:
- timeseries_id
- timeseries_ref
- connector_id
- pollutant
- station_id
- station_ref
- service_ref
- phenomenon_id
- first_observed_at
- last_observed_at
- index_version

Implement in phases inside this task:
1. Find the R2 history writer/backfill code that builds v2 observations history indexes.
2. Extend it to write/update the timeseries metadata index for each timeseries included in history.
3. Add a read helper in the observations history worker to fetch the timeseries metadata index by timeseries_id.
4. Update uk_aq_timeseries source=history path to use the R2 metadata index to resolve connector_id when connector_id is not supplied.
5. Do not call Supabase for connector resolution in source=history when the R2 metadata index exists.
6. Add debug fields:
   - timeseries_metadata_index_key
   - timeseries_metadata_index_hit
   - connector_id_source: request | r2_index | supabase_lookup | unresolved
   - pollutant_source: request | r2_index | unresolved

Acceptance test:
source=history&timeseries_id=3742&pollutant=pm25 with no connector_id should resolve connector_id from R2 index and return uses_supabase=false.

If the index object is missing, return a clear diagnostic explaining that the R2 metadata index needs backfilling, rather than silently falling back to Supabase in source=history.

Run type checks and tests.
```

## Phase 5: Refactor AQI R2 history worker to match observations contract

### Goal

Make AQI/hourly historical lookups follow the same source rules and metadata contract as observations.

### Changes

1. Accept and normalise `pollutant`.
2. Require pollutant for v2 partitioned AQI reads.
3. Accept `connector_id` and use R2 metadata index fallback.
4. Return only AQI/hourly fields, not derived colours unless explicitly requested.
5. Add `debug=summary|full` support.
6. Add monthly/range manifest support if implemented for observations.

### Acceptance tests

For a known PM2.5 timeseries/date range with AQI rows:

```text
AQI worker returns rows
pollutant_partition is not null
No pollutant-required warning
No Supabase dependency for historical-only range
```

### Codex prompt

```text
Refactor the AQI R2 history worker to mirror the observations R2 history worker contract.

Do not implement downsampling.

Required request contract:
- timeseries_id
- connector_id optional
- pollutant required for v2 partitioned reads, unless resolvable from R2 metadata index
- start_utc
- end_utc
- since_utc optional
- limit optional
- debug optional

Pollutant normalisation:
- pm25, pm2.5, pm2_5, pm2p5 → pm25
- pm10 → pm10
- no2 → no2

Return fields:
- observed_at
- aqi_source
- hourly_mean_ugm3
- rolling24h_mean_ugm3
- hourly_sample_count
- daqi_index_level
- eaqi_index_level

Do not return derived colours by default. Frontend/diagnostics should map colours from index levels.

Use the same R2 timeseries metadata index as observations where possible:
history/_index_v2/timeseries/{timeseries_id}.json

Add debug fields equivalent to observations:
- incoming pollutant
- normalised pollutant
- pollutant_partition
- connector_id_source
- timeseries_metadata_index_hit
- candidate manifests/chunks summary
- rows read
- rows after time filter

Acceptance test:
Known PM2.5 timeseries/date range with AQI rows should return AQI rows with pollutant_partition set and no pollutant-required warning. Historical-only requests should not require Supabase.

Run type checks and tests.
```

## Phase 6: Add monthly/range manifests for observations and AQI indexes

### Goal

Make 31d, 90d, and future older chart ranges efficient without downsampling.

This phase is about reducing index-object scans and R2 operations, not reducing returned point density.

### Recommended manifest keys

```text
history/_index_v2/observations_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json
history/_index_v2/aqi_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json
```

Each manifest should include:

```json
{
  "index_version": "v2",
  "pollutant": "pm25",
  "connector_id": 6,
  "year": 2026,
  "month": 5,
  "start_utc": "2026-05-01T00:00:00Z",
  "end_utc": "2026-06-01T00:00:00Z",
  "chunks": [
    {
      "key": "...",
      "min_observed_at": "...",
      "max_observed_at": "...",
      "timeseries_ids": [3742],
      "row_count": 12345
    }
  ]
}
```

If `timeseries_ids` arrays get too large, use a compact map or per-timeseries index files instead.

### Worker behaviour

For long ranges:

1. Resolve pollutant and connector.
2. Identify overlapping months.
3. Read monthly manifests.
4. Select only chunks that overlap time range and include the timeseries.
5. Read selected chunks.
6. Filter rows by time and timeseries.

### Acceptance tests

For a 90d request:

```text
monthly manifests read > 0
per-day manifest scan avoided or reduced
r2 object reads lower than before
response row count unchanged
```

### Codex prompt

```text
Add monthly/range manifest support to the v2 R2 observations and AQI history indexes to reduce R2 index-object reads for 31d, 90d, and future longer chart windows.

Do not implement downsampling.

For observations, add manifests like:
history/_index_v2/observations_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json

For AQI, add manifests like:
history/_index_v2/aqi_monthly/pollutant=pm25/connector_id=6/year=2026/month=05.json

Each manifest should include:
- index_version
- pollutant
- connector_id
- year
- month
- start_utc
- end_utc
- chunks with key, min_observed_at, max_observed_at, row_count, and a way to test whether a timeseries_id is present

Update the history workers so long range requests use monthly manifests before falling back to daily/per-file indexes.

Debug should show:
- monthly_manifest_keys_checked
- monthly_manifest_hit_count
- chunks_selected_from_monthly
- fallback_to_daily_index true/false
- r2_object_reads

Acceptance test:
A 90d observations request for timeseries_id=3742&connector_id=6&pollutant=pm25 should return the same rows as before but with fewer index-object reads. A missing monthly manifest should fall back cleanly to existing daily/index behaviour with a debug warning.

Run type checks and tests.
```

## Phase 7: Move verbose debug behind `debug=1` and keep public responses slim

### Goal

Keep Station Snapshot v2 highly diagnostic without making public chart responses large.

### Changes

1. Add `debug` param to `/api/aq/timeseries`, observations worker, and AQI worker.
2. Default response includes minimal meta only.
3. `debug=summary` includes source planning, counts, partial reasons.
4. `debug=full` includes candidate keys, manifests, chunk reads, warnings.
5. Station Snapshot v2 should request `debug=full` or `debug=summary`.
6. Hex map chart should not request full debug by default.

### Acceptance tests

Public chart request without `debug`:

```text
Response has no large candidate key arrays.
```

Station Snapshot v2 request:

```text
Debug panel still contains useful diagnostics.
```

### Codex prompt

```text
Move verbose R2/timeseries diagnostics behind a debug parameter so public chart responses stay small.

Implement debug modes:
- no debug param: minimal meta only
- debug=summary: source plan, source row counts, partial reasons, coverage summary
- debug=full: candidate keys, manifests checked, chunk details, warnings, auth/config diagnostics

Apply to:
- /api/aq/timeseries
- observations R2 history worker
- AQI R2 history worker
- Station Snapshot v2 requests

Station Snapshot v2 should request debug=full or debug=summary. Hex map chart should not request full debug by default.

Acceptance tests:
1. Normal chart request without debug should not include candidate key arrays or large coverage objects.
2. Station Snapshot v2 should still show the rows debug panel.
3. debug=summary should include counts and partial reasons.
4. debug=full should include candidate keys/manifests/chunks.

Run type checks and tests.
```

## Phase 8: Update cache policy for historical, recent, and stitched responses

### Goal

Reduce egress and backend load by caching immutable or slow-changing historical R2 responses more aggressively than recent responses.

### Changes

1. Classify response as:

```text
history_only
recent_only
stitched
```

2. Apply cache policy:

```text
history_only:
  public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=86400

recent_only:
  public, max-age=60, s-maxage=60, stale-while-revalidate=30, stale-if-error=300

stitched:
  use recent policy unless the effective response contains only historical rows
```

3. ETags should include index/chunk version fields where available.
4. Preserve existing `If-None-Match` behaviour.

### Acceptance tests

Historical-only response:

```text
Cache-Control shows longer s-maxage.
ETag changes if request params or index version changes.
```

Recent response:

```text
Cache-Control remains short.
```

### Codex prompt

```text
Update cache policy for uk_aq_timeseries and R2 history workers so historical-only responses are cached more aggressively than recent or stitched responses.

Rules:
- history_only: Cache-Control public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=86400
- recent_only: keep short realtime cache, roughly max-age=60, s-maxage=60, stale-while-revalidate=30, stale-if-error=300
- stitched: use recent policy unless the response is effectively historical-only

Keep existing ETag support and If-None-Match behaviour.

If available, include index_version/chunk manifest version in ETag payload for historical responses.

Acceptance tests:
- source=history response has long cache headers.
- source=recent response has short cache headers.
- source=stitched crossing the retention boundary has short cache headers.
- ETag/304 still works.

Run type checks and tests.
```

## Phase 9: Final integration tests

### Core observations test

```bash
curl -s "http://localhost:8080/api/aq/timeseries?timeseries_id=3742&connector_id=6&pollutant=pm25&source=history&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact&debug=summary" | python3 -m json.tool
```

Expected:

```text
HTTP 200
uses_supabase=false
uses_r2=true
pollutant_partition=pm25 or equivalent non-null value
No pollutant-required warning
Rows returned if data exists
```

### Compatibility chart test

```bash
curl -s "http://localhost:8080/api/aq/timeseries?timeseries_id=3742&pollutant=pm25&start=2026-05-18T00:00:00Z&end=2026-06-18T00:00:00Z&format=compact" | python3 -m json.tool
```

Expected:

```text
Existing API still works.
If connector_id missing and source omitted, compatibility fallback may use Supabase lookup.
```

### Station Snapshot v2 test

```text
Search: surbit
Pollutant: PM2.5
Range: 31 days or 90 days
Station: AirGradient Surbiton - CleanAirSurb
```

Expected:

```text
Rows table is not empty when R2 data exists.
r2.observs.value populated.
Debug shows pollutant forwarded and non-null pollutant partition.
AQI rows appear if AQI history exists.
```

### No accidental DB dependency test

For historical source with connector_id supplied:

```text
uses_supabase=false
uses_ingest_rpc=false
uses_connector_lookup=false
```

## Risks and mitigations

### Risk: old callers do not send pollutant

Mitigation:

- Keep compatibility warning for old callers.
- For `source=stitched`, allow Supabase fallback only if necessary.
- For v2 R2 partitioned reads, do not broad-scan all pollutants. Return a clear error or partial response.

### Risk: R2 metadata index not backfilled

Mitigation:

- Implement R2 index fallback in stages.
- Keep connector_id request param support.
- Return a clear diagnostic when index is missing.

### Risk: debug payloads increase response size

Mitigation:

- Move verbose debug behind `debug=full`.
- Keep public chart requests slim.

### Risk: cache serves stale repaired history

Mitigation:

- Include `index_version` or `history_build_id` in ETag payload.
- Bump cache key/version after repair/backfill jobs.

## Not included in this refactor

Downsampling is explicitly excluded.

Future downsampling project should add:

```text
resolution=hourly
resolution=daily_mean
resolution=daily_max
resolution=auto
```

and should decide chart-specific behaviour separately.
