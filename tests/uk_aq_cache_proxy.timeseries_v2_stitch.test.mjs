import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildMissingDaySlices,
  buildTimeseriesV2SupabaseFillPlan,
  classifyTimeseriesV2SourceRoute,
  computeCoverageFromRows,
  computeNextSince,
  detectGapRanges,
  mergeAndDedupeRows,
  resolveTimeseriesWindowBounds,
  subtractCoveredTailInterval,
} from "../workers/uk_aq_cache_proxy/src/timeseries_v2_stitch.mjs";

test("R2 fully current returns no ingest tail interval", () => {
  const requestStartMs = Date.parse("2026-05-09T00:00:00.000Z");
  const requestEndMs = Date.parse("2026-05-10T00:00:00.000Z");
  const { tailStartMs, tailEndMs } = subtractCoveredTailInterval(
    requestStartMs,
    requestEndMs,
    "2026-05-09T23:59:59.999Z",
  );
  assert.ok(tailStartMs >= tailEndMs);
});

test("R2 lagging by multiple days produces a positive tail interval", () => {
  const requestStartMs = Date.parse("2026-05-01T00:00:00.000Z");
  const requestEndMs = Date.parse("2026-05-15T00:00:00.000Z");
  const { tailStartMs, tailEndMs } = subtractCoveredTailInterval(
    requestStartMs,
    requestEndMs,
    "2026-05-09T23:00:00.000Z",
  );
  assert.equal(new Date(tailStartMs).toISOString(), "2026-05-09T23:00:00.001Z");
  assert.equal(new Date(tailEndMs).toISOString(), "2026-05-15T00:00:00.000Z");
});

test("missing day manifest keys become explicit day slices", () => {
  const slices = buildMissingDaySlices(
    [
      "history/v1/observations/day_utc=2026-05-11/manifest.json",
      "history/v1/observations/day_utc=2026-05-13/manifest.json",
    ],
    Date.parse("2026-05-10T12:00:00.000Z"),
    Date.parse("2026-05-14T12:00:00.000Z"),
  );
  assert.equal(slices.length, 2);
  assert.equal(new Date(slices[0].startMs).toISOString(), "2026-05-11T00:00:00.000Z");
  assert.equal(new Date(slices[1].endMs).toISOString(), "2026-05-14T00:00:00.000Z");
});

test("duplicate observed_at defaults to R2 precedence", () => {
  const r2Rows = [
    { observed_at: "2026-05-10T00:00:00.000Z", value: 12, source: "r2" },
  ];
  const ingestRows = [
    { observed_at: "2026-05-10T00:00:00.000Z", value: 14, source: "ingest" },
  ];
  const merged = mergeAndDedupeRows(r2Rows, ingestRows, false);
  assert.equal(merged.merged.length, 1);
  assert.equal(merged.merged[0].value, 12);
  assert.equal(merged.deduped, 1);
});

test("duplicate observed_at can be overwritten when allow flag is true", () => {
  const r2Rows = [
    { observed_at: "2026-05-10T00:00:00.000Z", value: 12, source: "r2" },
  ];
  const ingestRows = [
    { observed_at: "2026-05-10T00:00:00.000Z", value: 14, source: "ingest" },
  ];
  const merged = mergeAndDedupeRows(r2Rows, ingestRows, true);
  assert.equal(merged.merged.length, 1);
  assert.equal(merged.merged[0].value, 14);
  assert.equal(merged.deduped, 1);
});

test("gap detection catches middle hole", () => {
  const rows = [
    { observed_at: "2026-05-10T00:00:00.000Z", value: 1 },
    { observed_at: "2026-05-10T01:00:00.000Z", value: 2 },
    { observed_at: "2026-05-10T07:00:00.000Z", value: 3 },
    { observed_at: "2026-05-10T08:00:00.000Z", value: 4 },
  ];
  const result = detectGapRanges(
    rows,
    Date.parse("2026-05-10T00:00:00.000Z"),
    Date.parse("2026-05-10T09:00:00.000Z"),
    "24h",
  );
  assert.equal(result.hasGap, true);
  assert.equal(result.gapRanges.length >= 1, true);
});

test("gap detection with no rows is represented as full-window gap by caller policy", () => {
  const startMs = Date.parse("2026-05-18T13:40:07.157Z");
  const endMs = Date.parse("2026-05-19T13:40:07.157Z");
  const result = detectGapRanges([], startMs, endMs, "7d");
  assert.equal(result.hasGap, false);
  assert.equal(result.gapRanges.length, 0);
});

test("next_since is monotonic vs requested since", () => {
  const rows = [
    { observed_at: "2026-05-10T01:00:00.000Z", value: 1 },
    { observed_at: "2026-05-10T03:00:00.000Z", value: 2 },
  ];
  const nextSince = computeNextSince(rows, "2026-05-10T04:00:00.000Z");
  assert.equal(nextSince, "2026-05-10T04:00:00.000Z");
});

test("window bounds clamp explicit span to configured max days", () => {
  const nowMs = Date.parse("2026-05-15T00:00:00.000Z");
  const bounds = resolveTimeseriesWindowBounds({
    nowMs,
    windowLabel: "90d",
    startUtc: "2026-01-01T00:00:00.000Z",
    endUtc: "2026-05-15T00:00:00.000Z",
    maxWindowDays: 31,
  });
  assert.equal(bounds.mode, "explicit");
  assert.equal(new Date(bounds.endMs).toISOString(), "2026-05-15T00:00:00.000Z");
  assert.equal(new Date(bounds.startMs).toISOString(), "2026-04-14T00:00:00.000Z");
});

test("coverage from rows reports start/end", () => {
  const coverage = computeCoverageFromRows([
    { observed_at: "2026-05-10T01:00:00.000Z" },
    { observed_at: "2026-05-10T03:00:00.000Z" },
  ]);
  assert.equal(coverage.coverageStart, "2026-05-10T01:00:00.000Z");
  assert.equal(coverage.coverageEnd, "2026-05-10T03:00:00.000Z");
});

test("source routing classifies historical-only requests as R2-only", () => {
  const route = classifyTimeseriesV2SourceRoute({
    requestStartMs: Date.parse("2026-05-18T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-01T00:00:00.000Z"),
    recentBoundaryMs: Date.parse("2026-06-11T00:00:00.000Z"),
  });
  assert.equal(route.sourceMode, "history_only");
  assert.equal(route.usedR2, true);
  assert.equal(route.usedSupabase, false);
  assert.equal(route.ingestStartMs, null);
});

test("source routing keeps recent requests R2-first across the full range", () => {
  const route = classifyTimeseriesV2SourceRoute({
    requestStartMs: Date.parse("2026-06-12T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-18T00:00:00.000Z"),
    recentBoundaryMs: Date.parse("2026-06-11T00:00:00.000Z"),
  });
  assert.equal(route.sourceMode, "r2_first_full_range");
  assert.equal(route.usedR2, true);
  assert.equal(route.usedSupabase, false);
  assert.equal(route.r2StartMs, Date.parse("2026-06-12T00:00:00.000Z"));
  assert.equal(route.r2EndMs, Date.parse("2026-06-18T00:00:00.000Z"));
  assert.equal(route.ingestStartMs, null);
});

test("source routing keeps boundary-crossing requests R2-first across the full range", () => {
  const boundaryMs = Date.parse("2026-06-11T00:00:00.000Z");
  const route = classifyTimeseriesV2SourceRoute({
    requestStartMs: Date.parse("2026-06-01T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-18T00:00:00.000Z"),
    recentBoundaryMs: boundaryMs,
  });
  assert.equal(route.sourceMode, "r2_first_full_range");
  assert.equal(route.usedR2, true);
  assert.equal(route.usedSupabase, false);
  assert.equal(route.r2StartMs, Date.parse("2026-06-01T00:00:00.000Z"));
  assert.equal(route.r2EndMs, Date.parse("2026-06-18T00:00:00.000Z"));
  assert.equal(route.ingestStartMs, null);
});

test("recent range with R2 rows does not create a Supabase fill slice", () => {
  const plan = buildTimeseriesV2SupabaseFillPlan({
    requestStartMs: Date.parse("2026-06-22T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-23T00:00:00.000Z"),
    r2Rows: [
      { observed_at: "2026-06-22T00:00:00.000Z", value: 8 },
      { observed_at: "2026-06-22T23:59:59.999Z", value: 9 },
    ],
    r2Coverage: { response_complete: true },
    maxSupabaseTailHours: 168,
  });
  assert.equal(plan.ingestSlices.length, 0);
  assert.equal(plan.skippedIngestSlices.length, 0);
  assert.equal(plan.r2CoverageStart, "2026-06-22T00:00:00.000Z");
  assert.equal(plan.r2CoverageEnd, "2026-06-22T23:59:59.999Z");
});

test("recent range with no R2 rows falls back to Supabase for the request range", () => {
  const plan = buildTimeseriesV2SupabaseFillPlan({
    requestStartMs: Date.parse("2026-06-22T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-23T00:00:00.000Z"),
    r2Rows: [],
    r2Coverage: { response_complete: true },
    maxSupabaseTailHours: 168,
  });
  assert.equal(plan.ingestSlices.length, 1);
  assert.equal(new Date(plan.ingestSlices[0].startMs).toISOString(), "2026-06-22T00:00:00.000Z");
  assert.equal(new Date(plan.ingestSlices[0].endMs).toISOString(), "2026-06-23T00:00:00.000Z");
  assert.equal(plan.ingestSlices[0].reason, "r2_empty_window");
});

test("mixed range asks Supabase only for uncovered tail after R2 coverage", () => {
  const plan = buildTimeseriesV2SupabaseFillPlan({
    requestStartMs: Date.parse("2026-06-01T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-10T00:00:00.000Z"),
    r2Rows: [
      { observed_at: "2026-06-01T00:00:00.000Z", value: 1 },
      { observed_at: "2026-06-07T12:00:00.000Z", value: 2 },
    ],
    r2Coverage: { response_complete: true },
    maxSupabaseTailHours: 168,
  });
  assert.equal(plan.ingestSlices.length, 1);
  assert.equal(new Date(plan.ingestSlices[0].startMs).toISOString(), "2026-06-07T12:00:00.001Z");
  assert.equal(new Date(plan.ingestSlices[0].endMs).toISOString(), "2026-06-10T00:00:00.000Z");
  assert.equal(plan.ingestSlices[0].reason, "r2_uncovered_tail");
});

test("R2 missing diagnostics create Supabase repair slices inside the tail cap", () => {
  const plan = buildTimeseriesV2SupabaseFillPlan({
    requestStartMs: Date.parse("2026-06-20T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-24T00:00:00.000Z"),
    r2Rows: [
      { observed_at: "2026-06-20T00:00:00.000Z", value: 1 },
      { observed_at: "2026-06-23T23:59:59.999Z", value: 2 },
    ],
    r2Coverage: {
      missing_day_manifest_keys: [
        "history/v2/observations/day_utc=2026-06-22/manifest.json",
      ],
    },
    maxSupabaseTailHours: 168,
  });
  assert.equal(plan.ingestSlices.length, 1);
  assert.equal(new Date(plan.ingestSlices[0].startMs).toISOString(), "2026-06-22T00:00:00.000Z");
  assert.equal(new Date(plan.ingestSlices[0].endMs).toISOString(), "2026-06-23T00:00:00.000Z");
  assert.equal(plan.ingestSlices[0].reason, "missing_day_manifest");
});

test("missing diagnostic ranges outside the Supabase tail cap are reported as skipped", () => {
  const plan = buildTimeseriesV2SupabaseFillPlan({
    requestStartMs: Date.parse("2026-06-01T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-24T00:00:00.000Z"),
    r2Rows: [
      { observed_at: "2026-06-01T00:00:00.000Z", value: 1 },
      { observed_at: "2026-06-23T23:59:59.999Z", value: 2 },
    ],
    r2Coverage: {
      missing_day_manifest_keys: [
        "history/v2/observations/day_utc=2026-06-05/manifest.json",
      ],
    },
    maxSupabaseTailHours: 24,
  });
  assert.equal(plan.ingestSlices.length, 0);
  assert.equal(plan.skippedIngestSlices.length, 1);
  assert.equal(plan.skippedIngestSlices[0].start_utc, "2026-06-05T00:00:00.000Z");
  assert.equal(plan.skippedIngestSlices[0].end_utc, "2026-06-06T00:00:00.000Z");
  assert.equal(
    plan.skippedIngestSlices[0].reason,
    "missing_day_manifest_outside_supabase_tail_cap",
  );
});

test("cache proxy tries stable binding before Supabase connector lookup", () => {
  const source = fs.readFileSync("workers/uk_aq_cache_proxy/src/index.ts", "utf8");
  const bindingLookupPos = source.indexOf("stationHistoryObservations.loadTimeseriesBindingFromR2(");
  const supabaseLookupPos = source.indexOf("stationHistoryObservations.loadTimeseriesConnectorId(");
  const bindingCallPos = source.indexOf("r2TimeseriesBinding = await stationHistoryObservations.loadTimeseriesBindingFromR2(");
  const supabaseCallPos = source.indexOf("connectorId = await stationHistoryObservations.loadTimeseriesConnectorId(");
  assert.ok(bindingLookupPos > 0);
  assert.ok(supabaseLookupPos > 0);
  assert.ok(bindingCallPos > 0);
  assert.ok(supabaseCallPos > 0);
  assert.ok(bindingCallPos < supabaseCallPos);
  assert.equal(source.includes("/v1/timeseries-metadata"), false);
});

test("cache proxy keeps origin-only wrapper before R2 stitch when R2-first is disabled or unconfigured", () => {
  const source = fs.readFileSync("workers/uk_aq_cache_proxy/src/index.ts", "utf8");
  const guardPos = source.indexOf("if (!flags.r2First || !deps.r2HistoryApiUrl)");
  const originFetchPos = source.indexOf(
    "const originPayload = await stationHistoryObservations.fetchTimeseriesOriginPayload(",
    guardPos,
  );
  const r2FetchPos = source.indexOf("const r2Result = await stationHistoryObservations.fetchR2ObservationsPaged(");
  assert.ok(guardPos > 0);
  assert.ok(originFetchPos > guardPos);
  assert.ok(r2FetchPos > originFetchPos);
});
