import {
  AQI_ALGORITHM_VERSION,
  helperRowsToNormalizedAqiV1Rows,
  pivotNarrowRowsToHelperRows,
} from "../../../lib/aqi/aqi_levels.mjs";
import { publicContinuity, resolveTimeseriesBinding, selectContinuitySegments } from "./continuity.mjs";
import { parseHistoryChunkRequest } from "./history_chunks.mjs";
import { resolveStationHistoryPolicy } from "./policy.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const CONTINUATION_CONTRACT = "station-history-v3-continuation-experiment-v1";
const CONTINUATION_KIND = "uk_aq_station_history_continuation";
const CONTINUATION_SCHEMA_VERSION = 1;
const MAX_PHYSICAL_PAGES = 40;
const MAX_TOKEN_CHARACTERS = 12_000;
const WORK_REMAINING_REASON = "station_history_work_remaining";

function required(value) { return String(value ?? "").trim(); }
function positiveInt(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isInteger(number) && number > 0 ? number : null;
}
function boolFlag(value) {
  const text = required(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}
function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].sort();
}
function uniqueNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function utf8(value) { return new TextEncoder().encode(value); }
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new StationHistoryContinuationError(400, "station_history_continuation_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function continuationKeys(secret) {
  const material = new Uint8Array(await crypto.subtle.digest(
    "SHA-512",
    utf8(`uk-aq-station-history-continuation-v1\0${secret}`),
  ));
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    material.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const nonceKey = await crypto.subtle.importKey(
    "raw",
    material.slice(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { encryptionKey, nonceKey };
}

export class StationHistoryContinuationError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "StationHistoryContinuationError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) { throw new StationHistoryContinuationError(status, code); }

export function resolvePhysicalPageCap(env = {}) {
  const cap = positiveInt(env.UK_AQ_STATION_HISTORY_V3_PHYSICAL_PAGE_CAP);
  if (!cap || cap > MAX_PHYSICAL_PAGES) fail(500, "station_history_v3_physical_page_cap_invalid");
  return cap;
}

function exactContinuity(identity) {
  return {
    enabled: false,
    continuityKey: null,
    siteRef: null,
    ukAirRef: null,
    pollutant: identity.pollutant,
    members: [{
      stationId: identity.stationId,
      stationRef: null,
      timeseriesId: identity.timeseriesId,
      timeseriesRef: null,
      connectorId: identity.connectorId,
      pollutant: identity.pollutant,
      validFromDayUtc: null,
      validToDayUtc: null,
    }],
  };
}

function identityForSegment(segment) {
  return {
    timeseriesId: segment.timeseriesId,
    connectorId: segment.connectorId,
    stationId: segment.stationId,
    pollutant: segment.pollutant,
  };
}

function requestIdentity(chunk) {
  return {
    timeseriesId: chunk.timeseriesId,
    connectorId: chunk.connectorId,
    pollutant: chunk.pollutant,
  };
}

function requestTokenBinding(chunk) {
  return {
    t: chunk.timeseriesId,
    c: chunk.connectorId,
    p: chunk.pollutant,
    s: chunk.startUtc,
    e: chunk.endUtc,
    h: chunk.stableHeadStartUtc,
    o: chunk.includeObservations === true,
    a: chunk.includeAqi === true,
    x: CONTINUATION_CONTRACT,
  };
}

function sameTokenBinding(left, right) {
  return stableJson(left) === stableJson(right);
}

async function bindingFingerprint(identity, continuity) {
  return sha256Hex(stableJson({
    identity: {
      timeseries_id: identity.timeseriesId,
      station_id: identity.stationId,
      connector_id: identity.connectorId,
      pollutant: identity.pollutant,
    },
    continuity: publicContinuity(continuity),
  }));
}

export async function encodeStationHistoryContinuation(payload, secret) {
  if (!required(secret)) fail(500, "station_history_continuation_secret_missing");
  const payloadBytes = utf8(stableJson(payload));
  const keys = await continuationKeys(secret);
  const nonceDigest = new Uint8Array(await crypto.subtle.sign("HMAC", keys.nonceKey, payloadBytes));
  const nonce = nonceDigest.slice(0, 12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8(CONTINUATION_KIND) },
    keys.encryptionKey,
    payloadBytes,
  );
  const token = `v1.${base64UrlEncode(nonce)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
  if (token.length > MAX_TOKEN_CHARACTERS) fail(500, "station_history_continuation_too_large");
  return token;
}

export async function decodeStationHistoryContinuation(token, secret) {
  const value = required(token);
  if (!value || value.length > MAX_TOKEN_CHARACTERS) fail(400, "station_history_continuation_invalid");
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") fail(400, "station_history_continuation_invalid");
  let payloadBytes;
  try {
    const nonce = base64UrlDecode(parts[1]);
    const keys = await continuationKeys(secret);
    if (nonce.length !== 12) fail(400, "station_history_continuation_invalid");
    payloadBytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(CONTINUATION_KIND) },
      keys.encryptionKey,
      base64UrlDecode(parts[2]),
    ));
    const expectedNonce = new Uint8Array(
      await crypto.subtle.sign("HMAC", keys.nonceKey, payloadBytes),
    );
    let mismatch = 0;
    for (let index = 0; index < nonce.length; index += 1) mismatch |= nonce[index] ^ expectedNonce[index];
    if (mismatch !== 0) fail(400, "station_history_continuation_invalid");
  } catch {
    fail(400, "station_history_continuation_invalid");
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); }
  catch { fail(400, "station_history_continuation_invalid"); }
  if (
    payload?.v !== CONTINUATION_SCHEMA_VERSION
    || payload?.k !== CONTINUATION_KIND
    || payload?.q?.x !== CONTINUATION_CONTRACT
    || !payload?.f
    || !payload?.w
  ) fail(400, "station_history_continuation_invalid");
  return payload;
}

export function buildLogicalSourcePlan(chunk, continuity) {
  const contextHours = chunk.includeAqi && ["pm25", "pm10"].includes(chunk.pollutant) ? 23 : 0;
  const sourceStartMs = chunk.startMs - contextHours * HOUR_MS;
  const sourceEndMs = chunk.includeAqi ? chunk.endMs + 1 : chunk.endMs;
  const selection = selectContinuitySegments(continuity, sourceStartMs, sourceEndMs);
  const slices = [];
  for (const segment of selection.segments) {
    let cursor = segment.startMs;
    while (cursor < segment.endMs) {
      const endMs = Math.min(segment.endMs, cursor + DAY_MS);
      if (endMs <= cursor || endMs - cursor > DAY_MS) fail(500, "station_history_v3_logical_plan_invalid");
      slices.push({ ...identityForSegment(segment), startMs: cursor, endMs });
      cursor = endMs;
    }
  }
  slices.sort((left, right) => left.startMs - right.startMs || left.timeseriesId - right.timeseriesId);
  return { contextHours, sourceStartMs, sourceEndMs, selection, slices };
}

function newWorkState() {
  return {
    i: 0,
    c: null,
    e: 1,
    n: 0,
    h: [],
    o: null,
    d: null,
    vh: [],
    ah: [],
    ai: false,
    g: false,
    gr: [],
  };
}

function validateCompactAggregate(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const endpointMs = Number(value[0]);
  const sum = Number(value[1]);
  const count = Number(value[2]);
  return Number.isFinite(endpointMs) && Number.isFinite(sum) && Number.isInteger(count) && count > 0
    ? [endpointMs, sum, count]
    : null;
}

function validateWorkState(raw, plan) {
  const state = raw && typeof raw === "object" ? raw : null;
  if (!state) fail(400, "station_history_continuation_state_invalid");
  const sliceIndex = Number(state.i);
  const expectedPage = Number(state.e);
  const continuationNumber = Number(state.n);
  if (
    !Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex > plan.slices.length
    || !Number.isInteger(expectedPage) || expectedPage < 1
    || !Number.isInteger(continuationNumber) || continuationNumber < 0
    || (state.c !== null && (typeof state.c !== "string" || !state.c))
  ) fail(400, "station_history_continuation_state_invalid");
  const history = (Array.isArray(state.h) ? state.h : []).map(validateCompactAggregate);
  const open = state.o === null ? null : validateCompactAggregate(state.o);
  const dedupe = state.d === null ? null : (
    Array.isArray(state.d)
    && state.d.length === 3
    && Number.isFinite(Number(state.d[0]))
    && Number.isFinite(Number(state.d[1]))
    && positiveInt(state.d[2])
      ? [Number(state.d[0]), Number(state.d[1]), Number(state.d[2])]
      : null
  );
  if (history.some((entry) => entry === null) || (state.o !== null && !open) || (state.d !== null && !dedupe) || history.length > 24) {
    fail(400, "station_history_continuation_state_invalid");
  }
  return {
    i: sliceIndex,
    c: state.c,
    e: expectedPage,
    n: continuationNumber,
    h: history,
    o: open,
    d: dedupe,
    vh: uniqueNumbers(state.vh),
    ah: uniqueNumbers(state.ah),
    ai: state.ai === true,
    g: state.g === true,
    gr: uniqueStrings(state.gr),
  };
}

function leafUrl(env, slice, cursor) {
  const base = required(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
  if (!base) fail(500, "station_history_v3_leaf_url_missing");
  const url = new URL(base);
  url.pathname = "/v1/observations";
  url.search = "";
  url.searchParams.set("scope", "timeseries");
  url.searchParams.set("format", "objects");
  url.searchParams.set("timeseries_id", String(slice.timeseriesId));
  url.searchParams.set("connector_id", String(slice.connectorId));
  url.searchParams.set("pollutant", slice.pollutant);
  url.searchParams.set("start_utc", new Date(slice.startMs).toISOString());
  url.searchParams.set("end_utc", new Date(slice.endMs).toISOString());
  if (cursor) url.searchParams.set("physical_cursor", cursor);
  return url;
}

function normalizeLeafPage(payload, slice, state) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) fail(502, "station_history_v3_leaf_response_invalid");
  for (const [actual, expected] of [
    [Number(payload.timeseries_id), slice.timeseriesId],
    [Number(payload.connector_id), slice.connectorId],
    [required(payload.pollutant), slice.pollutant],
    [required(payload.start_utc), new Date(slice.startMs).toISOString()],
    [required(payload.end_utc), new Date(slice.endMs).toISOString()],
  ]) if (actual !== expected) fail(502, "station_history_v3_leaf_identity_contradiction");
  const physical = payload.physical_page;
  if (
    physical?.schema_version !== 2
    || physical.page_number !== state.e
    || physical.continuation_cursor_supplied !== Boolean(state.c)
    || physical.segments_decoded < 0
    || physical.segments_decoded > 1
  ) fail(502, "station_history_v3_leaf_page_contradiction");
  const paginationComplete = physical.pagination_complete === true;
  if (paginationComplete !== (physical.next_cursor === null)) fail(502, "station_history_v3_leaf_page_contradiction");
  if (!paginationComplete && (typeof physical.next_cursor !== "string" || !physical.next_cursor || physical.next_cursor === state.c)) {
    fail(502, "station_history_v3_leaf_cursor_loop");
  }
  if (payload.response_complete === true && (!paginationComplete || payload.has_gap === true)) {
    fail(502, "station_history_v3_leaf_completeness_contradiction");
  }
  const rows = [];
  let previousMs = null;
  for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
    const observedMs = Date.parse(String(row?.observed_at ?? row?.observed_at_utc ?? ""));
    const value = Number(row?.value);
    if (!Number.isFinite(observedMs) || observedMs < slice.startMs || observedMs >= slice.endMs || !Number.isFinite(value) || value < 0) {
      fail(502, "station_history_v3_leaf_row_invalid");
    }
    if (previousMs !== null && observedMs < previousMs) fail(502, "station_history_v3_leaf_row_order_invalid");
    previousMs = observedMs;
    rows.push({ observedMs, value });
  }
  return { payload, physical, paginationComplete, rows };
}

function memberAt(continuity, timestampMs) {
  const selected = selectContinuitySegments(continuity, timestampMs, timestampMs + 1).segments;
  return selected.length === 1 ? selected[0] : null;
}

function aggregateToNarrow(aggregate, chunk) {
  return {
    timeseries_id: chunk.timeseriesId,
    station_id: chunk.stationId,
    connector_id: chunk.connectorId,
    pollutant_code: chunk.pollutant,
    timestamp_hour_utc: new Date(aggregate[0]).toISOString(),
    hourly_mean_ugm3: aggregate[1] / aggregate[2],
    sample_count: aggregate[2],
  };
}

function calculateNewAqiRows(state, chunk, continuity, outputRows) {
  if (!chunk.includeAqi || !state.h.length) return;
  const already = new Set(state.ah);
  const helperRows = pivotNarrowRowsToHelperRows(
    state.h.map((aggregate) => aggregateToNarrow(aggregate, chunk)),
  );
  for (const row of helperRowsToNormalizedAqiV1Rows(helperRows, { computedAtUtc: null })) {
    const endpointMs = Date.parse(row.timestamp_hour_utc);
    if (
      !Number.isFinite(endpointMs)
      || endpointMs <= chunk.startMs
      || endpointMs > chunk.endMs
      || already.has(endpointMs)
    ) continue;
    const physical = memberAt(continuity, endpointMs - 1);
    if (!physical) fail(502, "station_history_continuity_aqi_identity_missing");
    const normalized = {
      ...row,
      connector_id: physical.connectorId,
      station_id: physical.stationId,
      timeseries_id: physical.timeseriesId,
      period_start_utc: new Date(endpointMs - HOUR_MS).toISOString(),
      period_end_utc: new Date(endpointMs).toISOString(),
      timestamp_hour_utc: new Date(endpointMs).toISOString(),
      source: "calculated_from_observations",
    };
    if (normalized.daqi_calculation_status !== "ok" || normalized.eaqi_calculation_status !== "ok") state.ai = true;
    outputRows.push(normalized);
    state.ah.push(endpointMs);
    already.add(endpointMs);
  }
  state.ah = uniqueNumbers(state.ah);
}

function finalizeOpenAggregate(state, chunk, continuity, aqiRows) {
  if (!state.o) return;
  state.h.push(state.o);
  const endpointMs = state.o[0];
  state.h = state.h
    .filter((aggregate) => aggregate[0] >= endpointMs - 23 * HOUR_MS)
    .sort((left, right) => left[0] - right[0]);
  state.o = null;
  calculateNewAqiRows(state, chunk, continuity, aqiRows);
}

function consumeSourceRow(state, chunk, continuity, row, observationRows, aqiRows) {
  const physical = memberAt(continuity, row.observedMs);
  if (!physical) fail(502, "station_history_continuity_observation_identity_missing");
  if (state.d && row.observedMs < state.d[0]) fail(502, "station_history_v3_cross_page_row_order_invalid");
  const duplicateForCalculation = state.d && row.observedMs === state.d[0];
  if (duplicateForCalculation && (row.value !== state.d[1] || physical.timeseriesId !== state.d[2])) {
    fail(502, "station_history_continuity_observation_conflict");
  }
  if (!duplicateForCalculation) {
    const endpointMs = Math.ceil(row.observedMs / HOUR_MS) * HOUR_MS;
    if (state.o && endpointMs < state.o[0]) fail(502, "station_history_v3_cross_page_row_order_invalid");
    if (state.o && endpointMs > state.o[0]) finalizeOpenAggregate(state, chunk, continuity, aqiRows);
    if (!state.o) state.o = [endpointMs, 0, 0];
    state.o[1] += row.value;
    state.o[2] += 1;
    state.d = [row.observedMs, row.value, physical.timeseriesId];
  }
  if (row.observedMs >= chunk.startMs && row.observedMs <= chunk.endMs) {
    observationRows.push({
      connector_id: physical.connectorId,
      station_id: physical.stationId,
      timeseries_id: physical.timeseriesId,
      pollutant_code: physical.pollutant,
      observed_at: new Date(row.observedMs).toISOString(),
      value: row.value,
      source: "r2",
    });
    state.vh.push(Math.floor(row.observedMs / HOUR_MS) * HOUR_MS + HOUR_MS);
  }
}

function expectedHourEndpoints(startMs, endMs) {
  const values = [];
  let cursor = Math.floor(startMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (; cursor <= endMs; cursor += HOUR_MS) values.push(cursor);
  return values;
}

function missingRanges(expected, present) {
  return expected.filter((value) => !present.has(value)).map((value) => ({
    start_utc: new Date(value - HOUR_MS).toISOString(),
    end_utc: new Date(value).toISOString(),
  }));
}

function responseRequest(chunk) {
  return {
    connector_id: chunk.connectorId,
    requested_timeseries_id: chunk.timeseriesId,
    station_id: chunk.stationId,
    pollutant: chunk.pollutant,
    start_utc: chunk.startUtc,
    end_utc: chunk.endUtc,
    include_observations: chunk.includeObservations,
    include_aqi: chunk.includeAqi,
  };
}

function chunkResponse(chunk, continuationReturned) {
  return {
    direction: "newest_first",
    row_order: "ascending",
    start_utc: chunk.startUtc,
    end_utc: chunk.endUtc,
    stable_head_start_utc: chunk.stableHeadStartUtc,
    next_older_chunk_end_utc: continuationReturned ? null : chunk.startUtc,
    replacement_policy: "extend_backwards_only",
    cache_class: "immutable",
    retry_key: `v3-continuation|${chunk.timeseriesId}|${chunk.connectorId}|${chunk.pollutant}|${chunk.startUtc}|${chunk.endUtc}|obs:${chunk.includeObservations}|aqi:${chunk.includeAqi}`,
  };
}

function compactTokenPayload(chunk, fingerprint, state) {
  return {
    v: CONTINUATION_SCHEMA_VERSION,
    k: CONTINUATION_KIND,
    q: requestTokenBinding(chunk),
    f: fingerprint,
    w: state,
  };
}

export function parseV3ContinuationRequest(url, env = {}) {
  const parsed = parseHistoryChunkRequest(url, "observations", resolveStationHistoryPolicy(env));
  if (!parsed.ok) fail(parsed.code === "history_chunk_overlaps_stable_head" ? 409 : 400, parsed.code);
  if (parsed.format !== "objects") fail(400, "station_history_v3_format_objects_required");
  return parsed;
}

export async function buildV3ContinuationPage({ request, env, fetchApi = fetch, nowMs = Date.now() } = {}) {
  const url = new URL(request.url);
  const chunk = parseV3ContinuationRequest(url, env);
  const cap = resolvePhysicalPageCap(env);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!secret) fail(500, "station_history_continuation_secret_missing");
  const bindingContext = await resolveTimeseriesBinding(requestIdentity(chunk), env);
  chunk.stationId = bindingContext.identity.stationId;
  const continuity = boolFlag(env.UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED)
    ? bindingContext.continuity
    : exactContinuity(bindingContext.identity);
  const plan = buildLogicalSourcePlan(chunk, continuity);
  if (!plan.slices.length) fail(502, "station_history_continuity_member_missing");
  const fingerprint = await bindingFingerprint(bindingContext.identity, continuity);
  const suppliedToken = required(url.searchParams.get("station_history_continuation"));
  let state = newWorkState();
  if (suppliedToken) {
    const decoded = await decodeStationHistoryContinuation(suppliedToken, secret);
    if (!sameTokenBinding(decoded.q, requestTokenBinding(chunk)) || decoded.f !== fingerprint) {
      fail(409, "station_history_continuation_identity_contradiction");
    }
    state = validateWorkState(decoded.w, plan);
  }
  const continuationNumber = state.n;
  const observationRows = [];
  const aqiRows = [];
  let pagesConsumed = 0;
  let sourceRowsReceived = 0;
  while (state.i < plan.slices.length && pagesConsumed < cap) {
    const slice = plan.slices[state.i];
    const target = leafUrl(env, slice, state.c);
    let response;
    try {
      response = await fetchApi(target.toString(), {
        headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret },
      });
    } catch {
      fail(502, "station_history_v3_leaf_fetch_failed");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) fail(502, "station_history_v3_leaf_fetch_failed");
    const page = normalizeLeafPage(payload, slice, state);
    pagesConsumed += 1;
    sourceRowsReceived += page.rows.length;
    for (const row of page.rows) consumeSourceRow(state, chunk, continuity, row, observationRows, aqiRows);
    if (payload.has_gap === true) state.g = true;
    state.gr = uniqueStrings([...state.gr, ...(Array.isArray(payload.coverage_partial_reasons) ? payload.coverage_partial_reasons : [])]);
    if (page.paginationComplete) {
      state.i += 1;
      state.c = null;
      state.e = 1;
    } else {
      state.c = page.physical.next_cursor;
      state.e += 1;
    }
  }
  const workComplete = state.i === plan.slices.length;
  if (workComplete) finalizeOpenAggregate(state, chunk, continuity, aqiRows);
  state.vh = uniqueNumbers(state.vh);
  state.ah = uniqueNumbers(state.ah);
  const expected = expectedHourEndpoints(chunk.startMs, chunk.endMs);
  const observationMissing = workComplete && chunk.includeObservations
    ? missingRanges(expected, new Set(state.vh))
    : [];
  const aqiMissing = workComplete && chunk.includeAqi
    ? missingRanges(expected, new Set(state.ah))
    : [];
  const continuityVisible = selectContinuitySegments(continuity, chunk.startMs, chunk.endMs + 1);
  const continuityContextGap = plan.selection.gaps.length > 0;
  const genuineGap = state.g || continuityVisible.gaps.length > 0 || continuityContextGap;
  const observationsComplete = chunk.includeObservations && workComplete && !genuineGap && observationMissing.length === 0;
  const aqiComplete = chunk.includeAqi && workComplete && !genuineGap && aqiMissing.length === 0 && !state.ai;
  const workRemaining = !workComplete;
  let nextToken = null;
  if (workRemaining) {
    state.n = continuationNumber + 1;
    nextToken = await encodeStationHistoryContinuation(compactTokenPayload(chunk, fingerprint, state), secret);
  }
  const observationPartialReasons = chunk.includeObservations && !observationsComplete ? uniqueStrings([
    ...(workRemaining ? [WORK_REMAINING_REASON] : []),
    ...(genuineGap ? ["required_observation_source_incomplete"] : []),
    ...(observationMissing.length ? ["missing_visible_observation_hours"] : []),
    ...state.gr,
  ]) : [];
  const aqiPartialReasons = chunk.includeAqi && !aqiComplete ? uniqueStrings([
    ...(workRemaining ? [WORK_REMAINING_REASON] : []),
    ...(genuineGap ? ["required_aqi_context_incomplete"] : []),
    ...(aqiMissing.length ? ["missing_visible_aqi_hours"] : []),
    ...(state.ai ? ["calculated_aqi_status_incomplete"] : []),
    ...state.gr,
  ]) : [];
  const overallComplete = (!chunk.includeObservations || observationsComplete)
    && (!chunk.includeAqi || aqiComplete);
  const diagnosticMode = required(url.searchParams.get("diagnostics"));
  if (diagnosticMode && diagnosticMode !== "cpu_v1") fail(400, "station_history_v3_diagnostics_invalid");
  const diagnosticRequestId = diagnosticMode ? crypto.randomUUID() : null;
  const cfRay = required(request.headers.get("cf-ray")) || null;
  const diagnostics = {
    schema_version: 1,
    station_history_request_id: diagnosticRequestId,
    cloudflare_ray_id: cfRay,
    public_continuation_number: continuationNumber,
    configured_physical_page_work_cap: cap,
    physical_pages_consumed: pagesConsumed,
    low_level_fetch_count: pagesConsumed,
    binding_fetch_count: 1,
    external_subrequest_count: pagesConsumed + 1,
    source_rows_received: sourceRowsReceived,
    visible_observation_rows_returned: observationRows.length,
    aqi_rows_calculated: aqiRows.length,
    continuation_returned: Boolean(nextToken),
    genuine_gap: genuineGap,
    cpu_time_ms: null,
    cpu_time_source: "cloudflare_invocation_logs_or_analytics",
  };
  if (diagnosticMode) console.info(JSON.stringify({ event: "station_history_v3_continuation_cpu_measurement", ...diagnostics }));
  const body = {
    schema_version: 2,
    continuation_contract: CONTINUATION_CONTRACT,
    request: responseRequest(chunk),
    identity: {
      source: "r2_timeseries_binding",
      connector_id: bindingContext.identity.connectorId,
      station_id: bindingContext.identity.stationId,
      timeseries_id: bindingContext.identity.timeseriesId,
      pollutant: bindingContext.identity.pollutant,
    },
    continuity: publicContinuity(continuity),
    observations: chunk.includeObservations ? {
      enabled: true,
      rows: observationRows,
      response_complete: observationsComplete,
      has_gap: genuineGap || observationMissing.length > 0,
      gap_ranges: [...continuityVisible.gaps, ...observationMissing],
      partial_reasons: observationPartialReasons,
      source_counts: { r2: observationRows.length, ingest: 0 },
    } : { enabled: false, rows: [], response_complete: false, has_gap: false, gap_ranges: [], partial_reasons: [] },
    aqi: chunk.includeAqi ? {
      enabled: true,
      calculation_source: "calculated_from_observations",
      response_contract: "aqi_hour_interval_v2",
      algorithm_version: AQI_ALGORITHM_VERSION,
      rows: aqiRows,
      response_complete: aqiComplete,
      has_gap: genuineGap || aqiMissing.length > 0 || state.ai,
      gap_ranges: [...plan.selection.gaps, ...aqiMissing],
      partial_reasons: aqiPartialReasons,
      required_context_start_utc: new Date(plan.sourceStartMs).toISOString(),
      output_start_utc: chunk.startUtc,
      output_end_utc: chunk.endUtc,
      source_counts: { calculated_from_observations: aqiRows.length },
    } : { enabled: false, calculation_source: null, rows: [], response_complete: false, has_gap: false, gap_ranges: [], partial_reasons: [] },
    rows: chunk.includeObservations ? observationRows : [],
    row_count: chunk.includeObservations ? observationRows.length : 0,
    response_complete: overallComplete,
    has_gap: genuineGap
      || (workComplete && ((chunk.includeObservations && observationMissing.length > 0) || (chunk.includeAqi && (aqiMissing.length > 0 || state.ai)))),
    coverage_state: overallComplete ? "complete" : "partial",
    partial_reasons: uniqueStrings([
      ...(workRemaining ? [WORK_REMAINING_REASON] : []),
      ...observationPartialReasons,
      ...aqiPartialReasons,
    ]),
    station_history_continuation: nextToken,
    station_history_page: {
      schema_version: 1,
      continuation_number: continuationNumber,
      physical_page_work_cap: cap,
      physical_pages_consumed: pagesConsumed,
      source_rows_received: sourceRowsReceived,
      work_complete: workComplete,
      continuation_returned: Boolean(nextToken),
      work_exhausted_without_gap: workRemaining && !genuineGap,
    },
    source: {
      mode: "v3_physical_leaf_bounded_continuation_experiment",
      ingest_fetch_count: 0,
      binding_fetch_count: 1,
      r2_observation_fetch_count: pagesConsumed,
      required_context_start_utc: new Date(plan.sourceStartMs).toISOString(),
      output_start_utc: chunk.startUtc,
      output_end_utc: chunk.endUtc,
    },
    chunk: chunkResponse(chunk, Boolean(nextToken)),
    ...(diagnosticMode ? { diagnostic_request: diagnostics } : {}),
  };
  const immutable = chunk.endMs <= nowMs - 120 * HOUR_MS;
  return {
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": diagnosticMode
        ? "no-store"
        : immutable ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300",
      "X-UK-AQ-Station-History-Contract": "v2",
      "X-UK-AQ-Station-History-Continuation-Contract": CONTINUATION_CONTRACT,
      "X-UK-AQ-Station-History-Continuation": String(Boolean(nextToken)),
      "X-UK-AQ-Response-Complete": String(overallComplete),
      ...(diagnosticRequestId ? { "X-UKAQ-Diagnostic-Request-Id": diagnosticRequestId } : {}),
    },
  };
}

export const STATION_HISTORY_V3_CONTINUATION_LIMITS = Object.freeze({
  maximum_physical_pages_per_invocation: MAX_PHYSICAL_PAGES,
  reserved_external_subrequests_at_maximum: 9,
  binding_fetches_per_invocation: 1,
  maximum_token_characters: MAX_TOKEN_CHARACTERS,
});

export { CONTINUATION_CONTRACT, WORK_REMAINING_REASON };
