import { Client } from "pg";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMPLETION_SOURCES = new Set(["prune_daily_phase_b"]);

export function normalizeConnectorDayPair(dayUtc, connectorId) {
  const day = String(dayUtc || "").trim();
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
  const manifestHash = String(row.history_manifest_hash || "").trim().toLowerCase();
  const completedAt = String(row.history_completed_at || "").trim();
  return (
    String(row.history_manifest_key || "").trim() === expectedKey
    && MANIFEST_HASH_PATTERN.test(manifestHash)
    && completedAt.length > 0
    && !Number.isNaN(Date.parse(completedAt))
  );
}

function normalizeNonNegativeInteger(value, fieldName) {
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
  const manifestHash = String(evidence?.history_manifest_hash || "").trim().toLowerCase();
  if (!MANIFEST_HASH_PATTERN.test(manifestHash)) {
    throw new Error("Connector gate manifest hash must be a lowercase SHA-256 hex digest");
  }
  const completionSource = String(evidence?.completion_source || "").trim();
  if (!COMPLETION_SOURCES.has(completionSource)) {
    throw new Error(`Invalid connector gate completion_source: ${completionSource || "(missing)"}`);
  }
  return {
    ...pair,
    history_run_id: String(evidence?.history_run_id || "").trim() || null,
    history_manifest_key: manifestKey,
    history_manifest_hash: manifestHash,
    history_row_count: normalizeNonNegativeInteger(evidence?.history_row_count, "history_row_count"),
    history_file_count: normalizeNonNegativeInteger(evidence?.history_file_count, "history_file_count"),
    history_total_bytes: normalizeNonNegativeInteger(evidence?.history_total_bytes, "history_total_bytes"),
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
