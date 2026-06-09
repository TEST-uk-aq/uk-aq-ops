#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";

import {
  resolvePhaseBRuntimeConfig,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_PREFIX = "aqi-r2-test/v1";
const DEFAULT_HOURLY_DAYS = 2;
const DEFAULT_DAILY_DAYS = 14;
const DEFAULT_MONTHLY_MONTHS = 6;
const DEFAULT_STATION_LIMIT = 6;
const DEFAULT_PCON_LIMIT = 4;
const DEFAULT_LA_LIMIT = 4;
const DEFAULT_REGION_LIMIT = 8;

let parquetInitialized = false;

function usage() {
  console.log(`
Usage: node scripts/backup_r2/uk_aq_aqi_history_r2_test_seed.mjs [options]

Options:
  --prefix <path>           R2 prefix (default: ${DEFAULT_PREFIX})
  --dry-run                 Build datasets but do not upload to R2
  --hourly-days <n>         Hourly test window in days (default: ${DEFAULT_HOURLY_DAYS})
  --daily-days <n>          Daily test window in days (default: ${DEFAULT_DAILY_DAYS})
  --monthly-months <n>      Monthly test window in months (default: ${DEFAULT_MONTHLY_MONTHS})
  --station-limit <n>       Number of station entities (default: ${DEFAULT_STATION_LIMIT})
  --pcon-limit <n>          Number of pcon entities (default: ${DEFAULT_PCON_LIMIT})
  --la-limit <n>            Number of LA entities (default: ${DEFAULT_LA_LIMIT})
  --region-limit <n>        Number of region entities (default: ${DEFAULT_REGION_LIMIT})
  -h, --help                Show help

Required environment:
  OBS_AQIDB_SUPABASE_URL
  OBS_AQIDB_SECRET_KEY
  CFLARE_R2_* (or R2_*) vars for upload unless --dry-run
`);
}

function parsePositiveInt(raw, fallback, min = 1, max = 10000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function parseArgs(argv) {
  const out = {
    prefix: DEFAULT_PREFIX,
    dryRun: false,
    hourlyDays: DEFAULT_HOURLY_DAYS,
    dailyDays: DEFAULT_DAILY_DAYS,
    monthlyMonths: DEFAULT_MONTHLY_MONTHS,
    stationLimit: DEFAULT_STATION_LIMIT,
    pconLimit: DEFAULT_PCON_LIMIT,
    laLimit: DEFAULT_LA_LIMIT,
    regionLimit: DEFAULT_REGION_LIMIT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prefix") {
      out.prefix = String(argv[i + 1] || "").trim() || DEFAULT_PREFIX;
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--hourly-days") {
      out.hourlyDays = parsePositiveInt(argv[i + 1], DEFAULT_HOURLY_DAYS, 1, 366);
      i += 1;
      continue;
    }
    if (arg === "--daily-days") {
      out.dailyDays = parsePositiveInt(argv[i + 1], DEFAULT_DAILY_DAYS, 1, 365);
      i += 1;
      continue;
    }
    if (arg === "--monthly-months") {
      out.monthlyMonths = parsePositiveInt(argv[i + 1], DEFAULT_MONTHLY_MONTHS, 1, 60);
      i += 1;
      continue;
    }
    if (arg === "--station-limit") {
      out.stationLimit = parsePositiveInt(argv[i + 1], DEFAULT_STATION_LIMIT, 1, 50);
      i += 1;
      continue;
    }
    if (arg === "--pcon-limit") {
      out.pconLimit = parsePositiveInt(argv[i + 1], DEFAULT_PCON_LIMIT, 1, 50);
      i += 1;
      continue;
    }
    if (arg === "--la-limit") {
      out.laLimit = parsePositiveInt(argv[i + 1], DEFAULT_LA_LIMIT, 1, 50);
      i += 1;
      continue;
    }
    if (arg === "--region-limit") {
      out.regionLimit = parsePositiveInt(argv[i + 1], DEFAULT_REGION_LIMIT, 1, 50);
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  out.prefix = normalizePrefix(out.prefix || DEFAULT_PREFIX) || DEFAULT_PREFIX;
  return out;
}

function startOfUtcHour(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  ));
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
}

function startOfUtcMonth(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  ));
}

function isoHour(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  )).toISOString();
}

function isoDay(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  )).toISOString();
}

function isoMonth(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  )).toISOString();
}

function buildHourlyPeriods(days) {
  const hours = days * 24;
  const end = startOfUtcHour(new Date());
  const start = new Date(end.getTime() - (hours - 1) * 60 * 60 * 1000);
  const periods = [];
  for (let i = 0; i < hours; i += 1) {
    periods.push(isoHour(new Date(start.getTime() + i * 60 * 60 * 1000)));
  }
  return periods;
}

function buildDailyPeriods(days) {
  const end = startOfUtcDay(new Date());
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const periods = [];
  for (let i = 0; i < days; i += 1) {
    periods.push(isoDay(new Date(start.getTime() + i * 24 * 60 * 60 * 1000)));
  }
  return periods;
}

function buildMonthlyPeriods(months) {
  const end = startOfUtcMonth(new Date());
  const periods = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1, 0, 0, 0, 0));
    periods.push(isoMonth(d));
  }
  return periods;
}

function hashString(raw) {
  const text = String(raw);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicAqi({ scopeType, scopeId, grain, periodStartUtc }) {
  const seed = hashString(`${scopeType}|${scopeId}|${grain}|${periodStartUtc}`);
  const daqi = 1 + (seed % 10);
  const eaqi = 1 + ((seed >>> 8) % 6);
  return { daqi, eaqi, seed };
}

function compactName(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function slugify(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "entity";
}

function buildEntityFileName(entityId) {
  return `${slugify(entityId)}.parquet`;
}

function postgrestHeaders(key, schema) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "x-ukaq-egress-caller": "uk_aq_aqi_r2_test_seed",
    ...(schema ? { "Accept-Profile": schema } : {}),
  };
}

async function postgrestSelect({ baseUrl, key, schema, table, select, filters = {}, order = null, limit = null }) {
  const params = new URLSearchParams();
  params.set("select", select);
  if (order) params.set("order", order);
  if (limit !== null) params.set("limit", String(limit));
  for (const [k, v] of Object.entries(filters)) {
    params.set(k, v);
  }

  const response = await fetch(`${baseUrl}/rest/v1/${table}?${params.toString()}`, {
    method: "GET",
    headers: postgrestHeaders(key, schema),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload.message || payload.error || payload.hint || JSON.stringify(payload))
      : text;
    throw new Error(`PostgREST ${table} failed (${response.status}): ${String(message || "unknown error")}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(`PostgREST ${table} returned non-array payload`);
  }
  return payload;
}

function maxIndex(values) {
  let out = null;
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    out = out === null ? numeric : Math.max(out, numeric);
  }
  return out === null ? null : Math.trunc(out);
}

function toHourlyRealRecord(row) {
  const stationId = Number(row.station_id);
  const periodStartUtc = isoHour(new Date(String(row.timestamp_hour_utc)));
  const daqi = maxIndex([
    row.daqi_no2_index_level,
    row.daqi_pm25_rolling24h_index_level,
    row.daqi_pm10_rolling24h_index_level,
  ]);
  const eaqi = maxIndex([
    row.eaqi_no2_index_level,
    row.eaqi_pm25_index_level,
    row.eaqi_pm10_index_level,
  ]);
  if (!Number.isFinite(stationId) || !periodStartUtc || (daqi === null && eaqi === null)) {
    return null;
  }
  return {
    station_id: stationId,
    period_start_utc: periodStartUtc,
    daqi_index_level: daqi,
    eaqi_index_level: eaqi,
  };
}

function ensureParquetInit() {
  if (parquetInitialized) {
    return;
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.resolve(moduleDir, "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  parquetWasm.initSync({ module: wasmBytes });
  parquetInitialized = true;
}

function parquetWriterProps() {
  ensureParquetInit();
  return new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.UNCOMPRESSED)
    .build();
}

function rowsToParquetBuffer(rows) {
  ensureParquetInit();
  const table = arrow.tableFromArrays({
    scope_type: rows.map((r) => r.scope_type),
    scope_id: rows.map((r) => r.scope_id),
    scope_name: rows.map((r) => r.scope_name),
    grain: rows.map((r) => r.grain),
    period_start_utc: rows.map((r) => r.period_start_utc),
    daqi_index_level: rows.map((r) => r.daqi_index_level),
    eaqi_index_level: rows.map((r) => r.eaqi_index_level),
    station_count: rows.map((r) => (r.station_count === null ? null : r.station_count)),
    source_type: rows.map((r) => r.source_type),
    debug_seed: rows.map((r) => (r.debug_seed === null ? null : r.debug_seed)),
    generated_at_utc: rows.map((r) => r.generated_at_utc),
  });
  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const bytes = parquetWasm.writeParquet(wasmTable, parquetWriterProps());
  return Buffer.from(bytes);
}

function buildStationEntities(stationRows, stationLimit) {
  return stationRows.slice(0, stationLimit).map((row) => ({
    scope_id: String(row.id),
    scope_name: compactName(row.station_name, compactName(row.label, `Station ${row.id}`)),
  }));
}

function distinctValues(rows, key) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const value = String(row?.[key] || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function withFallbackEntities(realIds, { prefix, limit, labelPrefix }) {
  const out = realIds.slice(0, limit).map((id) => ({
    scope_id: id,
    scope_name: id,
  }));
  while (out.length < limit) {
    const nextIndex = out.length + 1;
    const scopeId = `${prefix}_${String(nextIndex).padStart(3, "0")}`;
    out.push({
      scope_id: scopeId,
      scope_name: `${labelPrefix} ${nextIndex}`,
    });
  }
  return out;
}

function normalizeEntityMap(entities) {
  const map = new Map();
  for (const entity of entities) {
    map.set(entity.scope_id, entity);
  }
  return map;
}

function buildEmptyDatasetRow({ scopeType, scopeId, scopeName, grain, periodStartUtc, stationCountHint, generatedAtUtc }) {
  const synthetic = deterministicAqi({
    scopeType,
    scopeId,
    grain,
    periodStartUtc,
  });
  return {
    scope_type: scopeType,
    scope_id: String(scopeId),
    scope_name: String(scopeName),
    grain,
    period_start_utc: periodStartUtc,
    daqi_index_level: synthetic.daqi,
    eaqi_index_level: synthetic.eaqi,
    station_count: stationCountHint,
    source_type: "synthetic",
    debug_seed: synthetic.seed,
    generated_at_utc: generatedAtUtc,
  };
}

function hourlyAreaRealAggregate({ scopeType, entityId, periodStartUtc, areaHourlyMap }) {
  const key = `${entityId}|${periodStartUtc}`;
  const aggregate = areaHourlyMap.get(key);
  if (!aggregate || aggregate.count <= 0) {
    return null;
  }
  const daqi = Math.max(1, Math.min(10, Math.round(aggregate.sumDaqi / aggregate.count)));
  const eaqi = Math.max(1, Math.min(6, Math.round(aggregate.sumEaqi / aggregate.count)));
  return {
    scope_type: scopeType,
    scope_id: String(entityId),
    scope_name: aggregate.scopeName,
    grain: "hourly",
    period_start_utc: periodStartUtc,
    daqi_index_level: daqi,
    eaqi_index_level: eaqi,
    station_count: aggregate.stationCount,
    source_type: "real",
    debug_seed: null,
    generated_at_utc: aggregate.generatedAtUtc,
  };
}

function buildScopeDatasets({
  scopeType,
  entities,
  hourlyPeriods,
  dailyPeriods,
  monthlyPeriods,
  hourlyRealByKey,
  areaHourlyMap,
  generatedAtUtc,
}) {
  const datasets = [];

  for (const entity of entities) {
    const scopeId = String(entity.scope_id);
    const scopeName = String(entity.scope_name);
    const stationCountHint = scopeType === "station" ? null : (Number(entity.station_count_hint) || null);

    const hourlyRows = hourlyPeriods.map((periodStartUtc) => {
      if (scopeType === "station") {
        const real = hourlyRealByKey.get(`${scopeId}|${periodStartUtc}`);
        if (real) {
          return {
            scope_type: scopeType,
            scope_id: scopeId,
            scope_name: scopeName,
            grain: "hourly",
            period_start_utc: periodStartUtc,
            daqi_index_level: real.daqi_index_level,
            eaqi_index_level: real.eaqi_index_level,
            station_count: null,
            source_type: "real",
            debug_seed: null,
            generated_at_utc: generatedAtUtc,
          };
        }
      } else {
        const areaReal = hourlyAreaRealAggregate({
          scopeType,
          entityId: scopeId,
          periodStartUtc,
          areaHourlyMap,
        });
        if (areaReal) {
          return areaReal;
        }
      }

      return buildEmptyDatasetRow({
        scopeType,
        scopeId,
        scopeName,
        grain: "hourly",
        periodStartUtc,
        stationCountHint,
        generatedAtUtc,
      });
    });

    const dailyRows = dailyPeriods.map((periodStartUtc) => buildEmptyDatasetRow({
      scopeType,
      scopeId,
      scopeName,
      grain: "daily",
      periodStartUtc,
      stationCountHint,
      generatedAtUtc,
    }));

    const monthlyRows = monthlyPeriods.map((periodStartUtc) => buildEmptyDatasetRow({
      scopeType,
      scopeId,
      scopeName,
      grain: "monthly",
      periodStartUtc,
      stationCountHint,
      generatedAtUtc,
    }));

    datasets.push({ scopeType, scopeId, scopeName, grain: "hourly", rows: hourlyRows });
    datasets.push({ scopeType, scopeId, scopeName, grain: "daily", rows: dailyRows });
    datasets.push({ scopeType, scopeId, scopeName, grain: "monthly", rows: monthlyRows });
  }

  return datasets;
}

function summarizeDatasets(datasets) {
  const byScopeGrain = {};
  for (const dataset of datasets) {
    const key = `${dataset.scopeType}:${dataset.grain}`;
    if (!byScopeGrain[key]) {
      byScopeGrain[key] = {
        scope: dataset.scopeType,
        grain: dataset.grain,
        files: 0,
        rows: 0,
      };
    }
    byScopeGrain[key].files += 1;
    byScopeGrain[key].rows += dataset.rows.length;
  }
  return Object.values(byScopeGrain).sort((a, b) => `${a.scope}:${a.grain}`.localeCompare(`${b.scope}:${b.grain}`));
}

async function uploadJson({ r2, key, payload, dryRun }) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (dryRun) {
    return { key, bytes: body.byteLength, etag: null, dry_run: true };
  }
  return r2PutObject({
    r2,
    key,
    body,
    content_type: "application/json",
  });
}

async function uploadParquet({ r2, key, rows, dryRun }) {
  const parquetBuffer = rowsToParquetBuffer(rows);
  if (dryRun) {
    return { key, bytes: parquetBuffer.byteLength, etag: null, dry_run: true };
  }
  return r2PutObject({
    r2,
    key,
    body: parquetBuffer,
    content_type: "application/vnd.apache.parquet",
  });
}

async function fetchStationHourlyRows({ baseUrl, key, sinceIso }) {
  const rows = await postgrestSelect({
    baseUrl,
    key,
    schema: "uk_aq_public",
    table: "uk_aq_timeseries_aqi_hourly",
    select: [
      "station_id",
      "timestamp_hour_utc",
      "daqi_no2_index_level",
      "daqi_pm25_rolling24h_index_level",
      "daqi_pm10_rolling24h_index_level",
      "eaqi_no2_index_level",
      "eaqi_pm25_index_level",
      "eaqi_pm10_index_level",
    ].join(","),
    filters: {
      timestamp_hour_utc: `gte.${sinceIso}`,
    },
    order: "timestamp_hour_utc.asc",
    limit: 50000,
  });
  return rows
    .map(toHourlyRealRecord)
    .filter((row) => row !== null);
}

async function fetchStationsByIds({ baseUrl, key, stationIds }) {
  if (!stationIds.length) return [];
  const idFilter = `in.(${stationIds.join(",")})`;
  const rows = await postgrestSelect({
    baseUrl,
    key,
    schema: "uk_aq_core",
    table: "stations",
    select: "id,station_name,label,pcon_code,la_code,region",
    filters: { id: idFilter },
    order: "id.asc",
    limit: stationIds.length,
  });
  return rows;
}

function rankStationIds(realHourlyRows) {
  const counter = new Map();
  for (const row of realHourlyRows) {
    const key = String(row.station_id);
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stationId]) => Number(stationId));
}

function buildHourlyRealMaps({ realRows, selectedStationIdSet, stationById, generatedAtUtc }) {
  const stationHourlyMap = new Map();
  const pconAreaMap = new Map();
  const laAreaMap = new Map();
  const regionAreaMap = new Map();

  function accumulate(map, scopeName, scopeId, periodStartUtc, daqi, eaqi) {
    if (!scopeId) return;
    const key = `${scopeId}|${periodStartUtc}`;
    const existing = map.get(key) || {
      scopeName,
      sumDaqi: 0,
      sumEaqi: 0,
      count: 0,
      stationIds: new Set(),
      generatedAtUtc,
    };
    existing.sumDaqi += daqi;
    existing.sumEaqi += eaqi;
    existing.count += 1;
    map.set(key, existing);
  }

  for (const row of realRows) {
    const stationId = Number(row.station_id);
    if (!selectedStationIdSet.has(stationId)) continue;

    const daqi = Number(row.daqi_index_level);
    const eaqi = Number(row.eaqi_index_level);
    const periodStartUtc = String(row.period_start_utc);
    const stationKey = `${stationId}|${periodStartUtc}`;

    stationHourlyMap.set(stationKey, {
      daqi_index_level: Math.max(1, Math.min(10, Math.trunc(daqi))),
      eaqi_index_level: Math.max(1, Math.min(6, Math.trunc(eaqi))),
    });

    const station = stationById.get(stationId);
    if (!station) continue;

    if (station.pcon_code) {
      const key = `${station.pcon_code}|${periodStartUtc}`;
      const existing = pconAreaMap.get(key) || {
        scopeName: station.pcon_code,
        sumDaqi: 0,
        sumEaqi: 0,
        count: 0,
        stationIds: new Set(),
        generatedAtUtc,
      };
      existing.sumDaqi += daqi;
      existing.sumEaqi += eaqi;
      existing.count += 1;
      existing.stationIds.add(stationId);
      pconAreaMap.set(key, existing);
    }

    if (station.la_code) {
      const key = `${station.la_code}|${periodStartUtc}`;
      const existing = laAreaMap.get(key) || {
        scopeName: station.la_code,
        sumDaqi: 0,
        sumEaqi: 0,
        count: 0,
        stationIds: new Set(),
        generatedAtUtc,
      };
      existing.sumDaqi += daqi;
      existing.sumEaqi += eaqi;
      existing.count += 1;
      existing.stationIds.add(stationId);
      laAreaMap.set(key, existing);
    }

    if (station.region) {
      const key = `${station.region}|${periodStartUtc}`;
      const existing = regionAreaMap.get(key) || {
        scopeName: station.region,
        sumDaqi: 0,
        sumEaqi: 0,
        count: 0,
        stationIds: new Set(),
        generatedAtUtc,
      };
      existing.sumDaqi += daqi;
      existing.sumEaqi += eaqi;
      existing.count += 1;
      existing.stationIds.add(stationId);
      regionAreaMap.set(key, existing);
    }
  }

  for (const map of [pconAreaMap, laAreaMap, regionAreaMap]) {
    for (const value of map.values()) {
      value.stationCount = value.stationIds.size;
      delete value.stationIds;
    }
  }

  return {
    stationHourlyMap,
    pconAreaMap,
    laAreaMap,
    regionAreaMap,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const obsAqiBaseUrl = String(process.env.OBS_AQIDB_SUPABASE_URL || "").trim().replace(/\/$/, "");
  const obsAqiKey = String(process.env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!obsAqiBaseUrl || !obsAqiKey) {
    throw new Error("Missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY.");
  }

  const runtime = resolvePhaseBRuntimeConfig(process.env);
  if (!args.dryRun && !hasRequiredR2Config(runtime.r2)) {
    throw new Error("Missing R2 configuration; set CFLARE_R2_* (or R2_*) vars.");
  }

  const generatedAtUtc = new Date().toISOString();
  const hourlyPeriods = buildHourlyPeriods(args.hourlyDays);
  const dailyPeriods = buildDailyPeriods(args.dailyDays);
  const monthlyPeriods = buildMonthlyPeriods(args.monthlyMonths);

  const hourlySinceIso = hourlyPeriods[0];
  const allHourlyRows = await fetchStationHourlyRows({
    baseUrl: obsAqiBaseUrl,
    key: obsAqiKey,
    sinceIso: hourlySinceIso,
  });

  const rankedStationIds = rankStationIds(allHourlyRows);
  const selectedStationIds = rankedStationIds.slice(0, args.stationLimit);

  const selectedStationRows = await fetchStationsByIds({
    baseUrl: obsAqiBaseUrl,
    key: obsAqiKey,
    stationIds: selectedStationIds,
  });

  if (!selectedStationRows.length) {
    throw new Error("No station metadata found for real hourly AQI sample.");
  }

  const stationEntities = buildStationEntities(selectedStationRows, args.stationLimit);
  const stationById = new Map(selectedStationRows.map((row) => [Number(row.id), row]));
  const selectedStationIdSet = new Set(stationEntities.map((s) => Number(s.scope_id)));

  const realMaps = buildHourlyRealMaps({
    realRows: allHourlyRows,
    selectedStationIdSet,
    stationById,
    generatedAtUtc,
  });

  const pconRealIds = distinctValues(selectedStationRows, "pcon_code");
  const laRealIds = distinctValues(selectedStationRows, "la_code");
  const regionRealIds = distinctValues(selectedStationRows, "region");

  const pconEntities = withFallbackEntities(pconRealIds, {
    prefix: "PCON",
    limit: args.pconLimit,
    labelPrefix: "PCON",
  });
  const laEntities = withFallbackEntities(laRealIds, {
    prefix: "LA",
    limit: args.laLimit,
    labelPrefix: "Local Authority",
  });
  const regionEntities = withFallbackEntities(regionRealIds, {
    prefix: "region",
    limit: Math.max(1, Math.min(args.regionLimit, 12)),
    labelPrefix: "Region",
  });

  for (const entity of pconEntities) {
    const stationCountHint = selectedStationRows.filter((row) => String(row.pcon_code || "") === entity.scope_id).length;
    entity.station_count_hint = stationCountHint || 3;
  }
  for (const entity of laEntities) {
    const stationCountHint = selectedStationRows.filter((row) => String(row.la_code || "") === entity.scope_id).length;
    entity.station_count_hint = stationCountHint || 4;
  }
  for (const entity of regionEntities) {
    const stationCountHint = selectedStationRows.filter((row) => String(row.region || "") === entity.scope_id).length;
    entity.station_count_hint = stationCountHint || 5;
  }

  const datasets = [
    ...buildScopeDatasets({
      scopeType: "station",
      entities: stationEntities,
      hourlyPeriods,
      dailyPeriods,
      monthlyPeriods,
      hourlyRealByKey: realMaps.stationHourlyMap,
      areaHourlyMap: new Map(),
      generatedAtUtc,
    }),
    ...buildScopeDatasets({
      scopeType: "pcon",
      entities: pconEntities,
      hourlyPeriods,
      dailyPeriods,
      monthlyPeriods,
      hourlyRealByKey: new Map(),
      areaHourlyMap: realMaps.pconAreaMap,
      generatedAtUtc,
    }),
    ...buildScopeDatasets({
      scopeType: "la",
      entities: laEntities,
      hourlyPeriods,
      dailyPeriods,
      monthlyPeriods,
      hourlyRealByKey: new Map(),
      areaHourlyMap: realMaps.laAreaMap,
      generatedAtUtc,
    }),
    ...buildScopeDatasets({
      scopeType: "region",
      entities: regionEntities,
      hourlyPeriods,
      dailyPeriods,
      monthlyPeriods,
      hourlyRealByKey: new Map(),
      areaHourlyMap: realMaps.regionAreaMap,
      generatedAtUtc,
    }),
  ];

  const uploadedObjects = [];
  const manifestEntries = [];
  const scopeGrainManifestMap = new Map();

  for (const dataset of datasets) {
    const objectKey = `${args.prefix}/${dataset.scopeType}/${dataset.grain}/${buildEntityFileName(dataset.scopeId)}`;
    const result = await uploadParquet({
      r2: runtime.r2,
      key: objectKey,
      rows: dataset.rows,
      dryRun: args.dryRun,
    });
    uploadedObjects.push(result);

    const sourceTypes = Array.from(new Set(dataset.rows.map((row) => row.source_type))).sort();
    const stationCountValues = dataset.rows
      .map((row) => row.station_count)
      .filter((value) => value !== null && value !== undefined);

    const entry = {
      scope: dataset.scopeType,
      grain: dataset.grain,
      entity_id: dataset.scopeId,
      entity_name: dataset.scopeName,
      fetch_path: objectKey,
      row_count: dataset.rows.length,
      source_types: sourceTypes,
      station_count_min: stationCountValues.length ? Math.min(...stationCountValues) : null,
      station_count_max: stationCountValues.length ? Math.max(...stationCountValues) : null,
      generated_at_utc: generatedAtUtc,
    };

    manifestEntries.push(entry);

    const scopeGrainKey = `${dataset.scopeType}:${dataset.grain}`;
    const bucket = scopeGrainManifestMap.get(scopeGrainKey) || [];
    bucket.push(entry);
    scopeGrainManifestMap.set(scopeGrainKey, bucket);
  }

  manifestEntries.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    if (a.grain !== b.grain) return a.grain.localeCompare(b.grain);
    return a.entity_name.localeCompare(b.entity_name);
  });

  const rootManifest = {
    version: "v1",
    generated_at_utc: generatedAtUtc,
    prefix: args.prefix,
    dataset_count: manifestEntries.length,
    entities: manifestEntries,
  };

  const manifestUploads = [];
  manifestUploads.push(await uploadJson({
    r2: runtime.r2,
    key: `${args.prefix}/manifest.json`,
    payload: rootManifest,
    dryRun: args.dryRun,
  }));

  for (const [scopeGrainKey, entries] of scopeGrainManifestMap.entries()) {
    const [scope, grain] = scopeGrainKey.split(":");
    const payload = {
      version: "v1",
      generated_at_utc: generatedAtUtc,
      prefix: args.prefix,
      scope,
      grain,
      dataset_count: entries.length,
      entities: entries,
    };
    manifestUploads.push(await uploadJson({
      r2: runtime.r2,
      key: `${args.prefix}/${scope}/${grain}/manifest.json`,
      payload,
      dryRun: args.dryRun,
    }));
  }

  const parquetBytes = uploadedObjects.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  const manifestBytes = manifestUploads.reduce((sum, row) => sum + Number(row.bytes || 0), 0);

  console.log(JSON.stringify({
    ok: true,
    dry_run: args.dryRun,
    generated_at_utc: generatedAtUtc,
    prefix: args.prefix,
    hourly_periods: hourlyPeriods.length,
    daily_periods: dailyPeriods.length,
    monthly_periods: monthlyPeriods.length,
    selected_station_ids: stationEntities.map((s) => s.scope_id),
    selected_scope_counts: {
      station: stationEntities.length,
      pcon: pconEntities.length,
      la: laEntities.length,
      region: regionEntities.length,
    },
    dataset_summary: summarizeDatasets(datasets),
    parquet_objects_written: uploadedObjects.length,
    manifest_objects_written: manifestUploads.length,
    parquet_bytes: parquetBytes,
    manifest_bytes: manifestBytes,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
