What's been done
Prompt 1 — inspection (✅)
Inspection report is embedded directly in the plan doc at lines 461-528. References functions in hex_map.html and sensors_chart.html. No code change.

Prompt 2 — shared frontend timeseries client (✅, both pages)
New: /workspaces/uk-aq/timeseries-client.js — 138 lines. Exposes window.UkAqTimeseriesClient with parseTimeseriesPayloadPoints, parseObservationNumericValue, normalizeTimeseriesMeta, buildCanonicalTimeseriesUrl. Handles both legacy and v2 envelope shapes.
hex_map.html wired through it (lines 15331, 15478, 15498, 15537-15544). Flag: UK_AQ_CHART_TIMESERIES_PROXY_V2_ENABLED.
sensors_chart.html also wired (lines 623-624, 2374, 2391, 2422, 3613-3621). Same flag.
Note: the plan staged sensors_chart.html for "after hex_map works" — Codex did both at the same time. Functionally fine.

Prompt 3 — proxy v2 skeleton (✅)
In workers/uk_aq_cache_proxy/src/index.ts:

Flag detection: resolveTimeseriesV2FlagsFromEnv (line 941), isTimeseriesV2Request (line 955)
Cache-key normalization: canonicalizeTimeseriesV2RequestUrl (line 965) — strips _t/timestamp/cache_bust/random unless authorized bypass; sets canonical v=2
Constants: allowed windows (12h/24h/7d/31d/90d), cache key version (ts-v2), defaults
Wired into the main fetch handler at lines 2185-2300
All 4 UK_AQ_TIMESERIES_* flag env vars declared in wrangler.toml comments
Prompt 4 — R2 coverage discovery + stitcher (✅, far more complete than "skeleton")
This is the surprise — Codex implemented Prompt 4 fully, not as a skeleton.

Helper module: /workspaces/uk-aq-ops/workers/uk_aq_cache_proxy/src/timeseries_v2_stitch.mjs — 251 lines, pure functions:

resolveTimeseriesWindowBounds (window labels + explicit start/end + max-days clamp)
normalizeObservedRow, mergeAndDedupeRows (R2-wins by default; ingest-overwrite gated by flag)
parseDayUtcFromManifestKey, buildMissingDaySlices, mergeSlices (turns R2's "missing keys" into ingest re-fetch slices)
computeCoverageFromRows (coverage start/end from row timestamps)
detectGapRanges (median-diff-aware threshold; head & tail gap detection)
computeNextSince (monotonic next-since)
subtractCoveredTailInterval (the key "ingest_tail_start = r2_coverage_end + epsilon" rule)
Wired in: stitchTimeseriesV2FromR2AndIngest (index.ts:1356-1572) — full implementation including:

Connector-id lookup via schema RPC (line 1132)
R2 fetch (fetchR2ObservationsPayload, line 1216) → calls ${UK_AQ_OBSERVS_HISTORY_R2_API_URL}/v1/observations?...
Tail interval = R2 coverage end (no fixed recent-hours)
Repair slices from R2's missing_day_manifest_keys / missing_connector_manifest_keys / missing_parquet_keys
Per-slice ingest fetch with cap (UK_AQ_TIMESERIES_MAX_SUPABASE_TAIL_HOURS)
Merge + dedupe + gap detect
5-way source_mode classification: r2_only, r2_plus_ingest_tail, r2_plus_ingest_tail_and_repairs, ingest_only_fallback, ingest_only_on_r2_error
r2_errors[] and ingest_errors[] aggregated into meta
Cache-control varies by source mode (buildTimeseriesV2CacheControl)
ETag derived from response body
All v2 response headers (X-UK-AQ-Timeseries-Source-Mode, X-UK-AQ-Has-Gap, X-UK-AQ-R2-Coverage-End, X-UK-AQ-Ingest-Tail-Start, X-UK-AQ-Cache-Key-Version)
Cached-hit re-emits the v2 headers from the cached entry
Tests: /workspaces/uk-aq-ops/tests/uk_aq_cache_proxy.timeseries_v2_stitch.test.mjs — 9 tests covering the algorithm cases the plan listed (R2-current, R2-lagging, missing-middle-day, dedupe both ways, gap detection, monotonic next_since, max-days clamp, coverage from rows). All would run via npm test.

Prompt 5 — schema/RPC check (✅ effectively, but undocumented)
The required RPC already exists. /workspaces/uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql:161-222:


uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  p_connector_id, p_timeseries_id,
  p_start_utc timestamptz, p_end_utc timestamptz,
  p_since_ts timestamptz default null,
  p_limit integer default null
) returns table (observed_at timestamptz, value double precision)
This satisfies all five requirements from Prompt 5: arbitrary start_utc/end_utc, supports tail-only, no hard-coded recent-hours window, and since for incremental. The existing edge function uk_aq_timeseries (index.ts:65, OBS_AQIDB_TIMESERIES_WINDOW_RPC = "uk_aq_rpc_observs_timeseries_window") already calls it with p_start_utc/p_end_utc/p_since_ts. The proxy v2 stitcher hits this edge function via fetchTimeseriesOriginPayload (index.ts:1175). End-to-end already wired.

Nothing to migrate. The Prompt 5 deliverable is just to document this finding (which the plan asked for: "Please report 1-5"). That hasn't been written down.

Prompt 6 — canary script + validation checklist (❌)
Not started. No file under tests/ or anywhere matching a canary/validation script. No markdown checklist for the 10 cases in the plan. Curl examples not produced.

What needs doing
Write the Prompt 5 report. Could be appended to the plan doc itself (matching the Prompt 1 report format) or live as system_docs/uk-aq-timeseries-v2-rpc-status.md. Two paragraphs: "no migration needed because X exists; here's the call chain frontend → proxy → uk_aq_timeseries → uk_aq_rpc_observs_timeseries_window".

Write the Prompt 6 canary checklist. Markdown file under system_docs/ with: 10 test cases × 5 windows, expected source_mode per case, curl recipes for /api/aq/timeseries?v=2, expected metadata snapshots, and the rollback flags. Skip an actual script unless you want one — manual ticks against the matrix is enough for a canary.

Decisions before flipping the rollout flags (see below).

Decisions to make before deploying
1. CIC-Test rollout flags — what to set
The proxy has 4 layered flags. Decide which to enable in CIC-Test environment vars:

Flag	Effect when true	Recommendation
UK_AQ_TIMESERIES_V2_ENABLED	The whole v2 code path is reachable	Enable in CIC-Test
UK_AQ_TIMESERIES_PROXY_FIRST	Worker handles v=2 requests instead of falling through to generic origin proxy	Enable (gates whether v2 actually runs)
UK_AQ_TIMESERIES_R2_FIRST	Engage R2 stitching; otherwise return origin-only-v2 wrapper	Enable once R2 API URL is configured
UK_AQ_TIMESERIES_ALLOW_INGEST_OVERWRITE	Ingest dedupe wins instead of R2	Keep off (plan default)
If R2_FIRST=false, the v2 response is wrapped origin data — same data as today, plus the v2 envelope. Lower-risk first step than full R2 stitching.

2. Is UK_AQ_OBSERVS_HISTORY_R2_API_URL set in CIC-Test?
The stitcher checks for it (index.ts:1413) and falls back to origin_only_v2_wrapper_r2_unconfigured if not. If it's not yet pointed at the observs history R2 API worker in CIC-Test, R2 stitching can't engage even with the flag on. Confirm before flipping R2_FIRST.

3. Frontend UK_AQ_CHART_TIMESERIES_PROXY_V2_ENABLED default
Both pages have it; what's the per-environment default and how does it get switched? If it's hardcoded in the HTML, you need a deploy to flip it. If it's read from a config endpoint or query string, it's per-load. Worth checking the parseBooleanFlag source on the frontend before declaring a rollout method.

4. Manifest/Index URLs — vestigial?
UK_AQ_TIMESERIES_R2_MANIFEST_URL and UK_AQ_TIMESERIES_R2_INDEX_URL are declared in wrangler.toml comments but the stitcher reads them only into runtime.r2ManifestUrl / runtime.r2IndexUrl and doesn't use them anywhere (R2 coverage comes from the R2 API's own coverage field on the observations payload). Decide:

Remove from config (cleaner) — they were placeholders for an unused alternate discovery path.
Or wire them up as backup discovery (more work; the plan's Phase 3 mentioned "fallback object discovery if manifest/index is unavailable").
I'd remove. Less surface area.

5. The old edge function — wrap or replace?
You said you thought the proxy was "replacing" /workspaces/uk-aq-ingest/supabase/functions/uk_aq_timeseries. It isn't — the proxy wraps it (calls it via fetchTimeseriesOriginPayload for the ingest tail). The edge function stays alive as the Supabase tail origin. That's the intended design per the plan's "Source of truth policy" section.

If you actually want to retire the edge function entirely, you'd need to teach the proxy to call the RPC uk_aq_rpc_observs_timeseries_window directly via PostgREST — that's a separate piece of work the plan doesn't cover. Probably fine to leave the edge function in place.

6. Where do canary results get viewed?
Plan's Phase 5 says: "Repeated chart opens hit Cloudflare cache instead of repeatedly hitting Supabase." How will you measure that? Options:

Cloudflare dashboard analytics for the worker
The existing UK_AQ_CHART_METRICS_RPC (already wired in the proxy at line 779+) — chart metrics get inserted to a Supabase table for dashboards
Manually curl and check cf-cache-status and X-UK-AQ-Cache headers
Pick before declaring success criteria. The metrics RPC path already exists — easiest to use.

Suggested next moves
Write the Prompt 5 report (10 minutes — it's just confirming an RPC exists).
Write the Prompt 6 checklist (markdown under system_docs/).
Confirm UK_AQ_OBSERVS_HISTORY_R2_API_URL is set in CIC-Test worker config.
Decide on the 4 flags + flip them in CIC-Test.
Run the canary checklist for the existing test timeseries (3742) on the 5 windows.
Decide what to do with the unused R2_MANIFEST_URL/R2_INDEX_URL env vars.
If you want me to do any of those, just say which.