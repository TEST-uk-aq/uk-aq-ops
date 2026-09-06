import { Client } from "pg";
import { normalizePruneConnectorSourceIdentity } from "./uk_aq_prune_connector_source_identity.mjs";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMPLETION_SOURCES = new Set(["prune_daily_phase_b"]);

export function normalizeConnectorDayPair(dayUtc, connectorId) {
  let day;
  if (dayUtc instanceof Date) {
    if (
      Number.isNaN(dayUtc.getTime())
      || dayUtc.getUTCHours() !== 0
      || dayUtc.getUTCMinutes() !== 0
      || dayUtc.getUTCSeconds() !== 0
      || dayUtc.getUTCMilliseconds() !== 0
    ) {
      throw new Error(`Invalid connector-day UTC date: ${String(dayUtc || "")}`);
    }
    day = dayUtc.toISOString().slice(0, 10);
  } else if (typeof dayUtc === "string") {
    day = dayUtc.trim();
  } else {
    throw new Error(`Invalid connector-day UTC date: ${String(dayUtc || "")}`);
  }
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  const connector = Number(connectorId);
  if (
    !ISO_DAY_PATTERN.test(day)
    || Number.isNaN(parsedDay.getTime())
    || parsedDay.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`Invalid connector-day UTC date: ${String(dayUtc || "")}`);
  }
  if (!Number.isSafeInteger(connector) || connector <= 0) {
    throw new Error(`Invalid connector-day connector_id: ${String(connectorId || "")}`);
  }
  return { day_utc: day, connector_id: connector };
}

export function connectorDayGateKey(dayUtc, connectorId) {
  const pair = normalizeConnectorDayPair(dayUtc, connectorId);
  return `${pair.day_utc}|${pair.connector_id}`;
}

export function canonicalObservationConnectorManifestKey(dayUtc, connectorId) {
  const pair = normalizeConnectorDayPair(dayUtc, connectorId);
  return `history/v2/observations/day_utc=${pair.day_utc}/connector_id=${pair.connector_id}/manifest.json`;
}

export function isValidConnectorHistoryGateEvidence(row) {
  if (!row || row.history_done !== true) return false;
  let expectedKey;
  try {
    expectedKey = canonicalObservationConnectorManifestKey(row.day_utc, row.connector_id);
  } catch (_error) {
    return false;
  }
  const manifestHash = String(row.history_manifest_hash || "").trim();
  const completedAt = String(row.history_completed_at || "").trim();
  const completionSource = String(row.completion_source || "").trim();
  let historyRowCount;
  let historyFileCount;
  let historyTotalBytes;
  let sourceIdentity;
  try {
    historyRowCount = normalizeNonNegativeInteger(row.history_row_count, "history_row_count");
    historyFileCount = normalizeNonNegativeInteger(row.history_file_count, "history_file_count");
    historyTotalBytes = normalizeNonNegativeInteger(row.history_total_bytes, "history_total_bytes");
    sourceIdentity = normalizePruneConnectorSourceIdentity(row);
  } catch (_error) {
    return false;
  }
  const countsAreConsistent = historyRowCount === 0
    ? historyFileCount === 0 && historyTotalBytes === 0
    : historyFileCount > 0 && historyTotalBytes > 0;
  return (
    String(row.history_manifest_key || "").trim() === expectedKey
    && MANIFEST_HASH_PATTERN.test(manifestHash)
    && completedAt.length > 0
    && !Number.isNaN(Date.parse(completedAt))
    && completionSource === "prune_daily_phase_b"
    && countsAreConsistent
    && sourceIdentity.source_content_hash_row_count === historyRowCount
  );
}

function normalizeNonNegativeInteger(value, fieldName) {
  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

export function normalizeConnectorGateCompletionEvidence(evidence) {
  const pair = normalizeConnectorDayPair(evidence?.day_utc, evidence?.connector_id);
  const manifestKey = String(evidence?.history_manifest_key || "").trim();
  const expectedKey = canonicalObservationConnectorManifestKey(pair.day_utc, pair.connector_id);
  if (manifestKey !== expectedKey) {
    throw new Error(`Connector gate manifest key is not canonical: ${manifestKey || "(missing)"}`);
  }
  const manifestHash = String(evidence?.history_manifest_hash || "").trim();
  if (!MANIFEST_HASH_PATTERN.test(manifestHash)) {
    throw new Error("Connector gate manifest hash must be a lowercase SHA-256 hex digest");
  }
  const completionSource = String(evidence?.completion_source || "").trim();
  if (!COMPLETION_SOURCES.has(completionSource)) {
    throw new Error(`Invalid connector gate completion_source: ${completionSource || "(missing)"}`);
  }
  const historyRowCount = normalizeNonNegativeInteger(evidence?.history_row_count, "history_row_count");
  const historyFileCount = normalizeNonNegativeInteger(evidence?.history_file_count, "history_file_count");
  const historyTotalBytes = normalizeNonNegativeInteger(evidence?.history_total_bytes, "history_total_bytes");
  const sourceIdentity = normalizePruneConnectorSourceIdentity(evidence);
  if (
    (historyRowCount === 0 && (historyFileCount !== 0 || historyTotalBytes !== 0))
    || (historyRowCount > 0 && (historyFileCount === 0 || historyTotalBytes === 0))
  ) {
    throw new Error("Connector gate row, file and byte counts are internally inconsistent");
  }
  if (sourceIdentity.source_content_hash_row_count !== historyRowCount) {
    throw new Error("Connector gate source identity row count must equal history_row_count");
  }
  return {
    ...pair,
    history_run_id: String(evidence?.history_run_id || "").trim() || null,
    history_manifest_key: manifestKey,
    history_manifest_hash: manifestHash,
    history_row_count: historyRowCount,
    history_file_count: historyFileCount,
    history_total_bytes: historyTotalBytes,
    ...sourceIdentity,
    completion_source: completionSource,
  };
}

export async function setConnectorDayGateIncomplete(client, pairInput) {
  const pair = normalizeConnectorDayPair(pairInput?.day_utc, pairInput?.connector_id);
  await client.query(
    `
insert into uk_aq_ops.prune_connector_day_gates (
  day_utc,
  connector_id,
  history_done,
  updated_at
)
values ($1::date, $2::integer, false, now())
on conflict (day_utc, connector_id)
do update set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_manifest_hash = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  source_content_hash = null,
  source_content_hash_contract_version = null,
  source_content_hash_row_count = null,
  completion_source = null,
  updated_at = now()
`,
    [pair.day_utc, pair.connector_id],
  );
  return pair;
}

export async function setConnectorDayGateComplete(client, evidenceInput) {
  const evidence = normalizeConnectorGateCompletionEvidence(evidenceInput);
  await client.query(
    `
insert into uk_aq_ops.prune_connector_day_gates (
  day_utc,
  connector_id,
  history_done,
  history_run_id,
  history_manifest_key,
  history_manifest_hash,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  source_content_hash,
  source_content_hash_contract_version,
  source_content_hash_row_count,
  completion_source,
  updated_at
)
values (
  $1::date,
  $2::integer,
  true,
  $3,
  $4,
  $5,
  $6::bigint,
  $7::integer,
  $8::bigint,
  now(),
  $9,
  $10::integer,
  $11::bigint,
  $12,
  now()
)
on conflict (day_utc, connector_id)
do update set
  history_done = true,
  history_run_id = excluded.history_run_id,
  history_manifest_key = excluded.history_manifest_key,
  history_manifest_hash = excluded.history_manifest_hash,
  history_row_count = excluded.history_row_count,
  history_file_count = excluded.history_file_count,
  history_total_bytes = excluded.history_total_bytes,
  history_completed_at = excluded.history_completed_at,
  source_content_hash = excluded.source_content_hash,
  source_content_hash_contract_version = excluded.source_content_hash_contract_version,
  source_content_hash_row_count = excluded.source_content_hash_row_count,
  completion_source = excluded.completion_source,
  updated_at = now()
`,
    [
      evidence.day_utc,
      evidence.connector_id,
      evidence.history_run_id,
      evidence.history_manifest_key,
      evidence.history_manifest_hash,
      evidence.history_row_count,
      evidence.history_file_count,
      evidence.history_total_bytes,
      evidence.source_content_hash,
      evidence.source_content_hash_contract_version,
      evidence.source_content_hash_row_count,
      evidence.completion_source,
    ],
  );
  return evidence;
}

export async function withConnectorDayGateClient(databaseUrl, callback) {
  const connectionString = String(databaseUrl || "").trim();
  if (!connectionString) throw new Error("Connector-day gate requires SUPABASE_DB_URL (or DATABASE_URL)");
  const client = new Client({
    connectionString,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: "uk-aq-connector-day-gate",
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}
