#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  UKAIR_BC_HISTORY_START_DAY,
  UKAIR_BC_PROPERTIES,
  buildUkAirBlackCarbonAnnualUrl,
  normalizeSiteRef,
  normalizeUkaRef,
  parseUkAirBlackCarbonAnnualCsv,
  requiredBlackCarbonAnnualSourceYears,
  routeBlackCarbonSelectedScopes,
  sha256Hex,
} from "./uk_air_black_carbon_source.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECONCILER_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");
const LOCK_COORDINATOR_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
);
const LOCKED_RECONCILER_PATH = path.join(
  SCRIPT_DIR,
  "uk_aq_ukair_bc_observation_reconciler_locked.mjs",
);
const LOCK_OWNER = "ukair_bc_observation_reconciler";
const REPORT_SCOPE_SAMPLE_LIMIT = 200;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_RETRIES = 3;
const DEFAULT_DAILY_HORIZON_DAYS = 14;
const ALL_UTC_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));

function usage() {
  return [
    "Usage:",
    "  node scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler.mjs --mode <selected|range|year|backfill|daily> [options]",
    "",
    "Selection:",
    "  --from <YYYY-MM-DD>        Required for selected/range mode",
    "  --to <YYYY-MM-DD>          Required for selected/range; optional backfill/daily end",
    "  --year <YYYY>              Required for year mode",
    "  --horizon-days <n>         Daily correction horizon (default: 14)",
    "  --station <UKAxxxxx,...>   Repeatable/comma-separated station narrowing",
    "  --property <bc|uv370,...>  Repeatable/comma-separated; default both",
    "",
    "Execution:",
    "  --dry-run                  Acquire, pin, parse and report without R2 access (default)",
    "  --apply                    Enter the shared global lock and reconcile canonical R2",
    "  --environment TEST         Required TEST identity (default: TEST)",
    "  --run-id <id>              Optional stable run identity",
    "  --evidence-root <path>     Parent directory for run evidence (default: tmp/...)",
    "  --download-concurrency <n> Bounded annual-file downloads (default: 4)",
    "  --download-timeout-ms <n>  Per-attempt timeout (default: 60000)",
    "  --download-retries <n>     Total attempts for retryable failures (default: 3)",
    "  -h, --help                 Show this help",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(raw, flag, { min = 1, max = 100_000 } = {}) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizeDay(raw, flag) {
  const value = String(raw || "").trim();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD UTC day`);
  }
  return value;
}

function addCsvValues(target, raw) {
  for (const value of String(raw || "").split(",")) {
    const normalized = value.trim();
    if (normalized) target.push(normalized);
  }
}

function yesterdayUtc(now = new Date()) {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  )).toISOString().slice(0, 10);
}

function shiftDay(dayUtc, offsetDays) {
  return new Date(Date.parse(`${dayUtc}T00:00:00.000Z`) + offsetDays * 86_400_000)
    .toISOString().slice(0, 10);
}

export function parseReconcilerArgs(argv, { now = new Date() } = {}) {
  const args = {
    mode: "",
    fromDay: "",
    toDay: "",
    year: null,
    horizonDays: DEFAULT_DAILY_HORIZON_DAYS,
    stationRefs: [],
    properties: [],
    apply: false,
    sawDryRun: false,
    environment: "TEST",
    runId: "",
    evidenceRoot: path.join(REPOSITORY_ROOT, "tmp/ukair_bc_observation_reconciler"),
    downloadConcurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
    downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    downloadRetries: DEFAULT_DOWNLOAD_RETRIES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return Object.freeze({ help: true });
    if (flag === "--mode") args.mode = requireValue(argv, index++, flag).toLowerCase();
    else if (flag === "--from") args.fromDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--to") args.toDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--year") {
      args.year = parsePositiveInteger(requireValue(argv, index++, flag), flag, { min: 2020, max: 9999 });
    } else if (flag === "--horizon-days") {
      args.horizonDays = parsePositiveInteger(requireValue(argv, index++, flag), flag, { min: 1, max: 3660 });
    } else if (flag === "--station") addCsvValues(args.stationRefs, requireValue(argv, index++, flag));
    else if (flag === "--property") addCsvValues(args.properties, requireValue(argv, index++, flag));
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.sawDryRun = true;
    else if (flag === "--environment") args.environment = requireValue(argv, index++, flag).toUpperCase();
    else if (flag === "--run-id") args.runId = requireValue(argv, index++, flag);
    else if (flag === "--evidence-root") args.evidenceRoot = path.resolve(requireValue(argv, index++, flag));
    else if (flag === "--download-concurrency") {
      args.downloadConcurrency = parsePositiveInteger(requireValue(argv, index++, flag), flag, { min: 1, max: 16 });
    } else if (flag === "--download-timeout-ms") {
      args.downloadTimeoutMs = parsePositiveInteger(requireValue(argv, index++, flag), flag, { min: 1_000, max: 600_000 });
    } else if (flag === "--download-retries") {
      args.downloadRetries = parsePositiveInteger(requireValue(argv, index++, flag), flag, { min: 1, max: 10 });
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.mode || !["selected", "range", "year", "backfill", "daily"].includes(args.mode)) {
    throw new Error("--mode must be selected, range, year, backfill or daily");
  }
  if (args.environment !== "TEST") throw new Error("This reconciler permits only --environment TEST");
  if (args.apply && args.sawDryRun) throw new Error("Use either --apply or --dry-run, not both");
  args.stationRefs = [...new Set(args.stationRefs.map((value) => normalizeUkaRef(value)))].sort();
  args.properties = args.properties.length
    ? [...new Set(args.properties.map((value) => {
        const property = value.trim().toLowerCase();
        if (!UKAIR_BC_PROPERTIES.includes(property)) {
          throw new Error("--property must be bc or uv370");
        }
        return property;
      }))].sort()
    : [...UKAIR_BC_PROPERTIES];
  const defaultEnd = yesterdayUtc(now);
  if (args.mode === "selected" || args.mode === "range") {
    if (!args.fromDay || !args.toDay) throw new Error(`${args.mode} mode requires --from and --to`);
    if (args.mode === "selected" && !args.stationRefs.length) {
      throw new Error("selected mode requires at least one --station");
    }
  } else if (args.mode === "year") {
    if (!args.year) throw new Error("year mode requires --year");
    const currentYear = now.getUTCFullYear();
    if (args.year > currentYear) throw new Error("year mode cannot select a future year");
    args.fromDay = `${args.year}-01-01`;
    args.toDay = args.year === currentYear ? defaultEnd : `${args.year}-12-31`;
  } else if (args.mode === "backfill") {
    if (args.fromDay || args.year) throw new Error("backfill mode always begins at 2020-01-01");
    args.fromDay = UKAIR_BC_HISTORY_START_DAY;
    args.toDay ||= defaultEnd;
  } else if (args.mode === "daily") {
    if (args.fromDay || args.year) throw new Error("daily mode derives --from from --horizon-days");
    args.toDay ||= defaultEnd;
    args.fromDay = shiftDay(args.toDay, -(args.horizonDays - 1));
  }
  if (args.fromDay < UKAIR_BC_HISTORY_START_DAY) {
    throw new Error(`Canonical Black Carbon history cannot begin before ${UKAIR_BC_HISTORY_START_DAY}`);
  }
  if (args.toDay < args.fromDay) throw new Error("--to must not be earlier than --from");
  if (args.toDay > new Date(now).toISOString().slice(0, 10)) {
    throw new Error("Selected date range cannot extend into the future");
  }
  args.runId ||= `ukair-bc-${new Date(now).toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}`;
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(args.runId)) {
    throw new Error("--run-id contains unsupported characters or is too short/long");
  }
  return Object.freeze({ ...args, help: false, apply: args.apply === true });
}

export function daysInclusive(fromDay, toDay) {
  const days = [];
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  for (
    let current = Date.parse(`${fromDay}T00:00:00.000Z`);
    current <= end;
    current += 86_400_000
  ) {
    days.push(new Date(current).toISOString().slice(0, 10));
  }
  return days;
}

export function buildBackfillYearRanges(toDay) {
  const normalizedToDay = normalizeDay(toDay, "--to");
  if (normalizedToDay < UKAIR_BC_HISTORY_START_DAY) {
    throw new Error(`Backfill cannot end before ${UKAIR_BC_HISTORY_START_DAY}`);
  }
  const ranges = [];
  const firstYear = Number(UKAIR_BC_HISTORY_START_DAY.slice(0, 4));
  const finalYear = Number(normalizedToDay.slice(0, 4));
  for (let year = firstYear; year <= finalYear; year += 1) {
    ranges.push(Object.freeze({
      year,
      from_day: year === firstYear ? UKAIR_BC_HISTORY_START_DAY : `${year}-01-01`,
      to_day: year === finalYear ? normalizedToDay : `${year}-12-31`,
    }));
  }
  return Object.freeze(ranges);
}

function requiredDatabaseUrl(env) {
  const value = String(env.SUPABASE_DB_URL || env.UK_AQ_INGEST_DATABASE_URL || "").trim();
  if (!value) throw new Error("SUPABASE_DB_URL (or UK_AQ_INGEST_DATABASE_URL) is required");
  return value;
}

function parseRawPayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("ukair_bc_station_refs.raw_payload is not valid JSON");
  }
}

export async function resolveBlackCarbonMetadata(client, { stationRefs, properties }) {
  const connectorResult = await client.query(
    `select id::integer as id, connector_code from uk_aq_core.connectors where connector_code = $1`,
    ["ukair_bc"],
  );
  if (connectorResult.rows.length !== 1) {
    throw new Error(`Expected exactly one ukair_bc connector, found ${connectorResult.rows.length}`);
  }
  const connectorId = Number(connectorResult.rows[0].id);
  const stationResult = await client.query(
    `
select
  s.id::bigint::text as station_id,
  upper(btrim(s.station_ref)) as uk_air_ref,
  s.service_ref,
  nullif(upper(btrim(b.uk_air_ref)), '') as bridge_uk_air_ref,
  nullif(upper(btrim(b.site_ref)), '') as site_ref,
  b.raw_payload
from uk_aq_core.stations s
left join uk_aq_raw.ukair_bc_station_refs b on b.station_id = s.id
where s.connector_id = $1::integer
  and s.service_ref = 'ukair_bc'
order by upper(btrim(s.station_ref)), s.id
`,
    [connectorId],
  );
  const stationByRef = new Map();
  for (const row of stationResult.rows) {
    const ukAirRef = normalizeUkaRef(row.uk_air_ref, "canonical station_ref");
    if (stationByRef.has(ukAirRef)) throw new Error(`Duplicate canonical station ${ukAirRef}`);
    if (row.bridge_uk_air_ref && row.bridge_uk_air_ref !== ukAirRef) {
      throw new Error(`Routing bridge contradicts canonical station ${ukAirRef}`);
    }
    const stationId = Number(row.station_id);
    if (!Number.isSafeInteger(stationId) || stationId <= 0) {
      throw new Error(`Canonical station ID is invalid for ${ukAirRef}`);
    }
    stationByRef.set(ukAirRef, {
      station_id: stationId,
      uk_air_ref: ukAirRef,
      site_ref: row.site_ref || null,
      raw_payload: parseRawPayload(row.raw_payload),
      timeseries: new Map(),
    });
  }
  const timeseriesResult = await client.query(
    `
select
  t.id::integer as timeseries_id,
  t.station_id::bigint::text as station_id,
  t.connector_id::integer as connector_id,
  t.service_ref,
  t.timeseries_ref,
  t.uom,
  lower(btrim(op.code)) as pollutant_code
from uk_aq_core.timeseries t
join uk_aq_core.phenomena p on p.id = t.phenomenon_id
join uk_aq_core.observed_properties op on op.id = p.observed_property_id
where t.connector_id = $1::integer
  and t.service_ref = 'ukair_bc'
  and lower(btrim(op.code)) = any($2::text[])
order by t.station_id, lower(btrim(op.code)), t.id
`,
    [connectorId, properties],
  );
  const stationById = new Map([...stationByRef.values()].map((station) => [station.station_id, station]));
  for (const row of timeseriesResult.rows) {
    const station = stationById.get(Number(row.station_id));
    if (!station) throw new Error(`Black Carbon timeseries has unknown station_id=${row.station_id}`);
    const property = String(row.pollutant_code || "").trim().toLowerCase();
    if (!properties.includes(property)) continue;
    if (station.timeseries.has(property)) {
      throw new Error(`Ambiguous ${property} timeseries mapping for ${station.uk_air_ref}`);
    }
    const expectedRef = `${station.uk_air_ref}:${property}`;
    const timeseriesId = Number(row.timeseries_id);
    if (
      row.connector_id !== connectorId || row.service_ref !== "ukair_bc" ||
      row.timeseries_ref !== expectedRef || String(row.uom || "").trim() !== "ug/m3" ||
      !Number.isSafeInteger(timeseriesId) || timeseriesId <= 0
    ) {
      throw new Error(`Contradictory canonical timeseries mapping for ${expectedRef}`);
    }
    station.timeseries.set(property, {
      timeseries_id: timeseriesId,
      timeseries_ref: expectedRef,
      pollutant_code: property,
    });
  }
  const requestedRefs = stationRefs.length ? stationRefs : [...stationByRef.keys()];
  const missingRequested = requestedRefs.filter((ref) => !stationByRef.has(ref));
  if (missingRequested.length) {
    throw new Error(`Selected canonical stations are missing: ${missingRequested.join(",")}`);
  }
  const selectedStations = requestedRefs.map((ref) => stationByRef.get(ref));
  if (!selectedStations.length) throw new Error("No canonical ukair_bc stations were resolved");
  return Object.freeze({
    connector_id: connectorId,
    selected_stations: Object.freeze(selectedStations),
    all_station_count: stationByRef.size,
    acquisition_ineligible_stations: Object.freeze(
      [...stationByRef.values()]
        .filter((station) => !station.site_ref)
        .map((station) => station.uk_air_ref)
        .sort(),
    ),
  });
}

function supportingFilesFor(station, property) {
  const values = station.raw_payload?.supporting_files?.[property];
  if (!Array.isArray(values)) return null;
  return new Set(values.map((value) => path.basename(String(value || "")).toUpperCase()));
}

export function planAnnualSourceRequests({ metadata, properties, requiredYears }) {
  const requests = [];
  const expectedAbsences = [];
  const metadataBlockers = [];
  for (const station of metadata.selected_stations) {
    for (const property of properties) {
      const timeseries = station.timeseries.get(property);
      const supportedProperties = new Set(
        Array.isArray(station.raw_payload?.supported_properties)
          ? station.raw_payload.supported_properties.map((value) => String(value).toLowerCase())
          : [],
      );
      if (!timeseries) {
        if (supportedProperties.has(property)) {
          metadataBlockers.push({
            uk_air_ref: station.uk_air_ref,
            source_property: property,
            reason: "source-supported property has no canonical timeseries mapping",
          });
        }
        continue;
      }
      if (!station.site_ref) {
        metadataBlockers.push({
          uk_air_ref: station.uk_air_ref,
          source_property: property,
          reason: "authoritative site_ref is unresolved",
        });
        continue;
      }
      const siteRef = normalizeSiteRef(station.site_ref);
      const supportingFiles = supportingFilesFor(station, property);
      for (const sourceYear of requiredYears) {
        const sourceUrl = buildUkAirBlackCarbonAnnualUrl({
          siteRef,
          sourceProperty: property,
          sourceYear,
        });
        const basename = path.basename(new URL(sourceUrl).pathname).toUpperCase();
        const identity = `${station.uk_air_ref}\u0000${property}\u0000${sourceYear}`;
        const base = {
          identity,
          source_url: sourceUrl,
          uk_air_ref: station.uk_air_ref,
          site_ref: siteRef,
          source_property: property,
          source_year: sourceYear,
          station_id: station.station_id,
          timeseries_id: timeseries.timeseries_id,
        };
        if (supportingFiles && !supportingFiles.has(basename)) {
          expectedAbsences.push({
            ...base,
            status: "expected_absence",
            authority: "ukair_bc_station_refs.raw_payload.supporting_files",
          });
        } else requests.push(base);
      }
    }
  }
  return Object.freeze({
    requests: Object.freeze(requests),
    expectedAbsences: Object.freeze(expectedAbsences),
    metadataBlockers: Object.freeze(metadataBlockers),
  });
}

async function wait(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchAnnualSource(request, {
  fetchImpl = fetch,
  timeoutMs,
  retries,
  userAgent,
}) {
  let finalError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.source_url, {
        headers: { "user-agent": userAgent, accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`UK-AIR HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return Object.freeze({
        bytes,
        etag: response.headers.get("etag") || null,
        last_modified: response.headers.get("last-modified") || null,
        acquired_at_utc: new Date().toISOString(),
        attempt_count: attempt,
      });
    } catch (error) {
      finalError = error;
      const retryable = error?.name === "AbortError" || error?.retryable === true ||
        ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code);
      if (!retryable || attempt === retries) break;
      await wait(Math.min(5_000, 250 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw finalError || new Error("UK-AIR download failed");
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function pinSourceBytes(runDir, request, acquired) {
  const sha256 = sha256Hex(acquired.bytes);
  const directory = path.join(
    runDir,
    "source",
    request.uk_air_ref,
    request.source_property,
    String(request.source_year),
  );
  const pinnedPath = path.join(directory, `${sha256}.csv`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(pinnedPath, acquired.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await fs.readFile(pinnedPath);
    if (existing.byteLength !== acquired.bytes.byteLength || sha256Hex(existing) !== sha256) {
      throw new Error(`Existing pinned source identity is contradictory: ${pinnedPath}`);
    }
  }
  return Object.freeze({ sha256, pinnedPath });
}

async function acquireAndParseSources({ requests, args, runDir, fetchImpl = fetch }) {
  return await mapLimit(requests, args.downloadConcurrency, async (request) => {
    try {
      const acquired = await fetchAnnualSource(request, {
        fetchImpl,
        timeoutMs: args.downloadTimeoutMs,
        retries: args.downloadRetries,
        userAgent: "UK-AQ-TEST-ukair-bc-observation-reconciler/1",
      });
      const pinned = await pinSourceBytes(runDir, request, acquired);
      let parsed = null;
      let parseError = null;
      try {
        parsed = parseUkAirBlackCarbonAnnualCsv({
          bytes: acquired.bytes,
          sourceProperty: request.source_property,
          sourceYear: request.source_year,
          ukAirRef: request.uk_air_ref,
          siteRef: request.site_ref,
        });
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      return Object.freeze({
        ...request,
        status: "pinned",
        downloaded_byte_size: acquired.bytes.byteLength,
        sha256: pinned.sha256,
        source_supplied_date: parsed?.source_supplied_date || null,
        http_etag: acquired.etag,
        http_last_modified: acquired.last_modified,
        acquired_at_utc: acquired.acquired_at_utc,
        attempt_count: acquired.attempt_count,
        pinned_path: pinned.pinnedPath,
        parse_status: parsed ? "parsed" : "failed",
        parse_error: parseError,
        parsed,
      });
    } catch (error) {
      return Object.freeze({
        ...request,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function sourceIdentity(ukAirRef, property, year) {
  return `${ukAirRef}\u0000${property}\u0000${year}`;
}

function summarizeSourceEvidence(entry) {
  return {
    source_url: entry.source_url,
    uk_air_ref: entry.uk_air_ref,
    site_ref: entry.site_ref,
    source_property: entry.source_property,
    source_year: entry.source_year,
    status: entry.status,
    downloaded_byte_size: entry.downloaded_byte_size || null,
    sha256: entry.sha256 || null,
    source_supplied_date: entry.source_supplied_date || null,
    http_etag: entry.http_etag || null,
    http_last_modified: entry.http_last_modified || null,
    acquired_at_utc: entry.acquired_at_utc || null,
    pinned_path: entry.pinned_path || null,
    parse_status: entry.parse_status || null,
    parse_error: entry.parse_error || null,
    error: entry.error || null,
    source_rows: entry.parsed?.source_rows || 0,
    valid_observation_count: entry.parsed?.valid_observation_count || 0,
    missing_cell_count: entry.parsed?.missing_cell_count || 0,
    provisional_count: entry.parsed?.provisional_count || 0,
    ratified_count: entry.parsed?.ratified_count || 0,
    zero_count: entry.parsed?.zero_count || 0,
    source_date_count: entry.parsed?.source_date_count || 0,
    first_source_date: entry.parsed?.first_source_date || null,
    last_source_date: entry.parsed?.last_source_date || null,
    first_observed_at_utc: entry.parsed?.first_observed_at_utc || null,
    last_observed_at_utc: entry.parsed?.last_observed_at_utc || null,
  };
}

export function buildDesiredScopes({
  days,
  properties,
  metadata,
  requiredYearsByDay,
  acquisitionPlan,
  acquiredSources,
  currentYear = new Date().getUTCFullYear(),
}) {
  const acquiredByIdentity = new Map(acquiredSources.map((entry) => [entry.identity, entry]));
  const absenceByIdentity = new Map(
    acquisitionPlan.expectedAbsences.map((entry) => [entry.identity, entry]),
  );
  const blockerByStationProperty = new Map();
  for (const blocker of acquisitionPlan.metadataBlockers) {
    blockerByStationProperty.set(
      `${blocker.uk_air_ref}\u0000${blocker.source_property}`,
      blocker.reason,
    );
  }
  const scopes = [];
  for (const dayUtc of days) {
    for (const property of properties) {
      const rows = [];
      const blockers = [];
      const selectedTimeseriesAuthority = [];
      const temporarySourceGaps = [];
      const seenTimeseriesTimestamps = new Set();
      if (!metadata.selected_stations.some((station) => station.timeseries.has(property))) {
        blockers.push(`no selected station has a canonical ${property} timeseries mapping`);
      }
      for (const station of metadata.selected_stations) {
        const mapping = station.timeseries.get(property);
        if (!mapping) {
          const blocker = blockerByStationProperty.get(`${station.uk_air_ref}\u0000${property}`);
          if (blocker) blockers.push(`${station.uk_air_ref}: ${blocker}`);
          continue;
        }
        const metadataBlocker = blockerByStationProperty.get(
          `${station.uk_air_ref}\u0000${property}`,
        );
        if (metadataBlocker) {
          blockers.push(`${station.uk_air_ref}: ${metadataBlocker}`);
          continue;
        }
        const stationRows = [];
        let currentYearCoverage = null;
        let currentYearExpectedAbsence = null;
        for (const sourceYear of requiredYearsByDay.get(dayUtc)) {
          const identity = sourceIdentity(station.uk_air_ref, property, sourceYear);
          const expectedAbsence = absenceByIdentity.get(identity) || null;
          if (expectedAbsence) {
            if (sourceYear === currentYear && Number(dayUtc.slice(0, 4)) === currentYear) {
              currentYearExpectedAbsence = expectedAbsence;
            }
            continue;
          }
          const source = acquiredByIdentity.get(identity);
          if (!source || source.status !== "pinned" || source.parse_status !== "parsed") {
            blockers.push(
              `${station.uk_air_ref}/${property}/${sourceYear}: ${source?.parse_error || source?.error || "source unavailable"}`,
            );
            continue;
          }
          if (sourceYear === currentYear && Number(dayUtc.slice(0, 4)) === currentYear) {
            const sourceDates = new Set(source.parsed.source_date_days || []);
            const previousDay = shiftDay(dayUtc, -1);
            currentYearCoverage = Object.freeze({
              selected_source_date_present: sourceDates.has(dayUtc),
              previous_source_date_present:
                Number(previousDay.slice(0, 4)) !== currentYear || sourceDates.has(previousDay),
            });
          }
          for (const sourceRow of source.parsed.rows) {
            if (sourceRow.observed_at_utc.slice(0, 10) !== dayUtc) continue;
            stationRows.push(Object.freeze({
              connector_id: metadata.connector_id,
              station_id: station.station_id,
              timeseries_id: mapping.timeseries_id,
              pollutant_code: property,
              observed_at_utc: sourceRow.observed_at_utc,
              value: sourceRow.value,
              verification_status: sourceRow.verification_status,
            }));
          }
        }
        if (currentYearExpectedAbsence) {
          temporarySourceGaps.push(Object.freeze({
            station: station.uk_air_ref,
            station_id: station.station_id,
            timeseries_id: mapping.timeseries_id,
            timeseries_ref: mapping.timeseries_ref,
            property,
            canonical_day_utc: dayUtc,
            source_year: currentYear,
            source_identity: currentYearExpectedAbsence.identity,
            expected_annual_filename: path.basename(
              new URL(currentYearExpectedAbsence.source_url).pathname,
            ),
            reason: "temporary_current_year_source_file_not_listed",
          }));
          continue;
        }
        if (currentYearCoverage?.selected_source_date_present === false) {
          temporarySourceGaps.push(Object.freeze({
            station: station.uk_air_ref,
            station_id: station.station_id,
            timeseries_id: mapping.timeseries_id,
            timeseries_ref: mapping.timeseries_ref,
            property,
            canonical_day_utc: dayUtc,
            source_year: currentYear,
            missing_source_date: dayUtc,
            reason: "temporary_current_year_source_date_not_present",
          }));
          continue;
        }
        const authoritativeHours = currentYearCoverage
          ? [
              ...(currentYearCoverage.previous_source_date_present ? [0] : []),
              ...ALL_UTC_HOURS.slice(1),
            ]
          : ALL_UTC_HOURS;
        selectedTimeseriesAuthority.push(Object.freeze({
          timeseries_id: mapping.timeseries_id,
          authoritative_hours_utc: Object.freeze(authoritativeHours),
        }));
        const authoritativeHourSet = new Set(authoritativeHours);
        for (const row of stationRows) {
          const hourUtc = Number(row.observed_at_utc.slice(11, 13));
          if (!authoritativeHourSet.has(hourUtc)) continue;
          const duplicateKey = `${mapping.timeseries_id}\u0000${row.observed_at_utc}`;
          if (seenTimeseriesTimestamps.has(duplicateKey)) {
            blockers.push(`${station.uk_air_ref}/${property}: duplicate canonical timestamp`);
            continue;
          }
          seenTimeseriesTimestamps.add(duplicateKey);
          rows.push(row);
        }
      }
      rows.sort((left, right) =>
        left.observed_at_utc.localeCompare(right.observed_at_utc) ||
        left.timeseries_id - right.timeseries_id
      );
      scopes.push(Object.freeze({
        day_utc: dayUtc,
        connector_id: metadata.connector_id,
        pollutant_code: property,
        rows: Object.freeze(rows),
        selected_timeseries_authority: Object.freeze(selectedTimeseriesAuthority),
        temporary_source_gaps: Object.freeze(temporarySourceGaps),
        conclusive: blockers.length === 0,
        blocked_reason: blockers.length ? blockers.join("; ") : null,
      }));
    }
  }
  return routeBlackCarbonSelectedScopes(scopes);
}

function resolveGitSha(env) {
  const fromEnvironment = String(env.GITHUB_SHA || "").trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(fromEnvironment)) return fromEnvironment;
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Unable to resolve full writer Git SHA");
  return value;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function reportSourceTotals(evidence) {
  const parsed = evidence.filter((entry) => entry.parse_status === "parsed");
  const firstValues = parsed.map((entry) => entry.first_observed_at_utc).filter(Boolean).sort();
  const lastValues = parsed.map((entry) => entry.last_observed_at_utc).filter(Boolean).sort();
  const sum = (field) => parsed.reduce((total, entry) => total + Number(entry[field] || 0), 0);
  return {
    source_rows_parsed: sum("source_rows"),
    valid_observation_count: sum("valid_observation_count"),
    missing_cell_count: sum("missing_cell_count"),
    provisional_count: sum("provisional_count"),
    ratified_count: sum("ratified_count"),
    zero_count: sum("zero_count"),
    first_observed_at_utc: firstValues[0] || null,
    last_observed_at_utc: lastValues.at(-1) || null,
  };
}

function spawnCommand(command, commandArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Locked reconciliation terminated by ${signal}`));
      else resolve(Number(code || 0));
    });
  });
}

function backfillChildArgv(args, range, yearsRoot) {
  const childArgv = [
    "--mode", "range",
    "--from", range.from_day,
    "--to", range.to_day,
    "--environment", "TEST",
    "--run-id", `year-${range.year}`,
    "--evidence-root", yearsRoot,
    "--download-concurrency", String(args.downloadConcurrency),
    "--download-timeout-ms", String(args.downloadTimeoutMs),
    "--download-retries", String(args.downloadRetries),
    "--property", args.properties.join(","),
  ];
  if (args.stationRefs.length) childArgv.push("--station", args.stationRefs.join(","));
  childArgv.push(args.apply ? "--apply" : "--dry-run");
  return childArgv;
}

async function runBackfillYearProcess({ childArgv, env, reportPath }) {
  const code = await spawnCommand(process.execPath, [RECONCILER_PATH, ...childArgv], {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: "inherit",
  });
  let report = null;
  let report_read_error = null;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    report_read_error = error instanceof Error ? error.message : String(error);
  }
  return Object.freeze({ code, report, report_read_error });
}

function finiteReportCount(report, field) {
  const value = Number(report?.[field]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function summarizeBackfillYearResult({ range, status, reportPath, childReport, error }) {
  return {
    year: range.year,
    from_day: range.from_day,
    to_day: range.to_day,
    status,
    ok: status === "completed",
    report_path: childReport?.report_path || reportPath,
    source_files_successfully_pinned: finiteReportCount(
      childReport,
      "source_files_successfully_pinned",
    ),
    failed_blocked_scope_count: finiteReportCount(childReport, "failed_blocked_scope_count"),
    temporary_source_gap_count: finiteReportCount(childReport, "temporary_source_gap_count"),
    skipped_uncovered_scope_count: finiteReportCount(
      childReport,
      "skipped_uncovered_scope_count",
    ),
    non_empty_replacement_scope_count: finiteReportCount(
      childReport,
      "non_empty_replacement_scope_count",
    ),
    explicit_removal_scope_count: finiteReportCount(
      childReport,
      "explicit_removal_scope_count",
    ),
    unchanged_no_op_scope_count: finiteReportCount(childReport, "unchanged_no_op_scope_count"),
    r2_changed_scope_count: finiteReportCount(childReport, "r2_changed_scope_count"),
    child_final_status: childReport?.final_status || null,
    error: error || null,
  };
}

export async function runBackfillReconciliation({
  args,
  env,
  now,
  runYear = runBackfillYearProcess,
  clock = () => new Date(),
}) {
  const ranges = buildBackfillYearRanges(args.toDay);
  const runDir = path.join(args.evidenceRoot, args.runId);
  const yearsRoot = path.join(runDir, "years");
  const reportPath = path.join(runDir, "report.json");
  await fs.mkdir(args.evidenceRoot, { recursive: true });
  try {
    await fs.mkdir(runDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Run evidence directory already exists and will not be overwritten: ${runDir}`);
    }
    throw error;
  }
  await fs.mkdir(yearsRoot);

  const yearsSelected = ranges.map((range) => range.year);
  const report = {
    schema_version: 1,
    kind: "uk_aq_ukair_bc_observation_backfill_report",
    environment: "TEST",
    mode: "backfill",
    execution: args.apply ? "apply" : "dry_run",
    run_id: args.runId,
    selected_properties: args.properties,
    selected_stations: args.stationRefs,
    selected_utc_date_range: { from: UKAIR_BC_HISTORY_START_DAY, to: args.toDay },
    years_selected: yearsSelected,
    years_attempted: [],
    years_completed: [],
    years_failed: [],
    years_not_attempted: [...yearsSelected],
    current_or_failed_year: null,
    per_year_results: ranges.map((range) => summarizeBackfillYearResult({
      range,
      status: "not_attempted",
      reportPath: path.join(yearsRoot, `year-${range.year}`, "report.json"),
      childReport: null,
      error: null,
    })),
    final_status: "running",
    ok: false,
    started_at_utc: new Date(now).toISOString(),
    completed_at_utc: null,
    report_path: reportPath,
  };
  await writeJson(reportPath, report);

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const childReportPath = path.join(yearsRoot, `year-${range.year}`, "report.json");
    const childArgv = backfillChildArgv(args, range, yearsRoot);
    report.years_attempted.push(range.year);
    report.years_not_attempted = yearsSelected.filter(
      (year) => !report.years_attempted.includes(year),
    );
    report.current_or_failed_year = range.year;
    report.per_year_results[index] = summarizeBackfillYearResult({
      range,
      status: "running",
      reportPath: childReportPath,
      childReport: null,
      error: null,
    });
    await writeJson(reportPath, report);

    let outcome;
    let childError = null;
    try {
      outcome = await runYear({
        year: range.year,
        range,
        childArgv,
        env,
        reportPath: childReportPath,
      });
    } catch (error) {
      childError = error instanceof Error ? error.message : String(error);
      outcome = { code: null, report: null, report_read_error: null };
    }
    const childReport = outcome?.report || null;
    if (!report.selected_stations.length && Array.isArray(childReport?.selected_stations)) {
      report.selected_stations = [...childReport.selected_stations];
    }
    const completed = outcome?.code === 0 && childReport?.ok === true;
    if (completed) {
      report.years_completed.push(range.year);
      report.per_year_results[index] = summarizeBackfillYearResult({
        range,
        status: "completed",
        reportPath: childReportPath,
        childReport,
        error: null,
      });
      await writeJson(reportPath, report);
      continue;
    }

    const error = childError || outcome?.report_read_error ||
      `yearly reconciliation exited with code ${String(outcome?.code)}`;
    report.years_failed.push(range.year);
    report.per_year_results[index] = summarizeBackfillYearResult({
      range,
      status: "failed",
      reportPath: childReportPath,
      childReport,
      error,
    });
    report.final_status = "failed_year_reconciliation";
    break;
  }

  report.years_not_attempted = yearsSelected.filter(
    (year) => !report.years_attempted.includes(year),
  );
  report.completed_at_utc = new Date(clock()).toISOString();
  if (!report.years_failed.length && report.years_completed.length === yearsSelected.length) {
    report.current_or_failed_year = null;
    report.final_status = "completed";
    report.ok = true;
  }
  await writeJson(reportPath, report);
  return Object.freeze({ help: false, report });
}

export async function runLockedReconciliation({
  planPath,
  planSha256,
  runId,
  env,
  spawnImpl = spawnCommand,
}) {
  return await spawnImpl(process.execPath, [
    LOCK_COORDINATOR_PATH,
    "--owner",
    LOCK_OWNER,
    "--run-id",
    runId,
    "--",
    process.execPath,
    LOCKED_RECONCILER_PATH,
    "--plan",
    planPath,
    "--expected-plan-sha256",
    planSha256,
  ], {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: "inherit",
  });
}

async function withMetadataClient(databaseUrl, callback) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "uk-aq-ukair-bc-source-planner",
    statement_timeout: 60_000,
    query_timeout: 60_000,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export async function runBlackCarbonObservationReconciler({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  runBackfillYear,
  clock,
} = {}) {
  const args = parseReconcilerArgs(argv, { now });
  if (args.help) return Object.freeze({ help: true, text: usage() });
  const configuredEnvironment = String(env.UKAQ_ENV_NAME || env.UK_AQ_ENV_NAME || "TEST")
    .trim().toUpperCase();
  if (configuredEnvironment !== "TEST") throw new Error("Configured environment must be TEST");
  if (args.mode === "backfill") {
    return await runBackfillReconciliation({
      args,
      env,
      now,
      ...(runBackfillYear ? { runYear: runBackfillYear } : {}),
      ...(clock ? { clock } : {}),
    });
  }
  const days = daysInclusive(args.fromDay, args.toDay);
  const requiredYears = requiredBlackCarbonAnnualSourceYears(days);
  const requiredYearsByDay = new Map(days.map((day) => [
    day,
    requiredBlackCarbonAnnualSourceYears([day]).years,
  ]));
  const runDir = path.join(args.evidenceRoot, args.runId);
  const reportPath = path.join(runDir, "report.json");
  const planPath = path.join(runDir, "protected_plan.json");
  await fs.mkdir(args.evidenceRoot, { recursive: true });
  try {
    await fs.mkdir(runDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Run evidence directory already exists and will not be overwritten: ${runDir}`);
    }
    throw error;
  }
  const metadata = await withMetadataClient(
    requiredDatabaseUrl(env),
    async (client) => await resolveBlackCarbonMetadata(client, args),
  );
  const acquisitionPlan = planAnnualSourceRequests({
    metadata,
    properties: args.properties,
    requiredYears: requiredYears.years,
  });
  const acquiredSources = await acquireAndParseSources({
    requests: acquisitionPlan.requests,
    args,
    runDir,
    fetchImpl,
  });
  const routed = buildDesiredScopes({
    days,
    properties: args.properties,
    metadata,
    requiredYearsByDay,
    acquisitionPlan,
    acquiredSources,
    currentYear: now.getUTCFullYear(),
  });
  const sourceEvidence = acquiredSources
    .filter((entry) => entry.status === "pinned")
    .map(summarizeSourceEvidence);
  const allSourceEvidence = [
    ...acquiredSources.map(summarizeSourceEvidence),
    ...acquisitionPlan.expectedAbsences,
  ];
  const sourceTotals = reportSourceTotals(allSourceEvidence);
  const failures = [
    ...acquiredSources.filter((entry) => entry.status === "failed").map((entry) => ({
      stage: "source_acquisition",
      source_url: entry.source_url,
      error: entry.error,
    })),
    ...acquiredSources.filter((entry) => entry.parse_status === "failed").map((entry) => ({
      stage: "source_parsing",
      source_url: entry.source_url,
      error: entry.parse_error,
    })),
  ];
  const targetWriterGitSha = resolveGitSha(env);
  const report = {
    schema_version: 1,
    kind: "uk_aq_ukair_bc_observation_reconciliation_report",
    environment: "TEST",
    mode: args.mode,
    execution: args.apply ? "apply" : "dry_run",
    run_id: args.runId,
    started_at_utc: new Date(now).toISOString(),
    selected_stations: metadata.selected_stations.map((station) => station.uk_air_ref),
    selected_properties: args.properties,
    selected_utc_date_range: { from: args.fromDay, to: args.toDay },
    selected_day_count: days.length,
    required_annual_source_years: requiredYears,
    connector_code: "ukair_bc",
    resolved_connector_id: metadata.connector_id,
    canonical_station_count: metadata.all_station_count,
    acquisition_ineligible_stations: metadata.acquisition_ineligible_stations,
    source_files_requested: acquisitionPlan.requests.length,
    source_files_successfully_pinned: sourceEvidence.length,
    source_files_unavailable_or_failed: acquiredSources.filter((entry) => entry.status === "failed").length,
    source_files_expected_absent: acquisitionPlan.expectedAbsences.length,
    source_evidence: allSourceEvidence,
    ...sourceTotals,
    desired_scope_count: days.length * args.properties.length,
    desired_observation_count: routed.partitions.reduce(
      (sum, partition) => sum + partition.rows.length,
      0,
    ),
    source_selected_non_empty_scope_count: routed.partitions.length,
    source_selected_empty_scope_count: routed.removedScopes.length,
    temporary_source_gap_count: routed.temporarySourceGaps.length,
    temporary_source_gap_samples:
      routed.temporarySourceGaps.slice(0, REPORT_SCOPE_SAMPLE_LIMIT),
    skipped_uncovered_scope_count: routed.skippedUncoveredScopes.length,
    skipped_uncovered_scope_samples:
      routed.skippedUncoveredScopes.slice(0, REPORT_SCOPE_SAMPLE_LIMIT),
    non_empty_replacement_scope_count: routed.partitions.length,
    explicit_removal_scope_count: routed.removedScopes.length,
    unchanged_no_op_scope_count: 0,
    failed_blocked_scope_count: routed.blockedScopes.length,
    blocked_scope_samples: routed.blockedScopes.slice(0, REPORT_SCOPE_SAMPLE_LIMIT),
    r2_changed_scope_count: 0,
    failures,
    final_status: args.apply ? "ready_for_protected_r2_phase" :
      (routed.blockedScopes.length
        ? "dry_run_completed_with_blocked_scopes"
        : routed.skippedUncoveredScopes.length
          ? "dry_run_completed_with_skipped_uncovered_scopes"
          : "dry_run_completed"),
    ok: !args.apply && routed.blockedScopes.length === 0,
    report_path: reportPath,
  };
  const plan = {
    schema_version: 1,
    kind: "uk_aq_ukair_bc_observation_reconciliation_plan",
    environment: "TEST",
    run_id: args.runId,
    target_writer_git_sha: targetWriterGitSha,
    selected: {
      mode: args.mode,
      station_refs: report.selected_stations,
      properties: args.properties,
      from_day: args.fromDay,
      to_day: args.toDay,
    },
    source_evidence: sourceEvidence,
    partitions: routed.partitions,
    removed_scopes: routed.removedScopes,
    blocked_scope_count: routed.blockedScopes.length,
    blocked_scopes: routed.blockedScopes.slice(0, REPORT_SCOPE_SAMPLE_LIMIT),
    skipped_uncovered_scope_count: routed.skippedUncoveredScopes.length,
    skipped_uncovered_scopes:
      routed.skippedUncoveredScopes.slice(0, REPORT_SCOPE_SAMPLE_LIMIT),
    failures,
    report_path: reportPath,
  };
  await writeJson(reportPath, report);
  await writeJson(path.join(runDir, "source_evidence.json"), allSourceEvidence);
  await writeJson(planPath, plan);
  const planBytes = await fs.readFile(planPath);
  const planSha256 = sha256Hex(planBytes);
  report.protected_plan_sha256 = planSha256;
  await writeJson(reportPath, report);

  if (!args.apply) return Object.freeze({ help: false, report });
  if (!routed.partitions.length && !routed.removedScopes.length) {
    if (routed.blockedScopes.length === 0 && routed.skippedUncoveredScopes.length > 0) {
      report.ok = true;
      report.final_status = "completed_no_op_skipped_uncovered_scopes";
      report.completed_at_utc = new Date().toISOString();
      report.writer = {
        invoked: false,
        status: "no_authoritative_scopes",
        submitted_replacement_scope_count: 0,
        submitted_removal_scope_count: 0,
      };
    } else {
      report.ok = false;
      report.final_status = "failed_no_conclusive_scope";
    }
    await writeJson(reportPath, report);
    return Object.freeze({ help: false, report });
  }
  const code = await runLockedReconciliation({
    planPath,
    planSha256,
    runId: args.runId,
    env,
  });
  const finalReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (code !== 0) {
    finalReport.ok = false;
    finalReport.final_status = "failed_global_lock_or_protected_r2_phase";
    finalReport.failures = [
      ...(Array.isArray(finalReport.failures) ? finalReport.failures : []),
      {
        stage: "global_lock_or_protected_r2_phase",
        error: `protected coordinator exited with code ${code}`,
      },
    ];
    await writeJson(reportPath, finalReport);
  }
  return Object.freeze({ help: false, report: finalReport });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = await runBlackCarbonObservationReconciler();
    if (result.help) process.stdout.write(`${result.text}\n`);
    else {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      if (result.report.ok !== true) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema_version: 1,
      kind: "uk_aq_ukair_bc_observation_reconciliation_error",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
