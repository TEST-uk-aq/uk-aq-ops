#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const DEFAULT_SB_SECRET_KEY = String(process.env.SB_SECRET_KEY || "").trim();
const DEFAULT_SCHEMA = String(process.env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public").trim();
const DEFAULT_RPC = String(process.env.UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC || "uk_aq_latest_rpc").trim();
const DEFAULT_LIMIT_ROWS = parsePositiveInt(process.env.UK_AQ_LATEST_SNAPSHOT_LIMIT, 10000, 1, 10000);
const DEFAULT_POLLUTANTS = String(process.env.UK_AQ_LATEST_SNAPSHOT_POLLUTANTS || "pm25,pm10,no2")
  .split(",")
  .map((value) => normalizeMatrixPollutant(value))
  .filter(Boolean);
const DEFAULT_WINDOWS = String(process.env.UK_AQ_LATEST_SNAPSHOT_WINDOWS || "3h,6h,1d,7d,all")
  .split(",")
  .map((value) => normalizeWindow(value))
  .filter(Boolean);
const DEFAULT_STATE_PREFIX = normalizePrefix(
  process.env.UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX || "latest_snapshots_state/v1",
);
const DEFAULT_STATE_KEY = `${DEFAULT_STATE_PREFIX}/latest_state.json`;

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs [options]",
      "",
      "Required env (unless overridden by args):",
      "  SUPABASE_URL",
      "  SB_SECRET_KEY",
      "  CFLARE_R2_ENDPOINT (or R2_ENDPOINT)",
      "  CFLARE_R2_BUCKET (or R2_BUCKET)",
      "  CFLARE_R2_ACCESS_KEY_ID (or R2_ACCESS_KEY_ID)",
      "  CFLARE_R2_SECRET_ACCESS_KEY (or R2_SECRET_ACCESS_KEY)",
      "",
      "Options:",
      `  --supabase-url <url>          Default: ${DEFAULT_SUPABASE_URL || "<from env>"}`,
      "  --sb-secret-key <key>         Default: <from env>",
      `  --schema <name>               Default: ${DEFAULT_SCHEMA}`,
      `  --rpc <name>                  Default: ${DEFAULT_RPC}`,
      `  --limit-rows <N>              Default: ${DEFAULT_LIMIT_ROWS}`,
      `  --pollutants <csv>            Default: ${DEFAULT_POLLUTANTS.join(",")}`,
      `  --windows <csv>               Default: ${DEFAULT_WINDOWS.join(",")}`,
      `  --state-key <key>             Default: ${DEFAULT_STATE_KEY}`,
      "  --write-r2                    Write state object to R2 (default: dry-run)",
      "  --report-out <path>           Write JSON report to file",
      "  -h, --help",
      "",
      "Notes:",
      "  - One-off refresh from Supabase latest RPC to rebuild latest_state.json.",
      "  - Uses same pollutant/window matrix as legacy latest snapshot flow.",
    ].join("\n"),
  );
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizeTimestamp(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeMatrixPollutant(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalized.toLowerCase().replace(/[\s_.-]/g, "");
  if (compact === "pm25") return "pm25";
  if (compact === "pm10") return "pm10";
  if (compact === "no2") return "no2";
  return null;
}

function normalizePollutant(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalized.toLowerCase().replace(/[\s_]/g, "");
  if (compact === "pm25" || compact === "pm2.5") return "pm2.5";
  if (compact === "pm10") return "pm10";
  if (compact === "no2") return "no2";
  return normalized.toLowerCase();
}

function normalizeWindow(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) return null;
  return ["3h", "6h", "1d", "7d", "all"].includes(normalized) ? normalized : null;
}

function toRpcPollutant(matrixPollutant) {
  const normalized = normalizeMatrixPollutant(matrixPollutant);
  if (normalized === "pm25") return "pm2.5";
  return normalized || matrixPollutant;
}

function buildR2Config() {
  return {
    endpoint: String(process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    bucket: String(process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
    region: String(process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(
      process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "",
    ).trim(),
  };
}

function parseArgs(argv) {
  const args = {
    supabase_url: DEFAULT_SUPABASE_URL,
    sb_secret_key: DEFAULT_SB_SECRET_KEY,
    schema: DEFAULT_SCHEMA,
    rpc: DEFAULT_RPC,
    limit_rows: DEFAULT_LIMIT_ROWS,
    pollutants: [...DEFAULT_POLLUTANTS],
    windows: [...DEFAULT_WINDOWS],
    state_key: DEFAULT_STATE_KEY,
    write_r2: false,
    report_out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--supabase-url") {
      args.supabase_url = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--sb-secret-key") {
      args.sb_secret_key = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--schema") {
      args.schema = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--rpc") {
      args.rpc = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--limit-rows") {
      args.limit_rows = parsePositiveInt(argv[i + 1], DEFAULT_LIMIT_ROWS, 1, 10000);
      i += 1;
      continue;
    }
    if (arg === "--pollutants") {
      args.pollutants = String(argv[i + 1] || "")
        .split(",")
        .map((value) => normalizeMatrixPollutant(value))
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--windows") {
      args.windows = String(argv[i + 1] || "")
        .split(",")
        .map((value) => normalizeWindow(value))
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--state-key") {
      args.state_key = normalizePrefix(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--write-r2") {
      args.write_r2 = true;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.supabase_url) throw new Error("Missing SUPABASE_URL (--supabase-url)");
  if (!args.sb_secret_key) throw new Error("Missing SB_SECRET_KEY (--sb-secret-key)");
  if (!args.schema) throw new Error("Schema resolved empty");
  if (!args.rpc) throw new Error("RPC name resolved empty");
  if (!args.state_key) throw new Error("State key resolved empty");
  if (!args.pollutants.length) throw new Error("Pollutant list resolved empty");
  if (!args.windows.length) throw new Error("Window list resolved empty");
  return args;
}

function measureUtf8Bytes(value) {
  return new TextEncoder().encode(value || "").byteLength;
}

function looksLikeCursorSignatureMismatch(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("could not find the function") && normalized.includes("uk_aq_latest_rpc");
}

function mergeRpcMeta(a, b) {
  return {
    attempt_count: a.attempt_count + b.attempt_count,
    retry_count: a.retry_count + b.retry_count,
    http_status: b.http_status ?? a.http_status,
    duration_ms: a.duration_ms + b.duration_ms,
    response_bytes: a.response_bytes + b.response_bytes,
  };
}

function extractErrorMessage(payload, status) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload;
    for (const key of ["message", "error_description", "error"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return `RPC HTTP ${status}`;
}

async function postgrestRpc({
  supabase_url,
  sb_secret_key,
  schema,
  rpc_name,
  args,
  timeout_ms = 20000,
  retries = 3,
}) {
  const endpoint = `${supabase_url.replace(/\/$/, "")}/rest/v1/rpc/${rpc_name}`;
  const startedMs = Date.now();
  let lastError = null;
  let lastStatus = null;
  let totalResponseBytes = 0;
  let attemptCount = 0;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    attemptCount = attempt;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: sb_secret_key,
          Authorization: `Bearer ${sb_secret_key}`,
          "Accept-Profile": schema,
          "Content-Profile": schema,
        },
        body: JSON.stringify(args || {}),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      lastStatus = response.status;
      const responseText = await response.text();
      totalResponseBytes += measureUtf8Bytes(responseText);
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = null;
      }
      if (response.ok) {
        return {
          data: payload,
          error: null,
          meta: {
            attempt_count: attemptCount,
            retry_count: Math.max(0, attemptCount - 1),
            http_status: lastStatus,
            duration_ms: Date.now() - startedMs,
            response_bytes: totalResponseBytes,
          },
        };
      }
      const message = extractErrorMessage(payload, response.status);
      lastError = message;
      if (attempt < retries && [408, 429, 500, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        continue;
      }
      return {
        data: null,
        error: { message },
        meta: {
          attempt_count: attemptCount,
          retry_count: Math.max(0, attemptCount - 1),
          http_status: lastStatus,
          duration_ms: Date.now() - startedMs,
          response_bytes: totalResponseBytes,
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        continue;
      }
      return {
        data: null,
        error: { message },
        meta: {
          attempt_count: attemptCount,
          retry_count: Math.max(0, attemptCount - 1),
          http_status: lastStatus,
          duration_ms: Date.now() - startedMs,
          response_bytes: totalResponseBytes,
        },
      };
    }
  }

  return {
    data: null,
    error: { message: lastError || "RPC request failed" },
    meta: {
      attempt_count: attemptCount,
      retry_count: Math.max(0, attemptCount - 1),
      http_status: lastStatus,
      duration_ms: Date.now() - startedMs,
      response_bytes: totalResponseBytes,
    },
  };
}

async function callLatestRpc({ supabase_url, sb_secret_key, schema, rpc, pollutant, window_label, limit_rows }) {
  const cursorBody = {
    region: null,
    pcon_code: null,
    station_like: null,
    connector_id: null,
    pollutant,
    window_label,
    limit_rows,
    since_updated_at: null,
    since_updated_id: null,
  };
  const first = await postgrestRpc({
    supabase_url,
    sb_secret_key,
    schema,
    rpc_name: rpc,
    args: cursorBody,
  });
  if (!first.error) return { ...first, signature: "since_updated_at" };
  if (!looksLikeCursorSignatureMismatch(first.error.message)) {
    return { ...first, signature: "since_updated_at" };
  }
  const fallback = await postgrestRpc({
    supabase_url,
    sb_secret_key,
    schema,
    rpc_name: rpc,
    args: {
      region: null,
      pcon_code: null,
      station_like: null,
      connector_id: null,
      pollutant,
      window_label,
      limit_rows,
      since_ts: null,
    },
  });
  return {
    ...fallback,
    meta: mergeRpcMeta(first.meta, fallback.meta),
    signature: "since_ts",
  };
}

function hasAssignedGeoCode(row) {
  const station = row?.station && typeof row.station === "object" ? row.station : null;
  const pconCode = typeof station?.pcon_code === "string" ? station.pcon_code.trim() : "";
  const laCode = typeof station?.la_code === "string" ? station.la_code.trim() : "";
  return Boolean(pconCode || laCode);
}

function passesOutlierThreshold(row) {
  const value = Number(row?.last_value);
  if (!Number.isFinite(value)) return false;
  const phenomenon = row?.phenomenon && typeof row.phenomenon === "object" ? row.phenomenon : null;
  const pollutant = normalizePollutant(
    phenomenon?.observed_property_code ??
      phenomenon?.notation ??
      phenomenon?.pollutant_label ??
      phenomenon?.label ??
      null,
  );
  if (!pollutant) return true;
  const thresholds = {
    "pm2.5": { min: 0, max: 500 },
    pm25: { min: 0, max: 500 },
    pm10: { min: 0, max: 600 },
  };
  const bounds = thresholds[pollutant];
  if (!bounds) return true;
  return value >= bounds.min && value <= bounds.max;
}

function applyCandidate(stateByKey, candidate) {
  const key = `${candidate.connector_id}:${candidate.timeseries_id}`;
  const existing = stateByKey.get(key);
  if (!existing) {
    stateByKey.set(key, candidate);
    return "new";
  }
  const existingMs = Date.parse(existing.observed_at);
  const nextMs = Date.parse(candidate.observed_at);
  if (nextMs > existingMs) {
    stateByKey.set(key, candidate);
    return "updated_newer";
  }
  if (nextMs === existingMs) return "duplicate";
  return "older_skipped";
}

function sortStateEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
    return a.timeseries_id - b.timeseries_id;
  });
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) return;
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const r2 = buildR2Config();
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing required R2 config (CFLARE_R2_*/R2_*).");
  }

  const report = {
    ok: false,
    write_r2: args.write_r2,
    bucket: r2.bucket,
    state_key: args.state_key,
    schema: args.schema,
    rpc: args.rpc,
    pollutants: args.pollutants,
    windows: args.windows,
    limit_rows: args.limit_rows,
    matrix_calls: 0,
    matrix_errors: 0,
    rpc_response_bytes_total: 0,
    rpc_duration_ms_total: 0,
    rows_scanned: 0,
    rows_missing_timeseries_id: 0,
    rows_missing_connector_id: 0,
    rows_missing_timestamp: 0,
    rows_filtered_no_geo: 0,
    rows_filtered_outlier: 0,
    rows_invalid_value: 0,
    candidates_applied_new: 0,
    candidates_applied_updated_newer: 0,
    candidates_skipped_duplicate: 0,
    candidates_skipped_older: 0,
    seeded_entry_count: 0,
    state_bytes: 0,
    state_written: false,
    generated_at: new Date().toISOString(),
    warnings: [],
  };

  const stateByKey = new Map();

  for (const pollutant of args.pollutants) {
    for (const windowLabel of args.windows) {
      report.matrix_calls += 1;
      const rpcResult = await callLatestRpc({
        supabase_url: args.supabase_url,
        sb_secret_key: args.sb_secret_key,
        schema: args.schema,
        rpc: args.rpc,
        pollutant: toRpcPollutant(pollutant),
        window_label: windowLabel,
        limit_rows: args.limit_rows,
      });
      report.rpc_response_bytes_total += rpcResult?.meta?.response_bytes || 0;
      report.rpc_duration_ms_total += rpcResult?.meta?.duration_ms || 0;

      if (rpcResult.error) {
        report.matrix_errors += 1;
        report.warnings.push(
          `rpc_failed pollutant=${pollutant} window=${windowLabel} msg=${rpcResult.error.message}`,
        );
        continue;
      }

      const rows = Array.isArray(rpcResult.data) ? rpcResult.data : [];
      for (const row of rows) {
        report.rows_scanned += 1;
        const timeseriesId = Number(row?.id);
        const connectorId = Number(row?.connector_id);
        const observedAt = normalizeTimestamp(row?.last_value_at);
        if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
          report.rows_missing_timeseries_id += 1;
          continue;
        }
        if (!Number.isInteger(connectorId) || connectorId <= 0) {
          report.rows_missing_connector_id += 1;
          continue;
        }
        if (!observedAt) {
          report.rows_missing_timestamp += 1;
          continue;
        }
        if (!hasAssignedGeoCode(row)) {
          report.rows_filtered_no_geo += 1;
          continue;
        }
        if (!passesOutlierThreshold(row)) {
          report.rows_filtered_outlier += 1;
          continue;
        }
        const valueRaw = row?.last_value;
        const value = valueRaw === null || valueRaw === undefined ? null : Number(valueRaw);
        if (value !== null && !Number.isFinite(value)) {
          report.rows_invalid_value += 1;
          continue;
        }

        const applied = applyCandidate(stateByKey, {
          connector_id: Math.trunc(connectorId),
          timeseries_id: Math.trunc(timeseriesId),
          observed_at: observedAt,
          value,
          value_float8_hex: null,
          status: null,
          ingested_at: report.generated_at,
        });
        if (applied === "new") report.candidates_applied_new += 1;
        else if (applied === "updated_newer") report.candidates_applied_updated_newer += 1;
        else if (applied === "duplicate") report.candidates_skipped_duplicate += 1;
        else report.candidates_skipped_older += 1;
      }
    }
  }

  if (report.matrix_errors > 0) {
    throw new Error(`Seed aborted because ${report.matrix_errors} matrix RPC call(s) failed.`);
  }

  const seededEntries = sortStateEntries(stateByKey.values());
  report.seeded_entry_count = seededEntries.length;
  const statePayload = {
    schema_version: 1,
    updated_at: report.generated_at,
    entries: seededEntries,
  };
  const stateBody = new TextEncoder().encode(`${JSON.stringify(statePayload)}\n`);
  report.state_bytes = stateBody.byteLength;

  if (args.write_r2) {
    await r2PutObject({
      r2,
      key: args.state_key,
      body: stateBody,
      content_type: "application/json; charset=utf-8",
    });
    report.state_written = true;
  }

  report.ok = true;
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
