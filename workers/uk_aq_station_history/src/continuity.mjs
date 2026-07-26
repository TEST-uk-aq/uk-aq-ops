import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";
import { StationHistoryIdentityError } from "./identity.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const DAY_MS = 24 * 60 * 60 * 1000;

function required(value) { return String(value ?? "").trim(); }
function positiveInt(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function isoDay(value) {
  const text = required(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? text : null;
}

function fail(status, code, detail) { throw new StationHistoryIdentityError(status, code, detail); }

function validateContinuity(binding) {
  const section = binding.continuity;
  if (!section || section.schema_version !== 1 || section.source !== "sos_station_timeseries_site_refs") fail(422, "station_history_continuity_invalid");
  const pollutant = normalizePollutantCode(section.pollutant_code);
  const connectorId = positiveInt(binding.connector_id);
  const ukAirRef = required(section.uk_air_ref).toUpperCase();
  const expectedKey = `${connectorId}:${ukAirRef}:${pollutant}`;
  if (!pollutant || pollutant !== binding.pollutant_code || required(section.continuity_key) !== expectedKey || !required(section.site_ref) || !Array.isArray(section.members) || section.members.length < 2) fail(422, "station_history_continuity_invalid");
  const members = [];
  const seen = new Set();
  let openEnded = 0;
  for (const raw of section.members) {
    const stationId = positiveInt(raw?.station_id);
    const timeseriesId = positiveInt(raw?.timeseries_id);
    const validFrom = isoDay(raw?.valid_from_day_utc);
    const validTo = raw?.valid_to_day_utc == null ? null : isoDay(raw.valid_to_day_utc);
    if (!stationId || !timeseriesId || !validFrom || (raw?.valid_to_day_utc != null && !validTo) || (validTo && validTo < validFrom) || seen.has(timeseriesId)) fail(422, "station_history_continuity_invalid");
    seen.add(timeseriesId);
    if (validTo === null) openEnded += 1;
    members.push({
      stationId,
      stationRef: required(raw.station_ref) || null,
      timeseriesId,
      timeseriesRef: required(raw.timeseries_ref) || null,
      connectorId,
      pollutant,
      validFromDayUtc: validFrom,
      validToDayUtc: validTo,
    });
  }
  members.sort((left, right) => left.validFromDayUtc.localeCompare(right.validFromDayUtc) || left.timeseriesId - right.timeseriesId);
  for (let index = 1; index < members.length; index += 1) {
    const previous = members[index - 1];
    if (previous.validToDayUtc === null || members[index].validFromDayUtc <= previous.validToDayUtc) fail(422, "station_history_continuity_overlap");
  }
  if (openEnded > 1 || members.filter((member) => member.timeseriesId === positiveInt(binding.timeseries_id)).length !== 1) fail(422, "station_history_continuity_invalid");
  return { enabled: true, continuityKey: expectedKey, siteRef: required(section.site_ref), ukAirRef, pollutant, members };
}

export function validateTimeseriesBinding(binding, request) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) fail(422, "station_history_binding_invalid");
  const timeseriesId = positiveInt(binding.timeseries_id);
  const connectorId = positiveInt(binding.connector_id);
  const stationId = positiveInt(binding.station_id);
  const pollutant = normalizePollutantCode(binding.pollutant_code);
  if (![1, 2].includes(binding.schema_version) || binding.history_version !== "v2" || binding.index_kind !== "timeseries_binding" || !timeseriesId || !connectorId || !stationId || !pollutant) fail(422, "station_history_binding_invalid");
  if (timeseriesId !== positiveInt(request.timeseriesId)) fail(409, "station_history_binding_timeseries_mismatch");
  if (request.connectorId && connectorId !== positiveInt(request.connectorId)) fail(409, "station_history_connector_mismatch");
  if (pollutant !== normalizePollutantCode(request.pollutant)) fail(409, "station_history_pollutant_mismatch");
  const continuity = binding.schema_version === 2 ? validateContinuity(binding) : { enabled: false, continuityKey: null, siteRef: null, ukAirRef: null, pollutant, members: [{ stationId, stationRef: null, timeseriesId, timeseriesRef: null, connectorId, pollutant, validFromDayUtc: null, validToDayUtc: null }] };
  if (binding.schema_version === 1 && binding.continuity !== undefined) fail(422, "station_history_binding_invalid");
  return { binding, continuity, identity: { source: "r2_timeseries_binding", timeseriesId, stationId, connectorId, pollutant } };
}

export async function resolveTimeseriesBinding(request, env) {
  const baseUrl = required(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) fail(500, "station_history_binding_config_missing");
  const endpoint = new URL(baseUrl);
  endpoint.pathname = "/v1/timeseries-binding";
  endpoint.search = "";
  endpoint.searchParams.set("timeseries_id", String(request.timeseriesId));
  let response;
  try { response = await fetch(endpoint, { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } }); }
  catch { fail(502, "station_history_binding_lookup_failed"); }
  const payload = await response.json().catch(() => null);
  if (response.status === 404) fail(404, "station_history_binding_not_found");
  if (!response.ok || !payload?.binding) fail(502, "station_history_binding_lookup_failed");
  return validateTimeseriesBinding(payload.binding, request);
}

function memberBounds(member) {
  if (!member.validFromDayUtc) return { startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY };
  const startMs = Date.parse(`${member.validFromDayUtc}T00:00:00.000Z`);
  const endMs = member.validToDayUtc ? Date.parse(`${member.validToDayUtc}T00:00:00.000Z`) + DAY_MS : Number.POSITIVE_INFINITY;
  return { startMs, endMs };
}

export function selectContinuitySegments(continuity, startMs, endExclusiveMs) {
  const segments = [];
  for (const member of continuity.members) {
    const bounds = memberBounds(member);
    const segmentStartMs = Math.max(startMs, bounds.startMs);
    const segmentEndMs = Math.min(endExclusiveMs, bounds.endMs);
    if (segmentEndMs > segmentStartMs) segments.push({ ...member, startMs: segmentStartMs, endMs: segmentEndMs });
  }
  segments.sort((left, right) => left.startMs - right.startMs || left.timeseriesId - right.timeseriesId);
  const gaps = [];
  let cursor = startMs;
  for (const segment of segments) {
    if (segment.startMs > cursor) gaps.push({ start_utc: new Date(cursor).toISOString(), end_utc: new Date(segment.startMs).toISOString() });
    cursor = Math.max(cursor, segment.endMs);
  }
  if (cursor < endExclusiveMs) gaps.push({ start_utc: new Date(cursor).toISOString(), end_utc: new Date(endExclusiveMs).toISOString() });
  return { segments, gaps };
}

export function publicContinuity(continuity) {
  return {
    enabled: continuity.enabled,
    continuity_key: continuity.continuityKey,
    site_ref: continuity.siteRef,
    uk_air_ref: continuity.ukAirRef,
    members: continuity.members.map((member) => ({ station_id: member.stationId, station_ref: member.stationRef, timeseries_id: member.timeseriesId, timeseries_ref: member.timeseriesRef, valid_from_day_utc: member.validFromDayUtc, valid_to_day_utc: member.validToDayUtc })),
  };
}
