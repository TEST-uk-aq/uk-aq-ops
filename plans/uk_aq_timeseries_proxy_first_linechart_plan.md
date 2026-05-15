# UK-AQ Line Chart Timeseries Proxy-First Migration Plan

## Purpose

Move the first website line chart data path — the chart opened from the `hex_map.html` sensor list — onto a proxy-first timeseries API path that can stitch R2 history plus the live ingest tail without leaving gaps when R2 history lags.

This plan assumes the chart in `hex_map.html` and `sensors_chart.html` share visual chart helpers via `chart-core.js`, but that the data-fetching layer should be made into an explicit shared helper/adapter rather than hidden inside page-specific code.

## Current understanding

Repos involved:

- `uk-aq` — website UI, including `hex_map.html`, `sensors_chart.html`, and `chart-core.js`.
- `uk-aq-ops` — Cloudflare workers, including `workers/uk_aq_cache_proxy`.
- `uk-aq-ingest` — ingest/polling workers. This should remain the producer of recent observations, not the chart stitcher.
- `uk-aq-schema` — Supabase schema/RPC ownership.

Current proxy facts:

- `uk_aq_cache_proxy` already maps `/api/aq/timeseries` to the Supabase `uk_aq_timeseries` origin.
- `uk_aq_timeseries` currently uses the `realtime` cache profile.
- Existing chart metrics already track chart request/cache behaviour, so v2 should extend that observability rather than inventing a separate diagnostics system.

## Decisions

No blocking product decisions are needed before starting.

Use these implementation decisions:

1. The first user-facing target is the `hex_map.html` chart opened from the sensor list.
2. `sensors_chart.html` should be kept compatible by using the same shared timeseries fetch helper.
3. `chart-core.js` remains visual/rendering-only.
4. Add a new shared frontend helper, for example `timeseries-client.js`, for API request building, response normalization, ETag/local cache handling, and metadata logging.
5. Cloudflare `uk_aq_cache_proxy` becomes the primary stitch/cache layer.
6. Supabase `uk_aq_timeseries` remains the fallback/origin for live tail and rollback.
7. R2 history is authoritative where present.
8. Ingest/Supabase fills only the tail after actual R2 coverage ends, or explicit missing slices.
9. Ingest must not overwrite R2 rows for the same timestamp by default.
10. Do not use fixed “recent source of truth hours” to decide where the Supabase tail starts.

## Target architecture

```text
hex_map.html sensor list chart
  ↓
shared frontend timeseries client
  ↓
/api/aq/timeseries?timeseries_id=...&window=...&v=2
  ↓
Cloudflare uk_aq_cache_proxy
  ↓
R2 history / coverage manifest or index
  + Supabase uk_aq_timeseries tail fetch
  ↓
stitch, dedupe, gap-check, cache
  ↓
shared chart rendering helpers
```

## Source of truth policy

```text
R2 history wins for any timestamp it contains.
Supabase/ingest is used only for:
  - the tail after R2 coverage ends;
  - explicitly missing R2 slices;
  - emergency fallback if R2 is temporarily unavailable.
```

Default duplicate policy:

```text
If R2 and ingest both return the same observed_at timestamp:
  keep the R2 row;
  drop the ingest duplicate;
  increment deduped_row_count.
```

## API contract

### Request

Primary endpoint:

```text
GET /api/aq/timeseries
```

Required/canonical params:

```text
timeseries_id=3742
window=12h | 24h | 7d | 31d | 90d
v=2
format=json
```

Incremental polling:

```text
GET /api/aq/timeseries?timeseries_id=3742&since=2026-05-14T20:15:00Z&v=2
```

Optional debug/range mode:

```text
start_utc=2026-05-01T00:00:00Z
end_utc=2026-05-14T00:00:00Z
```

Normalize cache-key params:

- `timeseries_id` as integer string.
- `window` as lowercase canonical labels.
- `since`, `start_utc`, and `end_utc` as UTC ISO strings, truncated consistently.
- `format=json`.
- `v=2`.

Strip/reject accidental cache busters unless an authorized bypass is present:

- `_t`
- `timestamp`
- `cache_bust`
- `random`

### Response

```json
{
  "schema_version": 2,
  "timeseries_id": 3742,
  "request": {
    "window": "7d",
    "start_utc": "2026-05-07T00:00:00Z",
    "end_utc": "2026-05-14T00:00:00Z",
    "since": null
  },
  "data": [
    {
      "observed_at": "2026-05-13T10:00:00Z",
      "value": 18.2,
      "unit": "µg/m³",
      "source": "r2"
    }
  ],
  "meta": {
    "source_mode": "r2_plus_ingest_tail",
    "r2_coverage_start": "2026-05-07T00:00:00Z",
    "r2_coverage_end": "2026-05-09T23:59:59Z",
    "ingest_tail_start": "2026-05-10T00:00:00Z",
    "ingest_tail_end": "2026-05-14T00:00:00Z",
    "row_count": 1234,
    "r2_row_count": 900,
    "ingest_row_count": 334,
    "deduped_row_count": 0,
    "has_gap": false,
    "gap_ranges": [],
    "next_since": "2026-05-14T20:15:00Z",
    "cache_status": "MISS",
    "etag": "\"ts-v2-...\""
  }
}
```

The frontend should tolerate the old response shape during migration, but v2 should return this richer shape.

## Cache policy

| Request class | Example | Edge TTL | Browser TTL | Stale while revalidate | Notes |
|---|---:|---:|---:|---:|---|
| Recent chart | `12h`, `24h`, `since=` | 30–60s | 30–60s | 30–60s | Main user-facing path |
| Mixed R2 + ingest | `7d` while R2 lags | 60–120s | 60s | 60–120s | Prevents repeated Supabase tail hits |
| Historical | `31d`, `90d`, R2-only | 86400s | 86400s | 86400s | Strong cache win |
| Error fallback | stale cached response | previous TTL | previous TTL | `stale-if-error=300+` | Prefer stale continuity over empty chart |
| Authorized bypass | `cache=bypass` + token/header | 0 | 0 | 0 | Debug only |

Use both ETag and TTL. ETag-only still creates repeated validation traffic; TTL lets Cloudflare answer repeated chart loads directly.

## Stitching algorithm

```text
1. Parse and normalize request.
2. Resolve request window into start_utc/end_utc.
3. Discover actual R2 coverage for the timeseries/window.
4. Fetch all available R2 slices covering request_start..min(request_end, r2_coverage_end).
5. Set ingest_tail_start from actual R2 coverage, not from a fixed recent-hours setting.
6. Fetch Supabase/ingest only for uncovered tail or explicit missing slices.
7. Merge rows by observed_at.
8. Apply R2-wins duplicate policy.
9. Sort ascending by observed_at.
10. Detect gaps using expected sampling interval/window-aware threshold.
11. Compute next_since.
12. Return data + meta + ETag + cache headers.
```

The important rule is:

```text
ingest_tail_start = actual_r2_coverage_end + epsilon
```

not:

```text
ingest_tail_start = now - UK_AQ_TIMESERIES_RECENT_SOURCE_OF_TRUTH_HOURS
```

## Frontend plan

### Shared frontend helper

Add a small shared frontend helper, for example:

```text
timeseries-client.js
```

Responsibilities:

- Build canonical v2 timeseries URLs.
- Normalize returned rows to the chart point shape expected by existing renderers.
- Handle ETag/local cache if that already exists in page code.
- Preserve `next_since` for future polling.
- Surface `meta.has_gap` and `meta.source_mode` for debug logs.
- Fall back to old response shape if v2 is disabled.

Keep `chart-core.js` focused on rendering and shared visual helpers.

### `hex_map.html`

Use the shared helper for the chart opened from the sensor list.

The chart should request by `timeseries_id`, `window`, `pollutant`, and `v=2` where applicable.

Do not change the current chart-mode UI behaviour unless required for the data contract.

### `sensors_chart.html`

Update to use the same shared helper after `hex_map.html` works.

This keeps both chart entry points aligned and avoids two data-fetch implementations drifting apart.

## Backend proxy plan

In `uk-aq-ops/workers/uk_aq_cache_proxy`:

1. Add v2-aware timeseries handling before the existing generic Supabase proxy path.
2. Gate it behind env flags.
3. Keep the existing v1 passthrough behaviour for rollback.
4. Add R2 history API/manifest/index config.
5. Add Supabase tail fetch helper.
6. Add stitch/dedupe/gap logic.
7. Add response metadata and headers.
8. Add tests for cache-key normalization and gap prevention.

## Env vars

### Add

```text
UK_AQ_TIMESERIES_V2_ENABLED=true
UK_AQ_TIMESERIES_PROXY_FIRST=true
UK_AQ_TIMESERIES_R2_FIRST=true
UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE=false

UK_AQ_OBSERVS_HISTORY_R2_API_URL=...
UK_AQ_TIMESERIES_R2_MANIFEST_URL=...
UK_AQ_TIMESERIES_R2_INDEX_URL=...

UK_AQ_TIMESERIES_RECENT_EDGE_TTL_SECONDS=60
UK_AQ_TIMESERIES_RECENT_BROWSER_TTL_SECONDS=60
UK_AQ_TIMESERIES_RECENT_SWR_SECONDS=60

UK_AQ_TIMESERIES_HISTORICAL_EDGE_TTL_SECONDS=86400
UK_AQ_TIMESERIES_HISTORICAL_BROWSER_TTL_SECONDS=86400
UK_AQ_TIMESERIES_HISTORICAL_SWR_SECONDS=86400

UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES=180
UK_AQ_TIMESERIES_MAX_WINDOW_DAYS=90
UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST=120
UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS=168

UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR=true
UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR=false
UK_AQ_TIMESERIES_STALE_IF_ERROR_SECONDS=300
```

### Keep

```text
SUPABASE_URL
SB_PUBLISHABLE_DEFAULT_KEY
OBS_AQIDB_SUPABASE_URL
OBS_AQIDB_SECRET_KEY
UK_AQ_CACHE_ALLOWED_ORIGINS
UK_AQ_EDGE_ACCESS_TOKEN_SECRET
UK_AQ_EDGE_UPSTREAM_SECRET
UK_AQ_CACHE_BYPASS_SECRET
UK_AQ_CHART_METRICS_RPC
UK_AQ_CHART_METRICS_RPC_SCHEMA
```

### Deprecate/remove from normal policy

```text
UK_AQ_TIMESERIES_INGEST_SOURCE_OF_TRUTH_HOURS
UK_AQ_TIMESERIES_RECENT_SOURCE_OF_TRUTH_HOURS
```

Replace them with actual R2 coverage-driven stitching plus the emergency Supabase cap:

```text
UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS=168
```

## Response/debug headers

Add these where practical:

```text
X-UK-AQ-Timeseries-Source-Mode: r2_plus_ingest_tail
X-UK-AQ-R2-Coverage-End: 2026-05-09T23:59:59Z
X-UK-AQ-Ingest-Tail-Start: 2026-05-10T00:00:00Z
X-UK-AQ-Cache-Key-Version: ts-v2
X-UK-AQ-Has-Gap: false
X-UK-AQ-R2-Rows: 900
X-UK-AQ-Ingest-Rows: 334
```

## Rollout

### Phase 1 — non-breaking frontend helper

- Add shared `timeseries-client.js`.
- Wire `hex_map.html` chart path through it.
- Keep old endpoint/response compatibility.
- No visual UI change.

### Phase 2 — proxy v2 skeleton

- Add v2 route handling inside `uk_aq_cache_proxy`.
- Return old Supabase data through the v2 response envelope if full R2 stitch is not enabled.
- Add normalized cache keys and metadata headers.

### Phase 3 — R2 coverage discovery

- Add manifest/index lookup.
- Add fallback object discovery if manifest/index is unavailable.
- Return `r2_coverage_end` in metadata.

### Phase 4 — R2 + ingest tail stitch

- Fetch R2 rows first.
- Calculate ingest tail from actual R2 coverage.
- Fetch Supabase/ingest tail.
- Dedupe and sort.
- Return `has_gap` and row-count metadata.

### Phase 5 — canary

Start with:

```text
CIC-Test only
connector 6 / OpenAQ first
one or two known timeseries, including the existing test timeseries 3742 if available
```

Success criteria:

- `hex_map.html` chart opens normally from the sensor list.
- No middle gap when R2 latest is older than the requested chart window.
- R2 wins duplicate timestamps.
- `next_since` is monotonic.
- Repeated chart opens hit Cloudflare cache instead of repeatedly hitting Supabase.
- Existing `sensors_chart.html` still works.


### Phase 6 — expand

Promote in this order:

1. CIC-Test, OpenAQ only.
2. CIC-Test, all networks.
3. LIVE, allowlisted timeseries/connectors.
4. LIVE, full chart traffic.

### Rollback

Rollback should require only flags:

```text
UK_AQ_TIMESERIES_PROXY_FIRST=false
UK_AQ_TIMESERIES_V2_ENABLED=false
```

Frontend should also have a simple fallback switch to use the old path while v2 is canaried.

## Testing matrix

Windows:

```text
12h
24h
7d
31d
90d
```

Cases:

```text
R2 fully current
R2 lagging by 1 day
R2 lagging by 4 days
R2 missing a middle day/object
Supabase/ingest missing interval
R2 manifest unavailable
R2 object/API transient failure
Supabase tail transient failure
Duplicate timestamp in R2 and ingest
Late-arriving point after next_since
```

Expected outcomes:

```text
No middle gaps between R2 latest and ingest tail.
R2 duplicate rows win by default.
next_since never goes backwards.
Cache key is stable for equivalent requests.
ETag/304 still works.
Recent repeated chart loads avoid repeated Supabase hits.
Metadata clearly explains source_mode and coverage.
```

---

# Codex prompt 1 — inspect current frontend chart data paths

```text
Repo: https://github.com/ChronicChannel-test/uk-aq

I need you to inspect the current line chart data path used by `hex_map.html`, specifically the chart opened from the sensor list, and compare it with `sensors_chart.html`.

Context:
- `chart-core.js` appears to be the shared visual/rendering helper layer.
- The first production target is the chart embedded in `hex_map.html` and opened from the sensor list.
- `sensors_chart.html` should remain compatible and should eventually use the same data-fetch helper.
- Do not make visual UI changes yet.

Please report:
1. Where `hex_map.html` currently fetches raw observation/timeseries data for the line chart.
2. Whether `hex_map.html` and `sensors_chart.html` already share a data-fetch helper, or only share visual chart helpers.
3. Which functions/files should be extracted into a shared helper such as `timeseries-client.js`.
4. Any assumptions in the current frontend code about response shape, ETag/local cache, chunking, polling, or `since`.
5. A low-risk implementation plan for switching only the data source to `/api/aq/timeseries?v=2` while keeping the chart UI unchanged.

Do not implement yet. Produce a concise technical report with file/function references.
```
Plan review: no blocking inaccuracies for Prompt 1.  
I proceeded with Prompt 1 inspection.

**Prompt 1 Report**

1. `hex_map.html` current line-chart data fetch path (sensor-list chart)
- The chart-mode module builds the timeseries endpoint as `cache_base + "/timeseries"` in [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15327).
- Raw observations are fetched in `fetchObservationSeriesChunk(...)` via:
  - `timeseries_id`
  - `start`
  - `end`
  - `format=compact`  
  in [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15852).
- Main load path chunks requests by window (`buildChunkWorkQueue`) and merges incrementally in `loadChartData(...)` in [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15873) and [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:16008).
- Refresh path does delta by right-edge time (not `since` param), see `refreshChartData(...)` in [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15700).

2. Shared helper status: `hex_map.html` vs `sensors_chart.html`
- They share **visual** helper `chart-core.js` only ([chart-core.js](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/chart-core.js:1)).
- They do **not** share a dedicated timeseries data client.
- `sensors_chart.html` has its own endpoint builder/caching/ETag/since logic ([sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3544), [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3585), [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3686)).
- `hex_map.html` has parallel-but-separate implementations ([hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15460), [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15852)).

3. What should be extracted to shared `timeseries-client.js`
- URL construction:
  - canonical `/api/aq/timeseries` request builder (`timeseries_id`, `window` or `start/end`, `since`, `format`, `v`)
- Response normalization:
  - compact/object payload parser currently duplicated (`parseSeriesPayloadPoints`, numeric parsing)
- Merge/dedupe helpers:
  - `mergeSeriesPoints`
- Transport wrapper hooks:
  - consume injected cache-fetch (`window.ukAqFetchCacheApi`) if present, else `fetch`
- Optional incremental helpers:
  - `next_since` extraction + store/update

Keep page-specific:
- UI flow/state machines, selection logic, animation timing, AQI band rendering, table rendering.

4. Current frontend assumptions (response shape/cache/chunking/polling/since)
- Response shape assumptions:
  - payload contains `data`
  - optionally `data_format="compact"` + `columns=["observed_at","value", ...]`
  - fallback object rows with `observed_at` + `value`
  - optional `guideline`
  - optional `next_since`  
  refs: [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:2366), [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15460).
- ETag/local cache:
  - `sensors_chart.html` uses `If-None-Match`, handles `304`, persists local cache (`seriesSinceByKey`, `seriesEtagByKey`, point cache)  
  refs: [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3590), [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3614), [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:2458).
- Chunking/polling:
  - `hex_map.html` chunks large windows and refreshes with right-edge delta using `start/end` slices (no `since`)  
  refs: [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15716), [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html:15873).
  - `sensors_chart.html` uses incremental `since` mode plus cache revalidation.  
  refs: [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3550), [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html:3642).

5. Low-risk switch plan to `/api/aq/timeseries?v=2` (UI unchanged)
1. Add `timeseries-client.js` with:
- request builder + param canonicalization
- transport wrapper (use `window.ukAqFetchCacheApi` when available)
- payload normalizer supporting both legacy and v2 envelope
2. Integrate `hex_map.html` first:
- replace `fetchObservationSeriesChunk` internals to call shared client
- keep existing chart-state, chunk queue, render flow unchanged
3. Preserve backward compatibility:
- if `v2` flag off or v2 fields absent, parse legacy shape exactly as today
4. Keep `chart-core.js` untouched (render-only).
5. Integrate `sensors_chart.html` second by swapping request/parse paths to shared client while keeping existing local-storage/ETag/since orchestration.

No files were modified in this step (inspection/report only).


# Codex prompt 2 — add shared frontend timeseries client

```text
Repo: https://github.com/ChronicChannel-test/uk-aq

Implement a shared frontend timeseries data helper for the website line charts.

Target files:
- `hex_map.html` first, especially the chart opened from the sensor list.
- `sensors_chart.html` second, only where safe.
- Add a new shared file if appropriate, e.g. `timeseries-client.js`.
- Keep `chart-core.js` visual/rendering-only.

Requirements:
1. Add a shared helper that builds canonical v2 timeseries URLs:
   `/api/aq/timeseries?timeseries_id=...&window=...&v=2&format=json`
2. Support optional incremental requests using `since=...`.
3. Normalize v2 responses into the chart point shape currently expected by the chart renderer.
4. Preserve compatibility with the existing/old response shape while the proxy v2 rollout is behind flags.
5. Surface useful metadata to console/debug logs only, especially:
   - `source_mode`
   - `r2_coverage_end`
   - `ingest_tail_start`
   - `has_gap`
   - `cache_status`
6. Preserve existing ETag/local-cache behaviour if present.
7. Do not change chart styling, chart controls, sensor-list behaviour, or map UI.
8. Add comments explaining that `chart-core.js` is rendering-only and `timeseries-client.js` owns request/response normalization.

Feature flag:
- Add a clear frontend flag/constant such as `UK_AQ_CHART_TIMESERIES_PROXY_V2_ENABLED` or equivalent local config pattern already used in the repo.
- When disabled, use the existing data path.
- When enabled, use `/api/aq/timeseries?v=2`.

After implementation, provide:
- Files changed.
- Main functions changed/added.
- How to manually test `hex_map.html` chart from the sensor list.
- Any follow-up backend assumptions.
```

# Codex prompt 3 — implement proxy v2 skeleton in ops repo

```text
Repo: https://github.com/ChronicChannel-test/uk-aq-ops

Implement a gated v2 skeleton for `/api/aq/timeseries` inside `workers/uk_aq_cache_proxy`.

Context:
- Existing `ROUTE_TO_FUNCTION_MAP` maps `timeseries` to `uk_aq_timeseries`.
- Existing `FUNCTION_PROFILE_MAP` maps `uk_aq_timeseries` to the `realtime` cache profile.
- The new v2 path should be proxy-first but safely fall back to the existing Supabase origin until R2 stitching is implemented.

Requirements:
1. Add env flags:
   - `UK_AQ_TIMESERIES_V2_ENABLED`
   - `UK_AQ_TIMESERIES_PROXY_FIRST`
   - `UK_AQ_TIMESERIES_R2_FIRST`
   - `UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE`
2. If `/api/aq/timeseries` has `v=2` and v2 is enabled, route through a new v2 handler before the generic Supabase proxy path.
3. Normalize cache-key params:
   - `timeseries_id`
   - `window`
   - `since`
   - `start_utc`
   - `end_utc`
   - `format`
   - `v`
4. Strip/reject accidental cache busters such as `_t`, `timestamp`, `cache_bust`, and `random`, unless the existing authorized cache-bypass mechanism is used.
5. Initially call the existing Supabase `uk_aq_timeseries` origin and wrap/normalize the response into a v2 envelope where possible.
6. Add response metadata fields even if still using origin-only mode:
   - `source_mode: "origin_only_v2_wrapper"`
   - `r2_coverage_end: null`
   - `ingest_tail_start: null`
   - `has_gap: null`
   - row counts where possible
7. Add headers:
   - `X-UK-AQ-Timeseries-Source-Mode`
   - `X-UK-AQ-Cache-Key-Version: ts-v2`
   - `X-UK-AQ-Has-Gap`
8. Preserve old v1 behaviour when v2 is disabled or `v=2` is absent.
9. Add tests or lightweight script checks for URL normalization and fallback behaviour.

Do not implement full R2 stitching in this prompt. This is just the safe v2 skeleton and cache-key normalization.
```

# Codex prompt 4 — add R2 coverage discovery and stitcher

```text
Repo: https://github.com/ChronicChannel-test/uk-aq-ops

Extend the `/api/aq/timeseries?v=2` handler in `workers/uk_aq_cache_proxy` to use R2-first stitching for line chart observations.

Policy:
- R2 history is authoritative where present.
- Supabase/ingest fills only the tail after actual R2 coverage ends, or explicit missing slices.
- Ingest must not overwrite R2 rows for the same `observed_at` timestamp unless `UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE=true`.
- Do not use fixed recent-hours source-of-truth settings to decide stitch boundaries.

Add/env config:
- `UK_AQ_OBSERVS_HISTORY_R2_API_URL`
- `UK_AQ_TIMESERIES_R2_MANIFEST_URL`
- `UK_AQ_TIMESERIES_R2_INDEX_URL`
- `UK_AQ_TIMESERIES_MAX_WINDOW_DAYS`
- `UK_AQ_TIMESERIES_MAX_R2_OBJECTS_PER_REQUEST`
- `UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS`
- `UK_AQ_TIMESERIES_INCREMENTAL_OVERLAP_MINUTES`
- `UK_AQ_TIMESERIES_PARTIAL_ON_R2_ERROR`
- `UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR`

Implement:
1. Resolve request window into `start_utc` and `end_utc`.
2. Discover actual R2 coverage for the requested `timeseries_id` and window using manifest/index first.
3. If manifest/index is unavailable, use a safe fallback such as object/day discovery where possible.
4. Fetch R2 history rows for covered slices.
5. Compute `ingest_tail_start` from actual `r2_coverage_end + epsilon`.
6. Fetch Supabase `uk_aq_timeseries` only for the uncovered tail or explicit missing slices.
7. Merge rows by `observed_at`.
8. Deduplicate with R2 winning by default.
9. Sort rows ascending.
10. Detect gaps larger than the expected interval/window-aware threshold.
11. Compute monotonic `next_since`.
12. Return v2 response metadata:
    - `source_mode`
    - `r2_coverage_start`
    - `r2_coverage_end`
    - `ingest_tail_start`
    - `ingest_tail_end`
    - `row_count`
    - `r2_row_count`
    - `ingest_row_count`
    - `deduped_row_count`
    - `has_gap`
    - `gap_ranges`
    - `next_since`
    - `cache_status`

Cache behaviour:
- Recent/mixed responses: short edge/browser TTL, SWR, stale-if-error.
- Historical R2-only responses: longer TTL.
- Keep ETag support.

Failure behaviour:
- If R2 fails but Supabase succeeds and the requested fallback is within cap, return short-TTL partial/emergency response with clear metadata.
- If Supabase tail fails but R2 fully covers the request, return R2-only.
- If Supabase tail fails and R2 does not cover the tail, either return partial with `has_gap=true` or fail according to `UK_AQ_TIMESERIES_PARTIAL_ON_INGEST_ERROR`.
- Prefer stale cached response where available.

Add tests for:
- R2 fully current.
- R2 lagging by multiple days.
- R2 missing a middle slice.
- Duplicate timestamps.
- Supabase tail failure.
- Manifest/index failure.
- `since` incremental overlap.
```

# Codex prompt 5 — schema/RPC check for Supabase tail support

```text
Repo: https://github.com/ChronicChannel-test/uk-aq-schema

Check whether the existing Supabase `uk_aq_timeseries` RPC/function contract can support the Cloudflare proxy v2 stitcher fetching only a tail range.

Required tail query behaviour:
- Input must allow `timeseries_id`.
- Input must allow `start_utc` / `end_utc`, or equivalent.
- It must be possible to fetch the range from actual R2 coverage end to request end, even when that is longer than the old recent source-of-truth window.
- It should return enough fields for chart rendering and dedupe:
  - `observed_at`
  - numeric value
  - unit if available
  - pollutant/parameter if needed
  - any existing station/timeseries identifiers needed by frontend code

Please report:
1. Existing RPC/function name and signature.
2. Whether it supports arbitrary tail start/end ranges.
3. Any hard-coded recent-hours logic that would prevent fetching a longer tail when R2 lags.
4. Required migration if a new helper RPC is needed.
5. Recommended RPC name/signature if adding a new tail-only RPC.

If safe, implement only the minimal schema/RPC change needed for the proxy to fetch a bounded tail range. Do not change ingest workers.
```
The required RPC already exists. /workspaces/uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql:161-222:


uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  p_connector_id, p_timeseries_id,
  p_start_utc timestamptz, p_end_utc timestamptz,
  p_since_ts timestamptz default null,
  p_limit integer default null
) returns table (observed_at timestamptz, value double precision)
This satisfies all five requirements from Prompt 5: arbitrary start_utc/end_utc, supports tail-only, no hard-coded recent-hours window, and since for incremental. The existing edge function uk_aq_timeseries (index.ts:65, OBS_AQIDB_TIMESERIES_WINDOW_RPC = "uk_aq_rpc_observs_timeseries_window") already calls it with p_start_utc/p_end_utc/p_since_ts. The proxy v2 stitcher hits this edge function via fetchTimeseriesOriginPayload (index.ts:1175). End-to-end already wired.

Nothing to migrate. 


# Codex prompt 6 — canary and validation script

```text
Repos:
- https://github.com/ChronicChannel-test/uk-aq
- https://github.com/ChronicChannel-test/uk-aq-ops

Add a simple validation/canary script or documented manual test for the proxy-first line chart timeseries path.

Target first chart:
- `hex_map.html` chart opened from the sensor list.

Test windows:
- `12h`
- `24h`
- `7d`
- `31d`
- `90d`

Test cases to simulate or document:
1. R2 fully current.
2. R2 lagging by 1 day.
3. R2 lagging by 4 days.
4. R2 missing a middle day/object.
5. Supabase/ingest missing interval.
6. R2 manifest unavailable.
7. R2 object/API transient failure.
8. Supabase tail transient failure.
9. Duplicate timestamp in R2 and ingest.
10. Late-arriving point after `next_since`.

Validation criteria:
- No middle gap between R2 latest and ingest tail.
- `source_mode`, `r2_coverage_end`, and `ingest_tail_start` make sense.
- R2 wins duplicate timestamps by default.
- `next_since` never goes backwards.
- Repeated equivalent requests use stable cache keys.
- Recent repeated chart loads avoid repeated Supabase hits.
- `hex_map.html` chart behaviour is unchanged visually.
- `sensors_chart.html` still works.

Produce:
- A script if practical, or a markdown manual test checklist if not.
- Example curl commands for `/api/aq/timeseries?v=2`.
- Expected response metadata examples.
- Clear rollback steps using feature flags.
```
