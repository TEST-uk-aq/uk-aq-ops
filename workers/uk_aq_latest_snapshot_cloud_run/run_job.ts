import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2PutObject,
  sha256Hex,
} from "../shared/r2_sigv4.mjs";

type RpcError = { message: string };
type RpcResult<T> = { data: T | null; error: RpcError | null };

type RawLatestRow = {
  id: number | null;
  updated_at: string | null;
  timeseries_ref: string | null;
  label: string | null;
  uom: string | null;
  last_value: number | null;
  last_value_at: string | null;
  connector_id: number | null;
  connector: Record<string, unknown> | null;
  station: Record<string, unknown> | null;
  phenomenon: Record<string, unknown> | null;
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
    type: "postgrest_rpc";
    supabase_url: string;
    rpc: string;
    schema: string;
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

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SB_SECRET_KEY = requiredEnv("SB_SECRET_KEY");
const UK_AQ_PUBLIC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public").trim();
const UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC = (
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC") || "uk_aq_latest_rpc"
).trim();
const UK_AQ_LATEST_SNAPSHOT_LIMIT = Math.min(
  10000,
  Math.max(1, parsePositiveInt(Deno.env.get("UK_AQ_LATEST_SNAPSHOT_LIMIT"), 10000)),
);

const UK_AQ_LATEST_SNAPSHOT_POLLUTANTS = parseCsvList(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_POLLUTANTS"),
  ["pm25", "pm10", "no2"],
).map((value) => normalizeMatrixPollutant(value)).filter((value): value is string => Boolean(value));

const UK_AQ_LATEST_SNAPSHOT_WINDOWS = parseCsvList(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_WINDOWS"),
  ["3h", "6h", "1d"],
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
const UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES"),
  3,
);
const UK_AQ_LATEST_SNAPSHOT_RPC_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_RPC_TIMEOUT_MS"),
  20000,
);

const R2_CONFIG = {
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
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function parseCsvList(raw: string | undefined | null, fallback: string[]): string[] {
  const source = String(raw || "").trim();
  if (!source) {
    return [...fallback];
  }
  const values = source.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : [...fallback];
}

function normalizeMatrixPollutant(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const compact = normalized.toLowerCase().replace(/[\s_.-]/g, "");
  if (compact === "pm25") {
    return "pm25";
  }
  if (compact === "pm10") {
    return "pm10";
  }
  if (compact === "no2") {
    return "no2";
  }
  return null;
}

function toRpcPollutant(matrixPollutant: string): string {
  const normalized = normalizeMatrixPollutant(matrixPollutant);
  if (normalized === "pm25") {
    return "pm2.5";
  }
  return normalized || matrixPollutant;
}

function normalizePollutant(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const compact = normalized.toLowerCase().replace(/[\s_]/g, "");
  if (compact === "pm25" || compact === "pm2.5") {
    return "pm2.5";
  }
  if (compact === "pm10") {
    return "pm10";
  }
  if (compact === "no2") {
    return "no2";
  }
  return normalized.toLowerCase();
}

function normalizeWindow(value: string | null): string | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  return ["3h", "6h", "1d", "7d", "all"].includes(normalized)
    ? normalized
    : null;
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeTimestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function normalizeCursorId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeNonEmptyText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function formatUnit(unit: string | null): string | null {
  if (!unit) {
    return null;
  }
  const trimmed = unit.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase().replace(/µ/g, "u");
  if (normalized.includes("ug") && /m\s*[-^]?\s*3/.test(normalized)) {
    return "µg/m³";
  }
  return trimmed;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikePollutantUri(value: string): boolean {
  return /dd\.eionet\.europa\.eu\/vocabulary\/aq\/pollutant\//i.test(value);
}

function deriveStationLabel(label: string | null): string | null {
  if (!label) {
    return null;
  }
  const separator = label.includes(" - ") ? " - " : "-";
  const parts = label.split(separator).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    return label;
  }
  if (parts.length > 1 && (looksLikePollutantUri(parts[0]) || looksLikeUrl(parts[0]))) {
    return parts[parts.length - 1];
  }
  if (parts.length === 1 && looksLikeUrl(parts[0])) {
    return null;
  }
  return parts[0];
}

function resolveStationLabel(
  stationLabel: string | null | undefined,
  stationRef: string | null | undefined,
  seriesLabel: string | null,
): string | null {
  const normalizedStationLabel = normalizeNonEmptyText(stationLabel);
  if (normalizedStationLabel) {
    return normalizedStationLabel;
  }
  const derived = normalizeNonEmptyText(deriveStationLabel(seriesLabel));
  if (derived) {
    return derived;
  }
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
  if (normalizedRef && normalizedBase.includes(normalizedRef.toLowerCase())) {
    return base;
  }
  return normalizedRef ? `${base} - ${normalizedRef}` : base;
}

function formatDisplayName(
  template: string | null | undefined,
  stationName: string | null | undefined,
  stationLabel: string | null | undefined,
  stationRef: string | number,
  stationId: string | number | null | undefined,
): string | null {
  const refText = normalizeNonEmptyText(stationRef !== null && stationRef !== undefined ? String(stationRef) : null);
  const fallback = formatFallbackDisplayName(stationName, stationLabel, refText, stationId);
  const effectiveTemplate = template?.trim();
  if (!effectiveTemplate) {
    return fallback;
  }
  const rendered = renderDisplayTemplate(effectiveTemplate, {
    station_name: stationName ?? "",
    station_label: stationLabel ?? "",
    station_ref: refText ?? "",
  });
  if (rendered) {
    return rendered;
  }
  return fallback;
}

function hasAssignedGeoCode(row: RawLatestRow): boolean {
  const station = (row.station ?? null) as Record<string, unknown> | null;
  const pconCode = typeof station?.pcon_code === "string"
    ? station.pcon_code.trim()
    : "";
  const laCode = typeof station?.la_code === "string"
    ? station.la_code.trim()
    : "";
  return Boolean(pconCode || laCode);
}

function passesOutlierThreshold(row: RawLatestRow): boolean {
  const rawValue = row?.last_value;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return false;
  }
  const phenomenon = (row.phenomenon ?? null) as Record<string, unknown> | null;
  const pollutant = normalizePollutant(
    (phenomenon?.observed_property_code as string | null)
      ?? (phenomenon?.notation as string | null)
      ?? (phenomenon?.pollutant_label as string | null)
      ?? (phenomenon?.label as string | null)
      ?? null,
  );
  if (!pollutant) {
    return true;
  }
  const thresholds: Record<string, { min: number; max: number }> = {
    "pm2.5": { min: 0, max: 500 },
    "pm25": { min: 0, max: 500 },
    "pm10": { min: 0, max: 600 },
  };
  const bounds = thresholds[pollutant];
  if (!bounds) {
    return true;
  }
  return value >= bounds.min && value <= bounds.max;
}

function deriveNextCursor(
  rows: RawLatestRow[],
  fallbackSince: string | null,
  fallbackSinceId: number | null,
): { since: string | null; sinceId: number | null } {
  let bestSince = fallbackSince ? normalizeTimestamp(fallbackSince) : null;
  let bestId = bestSince ? (fallbackSinceId ?? 0) : null;
  let bestMs = bestSince ? Date.parse(bestSince) : Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rowSince = normalizeTimestamp(row?.updated_at ?? row?.last_value_at ?? "");
    if (!rowSince) {
      continue;
    }
    const rowMs = Date.parse(rowSince);
    const rowId = normalizeCursorId(row?.id) ?? 0;
    if (rowMs > bestMs) {
      bestMs = rowMs;
      bestSince = rowSince;
      bestId = rowId;
      continue;
    }
    if (rowMs === bestMs) {
      const currentId = bestId ?? 0;
      if (rowId > currentId) {
        bestId = rowId;
      }
    }
  }
  if (!bestSince) {
    return { since: null, sinceId: null };
  }
  return { since: bestSince, sinceId: bestId ?? 0 };
}

function buildLatestItem(row: RawLatestRow): LatestItem {
  const station = (row.station ?? null) as Record<string, unknown> | null;
  const connector = (row.connector ?? null) as Record<string, unknown> | null;
  const phenomenon = (row.phenomenon ?? null) as Record<string, unknown> | null;

  const stationLabel = resolveStationLabel(
    station?.label as string | null | undefined,
    station?.station_ref as string | null | undefined,
    row.label,
  );

  const pollutantLabel = resolvePhenomenonLabel(
    phenomenon?.observed_property_display_name as string | null | undefined,
    phenomenon?.pollutant_label as string | null | undefined,
    phenomenon?.label as string | null | undefined,
    phenomenon?.notation as string | null | undefined,
    (phenomenon?.source_label as string | null | undefined)
      ?? (phenomenon?.eionet_uri as string | null | undefined),
  );

  const observedPropertyCode = normalizePollutant(
    (phenomenon?.observed_property_code as string | null)
      ?? (phenomenon?.notation as string | null)
      ?? (phenomenon?.pollutant_label as string | null)
      ?? (phenomenon?.label as string | null)
      ?? null,
  );

  const rawMemberships = Array.isArray(station?.station_network_memberships)
    ? station.station_network_memberships
    : [];
  const stationNetworkMemberships = rawMemberships
    .map((entry: Record<string, unknown>) => {
      const networkCode = (entry?.network_code as string | null)
        ?? (entry?.connector_code as string | null)
        ?? null;
      if (!networkCode) {
        return null;
      }
      return {
        network_code: networkCode,
        network_label: (entry?.network_label as string | null)
          ?? (entry?.label as string | null)
          ?? null,
        is_primary: Boolean(entry?.is_primary),
      };
    })
    .filter((entry): entry is { network_code: string; network_label: string | null; is_primary: boolean } => Boolean(entry));

  return {
    id: row.id ?? null,
    last_value: row.last_value ?? null,
    last_value_at: row.last_value_at ?? null,
    connector_code: (connector?.connector_code as string | null) ?? null,
    connector_label: (connector?.display_name as string | null)
      ?? (connector?.label as string | null)
      ?? null,
    station_id: (station?.id as number | null) ?? null,
    station_label: stationLabel,
    display_name: formatDisplayName(
      connector?.station_display_name_template as string | null | undefined,
      station?.station_name as string | null | undefined,
      stationLabel,
      station?.station_ref as string | number,
      station?.id as string | number | null | undefined,
    ),
    pcon_code: (station?.pcon_code as string | null) ?? null,
    la_code: (station?.la_code as string | null) ?? null,
    station_network_memberships: stationNetworkMemberships,
    phenomenon_label: pollutantLabel,
    pollutant_label: pollutantLabel,
    observed_property_code: observedPropertyCode,
    uom_display: formatUnit(row.uom),
  };
}

async function postgrestRpc<T>(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const endpoint = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${rpcName}`;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UK_AQ_LATEST_SNAPSHOT_RPC_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SB_SECRET_KEY,
          Authorization: `Bearer ${SB_SECRET_KEY}`,
          "Accept-Profile": UK_AQ_PUBLIC_SCHEMA,
          "Content-Profile": UK_AQ_PUBLIC_SCHEMA,
          "x-ukaq-egress-caller": "uk_aq_latest_snapshot_builder",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.ok) {
        return { data: payload as T, error: null };
      }

      const message = extractErrorMessage(payload, response.status);
      lastError = message;
      if (attempt < UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES && isRetryableStatus(response.status)) {
        await sleep(attempt * 350);
        continue;
      }
      return { data: null, error: { message } };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (attempt < UK_AQ_LATEST_SNAPSHOT_RPC_RETRIES) {
        await sleep(attempt * 350);
        continue;
      }
      return { data: null, error: { message } };
    }
  }

  return { data: null, error: { message: lastError || "RPC request failed" } };
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["message", "error_description", "error"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return `RPC HTTP ${status}`;
}

function looksLikeCursorSignatureMismatch(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("could not find the function") &&
    normalized.includes("uk_aq_latest_rpc");
}

async function callLatestRpc(
  pollutant: string,
  windowLabel: string,
): Promise<RpcResult<RawLatestRow[]>> {
  const cursorBody = {
    region: null,
    pcon_code: null,
    station_like: null,
    connector_id: null,
    pollutant,
    window_label: windowLabel,
    limit_rows: UK_AQ_LATEST_SNAPSHOT_LIMIT,
    since_updated_at: null,
    since_updated_id: null,
  };

  const firstAttempt = await postgrestRpc<RawLatestRow[]>(UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC, cursorBody);
  if (!firstAttempt.error) {
    return firstAttempt;
  }
  if (!looksLikeCursorSignatureMismatch(firstAttempt.error.message)) {
    return firstAttempt;
  }
  return await postgrestRpc<RawLatestRow[]>(UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC, {
    region: null,
    pcon_code: null,
    station_like: null,
    connector_id: null,
    pollutant,
    window_label: windowLabel,
    limit_rows: UK_AQ_LATEST_SNAPSHOT_LIMIT,
    since_ts: null,
  });
}

function toStableJson(value: unknown): string {
  return JSON.stringify(stableSort(value));
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSort(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const output: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      output[key] = stableSort(obj[key]);
    }
    return output;
  }
  return value;
}

function minMaxObservedAt(rows: LatestItem[]): { min: string | null; max: string | null } {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let min: string | null = null;
  let max: string | null = null;
  for (const row of rows) {
    const value = normalizeTimestamp(row.last_value_at);
    if (!value) {
      continue;
    }
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

function matrixId(networkGroup: string, pollutant: string, windowLabel: string): string {
  return `network_group=${networkGroup}|pollutant=${pollutant}|window=${windowLabel}`;
}

function snapshotKey(networkGroup: string, pollutant: string, windowLabel: string): string {
  return `${UK_AQ_LATEST_SNAPSHOT_R2_PREFIX}/network_group=${networkGroup}/pollutant=${pollutant}/window=${windowLabel}.json`;
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
  return status === 408 || status === 429 || status === 500 || status === 502 ||
    status === 503 || status === 504;
}

async function loadExistingManifest(): Promise<SnapshotManifest | null> {
  try {
    const existing = await r2GetObject({ r2: R2_CONFIG, key: UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY });
    const text = new TextDecoder().decode(existing.body);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as SnapshotManifest;
  } catch {
    return null;
  }
}

async function buildSnapshotFor(
  pollutant: string,
  windowLabel: string,
): Promise<{ payload: SnapshotPayload; rows: LatestItem[] }> {
  const rpcResult = await callLatestRpc(toRpcPollutant(pollutant), windowLabel);
  if (rpcResult.error) {
    throw new Error(rpcResult.error.message);
  }
  const rawRows = Array.isArray(rpcResult.data) ? rpcResult.data : [];
  const nextCursor = deriveNextCursor(rawRows, null, null);
  const rows = rawRows
    .filter((row) => passesOutlierThreshold(row))
    .filter((row) => hasAssignedGeoCode(row))
    .map((row) => buildLatestItem(row))
    .sort((a, b) => {
      const aPollutant = a.phenomenon_label ?? a.pollutant_label ?? "";
      const bPollutant = b.phenomenon_label ?? b.pollutant_label ?? "";
      const pollutantCompare = aPollutant.localeCompare(bPollutant);
      if (pollutantCompare !== 0) return pollutantCompare;
      const aStation = a.station_label ?? "";
      const bStation = b.station_label ?? "";
      return aStation.localeCompare(bStation);
    });

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

  return { payload, rows };
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

  const previousManifest = await loadExistingManifest();
  const previousById = new Map<string, SnapshotManifestEntry>();
  for (const entry of previousManifest?.snapshots || []) {
    if (entry && typeof entry.id === "string") {
      previousById.set(entry.id, entry as SnapshotManifestEntry);
    }
  }

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
        const { payload, rows } = await buildSnapshotFor(pollutant, windowLabel);
        const body = `${toStableJson(payload)}\n`;
        const bodyBytes = new TextEncoder().encode(body);
        const hash = sha256Hex(bodyBytes);
        const etag = `"sha256-${hash}"`;
        const changed = previous?.sha256 !== hash || previous?.object_key !== key;

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
          build_duration_ms: Date.now() - itemStarted,
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
      type: "postgrest_rpc",
      supabase_url: SUPABASE_URL,
      rpc: UK_AQ_LATEST_SNAPSHOT_SOURCE_RPC,
      schema: UK_AQ_PUBLIC_SCHEMA,
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

  const manifestBody = new TextEncoder().encode(`${toStableJson(manifest)}\n`);
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
      body: new TextEncoder().encode(`${toStableJson(report)}\n`),
      content_type: "application/json; charset=utf-8",
    });
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
