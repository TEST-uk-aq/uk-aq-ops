type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type DbSizeSample = {
  database_label: "ingestdb" | "historydb" | "aggdailydb";
  database_name: string;
  size_bytes: number;
  oldest_observed_at: string | null;
  sampled_at: string;
};

type DbSource = {
  database_label: "ingestdb" | "historydb" | "aggdailydb";
  base_url: string;
  privileged_key: string;
};

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const HISTORY_SUPABASE_URL = requiredEnv("HISTORY_SUPABASE_URL");
const HISTORY_PRIVILEGED_KEY = requiredEnv("HISTORY_SECRET_KEY");
const AGGDAILY_SUPABASE_URL = optionalEnv("AGGDAILY_SUPABASE_URL");
const AGGDAILY_PRIVILEGED_KEY = optionalEnv("AGGDAILY_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public")
  .trim();
const DB_SIZE_RPC = (Deno.env.get("UK_AQ_DB_SIZE_RPC") ||
  "uk_aq_rpc_database_size_bytes").trim();
const DB_SIZE_UPSERT_RPC = (Deno.env.get("UK_AQ_DB_SIZE_UPSERT_RPC") ||
  "uk_aq_rpc_db_size_metric_upsert").trim();
const DB_SIZE_CLEANUP_RPC = (Deno.env.get("UK_AQ_DB_SIZE_CLEANUP_RPC") ||
  "uk_aq_rpc_db_size_metric_cleanup").trim();
const DB_SIZE_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_DB_SIZE_RETENTION_DAYS"),
  120,
);
const RPC_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_DB_SIZE_RPC_RETRIES"),
  3,
);

const INGEST_DB_LABEL = parseDatabaseLabel(
  Deno.env.get("UK_AQ_INGEST_DB_LABEL"),
  "ingestdb",
);
const HISTORY_DB_LABEL = parseDatabaseLabel(
  Deno.env.get("UK_AQ_HISTORY_DB_LABEL"),
  "historydb",
);
const AGGDAILY_DB_LABEL = parseDatabaseLabel(
  Deno.env.get("UK_AQ_AGGDAILY_DB_LABEL"),
  "aggdailydb",
);

if ((AGGDAILY_SUPABASE_URL && !AGGDAILY_PRIVILEGED_KEY) ||
  (!AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
  throw new Error(
    "Agg Daily config requires both AGGDAILY_SUPABASE_URL and AGGDAILY_SECRET_KEY",
  );
}
const AGGDAILY_ENABLED = Boolean(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY);

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredEnvAny(names: string[]): string {
  for (const name of names) {
    const value = (Deno.env.get(name) || "").trim();
    if (value) {
      return value;
    }
  }
  throw new Error(
    `Missing required environment variable: one of ${names.join(", ")}`,
  );
}

function optionalEnv(name: string): string | null {
  const value = (Deno.env.get(name) || "").trim();
  return value || null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseDatabaseLabel(
  raw: string | undefined,
  fallback: "ingestdb" | "historydb" | "aggdailydb",
): "ingestdb" | "historydb" | "aggdailydb" {
  const value = (raw || "").trim().toLowerCase();
  if (value === "ingestdb" || value === "historydb" || value === "aggdailydb") {
    return value;
  }
  return fallback;
}

function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function isMissingOldestUpsertArgError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("p_oldest_observed_at") &&
    normalized.includes("uk_aq_rpc_db_size_metric_upsert");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 ||
    status === 504;
}

function normalizeUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  return `${trimmed}/rest/v1`;
}

function asErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["message", "error_description", "error"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return `HTTP ${status}`;
}

async function postgrestRpc<T>(
  baseUrl: string,
  privilegedKey: string,
  rpcName: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const url = `${normalizeUrl(baseUrl)}/rpc/${rpcName}`;
  const headers: Record<string, string> = {
    apikey: privilegedKey,
    Authorization: `Bearer ${privilegedKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": RPC_SCHEMA,
    "Content-Profile": RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_db_size_logger_cloud_run",
  };

  for (let attempt = 1; attempt <= RPC_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      });
      const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);

      if (response.ok) {
        return { data: payload as T, error: null };
      }

      if (attempt < RPC_RETRIES && isRetryableStatus(response.status)) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return {
        data: null,
        error: { message: asErrorMessage(payload, response.status) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < RPC_RETRIES) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return { data: null, error: { message } };
    }
  }

  return { data: null, error: { message: "unknown_rpc_error" } };
}

function parseDbSizeSample(
  databaseLabel: "ingestdb" | "historydb" | "aggdailydb",
  payload: unknown,
): DbSizeSample {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`${databaseLabel}: db size RPC returned no rows`);
  }
  const row = payload[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${databaseLabel}: db size RPC returned invalid row`);
  }

  const root = row as Record<string, unknown>;
  const databaseName = typeof root.database_name === "string"
    ? root.database_name.trim()
    : "";
  const sizeBytes = Number(root.size_bytes);
  const sampledAt = parseIsoTimestamp(root.sampled_at) || new Date().toISOString();
  const oldestObservedAt = parseIsoTimestamp(root.oldest_observed_at);

  if (!databaseName) {
    throw new Error(`${databaseLabel}: missing database_name`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`${databaseLabel}: invalid size_bytes`);
  }

  return {
    database_label: databaseLabel,
    database_name: databaseName,
    size_bytes: Math.trunc(sizeBytes),
    oldest_observed_at: oldestObservedAt,
    sampled_at: sampledAt,
  };
}

async function collectDbSizeSample(
  databaseLabel: "ingestdb" | "historydb" | "aggdailydb",
  baseUrl: string,
  privilegedKey: string,
): Promise<DbSizeSample> {
  const result = await postgrestRpc<unknown>(
    baseUrl,
    privilegedKey,
    DB_SIZE_RPC,
    {},
  );
  if (result.error) {
    throw new Error(`${databaseLabel}: ${result.error.message}`);
  }
  return parseDbSizeSample(databaseLabel, result.data);
}

async function upsertDbSizeSample(
  target: DbSource,
  sample: DbSizeSample,
): Promise<void> {
  const baseArgs: Record<string, unknown> = {
    p_database_label: sample.database_label,
    p_database_name: sample.database_name,
    p_size_bytes: sample.size_bytes,
    p_recorded_at: sample.sampled_at,
    p_source: "uk_aq_db_size_logger_cloud_run",
  };
  const maybeExtendedArgs = sample.oldest_observed_at
    ? { ...baseArgs, p_oldest_observed_at: sample.oldest_observed_at }
    : baseArgs;

  let result = await postgrestRpc<unknown>(
    target.base_url,
    target.privileged_key,
    DB_SIZE_UPSERT_RPC,
    maybeExtendedArgs,
  );
  if (
    result.error &&
    "p_oldest_observed_at" in maybeExtendedArgs &&
    isMissingOldestUpsertArgError(result.error.message)
  ) {
    result = await postgrestRpc<unknown>(
      target.base_url,
      target.privileged_key,
      DB_SIZE_UPSERT_RPC,
      baseArgs,
    );
  }
  if (result.error) {
    throw new Error(
      `${sample.database_label}: upsert failed: ${result.error.message}`,
    );
  }
}

async function cleanupOldRows(
  target: DbSource,
  retentionDays: number,
): Promise<number> {
  const result = await postgrestRpc<unknown>(
    target.base_url,
    target.privileged_key,
    DB_SIZE_CLEANUP_RPC,
    { p_retention_days: retentionDays },
  );
  if (result.error) {
    throw new Error(
      `${target.database_label}: cleanup failed: ${result.error.message}`,
    );
  }
  if (!Array.isArray(result.data) || result.data.length === 0) {
    return 0;
  }
  const row = result.data[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return 0;
  }
  const deleted = Number((row as Record<string, unknown>).rows_deleted);
  if (!Number.isFinite(deleted) || deleted < 0) {
    return 0;
  }
  return Math.trunc(deleted);
}

async function main(): Promise<void> {
  const sources: DbSource[] = [
    {
      database_label: INGEST_DB_LABEL,
      base_url: SUPABASE_URL,
      privileged_key: SUPABASE_PRIVILEGED_KEY,
    },
    {
      database_label: HISTORY_DB_LABEL,
      base_url: HISTORY_SUPABASE_URL,
      privileged_key: HISTORY_PRIVILEGED_KEY,
    },
  ];
  if (AGGDAILY_ENABLED) {
    sources.push({
      database_label: AGGDAILY_DB_LABEL,
      base_url: AGGDAILY_SUPABASE_URL as string,
      privileged_key: AGGDAILY_PRIVILEGED_KEY as string,
    });
  }

  const startedAt = new Date().toISOString();
  console.log("uk_aq_db_size_logger_start", {
    started_at: startedAt,
    retention_days: DB_SIZE_RETENTION_DAYS,
    ingest_label: INGEST_DB_LABEL,
    history_label: HISTORY_DB_LABEL,
    aggdaily_enabled: AGGDAILY_ENABLED,
    aggdaily_label: AGGDAILY_DB_LABEL,
    targets: sources.map((source) => source.database_label),
  });

  const samplesByLabel: Record<"ingestdb" | "historydb" | "aggdailydb", DbSizeSample | null> = {
    ingestdb: null,
    historydb: null,
    aggdailydb: null,
  };
  const rowsDeletedByLabel: Record<"ingestdb" | "historydb" | "aggdailydb", number> = {
    ingestdb: 0,
    historydb: 0,
    aggdailydb: 0,
  };

  for (const source of sources) {
    const sample = await collectDbSizeSample(
      source.database_label,
      source.base_url,
      source.privileged_key,
    );
    await upsertDbSizeSample(source, sample);
    const deleted = await cleanupOldRows(source, DB_SIZE_RETENTION_DAYS);

    samplesByLabel[source.database_label] = sample;
    rowsDeletedByLabel[source.database_label] = deleted;
  }

  const rowsDeleted = rowsDeletedByLabel.ingestdb + rowsDeletedByLabel.historydb +
    rowsDeletedByLabel.aggdailydb;

  console.log("uk_aq_db_size_logger_summary", {
    started_at: startedAt,
    ingestdb: samplesByLabel.ingestdb,
    historydb: samplesByLabel.historydb,
    aggdailydb: samplesByLabel.aggdailydb,
    rows_deleted: rowsDeleted,
    rows_deleted_by_db: rowsDeletedByLabel,
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("uk_aq_db_size_logger_failed", { message });
    Deno.exit(1);
  });
}
