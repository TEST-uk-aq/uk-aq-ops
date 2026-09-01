#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildCalculatedHistory } from "../../workers/uk_aq_station_history/src/calculated_history.mjs";
import {
  buildV3ContinuationPage,
  decodeStationHistoryContinuation,
  StationHistoryContinuationError,
} from "../../workers/uk_aq_station_history/src/v3_continuation.mjs";

const HOUR_MS = 60 * 60 * 1000;
const PAGE_ROWS = 17;
const IDENTITY = Object.freeze({
  timeseriesId: 7421,
  connectorId: 7,
  stationId: 9001,
  pollutant: "pm25",
});
const OUTPUT_START = Date.parse("2026-04-03T00:00:00.000Z");
const OUTPUT_END = Date.parse("2026-04-04T00:00:00.000Z");
const SOURCE_START = OUTPUT_START - 23 * HOUR_MS;
const SOURCE_END_EXCLUSIVE = OUTPUT_END + 1;

function buildSourceRows() {
  const rows = [];
  for (let cursor = SOURCE_START; cursor < SOURCE_END_EXCLUSIVE; cursor += 5 * 60 * 1000) {
    rows.push({ observed_at: new Date(cursor).toISOString(), value: 8 + ((cursor / (5 * 60 * 1000)) % 29) / 10 });
  }
  const duplicate = rows.find((row) => row.observed_at === "2026-04-03T05:00:00.000Z");
  rows.splice(rows.indexOf(duplicate) + 1, 0, { ...duplicate });
  return rows;
}

const SOURCE_ROWS = buildSourceRows();
const exactContinuity = Object.freeze({
  enabled: false,
  continuityKey: null,
  siteRef: null,
  ukAirRef: null,
  pollutant: IDENTITY.pollutant,
  members: [Object.freeze({
    stationId: IDENTITY.stationId,
    stationRef: null,
    timeseriesId: IDENTITY.timeseriesId,
    timeseriesRef: null,
    connectorId: IDENTITY.connectorId,
    pollutant: IDENTITY.pollutant,
    validFromDayUtc: null,
    validToDayUtc: null,
  })],
});

function bindingPayload() {
  return {
    binding: {
      schema_version: 1,
      history_version: "v2",
      index_kind: "timeseries_binding",
      timeseries_id: IDENTITY.timeseriesId,
      connector_id: IDENTITY.connectorId,
      station_id: IDENTITY.stationId,
      pollutant_code: IDENTITY.pollutant,
    },
  };
}

function cursorFor(startUtc, endUtc, pageIndex) {
  return Buffer.from(JSON.stringify({ startUtc, endUtc, pageIndex }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMockFetch(state) {
  return async function mockFetch(input) {
    const url = new URL(String(input));
    if (url.pathname === "/v1/timeseries-binding") return json(bindingPayload());
    assert.equal(url.pathname, "/v1/observations");
    assert.equal(url.searchParams.has("since_utc"), false);
    const referenceRead = url.searchParams.has("limit");
    if (!referenceRead) assert.equal(url.searchParams.has("limit"), false);
    const startUtc = new Date(url.searchParams.get("start_utc")).toISOString();
    const endUtc = new Date(url.searchParams.get("end_utc")).toISOString();
    const startMs = Date.parse(startUtc);
    const endMs = Date.parse(endUtc);
    assert.ok(endMs > startMs);
    if (!referenceRead) assert.ok(endMs - startMs <= 24 * HOUR_MS);
    state.lowLevelRanges.push([startUtc, endUtc]);
    const selected = SOURCE_ROWS.filter((row) => {
      const observedMs = Date.parse(row.observed_at);
      return observedMs >= startMs && observedMs < endMs;
    });
    if (referenceRead) {
      return json({
        ok: true,
        timeseries_id: IDENTITY.timeseriesId,
        connector_id: IDENTITY.connectorId,
        pollutant: IDENTITY.pollutant,
        start_utc: startUtc,
        end_utc: endUtc,
        response_complete: true,
        has_gap: false,
        coverage_state: "complete",
        partial_reasons: [],
        rows: selected,
      });
    }
    const supplied = url.searchParams.get("physical_cursor");
    const decoded = supplied ? decodeCursor(supplied) : { startUtc, endUtc, pageIndex: 0 };
    assert.deepEqual([decoded.startUtc, decoded.endUtc], [startUtc, endUtc]);
    const pageIndex = decoded.pageIndex;
    const rows = selected.slice(pageIndex * PAGE_ROWS, (pageIndex + 1) * PAGE_ROWS);
    const paginationComplete = (pageIndex + 1) * PAGE_ROWS >= selected.length;
    let nextCursor = paginationComplete ? null : cursorFor(startUtc, endUtc, pageIndex + 1);
    if (state.returnCursorLoop && supplied) nextCursor = supplied;
    state.leafFetchCount += 1;
    return json({
      ok: true,
      timeseries_id: IDENTITY.timeseriesId,
      connector_id: IDENTITY.connectorId,
      pollutant: IDENTITY.pollutant,
      start_utc: startUtc,
      end_utc: endUtc,
      response_complete: paginationComplete && !state.genuineGap,
      has_gap: state.genuineGap,
      coverage_state: state.genuineGap ? "partial" : "complete",
      coverage_partial_reasons: state.genuineGap ? ["mock_missing_scope"] : [],
      partial_reasons: [
        ...(state.genuineGap ? ["mock_missing_scope"] : []),
        ...(paginationComplete ? [] : ["physical_pagination_incomplete"]),
      ],
      physical_page: {
        schema_version: 2,
        page_number: pageIndex + 1,
        continuation_cursor_supplied: Boolean(supplied),
        physical_page_path: supplied ? "direct_leaf_continuation" : "initial_discovery",
        candidate_intersecting_segments: Math.ceil(selected.length / PAGE_ROWS),
        segments_decoded: selected.length ? 1 : 0,
        physical_rows_decoded: rows.length,
        pagination_complete: paginationComplete,
        next_cursor: nextCursor,
      },
      rows,
    });
  };
}

function environment(cap) {
  return {
    UK_AQ_STATION_HISTORY_V3_PHYSICAL_PAGE_CAP: String(cap),
    UK_AQ_EDGE_UPSTREAM_SECRET: "local-station-history-continuation-secret",
    UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://uk-aq-observations-v3-leaf-candidate.example.test",
    UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED: "false",
    UK_AQ_STATION_HISTORY_OBSERVATION_CHUNK_MAX_HOURS: String(7 * 24),
  };
}

function requestUrl(continuation = null, overrides = {}) {
  const url = new URL("https://station-history-v3-candidate.example.test/v1/observations-history");
  for (const [name, value] of Object.entries({
    timeseries_id: IDENTITY.timeseriesId,
    connector_id: IDENTITY.connectorId,
    pollutant: IDENTITY.pollutant,
    start_utc: new Date(OUTPUT_START).toISOString(),
    end_utc: new Date(OUTPUT_END).toISOString(),
    stable_head_start_utc: new Date(OUTPUT_END).toISOString(),
    format: "objects",
    include_observations: "true",
    include_aqi: "true",
    limit: "5000",
    ...overrides,
  })) url.searchParams.set(name, String(value));
  if (continuation) url.searchParams.set("station_history_continuation", continuation);
  return url;
}

async function collect(cap, mockState = {}) {
  const state = {
    leafFetchCount: 0,
    lowLevelRanges: [],
    genuineGap: false,
    returnCursorLoop: false,
    ...mockState,
  };
  const mockFetch = createMockFetch(state);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  const observations = [];
  const aqi = [];
  const responses = [];
  let continuation = null;
  try {
    do {
      const built = await buildV3ContinuationPage({
        request: new Request(requestUrl(continuation)),
        env: environment(cap),
        fetchApi: mockFetch,
        nowMs: Date.parse("2026-09-01T00:00:00.000Z"),
      });
      responses.push(built);
      assert.ok(built.body.station_history_page.physical_pages_consumed <= cap);
      assert.equal(built.body.has_gap, state.genuineGap);
      if (built.body.station_history_continuation) {
        assert.equal(built.body.response_complete, false);
        assert.equal(built.body.station_history_page.work_exhausted_without_gap, !state.genuineGap);
      }
      observations.push(...built.body.observations.rows);
      aqi.push(...built.body.aqi.rows);
      continuation = built.body.station_history_continuation;
    } while (continuation);
  } finally {
    globalThis.fetch = previousFetch;
  }
  return { state, responses, observations, aqi };
}

function rowsSha256(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function referenceAqi() {
  const state = { leafFetchCount: 0, lowLevelRanges: [], genuineGap: false, returnCursorLoop: false };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(state);
  try {
    const result = await buildCalculatedHistory({
      request: { ...IDENTITY, includeObservations: true, includeAqi: true },
      continuity: exactContinuity,
      env: environment(8),
      outputStartMs: OUTPUT_START,
      outputEndMs: OUTPUT_END,
    });
    return result.aqi.rows;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function expectContinuationError(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof StationHistoryContinuationError);
    assert.equal(error.code, code);
    return true;
  });
}

async function main() {
  const expectedObservations = SOURCE_ROWS.filter((row) => {
    const observedMs = Date.parse(row.observed_at);
    return observedMs >= OUTPUT_START && observedMs <= OUTPUT_END;
  }).map((row) => ({
    connector_id: IDENTITY.connectorId,
    station_id: IDENTITY.stationId,
    timeseries_id: IDENTITY.timeseriesId,
    pollutant_code: IDENTITY.pollutant,
    observed_at: row.observed_at,
    value: row.value,
    source: "r2",
  }));
  const expectedAqi = await referenceAqi();
  const results = [];
  for (const cap of [1, 2, 4, 8]) {
    const collected = await collect(cap);
    assert.deepEqual(collected.observations, expectedObservations);
    assert.deepEqual(collected.aqi, expectedAqi);
    assert.equal(collected.responses.at(-1).body.response_complete, true);
    assert.equal(collected.responses.at(-1).body.has_gap, false);
    assert.equal(collected.responses.slice(0, -1).every((entry) => entry.body.has_gap === false), true);
    assert.equal(collected.state.lowLevelRanges.every(([start, end]) => Date.parse(end) - Date.parse(start) <= 24 * HOUR_MS), true);
    results.push({
      cap,
      station_invocations: collected.responses.length,
      leaf_fetches: collected.state.leafFetchCount,
      observation_rows: collected.observations.length,
      aqi_rows: collected.aqi.length,
      observations_sha256: rowsSha256(collected.observations),
      aqi_sha256: rowsSha256(collected.aqi),
      maximum_pages_in_one_invocation: Math.max(...collected.responses.map((entry) => entry.body.station_history_page.physical_pages_consumed)),
    });
  }

  const deterministicState = { leafFetchCount: 0, lowLevelRanges: [], genuineGap: false, returnCursorLoop: false };
  const deterministicFetch = createMockFetch(deterministicState);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = deterministicFetch;
  let first;
  let repeated;
  try {
    first = await buildV3ContinuationPage({ request: new Request(requestUrl()), env: environment(1), fetchApi: deterministicFetch });
    repeated = await buildV3ContinuationPage({ request: new Request(requestUrl()), env: environment(1), fetchApi: deterministicFetch });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(first.body.station_history_continuation, repeated.body.station_history_continuation);
  const decoded = await decodeStationHistoryContinuation(
    first.body.station_history_continuation,
    environment(1).UK_AQ_EDGE_UPSTREAM_SECRET,
  );
  assert.equal(decoded.q.x, "station-history-v3-continuation-experiment-v1");
  const corrupted = `${first.body.station_history_continuation.slice(0, -1)}${first.body.station_history_continuation.endsWith("A") ? "B" : "A"}`;
  await expectContinuationError(
    () => decodeStationHistoryContinuation(corrupted, environment(1).UK_AQ_EDGE_UPSTREAM_SECRET),
    "station_history_continuation_invalid",
  );

  const conflictState = { leafFetchCount: 0, lowLevelRanges: [], genuineGap: false, returnCursorLoop: false };
  const conflictFetch = createMockFetch(conflictState);
  globalThis.fetch = conflictFetch;
  try {
    await expectContinuationError(
      () => buildV3ContinuationPage({
        request: new Request(requestUrl(first.body.station_history_continuation, { end_utc: "2026-04-03T23:00:00.000Z" })),
        env: environment(1),
        fetchApi: conflictFetch,
      }),
      "station_history_continuation_identity_contradiction",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  const gap = await collect(8, { genuineGap: true });
  assert.equal(gap.responses.at(-1).body.has_gap, true);
  assert.ok(gap.responses.at(-1).body.partial_reasons.includes("mock_missing_scope"));

  const loopState = { leafFetchCount: 0, lowLevelRanges: [], genuineGap: false, returnCursorLoop: true };
  const loopFetch = createMockFetch(loopState);
  globalThis.fetch = loopFetch;
  try {
    const initial = await buildV3ContinuationPage({ request: new Request(requestUrl()), env: environment(1), fetchApi: loopFetch });
    await expectContinuationError(
      () => buildV3ContinuationPage({ request: new Request(requestUrl(initial.body.station_history_continuation)), env: environment(1), fetchApi: loopFetch }),
      "station_history_v3_leaf_cursor_loop",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  console.log(JSON.stringify({
    ok: true,
    fixture: {
      output_start_utc: new Date(OUTPUT_START).toISOString(),
      output_end_utc: new Date(OUTPUT_END).toISOString(),
      hidden_context_hours: 23,
      source_rows: SOURCE_ROWS.length,
      equal_timestamp_rows_preserved: expectedObservations.filter((row) => row.observed_at === "2026-04-03T05:00:00.000Z").length,
    },
    results,
    pm_aqi_equal_to_existing_calculated_history: true,
    deterministic_continuation_token: true,
    authenticated_envelope_tamper_rejected: true,
    cross_request_replay_rejected: true,
    physical_cursor_loop_rejected: true,
    physical_pagination_not_reported_as_gap: true,
    work_budget_exhaustion_not_reported_as_gap: true,
    genuine_gap_propagated: true,
    maximum_low_level_logical_range_hours: 24,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
