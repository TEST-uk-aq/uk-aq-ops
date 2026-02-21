import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_DRY_RUN = true;
const DEFAULT_MAX_HOURS_PER_RUN = 48;
const DEFAULT_DELETE_BATCH_SIZE = 50_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_HOUR = 10;
const PREVIEW_LIMIT = 25;
const RPC_SCHEMA = "uk_aq_public";

const RPC_HOURLY_FINGERPRINT = "uk_aq_rpc_observations_hourly_fingerprint";
const RPC_DELETE_HOUR_BUCKET = "uk_aq_rpc_observations_delete_hour_bucket";

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

function buildWindow(maxHoursPerRun) {
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
  const windowEndMs = utcMidnightMs - (7 * DAY_MS);
  const windowStartMs = windowEndMs - (maxHoursPerRun * HOUR_MS);
  return {
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(windowEndMs).toISOString(),
  };
}

function buildBucketKey(connectorId, hourStartIso) {
  return `${connectorId}|${hourStartIso}`;
}

function sampleRows(rows, limit = PREVIEW_LIMIT) {
  return rows.slice(0, limit);
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

async function fetchHourlyFingerprints(client, windowStart, windowEnd, sourceName) {
  const { data, error } = await client.schema(RPC_SCHEMA).rpc(RPC_HOURLY_FINGERPRINT, {
    window_start: windowStart,
    window_end: windowEnd,
  });

  if (error) {
    throw new Error(`${sourceName} fingerprint RPC failed: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  return normalizeFingerprintRows(rows, sourceName);
}

function compareBuckets(ingestBuckets, historyBuckets) {
  const ingestByKey = new Map(ingestBuckets.map((row) => [row.key, row]));
  const historyByKey = new Map(historyBuckets.map((row) => [row.key, row]));

  const deletableBuckets = [];
  const mismatches = [];
  const historyExtraBuckets = [];

  for (const ingest of ingestBuckets) {
    const history = historyByKey.get(ingest.key);
    if (!history) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "missing_in_history",
        ingest_count: ingest.observation_count.toString(),
        history_count: null,
      });
      continue;
    }

    if (ingest.observation_count !== history.observation_count) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "count_mismatch",
        ingest_count: ingest.observation_count.toString(),
        history_count: history.observation_count.toString(),
      });
      continue;
    }

    if (ingest.fingerprint !== history.fingerprint) {
      mismatches.push({
        connector_id: ingest.connector_id,
        hour_start: ingest.hour_start,
        reason: "fingerprint_mismatch",
        ingest_count: ingest.observation_count.toString(),
        history_count: history.observation_count.toString(),
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

  for (const history of historyBuckets) {
    if (!ingestByKey.has(history.key)) {
      historyExtraBuckets.push({
        connector_id: history.connector_id,
        hour_start: history.hour_start,
        observation_count: history.observation_count.toString(),
      });
    }
  }

  return {
    deletableBuckets,
    mismatches,
    historyExtraBuckets,
  };
}

async function deleteHourBucket(client, bucket, deleteBatchSize, maxDeleteBatchesPerHour) {
  let totalDeleted = 0n;
  let batchesRun = 0;
  let drained = false;
  let lastDeleted = 0;

  for (let batchNumber = 1; batchNumber <= maxDeleteBatchesPerHour; batchNumber += 1) {
    batchesRun = batchNumber;
    const { data, error } = await client.schema(RPC_SCHEMA).rpc(RPC_DELETE_HOUR_BUCKET, {
      p_connector_id: bucket.connector_id,
      p_hour_start: bucket.hour_start,
      p_delete_limit: deleteBatchSize,
    });

    if (error) {
      throw new Error(`delete RPC failed: ${error.message}`);
    }

    const firstRow = Array.isArray(data) ? data[0] : data;
    const deletedCount = Number(firstRow?.deleted_count ?? 0);
    if (!Number.isFinite(deletedCount) || deletedCount < 0) {
      throw new Error(`delete RPC returned invalid deleted_count: ${String(firstRow?.deleted_count)}`);
    }

    lastDeleted = deletedCount;
    if (deletedCount === 0) {
      drained = true;
      break;
    }
    totalDeleted += BigInt(deletedCount);
  }

  return {
    connector_id: bucket.connector_id,
    hour_start: bucket.hour_start,
    deleted_rows: totalDeleted,
    batches_run: batchesRun,
    drained,
    max_batches_reached_with_remaining_rows: !drained && lastDeleted > 0,
  };
}

function buildRunConfig(url) {
  const params = url.searchParams;

  const dryRun = parseBoolean(params.get("dryRun") ?? process.env.DRY_RUN, DEFAULT_DRY_RUN);
  const maxHoursPerRun = parsePositiveInt(
    params.get("maxHours") ?? process.env.MAX_HOURS_PER_RUN,
    DEFAULT_MAX_HOURS_PER_RUN,
    1,
    24 * 31,
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

  return {
    supabaseUrl: requiredEnvAny(["SUPABASE_URL", "SB_URL"]),
    historySupabaseUrl: requiredEnvAny(["HISTORY_SUPABASE_URL", "HISTORY_URL"]),
    ingestSecretKey: requiredEnvAny(["SB_SECRET_KEY"]),
    historySecretKey: requiredEnvAny(["HISTORY_SECRET_KEY"]),
    dryRun,
    maxHoursPerRun,
    deleteBatchSize,
    maxDeleteBatchesPerHour,
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

async function runPrune(config) {
  const runId = randomUUID();
  const ingestClient = createClient(config.supabaseUrl, config.ingestSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });
  const historyClient = createClient(config.historySupabaseUrl, config.historySecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });

  const { window_start: windowStart, window_end: windowEnd } = buildWindow(config.maxHoursPerRun);
  logStructured("INFO", "ingestdb_prune_run_start", {
    run_id: runId,
    mode: config.dryRun ? "dry-run" : "delete",
    window_start: windowStart,
    window_end: windowEnd,
    max_hours_per_run: config.maxHoursPerRun,
    delete_batch_size: config.deleteBatchSize,
    max_delete_batches_per_hour: config.maxDeleteBatchesPerHour,
  });

  const [ingestBuckets, historyBuckets] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, windowStart, windowEnd, "ingest"),
    fetchHourlyFingerprints(historyClient, windowStart, windowEnd, "history"),
  ]);

  const { deletableBuckets, mismatches, historyExtraBuckets } = compareBuckets(
    ingestBuckets,
    historyBuckets,
  );

  for (const mismatch of mismatches) {
    logStructured("ERROR", "hour_bucket_mismatch", { run_id: runId, ...mismatch });
  }
  if (historyExtraBuckets.length > 0) {
    logStructured("INFO", "history_extra_buckets", {
      run_id: runId,
      count: historyExtraBuckets.length,
      sample: sampleRows(historyExtraBuckets),
    });
  }

  const totalDeletableRows = deletableBuckets.reduce((total, row) => total + row.observation_count, 0n);
  const summaryBase = {
    run_id: runId,
    mode: config.dryRun ? "dry-run" : "delete",
    window_start: windowStart,
    window_end: windowEnd,
    ingest_bucket_count: ingestBuckets.length,
    history_bucket_count: historyBuckets.length,
    deletable_bucket_count: deletableBuckets.length,
    total_deletable_rows: totalDeletableRows.toString(),
    mismatch_count: mismatches.length,
    history_extra_bucket_count: historyExtraBuckets.length,
  };

  if (config.dryRun) {
    for (const bucket of deletableBuckets) {
      logStructured("INFO", "hour_bucket_deletable_plan", {
        run_id: runId,
        connector_id: bucket.connector_id,
        hour_start: bucket.hour_start,
        observation_count: bucket.observation_count.toString(),
      });
    }
    logStructured("INFO", "ingestdb_prune_dry_run_summary", {
      ...summaryBase,
      mismatches_preview: sampleRows(mismatches),
      deletable_buckets_preview: sampleRows(deletableBuckets.map(toBucketOutput)),
    });
    return {
      ...summaryBase,
      deletable_buckets_preview: sampleRows(deletableBuckets.map(toBucketOutput)),
      mismatches_preview: sampleRows(mismatches),
    };
  }

  const deletedBucketResults = [];
  const deleteErrors = [];
  const capWarnings = [];
  let totalDeletedRows = 0n;

  for (const bucket of deletableBuckets) {
    try {
      const result = await deleteHourBucket(
        ingestClient,
        bucket,
        config.deleteBatchSize,
        config.maxDeleteBatchesPerHour,
      );
      totalDeletedRows += result.deleted_rows;

      const bucketResult = {
        connector_id: result.connector_id,
        hour_start: result.hour_start,
        deleted_rows: result.deleted_rows.toString(),
        batches_run: result.batches_run,
        drained: result.drained,
      };
      deletedBucketResults.push(bucketResult);
      logStructured("INFO", "hour_bucket_delete_result", { run_id: runId, ...bucketResult });

      if (result.max_batches_reached_with_remaining_rows) {
        const warningPayload = {
          connector_id: result.connector_id,
          hour_start: result.hour_start,
          deleted_rows: result.deleted_rows.toString(),
          batches_run: result.batches_run,
          max_delete_batches_per_hour: config.maxDeleteBatchesPerHour,
          reason: "max_batches_reached_before_drain",
          alert_condition: true,
        };
        capWarnings.push(warningPayload);
        logStructured("WARNING", "hour_bucket_delete_cap_reached", { run_id: runId, ...warningPayload });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorPayload = {
        connector_id: bucket.connector_id,
        hour_start: bucket.hour_start,
        reason: "delete_error",
        message,
      };
      deleteErrors.push(errorPayload);
      logStructured("ERROR", "hour_bucket_delete_error", { run_id: runId, ...errorPayload });
    }
  }

  const runSummary = {
    ...summaryBase,
    deleted_bucket_count: deletedBucketResults.length,
    total_deleted_rows: totalDeletedRows.toString(),
    delete_error_count: deleteErrors.length,
    cap_warning_count: capWarnings.length,
    alert_condition_count: mismatches.length + deleteErrors.length + capWarnings.length,
    deleted_buckets_preview: sampleRows(deletedBucketResults),
    mismatches_preview: sampleRows(mismatches),
    delete_errors_preview: sampleRows(deleteErrors),
    cap_warnings_preview: sampleRows(capWarnings),
  };
  logStructured("INFO", "ingestdb_prune_delete_summary", runSummary);
  return runSummary;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

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

    const config = buildRunConfig(url);
    const summary = await runPrune(config);
    jsonResponse(res, 200, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("ERROR", "ingestdb_prune_run_error", { message });
    jsonResponse(res, 500, {
      error: "ingestdb_prune_run_error",
      message,
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8080, 1, 65535);
server.listen(port, () => {
  logStructured("INFO", "ingestdb_prune_service_started", {
    port,
    default_dry_run: DEFAULT_DRY_RUN,
    default_max_hours_per_run: DEFAULT_MAX_HOURS_PER_RUN,
  });
});
