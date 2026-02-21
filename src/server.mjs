import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_DRY_RUN = true;
const DEFAULT_MAX_HOURS_PER_RUN = 48;
const DEFAULT_INGESTDB_RETENTION_DAYS = 7;
const DEFAULT_DELETE_BATCH_SIZE = 50_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_HOUR = 10;
const DEFAULT_REPAIR_ONE_MISMATCH_BUCKET = true;
const DEFAULT_REPAIR_BUCKET_OUTBOX_CHUNK_SIZE = 1_000;
const DEFAULT_FLUSH_CLAIM_BATCH_LIMIT = 20;
const DEFAULT_MAX_FLUSH_BATCHES = 30;
const PREVIEW_LIMIT = 25;
const RPC_SCHEMA = "uk_aq_public";

const RPC_HOURLY_FINGERPRINT = "uk_aq_rpc_observations_hourly_fingerprint";
const RPC_DELETE_HOUR_BUCKET = "uk_aq_rpc_observations_delete_hour_bucket";
const RPC_REPAIR_ENQUEUE_HOUR_BUCKET = "uk_aq_rpc_history_outbox_enqueue_hour_bucket";
const RPC_OUTBOX_CLAIM = "uk_aq_rpc_history_outbox_claim";
const RPC_OUTBOX_RESOLVE = "uk_aq_rpc_history_outbox_resolve";
const RPC_HISTORY_UPSERT = "uk_aq_rpc_history_observations_upsert";
const RPC_HISTORY_RECEIPTS_UPSERT = "uk_aq_rpc_history_sync_receipt_daily_upsert";

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

function determineBucketMismatch(ingestBucket, historyBucket) {
  if (!ingestBucket && historyBucket) {
    return {
      connector_id: historyBucket.connector_id,
      hour_start: historyBucket.hour_start,
      reason: "missing_in_ingest",
      ingest_count: null,
      history_count: historyBucket.observation_count.toString(),
    };
  }

  if (!ingestBucket) {
    return null;
  }

  if (!historyBucket) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "missing_in_history",
      ingest_count: ingestBucket.observation_count.toString(),
      history_count: null,
    };
  }

  if (ingestBucket.observation_count !== historyBucket.observation_count) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "count_mismatch",
      ingest_count: ingestBucket.observation_count.toString(),
      history_count: historyBucket.observation_count.toString(),
    };
  }

  if (ingestBucket.fingerprint !== historyBucket.fingerprint) {
    return {
      connector_id: ingestBucket.connector_id,
      hour_start: ingestBucket.hour_start,
      reason: "fingerprint_mismatch",
      ingest_count: ingestBucket.observation_count.toString(),
      history_count: historyBucket.observation_count.toString(),
    };
  }

  return null;
}

function classifyRepairMismatches(mismatches) {
  const repairableMismatches = [];
  const historyCountGreaterThanIngest = [];

  for (const mismatch of mismatches) {
    if (mismatch.reason === "missing_in_history" || mismatch.reason === "fingerprint_mismatch") {
      repairableMismatches.push(mismatch);
      continue;
    }

    if (mismatch.reason !== "count_mismatch") {
      continue;
    }

    const ingestCount = toOptionalBigInt(mismatch.ingest_count, "mismatch.ingest_count");
    const historyCount = toOptionalBigInt(mismatch.history_count, "mismatch.history_count");
    if (ingestCount !== null && historyCount !== null && historyCount > ingestCount) {
      historyCountGreaterThanIngest.push(mismatch);
      continue;
    }
    repairableMismatches.push(mismatch);
  }

  return {
    repairableMismatches,
    historyCountGreaterThanIngest,
  };
}

function toIntField(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid integer for ${fieldName}: ${String(value)}`);
  }
  return Math.trunc(number);
}

function normalizeHistoryRows(inputRows) {
  const deduped = new Map();
  for (const row of inputRows) {
    const connectorId = toBigIntString(row.connector_id, "history_row.connector_id");
    const timeseriesId = toBigIntString(row.timeseries_id, "history_row.timeseries_id");
    const observedAt = toIso(row.observed_at, "history_row.observed_at");
    const value = row.value === undefined ? null : row.value;
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

function buildReceiptRows(historyRows) {
  const deduped = new Map();
  for (const row of historyRows) {
    const key = `${row.connector_id}|${row.timeseries_id}|${toObservedDay(row.observed_at)}`;
    deduped.set(key, {
      connector_id: row.connector_id,
      timeseries_id: row.timeseries_id,
      observed_day: toObservedDay(row.observed_at),
    });
  }
  return Array.from(deduped.values());
}

async function enqueueHistoryOutboxRepairBucket(client, mismatch, chunkSize) {
  const { data, error } = await client.schema(RPC_SCHEMA).rpc(RPC_REPAIR_ENQUEUE_HOUR_BUCKET, {
    p_connector_id: mismatch.connector_id,
    p_hour_start: mismatch.hour_start,
    p_chunk_size: chunkSize,
  });

  if (error) {
    throw new Error(`repair enqueue RPC failed: ${error.message}`);
  }

  const firstRow = Array.isArray(data) ? data[0] : data;
  return {
    connector_id: mismatch.connector_id,
    hour_start: mismatch.hour_start,
    rows_selected: toIntField(firstRow?.rows_selected ?? 0, "rows_selected"),
    outbox_entries_enqueued: toIntField(
      firstRow?.outbox_entries_enqueued ?? 0,
      "outbox_entries_enqueued",
    ),
  };
}

async function flushHistoryOutbox(mainClient, historyClient, claimBatchLimit, maxFlushBatches) {
  const summary = {
    batches_run: 0,
    claimed_entries: 0,
    delivered_rows: 0,
    failed_entries: 0,
    receipts_upserted: 0,
    rows_resolved: 0,
    drained: false,
  };

  for (let batch = 1; batch <= maxFlushBatches; batch += 1) {
    const claimResult = await mainClient.schema(RPC_SCHEMA).rpc(RPC_OUTBOX_CLAIM, {
      batch_limit: claimBatchLimit,
    });

    if (claimResult.error) {
      throw new Error(`outbox claim RPC failed: ${claimResult.error.message}`);
    }

    const entries = Array.isArray(claimResult.data) ? claimResult.data : [];
    if (!entries.length) {
      summary.drained = true;
      break;
    }
    summary.batches_run = batch;
    summary.claimed_entries += entries.length;

    const historyRows = normalizeHistoryRows(
      entries.flatMap((entry) => (Array.isArray(entry.payload) ? entry.payload : [])),
    );

    const resolutions = [];
    if (!historyRows.length) {
      for (const entry of entries) {
        resolutions.push({ id: entry.id, ok: true });
      }
    } else {
      try {
        const upsertResult = await historyClient.schema(RPC_SCHEMA).rpc(RPC_HISTORY_UPSERT, {
          rows: historyRows,
        });
        if (upsertResult.error) {
          throw new Error(upsertResult.error.message);
        }
        const upsertRow = Array.isArray(upsertResult.data) ? upsertResult.data[0] : upsertResult.data;
        summary.delivered_rows += toIntField(
          upsertRow?.observations_upserted ?? historyRows.length,
          "observations_upserted",
        );

        const receiptRows = buildReceiptRows(historyRows);
        if (receiptRows.length) {
          const receiptResult = await mainClient.schema(RPC_SCHEMA).rpc(RPC_HISTORY_RECEIPTS_UPSERT, {
            rows: receiptRows,
          });
          if (receiptResult.error) {
            throw new Error(`history receipts upsert failed: ${receiptResult.error.message}`);
          }
          const receiptRow = Array.isArray(receiptResult.data)
            ? receiptResult.data[0]
            : receiptResult.data;
          summary.receipts_upserted += toIntField(
            receiptRow?.rows_upserted ?? receiptRows.length,
            "rows_upserted",
          );
        }

        for (const entry of entries) {
          resolutions.push({ id: entry.id, ok: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.failed_entries += entries.length;
        for (const entry of entries) {
          resolutions.push({ id: entry.id, ok: false, error: message });
        }
      }
    }

    if (resolutions.length) {
      const resolveResult = await mainClient.schema(RPC_SCHEMA).rpc(RPC_OUTBOX_RESOLVE, {
        resolutions,
      });
      if (resolveResult.error) {
        throw new Error(`outbox resolve RPC failed: ${resolveResult.error.message}`);
      }
      const resolveRow = Array.isArray(resolveResult.data) ? resolveResult.data[0] : resolveResult.data;
      summary.rows_resolved += toIntField(
        resolveRow?.rows_resolved ?? resolutions.length,
        "rows_resolved",
      );
    }
  }

  return {
    ...summary,
    max_flush_batches_reached: !summary.drained,
  };
}

async function recheckSingleBucket(ingestClient, historyClient, mismatch) {
  const bucketWindow = buildBucketWindow(mismatch.hour_start);
  const [ingestRows, historyRows] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, bucketWindow.window_start, bucketWindow.window_end, "ingest_recheck"),
    fetchHourlyFingerprints(historyClient, bucketWindow.window_start, bucketWindow.window_end, "history_recheck"),
  ]);

  const ingestMap = new Map(ingestRows.map((row) => [row.key, row]));
  const historyMap = new Map(historyRows.map((row) => [row.key, row]));
  const key = buildBucketKey(mismatch.connector_id, mismatch.hour_start);
  const bucketMismatch = determineBucketMismatch(ingestMap.get(key), historyMap.get(key));

  return {
    connector_id: mismatch.connector_id,
    hour_start: mismatch.hour_start,
    verified: bucketMismatch === null,
    mismatch: bucketMismatch,
    ingest_bucket_found: ingestMap.has(key),
    history_bucket_found: historyMap.has(key),
  };
}

async function recheckMismatchBuckets(
  ingestClient,
  historyClient,
  windowStart,
  windowEnd,
  initialMismatches,
) {
  const [ingestRows, historyRows] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, windowStart, windowEnd, "ingest_recheck"),
    fetchHourlyFingerprints(historyClient, windowStart, windowEnd, "history_recheck"),
  ]);

  const ingestMap = new Map(ingestRows.map((row) => [row.key, row]));
  const historyMap = new Map(historyRows.map((row) => [row.key, row]));
  const nowDeletableBuckets = [];
  const stillMismatched = [];

  for (const mismatch of initialMismatches) {
    const key = buildBucketKey(mismatch.connector_id, mismatch.hour_start);
    const ingestBucket = ingestMap.get(key);
    const historyBucket = historyMap.get(key);
    const nextMismatch = determineBucketMismatch(ingestBucket, historyBucket);

    if (nextMismatch) {
      stillMismatched.push(nextMismatch);
      continue;
    }

    if (!ingestBucket || !historyBucket) {
      stillMismatched.push({
        connector_id: mismatch.connector_id,
        hour_start: mismatch.hour_start,
        reason: "missing_in_both_or_unknown_after_repair",
        ingest_count: ingestBucket ? ingestBucket.observation_count.toString() : null,
        history_count: historyBucket ? historyBucket.observation_count.toString() : null,
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

  return {
    nowDeletableBuckets,
    stillMismatched,
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
  const repairBucketOutboxChunkSize = parsePositiveInt(
    params.get("repairChunkSize") ?? process.env.REPAIR_BUCKET_OUTBOX_CHUNK_SIZE,
    DEFAULT_REPAIR_BUCKET_OUTBOX_CHUNK_SIZE,
    1,
    10_000,
  );
  const flushClaimBatchLimit = parsePositiveInt(
    params.get("flushClaimBatchLimit") ?? process.env.FLUSH_CLAIM_BATCH_LIMIT,
    DEFAULT_FLUSH_CLAIM_BATCH_LIMIT,
    1,
    1_000,
  );
  const maxFlushBatches = parsePositiveInt(
    params.get("maxFlushBatches") ?? process.env.MAX_FLUSH_BATCHES,
    DEFAULT_MAX_FLUSH_BATCHES,
    1,
    1_000,
  );

  return {
    supabaseUrl: requiredEnvAny(["SUPABASE_URL", "SB_URL"]),
    historySupabaseUrl: requiredEnvAny(["HISTORY_SUPABASE_URL", "HISTORY_URL"]),
    ingestSecretKey: requiredEnvAny(["SB_SECRET_KEY"]),
    historySecretKey: requiredEnvAny(["HISTORY_SECRET_KEY"]),
    dryRun,
    maxHoursPerRun,
    ingestDbRetentionDays,
    deleteBatchSize,
    maxDeleteBatchesPerHour,
    repairOneMismatchBucket,
    repairBucketOutboxChunkSize,
    flushClaimBatchLimit,
    maxFlushBatches,
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

  const { window_start: windowStart, window_end: windowEnd } = buildWindow(
    config.maxHoursPerRun,
    config.ingestDbRetentionDays,
  );
  logStructured("INFO", "ingestdb_prune_run_start", {
    run_id: runId,
    mode: config.dryRun ? "dry-run" : "delete",
    window_start: windowStart,
    window_end: windowEnd,
    ingestdb_retention_days: config.ingestDbRetentionDays,
    max_hours_per_run: config.maxHoursPerRun,
    delete_batch_size: config.deleteBatchSize,
    max_delete_batches_per_hour: config.maxDeleteBatchesPerHour,
    repair_one_mismatch_bucket: config.repairOneMismatchBucket,
    repair_bucket_outbox_chunk_size: config.repairBucketOutboxChunkSize,
    flush_claim_batch_limit: config.flushClaimBatchLimit,
    max_flush_batches: config.maxFlushBatches,
  });

  const [ingestBuckets, historyBuckets] = await Promise.all([
    fetchHourlyFingerprints(ingestClient, windowStart, windowEnd, "ingest"),
    fetchHourlyFingerprints(historyClient, windowStart, windowEnd, "history"),
  ]);

  const { deletableBuckets, mismatches, historyExtraBuckets } = compareBuckets(ingestBuckets, historyBuckets);
  const { repairableMismatches, historyCountGreaterThanIngest } = classifyRepairMismatches(mismatches);
  const repairCandidate = repairableMismatches[0] ?? null;

  for (const mismatch of mismatches) {
    logStructured("ERROR", "hour_bucket_mismatch", { run_id: runId, ...mismatch });
  }
  for (const mismatch of historyCountGreaterThanIngest) {
    logStructured("ERROR", "hour_bucket_history_count_exceeds_ingest", {
      run_id: runId,
      connector_id: mismatch.connector_id,
      hour_start: mismatch.hour_start,
      reason: mismatch.reason,
      ingest_count: mismatch.ingest_count,
      history_count: mismatch.history_count,
      alert_condition: true,
    });
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
    ingestdb_retention_days: config.ingestDbRetentionDays,
    ingest_bucket_count: ingestBuckets.length,
    history_bucket_count: historyBuckets.length,
    deletable_bucket_count: deletableBuckets.length,
    total_deletable_rows: totalDeletableRows.toString(),
    mismatch_count: mismatches.length,
    history_count_exceeds_ingest_count: historyCountGreaterThanIngest.length,
    history_extra_bucket_count: historyExtraBuckets.length,
  };

  if (config.dryRun) {
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
          const enqueueResult = await enqueueHistoryOutboxRepairBucket(
            ingestClient,
            repairCandidate,
            config.repairBucketOutboxChunkSize,
          );
          const flushResult = await flushHistoryOutbox(
            ingestClient,
            historyClient,
            config.flushClaimBatchLimit,
            config.maxFlushBatches,
          );
          const recheck = await recheckSingleBucket(ingestClient, historyClient, repairCandidate);
          repairPilot = {
            attempted: true,
            connector_id: repairCandidate.connector_id,
            hour_start: repairCandidate.hour_start,
            initial_reason: repairCandidate.reason,
            flush_scope: "all_due_outbox_entries",
            enqueue: enqueueResult,
            flush: flushResult,
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
      repair_one_mismatch_bucket_enabled: config.repairOneMismatchBucket,
      repair_one_mismatch_bucket_result: repairPilot,
      mismatches_preview: sampleRows(mismatches),
      deletable_buckets_preview: sampleRows(deletableBuckets.map(toBucketOutput)),
    });
    return {
      ...summaryBase,
      repair_one_mismatch_bucket_enabled: config.repairOneMismatchBucket,
      repair_one_mismatch_bucket_result: repairPilot,
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

  const repairEnqueueResults = [];
  const repairEnqueueErrors = [];
  let repairFlushResult = null;

  if (repairableMismatches.length > 0) {
    for (const mismatch of repairableMismatches) {
      try {
        const enqueueResult = await enqueueHistoryOutboxRepairBucket(
          ingestClient,
          mismatch,
          config.repairBucketOutboxChunkSize,
        );
        repairEnqueueResults.push(enqueueResult);
        logStructured("INFO", "hour_bucket_repair_enqueue_result", {
          run_id: runId,
          connector_id: enqueueResult.connector_id,
          hour_start: enqueueResult.hour_start,
          rows_selected: enqueueResult.rows_selected,
          outbox_entries_enqueued: enqueueResult.outbox_entries_enqueued,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorPayload = {
          connector_id: mismatch.connector_id,
          hour_start: mismatch.hour_start,
          reason: mismatch.reason,
          message,
        };
        repairEnqueueErrors.push(errorPayload);
        logStructured("ERROR", "hour_bucket_repair_enqueue_error", {
          run_id: runId,
          ...errorPayload,
        });
      }
    }

    try {
      repairFlushResult = await flushHistoryOutbox(
        ingestClient,
        historyClient,
        config.flushClaimBatchLimit,
        config.maxFlushBatches,
      );
      logStructured("INFO", "repair_outbox_flush_result", {
        run_id: runId,
        ...repairFlushResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repairFlushResult = {
        error: message,
      };
      logStructured("ERROR", "repair_outbox_flush_error", {
        run_id: runId,
        message,
      });
    }
  }

  let repairedNowDeletableBuckets = [];
  let mismatchesAfterRepair = mismatches;
  if (repairableMismatches.length > 0) {
    const recheckResult = await recheckMismatchBuckets(
      ingestClient,
      historyClient,
      windowStart,
      windowEnd,
      mismatches,
    );
    repairedNowDeletableBuckets = recheckResult.nowDeletableBuckets;
    mismatchesAfterRepair = recheckResult.stillMismatched;
  }

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

  const deletedAfterRepairBucketResults = [];
  const deleteAfterRepairErrors = [];
  const capAfterRepairWarnings = [];
  let totalDeletedAfterRepairRows = 0n;

  for (const bucket of repairedNowDeletableBuckets) {
    try {
      const result = await deleteHourBucket(
        ingestClient,
        bucket,
        config.deleteBatchSize,
        config.maxDeleteBatchesPerHour,
      );
      totalDeletedAfterRepairRows += result.deleted_rows;

      const bucketResult = {
        connector_id: result.connector_id,
        hour_start: result.hour_start,
        deleted_rows: result.deleted_rows.toString(),
        batches_run: result.batches_run,
        drained: result.drained,
      };
      deletedAfterRepairBucketResults.push(bucketResult);
      logStructured("INFO", "hour_bucket_delete_after_repair_result", {
        run_id: runId,
        ...bucketResult,
      });

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
        capAfterRepairWarnings.push(warningPayload);
        logStructured("WARNING", "hour_bucket_delete_after_repair_cap_reached", {
          run_id: runId,
          ...warningPayload,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorPayload = {
        connector_id: bucket.connector_id,
        hour_start: bucket.hour_start,
        reason: "delete_after_repair_error",
        message,
      };
      deleteAfterRepairErrors.push(errorPayload);
      logStructured("ERROR", "hour_bucket_delete_after_repair_error", {
        run_id: runId,
        ...errorPayload,
      });
    }
  }

  const finalMismatchCount = mismatchesAfterRepair.length;
  const totalRowsSelectedForRepair = repairEnqueueResults.reduce(
    (total, row) => total + BigInt(row.rows_selected),
    0n,
  );
  const totalOutboxEntriesEnqueuedForRepair = repairEnqueueResults.reduce(
    (total, row) => total + BigInt(row.outbox_entries_enqueued),
    0n,
  );

  const runSummary = {
    ...summaryBase,
    repairable_mismatch_bucket_count: repairableMismatches.length,
    repair_enqueue_success_count: repairEnqueueResults.length,
    repair_enqueue_error_count: repairEnqueueErrors.length,
    repair_rows_selected_total: totalRowsSelectedForRepair.toString(),
    repair_outbox_entries_enqueued_total: totalOutboxEntriesEnqueuedForRepair.toString(),
    repair_outbox_flush_result: repairFlushResult,
    mismatch_after_repair_count: finalMismatchCount,
    repaired_now_deletable_bucket_count: repairedNowDeletableBuckets.length,
    deleted_bucket_count: deletedBucketResults.length,
    total_deleted_rows: totalDeletedRows.toString(),
    deleted_after_repair_bucket_count: deletedAfterRepairBucketResults.length,
    total_deleted_after_repair_rows: totalDeletedAfterRepairRows.toString(),
    delete_error_count: deleteErrors.length,
    cap_warning_count: capWarnings.length,
    delete_after_repair_error_count: deleteAfterRepairErrors.length,
    cap_after_repair_warning_count: capAfterRepairWarnings.length,
    alert_condition_count:
      finalMismatchCount +
      deleteErrors.length +
      capWarnings.length +
      repairEnqueueErrors.length +
      deleteAfterRepairErrors.length +
      capAfterRepairWarnings.length,
    deleted_buckets_preview: sampleRows(deletedBucketResults),
    deleted_after_repair_buckets_preview: sampleRows(deletedAfterRepairBucketResults),
    mismatches_before_repair_preview: sampleRows(mismatches),
    mismatches_after_repair_preview: sampleRows(mismatchesAfterRepair),
    repair_enqueue_results_preview: sampleRows(repairEnqueueResults),
    repair_enqueue_errors_preview: sampleRows(repairEnqueueErrors),
    delete_errors_preview: sampleRows(deleteErrors),
    cap_warnings_preview: sampleRows(capWarnings),
    delete_after_repair_errors_preview: sampleRows(deleteAfterRepairErrors),
    cap_after_repair_warnings_preview: sampleRows(capAfterRepairWarnings),
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
    default_ingestdb_retention_days: DEFAULT_INGESTDB_RETENTION_DAYS,
    default_max_hours_per_run: DEFAULT_MAX_HOURS_PER_RUN,
  });
});
