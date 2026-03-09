import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { hasRequiredR2Config, r2HeadObject } from "../shared/r2_sigv4.mjs";

const AQILEVELS_TIME_ZONE = "Europe/London";

const RPC_SCHEMA = "uk_aq_public";
const RPC_DROP_CANDIDATES = "uk_aq_rpc_aqilevels_drop_candidates";
const RPC_DROP_DAY = "uk_aq_rpc_aqilevels_drop_day";

const DEFAULT_AQILEVELS_RETENTION_DAYS = 14;
const DEFAULT_DROP_DRY_RUN = false;

const LONDON_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: AQILEVELS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LONDON_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: AQILEVELS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function nowIso() {
  return new Date().toISOString();
}

function logStructured(severity, event, details = {}) {
  const entry = {
    severity,
    event,
    timestamp: nowIso(),
    ...details,
  };
  const line = JSON.stringify(entry);
  if (severity === "ERROR") {
    console.error(line);
    return;
  }
  if (severity === "WARNING") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}

function requiredEnvAny(names) {
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: one of ${names.join(", ")}`);
}

function normalizeIsoDate(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return "";
    }
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const isoDateMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return text.slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function partsToDate(parts) {
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function getLondonDateParts(date) {
  const parts = LONDON_DATE_FORMATTER.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
  };
}

function shiftLocalDateParts(parts, dayDelta) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(utcInstant, formatter) {
  const local = partsToDate(formatter.formatToParts(utcInstant));
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
  return asUtc - utcInstant.getTime();
}

function zonedLocalDateTimeToUtc(localParts, timeZoneFormatter) {
  const localEpochGuess = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour || 0,
    localParts.minute || 0,
    localParts.second || 0,
    0,
  );
  let utcEpoch = localEpochGuess;
  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(utcEpoch), timeZoneFormatter);
    const candidate = localEpochGuess - offsetMs;
    if (candidate === utcEpoch) {
      break;
    }
    utcEpoch = candidate;
  }
  return new Date(utcEpoch);
}

function computeRetentionCutoffUtc(now, retentionDays) {
  const londonToday = getLondonDateParts(now);
  const earliestKeptLocalDate = shiftLocalDateParts(londonToday, -retentionDays);
  return zonedLocalDateTimeToUtc(
    {
      year: earliestKeptLocalDate.year,
      month: earliestKeptLocalDate.month,
      day: earliestKeptLocalDate.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    LONDON_DATE_TIME_FORMATTER,
  );
}

function buildConfig(url) {
  const params = url.searchParams;

  const aqilevelsRetentionDays = parsePositiveInt(
    params.get("retentionDays") ?? process.env.OBS_AQIDB_AQILEVELS_RETENTION_DAYS,
    DEFAULT_AQILEVELS_RETENTION_DAYS,
    1,
    365,
  );

  const dropDryRun = parseBoolean(
    params.get("dropDryRun") ?? process.env.AQILEVELS_RETENTION_DROP_DRY_RUN,
    DEFAULT_DROP_DRY_RUN,
  );

  return {
    observsSupabaseUrl: requiredEnvAny(["OBS_AQIDB_SUPABASE_URL"]),
    observsSecretKey: requiredEnvAny(["OBS_AQIDB_SECRET_KEY"]),
    aqilevelsRetentionDays,
    dropDryRun,
    r2: {
      endpoint: (process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
      bucket: (process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
      access_key_id: (process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
      secret_access_key: (process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "").trim(),
      region: (process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
      aqilevels_prefix: (
        process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX
        || "history/v1/aqilevels"
      ).trim().replace(/^\/+|\/+$/g, ""),
    },
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function callRpc(client, fnName, params, errorLabel) {
  const { data, error } = await client.rpc(fnName, params);
  if (error) {
    throw new Error(`${errorLabel} failed: ${error.message}`);
  }
  return data || [];
}

function normalizeCandidate(row) {
  const dayUtc = normalizeIsoDate(row?.day_utc);
  const hourlyRows = Number(row?.hourly_rows || 0);
  const dailyRows = Number(row?.daily_rows || 0);

  return {
    day_utc: dayUtc,
    hourly_rows: Number.isFinite(hourlyRows) && hourlyRows > 0 ? hourlyRows : 0,
    daily_rows: Number.isFinite(dailyRows) && dailyRows > 0 ? dailyRows : 0,
  };
}

function normalizeDropResult(row) {
  const hourlyRowsDeleted = Number(row?.hourly_rows_deleted || 0);
  const dailyRowsDeleted = Number(row?.daily_rows_deleted || 0);

  return {
    hourly_rows_deleted: Number.isFinite(hourlyRowsDeleted) && hourlyRowsDeleted > 0 ? hourlyRowsDeleted : 0,
    daily_rows_deleted: Number.isFinite(dailyRowsDeleted) && dailyRowsDeleted > 0 ? dailyRowsDeleted : 0,
  };
}

async function headDayManifest(r2, dayUtc) {
  const manifestKey = `${r2.aqilevels_prefix}/day_utc=${dayUtc}/manifest.json`;
  const head = await r2HeadObject({
    r2,
    key: manifestKey,
  });

  if (!head.exists) {
    return {
      confirmed: false,
      method: "head_day_manifest",
      manifest_key: manifestKey,
      status: 404,
    };
  }

  return {
    confirmed: true,
    method: "head_day_manifest",
    manifest_key: manifestKey,
  };
}

async function historyManifestExists(dayUtc, r2) {
  try {
    const manifestResult = await headDayManifest(r2, dayUtc);
    if (manifestResult.confirmed) {
      return {
        confirmed: true,
        method: manifestResult.method,
        details: manifestResult,
      };
    }

    return {
      confirmed: false,
      reason: "history_manifest_not_confirmed",
      details: manifestResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      confirmed: false,
      reason: "history_manifest_check_error",
      details: {
        error: message,
      },
    };
  }
}

async function runAqilevelsRetention(config) {
  const runId = randomUUID();
  const client = createClient(config.observsSupabaseUrl, config.observsSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });

  if (!config.dropDryRun && !hasRequiredR2Config(config.r2)) {
    throw new Error("Missing required R2 History configuration for manifest-gated AQI retention.");
  }

  const now = new Date();
  const retentionCutoffUtc = computeRetentionCutoffUtc(now, config.aqilevelsRetentionDays);
  const retentionCutoffIso = retentionCutoffUtc.toISOString();
  const cutoffFloorDayUtc = retentionCutoffIso.slice(0, 10);

  logStructured("INFO", "aqilevels_retention_run_start", {
    run_id: runId,
    now_utc: now.toISOString(),
    aqilevels_retention_days: config.aqilevelsRetentionDays,
    retention_cutoff_utc: retentionCutoffIso,
    cutoff_floor_day_utc: cutoffFloorDayUtc,
    drop_dry_run: config.dropDryRun,
  });

  const dropCandidates = (await callRpc(
    client,
    RPC_DROP_CANDIDATES,
    {
      p_cutoff_day_utc: cutoffFloorDayUtc,
    },
    "aqilevels drop candidates",
  )).map(normalizeCandidate).filter((row) => row.day_utc);

  const dropped = [];
  const skipped = [];

  let totalHourlyRowsDeleted = 0;
  let totalDailyRowsDeleted = 0;

  for (const candidate of dropCandidates) {
    if (config.dropDryRun) {
      const skip = {
        day_utc: candidate.day_utc,
        reason: "drop_dry_run",
        candidate_hourly_rows: candidate.hourly_rows,
        candidate_daily_rows: candidate.daily_rows,
      };
      skipped.push(skip);
      logStructured("INFO", "aqilevels_retention_drop_dry_run_skip", {
        run_id: runId,
        ...skip,
      });
      continue;
    }

    const historyManifestCheck = await historyManifestExists(candidate.day_utc, config.r2);
    if (!historyManifestCheck.confirmed) {
      const skip = {
        day_utc: candidate.day_utc,
        reason: "history_manifest_not_confirmed",
        history_manifest_check: historyManifestCheck,
      };
      skipped.push(skip);
      logStructured("WARNING", "aqilevels_retention_drop_skipped", {
        run_id: runId,
        message: "SKIP DROP — history manifest not confirmed",
        ...skip,
      });
      continue;
    }

    const dropResultRows = await callRpc(
      client,
      RPC_DROP_DAY,
      {
        p_day_utc: candidate.day_utc,
      },
      `drop aqilevels day ${candidate.day_utc}`,
    );
    const dropResult = normalizeDropResult(dropResultRows?.[0]);

    totalHourlyRowsDeleted += dropResult.hourly_rows_deleted;
    totalDailyRowsDeleted += dropResult.daily_rows_deleted;

    dropped.push({
      day_utc: candidate.day_utc,
      hourly_rows_deleted: dropResult.hourly_rows_deleted,
      daily_rows_deleted: dropResult.daily_rows_deleted,
      history_manifest_method: historyManifestCheck.method,
    });

    logStructured("INFO", "aqilevels_retention_day_dropped", {
      run_id: runId,
      day_utc: candidate.day_utc,
      hourly_rows_deleted: dropResult.hourly_rows_deleted,
      daily_rows_deleted: dropResult.daily_rows_deleted,
      history_manifest_method: historyManifestCheck.method,
    });
  }

  const summary = {
    run_id: runId,
    now_utc: now.toISOString(),
    aqilevels_retention_days: config.aqilevelsRetentionDays,
    retention_cutoff_utc: retentionCutoffIso,
    cutoff_floor_day_utc: cutoffFloorDayUtc,
    drop_dry_run: config.dropDryRun,
    drop_candidate_count: dropCandidates.length,
    dropped_count: dropped.length,
    skipped_count: skipped.length,
    total_hourly_rows_deleted: totalHourlyRowsDeleted,
    total_daily_rows_deleted: totalDailyRowsDeleted,
    dropped_preview: dropped.slice(0, 50),
    skipped_preview: skipped.slice(0, 50),
  };

  logStructured("INFO", "aqilevels_retention_run_summary", summary);
  return summary;
}

const server = createServer(async (req, res) => {
  let requestPath = "/";
  let requestQuery = "";

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    requestPath = url.pathname;
    requestQuery = url.search || "";

    if (url.pathname === "/healthz") {
      jsonResponse(res, 200, { ok: true, now: nowIso() });
      return;
    }

    if (url.pathname !== "/run") {
      jsonResponse(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "method_not_allowed", message: "Use POST /run" });
      return;
    }

    const config = buildConfig(url);
    const summary = await runAqilevelsRetention(config);
    jsonResponse(res, 200, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logStructured("ERROR", "aqilevels_retention_run_error", {
      message,
      request_method: req.method || "",
      request_path: requestPath,
      request_query: requestQuery,
    });

    jsonResponse(res, 500, {
      error: "aqilevels_retention_run_error",
      message,
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8080, 1, 65535);
server.listen(port, () => {
  logStructured("INFO", "aqilevels_retention_service_started", {
    port,
    defaults: {
      aqilevels_retention_days: DEFAULT_AQILEVELS_RETENTION_DAYS,
      drop_dry_run: DEFAULT_DROP_DRY_RUN,
    },
  });
});
