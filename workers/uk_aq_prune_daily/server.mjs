import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  fetchBackupDoneConnectorDays,
  resolvePhaseBRuntimeConfig,
  runPhaseBBackup,
} from "./phase_b_history_r2.mjs";
import { connectorDayGateKey } from "../shared/uk_aq_connector_day_gate.mjs";
import { groupFingerprintRechecksByHour } from "./fingerprint_recheck.mjs";
import { deletePruneBucketsWithSourceIdentity } from "./source_identity_deletion.mjs";
import { withDailyTaskRun } from "../shared/daily_task_health.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_DRY_RUN = true;
const DEFAULT_MAX_HOURS_PER_RUN = 48;
const DEFAULT_INGESTDB_RETENTION_DAYS = 5;
const DEFAULT_PHASE_A_ENABLED = true;
const DEFAULT_PHASE_A_RECENT_DAYS = 3;
const DEFAULT_DELETE_BATCH_SIZE = 50_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_HOUR = 10;
const DEFAULT_REPAIR_ONE_MISMATCH_BUCKET = true;
const DEFAULT_MAX_HOURS_PER_BATCH = 24;
const DEFAULT_OBSAQIDB_OBSERVS_RETENTION_DAYS = 14;
const DEFAULT_OBSERVS_UPSERT_RPC_RETRIES = 3;
const DEFAULT_OBSERVS_UPSERT_RETRY_BASE_MS = 1_000;
const DEFAULT_OBSERVS_UPSERT_TIMEOUT_SPLIT_MIN_ROWS = 32;
const DEFAULT_OBSERVS_UPSERT_TIMEOUT_SPLIT_MAX_DEPTH = 4;
const DEFAULT_REPAIR_FETCH_PAGE_SIZE = 1_000;
const MAX_REPAIR_FETCH_PAGES = 500;
const PREVIEW_LIMIT = 25;
const LATE_ARRIVAL_DISCOVERY_PAGE_SIZE = 1000;
const MAX_LATE_ARRIVAL_DISCOVERY_PAGES = 100;
const MAX_LATE_ARRIVAL_WINDOWS_PER_RUN = 14;
const RPC_SCHEMA = "uk_aq_public";

const RPC_HOURLY_FINGERPRINT = "uk_aq_rpc_observations_hourly_fingerprint";
const RPC_REPAIR_FETCH_HOUR_BUCKET = "uk_aq_rpc_observations_select_hour_bucket";
const RPC_OBSERVS_UPSERT = "uk_aq_rpc_observs_observations_upsert";
const RPC_OBSERVS_RECEIPTS_UPSERT = "uk_aq_rpc_observs_sync_receipt_daily_upsert";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";

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

function validateUpstreamAuth(req) {
  const expected = String(process.env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!expected) {
    return { ok: false, status: 500, error: "Missing UK_AQ_EDGE_UPSTREAM_SECRET." };
  }

  const supplied = String(req.headers[UPSTREAM_AUTH_HEADER] || "").trim();
  if (supplied !== expected) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  return { ok: true };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observsUpsertErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 397)}...` : message;
}

function pickCount(summary, names) {
  for (const name of names) {
    const value = summary?.[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function compactPruneHealthSummary(summary = {}) {
  return {
    mode: summary.mode,
    dry_run: summary.mode === "dry-run" || undefined,
    window_start_utc: summary.window_start,
    window_end_utc: summary.window_end,
    ingest_bucket_count: summary.ingest_bucket_count,
    observs_bucket_count: summary.observs_bucket_count,
    deletable_bucket_count: summary.deletable_bucket_count,
    deleted_bucket_count: pickCount(summary, ["deleted_bucket_count", "deleted_after_repair_bucket_count"]),
    deleted_rows: pickCount(summary, ["total_deleted_rows", "total_deleted_after_repair_rows"]),
    mismatch_count: summary.mismatch_count,
    mismatch_after_repair_count: summary.mismatch_after_repair_count,
    connector_history_gate_blocked_bucket_count:
      Number(summary.connector_history_gate_blocked_bucket_count || 0)
      + Number(summary.connector_history_gate_blocked_after_repair_bucket_count || 0),
    delete_error_count: pickCount(summary, ["delete_error_count", "delete_after_repair_error_count"]),
    repair_replay_count: summary.repair_replay_success_count,
    repair_replay_error_count: summary.repair_replay_error_count,
    alert_condition_count: summary.alert_condition_count,
    connector_day_atomic_delete_planned_count:
      summary.connector_day_atomic_delete_planned_count,
    connector_day_atomic_delete_committed_count:
      summary.connector_day_atomic_delete_committed_count,
    connector_day_atomic_delete_rolled_back_count:
      summary.connector_day_atomic_delete_rolled_back_count,
    connector_day_atomic_delete_blocked_bucket_count:
      summary.connector_day_atomic_delete_blocked_bucket_count,
    connector_day_atomic_delete_plan_preview:
      summary.connector_day_atomic_delete_plan_preview,
    connector_day_atomic_delete_result_preview:
      summary.connector_day_atomic_delete_result_preview,
    phase_a_recent: summary.phase_a_recent
      ? {
        skipped: summary.phase_a_recent.skipped,
        enabled: summary.phase_a_recent.enabled,
        mismatch_count: summary.phase_a_recent.mismatch_count,
        mismatch_after_repair_count: summary.phase_a_recent.mismatch_after_repair_count,
        repair_replay_success_count: summary.phase_a_recent.repair_replay_success_count,
      }
      : undefined,
    phase_b_history: summary.phase_b_history
      ? {
        enabled: summary.phase_b_history.enabled,
        ok: summary.phase_b_history.ok,
        run_id: summary.phase_b_history.run_id,
        status: summary.phase_b_history.status,
        stopped_for_budget: summary.phase_b_history.stopped_for_budget,
        error_count: summary.phase_b_history.error_count,
      }
      : undefined,
    late_arrival: summary.late_arrival
      ? {
        enabled: summary.late_arrival.enabled,
        skipped: summary.late_arrival.skipped,
        discovered_day_count: summary.late_arrival.discovered_day_count,
        target_day_count: summary.late_arrival.target_day_count,
        direct_delete_day_count: summary.late_arrival.direct_delete_day_count,
        repair_day_count: summary.late_arrival.repair_day_count,
        processed_day_count: summary.late_arrival.processed_day_count,
        obs_aqidb_cutoff_day_utc: summary.late_arrival.obs_aqidb_cutoff_day_utc,
        error_count: summary.late_arrival.error_count,
        connector_day_atomic_delete_planned_count:
          summary.late_arrival.connector_day_atomic_delete_planned_count,
        connector_day_atomic_delete_committed_count:
          summary.late_arrival.connector_day_atomic_delete_committed_count,
        connector_day_atomic_delete_rolled_back_count:
          summary.late_arrival.connector_day_atomic_delete_rolled_back_count,
        connector_day_atomic_delete_blocked_bucket_count:
          summary.late_arrival.connector_day_atomic_delete_blocked_bucket_count,
        connector_day_atomic_delete_plan_preview:
          summary.late_arrival.connector_day_atomic_delete_plan_preview,
        connector_day_atomic_delete_result_preview:
          summary.late_arrival.connector_day_atomic_delete_result_preview,
      }
      : undefined,
    warnings: [
      summary.phase_b_history?.status === "stopped_budget"
        ? "Phase B stopped at its controlled internal budget; downstream prune work was skipped"
        : null,
      summary.cap_warning_count ? `delete cap warnings: ${summary.cap_warning_count}` : null,
      summary.cap_after_repair_warning_count
        ? `delete-after-repair cap warnings: ${summary.cap_after_repair_warning_count}`
        : null,
    ].filter(Boolean),
  };
}

function githubActionsTaskRunMetadata() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return {};
  }

  const repository = String(process.env.GITHUB_REPOSITORY || "").trim();
  const workflow = String(process.env.GITHUB_WORKFLOW || "").trim();
  const runId = String(process.env.GITHUB_RUN_ID || "").trim();
  if (!(repository && workflow && runId)) {
    return {};
  }

  return {
    source_repo: repository,
    source_worker: workflow,
    platform_run_id: runId,
    log_url: `https://github.com/${repository}/actions/runs/${runId}`,
  };
}

function isObservsStatementTimeoutError(message) {
  return /statement timeout|canceling statement due to statement timeout/i.test(message);
}

function isRetryableObservsUpsertError(message) {
  const normalized = message.toLowerCase();
  return (
    isObservsStatementTimeoutError(normalized)
    || normalized.includes("deadlock detected")
    || normalized.includes("could not serialize access due to")
    || normalized.includes("connection terminated")
    || normalized.includes("connection reset")
    || normalized.includes("http 429")
    || normalized.includes("http 500")
    || normalized.includes("http 502")
    || normalized.includes("http 503")
    || normalized.includes("http 504")
  );
}

function normalizeDropboxPath(raw) {
  const value = (raw || "").trim();
  if (!value) {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function dropboxWithRoot(path) {
  const root = normalizeDropboxPath(process.env.UK_AQ_DROPBOX_ROOT || "");
  const cleaned = normalizeDropboxPath(path);
  if (!root) {
    return cleaned;
  }
  if (!cleaned) {
    return root;
  }
  if (cleaned === root || cleaned.startsWith(`${root}/`)) {
    return cleaned;
  }
  return `${root}${cleaned}`;
}

function errorDropboxFolderPath() {
  const configured = (process.env.UK_AIR_ERROR_DROPBOX_FOLDER || "/error_log").trim();
  let folder = dropboxWithRoot(configured);
  if (!folder) {
    return "/error_log";
  }
  if (folder.endsWith("/error_log")) {
    return folder;
  }
  return `${folder}/error_log`;
}

function formatCompactUtc(ts) {
  return ts.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDropboxErrorFileName(createdAt, errorId) {
  return `uk_aq_error_cloud_run_ingestdb_prune_${formatCompactUtc(createdAt)}_${errorId}.json`;
}

async function readResponseText(response, limit = 1000) {
  const raw = await response.text();
  return raw.length <= limit ? raw : raw.slice(0, limit);
}

function shouldUploadErrorDropbox() {
  const allowedUrl = (process.env.UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL || "").trim();
  if (!allowedUrl) {
    return true;
  }
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.SB_URL || "").trim();
  return supabaseUrl === allowedUrl;
}

async function dropboxRefreshAccessToken() {
  const appKey = (process.env.DROPBOX_APP_KEY || "").trim();
  const appSecret = (process.env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = (process.env.DROPBOX_REFRESH_TOKEN || "").trim();

  if (!(appKey && appSecret && refreshToken)) {
    return null;
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });
  const tokenResp = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenResp.ok) {
    const text = await readResponseText(tokenResp);
    throw new Error(`Dropbox token request failed (${tokenResp.status}): ${text}`);
  }
  const tokenJson = await tokenResp.json();
  const accessToken = String(tokenJson?.access_token || "");
  if (!accessToken) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return accessToken;
}

async function uploadErrorPayloadToDropbox(payload, createdAt, errorId) {
  if (!shouldUploadErrorDropbox()) {
    return { uploaded: false, reason: "allowlist_mismatch" };
  }

  const accessToken = await dropboxRefreshAccessToken();
  if (!accessToken) {
    return { uploaded: false, reason: "missing_credentials" };
  }

  const dateFolder = createdAt.slice(0, 10);
  const folder = errorDropboxFolderPath();
  const fileName = buildDropboxErrorFileName(createdAt, errorId);
  const dropboxPath = `${folder}/${dateFolder}/${fileName}`;
  const uploadResp = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: JSON.stringify(payload, null, 2),
  });

  if (!uploadResp.ok) {
    const text = await readResponseText(uploadResp);
    throw new Error(`Dropbox upload failed (${uploadResp.status}): ${text}`);
  }

  return { uploaded: true, dropbox_path: dropboxPath };
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

function toIso(value, fieldName) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp for ${fieldName}: ${String(value)}`);
  }
  return date.toISOString();
}

function toBigInt(value, fieldName) {
  if (typeof value === "bigint") {
    return value;
  }
  if (value === null || value === undefined) {
    return 0n;
  }
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`Invalid bigint for ${fieldName}: ${String(value)}`);
  }
}

function toBigIntString(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing bigint for ${fieldName}`);
  }
  return toBigInt(value, fieldName).toString();
}

function toOptionalBigInt(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return toBigInt(value, fieldName);
}

function buildBucketWindow(hourStartIso) {
  const hourStartDate = new Date(hourStartIso);
  if (Number.isNaN(hourStartDate.getTime())) {
    throw new Error(`Invalid hour_start value: ${hourStartIso}`);
  }
  return {
    window_start: hourStartDate.toISOString(),
    window_end: new Date(hourStartDate.getTime() + HOUR_MS).toISOString(),
  };
}

function toObservedDay(observedAtIso) {
  return observedAtIso.slice(0, 10);
}

function buildWindow(maxHoursPerRun, retentionDays) {
  const now = new Date();
  const utcMidnightMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const windowEndMs = utcMidnightMs - (retentionDays * DAY_MS);
  const windowStartMs = windowEndMs - (maxHoursPerRun * HOUR_MS);
  return {
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(windowEndMs).toISOString(),
  };
}

function buildRecentUtcDayWindow(recentDays) {
  const now = new Date();
  const utcTomorrowMidnightMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  const windowStartMs = utcTomorrowMidnightMs - (recentDays * DAY_MS);
  return {
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(utcTomorrowMidnightMs).toISOString(),
  };
}

function buildUtcDayWindow(dayUtc) {
  const startDate = new Date(`${String(dayUtc).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error(`Invalid day_utc for day window: ${String(dayUtc)}`);
  }
  return {
    day_utc: startDate.toISOString().slice(0, 10),
    window_start: startDate.toISOString(),
    window_end: new Date(startDate.getTime() + DAY_MS).toISOString(),
  };
}

function buildRetentionCutoffDayUtc(retentionDays) {
  const now = new Date();
  const utcMidnightMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  return new Date(utcMidnightMs - (retentionDays * DAY_MS)).toISOString().slice(0, 10);
}

function splitWindowIntoBatches(windowStartIso, windowEndIso, maxHoursPerBatch = DEFAULT_MAX_HOURS_PER_BATCH) {
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);
  if (Number.isNaN(windowStartMs) || Number.isNaN(windowEndMs)) {
    throw new Error(`Invalid window for batching: ${windowStartIso} -> ${windowEndIso}`);
  }
  if (windowEndMs <= windowStartMs) {
    throw new Error(`window_end must be greater than window_start: ${windowStartIso} -> ${windowEndIso}`);
  }
  const batchMs = maxHoursPerBatch * HOUR_MS;
  const batches = [];
  let cursorMs = windowStartMs;
  while (cursorMs < windowEndMs) {
    const batchEndMs = Math.min(cursorMs + batchMs, windowEndMs);
    const batchHours = Math.max(1, Math.trunc((batchEndMs - cursorMs) / HOUR_MS));
    batches.push({
      batch_index: batches.length + 1,
      window_start: new Date(cursorMs).toISOString(),
      window_end: new Date(batchEndMs).toISOString(),
      batch_hours: batchHours,
    });
    cursorMs = batchEndMs;
  }
  return batches;
}

function buildBucketKey(connectorId, hourStartIso) {
  return `${connectorId}|${hourStartIso}`;
}

function sampleRows(rows, limit = PREVIEW_LIMIT) {
  return rows.slice(0, limit);
}

function toSafeInt(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.trunc(parsed);
}

function toSafeBigInt(value) {
  if (value === null || value === undefined || value === "") {
    return 0n;
  }
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function sumIntField(rows, field) {
  return rows.reduce((total, row) => total + toSafeInt(row?.[field]), 0);
}

function sumBigIntField(rows, field) {
  return rows.reduce((total, row) => total + toSafeBigInt(row?.[field]), 0n);
}

function mergePreviewField(rows, field) {
  const merged = [];
  for (const row of rows) {
    const previewRows = Array.isArray(row?.[field]) ? row[field] : [];
    for (const preview of previewRows) {
      merged.push(preview);
      if (merged.length >= PREVIEW_LIMIT) {
        return merged;
      }
    }
  }
  return merged;
}

export function aggregateAtomicDeletionSummaryForTest(rows) {
  const summaries = Array.isArray(rows) ? rows : [];
  return {
    connector_day_atomic_delete_planned_count: sumIntField(
      summaries,
      "connector_day_atomic_delete_planned_count",
    ),
    connector_day_atomic_delete_committed_count: sumIntField(
      summaries,
      "connector_day_atomic_delete_committed_count",
    ),
    connector_day_atomic_delete_rolled_back_count: sumIntField(
      summaries,
      "connector_day_atomic_delete_rolled_back_count",
    ),
    connector_day_atomic_delete_blocked_bucket_count: sumIntField(
      summaries,
      "connector_day_atomic_delete_blocked_bucket_count",
    ),
    connector_day_atomic_delete_plan_preview: mergePreviewField(
      summaries,
      "connector_day_atomic_delete_plan_preview",
    ),
    connector_day_atomic_delete_result_preview: mergePreviewField(
      summaries,
      "connector_day_atomic_delete_result_preview",
    ),
  };
}

function aggregateDryRunRepairPilot(batchSummaries) {
  const pilots = batchSummaries
    .map((summary) => summary?.repair_one_mismatch_bucket_result)
    .filter((pilot) => pilot && typeof pilot === "object");
  return {
    batched: true,
    batch_count: batchSummaries.length,
    attempted_batches: pilots.filter((pilot) => pilot.attempted === true).length,
    verified_batches: pilots.filter((pilot) => pilot?.recheck?.verified === true).length,
    error_batches: pilots.filter((pilot) => typeof pilot.error === "string" && pilot.error.length > 0).length,
    preview: sampleRows(pilots),
  };
}

function aggregateBatchSummary(config, overallWindow, batches, batchSummaries, parentRunId) {
  const summaryBase = {
    run_id: parentRunId,
    mode: config.dryRun ? "dry-run" : "delete",
    window_start: overallWindow.window_start,
    window_end: overallWindow.window_end,
    ingestdb_retention_days: config.ingestDbRetentionDays,
    max_hours_per_run: config.maxHoursPerRun,
    ingest_bucket_count: sumIntField(batchSummaries, "ingest_bucket_count"),
    observs_bucket_count: sumIntField(batchSummaries, "observs_bucket_count"),
    deletable_bucket_count: sumIntField(batchSummaries, "deletable_bucket_count"),
    deletable_bucket_count_before_history_gate: sumIntField(
      batchSummaries,
      "deletable_bucket_count_before_history_gate",
    ),
    total_deletable_rows: sumBigIntField(batchSummaries, "total_deletable_rows").toString(),
    mismatch_count: sumIntField(batchSummaries, "mismatch_count"),
    observs_count_exceeds_ingest_count: sumIntField(batchSummaries, "observs_count_exceeds_ingest_count"),
    observs_extra_bucket_count: sumIntField(batchSummaries, "observs_extra_bucket_count"),
    connector_history_gate_enabled: Boolean(config.phaseB?.enabled),
    connector_history_gate_allowed_bucket_count: sumIntField(
      batchSummaries,
      "connector_history_gate_allowed_bucket_count",
    ),
    connector_history_gate_blocked_bucket_count: sumIntField(
      batchSummaries,
      "connector_history_gate_blocked_bucket_count",
    ),
    duplicate_connector_day_skipped_count: sumIntField(
      batchSummaries,
      "duplicate_connector_day_skipped_count",
    ),
    duplicate_connector_day_skipped_preview: mergePreviewField(
      batchSummaries,
      "duplicate_connector_day_skipped_preview",
    ),
    batch_count: batches.length,
    batch_window_hours: DEFAULT_MAX_HOURS_PER_BATCH,
    batch_windows_preview: sampleRows(batches),
    batch_run_ids_preview: sampleRows(batchSummaries.map((summary) => summary.run_id)),
  };

  if (config.dryRun) {
    return {
      ...summaryBase,
      repair_one_mismatch_bucket_enabled: config.repairOneMismatchBucket,
      repair_one_mismatch_bucket_result: aggregateDryRunRepairPilot(batchSummaries),
      deletable_buckets_preview: mergePreviewField(batchSummaries, "deletable_buckets_preview"),
      mismatches_preview: mergePreviewField(batchSummaries, "mismatches_preview"),
      connector_history_gate_blocked_buckets_preview: mergePreviewField(
        batchSummaries,
        "connector_history_gate_blocked_buckets_preview",
      ),
    };
  }

  return {
    ...summaryBase,
    ...aggregateAtomicDeletionSummaryForTest(batchSummaries),
    repairable_mismatch_bucket_count: sumIntField(batchSummaries, "repairable_mismatch_bucket_count"),
    repair_replay_success_count: sumIntField(batchSummaries, "repair_replay_success_count"),
    repair_replay_error_count: sumIntField(batchSummaries, "repair_replay_error_count"),
    repair_rows_selected_total: sumBigIntField(batchSummaries, "repair_rows_selected_total").toString(),
    repair_rows_replayed_total: sumBigIntField(batchSummaries, "repair_rows_replayed_total").toString(),
    repair_receipts_upserted_total: sumBigIntField(batchSummaries, "repair_receipts_upserted_total").toString(),
    mismatch_after_repair_count: sumIntField(batchSummaries, "mismatch_after_repair_count"),
    repaired_now_deletable_bucket_count: sumIntField(
      batchSummaries,
      "repaired_now_deletable_bucket_count",
    ),
    repaired_now_deletable_bucket_count_before_history_gate: sumIntField(
      batchSummaries,
      "repaired_now_deletable_bucket_count_before_history_gate",
    ),
    connector_history_gate_allowed_after_repair_bucket_count: sumIntField(
      batchSummaries,
      "connector_history_gate_allowed_after_repair_bucket_count",
    ),
    connector_history_gate_blocked_after_repair_bucket_count: sumIntField(
      batchSummaries,
      "connector_history_gate_blocked_after_repair_bucket_count",
    ),
    deleted_bucket_count: sumIntField(batchSummaries, "deleted_bucket_count"),
    total_deleted_rows: sumBigIntField(batchSummaries, "total_deleted_rows").toString(),
    deleted_after_repair_bucket_count: sumIntField(
      batchSummaries,
      "deleted_after_repair_bucket_count",
    ),
    total_deleted_after_repair_rows: sumBigIntField(
      batchSummaries,
      "total_deleted_after_repair_rows",
    ).toString(),
    delete_error_count: sumIntField(batchSummaries, "delete_error_count"),
    cap_warning_count: sumIntField(batchSummaries, "cap_warning_count"),
    delete_after_repair_error_count: sumIntField(batchSummaries, "delete_after_repair_error_count"),
    cap_after_repair_warning_count: sumIntField(batchSummaries, "cap_after_repair_warning_count"),
    source_identity_blocked_bucket_count: sumIntField(
      batchSummaries,
      "source_identity_blocked_bucket_count",
    ),
    source_identity_invalidated_connector_days: sumIntField(
      batchSummaries,
      "source_identity_invalidated_connector_days",
    ),
    alert_condition_count: sumIntField(batchSummaries, "alert_condition_count"),
    deleted_buckets_preview: mergePreviewField(batchSummaries, "deleted_buckets_preview"),
    deleted_after_repair_buckets_preview: mergePreviewField(
      batchSummaries,
      "deleted_after_repair_buckets_preview",
    ),
    connector_history_gate_blocked_after_repair_buckets_preview: mergePreviewField(
      batchSummaries,
      "connector_history_gate_blocked_after_repair_buckets_preview",
    ),
    mismatches_before_repair_preview: mergePreviewField(
      batchSummaries,
      "mismatches_before_repair_preview",
    ),
    mismatches_after_repair_preview: mergePreviewField(
      batchSummaries,
      "mismatches_after_repair_preview",
    ),
    repair_replay_results_preview: mergePreviewField(batchSummaries, "repair_replay_results_preview"),
    repair_replay_errors_preview: mergePreviewField(batchSummaries, "repair_replay_errors_preview"),
    delete_errors_preview: mergePreviewField(batchSummaries, "delete_errors_preview"),
    cap_warnings_preview: mergePreviewField(batchSummaries, "cap_warnings_preview"),
    delete_after_repair_errors_preview: mergePreviewField(
      batchSummaries,
      "delete_after_repair_errors_preview",
    ),
    cap_after_repair_warnings_preview: mergePreviewField(
      batchSummaries,
      "cap_after_repair_warnings_preview",
    ),
    source_identity_blocked_buckets_preview: mergePreviewField(
      batchSummaries,
      "source_identity_blocked_buckets_preview",
    ),
  };
}

function aggregatePhaseARecentSummary(overallWindow, batches, batchSummaries, parentRunId, recentDays) {
  return {
    run_id: parentRunId,
    mode: "phase-a-repair-only",
    phase: "phase_a_recent",
    enabled: true,
    recent_window_days: recentDays,
    window_start: overallWindow.window_start,
    window_end: overallWindow.window_end,
    batch_count: batches.length,
    batch_window_hours: DEFAULT_MAX_HOURS_PER_BATCH,
    ingest_bucket_count: sumIntField(batchSummaries, "ingest_bucket_count"),
    observs_bucket_count: sumIntField(batchSummaries, "observs_bucket_count"),
    mismatch_count: sumIntField(batchSummaries, "mismatch_count"),
    observs_count_exceeds_ingest_count: sumIntField(batchSummaries, "observs_count_exceeds_ingest_count"),
    observs_extra_bucket_count: sumIntField(batchSummaries, "observs_extra_bucket_count"),
    repairable_mismatch_bucket_count: sumIntField(batchSummaries, "repairable_mismatch_bucket_count"),
    repair_replay_success_count: sumIntField(batchSummaries, "repair_replay_success_count"),
    repair_replay_error_count: sumIntField(batchSummaries, "repair_replay_error_count"),
    repair_rows_selected_total: sumBigIntField(batchSummaries, "repair_rows_selected_total").toString(),
    repair_rows_replayed_total: sumBigIntField(batchSummaries, "repair_rows_replayed_total").toString(),
    repair_receipts_upserted_total: sumBigIntField(batchSummaries, "repair_receipts_upserted_total").toString(),
    mismatch_after_repair_count: sumIntField(batchSummaries, "mismatch_after_repair_count"),
    repaired_now_deletable_bucket_count: sumIntField(batchSummaries, "repaired_now_deletable_bucket_count"),
    deleted_bucket_count: sumIntField(batchSummaries, "deleted_bucket_count"),
    total_deleted_rows: sumBigIntField(batchSummaries, "total_deleted_rows").toString(),
    deleted_after_repair_bucket_count: sumIntField(batchSummaries, "deleted_after_repair_bucket_count"),
    total_deleted_after_repair_rows: sumBigIntField(batchSummaries, "total_deleted_after_repair_rows").toString(),
    batch_windows_preview: sampleRows(batches),
    batch_run_ids_preview: sampleRows(batchSummaries.map((summary) => summary.run_id)),
    mismatches_before_repair_preview: mergePreviewField(batchSummaries, "mismatches_before_repair_preview"),
    mismatches_after_repair_preview: mergePreviewField(batchSummaries, "mismatches_after_repair_preview"),
    repair_replay_results_preview: mergePreviewField(batchSummaries, "repair_replay_results_preview"),
    repair_replay_errors_preview: mergePreviewField(batchSummaries, "repair_replay_errors_preview"),
  };
}

function normalizeFingerprintRows(rows, sourceName) {
  const normalized = [];

  for (const row of rows) {
    const connectorId = toBigIntString(row.connector_id, `${sourceName}.connector_id`);
    const hourStart = toIso(row.hour_start, `${sourceName}.hour_start`);
    const observationCount = toBigInt(row.observation_count, `${sourceName}.observation_count`);
    const fingerprint = String(row.fingerprint || "").trim();
    if (!fingerprint) {
      throw new Error(
        `${sourceName}: empty fingerprint for connector_id=${connectorId}, hour_start=${hourStart}`,
      );
    }

    normalized.push({
      key: buildBucketKey(connectorId, hourStart),
      connector_id: connectorId,
      hour_start: hourStart,
      observation_count: observationCount,
      fingerprint,
      min_observed_at: toIso(row.min_observed_at, `${sourceName}.min_observed_at`),
      max_observed_at: toIso(row.max_observed_at, `${sourceName}.max_observed_at`),
    });
  }

  normalized.sort((left, right) => {
    if (left.hour_start < right.hour_start) return -1;
    if (left.hour_start > right.hour_start) return 1;
    const leftConnector = BigInt(left.connector_id);
    const rightConnector = BigInt(right.connector_id);
    if (leftConnector < rightConnector) return -1;
    if (leftConnector > rightConnector) return 1;
    return 0;
  });

  return normalized;
}

function observationPollutantCodesForPrune(config, repairOnlyMode) {
  if (repairOnlyMode || config.phaseB?.history_write_version !== "v2") {
    return null;
  }
  const codes = Array.from(new Set(
    (Array.isArray(config.phaseB?.observations_pollutant_codes)
      ? config.phaseB.observations_pollutant_codes
      : [])
      .map((code) => String(code || "").trim().toLowerCase())
      .filter(Boolean),
  ));
  return codes.length > 0 ? codes : null;
}

async function fetchHourlyFingerprints(client, windowStart, windowEnd, sourceName, pollutantCodes = null) {
  const { data, error } = await client.schema(RPC_SCHEMA).rpc(RPC_HOURLY_FINGERPRINT, {
    window_start: windowStart,
    window_end: windowEnd,
    p_pollutant_codes: pollutantCodes,
  });

  if (error) {
    throw new Error(`${sourceName} fingerprint RPC failed: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  return normalizeFingerprintRows(rows, sourceName);
}

function compareBuckets(ingestBuckets, observsBuckets) {
  const ingestByKey = new Map(ingestBuckets.map((row) => [row.key, row]));
  const observsByKey = new Map(observsBuckets.map((row) => [row.key, row]));

  const deletableBuckets = [];
  const mismatches = [];
  const observsExtraBuckets = [];

  for (const ingest of ingestBuckets) {
    const observs = observsByKey.get(ingest.key);
    if (!observs) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "missing_in_observs",
        ingest_count: ingest.observation_count.toString(),
        observs_count: null,
      });
      continue;
    }

    if (ingest.observation_count !== observs.observation_count) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "count_mismatch",
        ingest_count: ingest.observation_count.toString(),
        observs_count: observs.observation_count.toString(),
      });
      continue;
    }

    if (ingest.fingerprint !== observs.fingerprint) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "fingerprint_mismatch",
        ingest_count: ingest.observation_count.toString(),
        observs_count: observs.observation_count.toString(),
      });
      continue;
    }

    deletableBuckets.push({
      connector_id: ingest.connector_id,
      hour_start: ingest.hour_start,
      observation_count: ingest.observation_count,
      min_observed_at: ingest.min_observed_at,
      max_observed_at: ingest.max_observed_at,
    });
  }

  for (const observs of observsBuckets) {
    if (!ingestByKey.has(observs.key)) {
      observsExtraBuckets.push({
        connector_id: observs.connector_id,
        hour_start: observs.hour_start,
        observation_count: observs.observation_count.toString(),
      });
    }
  }

  return {
    deletableBuckets,
    mismatches,
    observsExtraBuckets,
  };
}

function determineBucketMismatch(ingestBucket, observsBucket) {
  if (!ingestBucket && observsBucket) {
    return {
      connector_id: observsBucket.connector_id,
      hour_start: observsBucket.hour_start,
      reason: "missing_in_ingest",
      ingest_count: null,
      observs_count: observsBucket.observation_count.toString(),
    };
  }

  if (!ingestBucket) {
    return null;
  }

  if (!observsBucket) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "missing_in_observs",
      ingest_count: ingestBucket.observation_count.toString(),
      observs_count: null,
    };
  }

  if (ingestBucket.observation_count !== observsBucket.observation_count) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "count_mismatch",
      ingest_count: ingestBucket.observation_count.toString(),
      observs_count: observsBucket.observation_count.toString(),
    };
  }

  if (ingestBucket.fingerprint !== observsBucket.fingerprint) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "fingerprint_mismatch",
      ingest_count: ingestBucket.observation_count.toString(),
      observs_count: observsBucket.observation_count.toString(),
    };
  }

  return null;
}

function classifyRepairMismatches(mismatches) {
  const repairableMismatches = [];
  const observsCountGreaterThanIngest = [];

  for (const mismatch of mismatches) {
    if (mismatch.reason === "missing_in_observs" || mismatch.reason === "fingerprint_mismatch") {
      repairableMismatches.push(mismatch);
      continue;
    }

    if (mismatch.reason !== "count_mismatch") {
      continue;
    }

    const ingestCount = toOptionalBigInt(mismatch.ingest_count, "mismatch.ingest_count");
    const observsCount = toOptionalBigInt(mismatch.observs_count, "mismatch.observs_count");
    if (ingestCount !== null && observsCount !== null && observsCount > ingestCount) {
      observsCountGreaterThanIngest.push(mismatch);
      continue;
    }
    repairableMismatches.push(mismatch);
  }

  return {
    repairableMismatches,
    observsCountGreaterThanIngest,
  };
}

function toIntField(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid integer for ${fieldName}: ${String(value)}`);
  }
  return Math.trunc(number);
}

function parseFloat8Hex(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const hex = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(hex)) {
    return null;
  }
  const parsed = Buffer.from(hex, "hex").readDoubleBE(0);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeObservsRows(inputRows) {
  const deduped = new Map();
  for (const row of inputRows) {
    const connectorId = toBigIntString(row.connector_id, "observs_row.connector_id");
    const timeseriesId = toBigIntString(row.timeseries_id, "observs_row.timeseries_id");
    const observedAt = toIso(row.observed_at, "observs_row.observed_at");
    const valueFromHex = parseFloat8Hex(row.value_float8_hex);
    const value = valueFromHex ?? (row.value === undefined ? null : row.value);
    const status = row.status === undefined ? null : row.status;
    const key = `${connectorId}|${timeseriesId}|${observedAt}`;
    deduped.set(key, {
      connector_id: connectorId,
      timeseries_id: timeseriesId,
      observed_at: observedAt,
      value,
      status,
    });
  }
  return Array.from(deduped.values());
}

function buildReceiptRows(observsRows) {
  const deduped = new Map();
  for (const row of observsRows) {
    const key = `${row.connector_id}|${row.timeseries_id}|${toObservedDay(row.observed_at)}`;
    deduped.set(key, {
      connector_id: row.connector_id,
      timeseries_id: row.timeseries_id,
      observed_day: toObservedDay(row.observed_at),
    });
  }
  return Array.from(deduped.values());
}

async function upsertObservsRowsChunk(observsClient, rows) {
  const upsertResult = await observsClient.schema(RPC_SCHEMA).rpc(RPC_OBSERVS_UPSERT, {
    rows,
  });
  if (upsertResult.error) {
    throw new Error(upsertResult.error.message || "unknown_observs_upsert_error");
  }
  const upsertRow = Array.isArray(upsertResult.data) ? upsertResult.data[0] : upsertResult.data;
  return toIntField(
    upsertRow?.observations_upserted ?? rows.length,
    "observations_upserted",
  );
}

async function upsertObservsRowsWithFallback(observsClient, rows, splitDepth = 0) {
  let lastMessage = "unknown_observs_upsert_error";

  for (let attempt = 1; attempt <= DEFAULT_OBSERVS_UPSERT_RPC_RETRIES; attempt += 1) {
    try {
      return await upsertObservsRowsChunk(observsClient, rows);
    } catch (error) {
      lastMessage = observsUpsertErrorMessage(error);
      if (
        attempt < DEFAULT_OBSERVS_UPSERT_RPC_RETRIES
        && isRetryableObservsUpsertError(lastMessage)
      ) {
        await sleep(Math.min(5_000, DEFAULT_OBSERVS_UPSERT_RETRY_BASE_MS * attempt));
        continue;
      }
      break;
    }
  }

  if (
    isObservsStatementTimeoutError(lastMessage)
    && splitDepth < DEFAULT_OBSERVS_UPSERT_TIMEOUT_SPLIT_MAX_DEPTH
    && rows.length >= DEFAULT_OBSERVS_UPSERT_TIMEOUT_SPLIT_MIN_ROWS * 2
  ) {
    const midpoint = Math.floor(rows.length / 2);
    const leftRows = rows.slice(0, midpoint);
    const rightRows = rows.slice(midpoint);
    if (!leftRows.length || !rightRows.length) {
      throw new Error(`observs upsert failed: ${lastMessage}`);
    }
    const leftUpserted = await upsertObservsRowsWithFallback(
      observsClient,
      leftRows,
      splitDepth + 1,
    );
    const rightUpserted = await upsertObservsRowsWithFallback(
      observsClient,
      rightRows,
      splitDepth + 1,
    );
    return leftUpserted + rightUpserted;
  }

  throw new Error(`observs upsert failed: ${lastMessage}`);
}

async function fetchObservationsForRepairBucket(client, mismatch) {
  const connectorId = toIntField(mismatch.connector_id, "mismatch.connector_id");
  const pageSize = DEFAULT_REPAIR_FETCH_PAGE_SIZE;
  const rows = [];
  let pagesFetched = 0;
  let reachedEnd = false;

  for (let pageIndex = 0; pageIndex < MAX_REPAIR_FETCH_PAGES; pageIndex += 1) {
    const pageOffset = pageIndex * pageSize;
    const { data, error } = await client.schema(RPC_SCHEMA).rpc(RPC_REPAIR_FETCH_HOUR_BUCKET, {
      p_connector_id: connectorId,
      p_hour_start: mismatch.hour_start,
      p_page_size: pageSize,
      p_page_offset: pageOffset,
    });

    if (error) {
      throw new Error(`repair fetch RPC failed: ${error.message}`);
    }

    const pageRows = Array.isArray(data) ? data : [];
    pagesFetched += 1;
    if (pageRows.length === 0) {
      reachedEnd = true;
      break;
    }

    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      reachedEnd = true;
      break;
    }
  }

  if (!reachedEnd) {
    throw new Error(
      `repair fetch page cap reached for connector_id=${connectorId}, hour_start=${mismatch.hour_start}`,
    );
  }

  return { rows, pagesFetched };
}

async function replayObservationsForRepairBucket(mainClient, observsClient, mismatch) {
  const { rows: rawRows, pagesFetched } = await fetchObservationsForRepairBucket(mainClient, mismatch);
  const observsRows = normalizeObservsRows(rawRows);

  let rowsReplayed = 0;
  let receiptsUpserted = 0;
  if (observsRows.length > 0) {
    rowsReplayed = await upsertObservsRowsWithFallback(observsClient, observsRows);
    const receiptRows = buildReceiptRows(observsRows);
    if (receiptRows.length > 0) {
      const receiptResult = await mainClient.schema(RPC_SCHEMA).rpc(RPC_OBSERVS_RECEIPTS_UPSERT, {
        rows: receiptRows,
      });
      if (receiptResult.error) {
        throw new Error(`observs receipts upsert failed: ${receiptResult.error.message}`);
      }
      const receiptRow = Array.isArray(receiptResult.data)
        ? receiptResult.data[0]
        : receiptResult.data;
      receiptsUpserted = toIntField(
        receiptRow?.rows_upserted ?? receiptRows.length,
        "rows_upserted",
      );
    }
  }

  return {
    connector_id: mismatch.connector_id,
    hour_start: mismatch.hour_start,
    fetch_pages: pagesFetched,
    rows_selected: rawRows.length,
    rows_replayed: rowsReplayed,
    receipts_upserted: receiptsUpserted,
  };
}

async function recheckSingleBucket(ingestClient, observsClient, mismatch, pollutantCodes = null) {
  const bucketWindow = buildBucketWindow(mismatch.hour_start);
  const [ingestRows, observsRows] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, bucketWindow.window_start, bucketWindow.window_end, "ingest_recheck", pollutantCodes),
    fetchHourlyFingerprints(observsClient, bucketWindow.window_start, bucketWindow.window_end, "observs_recheck", pollutantCodes),
  ]);

  const ingestMap = new Map(ingestRows.map((row) => [row.key, row]));
  const observsMap = new Map(observsRows.map((row) => [row.key, row]));
  const key = buildBucketKey(mismatch.connector_id, mismatch.hour_start);
  const bucketMismatch = determineBucketMismatch(ingestMap.get(key), observsMap.get(key));

  return {
    connector_id: mismatch.connector_id,
    hour_start: mismatch.hour_start,
    verified: bucketMismatch === null,
    mismatch: bucketMismatch,
    ingest_bucket_found: ingestMap.has(key),
    observs_bucket_found: observsMap.has(key),
  };
}

async function recheckMismatchBuckets(
  ingestClient,
  observsClient,
  initialMismatches,
  pollutantCodes = null,
) {
  const nowDeletableBuckets = [];
  const stillMismatched = [];
  const recheckGroups = groupFingerprintRechecksByHour(initialMismatches);

  logStructured("INFO", "fingerprint_recheck_plan", {
    mismatch_bucket_count: initialMismatches.length,
    hour_window_count: recheckGroups.length,
    windows_preview: sampleRows(recheckGroups.map((group) => ({
      window_start: group.window_start,
      window_end: group.window_end,
      mismatch_bucket_count: group.mismatches.length,
    }))),
  });

  for (const group of recheckGroups) {
    const startedAt = Date.now();
    let ingestRows;
    let observsRows;
    try {
      [ingestRows, observsRows] = await Promise.all([
        fetchHourlyFingerprints(
          ingestClient,
          group.window_start,
          group.window_end,
          "ingest_recheck",
          pollutantCodes,
        ),
        fetchHourlyFingerprints(
          observsClient,
          group.window_start,
          group.window_end,
          "observs_recheck",
          pollutantCodes,
        ),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Fingerprint recheck failed for ${group.window_start} to ${group.window_end}: ${message}`,
        { cause: error },
      );
    }
    logStructured("INFO", "fingerprint_recheck_hour_complete", {
      window_start: group.window_start,
      window_end: group.window_end,
      mismatch_bucket_count: group.mismatches.length,
      ingest_bucket_count: ingestRows.length,
      observs_bucket_count: observsRows.length,
      duration_ms: Date.now() - startedAt,
    });
    const ingestMap = new Map(ingestRows.map((row) => [row.key, row]));
    const observsMap = new Map(observsRows.map((row) => [row.key, row]));

    for (const mismatch of group.mismatches) {
      const key = buildBucketKey(mismatch.connector_id, mismatch.hour_start);
      const ingestBucket = ingestMap.get(key);
      const observsBucket = observsMap.get(key);
      const nextMismatch = determineBucketMismatch(ingestBucket, observsBucket);

      if (nextMismatch) {
        stillMismatched.push(nextMismatch);
        continue;
      }

      if (!ingestBucket || !observsBucket) {
        stillMismatched.push({
          connector_id: mismatch.connector_id,
          hour_start: mismatch.hour_start,
          reason: "missing_in_both_or_unknown_after_repair",
          ingest_count: ingestBucket ? ingestBucket.observation_count.toString() : null,
          observs_count: observsBucket ? observsBucket.observation_count.toString() : null,
        });
        continue;
      }

      nowDeletableBuckets.push({
        connector_id: ingestBucket.connector_id,
        hour_start: ingestBucket.hour_start,
        observation_count: ingestBucket.observation_count,
        min_observed_at: ingestBucket.min_observed_at,
        max_observed_at: ingestBucket.max_observed_at,
      });
    }
  }

  return {
    nowDeletableBuckets,
    stillMismatched,
  };
}

function connectorDayPlanKey(dayUtc, connectorId) {
  return `${String(dayUtc).slice(0, 10)}|${Number(connectorId)}`;
}

function bucketConnectorDayPlanKey(bucket) {
  return connectorDayPlanKey(toBucketDayUtc(bucket), bucket.connector_id);
}

export function claimConnectorDaysForParentRun(buckets, processedConnectorDays = new Set()) {
  const discoveredKeys = Array.from(new Set(
    (Array.isArray(buckets) ? buckets : []).map(bucketConnectorDayPlanKey),
  )).sort();
  const claimedKeys = new Set();
  const duplicateConnectorDays = [];
  for (const key of discoveredKeys) {
    if (processedConnectorDays.has(key)) {
      const [dayUtc, connectorId] = key.split("|");
      duplicateConnectorDays.push({ day_utc: dayUtc, connector_id: Number(connectorId) });
      continue;
    }
    processedConnectorDays.add(key);
    claimedKeys.add(key);
  }
  return {
    claimedBuckets: (Array.isArray(buckets) ? buckets : []).filter((bucket) => (
      claimedKeys.has(bucketConnectorDayPlanKey(bucket))
    )),
    duplicateConnectorDays,
    processedConnectorDays,
  };
}

async function recheckCompleteConnectorDays(
  ingestClient,
  observsClient,
  initialIngestBuckets,
  pollutantCodes = null,
) {
  const connectorIdsByDay = new Map();
  for (const bucket of initialIngestBuckets) {
    const dayUtc = toBucketDayUtc(bucket);
    if (!connectorIdsByDay.has(dayUtc)) connectorIdsByDay.set(dayUtc, new Set());
    connectorIdsByDay.get(dayUtc).add(Number(bucket.connector_id));
  }

  const finalIngestBuckets = [];
  const finalObservsBuckets = [];
  for (const [dayUtc, connectorIds] of Array.from(connectorIdsByDay.entries()).sort()) {
    const windowStart = `${dayUtc}T00:00:00.000Z`;
    const windowEnd = new Date(Date.parse(windowStart) + DAY_MS).toISOString();
    const [ingestRows, observsRows] = await Promise.all([
      fetchHourlyFingerprints(
        ingestClient,
        windowStart,
        windowEnd,
        "ingest_final_connector_day_recheck",
        pollutantCodes,
      ),
      fetchHourlyFingerprints(
        observsClient,
        windowStart,
        windowEnd,
        "observs_final_connector_day_recheck",
        pollutantCodes,
      ),
    ]);
    finalIngestBuckets.push(...ingestRows.filter((row) => connectorIds.has(Number(row.connector_id))));
    finalObservsBuckets.push(...observsRows.filter((row) => connectorIds.has(Number(row.connector_id))));
  }

  return {
    finalIngestBuckets,
    finalObservsBuckets,
    ...compareBuckets(finalIngestBuckets, finalObservsBuckets),
  };
}

export function buildAtomicConnectorDayDeletionPlan({
  currentBuckets,
  eligibleBuckets,
  unresolvedBuckets = [],
  gateBlockedBuckets = [],
  pollutantCodes = null,
}) {
  const currentGroups = new Map();
  for (const bucket of Array.isArray(currentBuckets) ? currentBuckets : []) {
    const key = bucketConnectorDayPlanKey(bucket);
    if (!currentGroups.has(key)) currentGroups.set(key, []);
    currentGroups.get(key).push(bucket);
  }
  const eligibleByKey = new Map(
    (Array.isArray(eligibleBuckets) ? eligibleBuckets : [])
      .map((bucket) => [buildBucketKey(bucket.connector_id, bucket.hour_start), bucket]),
  );
  const unresolvedDays = new Set(
    (Array.isArray(unresolvedBuckets) ? unresolvedBuckets : []).map(bucketConnectorDayPlanKey),
  );
  const gateBlockedDays = new Set(
    (Array.isArray(gateBlockedBuckets) ? gateBlockedBuckets : []).map(bucketConnectorDayPlanKey),
  );
  const hasPollutantSubset = Array.isArray(pollutantCodes) && pollutantCodes.length > 0;
  const plannedBuckets = [];
  const blockedBuckets = [];
  const connectorDays = [];

  for (const [key, group] of Array.from(currentGroups.entries()).sort()) {
    const eligible = group.filter((bucket) => {
      const planned = eligibleByKey.get(buildBucketKey(bucket.connector_id, bucket.hour_start));
      return planned && planned.observation_count === bucket.observation_count;
    });
    let failureReason = null;
    if (hasPollutantSubset) failureReason = "connector_day_scope_mismatch";
    else if (unresolvedDays.has(key)) failureReason = "connector_day_not_fully_eligible";
    else if (gateBlockedDays.has(key)) failureReason = "history_not_complete_for_connector_day";
    else if (eligible.length !== group.length) failureReason = "connector_day_not_fully_eligible";

    const [dayUtc, connectorId] = key.split("|");
    connectorDays.push({
      day_utc: dayUtc,
      connector_id: Number(connectorId),
      connector_day_current_bucket_count: group.length,
      connector_day_eligible_bucket_count: eligible.length,
      connector_day_atomic_delete_planned: failureReason === null,
      connector_day_atomic_delete_failure_reason: failureReason,
    });
    if (!failureReason) {
      plannedBuckets.push(...group);
      continue;
    }
    blockedBuckets.push(...group.map((bucket) => ({
      connector_id: bucket.connector_id,
      hour_start: bucket.hour_start,
      day_utc: dayUtc,
      observation_count: bucket.observation_count.toString(),
      reason: failureReason,
    })));
  }

  return { plannedBuckets, blockedBuckets, connectorDays };
}

export function buildRunConfig(url) {
  const params = url.searchParams;

  const dryRun = parseBoolean(
    params.get("dryRun") ?? process.env.INGESTDB_PRUNE_DRY_RUN,
    DEFAULT_DRY_RUN,
  );
  const maxHoursPerRun = parsePositiveInt(
    params.get("maxHours") ?? process.env.MAX_HOURS_PER_RUN,
    DEFAULT_MAX_HOURS_PER_RUN,
    1,
    24 * 31,
  );
  const ingestDbRetentionDays = parsePositiveInt(
    params.get("retentionDays") ?? process.env.INGESTDB_RETENTION_DAYS,
    DEFAULT_INGESTDB_RETENTION_DAYS,
    1,
    3650,
  );
  const deleteBatchSize = parsePositiveInt(
    params.get("deleteBatchSize") ?? process.env.DELETE_BATCH_SIZE,
    DEFAULT_DELETE_BATCH_SIZE,
    1,
    500_000,
  );
  const maxDeleteBatchesPerHour = parsePositiveInt(
    params.get("maxDeleteBatchesPerHour") ?? process.env.MAX_DELETE_BATCHES_PER_HOUR,
    DEFAULT_MAX_DELETE_BATCHES_PER_HOUR,
    1,
    100,
  );
  const repairOneMismatchBucket = parseBoolean(
    params.get("repairOneMismatchBucket") ?? process.env.REPAIR_ONE_MISMATCH_BUCKET,
    DEFAULT_REPAIR_ONE_MISMATCH_BUCKET,
  );
  const phaseAEnabled = parseBoolean(
    params.get("phaseAEnabled") ?? process.env.INGESTDB_PRUNE_PHASE_A_ENABLED,
    DEFAULT_PHASE_A_ENABLED,
  );
  const phaseARecentDays = parsePositiveInt(
    params.get("phaseARecentDays") ?? process.env.INGESTDB_PRUNE_PHASE_A_RECENT_DAYS,
    DEFAULT_PHASE_A_RECENT_DAYS,
    1,
    14,
  );
  const obsAqidbObservsRetentionDays = parsePositiveInt(
    params.get("obsAqidbObservsRetentionDays") ?? process.env.OBS_AQIDB_OBSERVS_RETENTION_DAYS,
    DEFAULT_OBSAQIDB_OBSERVS_RETENTION_DAYS,
    1,
    3650,
  );

  const phaseB = resolvePhaseBRuntimeConfig(process.env);
  phaseB.observs_retention_days = obsAqidbObservsRetentionDays;
  phaseB.enabled = parseBoolean(
    params.get("historyEnabled") ?? process.env.UK_AQ_R2_HISTORY_PHASE_B_ENABLED,
    phaseB.enabled,
  );
  phaseB.part_max_rows = parsePositiveInt(
    params.get("historyPartMaxRows") ?? phaseB.part_max_rows,
    phaseB.part_max_rows,
    1,
    5_000_000,
  );
  phaseB.cursor_fetch_rows = parsePositiveInt(
    params.get("historyCursorFetchRows") ?? phaseB.cursor_fetch_rows,
    phaseB.cursor_fetch_rows,
    1_000,
    500_000,
  );
  phaseB.row_group_size = parsePositiveInt(
    params.get("historyRowGroupSize") ?? phaseB.row_group_size,
    phaseB.row_group_size,
    10_000,
    2_000_000,
  );
  phaseB.max_candidates_per_run = parsePositiveInt(
    params.get("historyMaxCandidates") ?? phaseB.max_candidates_per_run,
    phaseB.max_candidates_per_run,
    1,
    50_000,
  );
  phaseB.staging_retention_days = parsePositiveInt(
    params.get("historyStagingRetentionDays") ?? phaseB.staging_retention_days,
    phaseB.staging_retention_days,
    1,
    90,
  );
  const historyDbUrlOverride = (params.get("historyDbUrl") || "").trim();
  if (historyDbUrlOverride) {
    phaseB.supabase_db_url = historyDbUrlOverride;
  }
  const historyBucketOverride = (params.get("historyR2Bucket") || "").trim();
  if (historyBucketOverride) {
    phaseB.r2.bucket = historyBucketOverride;
  }
  const historyEndpointOverride = (params.get("historyR2Endpoint") || "").trim();
  if (historyEndpointOverride) {
    phaseB.r2.endpoint = historyEndpointOverride;
  }

  return {
    supabaseUrl: requiredEnvAny(["SUPABASE_URL", "SB_URL"]),
    observsSupabaseUrl: requiredEnvAny(["OBS_AQIDB_SUPABASE_URL"]),
    ingestSecretKey: requiredEnvAny(["SB_SECRET_KEY"]),
    observsSecretKey: requiredEnvAny(["OBS_AQIDB_SECRET_KEY"]),
    dryRun,
    maxHoursPerRun,
    ingestDbRetentionDays,
    deleteBatchSize,
    maxDeleteBatchesPerHour,
    repairOneMismatchBucket,
    obsAqidbObservsRetentionDays,
    phaseAEnabled,
    phaseARecentDays,
    phaseB,
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function toBucketOutput(bucket) {
  return {
    connector_id: bucket.connector_id,
    hour_start: bucket.hour_start,
    observation_count: bucket.observation_count.toString(),
  };
}

function toBucketDayUtc(bucket) {
  return String(bucket.hour_start || "").slice(0, 10);
}

export function filterBucketsByConnectorHistoryGate(buckets, connectorGateMap) {
  const allowedBuckets = [];
  const blockedBuckets = [];
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const dayUtc = toBucketDayUtc(bucket);
    let gateComplete = false;
    try {
      gateComplete = connectorGateMap.get(
        connectorDayGateKey(dayUtc, bucket.connector_id),
      ) === true;
    } catch (_error) {
      gateComplete = false;
    }
    if (gateComplete) {
      allowedBuckets.push(bucket);
      continue;
    }
    blockedBuckets.push({
      connector_id: bucket.connector_id,
      hour_start: bucket.hour_start,
      day_utc: dayUtc,
      observation_count: bucket.observation_count.toString(),
      reason: "history_not_complete_for_connector_day",
    });
  }
  return { allowedBuckets, blockedBuckets };
}

async function applyConnectorHistoryGateFilter(config, runId, buckets, gateStage) {
  if (!config.phaseB?.enabled || !Array.isArray(buckets) || buckets.length === 0) {
    return {
      allowedBuckets: Array.isArray(buckets) ? buckets : [],
      blockedBuckets: [],
      connectorGateMap: new Map(),
    };
  }

  const connectorGateMap = await fetchBackupDoneConnectorDays({
    supabaseDbUrl: config.phaseB.supabase_db_url,
    connectorDays: buckets.map((bucket) => ({
      day_utc: toBucketDayUtc(bucket),
      connector_id: bucket.connector_id,
    })),
  });

  const { allowedBuckets, blockedBuckets } = filterBucketsByConnectorHistoryGate(
    buckets,
    connectorGateMap,
  );

  if (blockedBuckets.length > 0) {
    logStructured("WARNING", "connector_history_gate_blocked_buckets", {
      run_id: runId,
      gate_stage: gateStage,
      connector_history_gate_allowed_bucket_count: allowedBuckets.length,
      connector_history_gate_blocked_bucket_count: blockedBuckets.length,
      connector_history_gate_blocked_buckets_preview: sampleRows(blockedBuckets),
    });
  } else {
    logStructured("INFO", "connector_history_gate_allows_all_buckets", {
      run_id: runId,
      gate_stage: gateStage,
      connector_history_gate_allowed_bucket_count: allowedBuckets.length,
    });
  }

  return {
    allowedBuckets,
    blockedBuckets,
    connectorGateMap,
  };
}

async function deleteBucketsWithConnectorSourceIdentity(
  config,
  runId,
  buckets,
  pollutantCodes,
  deleteStage,
) {
  const bucketResults = [];
  const errors = [];
  const capWarnings = [];
  const blockedBuckets = [];
  let totalDeletedRows = 0n;
  let sourceIdentityInvalidatedConnectorDays = 0;
  const transactionResults = await deletePruneBucketsWithSourceIdentity({
    databaseUrl: config.phaseB?.supabase_db_url,
    buckets,
    deleteBatchSize: config.deleteBatchSize,
    maxDeleteBatchesPerHour: config.maxDeleteBatchesPerHour,
    pollutantCodes,
  });
  for (const transactionResult of transactionResults) {
    logStructured(
      transactionResult.ok ? "INFO" : "WARNING",
      "connector_day_source_identity_delete_result",
      {
        run_id: runId,
        delete_stage: deleteStage,
        day_utc: transactionResult.day_utc,
        connector_id: transactionResult.connector_id,
        ...transactionResult.diagnostics,
      },
    );
    if (!transactionResult.ok) {
      sourceIdentityInvalidatedConnectorDays += Number(
        transactionResult.diagnostics.source_identity_invalidated_connector_days || 0,
      );
      blockedBuckets.push(...transactionResult.blocked_buckets);
      errors.push({
        day_utc: transactionResult.day_utc,
        connector_id: transactionResult.connector_id,
        reason: transactionResult.diagnostics.source_identity_failure_reason,
        retained_bucket_count: transactionResult.blocked_buckets.length,
      });
      continue;
    }
    for (const result of transactionResult.bucket_results) {
      totalDeletedRows += result.deleted_rows;
      const bucketResult = {
        connector_id: result.connector_id,
        hour_start: result.hour_start,
        deleted_rows: result.deleted_rows.toString(),
        batches_run: result.batches_run,
        drained: result.drained,
      };
      bucketResults.push(bucketResult);
      if (result.max_batches_reached_with_remaining_rows) {
        capWarnings.push({
          connector_id: result.connector_id,
          hour_start: result.hour_start,
          deleted_rows: result.deleted_rows.toString(),
          batches_run: result.batches_run,
          max_delete_batches_per_hour: config.maxDeleteBatchesPerHour,
          reason: "max_batches_reached_before_drain",
          alert_condition: true,
        });
      }
    }
  }
  return {
    bucketResults,
    errors,
    capWarnings,
    blockedBuckets,
    totalDeletedRows,
    sourceIdentityInvalidatedConnectorDays,
    transactionResults,
  };
}

async function runPruneSingleWindow(config, window, runContext = {}) {
  const runId = randomUUID();
  const ingestClient = createClient(config.supabaseUrl, config.ingestSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });
  const observsClient = createClient(config.observsSupabaseUrl, config.observsSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });

  const windowStart = toIso(window.window_start, "window_start");
  const windowEnd = toIso(window.window_end, "window_end");
  const batchWindowHours = Math.max(1, Math.trunc((Date.parse(windowEnd) - Date.parse(windowStart)) / HOUR_MS));
  const repairOnlyMode = runContext.repair_only === true;
  const dryRunMode = config.dryRun && !repairOnlyMode;
  const modeLabel = repairOnlyMode ? "phase-a-repair-only" : (dryRunMode ? "dry-run" : "delete");
  const historyGateEnabled = Boolean(config.phaseB?.enabled) && !repairOnlyMode;
  const deleteEligiblePollutantCodes = observationPollutantCodesForPrune(config, repairOnlyMode);
  logStructured("INFO", "ingestdb_prune_run_start", {
    run_id: runId,
    parent_run_id: runContext.parent_run_id ?? null,
    batch_index: runContext.batch_index ?? 1,
    batch_count: runContext.batch_count ?? 1,
    batch_window_hours: batchWindowHours,
    mode: modeLabel,
    window_start: windowStart,
    window_end: windowEnd,
    ingestdb_retention_days: config.ingestDbRetentionDays,
    max_hours_per_run: batchWindowHours,
    delete_batch_size: config.deleteBatchSize,
    max_delete_batches_per_hour: config.maxDeleteBatchesPerHour,
    repair_one_mismatch_bucket: config.repairOneMismatchBucket,
    connector_history_gate_enabled: historyGateEnabled,
    delete_filter_mode: deleteEligiblePollutantCodes ? "pollutant_allow_list" : "all_observations",
    delete_eligible_pollutant_codes: deleteEligiblePollutantCodes,
    phase: repairOnlyMode ? "phase_a_recent" : "prune",
  });

  let [ingestBuckets, observsBuckets] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, windowStart, windowEnd, "ingest", deleteEligiblePollutantCodes),
    fetchHourlyFingerprints(observsClient, windowStart, windowEnd, "observs", deleteEligiblePollutantCodes),
  ]);

  let duplicateConnectorDaysSkipped = [];
  if (!repairOnlyMode && !dryRunMode) {
    const claimed = claimConnectorDaysForParentRun(
      ingestBuckets,
      runContext.processed_connector_days instanceof Set
        ? runContext.processed_connector_days
        : new Set(),
    );
    duplicateConnectorDaysSkipped = claimed.duplicateConnectorDays;
    if (claimed.claimedBuckets.length > 0) {
      const completeInitialState = await recheckCompleteConnectorDays(
        ingestClient,
        observsClient,
        claimed.claimedBuckets,
        deleteEligiblePollutantCodes,
      );
      ingestBuckets = completeInitialState.finalIngestBuckets;
      observsBuckets = completeInitialState.finalObservsBuckets;
    } else {
      ingestBuckets = [];
      observsBuckets = [];
    }
  }

  const { deletableBuckets, mismatches, observsExtraBuckets } = compareBuckets(ingestBuckets, observsBuckets);
  const preRepairBackupGate = historyGateEnabled
    ? await applyConnectorHistoryGateFilter(
      config,
      runId,
      deletableBuckets,
      "pre_repair",
    )
    : {
      allowedBuckets: deletableBuckets,
      blockedBuckets: [],
      connectorGateMap: new Map(),
    };
  const gatedDeletableBuckets = preRepairBackupGate.allowedBuckets;
  const historyGateBlockedBuckets = preRepairBackupGate.blockedBuckets;
  const { repairableMismatches, observsCountGreaterThanIngest } = classifyRepairMismatches(mismatches);
  const repairCandidate = repairableMismatches[0] ?? null;

  for (const mismatch of mismatches) {
    logStructured("ERROR", "hour_bucket_mismatch", { run_id: runId, ...mismatch });
  }
  for (const mismatch of observsCountGreaterThanIngest) {
    logStructured("ERROR", "hour_bucket_observs_count_exceeds_ingest", {
      run_id: runId,
      connector_id: mismatch.connector_id,
      hour_start: mismatch.hour_start,
      reason: mismatch.reason,
      ingest_count: mismatch.ingest_count,
      observs_count: mismatch.observs_count,
      alert_condition: true,
    });
  }
  if (observsExtraBuckets.length > 0) {
    logStructured("INFO", "observs_extra_buckets", {
      run_id: runId,
      count: observsExtraBuckets.length,
      sample: sampleRows(observsExtraBuckets),
    });
  }

  const totalDeletableRows = gatedDeletableBuckets.reduce((total, row) => total + row.observation_count, 0n);
  const batchSummaryMeta = runContext.batch_count && runContext.batch_count > 1
    ? {
      parent_run_id: runContext.parent_run_id ?? null,
      batch_index: runContext.batch_index ?? 1,
      batch_count: runContext.batch_count,
      batch_window_hours: batchWindowHours,
    }
    : {};
  const summaryBase = {
    run_id: runId,
    ...batchSummaryMeta,
    mode: modeLabel,
    window_start: windowStart,
    window_end: windowEnd,
    ingestdb_retention_days: config.ingestDbRetentionDays,
    ingest_bucket_count: ingestBuckets.length,
    observs_bucket_count: observsBuckets.length,
    deletable_bucket_count: gatedDeletableBuckets.length,
    deletable_bucket_count_before_history_gate: deletableBuckets.length,
    total_deletable_rows: totalDeletableRows.toString(),
    mismatch_count: mismatches.length,
    observs_count_exceeds_ingest_count: observsCountGreaterThanIngest.length,
    observs_extra_bucket_count: observsExtraBuckets.length,
    connector_history_gate_enabled: historyGateEnabled,
    delete_filter_mode: deleteEligiblePollutantCodes ? "pollutant_allow_list" : "all_observations",
    delete_eligible_pollutant_codes: deleteEligiblePollutantCodes,
    connector_history_gate_allowed_bucket_count: gatedDeletableBuckets.length,
    connector_history_gate_blocked_bucket_count: historyGateBlockedBuckets.length,
    connector_history_gate_blocked_buckets_preview: sampleRows(historyGateBlockedBuckets),
    duplicate_connector_day_skipped_count: duplicateConnectorDaysSkipped.length,
    duplicate_connector_day_skipped_preview: sampleRows(duplicateConnectorDaysSkipped),
    phase: repairOnlyMode ? "phase_a_recent" : "prune",
  };

  if (dryRunMode) {
    let repairPilot = null;
    if (config.repairOneMismatchBucket) {
      if (!repairCandidate) {
        repairPilot = {
          attempted: false,
          reason: "no_repairable_mismatch_bucket_found",
        };
        logStructured("INFO", "repair_one_mismatch_bucket_skipped", {
          run_id: runId,
          ...repairPilot,
        });
      } else {
        try {
          const replayResult = await replayObservationsForRepairBucket(
            ingestClient,
            observsClient,
            repairCandidate,
          );
          const recheck = await recheckSingleBucket(
            ingestClient,
            observsClient,
            repairCandidate,
            deleteEligiblePollutantCodes,
          );
          repairPilot = {
            attempted: true,
            connector_id: repairCandidate.connector_id,
            hour_start: repairCandidate.hour_start,
            initial_reason: repairCandidate.reason,
            replay: replayResult,
            recheck,
          };
          logStructured("INFO", "repair_one_mismatch_bucket_result", {
            run_id: runId,
            ...repairPilot,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          repairPilot = {
            attempted: true,
            connector_id: repairCandidate.connector_id,
            hour_start: repairCandidate.hour_start,
            initial_reason: repairCandidate.reason,
            error: message,
          };
          logStructured("ERROR", "repair_one_mismatch_bucket_error", {
            run_id: runId,
            ...repairPilot,
          });
        }
      }
    }

    for (const bucket of gatedDeletableBuckets) {
      logStructured("INFO", "hour_bucket_deletable_plan", {
        run_id: runId,
        connector_id: bucket.connector_id,
        hour_start: bucket.hour_start,
        observation_count: bucket.observation_count.toString(),
      });
    }
    logStructured("INFO", "ingestdb_prune_dry_run_summary", {
      ...summaryBase,
      repair_one_mismatch_bucket_enabled: config.repairOneMismatchBucket,
      repair_one_mismatch_bucket_result: repairPilot,
      mismatches_preview: sampleRows(mismatches),
      deletable_buckets_preview: sampleRows(gatedDeletableBuckets.map(toBucketOutput)),
    });
    return {
      ...summaryBase,
      repair_one_mismatch_bucket_enabled: config.repairOneMismatchBucket,
      repair_one_mismatch_bucket_result: repairPilot,
      deletable_buckets_preview: sampleRows(gatedDeletableBuckets.map(toBucketOutput)),
      mismatches_preview: sampleRows(mismatches),
    };
  }

  const repairReplayResults = [];
  const repairReplayErrors = [];

  if (repairableMismatches.length > 0) {
    for (const mismatch of repairableMismatches) {
      try {
        const replayResult = await replayObservationsForRepairBucket(
          ingestClient,
          observsClient,
          mismatch,
        );
        repairReplayResults.push(replayResult);
        logStructured("INFO", "hour_bucket_repair_replay_result", {
          run_id: runId,
          connector_id: replayResult.connector_id,
          hour_start: replayResult.hour_start,
          rows_selected: replayResult.rows_selected,
          rows_replayed: replayResult.rows_replayed,
          receipts_upserted: replayResult.receipts_upserted,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorPayload = {
          connector_id: mismatch.connector_id,
          hour_start: mismatch.hour_start,
          reason: mismatch.reason,
          message,
        };
        repairReplayErrors.push(errorPayload);
        logStructured("ERROR", "hour_bucket_repair_replay_error", {
          run_id: runId,
          ...errorPayload,
        });
      }
    }
  }

  let repairedNowDeletableBuckets = [];
  let mismatchesAfterRepair = mismatches;
  let finalCurrentBuckets = [];
  let finalEligibleBuckets = [];
  let finalObservsBucketCount = 0;
  if (repairOnlyMode && repairableMismatches.length > 0) {
    const recheckResult = await recheckMismatchBuckets(
      ingestClient,
      observsClient,
      mismatches,
      deleteEligiblePollutantCodes,
    );
    repairedNowDeletableBuckets = recheckResult.nowDeletableBuckets;
    mismatchesAfterRepair = recheckResult.stillMismatched;
  } else if (!repairOnlyMode) {
    const finalRecheck = await recheckCompleteConnectorDays(
      ingestClient,
      observsClient,
      ingestBuckets,
      deleteEligiblePollutantCodes,
    );
    finalCurrentBuckets = finalRecheck.finalIngestBuckets;
    finalEligibleBuckets = finalRecheck.deletableBuckets;
    finalObservsBucketCount = finalRecheck.finalObservsBuckets.length;
    mismatchesAfterRepair = finalRecheck.mismatches;
    const initiallyMismatchedKeys = new Set(
      mismatches.map((bucket) => buildBucketKey(bucket.connector_id, bucket.hour_start)),
    );
    repairedNowDeletableBuckets = finalEligibleBuckets.filter((bucket) => (
      initiallyMismatchedKeys.has(buildBucketKey(bucket.connector_id, bucket.hour_start))
    ));
  }

  const postRepairBackupGate = historyGateEnabled
    ? await applyConnectorHistoryGateFilter(
      config,
      runId,
      finalEligibleBuckets,
      "final_connector_day_plan",
    )
    : {
      allowedBuckets: repairOnlyMode ? repairedNowDeletableBuckets : finalEligibleBuckets,
      blockedBuckets: [],
      connectorGateMap: new Map(),
    };
  const gatedFinalEligibleBuckets = postRepairBackupGate.allowedBuckets;
  const historyGateBlockedAfterRepairBuckets = postRepairBackupGate.blockedBuckets;
  const atomicDeletionPlan = repairOnlyMode
    ? { plannedBuckets: [], blockedBuckets: [], connectorDays: [] }
    : buildAtomicConnectorDayDeletionPlan({
      currentBuckets: finalCurrentBuckets,
      eligibleBuckets: gatedFinalEligibleBuckets,
      unresolvedBuckets: mismatchesAfterRepair,
      gateBlockedBuckets: historyGateBlockedAfterRepairBuckets,
      pollutantCodes: deleteEligiblePollutantCodes,
    });

  for (const mismatch of mismatchesAfterRepair) {
    logStructured("ERROR", "hour_bucket_mismatch_after_repair", {
      run_id: runId,
      ...mismatch,
    });
  }
  for (const bucket of repairedNowDeletableBuckets) {
    logStructured("INFO", "hour_bucket_repaired_and_now_deletable", {
      run_id: runId,
      connector_id: bucket.connector_id,
      hour_start: bucket.hour_start,
      observation_count: bucket.observation_count.toString(),
    });
  }

  const finalDeletion = !repairOnlyMode
    ? await deleteBucketsWithConnectorSourceIdentity(
      config,
      runId,
      atomicDeletionPlan.plannedBuckets,
      deleteEligiblePollutantCodes,
      "final_connector_day_atomic_delete",
    )
    : {
      bucketResults: [],
      errors: [],
      capWarnings: [],
      blockedBuckets: [],
      totalDeletedRows: 0n,
      sourceIdentityInvalidatedConnectorDays: 0,
      transactionResults: [],
    };
  const deletedBucketResults = finalDeletion.bucketResults;
  const deleteErrors = finalDeletion.errors;
  const capWarnings = finalDeletion.capWarnings;
  const totalDeletedRows = finalDeletion.totalDeletedRows;
  const initiallyMismatchedKeys = new Set(
    mismatches.map((bucket) => buildBucketKey(bucket.connector_id, bucket.hour_start)),
  );
  const deletedAfterRepairBucketResults = deletedBucketResults.filter((bucket) => (
    initiallyMismatchedKeys.has(buildBucketKey(bucket.connector_id, bucket.hour_start))
  ));
  const totalDeletedAfterRepairRows = deletedAfterRepairBucketResults.reduce(
    (total, bucket) => total + BigInt(bucket.deleted_rows),
    0n,
  );
  const deleteAfterRepairErrors = deleteErrors.filter((error) => (
    mismatches.some((bucket) => (
      toBucketDayUtc(bucket) === error.day_utc
      && Number(bucket.connector_id) === Number(error.connector_id)
    ))
  ));
  const capAfterRepairWarnings = [];

  const finalMismatchCount = mismatchesAfterRepair.length;
  const totalRowsSelectedForRepair = repairReplayResults.reduce(
    (total, row) => total + BigInt(row.rows_selected),
    0n,
  );
  const totalRowsReplayedForRepair = repairReplayResults.reduce(
    (total, row) => total + BigInt(row.rows_replayed),
    0n,
  );
  const totalReceiptsUpsertedForRepair = repairReplayResults.reduce(
    (total, row) => total + BigInt(row.receipts_upserted),
    0n,
  );

  const runSummary = {
    ...summaryBase,
    repairable_mismatch_bucket_count: repairableMismatches.length,
    repair_replay_success_count: repairReplayResults.length,
    repair_replay_error_count: repairReplayErrors.length,
    repair_rows_selected_total: totalRowsSelectedForRepair.toString(),
    repair_rows_replayed_total: totalRowsReplayedForRepair.toString(),
    repair_receipts_upserted_total: totalReceiptsUpsertedForRepair.toString(),
    mismatch_after_repair_count: finalMismatchCount,
    repaired_now_deletable_bucket_count: repairedNowDeletableBuckets.length,
    repaired_now_deletable_bucket_count_before_history_gate: repairedNowDeletableBuckets.length,
    connector_history_gate_allowed_after_repair_bucket_count: repairedNowDeletableBuckets.filter((bucket) => (
      gatedFinalEligibleBuckets.some((allowed) => (
        buildBucketKey(allowed.connector_id, allowed.hour_start)
          === buildBucketKey(bucket.connector_id, bucket.hour_start)
      ))
    )).length,
    connector_history_gate_blocked_after_repair_bucket_count: historyGateBlockedAfterRepairBuckets.length,
    deleted_bucket_count: deletedBucketResults.length,
    total_deleted_rows: totalDeletedRows.toString(),
    deleted_after_repair_bucket_count: deletedAfterRepairBucketResults.length,
    total_deleted_after_repair_rows: totalDeletedAfterRepairRows.toString(),
    delete_error_count: deleteErrors.length,
    cap_warning_count: capWarnings.length,
    delete_after_repair_error_count: deleteAfterRepairErrors.length,
    cap_after_repair_warning_count: capAfterRepairWarnings.length,
    source_identity_blocked_bucket_count:
      finalDeletion.blockedBuckets.length,
    source_identity_invalidated_connector_days:
      finalDeletion.sourceIdentityInvalidatedConnectorDays,
    final_connector_day_ingest_bucket_count: finalCurrentBuckets.length,
    final_connector_day_observs_bucket_count: finalObservsBucketCount,
    connector_day_atomic_delete_planned_count: atomicDeletionPlan.connectorDays.filter(
      (row) => row.connector_day_atomic_delete_planned,
    ).length,
    connector_day_atomic_delete_committed_count: finalDeletion.transactionResults.filter(
      (row) => row.diagnostics.connector_day_atomic_delete_committed,
    ).length,
    connector_day_atomic_delete_rolled_back_count: finalDeletion.transactionResults.filter(
      (row) => row.diagnostics.connector_day_atomic_delete_rolled_back,
    ).length,
    connector_day_atomic_delete_blocked_bucket_count: atomicDeletionPlan.blockedBuckets.length,
    alert_condition_count:
      finalMismatchCount +
      deleteErrors.length +
      repairReplayErrors.length +
      atomicDeletionPlan.blockedBuckets.length +
      finalDeletion.blockedBuckets.length,
    deleted_buckets_preview: sampleRows(deletedBucketResults),
    deleted_after_repair_buckets_preview: sampleRows(deletedAfterRepairBucketResults),
    mismatches_before_repair_preview: sampleRows(mismatches),
    mismatches_after_repair_preview: sampleRows(mismatchesAfterRepair),
    connector_history_gate_blocked_after_repair_buckets_preview: sampleRows(historyGateBlockedAfterRepairBuckets),
    repair_replay_results_preview: sampleRows(repairReplayResults),
    repair_replay_errors_preview: sampleRows(repairReplayErrors),
    delete_errors_preview: sampleRows(deleteErrors),
    cap_warnings_preview: sampleRows(capWarnings),
    delete_after_repair_errors_preview: sampleRows(deleteAfterRepairErrors),
    cap_after_repair_warnings_preview: sampleRows(capAfterRepairWarnings),
    source_identity_blocked_buckets_preview: sampleRows([
      ...atomicDeletionPlan.blockedBuckets,
      ...finalDeletion.blockedBuckets,
    ]),
    connector_day_atomic_delete_plan_preview: sampleRows(atomicDeletionPlan.connectorDays),
    connector_day_atomic_delete_result_preview: sampleRows(finalDeletion.transactionResults.map((row) => ({
      day_utc: row.day_utc,
      connector_id: row.connector_id,
      ...row.diagnostics,
    }))),
  };
  logStructured(
    "INFO",
    repairOnlyMode ? "ingestdb_phase_a_recent_repair_summary" : "ingestdb_prune_delete_summary",
    runSummary,
  );
  return runSummary;
}

async function runPhaseARecent(config) {
  if (!config.phaseAEnabled) {
    const skippedSummary = {
      enabled: false,
      skipped: true,
      reason: "phase_a_disabled",
      recent_window_days: config.phaseARecentDays,
    };
    logStructured("INFO", "ingestdb_phase_a_recent_check_skipped", skippedSummary);
    return skippedSummary;
  }

  const overallWindow = buildRecentUtcDayWindow(config.phaseARecentDays);
  const batches = splitWindowIntoBatches(
    overallWindow.window_start,
    overallWindow.window_end,
    DEFAULT_MAX_HOURS_PER_BATCH,
  );
  const parentRunId = randomUUID();
  logStructured("INFO", "ingestdb_phase_a_recent_check_plan", {
    run_id: parentRunId,
    mode: "phase-a-repair-only",
    phase: "phase_a_recent",
    recent_window_days: config.phaseARecentDays,
    window_start: overallWindow.window_start,
    window_end: overallWindow.window_end,
    batch_window_hours: DEFAULT_MAX_HOURS_PER_BATCH,
    batch_count: batches.length,
    batches_preview: sampleRows(batches),
  });

  const batchSummaries = [];
  for (const batch of batches) {
    const summary = await runPruneSingleWindow(config, batch, {
      parent_run_id: parentRunId,
      batch_index: batch.batch_index,
      batch_count: batches.length,
      repair_only: true,
    });
    batchSummaries.push(summary);
  }

  const aggregateSummary = aggregatePhaseARecentSummary(
    overallWindow,
    batches,
    batchSummaries,
    parentRunId,
    config.phaseARecentDays,
  );
  logStructured("INFO", "ingestdb_phase_a_recent_check_summary", aggregateSummary);
  return aggregateSummary;
}

async function discoverLateArrivalDays(ingestClient, overallWindow) {
  const cutoffWindowStart = toIso(overallWindow.window_start, "late_arrival.window_start");
  const distinctDaySet = new Set();
  let scannedRowCount = 0;
  let scannedPageCount = 0;
  let truncatedByPageLimit = false;

  for (let page = 0; page < MAX_LATE_ARRIVAL_DISCOVERY_PAGES; page += 1) {
    const start = page * LATE_ARRIVAL_DISCOVERY_PAGE_SIZE;
    const end = start + LATE_ARRIVAL_DISCOVERY_PAGE_SIZE - 1;
    const { data, error } = await ingestClient
      .schema(RPC_SCHEMA)
      .from("observations")
      .select("observed_at")
      .lt("observed_at", cutoffWindowStart)
      .order("observed_at", { ascending: true })
      .range(start, end);

    if (error) {
      throw new Error(`late-arrival discovery query failed: ${error.message}`);
    }

    const rows = Array.isArray(data) ? data : [];
    scannedPageCount += 1;
    scannedRowCount += rows.length;
    for (const row of rows) {
      const observedAtIso = toIso(row.observed_at, "late_arrival.observed_at");
      distinctDaySet.add(toObservedDay(observedAtIso));
    }

    if (rows.length < LATE_ARRIVAL_DISCOVERY_PAGE_SIZE) {
      break;
    }
    if (page + 1 === MAX_LATE_ARRIVAL_DISCOVERY_PAGES) {
      truncatedByPageLimit = true;
    }
  }

  const discoveredDays = Array.from(distinctDaySet).sort();
  return {
    cutoff_window_start: cutoffWindowStart,
    discovered_day_count: discoveredDays.length,
    discovered_day_preview: sampleRows(discoveredDays),
    discovered_days: discoveredDays,
    scanned_row_count: scannedRowCount,
    scanned_page_count: scannedPageCount,
    truncated_by_page_limit: truncatedByPageLimit,
  };
}

async function runLateArrivalDirectDeleteDay(
  config,
  ingestClient,
  dayWindow,
  runId,
  batchIndex,
  batchCount,
  processedConnectorDays,
) {
  const deleteEligiblePollutantCodes = observationPollutantCodesForPrune(config, false);
  const discoveredIngestBuckets = await fetchHourlyFingerprints(
    ingestClient,
    dayWindow.window_start,
    dayWindow.window_end,
    "ingest",
    deleteEligiblePollutantCodes,
  );
  const claimed = claimConnectorDaysForParentRun(
    discoveredIngestBuckets,
    processedConnectorDays instanceof Set ? processedConnectorDays : new Set(),
  );
  const ingestBuckets = claimed.claimedBuckets;
  const batchSummaryMeta = batchCount > 1
    ? {
      parent_run_id: runId,
      batch_index: batchIndex,
      batch_count: batchCount,
      batch_window_hours: 24,
    }
    : {};

  if (ingestBuckets.length === 0) {
    const skippedSummary = {
      run_id: randomUUID(),
      ...batchSummaryMeta,
      mode: config.dryRun ? "dry-run" : "delete",
      phase: "late_arrival_direct_delete",
      day_utc: dayWindow.day_utc,
      window_start: dayWindow.window_start,
      window_end: dayWindow.window_end,
      ingest_bucket_count: 0,
      duplicate_connector_day_skipped_count: claimed.duplicateConnectorDays.length,
      duplicate_connector_day_skipped_preview: sampleRows(claimed.duplicateConnectorDays),
      delete_filter_mode: deleteEligiblePollutantCodes ? "pollutant_allow_list" : "all_observations",
      delete_eligible_pollutant_codes: deleteEligiblePollutantCodes,
      deleted_bucket_count: 0,
      total_deleted_rows: "0",
      delete_error_count: 0,
      alert_condition_count: 0,
      connector_day_atomic_delete_planned_count: 0,
      connector_day_atomic_delete_committed_count: 0,
      connector_day_atomic_delete_rolled_back_count: 0,
      connector_day_atomic_delete_blocked_bucket_count: 0,
      connector_day_atomic_delete_plan_preview: [],
      connector_day_atomic_delete_result_preview: [],
      skipped: true,
      reason: discoveredIngestBuckets.length === 0
        ? "no_ingest_buckets_detected"
        : "connector_days_already_processed_in_parent_run",
      deleted_buckets_preview: [],
      delete_errors_preview: [],
    };
    logStructured("INFO", "ingestdb_late_arrival_direct_delete_summary", skippedSummary);
    return skippedSummary;
  }

  logStructured("INFO", "ingestdb_late_arrival_direct_delete_plan", {
    run_id: runId,
    day_utc: dayWindow.day_utc,
    mode: config.dryRun ? "dry-run" : "delete",
    ingest_bucket_count: ingestBuckets.length,
    duplicate_connector_day_skipped_count: claimed.duplicateConnectorDays.length,
    duplicate_connector_day_skipped_preview: sampleRows(claimed.duplicateConnectorDays),
    delete_filter_mode: deleteEligiblePollutantCodes ? "pollutant_allow_list" : "all_observations",
    delete_eligible_pollutant_codes: deleteEligiblePollutantCodes,
    window_start: dayWindow.window_start,
    window_end: dayWindow.window_end,
    ingest_bucket_preview: sampleRows(ingestBuckets.map(toBucketOutput)),
  });
  const directDeleteGate = await applyConnectorHistoryGateFilter(
    config,
    runId,
    ingestBuckets,
    "late_arrival_direct_delete",
  );
  const atomicDeletionPlan = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: ingestBuckets,
    eligibleBuckets: directDeleteGate.allowedBuckets,
    gateBlockedBuckets: directDeleteGate.blockedBuckets,
    pollutantCodes: deleteEligiblePollutantCodes,
  });
  const directDeletion = !config.dryRun
    ? await deleteBucketsWithConnectorSourceIdentity(
      config,
      runId,
      atomicDeletionPlan.plannedBuckets,
      deleteEligiblePollutantCodes,
      "late_arrival_final_connector_day_atomic_delete",
    )
    : {
      bucketResults: [],
      errors: [],
      blockedBuckets: [],
      totalDeletedRows: 0n,
      sourceIdentityInvalidatedConnectorDays: 0,
      transactionResults: [],
    };
  const deletedBucketResults = directDeletion.bucketResults;
  const deleteErrors = directDeletion.errors;
  const totalDeletedRows = directDeletion.totalDeletedRows;

  const summary = {
    run_id: randomUUID(),
    ...batchSummaryMeta,
    mode: config.dryRun ? "dry-run" : "delete",
    phase: "late_arrival_direct_delete",
    day_utc: dayWindow.day_utc,
    window_start: dayWindow.window_start,
    window_end: dayWindow.window_end,
    ingest_bucket_count: ingestBuckets.length,
    duplicate_connector_day_skipped_count: claimed.duplicateConnectorDays.length,
    duplicate_connector_day_skipped_preview: sampleRows(claimed.duplicateConnectorDays),
    delete_filter_mode: deleteEligiblePollutantCodes ? "pollutant_allow_list" : "all_observations",
    delete_eligible_pollutant_codes: deleteEligiblePollutantCodes,
    deleted_bucket_count: deletedBucketResults.length,
    total_deleted_rows: totalDeletedRows.toString(),
    delete_error_count: deleteErrors.length,
    connector_history_gate_blocked_bucket_count: directDeleteGate.blockedBuckets.length,
    source_identity_blocked_bucket_count:
      atomicDeletionPlan.blockedBuckets.length + directDeletion.blockedBuckets.length,
    source_identity_invalidated_connector_days:
      directDeletion.sourceIdentityInvalidatedConnectorDays,
    connector_day_atomic_delete_planned_count: atomicDeletionPlan.connectorDays.filter(
      (row) => row.connector_day_atomic_delete_planned,
    ).length,
    connector_day_atomic_delete_committed_count: directDeletion.transactionResults.filter(
      (row) => row.diagnostics.connector_day_atomic_delete_committed,
    ).length,
    connector_day_atomic_delete_rolled_back_count: directDeletion.transactionResults.filter(
      (row) => row.diagnostics.connector_day_atomic_delete_rolled_back,
    ).length,
    connector_day_atomic_delete_blocked_bucket_count: atomicDeletionPlan.blockedBuckets.length,
    alert_condition_count:
      deleteErrors.length
      + atomicDeletionPlan.blockedBuckets.length
      + directDeletion.blockedBuckets.length,
    skipped: false,
    reason: "older_than_obs_aqidb_retention_cutoff",
    deleted_buckets_preview: sampleRows(deletedBucketResults),
    delete_errors_preview: sampleRows(deleteErrors),
    connector_history_gate_blocked_buckets_preview: sampleRows(directDeleteGate.blockedBuckets),
    source_identity_blocked_buckets_preview: sampleRows([
      ...atomicDeletionPlan.blockedBuckets,
      ...directDeletion.blockedBuckets,
    ]),
    connector_day_atomic_delete_plan_preview: sampleRows(atomicDeletionPlan.connectorDays),
    connector_day_atomic_delete_result_preview: sampleRows(
      directDeletion.transactionResults.map((row) => ({
        day_utc: row.day_utc,
        connector_id: row.connector_id,
        ...row.diagnostics,
      })),
    ),
  };
  logStructured("INFO", "ingestdb_late_arrival_direct_delete_summary", summary);
  return summary;
}

async function runLateArrivalCleanup(config, overallWindow, runContext = {}) {
  const runId = randomUUID();
  const ingestClient = createClient(config.supabaseUrl, config.ingestSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });
  const discovery = await discoverLateArrivalDays(ingestClient, overallWindow);
  const { discovered_days: discoveredDays, ...discoverySummary } = discovery;
  const obsAqidbCutoffDayUtc = buildRetentionCutoffDayUtc(config.obsAqidbObservsRetentionDays);
  const directDeleteDayWindows = [];
  const repairEligibleDayWindows = [];
  for (const dayUtc of discoveredDays) {
    const dayWindow = buildUtcDayWindow(dayUtc);
    if (dayWindow.day_utc < obsAqidbCutoffDayUtc) {
      directDeleteDayWindows.push(dayWindow);
      continue;
    }
    repairEligibleDayWindows.push(dayWindow);
  }
  const repairDayWindows = repairEligibleDayWindows.slice(0, MAX_LATE_ARRIVAL_WINDOWS_PER_RUN);
  const droppedDayCount = Math.max(0, repairEligibleDayWindows.length - repairDayWindows.length);
  const dayWindows = [...directDeleteDayWindows, ...repairDayWindows];
  logStructured("INFO", "ingestdb_late_arrival_discovery_summary", {
    run_id: runId,
    mode: config.dryRun ? "dry-run" : "delete",
    ...discoverySummary,
  });

  if (discoveredDays.length === 0) {
    return {
      enabled: true,
      skipped: true,
      reason: "no_late_arrival_days_detected",
      run_id: runId,
      ...discoverySummary,
      obs_aqidb_retention_days: config.obsAqidbObservsRetentionDays,
      obs_aqidb_cutoff_day_utc: obsAqidbCutoffDayUtc,
      target_day_count: 0,
      direct_delete_day_count: 0,
      repair_day_count: 0,
      dropped_day_count: 0,
      processed_day_count: 0,
      delete_error_count: 0,
      mismatch_after_repair_count: 0,
      connector_history_gate_blocked_bucket_count: 0,
      connector_history_gate_blocked_after_repair_bucket_count: 0,
      total_deleted_rows: "0",
      total_deleted_after_repair_rows: "0",
      alert_condition_count: 0,
      duplicate_connector_day_skipped_count: 0,
      duplicate_connector_day_skipped_preview: [],
      connector_day_atomic_delete_planned_count: 0,
      connector_day_atomic_delete_committed_count: 0,
      connector_day_atomic_delete_rolled_back_count: 0,
      connector_day_atomic_delete_blocked_bucket_count: 0,
      connector_day_atomic_delete_plan_preview: [],
      connector_day_atomic_delete_result_preview: [],
      batch_summaries_preview: [],
    };
  }

  logStructured("INFO", "ingestdb_late_arrival_cleanup_plan", {
    run_id: runId,
    mode: config.dryRun ? "dry-run" : "delete",
    target_day_count: dayWindows.length,
    obs_aqidb_retention_days: config.obsAqidbObservsRetentionDays,
    obs_aqidb_cutoff_day_utc: obsAqidbCutoffDayUtc,
    direct_delete_day_count: directDeleteDayWindows.length,
    repair_day_count: repairDayWindows.length,
    dropped_day_count: droppedDayCount,
    target_day_preview: sampleRows(dayWindows.map((entry) => entry.day_utc)),
    direct_delete_day_preview: sampleRows(directDeleteDayWindows.map((entry) => entry.day_utc)),
    repair_day_preview: sampleRows(repairDayWindows.map((entry) => entry.day_utc)),
  });

  const batchSummaries = [];
  const processedConnectorDays = runContext.processed_connector_days instanceof Set
    ? runContext.processed_connector_days
    : new Set();
  for (const dayWindow of directDeleteDayWindows) {
    try {
      const summary = await runLateArrivalDirectDeleteDay(
        config,
        ingestClient,
        dayWindow,
        runId,
        batchSummaries.length + 1,
        dayWindows.length,
        processedConnectorDays,
      );
      batchSummaries.push(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("ERROR", "ingestdb_late_arrival_direct_delete_day_error", {
        run_id: runId,
        day_utc: dayWindow.day_utc,
        error: message,
      });
      batchSummaries.push({
        day_utc: dayWindow.day_utc,
        run_id: null,
        mode: config.dryRun ? "dry-run" : "delete",
        phase: "late_arrival_direct_delete",
        window_start: dayWindow.window_start,
        window_end: dayWindow.window_end,
        delete_error_count: 1,
        alert_condition_count: 1,
        error: message,
      });
    }
  }

  for (const dayWindow of repairDayWindows) {
    try {
      const summary = await runPruneSingleWindow(config, dayWindow, {
        parent_run_id: runId,
        batch_index: batchSummaries.length + 1,
        batch_count: dayWindows.length,
        processed_connector_days: processedConnectorDays,
      });
      batchSummaries.push(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("ERROR", "ingestdb_late_arrival_cleanup_day_error", {
        run_id: runId,
        day_utc: dayWindow.day_utc,
        error: message,
      });
      batchSummaries.push({
        day_utc: dayWindow.day_utc,
        run_id: null,
        mode: config.dryRun ? "dry-run" : "delete",
        window_start: dayWindow.window_start,
        window_end: dayWindow.window_end,
        delete_error_count: 1,
        alert_condition_count: 1,
        error: message,
      });
    }
  }

  const summary = {
    enabled: true,
    skipped: false,
    run_id: runId,
    ...discoverySummary,
    obs_aqidb_retention_days: config.obsAqidbObservsRetentionDays,
    obs_aqidb_cutoff_day_utc: obsAqidbCutoffDayUtc,
    target_day_count: dayWindows.length,
    direct_delete_day_count: directDeleteDayWindows.length,
    repair_day_count: repairDayWindows.length,
    processed_day_count: dayWindows.length,
    dropped_day_count: droppedDayCount,
    delete_error_count:
      sumIntField(batchSummaries, "delete_error_count") +
      sumIntField(batchSummaries, "delete_after_repair_error_count"),
    mismatch_after_repair_count: sumIntField(batchSummaries, "mismatch_after_repair_count"),
    connector_history_gate_blocked_bucket_count:
      sumIntField(batchSummaries, "connector_history_gate_blocked_bucket_count") +
      sumIntField(batchSummaries, "connector_history_gate_blocked_after_repair_bucket_count"),
    connector_history_gate_blocked_after_repair_bucket_count: sumIntField(
      batchSummaries,
      "connector_history_gate_blocked_after_repair_bucket_count",
    ),
    total_deleted_rows: sumBigIntField(batchSummaries, "total_deleted_rows").toString(),
    total_deleted_after_repair_rows: sumBigIntField(batchSummaries, "total_deleted_after_repair_rows").toString(),
    alert_condition_count: sumIntField(batchSummaries, "alert_condition_count"),
    duplicate_connector_day_skipped_count: sumIntField(
      batchSummaries,
      "duplicate_connector_day_skipped_count",
    ),
    duplicate_connector_day_skipped_preview: mergePreviewField(
      batchSummaries,
      "duplicate_connector_day_skipped_preview",
    ),
    ...aggregateAtomicDeletionSummaryForTest(batchSummaries),
    batch_summaries_preview: sampleRows(batchSummaries),
  };
  logStructured("INFO", "ingestdb_late_arrival_cleanup_summary", summary);
  return summary;
}

async function runPrune(config, adapters = {}) {
  const runPhaseARecentAdapter = adapters.runPhaseARecent || runPhaseARecent;
  const runPhaseBBackupAdapter = adapters.runPhaseBBackup || runPhaseBBackup;
  const runPruneSingleWindowAdapter = adapters.runPruneSingleWindow || runPruneSingleWindow;
  const runLateArrivalCleanupAdapter = adapters.runLateArrivalCleanup || runLateArrivalCleanup;

  const phaseARecentSummary = await runPhaseARecentAdapter(config);

  const phaseBRunId = randomUUID();
  const phaseBHistorySummary = await runPhaseBBackupAdapter({
    dryRun: config.dryRun,
    phaseB: config.phaseB,
    ingestRetentionDays: config.ingestDbRetentionDays,
    logStructured,
    runId: phaseBRunId,
  });
  if (phaseBHistorySummary?.enabled === true && phaseBHistorySummary?.status === "stopped_budget") {
    const overallWindow = buildWindow(
      config.maxHoursPerRun,
      config.ingestDbRetentionDays,
    );
    const skipped = (extra = {}) => ({
      enabled: false,
      skipped: true,
      reason: "phase_b_stopped_budget",
      ...extra,
    });
    const summary = {
      mode: config.dryRun ? "dry-run" : "delete",
      window_start: overallWindow.window_start,
      window_end: overallWindow.window_end,
      skipped: true,
      reason: "phase_b_stopped_budget",
      deletion_attempted: false,
      normal_prune: skipped({ deletion_attempted: false }),
      phase_a_recent: phaseARecentSummary,
      phase_b_history: phaseBHistorySummary,
      late_arrival: skipped(),
    };
    logStructured("WARNING", "ingestdb_prune_stopped_after_phase_b_budget", {
      phase_b_history_run_id: phaseBHistorySummary.run_id || phaseBRunId,
      phase_b_history_status: phaseBHistorySummary.status,
      stopped_for_budget: phaseBHistorySummary.stopped_for_budget === true,
      downstream_skip_reason: "phase_b_stopped_budget",
    });
    return summary;
  }
  const overallWindow = buildWindow(
    config.maxHoursPerRun,
    config.ingestDbRetentionDays,
  );
  const batches = splitWindowIntoBatches(
    overallWindow.window_start,
    overallWindow.window_end,
    DEFAULT_MAX_HOURS_PER_BATCH,
  );
  const processedConnectorDays = new Set();

  let pruneWindowSummary;
  if (batches.length <= 1) {
    pruneWindowSummary = await runPruneSingleWindowAdapter(config, batches[0] ?? overallWindow, {
      processed_connector_days: processedConnectorDays,
    });
  } else {
    const parentRunId = randomUUID();
    logStructured("INFO", "ingestdb_prune_batch_plan", {
      run_id: parentRunId,
      mode: config.dryRun ? "dry-run" : "delete",
      phase_b_history_enabled: Boolean(config.phaseB?.enabled),
      phase_b_history_run_id: phaseBHistorySummary?.run_id || null,
      window_start: overallWindow.window_start,
      window_end: overallWindow.window_end,
      ingestdb_retention_days: config.ingestDbRetentionDays,
      max_hours_per_run: config.maxHoursPerRun,
      batch_window_hours: DEFAULT_MAX_HOURS_PER_BATCH,
      batch_count: batches.length,
      batches_preview: sampleRows(batches),
    });

    const batchSummaries = [];
    for (const batch of batches) {
      const summary = await runPruneSingleWindowAdapter(config, batch, {
        parent_run_id: parentRunId,
        batch_index: batch.batch_index,
        batch_count: batches.length,
        processed_connector_days: processedConnectorDays,
      });
      batchSummaries.push(summary);
    }

    pruneWindowSummary = aggregateBatchSummary(
      config,
      overallWindow,
      batches,
      batchSummaries,
      parentRunId,
    );
  }

  let lateArrivalSummary = {
    enabled: false,
    skipped: true,
    reason: "not_started",
  };
  try {
    lateArrivalSummary = await runLateArrivalCleanupAdapter(config, overallWindow, {
      processed_connector_days: processedConnectorDays,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lateArrivalSummary = {
      enabled: true,
      skipped: false,
      error: message,
    };
    logStructured("WARNING", "ingestdb_late_arrival_cleanup_failed", {
      error: message,
    });
  }

  const combinedSummary = {
    ...pruneWindowSummary,
    duplicate_connector_day_skipped_count:
      toSafeInt(pruneWindowSummary.duplicate_connector_day_skipped_count)
      + toSafeInt(lateArrivalSummary.duplicate_connector_day_skipped_count),
    duplicate_connector_day_skipped_preview: sampleRows([
      ...(Array.isArray(pruneWindowSummary.duplicate_connector_day_skipped_preview)
        ? pruneWindowSummary.duplicate_connector_day_skipped_preview
        : []),
      ...(Array.isArray(lateArrivalSummary.duplicate_connector_day_skipped_preview)
        ? lateArrivalSummary.duplicate_connector_day_skipped_preview
        : []),
    ]),
    ...aggregateAtomicDeletionSummaryForTest([
      pruneWindowSummary,
      lateArrivalSummary,
    ]),
    phase_a_recent: phaseARecentSummary,
    phase_b_history: phaseBHistorySummary,
    late_arrival: lateArrivalSummary,
  };
  if (batches.length > 1) {
    logStructured(
      "INFO",
      config.dryRun ? "ingestdb_prune_dry_run_batched_summary" : "ingestdb_prune_delete_batched_summary",
      combinedSummary,
    );
  }
  return combinedSummary;
}

export async function runPruneForTest(config, adapters = {}) {
  return runPrune(config, adapters);
}

export async function executePruneDaily(config, adapters = {}) {
  const withDailyTaskRunAdapter = adapters.withDailyTaskRun || withDailyTaskRun;
  return withDailyTaskRunAdapter(
    {
      task_key: "ops.prune_daily",
      source_repo: "uk-aq-ops",
      source_worker: "uk_aq_prune_daily",
      ...githubActionsTaskRunMetadata(),
      startSummary: {
        dry_run: config.dryRun,
        max_hours_per_run: config.maxHoursPerRun,
        ingestdb_retention_days: config.ingestDbRetentionDays,
        phase_a_enabled: config.phaseAEnabled,
        phase_b_enabled: Boolean(config.phaseB?.enabled),
      },
      buildFinishedSummary: compactPruneHealthSummary,
    },
    () => runPrune(config, adapters),
  );
}

export async function reportPruneDailyError(error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || null : null;
  const errorId = randomUUID();
  const createdAt = nowIso();
  const errorPayload = {
    id: errorId,
    created_at: createdAt,
    source: context.execution_mode === "github_actions"
      ? "github_actions_ingestdb_prune"
      : "cloud_run_ingestdb_prune",
    severity: "error",
    message,
    stack,
    context,
  };

  const dropboxResult = await (async () => {
    try {
      return await uploadErrorPayloadToDropbox(errorPayload, createdAt, errorId);
    } catch (uploadError) {
      const uploadMessage = uploadError instanceof Error
        ? uploadError.message
        : String(uploadError);
      logStructured("ERROR", "ingestdb_prune_error_dropbox_upload_failed", {
        error_id: errorId,
        message: uploadMessage,
      });
      return { uploaded: false, reason: "upload_failed", upload_error: uploadMessage };
    }
  })();

  logStructured("ERROR", "ingestdb_prune_run_error", {
    error_id: errorId,
    message,
    request_method: context.request_method || "",
    request_path: context.request_path || "",
    dropbox_uploaded: Boolean(dropboxResult.uploaded),
    dropbox_path: dropboxResult.dropbox_path || null,
    dropbox_reason: dropboxResult.reason || null,
  });

  return {
    error_id: errorId,
    dropbox_uploaded: Boolean(dropboxResult.uploaded),
    dropbox_path: dropboxResult.dropbox_path || null,
    dropbox_reason: dropboxResult.reason || null,
  };
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

    const upstreamAuth = validateUpstreamAuth(req);
    if (!upstreamAuth.ok) {
      jsonResponse(res, upstreamAuth.status, { error: upstreamAuth.error });
      return;
    }

    const config = buildRunConfig(url);
    const summary = await executePruneDaily(config);
    jsonResponse(res, 200, summary);
  } catch (error) {
    const errorReport = await reportPruneDailyError(error, {
      request_method: req.method || "",
      request_path: requestPath,
      request_query: requestQuery,
      host: req.headers.host || "",
      user_agent: req.headers["user-agent"] || "",
    });
    jsonResponse(res, 500, {
      error: "ingestdb_prune_run_error",
      message: "Internal error. See logs with error_id.",
      error_id: errorReport.error_id,
      dropbox_uploaded: errorReport.dropbox_uploaded,
      dropbox_path: errorReport.dropbox_path,
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8080, 1, 65535);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, () => {
    logStructured("INFO", "ingestdb_prune_service_started", {
      port,
      default_dry_run: DEFAULT_DRY_RUN,
      default_ingestdb_retention_days: DEFAULT_INGESTDB_RETENTION_DAYS,
      default_max_hours_per_run: DEFAULT_MAX_HOURS_PER_RUN,
      default_obs_aqidb_observs_retention_days: DEFAULT_OBSAQIDB_OBSERVS_RETENTION_DAYS,
    });
  });
}
