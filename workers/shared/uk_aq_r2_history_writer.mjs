import { createHash } from "node:crypto";
import { Client } from "pg";

import { normalizeConnectorDayPair } from "./uk_aq_connector_day_gate.mjs";

// Keep the canonical object construction surface on the shared writer API.
// Source adapters may prepare rows independently, but every production writer
// uses these implementations for bytes, keys, manifests and validation.
export {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
  serializeCanonicalAqilevelDataV2Parquet,
  serializeCanonicalAqilevelDebugV2Parquet,
  serializeCanonicalObservationV2Parquet,
  validateCanonicalHistoryV2Manifest,
} from "./uk_aq_r2_history_canonical.mjs";

export const HISTORY_LOCK_NAMESPACES = Object.freeze({
  connectorDay: "connector_day",
  dayFinalization: "day_finalisation",
  globalIndex: "global_index_finalisation",
});

const HISTORY_LOCK_APPLICATION_NAMESPACE = "uk_aq:r2_history:v1";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDay(dayUtc) {
  const day = String(dayUtc || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!ISO_DAY_PATTERN.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid history writer UTC day: ${String(dayUtc || "")}`);
  }
  return day;
}

function lockResource({ namespace, dayUtc, connectorId }) {
  if (namespace === HISTORY_LOCK_NAMESPACES.connectorDay) {
    const pair = normalizeConnectorDayPair(dayUtc, connectorId);
    return `${pair.day_utc}|${pair.connector_id}`;
  }
  if (namespace === HISTORY_LOCK_NAMESPACES.dayFinalization) return normalizeDay(dayUtc);
  if (namespace === HISTORY_LOCK_NAMESPACES.globalIndex) return "";
  throw new Error(`Unknown history writer lock namespace: ${String(namespace || "")}`);
}

export function historyWriterLockIdentity({ namespace, dayUtc, connectorId }) {
  const resource = lockResource({ namespace, dayUtc, connectorId });
  const canonical = `${HISTORY_LOCK_APPLICATION_NAMESPACE}:${namespace}${resource ? `:${resource.replace("|", ":")}` : ""}`;
  const digest = createHash("sha256").update(canonical, "utf8").digest();
  return {
    namespace,
    resource,
    logical_identity: canonical,
    class_id: digest.readInt32BE(0),
    object_id: digest.readInt32BE(4),
  };
}

function recordDiagnostic(diagnostics, event) {
  if (Array.isArray(diagnostics)) diagnostics.push(event);
}

export async function withHistoryWriterLock({
  client,
  environment,
  namespace,
  dayUtc,
  connectorId,
  timeoutMs = 15_000,
  retryMs = 250,
  diagnostics,
  diagnosticEnvironment,
  signal,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}, callback) {
  if (!client?.query) throw new Error("History writer lock requires a PostgreSQL client");
  if (typeof callback !== "function") throw new Error("History writer lock callback is required");
  const identity = historyWriterLockIdentity({ namespace, dayUtc, connectorId });
  const diagnosticMetadata = String(diagnosticEnvironment || environment || "").trim()
    ? { diagnostic_environment: String(diagnosticEnvironment || environment).trim() }
    : {};
  const startedMs = now();
  const deadlineMs = startedMs + Math.max(0, Number(timeoutMs) || 0);
  let attempts = 0;
  let acquired = false;
  while (!acquired) {
    if (signal?.aborted) throw signal.reason || new Error("History writer lock acquisition cancelled");
    attempts += 1;
    const result = await client.query(
      "select pg_try_advisory_lock($1::integer, $2::integer) as acquired",
      [identity.class_id, identity.object_id],
    );
    acquired = result.rows?.[0]?.acquired === true;
    if (acquired) break;
    if (now() >= deadlineMs) {
      const error = new Error(
        `Timed out acquiring ${identity.namespace} history writer lock for ${identity.resource}`,
      );
      error.code = "UK_AQ_HISTORY_LOCK_TIMEOUT";
      error.lock = identity;
      recordDiagnostic(diagnostics, {
        event: "lock_timeout",
        ...identity,
        ...diagnosticMetadata,
        attempts,
        waited_ms: Math.max(0, now() - startedMs),
      });
      throw error;
    }
    await sleep(Math.min(Math.max(1, Number(retryMs) || 1), Math.max(1, deadlineMs - now())));
  }
  recordDiagnostic(diagnostics, {
    event: "lock_acquired",
    ...identity,
    ...diagnosticMetadata,
    attempts,
    waited_ms: Math.max(0, now() - startedMs),
  });
  let callbackError;
  try {
    return await callback(identity);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      const result = await client.query(
        "select pg_advisory_unlock($1::integer, $2::integer) as released",
        [identity.class_id, identity.object_id],
      );
      if (result.rows?.[0]?.released !== true) {
        throw new Error(`PostgreSQL did not release ${identity.namespace} history writer lock for ${identity.resource}`);
      }
      recordDiagnostic(diagnostics, { event: "lock_released", ...identity, ...diagnosticMetadata });
    } catch (releaseError) {
      recordDiagnostic(diagnostics, {
        event: "lock_release_failed",
        ...identity,
        ...diagnosticMetadata,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
      if (!callbackError) throw releaseError;
    }
  }
}

export function withConnectorDayHistoryLock(options, callback) {
  return withHistoryWriterLock({ ...options, namespace: HISTORY_LOCK_NAMESPACES.connectorDay }, callback);
}

export async function runCanonicalConnectorDayWriter({
  client,
  dayUtc,
  connectorId,
  write,
  verify,
  diagnostics,
  ...lockOptions
}) {
  if (typeof write !== "function" || typeof verify !== "function") {
    throw new Error("Canonical connector-day writer requires write and verify callbacks");
  }
  return await withConnectorDayHistoryLock({
    client,
    dayUtc,
    connectorId,
    diagnostics,
    ...lockOptions,
  }, async () => {
    const written = await write();
    const verified = await verify(written);
    return { written, verified };
  });
}

export function withDayFinalizationHistoryLock(options, callback) {
  return withHistoryWriterLock({ ...options, namespace: HISTORY_LOCK_NAMESPACES.dayFinalization }, callback);
}

export async function runCanonicalDayFinalizer({ client, dayUtc, finalize, verify, ...lockOptions }) {
  if (typeof finalize !== "function") throw new Error("Canonical day finalizer callback is required");
  return await withDayFinalizationHistoryLock({ client, dayUtc, ...lockOptions }, async () => {
    const finalized = await finalize();
    return typeof verify === "function" ? await verify(finalized) : finalized;
  });
}

export function isConfirmedR2ObjectAbsentError(error) {
  const rawStatus = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (rawStatus !== undefined && rawStatus !== null && rawStatus !== "") {
    return Number(rawStatus) === 404;
  }

  const code = String(error?.code || error?.name || "").trim().toLowerCase();
  if (["nosuchkey", "no_such_key", "notfound", "not_found"].includes(code)) return true;

  const message = String(error instanceof Error ? error.message : error || "").trim();
  return /^R2 GET failed \(404\) key=/.test(message);
}

export async function readParentManifestForBoundedRecovery({
  getObject,
  r2,
  key,
  validate,
}) {
  if (typeof getObject !== "function") throw new Error("Parent-manifest reader requires a getObject adapter");
  if (typeof validate !== "function") throw new Error("Parent-manifest reader requires a structural validator");

  let object;
  try {
    object = await getObject({ r2, key });
  } catch (error) {
    if (isConfirmedR2ObjectAbsentError(error)) {
      return {
        state: "absent",
        manifest: null,
        value: null,
        validation_error: error,
      };
    }
    throw error;
  }

  try {
    if (object?.body === undefined || object?.body === null) {
      throw new Error(`Parent manifest body is missing: ${key}`);
    }
    const manifest = JSON.parse(Buffer.from(object.body).toString("utf8"));
    const value = await validate(manifest);
    return {
      state: "valid",
      manifest,
      value,
      validation_error: null,
    };
  } catch (error) {
    return {
      state: "structurally_invalid",
      manifest: null,
      value: null,
      validation_error: error,
    };
  }
}

export function withGlobalIndexHistoryLock(options, callback) {
  return withHistoryWriterLock({ ...options, namespace: HISTORY_LOCK_NAMESPACES.globalIndex }, callback);
}

export async function runCanonicalGlobalIndexFinalizer({ client, finalize, ...lockOptions }) {
  if (typeof finalize !== "function") throw new Error("Canonical global index finalizer callback is required");
  return await withGlobalIndexHistoryLock({ client, ...lockOptions }, finalize);
}

export async function withHistoryWriterClient(databaseUrl, callback, options = {}) {
  const connectionString = String(databaseUrl || "").trim();
  if (!connectionString) throw new Error("History writer requires SUPABASE_DB_URL (or DATABASE_URL)");
  const client = new Client({
    connectionString,
    statement_timeout: Number(options.statementTimeoutMs || 30_000),
    query_timeout: Number(options.queryTimeoutMs || 30_000),
    connectionTimeoutMillis: Number(options.connectionTimeoutMs || 15_000),
    application_name: String(options.applicationName || "uk-aq-r2-history-writer"),
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export function mergeConnectorManifestReferences(existing = [], replacements = []) {
  const byConnector = new Map();
  for (const reference of [...existing, ...replacements]) {
    const connectorId = Number(reference?.connector_id);
    const manifestKey = String(reference?.manifest_key || "").trim();
    if (!Number.isSafeInteger(connectorId) || connectorId <= 0 || !manifestKey) {
      throw new Error("Invalid connector manifest reference");
    }
    byConnector.set(connectorId, { ...reference, connector_id: connectorId, manifest_key: manifestKey });
  }
  return Array.from(byConnector.values()).sort((left, right) => left.connector_id - right.connector_id);
}

export const INTEGRITY_SOURCE_CONNECTOR_CODES = Object.freeze({
  openaq: "openaq",
  sensorcommunity: "sensorcommunity",
  sos: "sos",
});

export async function readIntegrityIngestBoundaries(client, requestedSources) {
  const sources = Array.from(new Set(requestedSources.map((value) => String(value || "").trim().toLowerCase()))).sort();
  if (!sources.length || sources.some((source) => !INTEGRITY_SOURCE_CONNECTOR_CODES[source])) {
    throw new Error(`Invalid Integrity source scope: ${sources.join(",") || "(empty)"}`);
  }
  const connectorCodes = sources.map((source) => INTEGRITY_SOURCE_CONNECTOR_CODES[source]);
  const result = await client.query(
    `
select
  c.id::integer as connector_id,
  lower(btrim(c.connector_code)) as connector_code,
  min((o.observed_at at time zone 'UTC')::date)::text as earliest_ingest_day_utc
from uk_aq_core.connectors c
left join uk_aq_core.observations o on o.connector_id = c.id
where lower(btrim(c.connector_code)) = any($1::text[])
group by c.id, lower(btrim(c.connector_code))
order by lower(btrim(c.connector_code)), c.id
`,
    [connectorCodes],
  );
  const rows = result.rows || [];
  for (const connectorCode of connectorCodes) {
    const matches = rows.filter((row) => row.connector_code === connectorCode);
    if (matches.length !== 1) {
      throw new Error(`Integrity boundary requires exactly one connector for ${connectorCode}; found ${matches.length}`);
    }
  }
  return rows.map((row) => ({
    source: row.connector_code,
    connector_id: Number(row.connector_id),
    earliest_ingest_day_utc: row.earliest_ingest_day_utc || null,
  }));
}

export function evaluateIntegrityIngestBoundary({ requestedToDayUtc, boundaries }) {
  const requestedToDay = normalizeDay(requestedToDayUtc);
  const results = boundaries.map((boundary) => {
    const earliest = boundary.earliest_ingest_day_utc
      ? normalizeDay(boundary.earliest_ingest_day_utc)
      : null;
    return {
      ...boundary,
      earliest_ingestdb_day: earliest,
      requested_to_day_utc: requestedToDay,
      allowed: earliest === null || requestedToDay < earliest,
    };
  });
  return {
    allowed: results.length > 0 && results.every((result) => result.allowed),
    requested_to_day_utc: requestedToDay,
    connectors: results,
    blockers: results.filter((result) => !result.allowed),
  };
}
