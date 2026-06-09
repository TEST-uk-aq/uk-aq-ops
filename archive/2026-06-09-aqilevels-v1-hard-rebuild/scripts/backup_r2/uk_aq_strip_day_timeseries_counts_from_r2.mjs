#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { hasRequiredR2Config, r2GetObject, r2PutObject, sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";

const DEFAULT_OBSERVATIONS_PREFIX = "history/v1/observations";

function buildDefaultDropboxLocalBackupRoot() {
  const dropboxRoot = String(process.env.UK_AQ_DROPBOX_ROOT || "").trim() || "CIC-Test";
  return `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/${dropboxRoot}/R2_history_backup`;
}

const DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT = buildDefaultDropboxLocalBackupRoot();

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_strip_day_timeseries_counts_from_r2.mjs [options]",
    "",
    "Purpose:",
    "  Find observations day manifests with top-level timeseries_row_counts",
    "  using local Dropbox backup files, then optionally remove that field in R2.",
    "",
    "Default mode:",
    "  Dry-run report only (no R2 writes).",
    "",
    "Options:",
    "  --root <path>                Local R2 Dropbox backup root (default: auto detect)",
    "  --from-day <YYYY-MM-DD>      Optional inclusive day lower bound",
    "  --to-day <YYYY-MM-DD>        Optional inclusive day upper bound",
    "  --format csv|json            Output format (default: csv)",
    "  --out <path>                 Write output file as well as stdout",
    "  --include-clean              Include day manifests without the field",
    "  --dry-run                    Explicit no-write mode (default)",
    "  --write-r2                   Remove field in matching R2 day manifests",
    "  -h, --help                   Show this help",
    "",
    "Required env for --write-r2:",
    "  CFLARE_R2_ENDPOINT / R2_ENDPOINT",
    "  CFLARE_R2_REGION / R2_REGION",
    "  CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
    "  CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
    "  R2 bucket mapping via CFLARE_R2_BUCKET / R2_BUCKET or R2_BUCKET_DEV/STAGE/PROD",
    "",
    "Optional env:",
    "  UK_AQ_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX (default history/v1/observations)",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    root: "",
    fromDay: "",
    toDay: "",
    format: "csv",
    outPath: "",
    includeClean: false,
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--from-day") {
      args.fromDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--to-day") {
      args.toDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
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
    if (arg === "--include-clean") {
      args.includeClean = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
      continue;
    }
    if (arg === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  if (args.fromDay && !isIsoDay(args.fromDay)) {
    throw new Error("--from-day must be YYYY-MM-DD");
  }
  if (args.toDay && !isIsoDay(args.toDay)) {
    throw new Error("--to-day must be YYYY-MM-DD");
  }
  if (args.fromDay && args.toDay && args.fromDay > args.toDay) {
    throw new Error("--from-day must be <= --to-day");
  }
  if (!new Set(["csv", "json"]).has(args.format)) {
    throw new Error("--format must be csv or json");
  }
  return args;
}

function isIsoDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(ms);
}

function normalizePrefix(rawValue, fallbackValue) {
  const prefix = String(rawValue || fallbackValue || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error("Invalid empty prefix");
  }
  return prefix;
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim(),
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

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { status: "missing_file", bytes: 0, json: null };
  }
  const bytes = fs.statSync(filePath).size;
  if (bytes <= 0) {
    return { status: "zero_bytes", bytes, json: null };
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { status: "ok", bytes, json };
  } catch (_error) {
    return { status: "invalid_json", bytes, json: null };
  }
}

function listObservationDayManifests(observationsDomainPath) {
  const out = [];
  if (!fs.existsSync(observationsDomainPath)) return out;
  const dayDirs = fs.readdirSync(observationsDomainPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name));
  for (const dayDir of dayDirs) {
    const dayUtc = dayDir.name.slice("day_utc=".length);
    out.push({
      day_utc: dayUtc,
      local_manifest_path: path.join(observationsDomainPath, dayDir.name, "manifest.json"),
    });
  }
  out.sort((a, b) => a.day_utc.localeCompare(b.day_utc));
  return out;
}

function matchesDayFilters(dayUtc, args) {
  if (args.fromDay && dayUtc < args.fromDay) return false;
  if (args.toDay && dayUtc > args.toDay) return false;
  return true;
}

function buildCandidates(dayManifests, args) {
  const out = [];
  for (const entry of dayManifests) {
    if (!matchesDayFilters(entry.day_utc, args)) continue;
    const read = safeReadJson(entry.local_manifest_path);
    const hasField = read.status === "ok"
      && read.json
      && typeof read.json === "object"
      && !Array.isArray(read.json)
      && Object.prototype.hasOwnProperty.call(read.json, "timeseries_row_counts");
    if (!args.includeClean && !hasField) continue;
    out.push({
      day_utc: entry.day_utc,
      local_manifest_status: read.status,
      local_manifest_bytes: read.bytes,
      local_has_timeseries_row_counts: hasField,
      local_manifest_path: entry.local_manifest_path,
    });
  }
  return out;
}

function stripDayTimeseriesCounts(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { changed: false, patched: null, oldHash: null, newHash: null };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "timeseries_row_counts")) {
    return { changed: false, patched: payload, oldHash: payload.manifest_hash ?? null, newHash: payload.manifest_hash ?? null };
  }
  const { timeseries_row_counts: _removed, manifest_hash: oldHash, ...withoutCountsAndHash } = payload;
  const newHash = sha256Hex(JSON.stringify(withoutCountsAndHash));
  const patched = { ...withoutCountsAndHash, manifest_hash: newHash };
  return { changed: true, patched, oldHash: oldHash ?? null, newHash };
}

async function applyR2Writes({ candidates, observationsPrefix, r2 }) {
  const writeRows = [];
  let changedCount = 0;
  for (const row of candidates) {
    const manifestKey = `${observationsPrefix}/day_utc=${row.day_utc}/manifest.json`;
    try {
      const object = await r2GetObject({ r2, key: manifestKey });
      const payload = JSON.parse(object.body.toString("utf8"));
      const stripped = stripDayTimeseriesCounts(payload);
      if (!stripped.patched || !stripped.changed) {
        writeRows.push({
          day_utc: row.day_utc,
          r2_manifest_key: manifestKey,
          r2_write_status: "already_clean",
          r2_old_manifest_hash: stripped.oldHash,
          r2_new_manifest_hash: stripped.newHash,
        });
        continue;
      }
      await r2PutObject({
        r2,
        key: manifestKey,
        body: `${JSON.stringify(stripped.patched, null, 2)}\n`,
        content_type: "application/json; charset=utf-8",
      });
      changedCount += 1;
      writeRows.push({
        day_utc: row.day_utc,
        r2_manifest_key: manifestKey,
        r2_write_status: "updated",
        r2_old_manifest_hash: stripped.oldHash,
        r2_new_manifest_hash: stripped.newHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeRows.push({
        day_utc: row.day_utc,
        r2_manifest_key: manifestKey,
        r2_write_status: `error:${message}`,
        r2_old_manifest_hash: null,
        r2_new_manifest_hash: null,
      });
    }
  }
  return { rows: writeRows, changed_count: changedCount };
}

function toCsvValue(value) {
  const text = value == null ? "" : String(value);
  if (!/[,"\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function writeOutput(outPath, text) {
  process.stdout.write(text);
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const writeR2 = args.mode === "write-r2";

  const dropboxRoot = findDropboxRoot(args.root);
  if (!dropboxRoot) {
    throw new Error("No Dropbox root found. Set --root or UK_AQ_R2_HISTORY_DROPBOX_ROOT.");
  }

  const observationsPrefix = normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX,
    DEFAULT_OBSERVATIONS_PREFIX,
  );
  const observationsDomainPath = path.join(dropboxRoot, observationsPrefix);
  const dayManifests = listObservationDayManifests(observationsDomainPath);
  const baseRows = buildCandidates(dayManifests, args);
  const candidateRows = baseRows.filter((row) => row.local_has_timeseries_row_counts === true);

  let writeResult = { rows: [], changed_count: 0 };
  if (writeR2 && candidateRows.length > 0) {
    const config = resolveR2HistoryIndexConfig(process.env);
    if (!hasRequiredR2Config(config.r2)) {
      throw new Error("Missing R2 config for --write-r2 mode.");
    }
    writeResult = await applyR2Writes({
      candidates: candidateRows,
      observationsPrefix,
      r2: config.r2,
    });
  }

  const rowsByDay = new Map();
  for (const row of baseRows) {
    rowsByDay.set(row.day_utc, { ...row });
  }
  for (const row of writeResult.rows) {
    const current = rowsByDay.get(row.day_utc) || { day_utc: row.day_utc };
    rowsByDay.set(row.day_utc, { ...current, ...row });
  }
  const outputRows = Array.from(rowsByDay.values()).sort((a, b) => String(a.day_utc).localeCompare(String(b.day_utc)));

  if (args.format === "json") {
    const payload = {
      ok: true,
      mode: args.mode,
      dry_run: !writeR2,
      write_r2: writeR2,
      dropbox_root: dropboxRoot,
      observations_prefix: observationsPrefix,
      days_scanned: dayManifests.length,
      days_reported: outputRows.length,
      day_manifests_with_counts: candidateRows.length,
      r2_day_manifests_updated: writeResult.changed_count,
      rows: outputRows,
    };
    writeOutput(args.outPath, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const columns = [
    "day_utc",
    "local_manifest_status",
    "local_manifest_bytes",
    "local_has_timeseries_row_counts",
    "r2_write_status",
    "r2_old_manifest_hash",
    "r2_new_manifest_hash",
    "local_manifest_path",
    "r2_manifest_key",
  ];
  writeOutput(args.outPath, toCsv(outputRows, columns));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});

