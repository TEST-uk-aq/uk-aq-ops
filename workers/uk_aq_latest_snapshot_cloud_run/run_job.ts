import zlib from "node:zlib";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "../shared/r2_sigv4.mjs";

type ServiceEgressMetricRow = {
  bucket_minute?: string;
  env_name: string;
  project_ref?: string;
  service_name: string;
  source_type: "supabase" | "r2" | "cloudflare_cache" | "gcp" | "other";
  source_name?: string;
  route_name: string;
  query_name?: string;
  window_label?: string;
  status: "ok" | "error" | "partial" | "skipped";
  request_count?: number;
  response_rows?: number;
  response_bytes_est?: number;
  upstream_bytes_est?: number;
  cache_hit_count?: number;
  cache_miss_count?: number;
  objects_written_count?: number;
  objects_written_bytes?: number;
  duration_ms?: number;
  error_count?: number;
  notes?: Record<string, unknown> | null;
};

type LatestItem = {
  id: number | null;
  last_value: number | null;
  last_value_at: string | null;
  connector_code: string | null;
  connector_label: string | null;
  station_id: number | null;
  station_label: string | null;
  display_name: string | null;
  pcon_code: string | null;
  la_code: string | null;
  station_network_memberships: Array<{
    network_code: string;
    network_label: string | null;
    is_primary: boolean;
  }>;
  phenomenon_label: string | null;
  pollutant_label: string | null;
  observed_property_code: string | null;
  uom_display: string | null;
};

type SnapshotPayload = {
  region: null;
  pcon_code: null;
  pollutant: string;
  window: string;
  since: null;
  since_id: null;
  next_since: string | null;
  next_since_id: number | null;
  count: number;
  data: LatestItem[];
};

type SnapshotManifestEntry = {
  id: string;
  network_group: string;
  pollutant: string;
  window: string;
  object_key: string | null;
  content_type: string;
  content_encoding: string | null;
  sha256: string | null;
  etag: string | null;
  row_count: number | null;
  bytes: number | null;
  min_observed_at: string | null;
  max_observed_at: string | null;
  generated_at: string;
  build_duration_ms: number;
  previous_sha256: string | null;
  changed: boolean;
  error: string | null;
};

type SnapshotManifest = {
  schema_version: number;
  snapshot_family: "latest";
  version: string;
  generated_at: string;
  trigger_mode: string;
  source: {
    type: "pubsub_observation_state";
    pubsub_subscription: string;
    state_key: string;
    core_metadata_prefix: string;
    core_metadata_day_utc: string | null;
  };
  matrix: {
    network_group: string;
    pollutants: string[];
    windows: string[];
  };
  build: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
    success_count: number;
    failure_count: number;
    partial_failure: boolean;
    ok: boolean;
  };
  snapshots: SnapshotManifestEntry[];
};

type BuildReport = {
  ok: boolean;
  trigger_mode: string;
  manifest_key: string;
  reports_key: string | null;
  duration_ms: number;
  success_count: number;
  failure_count: number;
  changed_count: number;
  skipped_unchanged_count: number;
  warnings: string[];
};

type PubsubPullMessage = {
  ackId?: unknown;
  message?: {
    data?: unknown;
  };
};

type PubsubPullResponse = {
  receivedMessages?: unknown;
};

type ObservationMessageRow = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  value_float8_hex: string | null;
  status: string | null;
};

type DecodedMessage = {
  ackId: string | null;
  row: ObservationMessageRow | null;
  payloadBytes: number;
};

type PullSummary = {
  pull_requests: number;
  pulled_messages: number;
  decoded_rows: number;
  malformed_messages: number;
  acked_messages: number;
  payload_bytes: number;
  duration_ms: number;
};

type LatestStateEntry = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  value_float8_hex: string | null;
  status: string | null;
  ingested_at: string | null;
};

type LatestStateFile = {
  schema_version: 1;
  updated_at: string;
  entries: LatestStateEntry[];
};

type LoadedState = {
  stateMap: Map<string, LatestStateEntry>;
  existingHash: string | null;
  existingBytes: number;
};

type StateApplySummary = {
  applied_new: number;
  applied_newer: number;
  skipped_older: number;
  skipped_duplicate: number;
};

type CoreSnapshotManifest = {
  day_utc: string | null;
  tables: Array<{ table: string; key: string }>;
};

type MetadataConnector = {
  id: number;
  connector_code: string | null;
  label: string | null;
  display_name: string | null;
  station_display_name_template: string | null;
};

type MetadataStation = {
  id: number;
  connector_id: number | null;
  station_ref: string | null;
  label: string | null;
  station_name: string | null;
  pcon_code: string | null;
  la_code: string | null;
};

type MetadataMembership = {
  station_id: number;
  network_code: string;
  network_label: string | null;
  is_primary: boolean;
};

type MetadataTimeseries = {
  id: number;
  connector_id: number | null;
  station_id: number | null;
  phenomenon_id: number | null;
  label: string | null;
  uom: string | null;
};

type MetadataPhenomenon = {
  id: number;
  observed_property_id: number | null;
  label: string | null;
  notation: string | null;
  pollutant_label: string | null;
  source_label: string | null;
};

type MetadataObservedProperty = {
  id: number;
  code: string | null;
  display_name: string | null;
};

type CoreMetadataCacheFile = {
  schema_version: 1;
  generated_at: string;
  source_day_utc: string | null;
  connectors: MetadataConnector[];
  stations: MetadataStation[];
  memberships: MetadataMembership[];
  timeseries: MetadataTimeseries[];
  phenomena: MetadataPhenomenon[];
  observed_properties: MetadataObservedProperty[];
};

type MetadataIndex = {
  source_day_utc: string | null;
  connectorsById: Map<number, MetadataConnector>;
  stationsById: Map<number, MetadataStation>;
  membershipsByStationId: Map<number, MetadataMembership[]>;
  timeseriesById: Map<number, MetadataTimeseries>;
  phenomenaById: Map<number, MetadataPhenomenon>;
  observedPropertyById: Map<number, MetadataObservedProperty>;
};

type MetadataRefreshStats = {
  refreshed: boolean;
  source_day_utc: string | null;
  objects_read: number;
  bytes_read: number;
  cache_bytes_written: number;
  duration_ms: number;
};

type SnapshotSourceRow = {
  pollutant: string;
  item: LatestItem;
};

const PUBSUB_PROJECT_ID = (
  Deno.env.get("GCP_PROJECT_ID") ||
  Deno.env.get("GOOGLE_CLOUD_PROJECT") ||
  ""
).trim();

const PUBSUB_SUBSCRIPTION = (
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION") ||
  "uk-aq-latest-snapshot-sub"
).trim();

const OBSERVS_BASE_SUBSCRIPTION = (
  Deno.env.get("OBSERVS_PUBSUB_SUBSCRIPTION") ||
  ""
).trim();

const PUBSUB_PULL_MAX_MESSAGES = 1000;
const PUBSUB_MAX_BATCHES_PER_RUN = 8;
const PUBSUB_PULL_RETRIES = parsePositiveInt(
  Deno.env.get("OBSERVS_PUBSUB_WRITER_PUBSUB_RETRIES"),
  3,
);

const UK_AQ_LATEST_SNAPSHOT_POLLUTANTS = parseCsvList(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_POLLUTANTS"),
  ["pm25", "pm10", "no2"],
).map((value) => normalizeMatrixPollutant(value)).filter((value): value is string => Boolean(value));

const UK_AQ_LATEST_SNAPSHOT_WINDOWS = parseCsvList(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_WINDOWS"),
  ["3h", "6h", "1d", "7d", "all"],
).map((value) => normalizeWindow(value)).filter((value): value is string => Boolean(value));

const UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP =
  (Deno.env.get("UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP") || "all").trim().toLowerCase() || "all";
const UK_AQ_LATEST_SNAPSHOT_R2_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_R2_PREFIX") || "latest_snapshots/v1",
);
const UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY = normalizePrefix(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY") || `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/manifest.json`,
);
const UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX") || `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/_runs`,
);
const UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED"),
  true,
);
const UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX") || "latest_snapshots_state/v1",
);
const UK_AQ_LATEST_SNAPSHOT_STATE_KEY = `${UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX}/latest_state.json`;
const UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX") || "history/v1/core",
);
const UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_CACHE_KEY =
  `${UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX}/core_metadata_cache.json`;
const UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS = parsePositiveInt(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS"),
  86400,
);
const UK_AQ_LATEST_SNAPSHOT_CORE_LOOKBACK_DAYS = 14;
const UK_AQ_LATEST_SNAPSHOT_MAX_STATE_ENTRIES = 500_000;

const UK_AQ_SERVICE_EGRESS_METRICS_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_SERVICE_EGRESS_METRICS_ENABLED"),
  false,
);
const UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL") || ""
).trim();
const UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY") || ""
).trim();
const UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA") || "uk_aq_public"
).trim();
const UK_AQ_SERVICE_EGRESS_METRICS_RPC = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_METRICS_RPC") || "uk_aq_rpc_service_egress_metrics_batch_upsert"
).trim();
const UK_AQ_SERVICE_EGRESS_ENV = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_ENV") || Deno.env.get("UK_AQ_ENV") || "unknown"
).trim().toLowerCase() || "unknown";
const UK_AQ_SERVICE_EGRESS_PROJECT_REF = (
  Deno.env.get("UK_AQ_SERVICE_EGRESS_PROJECT_REF") || ""
).trim();

const R2_CONFIG = {
  endpoint: optionalEnvAny(["CFLARE_R2_ENDPOINT", "R2_ENDPOINT"]) || "",
  bucket: optionalEnvAny(["CFLARE_R2_BUCKET", "R2_BUCKET"]) || "",
  region: optionalEnvAny(["CFLARE_R2_REGION", "R2_REGION"]) || "auto",
  access_key_id: optionalEnvAny(["CFLARE_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"]) || "",
  secret_access_key: optionalEnvAny(["CFLARE_R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"]) || "",
};

const TEXT_ENCODER = new TextEncoder();

function optionalEnvAny(names: string[]): string | null {
  for (const name of names) {
    const value = (Deno.env.get(name) || "").trim();
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

function parseBoolean(raw: string | undefined | null, fallback: boolean): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function parseCsvList(raw: string | undefined | null, fallback: string[]): string[] {
  const source = String(raw || "").trim();
  if (!source) return [...fallback];
  const values = source.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : [...fallback];
}

function normalizeText(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeTimestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeNonEmptyText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizeMatrixPollutant(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalized.toLowerCase().replace(/[\s_.-]/g, "");
  if (compact === "pm25") return "pm25";
  if (compact === "pm10") return "pm10";
  if (compact === "no2") return "no2";
  return null;
}

function normalizePollutant(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalized.toLowerCase().replace(/[\s_]/g, "");
  if (compact === "pm25" || compact === "pm2.5") return "pm2.5";
  if (compact === "pm10") return "pm10";
  if (compact === "no2") return "no2";
  return normalized.toLowerCase();
}

function normalizeWindow(value: string | null): string | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) return null;
  return ["3h", "6h", "1d", "7d", "all"].includes(normalized) ? normalized : null;
}

function measureUtf8Bytes(value: string): number {
  if (!value) return 0;
  return TEXT_ENCODER.encode(value).byteLength;
}

function deriveProjectRef(supabaseUrl: string): string {
  const trimmed = String(supabaseUrl || "").trim();
  if (!trimmed) return "";
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host.endsWith(".supabase.co")) return host.slice(0, -".supabase.co".length);
    if (host.endsWith(".supabase.in")) return host.slice(0, -".supabase.in".length);
  } catch {
    return "";
  }
  return "";
}

function utcNowIso(): string {
  return new Date().toISOString();
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[:-]|\.\d{3}/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikePollutantUri(value: string): boolean {
  return /dd\.eionet\.europa\.eu\/vocabulary\/aq\/pollutant\//i.test(value);
}

function deriveStationLabel(label: string | null): string | null {
  if (!label) return null;
  const separator = label.includes(" - ") ? " - " : "-";
  const parts = label.split(separator).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return label;
  if (parts.length > 1 && (looksLikePollutantUri(parts[0]) || looksLikeUrl(parts[0]))) {
    return parts[parts.length - 1];
  }
  if (parts.length === 1 && looksLikeUrl(parts[0])) return null;
  return parts[0];
}

function resolveStationLabel(
  stationLabel: string | null | undefined,
  stationRef: string | null | undefined,
  seriesLabel: string | null,
): string | null {
  const normalizedStationLabel = normalizeNonEmptyText(stationLabel);
  if (normalizedStationLabel) return normalizedStationLabel;
  const derived = normalizeNonEmptyText(deriveStationLabel(seriesLabel));
  if (derived) return derived;
  return normalizeNonEmptyText(stationRef);
}

function resolvePhenomenonLabel(
  observedPropertyDisplayName: string | null | undefined,
  pollutantLabel: string | null | undefined,
  label: string | null | undefined,
  notation: string | null | undefined,
  sourceLabel: string | null | undefined,
): string | null {
  if (observedPropertyDisplayName) return observedPropertyDisplayName;
  if (notation) return notation;
  if (pollutantLabel) return pollutantLabel;
  if (label) return label;
  if (sourceLabel) return sourceLabel.split(/[:/]/).filter(Boolean).pop() ?? null;
  return null;
}

function isTemplateBoundaryChar(char: string): boolean {
  return /\s|[-,:;|/]/.test(char);
}

function trimBoundaryDelimiters(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isTemplateBoundaryChar(value[start])) start += 1;
  while (end > start && isTemplateBoundaryChar(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function renderDisplayTemplate(template: string, tokens: Record<string, string>): string | null {
  const normalizedStationName = normalizeNonEmptyText(tokens.station_name ?? null);
  const normalizedStationRef = normalizeNonEmptyText(tokens.station_ref ?? null);
  const hasStationNameToken = /\{station_name\}/i.test(template);
  const hasStationRefToken = /\{station_ref\}/i.test(template);
  const safeTokens = { ...tokens };
  if (
    hasStationNameToken &&
    hasStationRefToken &&
    normalizedStationName &&
    normalizedStationRef &&
    normalizedStationName.toLowerCase().includes(normalizedStationRef.toLowerCase())
  ) {
    safeTokens.station_ref = "";
  }
  const rendered = template.replace(/\{(station_name|station_label|station_ref)\}/g, (_, key) => {
    return safeTokens[key] ?? "";
  });
  const cleaned = rendered
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+/g, " ");
  const trimmed = trimBoundaryDelimiters(cleaned).trim();
  return trimmed ? trimmed : null;
}

function formatFallbackDisplayName(
  stationName: string | null | undefined,
  stationLabel: string | null | undefined,
  stationRef: string | null,
  stationId: string | number | null | undefined,
): string | null {
  const normalizedName = normalizeNonEmptyText(stationName);
  const normalizedLabel = normalizeNonEmptyText(stationLabel);
  const normalizedRef = normalizeNonEmptyText(stationRef);
  const normalizedId = normalizeNonEmptyText(stationId !== null && stationId !== undefined ? String(stationId) : null);
  const base = normalizedName ?? normalizedLabel ?? null;
  if (!base) {
    if (normalizedRef) return normalizedRef;
    return normalizedId ? `Station ${normalizedId}` : null;
  }
  if (!normalizedName) return base;
  const normalizedBase = base.toLowerCase();
  if (normalizedRef && normalizedBase.includes(normalizedRef.toLowerCase())) return base;
  return normalizedRef ? `${base} - ${normalizedRef}` : base;
}

function formatDisplayName(
  template: string | null | undefined,
  stationName: string | null | undefined,
  stationLabel: string | null | undefined,
  stationRef: string | number | null,
  stationId: string | number | null | undefined,
): string | null {
  const refText = normalizeNonEmptyText(stationRef !== null && stationRef !== undefined ? String(stationRef) : null);
  const fallback = formatFallbackDisplayName(stationName, stationLabel, refText, stationId);
  const effectiveTemplate = template?.trim();
  if (!effectiveTemplate) return fallback;
  const rendered = renderDisplayTemplate(effectiveTemplate, {
    station_name: stationName ?? "",
    station_label: stationLabel ?? "",
    station_ref: refText ?? "",
  });
  if (rendered) return rendered;
  return fallback;
}

function formatUnit(unit: string | null): string | null {
  if (!unit) return null;
  const trimmed = unit.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/µ/g, "u");
  if (normalized.includes("ug") && /m\s*[-^]?\s*3/.test(normalized)) return "µg/m³";
  return trimmed;
}

function passesOutlierThreshold(pollutant: string | null, value: number | null): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  if (!pollutant) return true;
  const thresholds: Record<string, { min: number; max: number }> = {
    "pm2.5": { min: 0, max: 500 },
    "pm25": { min: 0, max: 500 },
    "pm10": { min: 0, max: 600 },
  };
  const bounds = thresholds[pollutant];
  if (!bounds) return true;
  return value >= bounds.min && value <= bounds.max;
}

function matrixId(networkGroup: string, pollutant: string, windowLabel: string): string {
  return `network_group=${networkGroup}|pollutant=${pollutant}|window=${windowLabel}`;
}

function snapshotKey(networkGroup: string, pollutant: string, windowLabel: string): string {
  return `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/network_group=${networkGroup}/pollutant=${pollutant}/window=${windowLabel}.json`;
}

function toStableJson(value: unknown): string {
  return JSON.stringify(stableSort(value));
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableSort(item));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const output: Record<string, unknown> = {};
    for (const key of sortedKeys) output[key] = stableSort(obj[key]);
    return output;
  }
  return value;
}

function normalizeMetricKeyPart(value: string | undefined): string {
  const text = String(value || "").trim();
  return text || "";
}

function metricBucketMinute(iso: string): string {
  const timestamp = normalizeTimestamp(iso) || utcNowIso();
  return timestamp.slice(0, 16) + ":00.000Z";
}

function aggregateServiceEgressMetrics(rows: ServiceEgressMetricRow[]): ServiceEgressMetricRow[] {
  const byKey = new Map<string, ServiceEgressMetricRow>();
  for (const row of rows) {
    const key = [
      normalizeMetricKeyPart(row.bucket_minute),
      normalizeMetricKeyPart(row.env_name),
      normalizeMetricKeyPart(row.project_ref),
      normalizeMetricKeyPart(row.service_name),
      normalizeMetricKeyPart(row.source_type),
      normalizeMetricKeyPart(row.source_name),
      normalizeMetricKeyPart(row.route_name),
      normalizeMetricKeyPart(row.query_name),
      normalizeMetricKeyPart(row.window_label),
      normalizeMetricKeyPart(row.status),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...row,
        request_count: Math.max(0, row.request_count ?? 0),
        response_rows: Math.max(0, row.response_rows ?? 0),
        response_bytes_est: Math.max(0, row.response_bytes_est ?? 0),
        upstream_bytes_est: Math.max(0, row.upstream_bytes_est ?? 0),
        cache_hit_count: Math.max(0, row.cache_hit_count ?? 0),
        cache_miss_count: Math.max(0, row.cache_miss_count ?? 0),
        objects_written_count: Math.max(0, row.objects_written_count ?? 0),
        objects_written_bytes: Math.max(0, row.objects_written_bytes ?? 0),
        duration_ms: Math.max(0, row.duration_ms ?? 0),
        error_count: Math.max(0, row.error_count ?? 0),
      });
      continue;
    }
    existing.request_count = (existing.request_count ?? 0) + Math.max(0, row.request_count ?? 0);
    existing.response_rows = (existing.response_rows ?? 0) + Math.max(0, row.response_rows ?? 0);
    existing.response_bytes_est = (existing.response_bytes_est ?? 0) + Math.max(0, row.response_bytes_est ?? 0);
    existing.upstream_bytes_est = (existing.upstream_bytes_est ?? 0) + Math.max(0, row.upstream_bytes_est ?? 0);
    existing.cache_hit_count = (existing.cache_hit_count ?? 0) + Math.max(0, row.cache_hit_count ?? 0);
    existing.cache_miss_count = (existing.cache_miss_count ?? 0) + Math.max(0, row.cache_miss_count ?? 0);
    existing.objects_written_count = (existing.objects_written_count ?? 0) + Math.max(0, row.objects_written_count ?? 0);
    existing.objects_written_bytes = (existing.objects_written_bytes ?? 0) + Math.max(0, row.objects_written_bytes ?? 0);
    existing.duration_ms = (existing.duration_ms ?? 0) + Math.max(0, row.duration_ms ?? 0);
    existing.error_count = (existing.error_count ?? 0) + Math.max(0, row.error_count ?? 0);
    if (row.notes && typeof row.notes === "object") {
      existing.notes = { ...(existing.notes || {}), ...row.notes };
    }
  }
  return [...byKey.values()];
}

async function postgrestRpcToUrl(
  baseUrl: string,
  apiKey: string,
  schema: string,
  rpcName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; message: string }> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/rest/v1/rpc/${rpcName}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Accept-Profile": schema,
      "Content-Profile": schema,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text || null;
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && !Array.isArray(payload)
      ? String((payload as Record<string, unknown>).message || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    return { ok: false, status: response.status, message };
  }
  return { ok: true, status: response.status, message: "ok" };
}

async function publishServiceEgressMetrics(rows: ServiceEgressMetricRow[]): Promise<void> {
  if (!UK_AQ_SERVICE_EGRESS_METRICS_ENABLED) return;
  if (!UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL || !UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY) return;
  if (!UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA || !UK_AQ_SERVICE_EGRESS_METRICS_RPC) return;
  if (!rows.length) return;
  const response = await postgrestRpcToUrl(
    UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL,
    UK_AQ_SERVICE_EGRESS_METRICS_SB_SECRET_KEY,
    UK_AQ_SERVICE_EGRESS_METRICS_SCHEMA,
    UK_AQ_SERVICE_EGRESS_METRICS_RPC,
    { p_rows: rows },
  );
  if (!response.ok) {
    throw new Error(`Metrics RPC failed HTTP ${response.status}: ${response.message}`);
  }
}

function subscriptionPath(): string {
  if (PUBSUB_SUBSCRIPTION.startsWith("projects/")) return PUBSUB_SUBSCRIPTION;
  return `projects/${PUBSUB_PROJECT_ID}/subscriptions/${PUBSUB_SUBSCRIPTION}`;
}

async function fetchGoogleAccessToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Metadata token request failed (${response.status}): ${text}`);
  }
  const payload = await response.json().catch(() => null);
  const token = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
  if (!token) throw new Error("Metadata token response missing access_token");
  return token;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function pubsubPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let lastError = "";
  for (let attempt = 1; attempt <= PUBSUB_PULL_RETRIES; attempt += 1) {
    try {
      const token = await fetchGoogleAccessToken();
      const response = await fetch(`https://pubsub.googleapis.com/v1/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (response.ok) return asRecord(payload) || {};

      const message = asRecord(payload)?.error
        ? JSON.stringify(asRecord(payload)?.error)
        : `HTTP ${response.status}`;
      lastError = message;
      if (attempt < PUBSUB_PULL_RETRIES && isRetryableStatus(response.status)) {
        await sleep(Math.min(5000, attempt * 1000));
        continue;
      }
      throw new Error(message);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < PUBSUB_PULL_RETRIES) {
        await sleep(Math.min(5000, attempt * 1000));
        continue;
      }
      throw new Error(`Pub/Sub request failed: ${lastError}`);
    }
  }
  throw new Error(`Pub/Sub request failed: ${lastError || "unknown"}`);
}

async function pullPubsubMessages(maxMessages: number): Promise<PubsubPullMessage[]> {
  const payload = await pubsubPost(`${subscriptionPath()}:pull`, {
    maxMessages,
    returnImmediately: true,
  }) as PubsubPullResponse;
  if (!Array.isArray(payload?.receivedMessages)) return [];
  return payload.receivedMessages as PubsubPullMessage[];
}

async function ackPubsubMessages(ackIds: string[]): Promise<void> {
  if (!ackIds.length) return;
  await pubsubPost(`${subscriptionPath()}:acknowledge`, { ackIds });
}

function decodeMessageRow(message: PubsubPullMessage): DecodedMessage {
  const ackId = typeof message.ackId === "string" && message.ackId.trim() ? message.ackId : null;
  const data = message.message?.data;
  if (!ackId || typeof data !== "string" || !data.trim()) {
    return { ackId, row: null, payloadBytes: 0 };
  }
  try {
    const decoded = atob(data);
    const payloadBytes = measureUtf8Bytes(decoded);
    const parsed = JSON.parse(decoded);
    const record = asRecord(parsed);
    if (!record) return { ackId, row: null, payloadBytes };

    const connectorId = Number(record.connector_id);
    const timeseriesId = Number(record.timeseries_id);
    const observedAt = normalizeTimestamp(record.observed_at);
    if (!Number.isInteger(connectorId) || connectorId <= 0) return { ackId, row: null, payloadBytes };
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) return { ackId, row: null, payloadBytes };
    if (!observedAt) return { ackId, row: null, payloadBytes };

    const valueRaw = record.value;
    const value = valueRaw === null || valueRaw === undefined ? null : Number(valueRaw);
    if (value !== null && !Number.isFinite(value)) return { ackId, row: null, payloadBytes };

    return {
      ackId,
      payloadBytes,
      row: {
        connector_id: Math.trunc(connectorId),
        timeseries_id: Math.trunc(timeseriesId),
        observed_at: observedAt,
        value,
        value_float8_hex: record.value_float8_hex === null || record.value_float8_hex === undefined
          ? null
          : String(record.value_float8_hex),
        status: record.status === null || record.status === undefined ? null : String(record.status),
      },
    };
  } catch {
    return { ackId, row: null, payloadBytes: 0 };
  }
}

function stateKey(connectorId: number, timeseriesId: number): string {
  return `${connectorId}:${timeseriesId}`;
}

function compareStateRows(a: LatestStateEntry, b: LatestStateEntry): number {
  const aMs = Date.parse(a.observed_at);
  const bMs = Date.parse(b.observed_at);
  if (aMs !== bMs) return aMs - bMs;
  const aIngested = a.ingested_at ? Date.parse(a.ingested_at) : 0;
  const bIngested = b.ingested_at ? Date.parse(b.ingested_at) : 0;
  if (aIngested !== bIngested) return aIngested - bIngested;
  return 0;
}

function applyRowsToState(
  stateMap: Map<string, LatestStateEntry>,
  rows: ObservationMessageRow[],
  ingestedAt: string,
): StateApplySummary {
  const summary: StateApplySummary = {
    applied_new: 0,
    applied_newer: 0,
    skipped_older: 0,
    skipped_duplicate: 0,
  };

  for (const row of rows) {
    const key = stateKey(row.connector_id, row.timeseries_id);
    const next: LatestStateEntry = {
      connector_id: row.connector_id,
      timeseries_id: row.timeseries_id,
      observed_at: row.observed_at,
      value: row.value,
      value_float8_hex: row.value_float8_hex,
      status: row.status,
      ingested_at: ingestedAt,
    };
    const current = stateMap.get(key);
    if (!current) {
      stateMap.set(key, next);
      summary.applied_new += 1;
      continue;
    }
    const cmp = compareStateRows(current, next);
    if (cmp < 0) {
      stateMap.set(key, next);
      summary.applied_newer += 1;
    } else if (cmp === 0) {
      summary.skipped_duplicate += 1;
    } else {
      summary.skipped_older += 1;
    }
  }

  return summary;
}

function serializeState(stateMap: Map<string, LatestStateEntry>, updatedAt: string): Uint8Array {
  const entries = [...stateMap.values()]
    .sort((a, b) => {
      if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
      return a.timeseries_id - b.timeseries_id;
    });

  const payload: LatestStateFile = {
    schema_version: 1,
    updated_at: updatedAt,
    entries,
  };
  return TEXT_ENCODER.encode(`${toStableJson(payload)}\n`);
}

async function loadState(): Promise<LoadedState> {
  try {
    const existing = await r2GetObject({ r2: R2_CONFIG, key: UK_AQ_LATEST_SNAPSHOT_STATE_KEY });
    const text = new TextDecoder().decode(existing.body);
    const bytes = existing.body.byteLength;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const stateMap = new Map<string, LatestStateEntry>();
    const rows = Array.isArray((parsed as Record<string, unknown> | null)?.entries)
      ? ((parsed as Record<string, unknown>).entries as unknown[])
      : [];
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) continue;
      const connectorId = Number(record.connector_id);
      const timeseriesId = Number(record.timeseries_id);
      const observedAt = normalizeTimestamp(record.observed_at);
      if (!Number.isInteger(connectorId) || connectorId <= 0) continue;
      if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) continue;
      if (!observedAt) continue;
      stateMap.set(
        stateKey(Math.trunc(connectorId), Math.trunc(timeseriesId)),
        {
          connector_id: Math.trunc(connectorId),
          timeseries_id: Math.trunc(timeseriesId),
          observed_at: observedAt,
          value: record.value === null || record.value === undefined ? null : Number(record.value),
          value_float8_hex: record.value_float8_hex === null || record.value_float8_hex === undefined
            ? null
            : String(record.value_float8_hex),
          status: record.status === null || record.status === undefined ? null : String(record.status),
          ingested_at: normalizeTimestamp(record.ingested_at),
        },
      );
    }
    return {
      stateMap,
      existingHash: sha256Hex(existing.body),
      existingBytes: bytes,
    };
  } catch {
    return {
      stateMap: new Map<string, LatestStateEntry>(),
      existingHash: null,
      existingBytes: 0,
    };
  }
}

function decodeCoreTableText(body: Uint8Array, tableKey: string): string {
  const decoder = new TextDecoder();
  if (tableKey.endsWith(".gz")) {
    const uncompressed = zlib.gunzipSync(body);
    return decoder.decode(uncompressed);
  }
  return decoder.decode(body);
}

function parseNdjsonRows(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object" && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return rows;
}

function parseCoreManifest(text: string): CoreSnapshotManifest {
  const parsed = JSON.parse(text);
  const root = asRecord(parsed) || {};
  const tablesRaw = Array.isArray(root.tables) ? root.tables : [];
  const tables: Array<{ table: string; key: string }> = [];
  for (const item of tablesRaw) {
    const record = asRecord(item);
    if (!record) continue;
    const table = String(record.table || "").trim();
    const key = String(record.key || "").trim();
    if (!table || !key) continue;
    tables.push({ table, key });
  }
  return {
    day_utc: normalizeDay(root.day_utc),
    tables,
  };
}

function normalizeDay(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function shiftIsoDay(isoDay: string, dayOffset: number): string {
  const base = new Date(`${isoDay}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return isoDay;
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

function tableKeyFromManifest(manifest: CoreSnapshotManifest, tableName: string): string | null {
  const needle = tableName.trim().toLowerCase();
  for (const entry of manifest.tables) {
    if (entry.table.trim().toLowerCase() === needle) return entry.key;
  }
  return null;
}

function buildMetadataIndex(cache: CoreMetadataCacheFile): MetadataIndex {
  const connectorsById = new Map<number, MetadataConnector>();
  const stationsById = new Map<number, MetadataStation>();
  const membershipsByStationId = new Map<number, MetadataMembership[]>();
  const timeseriesById = new Map<number, MetadataTimeseries>();
  const phenomenaById = new Map<number, MetadataPhenomenon>();
  const observedPropertyById = new Map<number, MetadataObservedProperty>();

  for (const row of cache.connectors) connectorsById.set(row.id, row);
  for (const row of cache.stations) stationsById.set(row.id, row);
  for (const row of cache.timeseries) timeseriesById.set(row.id, row);
  for (const row of cache.phenomena) phenomenaById.set(row.id, row);
  for (const row of cache.observed_properties) observedPropertyById.set(row.id, row);
  for (const row of cache.memberships) {
    const existing = membershipsByStationId.get(row.station_id) || [];
    existing.push(row);
    membershipsByStationId.set(row.station_id, existing);
  }
  for (const rows of membershipsByStationId.values()) {
    rows.sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return a.network_code.localeCompare(b.network_code);
    });
  }

  return {
    source_day_utc: cache.source_day_utc,
    connectorsById,
    stationsById,
    membershipsByStationId,
    timeseriesById,
    phenomenaById,
    observedPropertyById,
  };
}

function isMetadataCacheFresh(cache: CoreMetadataCacheFile): boolean {
  const generatedAt = normalizeTimestamp(cache.generated_at);
  if (!generatedAt) return false;
  const ageMs = Date.now() - Date.parse(generatedAt);
  return ageMs <= UK_AQ_LATEST_SNAPSHOT_METADATA_REFRESH_SECONDS * 1000;
}

async function findLatestCoreManifestKey(): Promise<{ day_utc: string; key: string } | null> {
  const todayUtc = utcNowIso().slice(0, 10);
  for (let offset = 0; offset <= UK_AQ_LATEST_SNAPSHOT_CORE_LOOKBACK_DAYS; offset += 1) {
    const dayUtc = shiftIsoDay(todayUtc, -offset);
    const key = `${UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX}/day_utc=${dayUtc}/manifest.json`;
    const head = await r2HeadObject({ r2: R2_CONFIG, key });
    if (head.exists) return { day_utc: dayUtc, key };
  }
  return null;
}

function mapConnectorRows(rows: Array<Record<string, unknown>>): MetadataConnector[] {
  const output: MetadataConnector[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    output.push({
      id: Math.trunc(id),
      connector_code: normalizeNonEmptyText(String(row.connector_code ?? "")),
      label: normalizeNonEmptyText(String(row.label ?? "")),
      display_name: normalizeNonEmptyText(String(row.display_name ?? "")),
      station_display_name_template: normalizeNonEmptyText(String(row.station_display_name_template ?? "")),
    });
  }
  return output;
}

function mapStationRows(rows: Array<Record<string, unknown>>): MetadataStation[] {
  const output: MetadataStation[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const connectorId = Number(row.connector_id);
    output.push({
      id: Math.trunc(id),
      connector_id: Number.isInteger(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null,
      station_ref: normalizeNonEmptyText(String(row.station_ref ?? "")),
      label: normalizeNonEmptyText(String(row.label ?? "")),
      station_name: normalizeNonEmptyText(String(row.station_name ?? "")),
      pcon_code: normalizeNonEmptyText(String(row.pcon_code ?? "")),
      la_code: normalizeNonEmptyText(String(row.la_code ?? "")),
    });
  }
  return output;
}

function mapMembershipRows(rows: Array<Record<string, unknown>>): MetadataMembership[] {
  const output: MetadataMembership[] = [];
  for (const row of rows) {
    const stationId = Number(row.station_id);
    const networkCode = normalizeNonEmptyText(String(row.network_code ?? ""));
    if (!Number.isInteger(stationId) || stationId <= 0 || !networkCode) continue;
    output.push({
      station_id: Math.trunc(stationId),
      network_code: networkCode,
      network_label: normalizeNonEmptyText(String(row.network_label ?? "")),
      is_primary: Boolean(row.is_primary),
    });
  }
  return output;
}

function mapTimeseriesRows(rows: Array<Record<string, unknown>>): MetadataTimeseries[] {
  const output: MetadataTimeseries[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const connectorId = Number(row.connector_id);
    const stationId = Number(row.station_id);
    const phenomenonId = Number(row.phenomenon_id);
    output.push({
      id: Math.trunc(id),
      connector_id: Number.isInteger(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null,
      station_id: Number.isInteger(stationId) && stationId > 0 ? Math.trunc(stationId) : null,
      phenomenon_id: Number.isInteger(phenomenonId) && phenomenonId > 0 ? Math.trunc(phenomenonId) : null,
      label: normalizeNonEmptyText(String(row.label ?? "")),
      uom: normalizeNonEmptyText(String(row.uom ?? "")),
    });
  }
  return output;
}

function mapPhenomenonRows(rows: Array<Record<string, unknown>>): MetadataPhenomenon[] {
  const output: MetadataPhenomenon[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const observedPropertyId = Number(row.observed_property_id);
    output.push({
      id: Math.trunc(id),
      observed_property_id: Number.isInteger(observedPropertyId) && observedPropertyId > 0
        ? Math.trunc(observedPropertyId)
        : null,
      label: normalizeNonEmptyText(String(row.label ?? "")),
      notation: normalizeNonEmptyText(String(row.notation ?? "")),
      pollutant_label: normalizeNonEmptyText(String(row.pollutant_label ?? "")),
      source_label: normalizeNonEmptyText(String(row.source_label ?? row.eionet_uri ?? "")),
    });
  }
  return output;
}

function mapObservedPropertyRows(rows: Array<Record<string, unknown>>): MetadataObservedProperty[] {
  const output: MetadataObservedProperty[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    output.push({
      id: Math.trunc(id),
      code: normalizeNonEmptyText(String(row.code ?? "")),
      display_name: normalizeNonEmptyText(String(row.display_name ?? "")),
    });
  }
  return output;
}

async function loadMetadataIndex(): Promise<{ metadata: MetadataIndex; stats: MetadataRefreshStats }> {
  const startedMs = Date.now();
  let objectsRead = 0;
  let bytesRead = 0;

  try {
    const cacheObject = await r2GetObject({ r2: R2_CONFIG, key: UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_CACHE_KEY });
    objectsRead += 1;
    bytesRead += cacheObject.body.byteLength;
    const text = new TextDecoder().decode(cacheObject.body);
    const parsed = JSON.parse(text) as CoreMetadataCacheFile;
    if (parsed && parsed.schema_version === 1 && isMetadataCacheFresh(parsed)) {
      return {
        metadata: buildMetadataIndex(parsed),
        stats: {
          refreshed: false,
          source_day_utc: parsed.source_day_utc || null,
          objects_read: objectsRead,
          bytes_read: bytesRead,
          cache_bytes_written: 0,
          duration_ms: Date.now() - startedMs,
        },
      };
    }
  } catch {
    // fall through to refresh
  }

  const latestManifestInfo = await findLatestCoreManifestKey();
  if (!latestManifestInfo) {
    throw new Error("No core snapshot manifest found in R2 lookback window.");
  }

  const manifestObject = await r2GetObject({ r2: R2_CONFIG, key: latestManifestInfo.key });
  objectsRead += 1;
  bytesRead += manifestObject.body.byteLength;
  const manifestText = new TextDecoder().decode(manifestObject.body);
  const manifest = parseCoreManifest(manifestText);

  const requiredTables = [
    "connectors",
    "stations",
    "timeseries",
    "phenomena",
    "observed_properties",
  ];

  const tableRows = new Map<string, Array<Record<string, unknown>>>();
  for (const tableName of requiredTables) {
    const key = tableKeyFromManifest(manifest, tableName);
    if (!key) {
      throw new Error(`Core snapshot manifest missing table ${tableName}`);
    }
    const object = await r2GetObject({ r2: R2_CONFIG, key });
    objectsRead += 1;
    bytesRead += object.body.byteLength;
    const ndjsonText = decodeCoreTableText(object.body, key);
    tableRows.set(tableName, parseNdjsonRows(ndjsonText));
  }

  const membershipsKey = tableKeyFromManifest(manifest, "station_network_memberships");
  if (membershipsKey) {
    const object = await r2GetObject({ r2: R2_CONFIG, key: membershipsKey });
    objectsRead += 1;
    bytesRead += object.body.byteLength;
    const ndjsonText = decodeCoreTableText(object.body, membershipsKey);
    tableRows.set("station_network_memberships", parseNdjsonRows(ndjsonText));
  } else {
    tableRows.set("station_network_memberships", []);
  }

  const cachePayload: CoreMetadataCacheFile = {
    schema_version: 1,
    generated_at: utcNowIso(),
    source_day_utc: manifest.day_utc || latestManifestInfo.day_utc,
    connectors: mapConnectorRows(tableRows.get("connectors") || []),
    stations: mapStationRows(tableRows.get("stations") || []),
    memberships: mapMembershipRows(tableRows.get("station_network_memberships") || []),
    timeseries: mapTimeseriesRows(tableRows.get("timeseries") || []),
    phenomena: mapPhenomenonRows(tableRows.get("phenomena") || []),
    observed_properties: mapObservedPropertyRows(tableRows.get("observed_properties") || []),
  };
  const cacheBytes = TEXT_ENCODER.encode(`${toStableJson(cachePayload)}\n`);
  await r2PutObject({
    r2: R2_CONFIG,
    key: UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_CACHE_KEY,
    body: cacheBytes,
    content_type: "application/json; charset=utf-8",
  });

  return {
    metadata: buildMetadataIndex(cachePayload),
    stats: {
      refreshed: true,
      source_day_utc: cachePayload.source_day_utc,
      objects_read: objectsRead,
      bytes_read: bytesRead,
      cache_bytes_written: cacheBytes.byteLength,
      duration_ms: Date.now() - startedMs,
    },
  };
}

function deriveNextCursor(rows: LatestItem[]): { since: string | null; sinceId: number | null } {
  let bestSince: string | null = null;
  let bestId: number | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const since = normalizeTimestamp(row.last_value_at);
    if (!since) continue;
    const rowMs = Date.parse(since);
    const rowId = Number.isInteger(row.id) && (row.id as number) >= 0 ? (row.id as number) : 0;
    if (rowMs > bestMs) {
      bestMs = rowMs;
      bestSince = since;
      bestId = rowId;
      continue;
    }
    if (rowMs === bestMs) {
      const currentId = bestId ?? 0;
      if (rowId > currentId) bestId = rowId;
    }
  }
  return { since: bestSince, sinceId: bestSince ? (bestId ?? 0) : null };
}

function minMaxObservedAt(rows: LatestItem[]): { min: string | null; max: string | null } {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let min: string | null = null;
  let max: string | null = null;
  for (const row of rows) {
    const value = normalizeTimestamp(row.last_value_at);
    if (!value) continue;
    const ms = Date.parse(value);
    if (ms < minMs) {
      minMs = ms;
      min = value;
    }
    if (ms > maxMs) {
      maxMs = ms;
      max = value;
    }
  }
  return { min, max };
}

function computeWindowCutoffMs(windowLabel: string, nowMs: number): number | null {
  if (windowLabel === "all") return null;
  if (windowLabel === "3h") return nowMs - 3 * 60 * 60 * 1000;
  if (windowLabel === "6h") return nowMs - 6 * 60 * 60 * 1000;
  if (windowLabel === "1d") return nowMs - 24 * 60 * 60 * 1000;
  if (windowLabel === "7d") return nowMs - 7 * 24 * 60 * 60 * 1000;
  return null;
}

function buildSourceRows(
  stateMap: Map<string, LatestStateEntry>,
  metadata: MetadataIndex,
): { rows: SnapshotSourceRow[]; missingMetadata: number } {
  const rows: SnapshotSourceRow[] = [];
  let missingMetadata = 0;

  for (const state of stateMap.values()) {
    const series = metadata.timeseriesById.get(state.timeseries_id);
    if (!series) {
      missingMetadata += 1;
      continue;
    }
    const station = series.station_id ? metadata.stationsById.get(series.station_id) || null : null;
    const connectorId = series.connector_id || state.connector_id;
    const connector = connectorId ? metadata.connectorsById.get(connectorId) || null : null;
    const phenomenon = series.phenomenon_id ? metadata.phenomenaById.get(series.phenomenon_id) || null : null;
    const observedProperty = phenomenon?.observed_property_id
      ? metadata.observedPropertyById.get(phenomenon.observed_property_id) || null
      : null;

    const pollutantNormalized = normalizePollutant(
      observedProperty?.code ??
        phenomenon?.notation ??
        phenomenon?.pollutant_label ??
        phenomenon?.label ??
        null,
    );
    const matrixPollutant = normalizeMatrixPollutant(pollutantNormalized);
    if (!matrixPollutant) continue;

    if (!passesOutlierThreshold(pollutantNormalized, state.value)) continue;
    if (!(station?.pcon_code || station?.la_code)) continue;

    const stationLabel = resolveStationLabel(station?.label, station?.station_ref, series.label ?? null);
    const stationMemberships = station
      ? (metadata.membershipsByStationId.get(station.id) || []).map((item) => ({
        network_code: item.network_code,
        network_label: item.network_label,
        is_primary: item.is_primary,
      }))
      : [];

    const phenomenonLabel = resolvePhenomenonLabel(
      observedProperty?.display_name,
      phenomenon?.pollutant_label,
      phenomenon?.label,
      phenomenon?.notation,
      phenomenon?.source_label,
    );

    const item: LatestItem = {
      id: series.id,
      last_value: state.value,
      last_value_at: state.observed_at,
      connector_code: connector?.connector_code || null,
      connector_label: connector?.display_name || connector?.label || null,
      station_id: station?.id ?? null,
      station_label: stationLabel,
      display_name: formatDisplayName(
        connector?.station_display_name_template,
        station?.station_name,
        stationLabel,
        station?.station_ref || null,
        station?.id ?? null,
      ),
      pcon_code: station?.pcon_code ?? null,
      la_code: station?.la_code ?? null,
      station_network_memberships: stationMemberships,
      phenomenon_label: phenomenonLabel,
      pollutant_label: phenomenonLabel,
      observed_property_code: pollutantNormalized,
      uom_display: formatUnit(series.uom),
    };

    rows.push({
      pollutant: matrixPollutant,
      item,
    });
  }

  return { rows, missingMetadata };
}

function sortSnapshotRows(rows: LatestItem[]): LatestItem[] {
  return rows.sort((a, b) => {
    const aPollutant = a.phenomenon_label ?? a.pollutant_label ?? "";
    const bPollutant = b.phenomenon_label ?? b.pollutant_label ?? "";
    const pollutantCompare = aPollutant.localeCompare(bPollutant);
    if (pollutantCompare !== 0) return pollutantCompare;
    const aStation = a.station_label ?? "";
    const bStation = b.station_label ?? "";
    return aStation.localeCompare(bStation);
  });
}

async function flushPubsubRows(): Promise<{ rows: ObservationMessageRow[]; validAckIds: string[]; summary: PullSummary }> {
  const startedMs = Date.now();
  const outputRows: ObservationMessageRow[] = [];
  const validAckIds: string[] = [];
  const summary: PullSummary = {
    pull_requests: 0,
    pulled_messages: 0,
    decoded_rows: 0,
    malformed_messages: 0,
    acked_messages: 0,
    payload_bytes: 0,
    duration_ms: 0,
  };

  for (let batch = 0; batch < PUBSUB_MAX_BATCHES_PER_RUN; batch += 1) {
    summary.pull_requests += 1;
    const pulled = await pullPubsubMessages(PUBSUB_PULL_MAX_MESSAGES);
    if (!pulled.length) break;
    summary.pulled_messages += pulled.length;

    const malformedAckIds: string[] = [];
    const batchValidAckIds: string[] = [];
    const batchRows: ObservationMessageRow[] = [];

    for (const message of pulled) {
      const decoded = decodeMessageRow(message);
      summary.payload_bytes += decoded.payloadBytes;
      if (!decoded.ackId) {
        summary.malformed_messages += 1;
        continue;
      }
      if (!decoded.row) {
        malformedAckIds.push(decoded.ackId);
        summary.malformed_messages += 1;
        continue;
      }
      batchValidAckIds.push(decoded.ackId);
      batchRows.push(decoded.row);
    }

    if (malformedAckIds.length) {
      await ackPubsubMessages(malformedAckIds);
      summary.acked_messages += malformedAckIds.length;
    }
    summary.decoded_rows += batchRows.length;
    validAckIds.push(...batchValidAckIds);
    outputRows.push(...batchRows);
  }

  summary.duration_ms = Date.now() - startedMs;
  return { rows: outputRows, validAckIds, summary };
}

async function loadExistingManifest(): Promise<SnapshotManifest | null> {
  try {
    const existing = await r2GetObject({ r2: R2_CONFIG, key: UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY });
    const text = new TextDecoder().decode(existing.body);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SnapshotManifest;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!hasRequiredR2Config(R2_CONFIG)) {
    throw new Error("Missing required R2 configuration (CFLARE_R2_*).");
  }
  if (!UK_AQ_LATEST_SNAPSHOT_R2_PREFIX) {
    throw new Error("UK_AQ_LATEST_SNAPSHOT_R2_PREFIX resolved empty.");
  }
  if (!UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY) {
    throw new Error("UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY resolved empty.");
  }
  if (!PUBSUB_PROJECT_ID) {
    throw new Error("Missing GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT).");
  }
  if (!PUBSUB_SUBSCRIPTION) {
    throw new Error("UK_AQ_LATEST_SNAPSHOT_PUBSUB_SUBSCRIPTION resolved empty.");
  }
  if (OBSERVS_BASE_SUBSCRIPTION && OBSERVS_BASE_SUBSCRIPTION === PUBSUB_SUBSCRIPTION) {
    throw new Error("Snapshot Pub/Sub subscription must be dedicated (must not equal OBSERVS_PUBSUB_SUBSCRIPTION).");
  }
  if (UK_AQ_LATEST_SNAPSHOT_POLLUTANTS.length === 0) {
    throw new Error("UK_AQ_LATEST_SNAPSHOT_POLLUTANTS resolved empty.");
  }
  if (UK_AQ_LATEST_SNAPSHOT_WINDOWS.length === 0) {
    throw new Error("UK_AQ_LATEST_SNAPSHOT_WINDOWS resolved empty.");
  }

  const triggerMode = (Deno.env.get("UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE") || "manual").trim().toLowerCase() || "manual";
  const startedAt = utcNowIso();
  const startedMs = Date.now();
  const warnings: string[] = [];
  const serviceEgressMetricRows: ServiceEgressMetricRow[] = [];
  const serviceProjectRef = UK_AQ_SERVICE_EGRESS_PROJECT_REF ||
    deriveProjectRef(UK_AQ_SERVICE_EGRESS_METRICS_SUPABASE_URL);

  const previousManifest = await loadExistingManifest();
  const previousById = new Map<string, SnapshotManifestEntry>();
  for (const entry of previousManifest?.snapshots || []) {
    if (entry && typeof entry.id === "string") previousById.set(entry.id, entry as SnapshotManifestEntry);
  }

  const stateLoaded = await loadState();

  serviceEgressMetricRows.push({
    bucket_minute: metricBucketMinute(startedAt),
    env_name: UK_AQ_SERVICE_EGRESS_ENV,
    project_ref: serviceProjectRef,
    service_name: "uk_aq_latest_snapshot_builder",
    source_type: "r2",
    source_name: R2_CONFIG.bucket || "",
    route_name: "latest_state_read",
    query_name: "r2GetObject",
    status: stateLoaded.existingHash ? "ok" : "skipped",
    request_count: stateLoaded.existingHash ? 1 : 0,
    response_rows: stateLoaded.stateMap.size,
    response_bytes_est: stateLoaded.existingBytes,
    upstream_bytes_est: stateLoaded.existingBytes,
    duration_ms: 0,
    error_count: 0,
    notes: {
      state_key: UK_AQ_LATEST_SNAPSHOT_STATE_KEY,
      state_found: Boolean(stateLoaded.existingHash),
    },
  });

  const pulled = await flushPubsubRows();
  const ingestedAt = utcNowIso();
  const stateApply = applyRowsToState(stateLoaded.stateMap, pulled.rows, ingestedAt);
  if (stateLoaded.stateMap.size > UK_AQ_LATEST_SNAPSHOT_MAX_STATE_ENTRIES) {
    throw new Error(
      `Latest snapshot state exceeded max entries (${stateLoaded.stateMap.size} > ${UK_AQ_LATEST_SNAPSHOT_MAX_STATE_ENTRIES}).`,
    );
  }

  const stateBytes = serializeState(stateLoaded.stateMap, ingestedAt);
  const nextStateHash = sha256Hex(stateBytes);
  const stateChanged = nextStateHash !== stateLoaded.existingHash;
  if (stateChanged) {
    await r2PutObject({
      r2: R2_CONFIG,
      key: UK_AQ_LATEST_SNAPSHOT_STATE_KEY,
      body: stateBytes,
      content_type: "application/json; charset=utf-8",
    });
  }

  serviceEgressMetricRows.push({
    bucket_minute: metricBucketMinute(startedAt),
    env_name: UK_AQ_SERVICE_EGRESS_ENV,
    project_ref: serviceProjectRef,
    service_name: "uk_aq_latest_snapshot_builder",
    source_type: "r2",
    source_name: R2_CONFIG.bucket || "",
    route_name: "latest_state_write",
    query_name: "r2PutObject",
    status: stateChanged ? "ok" : "skipped",
    request_count: stateChanged ? 1 : 0,
    response_rows: stateLoaded.stateMap.size,
    response_bytes_est: 0,
    upstream_bytes_est: stateChanged ? stateBytes.byteLength : 0,
    objects_written_count: stateChanged ? 1 : 0,
    objects_written_bytes: stateChanged ? stateBytes.byteLength : 0,
    duration_ms: 0,
    error_count: 0,
    notes: {
      state_key: UK_AQ_LATEST_SNAPSHOT_STATE_KEY,
      applied_new: stateApply.applied_new,
      applied_newer: stateApply.applied_newer,
      skipped_older: stateApply.skipped_older,
      skipped_duplicate: stateApply.skipped_duplicate,
    },
  });

  if (pulled.validAckIds.length) {
    await ackPubsubMessages(pulled.validAckIds);
    pulled.summary.acked_messages += pulled.validAckIds.length;
  }

  serviceEgressMetricRows.push({
    bucket_minute: metricBucketMinute(startedAt),
    env_name: UK_AQ_SERVICE_EGRESS_ENV,
    project_ref: serviceProjectRef,
    service_name: "uk_aq_latest_snapshot_builder",
    source_type: "gcp",
    source_name: PUBSUB_PROJECT_ID,
    route_name: "pubsub_observation_pull",
    query_name: PUBSUB_SUBSCRIPTION,
    status: "ok",
    request_count: pulled.summary.pull_requests,
    response_rows: pulled.summary.decoded_rows,
    response_bytes_est: pulled.summary.payload_bytes,
    upstream_bytes_est: pulled.summary.payload_bytes,
    duration_ms: pulled.summary.duration_ms,
    error_count: 0,
    notes: {
      pulled_messages: pulled.summary.pulled_messages,
      malformed_messages: pulled.summary.malformed_messages,
      acked_messages: pulled.summary.acked_messages,
      max_batches: PUBSUB_MAX_BATCHES_PER_RUN,
      max_messages: PUBSUB_PULL_MAX_MESSAGES,
    },
  });

  const metadataResult = await loadMetadataIndex();
  serviceEgressMetricRows.push({
    bucket_minute: metricBucketMinute(startedAt),
    env_name: UK_AQ_SERVICE_EGRESS_ENV,
    project_ref: serviceProjectRef,
    service_name: "uk_aq_latest_snapshot_builder",
    source_type: "r2",
    source_name: R2_CONFIG.bucket || "",
    route_name: "core_metadata_refresh",
    query_name: "r2GetObject",
    status: "ok",
    request_count: metadataResult.stats.objects_read,
    response_rows: metadataResult.metadata.timeseriesById.size,
    response_bytes_est: metadataResult.stats.bytes_read,
    upstream_bytes_est: metadataResult.stats.bytes_read,
    objects_written_count: metadataResult.stats.refreshed ? 1 : 0,
    objects_written_bytes: metadataResult.stats.cache_bytes_written,
    duration_ms: metadataResult.stats.duration_ms,
    error_count: 0,
    notes: {
      refreshed: metadataResult.stats.refreshed,
      metadata_day_utc: metadataResult.stats.source_day_utc,
      cache_key: UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_CACHE_KEY,
    },
  });

  const sourceRows = buildSourceRows(stateLoaded.stateMap, metadataResult.metadata);
  if (sourceRows.missingMetadata > 0) {
    warnings.push(`missing_metadata_rows=${sourceRows.missingMetadata}`);
  }

  const nowMs = Date.now();
  const entries: SnapshotManifestEntry[] = [];
  let successCount = 0;
  let failureCount = 0;
  let changedCount = 0;
  let skippedUnchangedCount = 0;

  for (const pollutant of UK_AQ_LATEST_SNAPSHOT_POLLUTANTS) {
    for (const windowLabel of UK_AQ_LATEST_SNAPSHOT_WINDOWS) {
      const itemStarted = Date.now();
      const id = matrixId(UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP, pollutant, windowLabel);
      const key = snapshotKey(UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP, pollutant, windowLabel);
      const previous = previousById.get(id) || null;
      try {
        const cutoffMs = computeWindowCutoffMs(windowLabel, nowMs);
        const rows = sourceRows.rows
          .filter((row) => row.pollutant === pollutant)
          .map((row) => row.item)
          .filter((item) => {
            if (cutoffMs === null) return true;
            const observedAt = normalizeTimestamp(item.last_value_at);
            if (!observedAt) return false;
            return Date.parse(observedAt) >= cutoffMs;
          });

        sortSnapshotRows(rows);
        const nextCursor = deriveNextCursor(rows);
        const payload: SnapshotPayload = {
          region: null,
          pcon_code: null,
          pollutant,
          window: windowLabel,
          since: null,
          since_id: null,
          next_since: nextCursor.since,
          next_since_id: nextCursor.sinceId,
          count: rows.length,
          data: rows,
        };

        const body = `${toStableJson(payload)}\n`;
        const bodyBytes = TEXT_ENCODER.encode(body);
        const hash = sha256Hex(bodyBytes);
        const etag = `"sha256-${hash}"`;
        const changed = previous?.sha256 !== hash || previous?.object_key !== key;
        const itemDurationMs = Date.now() - itemStarted;

        if (changed) {
          await r2PutObject({
            r2: R2_CONFIG,
            key,
            body: bodyBytes,
            content_type: "application/json; charset=utf-8",
          });
          changedCount += 1;
        } else {
          skippedUnchangedCount += 1;
        }

        serviceEgressMetricRows.push({
          bucket_minute: metricBucketMinute(startedAt),
          env_name: UK_AQ_SERVICE_EGRESS_ENV,
          project_ref: serviceProjectRef,
          service_name: "uk_aq_latest_snapshot_builder",
          source_type: "r2",
          source_name: R2_CONFIG.bucket || "",
          route_name: "snapshot_object_write",
          query_name: "r2PutObject",
          window_label: windowLabel,
          status: changed ? "ok" : "skipped",
          request_count: changed ? 1 : 0,
          response_rows: rows.length,
          response_bytes_est: 0,
          upstream_bytes_est: changed ? bodyBytes.byteLength : 0,
          objects_written_count: changed ? 1 : 0,
          objects_written_bytes: changed ? bodyBytes.byteLength : 0,
          duration_ms: itemDurationMs,
          error_count: 0,
          notes: {
            trigger_mode: triggerMode,
            pollutant,
            changed,
          },
        });

        const observed = minMaxObservedAt(rows);
        entries.push({
          id,
          network_group: UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP,
          pollutant,
          window: windowLabel,
          object_key: key,
          content_type: "application/json; charset=utf-8",
          content_encoding: null,
          sha256: hash,
          etag,
          row_count: rows.length,
          bytes: bodyBytes.byteLength,
          min_observed_at: observed.min,
          max_observed_at: observed.max,
          generated_at: utcNowIso(),
          build_duration_ms: itemDurationMs,
          previous_sha256: previous?.sha256 ?? null,
          changed,
          error: null,
        });
        successCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failureCount += 1;
        warnings.push(`${id}: ${message}`);
        if (previous) {
          entries.push({
            ...previous,
            build_duration_ms: Date.now() - itemStarted,
            generated_at: utcNowIso(),
            changed: false,
            error: message,
          });
        } else {
          entries.push({
            id,
            network_group: UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP,
            pollutant,
            window: windowLabel,
            object_key: null,
            content_type: "application/json; charset=utf-8",
            content_encoding: null,
            sha256: null,
            etag: null,
            row_count: null,
            bytes: null,
            min_observed_at: null,
            max_observed_at: null,
            generated_at: utcNowIso(),
            build_duration_ms: Date.now() - itemStarted,
            previous_sha256: null,
            changed: false,
            error: message,
          });
        }
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const finishedAt = utcNowIso();
  const durationMs = Date.now() - startedMs;

  const manifest: SnapshotManifest = {
    schema_version: 1,
    snapshot_family: "latest",
    version: "v1",
    generated_at: finishedAt,
    trigger_mode: triggerMode,
    source: {
      type: "pubsub_observation_state",
      pubsub_subscription: subscriptionPath(),
      state_key: UK_AQ_LATEST_SNAPSHOT_STATE_KEY,
      core_metadata_prefix: UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX,
      core_metadata_day_utc: metadataResult.metadata.source_day_utc,
    },
    matrix: {
      network_group: UK_AQ_LATEST_SNAPSHOT_NETWORK_GROUP,
      pollutants: [...UK_AQ_LATEST_SNAPSHOT_POLLUTANTS],
      windows: [...UK_AQ_LATEST_SNAPSHOT_WINDOWS],
    },
    build: {
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      success_count: successCount,
      failure_count: failureCount,
      partial_failure: failureCount > 0,
      ok: failureCount === 0,
    },
    snapshots: entries,
  };

  const manifestBody = TEXT_ENCODER.encode(`${toStableJson(manifest)}\n`);
  await r2PutObject({
    r2: R2_CONFIG,
    key: UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY,
    body: manifestBody,
    content_type: "application/json; charset=utf-8",
  });

  let reportKey: string | null = null;
  if (UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED && UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX) {
    reportKey = `${UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX}/${compactTimestamp(finishedAt)}.json`;
    const report: BuildReport = {
      ok: failureCount === 0,
      trigger_mode: triggerMode,
      manifest_key: UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY,
      reports_key: reportKey,
      duration_ms: durationMs,
      success_count: successCount,
      failure_count: failureCount,
      changed_count: changedCount,
      skipped_unchanged_count: skippedUnchangedCount,
      warnings,
    };
    await r2PutObject({
      r2: R2_CONFIG,
      key: reportKey,
      body: TEXT_ENCODER.encode(`${toStableJson(report)}\n`),
      content_type: "application/json; charset=utf-8",
    });
  }

  const aggregatedEgressMetrics = aggregateServiceEgressMetrics(serviceEgressMetricRows);
  try {
    await publishServiceEgressMetrics(aggregatedEgressMetrics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`service_egress_metrics_flush_failed: ${message}`);
  }

  const report: BuildReport = {
    ok: failureCount === 0,
    trigger_mode: triggerMode,
    manifest_key: UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY,
    reports_key: reportKey,
    duration_ms: durationMs,
    success_count: successCount,
    failure_count: failureCount,
    changed_count: changedCount,
    skipped_unchanged_count: skippedUnchangedCount,
    warnings,
  };
  console.log(JSON.stringify(report));

  if (failureCount > 0) {
    throw new Error(`Snapshot build completed with ${failureCount} failed matrix item(s).`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    Deno.exit(1);
  });
}
