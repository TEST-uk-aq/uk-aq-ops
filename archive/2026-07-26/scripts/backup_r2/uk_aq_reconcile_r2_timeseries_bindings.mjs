#!/usr/bin/env node
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2ListAllCommonPrefixes,
} from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryVersion } from "../../workers/shared/uk_aq_r2_history_version.mjs";
import {
  DEFAULT_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX,
  reconcileR2HistoryV2TimeseriesBindings,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  buildAuthoritativeTimeseriesBindingsFromCoreSnapshotRows,
} from "./uk_aq_core_snapshot_to_r2.mjs";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs [options]",
    "",
    "Reads one committed v2 core snapshot and reconciles stable timeseries bindings.",
    "Defaults to --dry-run. Stale bindings are reported and never deleted.",
    "",
    "Options:",
    "  --day-utc YYYY-MM-DD  Use this core snapshot day (default: newest available).",
    "  --core-prefix PREFIX  Default: UK_AQ_R2_HISTORY_V2_CORE_PREFIX or history/v2/core.",
    "  --binding-prefix PREFIX",
    "                         Default: UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX",
    "                                  or history/_index_v2/timeseries_binding.",
    "  --dry-run             Plan only (default).",
    "  --write-r2            Write new/changed binding objects after explicit selection.",
    "  -h, --help",
  ].join("\n"));
}

function parseDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new Error(`Invalid --day-utc: ${value}`);
  }
  return day;
}

function parseArgs(argv) {
  const args = { dayUtc: null, corePrefix: "", bindingPrefix: "", writeR2: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--dry-run") continue;
    if (arg === "--write-r2") { args.writeR2 = true; continue; }
    if (["--day-utc", "--core-prefix", "--binding-prefix"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      if (arg === "--day-utc") args.dayUtc = parseDay(value);
      if (arg === "--core-prefix") args.corePrefix = normalizePrefix(value);
      if (arg === "--binding-prefix") args.bindingPrefix = normalizePrefix(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function r2ConfigFromEnv(env = process.env) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
    bucket: String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim(),
    region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function parseNdjsonGz(buffer, key) {
  try {
    return zlib.gunzipSync(buffer).toString("utf8").split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`Invalid core snapshot table ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function newestCoreDay(r2, corePrefix) {
  const prefixes = await r2ListAllCommonPrefixes({ r2, prefix: `${corePrefix}/`, delimiter: "/" });
  const days = prefixes.map((entry) => String(entry || "").match(/day_utc=(\d{4}-\d{2}-\d{2})\/$/)?.[1])
    .filter(Boolean).sort((left, right) => right.localeCompare(left));
  if (!days.length) throw new Error(`No core snapshot days found under ${corePrefix}`);
  return days[0];
}

async function readCoreTable(r2, manifest, table) {
  const entry = Array.isArray(manifest?.tables) ? manifest.tables.find((candidate) => candidate?.table === table) : null;
  if (!entry?.key) throw new Error(`Core snapshot manifest is missing table=${table}`);
  const object = await r2GetObject({ r2, key: entry.key });
  return parseNdjsonGz(object.body, entry.key);
}

export async function reconcileCoreSnapshotTimeseriesBindings({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  if (resolveR2HistoryVersion(env, { context: "R2 timeseries binding reconciliation" }) !== "v2") {
    throw new Error("R2 timeseries binding reconciliation requires UK_AQ_R2_HISTORY_VERSION=v2");
  }
  const r2 = r2ConfigFromEnv(env);
  if (!hasRequiredR2Config(r2)) throw new Error("Missing required R2 configuration");
  const corePrefix = args.corePrefix || normalizePrefix(env.UK_AQ_R2_HISTORY_V2_CORE_PREFIX || "history/v2/core");
  const dayUtc = args.dayUtc || await newestCoreDay(r2, corePrefix);
  const manifestKey = `${corePrefix}/day_utc=${dayUtc}/manifest.json`;
  const manifestObject = await r2GetObject({ r2, key: manifestKey });
  let manifest;
  try { manifest = JSON.parse(manifestObject.body.toString("utf8")); } catch { throw new Error(`Invalid core snapshot manifest JSON: ${manifestKey}`); }
  if (manifest?.schema_name !== "uk_aq_core_snapshot" || manifest?.day_utc !== dayUtc) {
    throw new Error(`Invalid core snapshot manifest contract: ${manifestKey}`);
  }
  const [timeseriesRows, phenomenaRows, observedPropertiesRows] = await Promise.all([
    readCoreTable(r2, manifest, "timeseries"),
    readCoreTable(r2, manifest, "phenomena"),
    readCoreTable(r2, manifest, "observed_properties"),
  ]);
  const summary = await reconcileR2HistoryV2TimeseriesBindings({
    r2,
    bucketName: r2.bucket,
    timeseriesBindingIndexPrefix: args.bindingPrefix || normalizePrefix(
      env.UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX
        || DEFAULT_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX,
    ),
    authoritativeTimeseries: buildAuthoritativeTimeseriesBindingsFromCoreSnapshotRows({
      timeseriesRows,
      phenomenaRows,
      observedPropertiesRows,
    }),
    writeR2: args.writeR2,
  });
  return { ...summary, core_snapshot_day_utc: dayUtc, core_snapshot_manifest_key: manifestKey };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await reconcileCoreSnapshotTimeseriesBindings();
    if (result.help) usage(); else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
