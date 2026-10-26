import { Client } from "pg";

const MEASUREMENT = "node_pg_connection_stream_bytes_read_delta";
const SERVICE_NAME = "ops.prune_phase_b";
const SOURCE_TYPE = "supabase_postgres";
const ROUTE_NAME = "postgres/history_compact_source";
const QUERY_NAME = "history_phase_b_read";
const METRICS_RPC = "uk_aq_rpc_service_egress_metrics_batch_upsert";
const METRICS_SCHEMA = "uk_aq_public";
const PATCH_MARKER = Symbol.for("uk_aq.phase_b_pg_source_egress_diagnostic");
const DELETION_APPLICATION_NAME = "uk-aq-prune-source-identity-delete";

const aggregate = {
  candidate_count: 0,
  measured_candidate_count: 0,
  source_row_count: 0,
  pg_source_socket_bytes_received: 0,
  deletion_revalidation_count: 0,
  measured_deletion_revalidation_count: 0,
  deletion_revalidation_source_row_count: 0,
  deletion_revalidation_pg_source_socket_bytes_received: 0,
};

let aggregateLogged = false;
const serviceMetrics = new Map();

function nowIso() {
  return new Date().toISOString();
}

function emitInfo(event, details = {}) {
  console.log(JSON.stringify({
    severity: "INFO",
    event,
    timestamp: nowIso(),
    ...details,
  }));
}

function socketBytesRead(client) {
  const raw = client?.connection?.stream?.bytesRead;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "n", "off"].includes(normalized);
}

function projectRefFromSupabaseUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const match = parsed.hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/);
    return match ? match[1] : null;
  } catch (_error) {
    return null;
  }
}

function projectRefFromPgClient(client) {
  const host = String(client?.connectionParameters?.host || "").trim().toLowerCase();
  const directHostMatch = host.match(/^db\.([a-z0-9-]+)\.supabase\.co$/);
  if (directHostMatch) return directHostMatch[1];

  const user = String(client?.connectionParameters?.user || "").trim().toLowerCase();
  const poolerUserMatch = user.match(/^postgres\.([a-z0-9-]+)$/);
  if (poolerUserMatch) return poolerUserMatch[1];

  return null;
}

function projectRefFromPgConnectionString(value) {
  try {
    const parsed = new URL(String(value || ""));
    const directHostMatch = parsed.hostname.toLowerCase().match(/^db\.([a-z0-9-]+)\.supabase\.co$/);
    if (directHostMatch) return directHostMatch[1];
    const user = decodeURIComponent(parsed.username || "").toLowerCase();
    const poolerUserMatch = user.match(/^postgres\.([a-z0-9-]+)$/);
    return poolerUserMatch ? poolerUserMatch[1] : null;
  } catch (_error) {
    return null;
  }
}

function sourceIdentity(client, env = process.env) {
  const projectRef = projectRefFromPgClient(client)
    || projectRefFromPgConnectionString(env.SUPABASE_DB_URL)
    || "";
  const ingestProjectRef = projectRefFromSupabaseUrl(env.SUPABASE_URL);
  const obsProjectRef = projectRefFromSupabaseUrl(env.OBS_AQIDB_SUPABASE_URL);
  let sourceName = "postgres";
  if (projectRef && projectRef === ingestProjectRef) sourceName = "ingestdb";
  if (projectRef && projectRef === obsProjectRef) sourceName = "obs_aqidb";
  return { project_ref: projectRef, source_name: sourceName };
}

function bucketMinuteIso(value = new Date()) {
  const bucket = new Date(value);
  bucket.setUTCSeconds(0, 0);
  return bucket.toISOString();
}

function registerServiceMetric({
  client,
  responseBytes,
  responseRows,
  durationMs,
  status,
  measurementAvailable,
}) {
  try {
    const identity = sourceIdentity(client);
    const bucketMinute = bucketMinuteIso();
    const semanticStatus = status === "error"
      ? "error"
      : measurementAvailable
        ? "ok"
        : "partial";
    const key = [
      bucketMinute,
      identity.project_ref,
      identity.source_name,
      semanticStatus,
    ].join("\u001f");
    const current = serviceMetrics.get(key) || {
      bucket_minute: bucketMinute,
      env_name: String(process.env.UK_AQ_ENV_NAME || "").trim().toLowerCase(),
      project_ref: identity.project_ref,
      service_name: SERVICE_NAME,
      source_type: SOURCE_TYPE,
      source_name: identity.source_name,
      route_name: ROUTE_NAME,
      query_name: QUERY_NAME,
      window_label: "",
      status: semanticStatus,
      request_count: 0,
      response_rows: 0,
      response_bytes_est: 0,
      upstream_bytes_est: 0,
      duration_ms: 0,
      error_count: 0,
      notes: {
        measurement_method: "postgres_socket",
        socket_counter_complete: measurementAvailable,
      },
    };
    current.request_count += 1;
    current.response_rows += Math.max(0, Number(responseRows) || 0);
    current.response_bytes_est += measurementAvailable
      ? Math.max(0, Number(responseBytes) || 0)
      : 0;
    current.duration_ms += Math.max(0, Math.trunc(Number(durationMs) || 0));
    current.error_count += status === "error" ? 1 : 0;
    current.notes.socket_counter_complete = Boolean(
      current.notes.socket_counter_complete && measurementAvailable,
    );
    serviceMetrics.set(key, current);
  } catch (_diagnosticError) {
    // Metrics aggregation must never affect Phase B behaviour.
  }
}

function dayUtcFromValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn(row, key) {
  return Boolean(row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, key));
}

function looksLikeCurrentPhaseBSourceRow(row) {
  return hasOwn(row, "connector_id")
    && hasOwn(row, "station_id")
    && hasOwn(row, "timeseries_id")
    && hasOwn(row, "pollutant_code")
    && hasOwn(row, "observed_at_utc")
    && hasOwn(row, "value")
    && hasOwn(row, "status");
}

function looksLikeCurrentPhaseBSourceQuery(cursor) {
  const text = typeof cursor?.text === "string" ? cursor.text : "";
  const canonicalSourceQuery = /from\s+uk_aq_ops\.uk_aq_phase_b_history_rows_v2\s*\(/i.test(text)
    && /\bstation_id\b/i.test(text)
    && /\bpollutant_code\b/i.test(text);
  const compactSourceQuery = /from\s+uk_aq_ops\.uk_aq_phase_b_history_compact_rows_v1\s*\(/i.test(text)
    && !/\bstation_id\b/i.test(text)
    && !/\bpollutant_code\b/i.test(text);
  return (canonicalSourceQuery || compactSourceQuery) && /\bstatus\b/i.test(text);
}

function queryText(config) {
  if (typeof config === "string") {
    return config;
  }
  if (config && typeof config.text === "string") {
    return config.text;
  }
  return "";
}

function queryValues(config, args) {
  if (config && typeof config === "object" && Array.isArray(config.values)) {
    return config.values;
  }
  return Array.isArray(args?.[0]) ? args[0] : [];
}

function looksLikeDeletionRevalidationQuery(client, config) {
  const applicationName = String(client?.connectionParameters?.application_name || "").trim();
  if (applicationName !== DELETION_APPLICATION_NAME) {
    return false;
  }
  const text = queryText(config);
  return /^\s*select\s+connector_id\s*,\s*station_id\s*,\s*timeseries_id\s*,\s*pollutant_code\s*,\s*observed_at_utc\s*,\s*value\s*,\s*status\s+from\s+uk_aq_ops\.uk_aq_phase_b_history_rows_v2\s*\(/is.test(text);
}

function classifyFromCursor(state, cursor) {
  if (!looksLikeCurrentPhaseBSourceQuery(cursor)) {
    return;
  }
  state.is_phase_b_source = true;
  const values = Array.isArray(cursor?.values) ? cursor.values : [];
  state.connector_id = positiveIntegerOrNull(values[0]);
  state.day_utc = dayUtcFromValue(values[1]);
}

function classifyFromRows(state, rows) {
  if (state.is_phase_b_source || !Array.isArray(rows) || rows.length === 0) {
    return;
  }
  const first = rows[0];
  if (!looksLikeCurrentPhaseBSourceRow(first)) {
    return;
  }
  state.is_phase_b_source = true;
  state.connector_id = positiveIntegerOrNull(first.connector_id);
  state.day_utc = dayUtcFromValue(first.observed_at_utc);
}

function finishMeasurement(state, client, status = "ok") {
  if (state.finished || !state.is_phase_b_source) {
    return;
  }
  state.finished = true;

  const endBytes = socketBytesRead(client);
  const measured = state.start_bytes !== null
    && endBytes !== null
    && endBytes >= state.start_bytes;
  const receivedBytes = measured ? endBytes - state.start_bytes : null;

  registerServiceMetric({
    client,
    responseBytes: receivedBytes,
    responseRows: state.source_row_count,
    durationMs: Date.now() - state.started_at_ms,
    status,
    measurementAvailable: measured,
  });

  aggregate.candidate_count += 1;
  aggregate.source_row_count += state.source_row_count;
  if (measured) {
    aggregate.measured_candidate_count += 1;
    aggregate.pg_source_socket_bytes_received += receivedBytes;
  }

  emitInfo("phase_b_history_pg_source_egress_diagnostic", {
    day_utc: state.day_utc,
    connector_id: state.connector_id,
    source_row_count: state.source_row_count,
    pg_source_socket_bytes_received: receivedBytes,
    pg_source_socket_counter_available: measured,
    measurement: MEASUREMENT,
    diagnostic_scope: "phase_b_target_day_observation_cursor",
    exact_supabase_billing_meter: false,
  });
}

function observeCursorRead(state, client, rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  classifyFromRows(state, normalizedRows);
  if (!state.is_phase_b_source) {
    return;
  }
  if (normalizedRows.length > 0) {
    state.source_row_count += normalizedRows.length;
    if (state.connector_id === null) {
      state.connector_id = positiveIntegerOrNull(normalizedRows[0]?.connector_id);
    }
    if (state.day_utc === null) {
      state.day_utc = dayUtcFromValue(normalizedRows[0]?.observed_at_utc);
    }
    return;
  }
  finishMeasurement(state, client);
}

function wrapCursorRead(client, cursor) {
  if (!cursor || typeof cursor.read !== "function" || cursor[PATCH_MARKER]) {
    return;
  }

  const state = {
    start_bytes: socketBytesRead(client),
    source_row_count: 0,
    connector_id: null,
    day_utc: null,
    is_phase_b_source: false,
    finished: false,
    started_at_ms: Date.now(),
  };
  classifyFromCursor(state, cursor);

  const originalRead = cursor.read.bind(cursor);
  cursor.read = function patchedRead(rowCount, callback) {
    if (typeof callback === "function") {
      return originalRead(rowCount, (error, rows, ...rest) => {
        try {
          if (!error) {
            observeCursorRead(state, client, rows);
          } else {
            finishMeasurement(state, client, "error");
          }
        } catch (_diagnosticError) {
          // Diagnostics must never affect Phase B behaviour.
        }
        callback(error, rows, ...rest);
      });
    }

    const result = originalRead(rowCount);
    if (!result || typeof result.then !== "function") {
      return result;
    }
    return result.then(
      (value) => {
        try {
          const rows = Array.isArray(value) ? value : value?.rows;
          observeCursorRead(state, client, rows);
        } catch (_diagnosticError) {
          // Diagnostics must never affect Phase B behaviour.
        }
        return value;
      },
      (error) => {
        try {
          finishMeasurement(state, client, "error");
        } catch (_diagnosticError) {
          // Diagnostics must never affect Phase B behaviour.
        }
        throw error;
      },
    );
  };

  Object.defineProperty(cursor, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function finishDeletionRevalidationMeasurement(state, client, result) {
  const endBytes = socketBytesRead(client);
  const measured = state.start_bytes !== null
    && endBytes !== null
    && endBytes >= state.start_bytes;
  const receivedBytes = measured ? endBytes - state.start_bytes : null;
  const sourceRowCount = Array.isArray(result?.rows) ? result.rows.length : 0;

  registerServiceMetric({
    client,
    responseBytes: receivedBytes,
    responseRows: sourceRowCount,
    durationMs: Date.now() - state.started_at_ms,
    status: "ok",
    measurementAvailable: measured,
  });

  aggregate.deletion_revalidation_count += 1;
  aggregate.deletion_revalidation_source_row_count += sourceRowCount;
  if (measured) {
    aggregate.measured_deletion_revalidation_count += 1;
    aggregate.deletion_revalidation_pg_source_socket_bytes_received += receivedBytes;
  }

  emitInfo("phase_b_history_pg_deletion_revalidation_egress_diagnostic", {
    day_utc: state.day_utc,
    connector_id: state.connector_id,
    source_row_count: sourceRowCount,
    pg_source_socket_bytes_received: receivedBytes,
    pg_source_socket_counter_available: measured,
    measurement: MEASUREMENT,
    diagnostic_scope: "phase_b_deletion_source_identity_revalidation",
    exact_supabase_billing_meter: false,
  });
}

if (!Client.prototype[PATCH_MARKER]) {
  const originalQuery = Client.prototype.query;
  Client.prototype.query = function patchedQuery(config, ...args) {
    let deletionRevalidationState = null;
    try {
      if (looksLikeDeletionRevalidationQuery(this, config)) {
        const values = queryValues(config, args);
        deletionRevalidationState = {
          start_bytes: socketBytesRead(this),
          connector_id: positiveIntegerOrNull(values[0]),
          day_utc: dayUtcFromValue(values[1]),
          started_at_ms: Date.now(),
        };
      }
      if (config && typeof config.read === "function" && typeof config.close === "function") {
        wrapCursorRead(this, config);
      }
    } catch (_diagnosticError) {
      deletionRevalidationState = null;
      // Diagnostics must never affect PostgreSQL query behaviour.
    }

    const result = originalQuery.call(this, config, ...args);
    if (!deletionRevalidationState || !result || typeof result.then !== "function") {
      return result;
    }
    return result.then(
      (value) => {
        try {
          finishDeletionRevalidationMeasurement(deletionRevalidationState, this, value);
        } catch (_diagnosticError) {
          // Diagnostics must never affect source-identity revalidation or deletion behaviour.
        }
        return value;
      },
      (error) => {
        try {
          const endBytes = socketBytesRead(this);
          const measured = deletionRevalidationState.start_bytes !== null
            && endBytes !== null
            && endBytes >= deletionRevalidationState.start_bytes;
          registerServiceMetric({
            client: this,
            responseBytes: measured ? endBytes - deletionRevalidationState.start_bytes : null,
            responseRows: 0,
            durationMs: Date.now() - deletionRevalidationState.started_at_ms,
            status: "error",
            measurementAvailable: measured,
          });
        } catch (_diagnosticError) {
          // Diagnostics must never affect source-identity revalidation or deletion behaviour.
        }
        throw error;
      },
    );
  };

  Object.defineProperty(Client.prototype, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export async function flushPhaseBServiceEgressMetrics({ env = process.env, fetchImpl = fetch } = {}) {
  if (!parseBool(env.UK_AQ_SERVICE_EGRESS_METRICS_ENABLED, false) || serviceMetrics.size === 0) {
    return { enabled: parseBool(env.UK_AQ_SERVICE_EGRESS_METRICS_ENABLED, false), rows: 0 };
  }

  const supabaseUrl = String(env.OBS_AQIDB_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!supabaseUrl || !serviceKey) {
    emitInfo("phase_b_history_service_egress_metrics_warning", {
      reason: "metrics_destination_not_configured",
    });
    return { enabled: true, rows: 0, error: "metrics_destination_not_configured" };
  }

  const canonicalEnvName = String(env.UK_AQ_ENV_NAME || "").trim();
  if (!["TEST", "LIVE"].includes(canonicalEnvName)) {
    emitInfo("phase_b_history_service_egress_metrics_warning", {
      reason: "metrics_environment_invalid",
    });
    return { enabled: true, rows: 0, error: "metrics_environment_invalid" };
  }
  const envName = canonicalEnvName.toLowerCase();
  const rows = Array.from(serviceMetrics.values(), (row) => ({ ...row, env_name: envName }));
  serviceMetrics.clear();
  try {
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/rpc/${METRICS_RPC}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Accept-Profile": METRICS_SCHEMA,
          "Content-Profile": METRICS_SCHEMA,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
          "x-ukaq-egress-bypass": "1",
        },
        body: JSON.stringify({ p_rows: rows }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`metrics_http_${response.status}`);
    }
    return { enabled: true, rows: rows.length };
  } catch (error) {
    emitInfo("phase_b_history_service_egress_metrics_warning", {
      reason: error instanceof Error && /^metrics_http_\d+$/.test(error.message)
        ? error.message
        : "metrics_request_failed",
      rows: rows.length,
    });
    return { enabled: true, rows: 0, error: "metrics_persistence_failed" };
  }
}

process.once("beforeExit", () => {
  if (
    aggregateLogged
    || (aggregate.candidate_count === 0 && aggregate.deletion_revalidation_count === 0)
  ) {
    return;
  }
  aggregateLogged = true;

  const allArchiveMeasurementsAvailable =
    aggregate.candidate_count === aggregate.measured_candidate_count;
  const allDeletionMeasurementsAvailable =
    aggregate.deletion_revalidation_count === aggregate.measured_deletion_revalidation_count;
  const combinedMeasurementComplete =
    allArchiveMeasurementsAvailable && allDeletionMeasurementsAvailable;
  const combinedBytes = combinedMeasurementComplete
    ? aggregate.pg_source_socket_bytes_received
      + aggregate.deletion_revalidation_pg_source_socket_bytes_received
    : null;

  emitInfo("phase_b_history_pg_source_egress_run_summary", {
    measurement: MEASUREMENT,
    candidate_count: aggregate.candidate_count,
    measured_candidate_count: aggregate.measured_candidate_count,
    source_row_count: aggregate.source_row_count,
    pg_source_socket_bytes_received: aggregate.measured_candidate_count > 0
      ? aggregate.pg_source_socket_bytes_received
      : null,
    deletion_revalidation_count: aggregate.deletion_revalidation_count,
    measured_deletion_revalidation_count: aggregate.measured_deletion_revalidation_count,
    deletion_revalidation_source_row_count: aggregate.deletion_revalidation_source_row_count,
    deletion_revalidation_pg_source_socket_bytes_received:
      aggregate.measured_deletion_revalidation_count > 0
        ? aggregate.deletion_revalidation_pg_source_socket_bytes_received
        : null,
    combined_pg_source_socket_bytes_received: combinedBytes,
    combined_pg_source_socket_counter_complete: combinedMeasurementComplete,
    exact_supabase_billing_meter: false,
  });
});
