import { buildJsonResponse, errorEnvelope } from "./http";
import type { WorkerEnv } from "./upstream";

type JsonObject = Record<string, unknown>;
export type SnapshotV2InputRow = { observed_at?: string; timestamp_hour_utc?: string; period_start_utc?: string; source?: unknown; timeseries_id?: number; value?: unknown; hourly_mean_ugm3?: unknown; rolling24h_mean_ugm3?: unknown; hourly_sample_count?: unknown; daqi_index_level?: unknown; eaqi_index_level?: unknown };

const POLLUTANTS = new Set(["pm25", "pm10", "no2"]);
const RANGES: Record<string, number> = { "24h": 24, "7d": 24 * 7, "31d": 24 * 31, "90d": 24 * 90 };
const DAQI_COLOURS: Record<number, string> = { 1: "#9CFF9C", 2: "#31FF00", 3: "#31CF00", 4: "#FFFF00", 5: "#FFCF00", 6: "#FF9A00", 7: "#FF6464", 8: "#FF0000", 9: "#990000", 10: "#CE30FF" };
const EAQI_COLOURS: Record<number, string> = { 1: "#50F0E6", 2: "#50CCAA", 3: "#F0E641", 4: "#FF5050", 5: "#960032", 6: "#7D2181" };

function restBase(env: WorkerEnv, obs = false): string {
  const raw = String((obs ? env.OBS_AQIDB_SUPABASE_URL : env.SUPABASE_URL) || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error(`${obs ? "OBS_AQIDB_SUPABASE_URL" : "SUPABASE_URL"} is required`);
  return `${raw}/rest/v1`;
}
function serviceKey(env: WorkerEnv, obs = false): string {
  const key = String((obs ? env.OBS_AQIDB_SECRET_KEY : env.SB_SECRET_KEY) || "").trim();
  if (!key) throw new Error(`${obs ? "OBS_AQIDB_SECRET_KEY" : "SB_SECRET_KEY"} is required`);
  return key;
}
function headers(key: string, schema: string): Headers {
  const h = new Headers(); h.set("apikey", key); h.set("Authorization", `Bearer ${key}`); h.set("Accept-Profile", schema); return h;
}
function url(base: string, path: string, params: Record<string, string>): string { const u = new URL(path, `${base}/`); for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v); return u.toString(); }
async function rows(base: string, table: string, h: Headers, params: Record<string,string>): Promise<JsonObject[]> { const r = await fetch(url(base, table, params), { headers: h }); const t = await r.text(); if (!r.ok) throw new Error(`${table} (${r.status}): ${t}`); const j = t ? JSON.parse(t) : []; return Array.isArray(j) ? j.filter((x): x is JsonObject => x && typeof x === "object" && !Array.isArray(x)) : []; }
async function apiRows(apiUrl: string, token: string, params: Record<string,string>, candidates: string[]): Promise<JsonObject[]> {
  if (!apiUrl) return [];
  const u = new URL(apiUrl);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  const h = new Headers(); if (token) h.set("Authorization", `Bearer ${token}`);
  const r = await fetch(u.toString(), { headers: h }); const t = await r.text(); if (!r.ok) throw new Error(`${apiUrl} (${r.status}): ${t}`);
  const j = t ? JSON.parse(t) : [];
  for (const key of candidates) { const value = j && typeof j === "object" && !Array.isArray(j) ? (j as JsonObject)[key] : null; if (Array.isArray(value)) return value.filter((x): x is JsonObject => x && typeof x === "object" && !Array.isArray(x)); }
  return Array.isArray(j) ? j.filter((x): x is JsonObject => x && typeof x === "object" && !Array.isArray(x)) : [];
}
function n(v: unknown): number | null { if (v === null || v === undefined || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function levelColour(level: unknown, map: Record<number,string>): string | null { const x = n(level); return x === null ? null : map[Math.trunc(x)] || null; }
function isoExact(v: unknown): string | null { const d = new Date(String(v || "")); if (Number.isNaN(d.getTime())) return null; return d.toISOString(); }
function isoHour(v: unknown): string | null { const d = new Date(String(v || "")); if (Number.isNaN(d.getTime())) return null; d.setUTCMinutes(0,0,0); return d.toISOString(); }

export function mergeStationSnapshotV2Rows(input: { ingestObservs?: SnapshotV2InputRow[]; obsAqidbObservs?: SnapshotV2InputRow[]; r2Observs?: SnapshotV2InputRow[]; ingestAqi?: SnapshotV2InputRow[]; r2Aqi?: SnapshotV2InputRow[] }) {
  const byAt = new Map<string, JsonObject>();
  const ensure = (at: string, bucket?: string | null) => { if (!byAt.has(at)) byAt.set(at, { hour_bucket: bucket || isoHour(at), observed_at: at, ingestdb_observs_value: null, obsaqidb_observs_value: null, r2_observs_value: null, aqi_source: "", hourly_mean_ugm3: null, rolling24h_mean_ugm3: null, hourly_sample_count: null, daqi_index_level: null, daqi_colour: null, eaqi_index_level: null, eaqi_colour: null, has_ingestdb_observs_row: false, has_obsaqidb_observs_row: false, has_r2_observs_row: false, has_aqi_row: false }); return byAt.get(at)!; };
  for (const row of input.ingestObservs || []) { const at = isoExact(row.observed_at); if (at) { const out = ensure(at, isoHour(at)); out.ingestdb_observs_value = n(row.value); out.has_ingestdb_observs_row = true; } }
  for (const row of input.obsAqidbObservs || []) { const at = isoExact(row.observed_at); if (at) { const out = ensure(at, isoHour(at)); out.obsaqidb_observs_value = n(row.value); out.has_obsaqidb_observs_row = true; } }
  for (const row of input.r2Observs || []) { const at = isoExact(row.observed_at); if (at) { const out = ensure(at, isoHour(at)); out.r2_observs_value = n(row.value); out.has_r2_observs_row = true; } }
  const ingestAqi = new Map<string, SnapshotV2InputRow>(); const r2Aqi = new Map<string, SnapshotV2InputRow>();
  for (const row of input.ingestAqi || []) { const at = isoHour(row.observed_at || row.timestamp_hour_utc || row.period_start_utc); if (at) ingestAqi.set(at, row); }
  for (const row of input.r2Aqi || []) { const at = isoHour(row.observed_at || row.timestamp_hour_utc || row.period_start_utc); if (at) r2Aqi.set(at, row); }
  let overlap_detected = false;
  const attachAqi = (out: JsonObject, src: SnapshotV2InputRow, source: string) => { out.has_aqi_row = true; out.aqi_source = source; out.hourly_mean_ugm3 = n(src.hourly_mean_ugm3); out.rolling24h_mean_ugm3 = n(src.rolling24h_mean_ugm3); out.hourly_sample_count = n(src.hourly_sample_count); out.daqi_index_level = n(src.daqi_index_level); out.eaqi_index_level = n(src.eaqi_index_level); out.daqi_colour = levelColour(src.daqi_index_level, DAQI_COLOURS); out.eaqi_colour = levelColour(src.eaqi_index_level, EAQI_COLOURS); };
  const observationBuckets = new Set(Array.from(byAt.values()).map((row) => String(row.hour_bucket || "")));
  for (const [at, out] of byAt) { const bucket = String(out.hour_bucket || at); const src = r2Aqi.get(bucket) || ingestAqi.get(bucket); if (r2Aqi.has(bucket) && ingestAqi.has(bucket)) overlap_detected = true; if (src) attachAqi(out, src, r2Aqi.has(bucket) ? "R2 History" : "obsaqidb"); }
  for (const [bucket, src] of [...ingestAqi.entries(), ...r2Aqi.entries()]) { if (observationBuckets.has(bucket)) continue; const isR2 = r2Aqi.has(bucket); const out = ensure(bucket, bucket); attachAqi(out, isR2 ? r2Aqi.get(bucket)! : src, isR2 ? "R2 History" : "obsaqidb"); }
  return { overlap_detected, rows: Array.from(byAt.values()).sort((a,b) => String(b.observed_at).localeCompare(String(a.observed_at))) };
}

export async function handleStationSnapshotV2Search(env: WorkerEnv, search: URLSearchParams): Promise<Response> {
  const q = String(search.get("q") || "").trim(); if (q.length < 2) return buildJsonResponse({ results: [] }, 200, "no-store");
  const base = restBase(env); const key = serviceKey(env); const h = headers(key, String(env.UK_AQ_CORE_SCHEMA || "uk_aq_core"));
  const safe = q.replace(/[,*()]/g, " ").trim();
  const result = await rows(base, "stations", h, { select: "id,station_ref,label,name,connector_id,connectors(id,label,name)", or: `(label.ilike.*${safe}*,name.ilike.*${safe}*,station_ref.ilike.*${safe}*,id.eq.${/^\d+$/.test(safe) ? safe : -1})`, order: "label.asc", limit: "20" });
  return buildJsonResponse({ results: result.map((r) => { const c = (r.connectors && typeof r.connectors === "object" && !Array.isArray(r.connectors)) ? r.connectors as JsonObject : {}; const connectorId = n(r.connector_id ?? c.id); return { station_id: n(r.id), station_ref: r.station_ref ?? "", station_name: r.label || r.name || `station ${r.id}`, connector_id: connectorId, connector_label: connectorId === 1 ? "GOV.UK AURN" : String(c.label || c.name || r.connector_id || "") }; }) }, 200, "no-store");
}

export async function handleStationSnapshotV2Rows(env: WorkerEnv, search: URLSearchParams): Promise<Response> {
  const stationId = Math.trunc(Number(search.get("station_id"))); const pollutant = String(search.get("pollutant") || "pm25"); const range = String(search.get("range") || "24h"); const requestedTs = Number(search.get("timeseries_id") || "");
  if (!Number.isFinite(stationId) || stationId < 1) return errorEnvelope("BAD_REQUEST", "station_id is required", 400); if (!POLLUTANTS.has(pollutant) || !RANGES[range]) return errorEnvelope("BAD_REQUEST", "Invalid pollutant or range", 400);
  const nowMs = Date.now(); const start = new Date(nowMs - RANGES[range] * 3600_000).toISOString(); const end = new Date(nowMs).toISOString(); const base = restBase(env); const key = serviceKey(env); const h = headers(key, String(env.UK_AQ_CORE_SCHEMA || "uk_aq_core"));
  const ts = await rows(base, "timeseries", h, { select: "id,connector_id,station_id,label,uom,phenomenon", station_id: `eq.${stationId}`, order: "id.asc", limit: "100" });
  const matching = ts.filter((r) => JSON.stringify(r).toLowerCase().replace(/[^a-z0-9]+/g, "").includes(pollutant));
  const selected = Number.isFinite(requestedTs) && matching.some(r => n(r.id) === requestedTs) ? requestedTs : (matching.length === 1 ? n(matching[0].id) : n(matching[0]?.id));
  if (!selected) return buildJsonResponse({ station_id: stationId, pollutant, range, timeseries: [], selected_timeseries_id: null, overlap_detected: false, rows: [] }, 200, "no-store");
  const ingestObservs = await rows(base, "observations", h, { select: "timeseries_id,observed_at,value", timeseries_id: `eq.${selected}`, observed_at: `gte.${start}`, order: "observed_at.desc", limit: "3000" });
  let obsAqidbObservs: JsonObject[] = []; let ingestAqi: JsonObject[] = []; let r2Observs: JsonObject[] = []; let r2Aqi: JsonObject[] = [];
  const selectedMeta = matching.find(r => n(r.id) === selected); const selectedConnectorId = String(n(selectedMeta?.connector_id) || "");
  const r2Params = { timeseries_id: String(selected), connector_id: selectedConnectorId, pollutant, since: start, since_utc: start, from_utc: start, start_utc: start, to_utc: end, end_utc: end, read_version: "v2", debug: "1" };
  try { const obsApi = String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || "").trim(); r2Observs = await apiRows(obsApi, String(env.UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN || "").trim(), r2Params, ["rows", "observations"]); } catch (_err) {}
  try { const aqiApi = String(env.UK_AQ_AQI_HISTORY_R2_API_URL || "").trim(); r2Aqi = await apiRows(aqiApi, String(env.UK_AQ_AQI_HISTORY_R2_API_TOKEN || "").trim(), { ...r2Params, format: "objects" }, ["rows", "data", "points"]).then(a => a.map(r => ({...r, observed_at: r.observed_at || r.timestamp_hour_utc || r.period_start_utc, hourly_mean_ugm3: r.hourly_mean_ugm3 ?? r.eaqi_input_value_ugm3 ?? r.daqi_input_value_ugm3, rolling24h_mean_ugm3: r.rolling24h_mean_ugm3 ?? r.daqi_input_value_ugm3, hourly_sample_count: r.hourly_sample_count ?? r.source_observation_count }))); } catch (_err) {}
  try { const ob = restBase(env, true); const oh = headers(serviceKey(env, true), String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public")); obsAqidbObservs = await rows(ob, "observations", oh, { select: "timeseries_id,observed_at,value", timeseries_id: `eq.${selected}`, observed_at: `gte.${start}`, order: "observed_at.desc", limit: "3000" }); ingestAqi = await rows(ob, "uk_aq_timeseries_aqi_hourly", oh, { select: "timeseries_id,timestamp_hour_utc,hourly_mean_ugm3,rolling24h_mean_ugm3,hourly_sample_count,daqi_index_level,eaqi_index_level", timeseries_id: `eq.${selected}`, timestamp_hour_utc: `gte.${start}`, order: "timestamp_hour_utc.desc", limit: "3000" }).then(a => a.map(r => ({...r, observed_at: r.timestamp_hour_utc}))); } catch (_err) {}
  const merged = mergeStationSnapshotV2Rows({ ingestObservs: ingestObservs as SnapshotV2InputRow[], obsAqidbObservs: obsAqidbObservs as SnapshotV2InputRow[], r2Observs: r2Observs as SnapshotV2InputRow[], ingestAqi: ingestAqi as SnapshotV2InputRow[], r2Aqi: r2Aqi as SnapshotV2InputRow[] });
  return buildJsonResponse({ station_id: stationId, pollutant, range, timeseries: matching.map(r => ({ timeseries_id: n(r.id), connector_id: n(r.connector_id), station_id: n(r.station_id), label: r.label || "", uom: r.uom || "" })), selected_timeseries_id: selected, debug: { selected_connector_id: selectedConnectorId ? Number(selectedConnectorId) : null, r2_lookup_key_or_filter: r2Params, r2_row_count: r2Observs.length, r2_aqi_row_count: r2Aqi.length, obsaqidb_aqi_row_count: ingestAqi.length, aqi_row_count: r2Aqi.length + ingestAqi.length, aqi_overlap_detected: merged.overlap_detected }, ...merged }, 200, "no-store");
}
