// Private, exact-allowlist TEST pilot. The cache proxy supplies the authenticated edge boundary.
import { buildCalculatedHistory } from "../uk_aq_station_history/src/calculated_history.mjs";
import {
  COMPRESSED_CHART_SAMPLES as SAMPLES,
  COMPRESSED_CHART_SELECTOR_KEY as SELECTOR_KEY,
  validateCompressedChartSelector,
  validateCompressedChartPublication,
} from "../shared/uk_aq_compressed_chart_pilot.mjs";

const authHeader = "X-UK-AQ-Upstream-Auth";
const identity = { connectorId: 1, stationId: 248, timeseriesId: 212, pollutant: "pm25" };
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function error(status, code) { return Response.json({ error: { code } }, { status, headers: jsonHeaders }); }
function equalSecret(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function secretValue(value) { return typeof value?.get === "function" ? value.get() : value; }
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readJson(bucket, key, maxBytes, expectedDigest = null) {
  const object = await bucket.get(key);
  if (!object || object.size < 1 || object.size > maxBytes) return null;
  const bytes = await object.arrayBuffer();
  if (expectedDigest && await sha256(bytes) !== expectedDigest) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
function exactQuery(url, names) {
  const keys = [...url.searchParams.keys()];
  return keys.length === names.length && names.every((name) => keys.filter((key) => key === name).length === 1);
}
function requestId(request) {
  const value = request.headers.get("X-UK-AQ-Prototype-Request-ID") || "";
  return /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : crypto.randomUUID();
}
function rangeFor(url, sample) {
  const start = url.searchParams.get("start_utc"), end = url.searchParams.get("end_utc");
  const startMs = Date.parse(start || ""), endMs = Date.parse(end || "");
  if (!start || !end || !Number.isFinite(startMs) || !Number.isFinite(endMs)
    || new Date(startMs).toISOString() !== start || new Date(endMs).toISOString() !== end
    || startMs < Date.parse(sample.start) || endMs >= Date.parse(sample.end) || endMs <= startMs) return null;
  return { startMs, endMs };
}
async function selected(bucket, sampleId) {
  const selector = await readJson(bucket, SELECTOR_KEY, 16 * 1024);
  if (!selector || !validateCompressedChartSelector(selector)) return null;
  const entry = selector.samples[sampleId];
  if (!entry) return null;
  const publication = await readJson(bucket, entry.manifest_key, 32 * 1024, entry.manifest_sha256);
  if (!publication || !validateCompressedChartPublication(publication, sampleId)) return null;
  return { entry, publication, object: publication.objects[0] };
}
function validMonth(month, selected, sample) {
  const rows = month?.observations;
  if (month?.schema_version !== 1 || month?.kind !== "uk_aq_compressed_chart_history_month"
    || month?.identity?.connector_id !== 1 || month.identity.station_id !== 248
    || month.identity.timeseries_id !== 212 || month.identity.pollutant_code !== "pm25"
    || month?.source?.generation !== sample.generation || month?.coverage?.complete !== true
    || month.coverage.requested_start_utc !== sample.start
    || month.coverage.requested_end_exclusive_utc !== sample.end
    || JSON.stringify(month.row_columns) !== JSON.stringify(["observed_at_utc", "value", "station_id", "source_status", "verification_status"])
    || !Array.isArray(rows) || rows.length !== selected.object.row_count) return false;
  return rows.every((row) => Array.isArray(row) && row.length === 5
    && typeof row[0] === "string" && Number.isFinite(Date.parse(row[0]))
    && row[0] >= sample.start && row[0] < sample.end
    && typeof row[1] === "number" && Number.isFinite(row[1]) && row[2] === 248);
}
async function aqiFromObject(object, selected, sample, range) {
  const decompressed = new Response(object.body.pipeThrough(new DecompressionStream("gzip")));
  const raw = await decompressed.arrayBuffer();
  if (raw.byteLength > 512 * 1024 || await sha256(raw) !== selected.object.json_sha256) throw new Error("pilot_json_digest_invalid");
  const month = JSON.parse(new TextDecoder().decode(raw));
  if (!validMonth(month, selected, sample)) throw new Error("pilot_json_invalid");
  const rows = month.observations.map((row) => ({
    connector_id: 1, station_id: 248, timeseries_id: 212, pollutant_code: "pm25",
    observed_at: row[0], value: row[1], source_status: row[3], verification_status: row[4], source: "json",
  }));
  const result = await buildCalculatedHistory({
    request: { ...identity, includeObservations: false, includeAqi: true },
    continuity: { enabled: false, continuityKey: null, siteRef: null, ukAirRef: null,
      pollutant: "pm25", members: [{ ...identity, stationRef: null, timeseriesRef: null, validFromDayUtc: null, validToDayUtc: null }] },
    outputStartMs: range.startMs, outputEndMs: range.endMs,
    observationProvider: async ({ startMs, endMs }) => ({
      rows: rows.filter((row) => Date.parse(row.observed_at) >= startMs && Date.parse(row.observed_at) < endMs),
      response_complete: true, partial_reasons: [], fetch_count: 1,
      context_complete: startMs >= Date.parse(sample.start),
    }),
  });
  return result.aqi;
}

export default {
  async fetch(request, env) {
    if (env.UK_AQ_ENV_NAME !== "TEST" || !env.UK_AQ_COMPRESSED_CHART_BUCKET) return error(503, "pilot_not_configured");
    if (!equalSecret(request.headers.get(authHeader) || "", String(await secretValue(env.UK_AQ_EDGE_UPSTREAM_SECRET) || ""))) return error(403, "forbidden");
    if (request.method !== "GET") return error(405, "method_not_allowed");
    const url = new URL(request.url), route = url.pathname;
    if (!["/v1/manifest", "/v1/month", "/v1/aqi"].includes(route)) return error(404, "route_not_found");
    const sampleId = url.searchParams.get("sample"), sample = Object.hasOwn(SAMPLES, sampleId) ? SAMPLES[sampleId] : null;
    if (!sample) return error(400, "pilot_sample_invalid");
    const names = route === "/v1/manifest" ? ["sample"] : ["sample", "publication", "source_generation", "start_utc", "end_utc", "connector_id", "station_id", "timeseries_id", "pollutant"];
    if (!exactQuery(url, names)) return error(400, "pilot_query_invalid");
    if (route !== "/v1/manifest" && (url.searchParams.get("source_generation") !== sample.generation
      || url.searchParams.get("connector_id") !== "1"
      || url.searchParams.get("station_id") !== "248" || url.searchParams.get("timeseries_id") !== "212"
      || url.searchParams.get("pollutant") !== "pm25")) return error(400, "pilot_identity_invalid");
    const range = route === "/v1/manifest" ? null : rangeFor(url, sample);
    if (route !== "/v1/manifest" && !range) return error(400, "pilot_range_invalid");
    const selectedPublication = await selected(env.UK_AQ_COMPRESSED_CHART_BUCKET, sampleId);
    if (!selectedPublication) return error(404, "pilot_publication_unavailable");
    const { entry, object: descriptor } = selectedPublication;
    if (route !== "/v1/manifest" && url.searchParams.get("publication") !== entry.manifest_sha256) return error(409, "pilot_publication_changed");
    const id = requestId(request);
    console.log(JSON.stringify({ event: "compressed_chart_pilot_request", request_id: id,
      route, sample_id: sampleId, generation: sample.generation,
      publication_sha256: entry.manifest_sha256, r2_reads: route === "/v1/manifest" ? 2 : 3 }));
    if (route === "/v1/manifest") return Response.json({ schema_version: 1, sample_id: sampleId,
      source_generation: sample.generation, publication_sha256: entry.manifest_sha256,
      identity: selectedPublication.publication.identity, interval: selectedPublication.publication.requested_interval,
      object: { sha256: descriptor.sha256, json_sha256: descriptor.json_sha256,
        byte_size: descriptor.byte_size, row_count: descriptor.row_count, coverage_days: descriptor.coverage_days } },
    { headers: { ...jsonHeaders, "X-UK-AQ-Prototype-Request-ID": id,
      "X-UK-AQ-Prototype-R2-Reads": "2", "X-UK-AQ-Prototype-Cache": "BYPASS" } });
    const object = await env.UK_AQ_COMPRESSED_CHART_BUCKET.get(descriptor.key);
    if (!object || object.size !== descriptor.byte_size) return error(502, "pilot_object_unavailable");
    if (route === "/v1/month") return new Response(object.body, { encodeBody: "manual", headers: {
      "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(object.size),
      "Cache-Control": "no-store", "X-UK-AQ-Prototype-Request-ID": id,
      "X-UK-AQ-Prototype-Publication": entry.manifest_sha256,
      "X-UK-AQ-Prototype-Compressed-Bytes": String(object.size), "X-UK-AQ-Prototype-R2-Reads": "3",
      "X-UK-AQ-Prototype-Cache": "BYPASS",
    } });
    try {
      const aqiStarted = performance.now();
      const aqi = await aqiFromObject(object, selectedPublication, sample, range);
      return Response.json({ schema_version: 2, aqi }, { headers: { ...jsonHeaders,
        "X-UK-AQ-Prototype-Request-ID": id, "X-UK-AQ-Prototype-Publication": entry.manifest_sha256,
        "X-UK-AQ-Prototype-R2-Reads": "3", "X-UK-AQ-Prototype-Cache": "BYPASS",
        "X-UK-AQ-Prototype-AQI-Wall-MS": String(Math.round(performance.now() - aqiStarted)) } });
    } catch { return error(502, "pilot_aqi_calculation_failed"); }
  },
};
