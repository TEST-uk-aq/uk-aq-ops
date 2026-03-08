import {
  hasRequiredR2Config,
  normalizePrefix,
  r2ListAllObjects,
} from "../shared/r2_sigv4.mjs";

type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type DbSizeSample = {
  database_label: "ingestdb" | "obs_aqidb";
  database_name: string;
  size_bytes: number;
  oldest_observed_at: string | null;
  sampled_at: string;
};

type SchemaName = "uk_aq_observs" | "uk_aq_aqilevels";

type SchemaSizeSample = {
  database_label: "obs_aqidb";
  schema_name: SchemaName;
  size_bytes: number;
  oldest_observed_at: string | null;
  sampled_at: string;
  source: string;
};

type DomainName = "observations" | "aqilevels";

type R2DomainSizeSample = {
  domain_name: DomainName;
  size_bytes: number;
  sampled_at: string;
  source: string;
};

type DbSource = {
  database_label: "ingestdb" | "obs_aqidb";
  base_url: string;
  privileged_key: string;
};

type R2Config = {
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
};

const SCHEMA_NAMES: readonly SchemaName[] = ["uk_aq_observs", "uk_aq_aqilevels"];
const R2_DOMAINS: readonly DomainName[] = ["observations", "aqilevels"];

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = requiredEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQIDB_PRIVILEGED_KEY = requiredEnv("OBS_AQIDB_SECRET_KEY");

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

const SCHEMA_SIZE_SOURCE_RPC = (Deno.env.get("UK_AQ_SCHEMA_SIZE_SOURCE_RPC") ||
  "uk_aq_rpc_schema_size_bytes").trim();
const SCHEMA_SIZE_UPSERT_RPC = (Deno.env.get("UK_AQ_SCHEMA_SIZE_UPSERT_RPC") ||
  "uk_aq_rpc_schema_size_metric_upsert").trim();
const SCHEMA_SIZE_CLEANUP_RPC = (Deno.env.get("UK_AQ_SCHEMA_SIZE_CLEANUP_RPC") ||
  "uk_aq_rpc_schema_size_metric_cleanup").trim();
const SCHEMA_SIZE_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_SCHEMA_SIZE_RETENTION_DAYS"),
  120,
);

const R2_DOMAIN_SIZE_UPSERT_RPC = (Deno.env.get("UK_AQ_R2_DOMAIN_SIZE_UPSERT_RPC") ||
  "uk_aq_rpc_r2_domain_size_metric_upsert").trim();
const R2_DOMAIN_SIZE_CLEANUP_RPC = (Deno.env.get("UK_AQ_R2_DOMAIN_SIZE_CLEANUP_RPC") ||
  "uk_aq_rpc_r2_domain_size_metric_cleanup").trim();
const R2_DOMAIN_SIZE_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_DOMAIN_SIZE_RETENTION_DAYS"),
  120,
);

const R2_HISTORY_OBSERVATIONS_PREFIX = parseHistoryPrefix(
  optionalEnv("UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX") ||
    "history/v1/observations",
);
const R2_HISTORY_AQILEVELS_PREFIX = parseHistoryPrefix(
  optionalEnv("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX") ||
    "history/v1/aqilevels",
);

const RPC_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_DB_SIZE_RPC_RETRIES"),
  3,
);
const R2_LIST_MAX_KEYS = Math.max(
  100,
  Math.min(1000, parsePositiveInt(Deno.env.get("UK_AQ_R2_LIST_MAX_KEYS"), 1000)),
);

const INGEST_DB_LABEL = parseDatabaseLabel(
  Deno.env.get("UK_AQ_INGEST_DB_LABEL"),
  "ingestdb",
);
const OBS_AQIDB_DB_LABEL = parseDatabaseLabel(
  Deno.env.get("UK_AQ_OBS_AQIDB_DB_LABEL"),
  "obs_aqidb",
);

const R2_CONFIG: R2Config = {
  endpoint: optionalEnvAny(["CFLARE_R2_ENDPOINT", "R2_ENDPOINT"]) || "",
  bucket: optionalEnvAny(["CFLARE_R2_BUCKET", "R2_BUCKET"]) || "",
  region: optionalEnvAny(["CFLARE_R2_REGION", "R2_REGION"]) || "auto",
  access_key_id: optionalEnvAny(["CFLARE_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"]) || "",
  secret_access_key: optionalEnvAny(["CFLARE_R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"]) || "",
};

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

function optionalEnvAny(names: string[]): string | null {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseDatabaseLabel(
  raw: string | undefined,
  fallback: "ingestdb" | "obs_aqidb",
): "ingestdb" | "obs_aqidb" {
  const value = (raw || "").trim().toLowerCase();
  if (value === "ingestdb" || value === "obs_aqidb") {
    return value;
  }
  return fallback;
}

function parseSchemaName(value: unknown): SchemaName | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "uk_aq_observs" || normalized === "uk_aq_aqilevels") {
    return normalized;
  }
  return null;
}

function parseDomainName(value: unknown): DomainName | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "observations" || normalized === "aqilevels") {
    return normalized;
  }
  return null;
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

function parseHistoryPrefix(rawPrefix: string): string {
  const normalized = normalizePrefix(rawPrefix);
  if (!normalized) {
    return "";
  }
  return normalized;
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

function isMissingRpcError(message: string, rpcName: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("could not find") && normalized.includes(rpcName.toLowerCase()) ||
    normalized.includes("pgrst202") || normalized.includes("does not exist");
}

function parseRowsDeleted(payload: unknown): number {
  if (!Array.isArray(payload) || payload.length === 0) {
    return 0;
  }
  const row = payload[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return 0;
  }
  const deleted = Number((row as Record<string, unknown>).rows_deleted);
  if (!Number.isFinite(deleted) || deleted < 0) {
    return 0;
  }
  return Math.trunc(deleted);
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
  databaseLabel: "ingestdb" | "obs_aqidb",
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

function parseSchemaSizeSamples(payload: unknown): SchemaSizeSample[] {
  const nowIso = new Date().toISOString();
  const sampleBySchema = new Map<SchemaName, SchemaSizeSample>();

  if (Array.isArray(payload)) {
    for (const row of payload) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const root = row as Record<string, unknown>;
      const schemaName = parseSchemaName(root.schema_name);
      if (!schemaName) {
        continue;
      }
      const sizeBytes = Number(root.size_bytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
        continue;
      }
      const sampledAt = parseIsoTimestamp(root.sampled_at) ||
        parseIsoTimestamp(root.recorded_at) || nowIso;
      const oldestObservedAt = parseIsoTimestamp(root.oldest_observed_at);
      sampleBySchema.set(schemaName, {
        database_label: "obs_aqidb",
        schema_name: schemaName,
        size_bytes: Math.trunc(sizeBytes),
        oldest_observed_at: oldestObservedAt,
        sampled_at: sampledAt,
        source: "uk_aq_db_size_logger_cloud_run",
      });
    }
  }

  for (const schemaName of SCHEMA_NAMES) {
    if (!sampleBySchema.has(schemaName)) {
      sampleBySchema.set(schemaName, {
        database_label: "obs_aqidb",
        schema_name: schemaName,
        size_bytes: 0,
        oldest_observed_at: null,
        sampled_at: nowIso,
        source: "uk_aq_db_size_logger_cloud_run_fallback_zero",
      });
    }
  }

  return SCHEMA_NAMES.map((schemaName) => sampleBySchema.get(schemaName)!)
    .sort((a, b) => a.schema_name.localeCompare(b.schema_name));
}

function buildFallbackSchemaSamples(sampledAt: string, source: string): SchemaSizeSample[] {
  return SCHEMA_NAMES.map((schemaName) => ({
    database_label: "obs_aqidb",
    schema_name: schemaName,
    size_bytes: 0,
    oldest_observed_at: null,
    sampled_at: sampledAt,
    source,
  }));
}

function buildFallbackR2DomainSamples(sampledAt: string, source: string): R2DomainSizeSample[] {
  return R2_DOMAINS.map((domainName) => ({
    domain_name: domainName,
    size_bytes: 0,
    sampled_at: sampledAt,
    source,
  }));
}

async function collectDbSizeSample(
  databaseLabel: "ingestdb" | "obs_aqidb",
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

async function collectSchemaSizeSamples(
  obsSource: DbSource,
): Promise<SchemaSizeSample[]> {
  const result = await postgrestRpc<unknown>(
    obsSource.base_url,
    obsSource.privileged_key,
    SCHEMA_SIZE_SOURCE_RPC,
    {},
  );
  if (result.error) {
    throw new Error(result.error.message);
  }
  return parseSchemaSizeSamples(result.data);
}

async function collectR2DomainSamples(
  sampledAt: string,
): Promise<R2DomainSizeSample[]> {
  if (!hasRequiredR2Config(R2_CONFIG)) {
    throw new Error("missing R2 endpoint/bucket/region/access credentials");
  }

  const prefixByDomain: Record<DomainName, string> = {
    observations: R2_HISTORY_OBSERVATIONS_PREFIX,
    aqilevels: R2_HISTORY_AQILEVELS_PREFIX,
  };

  const samples: R2DomainSizeSample[] = [];
  for (const domainName of R2_DOMAINS) {
    const prefix = prefixByDomain[domainName];
    const effectivePrefix = prefix ? `${normalizePrefix(prefix)}/` : "";
    const entries = await r2ListAllObjects({
      r2: R2_CONFIG,
      prefix: effectivePrefix,
      max_keys: R2_LIST_MAX_KEYS,
    });
    const sizeBytes = entries.reduce((sum, entry) => {
      const size = Number(entry?.size);
      if (!Number.isFinite(size) || size < 0) {
        return sum;
      }
      return sum + Math.trunc(size);
    }, 0);

    samples.push({
      domain_name: domainName,
      size_bytes: Math.max(0, Math.trunc(sizeBytes)),
      sampled_at: sampledAt,
      source: "uk_aq_db_size_logger_cloud_run",
    });
  }

  return samples;
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

async function upsertSchemaSizeSample(
  target: DbSource,
  sample: SchemaSizeSample,
): Promise<void> {
  const args: Record<string, unknown> = {
    p_database_label: sample.database_label,
    p_schema_name: sample.schema_name,
    p_size_bytes: sample.size_bytes,
    p_recorded_at: sample.sampled_at,
    p_source: sample.source,
  };
  if (sample.oldest_observed_at) {
    args.p_oldest_observed_at = sample.oldest_observed_at;
  }

  const result = await postgrestRpc<unknown>(
    target.base_url,
    target.privileged_key,
    SCHEMA_SIZE_UPSERT_RPC,
    args,
  );
  if (result.error) {
    throw new Error(
      `${sample.schema_name}: schema upsert failed: ${result.error.message}`,
    );
  }
}

async function upsertR2DomainSample(
  target: DbSource,
  sample: R2DomainSizeSample,
): Promise<void> {
  const result = await postgrestRpc<unknown>(
    target.base_url,
    target.privileged_key,
    R2_DOMAIN_SIZE_UPSERT_RPC,
    {
      p_domain_name: sample.domain_name,
      p_size_bytes: sample.size_bytes,
      p_recorded_at: sample.sampled_at,
      p_source: sample.source,
    },
  );
  if (result.error) {
    throw new Error(
      `${sample.domain_name}: r2 domain upsert failed: ${result.error.message}`,
    );
  }
}

async function cleanupMetricRows(
  target: DbSource,
  cleanupRpc: string,
  retentionDays: number,
): Promise<number> {
  const result = await postgrestRpc<unknown>(
    target.base_url,
    target.privileged_key,
    cleanupRpc,
    { p_retention_days: retentionDays },
  );
  if (result.error) {
    throw new Error(result.error.message);
  }
  return parseRowsDeleted(result.data);
}

function warningMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const sources: DbSource[] = [
    {
      database_label: INGEST_DB_LABEL,
      base_url: SUPABASE_URL,
      privileged_key: SUPABASE_PRIVILEGED_KEY,
    },
    {
      database_label: OBS_AQIDB_DB_LABEL,
      base_url: OBS_AQIDB_SUPABASE_URL,
      privileged_key: OBS_AQIDB_PRIVILEGED_KEY,
    },
  ];

  const ingestSource = sources.find((source) => source.database_label === INGEST_DB_LABEL);
  const obsSource = sources.find((source) => source.database_label === OBS_AQIDB_DB_LABEL);
  if (!ingestSource || !obsSource) {
    throw new Error("missing ingestdb or obs_aqidb source configuration");
  }

  const startedAt = new Date().toISOString();
  console.log("uk_aq_db_size_logger_start", {
    started_at: startedAt,
    db_size_retention_days: DB_SIZE_RETENTION_DAYS,
    schema_size_retention_days: SCHEMA_SIZE_RETENTION_DAYS,
    r2_domain_size_retention_days: R2_DOMAIN_SIZE_RETENTION_DAYS,
    ingest_label: INGEST_DB_LABEL,
    obs_aqidb_label: OBS_AQIDB_DB_LABEL,
    schema_names: SCHEMA_NAMES,
    r2_domains: R2_DOMAINS,
    r2_prefixes: {
      observations: R2_HISTORY_OBSERVATIONS_PREFIX,
      aqilevels: R2_HISTORY_AQILEVELS_PREFIX,
    },
    targets: sources.map((source) => source.database_label),
  });

  const warnings: string[] = [];
  const samplesByLabel: Record<"ingestdb" | "obs_aqidb", DbSizeSample | null> = {
    ingestdb: null,
    obs_aqidb: null,
  };
  const rowsDeletedByDb: Record<"ingestdb" | "obs_aqidb", number> = {
    ingestdb: 0,
    obs_aqidb: 0,
  };

  for (const source of sources) {
    const sample = await collectDbSizeSample(
      source.database_label,
      source.base_url,
      source.privileged_key,
    );
    await upsertDbSizeSample(source, sample);
    const deleted = await cleanupMetricRows(source, DB_SIZE_CLEANUP_RPC, DB_SIZE_RETENTION_DAYS);

    samplesByLabel[source.database_label] = sample;
    rowsDeletedByDb[source.database_label] = deleted;
  }

  let schemaSamples: SchemaSizeSample[] = [];
  let schemaRowsDeleted = 0;
  const schemaSampledAt = new Date().toISOString();
  try {
    schemaSamples = await collectSchemaSizeSamples(obsSource);
  } catch (error) {
    const message = warningMessage(error);
    warnings.push(`schema_source: ${message}`);
    const fallbackSource = isMissingRpcError(message, SCHEMA_SIZE_SOURCE_RPC)
      ? "uk_aq_db_size_logger_cloud_run_missing_schema_rpc"
      : "uk_aq_db_size_logger_cloud_run_fallback_zero";
    schemaSamples = buildFallbackSchemaSamples(schemaSampledAt, fallbackSource);
  }

  try {
    for (const sample of schemaSamples) {
      await upsertSchemaSizeSample(obsSource, sample);
    }
    schemaRowsDeleted = await cleanupMetricRows(
      obsSource,
      SCHEMA_SIZE_CLEANUP_RPC,
      SCHEMA_SIZE_RETENTION_DAYS,
    );
  } catch (error) {
    warnings.push(`schema_persist: ${warningMessage(error)}`);
  }

  let r2DomainSamples: R2DomainSizeSample[] = [];
  let r2DomainRowsDeleted = 0;
  const r2SampledAt = new Date().toISOString();
  try {
    r2DomainSamples = await collectR2DomainSamples(r2SampledAt);
  } catch (error) {
    warnings.push(`r2_domain_source: ${warningMessage(error)}`);
    r2DomainSamples = buildFallbackR2DomainSamples(
      r2SampledAt,
      "uk_aq_db_size_logger_cloud_run_fallback_zero",
    );
  }

  try {
    for (const sample of r2DomainSamples) {
      await upsertR2DomainSample(ingestSource, sample);
    }
    r2DomainRowsDeleted = await cleanupMetricRows(
      ingestSource,
      R2_DOMAIN_SIZE_CLEANUP_RPC,
      R2_DOMAIN_SIZE_RETENTION_DAYS,
    );
  } catch (error) {
    warnings.push(`r2_domain_persist: ${warningMessage(error)}`);
  }

  const rowsDeleted = rowsDeletedByDb.ingestdb + rowsDeletedByDb.obs_aqidb +
    schemaRowsDeleted + r2DomainRowsDeleted;

  if (warnings.length > 0) {
    console.warn("uk_aq_db_size_logger_warnings", {
      started_at: startedAt,
      warnings,
    });
  }

  console.log("uk_aq_db_size_logger_summary", {
    started_at: startedAt,
    ingestdb: samplesByLabel.ingestdb,
    obs_aqidb: samplesByLabel.obs_aqidb,
    schema_size_samples: schemaSamples,
    r2_domain_size_samples: r2DomainSamples,
    rows_deleted: rowsDeleted,
    rows_deleted_by_db: rowsDeletedByDb,
    rows_deleted_by_family: {
      db_size: rowsDeletedByDb.ingestdb + rowsDeletedByDb.obs_aqidb,
      schema_size: schemaRowsDeleted,
      r2_domain_size: r2DomainRowsDeleted,
    },
    warnings,
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("uk_aq_db_size_logger_failed", { message });
    Deno.exit(1);
  });
}
