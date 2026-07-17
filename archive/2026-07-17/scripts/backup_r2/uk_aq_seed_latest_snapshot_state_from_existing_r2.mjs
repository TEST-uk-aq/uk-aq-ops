#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_SNAPSHOT_MANIFEST_KEY = normalizePrefix(
  process.env.UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY || "latest_snapshots/v1/manifest.json",
);
const DEFAULT_STATE_PREFIX = normalizePrefix(
  process.env.UK_AQ_LATEST_SNAPSHOT_STATE_PREFIX || "latest_snapshots_state/v1",
);
const DEFAULT_STATE_KEY = `${DEFAULT_STATE_PREFIX}/latest_state.json`;
const DEFAULT_CORE_PREFIX = normalizePrefix(
  process.env.UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX ||
    process.env.UK_AQ_R2_HISTORY_CORE_PREFIX ||
    "history/v1/core",
);
const DEFAULT_LOOKBACK_DAYS = 14;

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs [options]",
      "",
      "Required env:",
      "  CFLARE_R2_ENDPOINT (or R2_ENDPOINT)",
      "  CFLARE_R2_BUCKET (or R2_BUCKET)",
      "  CFLARE_R2_ACCESS_KEY_ID (or R2_ACCESS_KEY_ID)",
      "  CFLARE_R2_SECRET_ACCESS_KEY (or R2_SECRET_ACCESS_KEY)",
      "",
      "Options:",
      `  --snapshot-manifest-key <key>   Default: ${DEFAULT_SNAPSHOT_MANIFEST_KEY}`,
      `  --state-key <key>               Default: ${DEFAULT_STATE_KEY}`,
      `  --core-prefix <prefix>          Default: ${DEFAULT_CORE_PREFIX}`,
      "  --lookback-days <N>             Default: 14",
      "  --write-r2                      Write state object to R2 (default: dry-run)",
      "  --report-out <path>             Write JSON report to file",
      "  -h, --help",
      "",
      "Notes:",
      "  - Seeds latest state from existing latest snapshot R2 objects.",
      "  - This is intended as a one-off bootstrap after source migration.",
      "  - If run again, it will deterministically rebuild state from snapshot objects.",
    ].join("\n"),
  );
}

function parsePositiveInt(raw, fallback, min = 1, max = 3650) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function normalizeDay(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function shiftIsoDay(isoDay, dayOffset) {
  const base = new Date(`${isoDay}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return isoDay;
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function loadJson(bytes, keyLabel) {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON for key: ${keyLabel}`);
  }
}

function decodeCoreTableText(body, tableKey) {
  const decoder = new TextDecoder();
  if (tableKey.endsWith(".gz")) {
    const uncompressed = zlib.gunzipSync(body);
    return decoder.decode(uncompressed);
  }
  return decoder.decode(body);
}

function parseNdjsonRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {
      // ignore bad line
    }
  }
  return rows;
}

function parseArgs(argv) {
  const args = {
    snapshot_manifest_key: DEFAULT_SNAPSHOT_MANIFEST_KEY,
    state_key: DEFAULT_STATE_KEY,
    core_prefix: DEFAULT_CORE_PREFIX,
    lookback_days: DEFAULT_LOOKBACK_DAYS,
    write_r2: false,
    report_out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot-manifest-key") {
      args.snapshot_manifest_key = normalizePrefix(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--state-key") {
      args.state_key = normalizePrefix(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--core-prefix") {
      args.core_prefix = normalizePrefix(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--lookback-days") {
      args.lookback_days = parsePositiveInt(argv[i + 1], DEFAULT_LOOKBACK_DAYS);
      i += 1;
      continue;
    }
    if (arg === "--write-r2") {
      args.write_r2 = true;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.snapshot_manifest_key) throw new Error("--snapshot-manifest-key resolved empty");
  if (!args.state_key) throw new Error("--state-key resolved empty");
  if (!args.core_prefix) throw new Error("--core-prefix resolved empty");
  return args;
}

function buildR2Config() {
  return {
    endpoint: String(process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    bucket: String(process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
    region: String(process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(
      process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "",
    ).trim(),
  };
}

async function findLatestCoreManifestKey(r2, corePrefix, lookbackDays) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  for (let offset = 0; offset <= lookbackDays; offset += 1) {
    const dayUtc = shiftIsoDay(todayUtc, -offset);
    const key = `${corePrefix}/day_utc=${dayUtc}/manifest.json`;
    const head = await r2HeadObject({ r2, key });
    if (head.exists) {
      return { day_utc: dayUtc, key };
    }
  }
  return null;
}

function getManifestTableKey(manifest, tableName) {
  const rows = Array.isArray(manifest?.tables) ? manifest.tables : [];
  const needle = String(tableName || "").trim().toLowerCase();
  for (const row of rows) {
    const table = String(row?.table || "").trim().toLowerCase();
    if (table !== needle) continue;
    const key = String(row?.key || "").trim();
    if (key) return key;
  }
  return null;
}

function buildTimeseriesConnectorMap(rows) {
  const out = new Map();
  for (const row of rows) {
    const timeseriesId = Number(row?.id);
    const connectorId = Number(row?.connector_id);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) continue;
    if (!Number.isInteger(connectorId) || connectorId <= 0) continue;
    out.set(Math.trunc(timeseriesId), Math.trunc(connectorId));
  }
  return out;
}

function applyCandidate(stateByKey, candidate) {
  const key = `${candidate.connector_id}:${candidate.timeseries_id}`;
  const existing = stateByKey.get(key);
  if (!existing) {
    stateByKey.set(key, candidate);
    return { status: "new" };
  }
  const existingMs = Date.parse(existing.observed_at);
  const nextMs = Date.parse(candidate.observed_at);
  if (nextMs > existingMs) {
    stateByKey.set(key, candidate);
    return { status: "updated_newer" };
  }
  if (nextMs === existingMs) {
    return { status: "duplicate" };
  }
  return { status: "older_skipped" };
}

function sortStateEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
    return a.timeseries_id - b.timeseries_id;
  });
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) return;
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const r2 = buildR2Config();
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing required R2 config (CFLARE_R2_*/R2_*).");
  }

  const report = {
    ok: false,
    write_r2: args.write_r2,
    bucket: r2.bucket,
    snapshot_manifest_key: args.snapshot_manifest_key,
    state_key: args.state_key,
    core_prefix: args.core_prefix,
    core_manifest_key: null,
    core_day_utc: null,
    snapshot_objects_read: 0,
    snapshot_rows_scanned: 0,
    rows_missing_timeseries_id: 0,
    rows_missing_timestamp: 0,
    rows_missing_core_mapping: 0,
    rows_invalid_value: 0,
    candidates_applied_new: 0,
    candidates_applied_updated_newer: 0,
    candidates_skipped_duplicate: 0,
    candidates_skipped_older: 0,
    seeded_entry_count: 0,
    state_bytes: 0,
    state_written: false,
    generated_at: new Date().toISOString(),
    warnings: [],
  };

  const snapshotManifestObject = await r2GetObject({
    r2,
    key: args.snapshot_manifest_key,
  });
  const snapshotManifest = loadJson(snapshotManifestObject.body, args.snapshot_manifest_key);
  const snapshotEntries = Array.isArray(snapshotManifest?.snapshots) ? snapshotManifest.snapshots : [];
  if (!snapshotEntries.length) {
    throw new Error(`No snapshots found in manifest ${args.snapshot_manifest_key}`);
  }

  const latestCore = await findLatestCoreManifestKey(r2, args.core_prefix, args.lookback_days);
  if (!latestCore) {
    throw new Error(`No core manifest found under ${args.core_prefix} within ${args.lookback_days} days.`);
  }
  report.core_manifest_key = latestCore.key;
  report.core_day_utc = normalizeDay(latestCore.day_utc);

  const coreManifestObject = await r2GetObject({ r2, key: latestCore.key });
  const coreManifest = loadJson(coreManifestObject.body, latestCore.key);
  const timeseriesKey = getManifestTableKey(coreManifest, "timeseries");
  if (!timeseriesKey) {
    throw new Error(`Core manifest missing timeseries table key: ${latestCore.key}`);
  }
  const timeseriesObject = await r2GetObject({ r2, key: timeseriesKey });
  const timeseriesRows = parseNdjsonRows(decodeCoreTableText(timeseriesObject.body, timeseriesKey));
  const connectorByTimeseriesId = buildTimeseriesConnectorMap(timeseriesRows);
  if (connectorByTimeseriesId.size === 0) {
    throw new Error("Core timeseries mapping is empty.");
  }

  const stateByKey = new Map();

  for (const manifestEntry of snapshotEntries) {
    const objectKey = String(manifestEntry?.object_key || "").trim();
    if (!objectKey) continue;
    const snapshotObject = await r2GetObject({ r2, key: objectKey });
    report.snapshot_objects_read += 1;
    const snapshotPayload = loadJson(snapshotObject.body, objectKey);
    const rows = Array.isArray(snapshotPayload?.data) ? snapshotPayload.data : [];
    for (const row of rows) {
      report.snapshot_rows_scanned += 1;
      const timeseriesId = Number(row?.id);
      if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
        report.rows_missing_timeseries_id += 1;
        continue;
      }
      const observedAt = normalizeTimestamp(row?.last_value_at);
      if (!observedAt) {
        report.rows_missing_timestamp += 1;
        continue;
      }
      const connectorId = connectorByTimeseriesId.get(Math.trunc(timeseriesId));
      if (!connectorId) {
        report.rows_missing_core_mapping += 1;
        continue;
      }
      const valueRaw = row?.last_value;
      const value = valueRaw === null || valueRaw === undefined ? null : Number(valueRaw);
      if (value !== null && !Number.isFinite(value)) {
        report.rows_invalid_value += 1;
        continue;
      }
      const candidate = {
        connector_id: connectorId,
        timeseries_id: Math.trunc(timeseriesId),
        observed_at: observedAt,
        value,
        value_float8_hex: null,
        status: null,
        ingested_at: report.generated_at,
      };
      const applied = applyCandidate(stateByKey, candidate).status;
      if (applied === "new") report.candidates_applied_new += 1;
      else if (applied === "updated_newer") report.candidates_applied_updated_newer += 1;
      else if (applied === "duplicate") report.candidates_skipped_duplicate += 1;
      else report.candidates_skipped_older += 1;
    }
  }

  const seededEntries = sortStateEntries(stateByKey.values());
  report.seeded_entry_count = seededEntries.length;

  const statePayload = {
    schema_version: 1,
    updated_at: report.generated_at,
    entries: seededEntries,
  };
  const stateBody = new TextEncoder().encode(`${JSON.stringify(statePayload)}\n`);
  report.state_bytes = stateBody.byteLength;

  if (args.write_r2) {
    await r2PutObject({
      r2,
      key: args.state_key,
      body: stateBody,
      content_type: "application/json; charset=utf-8",
    });
    report.state_written = true;
  }

  report.ok = true;
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
