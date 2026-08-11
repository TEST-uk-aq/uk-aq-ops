import { Client } from "pg";

const MEASUREMENT = "node_pg_connection_stream_bytes_read_delta";
const PATCH_MARKER = Symbol.for("uk_aq.phase_b_pg_source_egress_diagnostic");

const aggregate = {
  candidate_count: 0,
  measured_candidate_count: 0,
  source_row_count: 0,
  pg_source_socket_bytes_received: 0,
};

let aggregateLogged = false;

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
  return /from\s+uk_aq_ops\.uk_aq_phase_b_history_rows_v2\s*\(/i.test(text)
    && /\bstation_id\b/i.test(text)
    && /\bpollutant_code\b/i.test(text)
    && /\bstatus\b/i.test(text);
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

function finishMeasurement(state, client) {
  if (state.finished || !state.is_phase_b_source) {
    return;
  }
  state.finished = true;

  const endBytes = socketBytesRead(client);
  const measured = state.start_bytes !== null
    && endBytes !== null
    && endBytes >= state.start_bytes;
  const receivedBytes = measured ? endBytes - state.start_bytes : null;

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
  };
  classifyFromCursor(state, cursor);

  const originalRead = cursor.read.bind(cursor);
  cursor.read = function patchedRead(rowCount, callback) {
    if (typeof callback === "function") {
      return originalRead(rowCount, (error, rows, ...rest) => {
        try {
          if (!error) {
            observeCursorRead(state, client, rows);
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

if (!Client.prototype[PATCH_MARKER]) {
  const originalQuery = Client.prototype.query;
  Client.prototype.query = function patchedQuery(config, ...args) {
    try {
      if (config && typeof config.read === "function" && typeof config.close === "function") {
        wrapCursorRead(this, config);
      }
    } catch (_diagnosticError) {
      // Diagnostics must never affect PostgreSQL query behaviour.
    }
    return originalQuery.call(this, config, ...args);
  };

  Object.defineProperty(Client.prototype, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

process.once("beforeExit", () => {
  if (aggregateLogged || aggregate.candidate_count === 0) {
    return;
  }
  aggregateLogged = true;
  emitInfo("phase_b_history_pg_source_egress_run_summary", {
    measurement: MEASUREMENT,
    candidate_count: aggregate.candidate_count,
    measured_candidate_count: aggregate.measured_candidate_count,
    source_row_count: aggregate.source_row_count,
    pg_source_socket_bytes_received: aggregate.measured_candidate_count > 0
      ? aggregate.pg_source_socket_bytes_received
      : null,
    exact_supabase_billing_meter: false,
  });
});
