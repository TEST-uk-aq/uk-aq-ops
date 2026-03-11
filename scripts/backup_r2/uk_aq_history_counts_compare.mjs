#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2ListAllCommonPrefixes,
} from "../../workers/shared/r2_sigv4.mjs";

const OBSERVS_RPC_FINGERPRINT = "uk_aq_rpc_observations_hourly_fingerprint";
const AQI_RPC_DAY_CONNECTOR_COUNTS = "uk_aq_rpc_aqilevels_history_day_connector_counts";
const OBSERVS_DROP_CANDIDATES_RPC = "uk_aq_rpc_observs_drop_candidates";
const AQI_DROP_CANDIDATES_RPC = "uk_aq_rpc_aqilevels_drop_candidates";
const PUBLIC_SCHEMA = "uk_aq_public";
const DAY_PREFIX_RE = /day_utc=(\d{4}-\d{2}-\d{2})\/?$/;

const DEFAULT_OBSERVS_RETENTION_DAYS = 21;
const DEFAULT_AQI_RETENTION_DAYS = 14;
const DEFAULT_MAX_DAYS = 400;
const DEFAULT_OBSERVATIONS_PREFIX = "history/v1/observations";
const DEFAULT_AQILEVELS_PREFIX = "history/v1/aqilevels";
const DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT =
  "/Users/mikehinford/Library/CloudStorage/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_history_counts_compare.mjs [options]",
    "",
    "Options:",
    "  --format json|csv           Output format (default: csv)",
    "  --out <path>                Write output to file as well as stdout",
    "  --dropbox-root <path>       Local Dropbox backup root (default: auto detect)",
    "  --scope outside-retention|all-complete",
    "                             Day filter mode (default: outside-retention)",
    "  --max-days <n>              Max outside-retention days per domain (default: 400)",
    "  --today <YYYY-MM-DD>        Override UTC today for deterministic runs",
    "  --only-mismatch             Emit only rows with at least one mismatch",
    "  -h, --help                  Show this help",
    "",
    "Required env for DB checks:",
    "  SUPABASE_URL, SB_SECRET_KEY",
    "  OBS_AQIDB_SUPABASE_URL, OBS_AQIDB_SECRET_KEY",
    "",
    "Required env for live R2 checks:",
    "  CFLARE_R2_ENDPOINT, CFLARE_R2_BUCKET, CFLARE_R2_REGION,",
    "  CFLARE_R2_ACCESS_KEY_ID, CFLARE_R2_SECRET_ACCESS_KEY",
    "",
    "Retention env (optional):",
    "  OBS_AQIDB_OBSERVS_RETENTION_DAYS (default 21)",
    "  OBS_AQIDB_AQILEVELS_RETENTION_DAYS (default 14)",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    format: "csv",
    outPath: "",
    dropboxRoot: "",
    scope: "outside-retention",
    maxDays: DEFAULT_MAX_DAYS,
    today: "",
    onlyMismatch: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      args.format = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.outPath = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dropbox-root") {
      args.dropboxRoot = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scope") {
      args.scope = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--max-days") {
      args.maxDays = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--today") {
      args.today = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--only-mismatch") {
      args.onlyMismatch = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!new Set(["csv", "json"]).has(args.format)) {
    throw new Error("--format must be csv or json");
  }
  if (!new Set(["outside-retention", "all-complete"]).has(args.scope)) {
    throw new Error("--scope must be outside-retention or all-complete");
  }
  if (!Number.isFinite(args.maxDays) || args.maxDays < 1) {
    throw new Error("--max-days must be a positive integer");
  }
  if (args.today && !isIsoDay(args.today)) {
    throw new Error("--today must be YYYY-MM-DD");
  }
  return args;
}

function isIsoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function toUtcDay(dateValue) {
  return new Date(dateValue).toISOString().slice(0, 10);
}

function addUtcDays(isoDay, deltaDays) {
  const baseMs = Date.parse(`${isoDay}T00:00:00.000Z`);
  return toUtcDay(baseMs + (deltaDays * 24 * 60 * 60 * 1000));
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.trunc(n);
}

function parseJsonOrThrow(text, context) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_error) {
    throw new Error(`Invalid JSON from ${context}`);
  }
}

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function buildR2Config(env) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || "").trim(),
    bucket: String(env.CFLARE_R2_BUCKET || "").trim(),
    region: String(env.CFLARE_R2_REGION || "").trim(),
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT || "").trim(),
    DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return "";
}

function postgrestHeaders(apiKey) {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Accept-Profile": PUBLIC_SCHEMA,
    "Content-Profile": PUBLIC_SCHEMA,
  };
}

async function postgrestRpc({ baseUrl, apiKey, rpcName, body }) {
  if (!baseUrl || !apiKey) {
    throw new Error(`Missing base URL or API key for RPC ${rpcName}`);
  }
  const endpoint = `${normalizeBaseUrl(baseUrl)}/rest/v1/rpc/${rpcName}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: postgrestHeaders(apiKey),
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const payload = parseJsonOrThrow(text, `${rpcName} response`);
  if (!response.ok) {
    const message = payload?.message || payload?.error || text || response.statusText;
    throw new Error(`${rpcName} failed (${response.status}): ${String(message)}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(`${rpcName} returned non-array payload`);
  }
  return payload;
}

function parseDayFromPrefix(prefixValue) {
  const match = String(prefixValue || "").match(DAY_PREFIX_RE);
  if (!match) {
    return null;
  }
  const day = match[1];
  return isIsoDay(day) ? day : null;
}

async function listR2Days({ r2, domainPrefix }) {
  const out = new Set();
  const prefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${domainPrefix}/`,
    delimiter: "/",
  });
  for (const pref of prefixes) {
    const day = parseDayFromPrefix(pref);
    if (day) {
      out.add(day);
    }
  }
  return out;
}

function listDropboxDays({ dropboxRoot, domainPrefix }) {
  const out = new Set();
  if (!dropboxRoot) {
    return out;
  }
  const domainPath = path.join(dropboxRoot, domainPrefix);
  if (!fs.existsSync(domainPath)) {
    return out;
  }
  const entries = fs.readdirSync(domainPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const day = parseDayFromPrefix(entry.name);
    if (day) {
      out.add(day);
    }
  }
  return out;
}

function extractCountsFromManifest(manifest) {
  const counts = new Map();
  const connectorManifestEntries = Array.isArray(manifest?.connector_manifests)
    ? manifest.connector_manifests
    : [];
  if (connectorManifestEntries.length) {
    for (const entry of connectorManifestEntries) {
      const connectorId = Number(entry?.connector_id);
      const rowCount = Number(entry?.source_row_count);
      if (!Number.isFinite(connectorId) || connectorId <= 0) {
        continue;
      }
      if (!Number.isFinite(rowCount) || rowCount < 0) {
        continue;
      }
      counts.set(String(Math.trunc(connectorId)), Math.trunc(rowCount));
    }
    return counts;
  }

  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  for (const fileEntry of files) {
    const connectorId = Number(fileEntry?.connector_id);
    const rowCount = Number(fileEntry?.row_count);
    if (!Number.isFinite(connectorId) || connectorId <= 0) {
      continue;
    }
    if (!Number.isFinite(rowCount) || rowCount < 0) {
      continue;
    }
    const key = String(Math.trunc(connectorId));
    counts.set(key, (counts.get(key) || 0) + Math.trunc(rowCount));
  }
  return counts;
}

async function readR2DayCounts({ r2, domainPrefix, dayUtc }) {
  const key = `${domainPrefix}/day_utc=${dayUtc}/manifest.json`;
  try {
    const object = await r2GetObject({ r2, key });
    const manifest = parseJsonOrThrow(object.body.toString("utf8"), `R2 manifest ${key}`);
    return extractCountsFromManifest(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("(404)")) {
      return new Map();
    }
    throw error;
  }
}

function readDropboxDayCounts({ dropboxRoot, domainPrefix, dayUtc }) {
  const manifestPath = path.join(
    dropboxRoot,
    domainPrefix,
    `day_utc=${dayUtc}`,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return new Map();
  }
  const text = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseJsonOrThrow(text, `Dropbox manifest ${manifestPath}`);
  return extractCountsFromManifest(manifest);
}

function aggregateObservationCountsByConnector(rows) {
  const counts = new Map();
  for (const row of rows) {
    const connectorId = Number(row?.connector_id);
    const observationCount = Number(row?.observation_count);
    if (!Number.isFinite(connectorId) || connectorId <= 0) {
      continue;
    }
    if (!Number.isFinite(observationCount) || observationCount < 0) {
      continue;
    }
    const key = String(Math.trunc(connectorId));
    counts.set(key, (counts.get(key) || 0) + Math.trunc(observationCount));
  }
  return counts;
}

async function fetchObservsDayCounts({ baseUrl, apiKey, dayUtc }) {
  const nextDay = addUtcDays(dayUtc, 1);
  const rows = await postgrestRpc({
    baseUrl,
    apiKey,
    rpcName: OBSERVS_RPC_FINGERPRINT,
    body: {
      window_start: `${dayUtc}T00:00:00Z`,
      window_end: `${nextDay}T00:00:00Z`,
    },
  });
  return aggregateObservationCountsByConnector(rows);
}

async function fetchAqiDayCounts({ baseUrl, apiKey, dayUtc }) {
  const rows = await postgrestRpc({
    baseUrl,
    apiKey,
    rpcName: AQI_RPC_DAY_CONNECTOR_COUNTS,
    body: {
      p_day_utc: dayUtc,
      p_connector_ids: null,
    },
  });
  const counts = new Map();
  for (const row of rows) {
    const connectorId = Number(row?.connector_id);
    const rowCount = Number(row?.row_count);
    if (!Number.isFinite(connectorId) || connectorId <= 0) {
      continue;
    }
    if (!Number.isFinite(rowCount) || rowCount < 0) {
      continue;
    }
    counts.set(String(Math.trunc(connectorId)), Math.trunc(rowCount));
  }
  return counts;
}

async function fetchObsAqiDbDaySetObservs({ baseUrl, apiKey }) {
  const rows = await postgrestRpc({
    baseUrl,
    apiKey,
    rpcName: OBSERVS_DROP_CANDIDATES_RPC,
    body: {
      cutoff_utc: "2100-01-01T00:00:00Z",
    },
  });
  const days = new Set();
  for (const row of rows) {
    const day = String(row?.partition_day_utc || "").slice(0, 10);
    if (isIsoDay(day)) {
      days.add(day);
    }
  }
  return days;
}

async function fetchObsAqiDbDaySetAqi({ baseUrl, apiKey }) {
  const rows = await postgrestRpc({
    baseUrl,
    apiKey,
    rpcName: AQI_DROP_CANDIDATES_RPC,
    body: {
      p_cutoff_day_utc: "2100-01-01",
    },
  });
  const days = new Set();
  for (const row of rows) {
    const day = String(row?.day_utc || "").slice(0, 10);
    const hourlyRows = Number(row?.hourly_rows ?? row?.row_count ?? 0);
    if (isIsoDay(day) && Number.isFinite(hourlyRows) && hourlyRows > 0) {
      days.add(day);
    }
  }
  return days;
}

function setUnion(...sets) {
  const out = new Set();
  for (const setValue of sets) {
    for (const value of setValue || []) {
      out.add(value);
    }
  }
  return out;
}

function filteredOutsideRetentionDays({
  daySet,
  cutoffDayUtc,
  todayDayUtc,
  scope,
  maxDays,
}) {
  const days = Array.from(daySet || [])
    .filter((day) => isIsoDay(day))
    .filter((day) => (
      scope === "outside-retention"
        ? day < cutoffDayUtc
        : day < todayDayUtc
    ))
    .filter((day) => day < todayDayUtc)
    .sort((a, b) => a.localeCompare(b));
  if (days.length <= maxDays) {
    return days;
  }
  return days.slice(days.length - maxDays);
}

function mapGetOrNull(mapValue, key) {
  if (!mapValue || !mapValue.has(key)) {
    return null;
  }
  return mapValue.get(key);
}

function diffOrNull(left, right) {
  if (left === null || right === null) {
    return null;
  }
  return left - right;
}

function buildStatus(row) {
  const flags = [];
  if (row.diff_ingestdb_obs_aqidb !== null && row.diff_ingestdb_obs_aqidb !== 0) {
    flags.push("ingest_vs_obs_aqidb");
  }
  if (row.diff_obs_aqidb_r2 !== null && row.diff_obs_aqidb_r2 !== 0) {
    flags.push("obs_aqidb_vs_r2");
  }
  if (row.diff_r2_dropbox !== null && row.diff_r2_dropbox !== 0) {
    flags.push("r2_vs_dropbox");
  }
  return flags.length ? flags.join("|") : "ok";
}

function toCsv(rows) {
  const columns = [
    "domain",
    "day_utc",
    "connector_id",
    "ingestdb_row_count",
    "obs_aqidb_row_count",
    "r2_history_row_count",
    "dropbox_backup_row_count",
    "diff_ingestdb_obs_aqidb",
    "diff_obs_aqidb_r2",
    "diff_r2_dropbox",
    "status",
  ];
  const escapeCell = (value) => {
    if (value === null || value === undefined) {
      return "";
    }
    const text = String(value);
    if (!/[",\n]/.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, "\"\"")}"`;
  };
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const todayDayUtc = args.today || toUtcDay(new Date());
  const observsRetentionDays = parsePositiveInt(
    process.env.OBS_AQIDB_OBSERVS_RETENTION_DAYS,
    DEFAULT_OBSERVS_RETENTION_DAYS,
  );
  const aqiRetentionDays = parsePositiveInt(
    process.env.OBS_AQIDB_AQILEVELS_RETENTION_DAYS,
    DEFAULT_AQI_RETENTION_DAYS,
  );
  const observsCutoffDayUtc = addUtcDays(todayDayUtc, -observsRetentionDays);
  const aqiCutoffDayUtc = addUtcDays(todayDayUtc, -aqiRetentionDays);

  const ingestBaseUrl = normalizeBaseUrl(process.env.SUPABASE_URL || "");
  const ingestApiKey = String(process.env.SB_SECRET_KEY || "").trim();
  const obsAqiBaseUrl = normalizeBaseUrl(process.env.OBS_AQIDB_SUPABASE_URL || "");
  const obsAqiApiKey = String(process.env.OBS_AQIDB_SECRET_KEY || "").trim();
  const observationsPrefix = normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_OBSERVATIONS_PREFIX,
  );
  const aqilevelsPrefix = normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_AQILEVELS_PREFIX,
  );
  const dropboxRoot = findDropboxRoot(args.dropboxRoot);
  const r2 = buildR2Config(process.env);
  const canUseR2 = hasRequiredR2Config(r2);

  if (!ingestBaseUrl || !ingestApiKey) {
    throw new Error("Missing SUPABASE_URL or SB_SECRET_KEY for ingestdb checks.");
  }
  if (!obsAqiBaseUrl || !obsAqiApiKey) {
    throw new Error("Missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY for obs_aqidb checks.");
  }

  const sourceInfo = {
    ingestdb: true,
    obs_aqidb: true,
    r2_history: canUseR2,
    dropbox_backup: Boolean(dropboxRoot),
  };

  const [obsDbObservsDays, obsDbAqiDays] = await Promise.all([
    fetchObsAqiDbDaySetObservs({ baseUrl: obsAqiBaseUrl, apiKey: obsAqiApiKey }),
    fetchObsAqiDbDaySetAqi({ baseUrl: obsAqiBaseUrl, apiKey: obsAqiApiKey }),
  ]);

  const [r2ObservsDays, r2AqiDays] = canUseR2
    ? await Promise.all([
      listR2Days({ r2, domainPrefix: observationsPrefix }),
      listR2Days({ r2, domainPrefix: aqilevelsPrefix }),
    ])
    : [new Set(), new Set()];

  const dropboxObservsDays = listDropboxDays({ dropboxRoot, domainPrefix: observationsPrefix });
  const dropboxAqiDays = listDropboxDays({ dropboxRoot, domainPrefix: aqilevelsPrefix });

  const observsDays = filteredOutsideRetentionDays({
    daySet: setUnion(obsDbObservsDays, r2ObservsDays, dropboxObservsDays),
    cutoffDayUtc: observsCutoffDayUtc,
    todayDayUtc,
    scope: args.scope,
    maxDays: args.maxDays,
  });
  const aqiDays = filteredOutsideRetentionDays({
    daySet: setUnion(obsDbAqiDays, r2AqiDays, dropboxAqiDays),
    cutoffDayUtc: aqiCutoffDayUtc,
    todayDayUtc,
    scope: args.scope,
    maxDays: args.maxDays,
  });

  const rows = [];

  for (const dayUtc of observsDays) {
    const [ingestCounts, obsCounts, r2Counts, dropboxCounts] = await Promise.all([
      fetchObservsDayCounts({ baseUrl: ingestBaseUrl, apiKey: ingestApiKey, dayUtc }),
      fetchObservsDayCounts({ baseUrl: obsAqiBaseUrl, apiKey: obsAqiApiKey, dayUtc }),
      canUseR2 ? readR2DayCounts({ r2, domainPrefix: observationsPrefix, dayUtc }) : new Map(),
      dropboxRoot ? readDropboxDayCounts({ dropboxRoot, domainPrefix: observationsPrefix, dayUtc }) : new Map(),
    ]);

    const connectorIds = Array.from(setUnion(
      new Set(ingestCounts.keys()),
      new Set(obsCounts.keys()),
      new Set(r2Counts.keys()),
      new Set(dropboxCounts.keys()),
    )).sort((a, b) => Number(a) - Number(b));

    for (const connectorId of connectorIds) {
      const row = {
        domain: "observs",
        day_utc: dayUtc,
        connector_id: connectorId,
        ingestdb_row_count: mapGetOrNull(ingestCounts, connectorId),
        obs_aqidb_row_count: mapGetOrNull(obsCounts, connectorId),
        r2_history_row_count: mapGetOrNull(r2Counts, connectorId),
        dropbox_backup_row_count: mapGetOrNull(dropboxCounts, connectorId),
      };
      row.diff_ingestdb_obs_aqidb = diffOrNull(row.ingestdb_row_count, row.obs_aqidb_row_count);
      row.diff_obs_aqidb_r2 = diffOrNull(row.obs_aqidb_row_count, row.r2_history_row_count);
      row.diff_r2_dropbox = diffOrNull(row.r2_history_row_count, row.dropbox_backup_row_count);
      row.status = buildStatus(row);
      rows.push(row);
    }
  }

  for (const dayUtc of aqiDays) {
    const [obsCounts, r2Counts, dropboxCounts] = await Promise.all([
      fetchAqiDayCounts({ baseUrl: obsAqiBaseUrl, apiKey: obsAqiApiKey, dayUtc }),
      canUseR2 ? readR2DayCounts({ r2, domainPrefix: aqilevelsPrefix, dayUtc }) : new Map(),
      dropboxRoot ? readDropboxDayCounts({ dropboxRoot, domainPrefix: aqilevelsPrefix, dayUtc }) : new Map(),
    ]);

    const connectorIds = Array.from(setUnion(
      new Set(obsCounts.keys()),
      new Set(r2Counts.keys()),
      new Set(dropboxCounts.keys()),
    )).sort((a, b) => Number(a) - Number(b));

    for (const connectorId of connectorIds) {
      const row = {
        domain: "aqilevels",
        day_utc: dayUtc,
        connector_id: connectorId,
        ingestdb_row_count: null,
        obs_aqidb_row_count: mapGetOrNull(obsCounts, connectorId),
        r2_history_row_count: mapGetOrNull(r2Counts, connectorId),
        dropbox_backup_row_count: mapGetOrNull(dropboxCounts, connectorId),
      };
      row.diff_ingestdb_obs_aqidb = null;
      row.diff_obs_aqidb_r2 = diffOrNull(row.obs_aqidb_row_count, row.r2_history_row_count);
      row.diff_r2_dropbox = diffOrNull(row.r2_history_row_count, row.dropbox_backup_row_count);
      row.status = buildStatus(row);
      rows.push(row);
    }
  }

  rows.sort((left, right) => {
    if (left.domain !== right.domain) {
      return left.domain.localeCompare(right.domain);
    }
    if (left.day_utc !== right.day_utc) {
      return left.day_utc.localeCompare(right.day_utc);
    }
    return Number(left.connector_id) - Number(right.connector_id);
  });

  const outputRows = args.onlyMismatch
    ? rows.filter((row) => row.status !== "ok")
    : rows;

  const summary = {
    generated_at_utc: new Date().toISOString(),
    today_utc_day: todayDayUtc,
    scope: args.scope,
    observs_retention_days: observsRetentionDays,
    aqilevels_retention_days: aqiRetentionDays,
    observs_outside_cutoff_day_utc: observsCutoffDayUtc,
    aqilevels_outside_cutoff_day_utc: aqiCutoffDayUtc,
    source_info: sourceInfo,
    day_counts: {
      observs_days_compared: observsDays.length,
      aqilevels_days_compared: aqiDays.length,
    },
    row_counts: {
      total_rows: rows.length,
      output_rows: outputRows.length,
      mismatched_rows: rows.filter((row) => row.status !== "ok").length,
    },
  };

  const output = args.format === "json"
    ? `${JSON.stringify({ summary, rows: outputRows }, null, 2)}\n`
    : toCsv(outputRows);

  if (args.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(args.outPath), output, "utf8");
  }

  if (args.format === "json") {
    process.stdout.write(output);
  } else {
    process.stdout.write(`# ${JSON.stringify(summary)}\n`);
    process.stdout.write(output);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
