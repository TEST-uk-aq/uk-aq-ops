import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildMissingDaySlices,
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

test("source routing classifies recent-only requests as Supabase-only", () => {
  const route = classifyTimeseriesV2SourceRoute({
    requestStartMs: Date.parse("2026-06-12T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-18T00:00:00.000Z"),
    recentBoundaryMs: Date.parse("2026-06-11T00:00:00.000Z"),
  });
  assert.equal(route.sourceMode, "recent_only");
  assert.equal(route.usedR2, false);
  assert.equal(route.usedSupabase, true);
  assert.equal(route.r2StartMs, null);
});

test("source routing classifies boundary-crossing requests as stitched", () => {
  const boundaryMs = Date.parse("2026-06-11T00:00:00.000Z");
  const route = classifyTimeseriesV2SourceRoute({
    requestStartMs: Date.parse("2026-06-01T00:00:00.000Z"),
    requestEndMs: Date.parse("2026-06-18T00:00:00.000Z"),
    recentBoundaryMs: boundaryMs,
  });
  assert.equal(route.sourceMode, "recent_history_stitched");
  assert.equal(route.usedR2, true);
  assert.equal(route.usedSupabase, true);
  assert.equal(route.r2EndMs, boundaryMs);
  assert.equal(route.ingestStartMs, boundaryMs);
});

test("cache proxy tries R2 timeseries metadata before Supabase connector lookup", () => {
  const source = fs.readFileSync("workers/uk_aq_cache_proxy/src/index.ts", "utf8");
  const r2LookupPos = source.indexOf("loadTimeseriesMetadataFromR2(");
  const supabaseLookupPos = source.indexOf("loadTimeseriesConnectorId(");
  const r2CallPos = source.indexOf("r2TimeseriesMetadata = await loadTimeseriesMetadataFromR2(");
  const supabaseCallPos = source.indexOf("connectorId = await loadTimeseriesConnectorId(");
  assert.ok(r2LookupPos > 0);
  assert.ok(supabaseLookupPos > 0);
  assert.ok(r2CallPos > 0);
  assert.ok(supabaseCallPos > 0);
  assert.ok(r2CallPos < supabaseCallPos);
});
