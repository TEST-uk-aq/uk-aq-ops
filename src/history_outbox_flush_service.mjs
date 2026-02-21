import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_FLUSH_CLAIM_BATCH_LIMIT = 20;
const DEFAULT_MAX_FLUSH_BATCHES = 30;
const RPC_SCHEMA = "uk_aq_public";

const RPC_OUTBOX_CLAIM = "uk_aq_rpc_history_outbox_claim";
const RPC_OUTBOX_RESOLVE = "uk_aq_rpc_history_outbox_resolve";
const RPC_HISTORY_UPSERT = "uk_aq_rpc_history_observations_upsert";
const RPC_HISTORY_RECEIPTS_UPSERT = "uk_aq_rpc_history_sync_receipt_daily_upsert";

function nowIso() {
  return new Date().toISOString();
}

function logStructured(severity, event, details = {}) {
  const payload = {
    severity,
    event,
    timestamp: nowIso(),
    ...details,
  };
  const line = JSON.stringify(payload);
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
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing bigint for ${fieldName}`);
  }
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`Invalid bigint for ${fieldName}: ${String(value)}`);
  }
}

function toBigIntString(value, fieldName) {
  return toBigInt(value, fieldName).toString();
}

function toIntField(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid integer for ${fieldName}: ${String(value)}`);
  }
  return Math.trunc(number);
}

function toObservedDay(observedAtIso) {
  return observedAtIso.slice(0, 10);
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
    alert_condition: summary.failed_entries > 0 || !summary.drained,
  };
}

function buildRunConfig(url) {
  const params = url.searchParams;
  return {
    supabaseUrl: requiredEnvAny(["SUPABASE_URL", "SB_URL"]),
    historySupabaseUrl: requiredEnvAny(["HISTORY_SUPABASE_URL", "HISTORY_URL"]),
    ingestSecretKey: requiredEnvAny(["SB_SECRET_KEY"]),
    historySecretKey: requiredEnvAny(["HISTORY_SECRET_KEY"]),
    flushClaimBatchLimit: parsePositiveInt(
      params.get("flushClaimBatchLimit") ?? process.env.FLUSH_CLAIM_BATCH_LIMIT,
      DEFAULT_FLUSH_CLAIM_BATCH_LIMIT,
      1,
      1_000,
    ),
    maxFlushBatches: parsePositiveInt(
      params.get("maxFlushBatches") ?? process.env.MAX_FLUSH_BATCHES,
      DEFAULT_MAX_FLUSH_BATCHES,
      1,
      1_000,
    ),
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function runFlush(config) {
  const runId = randomUUID();
  const ingestClient = createClient(config.supabaseUrl, config.ingestSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });
  const historyClient = createClient(config.historySupabaseUrl, config.historySecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });

  logStructured("INFO", "history_outbox_flush_service_run_start", {
    run_id: runId,
    flush_claim_batch_limit: config.flushClaimBatchLimit,
    max_flush_batches: config.maxFlushBatches,
  });

  const summary = await flushHistoryOutbox(
    ingestClient,
    historyClient,
    config.flushClaimBatchLimit,
    config.maxFlushBatches,
  );
  const payload = { run_id: runId, ...summary };

  if (summary.alert_condition) {
    logStructured("WARNING", "history_outbox_flush_service_run_warning", payload);
  } else {
    logStructured("INFO", "history_outbox_flush_service_run_summary", payload);
  }

  return payload;
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
    const summary = await runFlush(config);
    jsonResponse(res, 200, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("ERROR", "history_outbox_flush_service_run_error", { message });
    jsonResponse(res, 500, {
      error: "history_outbox_flush_service_run_error",
      message,
    });
  }
});

const port = parsePositiveInt(process.env.PORT, 8080, 1, 65535);
server.listen(port, () => {
  logStructured("INFO", "history_outbox_flush_service_started", {
    port,
    default_flush_claim_batch_limit: DEFAULT_FLUSH_CLAIM_BATCH_LIMIT,
    default_max_flush_batches: DEFAULT_MAX_FLUSH_BATCHES,
  });
});
