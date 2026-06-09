#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_cleanup_sos_empty_mirror_files.mjs [options]",
    "",
    "Options:",
    "  --apply                 Write/update _no_data_timeseries.json and delete old empty files",
    "  --root <path>           SOS mirror root (default: UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT)",
    "  --day <YYYY-MM-DD>      Restrict cleanup to one UTC day directory",
    "  --verbose               Print each migrated file path",
    "  -h, --help              Show this help",
    "",
    "Notes:",
    "  - Dry-run is the default; use --apply to make changes.",
    "  - Only exact empty SOS payloads are migrated:",
    "    []",
    "    {\"values\":[]}",
    "    {\"data\":[]}",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    apply: false,
    root: String(process.env.UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT || "").trim(),
    day: "",
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--root") {
      args.root = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--day") {
      args.day = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.root) {
    throw new Error("Missing SOS mirror root. Set UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT or pass --root.");
  }
  if (args.day && !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
    throw new Error("--day must be YYYY-MM-DD");
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function isEmptySosPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.length === 0;
  }
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (Array.isArray(payload.values)) {
    return payload.values.length === 0;
  }
  if (Array.isArray(payload.data)) {
    return payload.data.length === 0;
  }
  return false;
}

function dayDirNameToDayUtc(dirName) {
  const match = String(dirName || "").match(/^day_utc=(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : "";
}

function loadNoDataManifest(manifestPath, dayUtc) {
  if (!fs.existsSync(manifestPath)) {
    return new Map();
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`No-data manifest is not an object: ${manifestPath}`);
  }
  const rawEntries = Array.isArray(parsed.timeseries) ? parsed.timeseries : [];
  const entries = new Map();
  for (const rawEntry of rawEntries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const timeseriesRef = String(rawEntry.timeseries_ref || "").trim();
    if (!timeseriesRef) {
      continue;
    }
    entries.set(timeseriesRef, {
      timeseries_ref: timeseriesRef,
      station_ref: rawEntry.station_ref == null ? null : String(rawEntry.station_ref),
      recorded_at_utc: typeof rawEntry.recorded_at_utc === "string" && rawEntry.recorded_at_utc.trim()
        ? rawEntry.recorded_at_utc.trim()
        : nowIso(),
      day_utc: dayUtc,
    });
  }
  return entries;
}

function writeNoDataManifest(manifestPath, dayUtc, entries) {
  const payload = {
    schema_version: 1,
    day_utc: dayUtc,
    updated_at_utc: nowIso(),
    timeseries: Array.from(entries.values())
      .map((entry) => ({
        timeseries_ref: entry.timeseries_ref,
        station_ref: entry.station_ref,
        recorded_at_utc: entry.recorded_at_utc,
      }))
      .sort((left, right) => left.timeseries_ref.localeCompare(right.timeseries_ref)),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function collectDayDirs(root, restrictedDay) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dayUtc = dayDirNameToDayUtc(entry.name);
    if (!dayUtc) {
      continue;
    }
    if (restrictedDay && dayUtc !== restrictedDay) {
      continue;
    }
    out.push({
      day_utc: dayUtc,
      dir_path: path.join(root, entry.name),
    });
  }
  out.sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  return out;
}

function decodeTimeseriesRef(fileName) {
  const baseName = fileName.replace(/\.json$/i, "");
  try {
    return decodeURIComponent(baseName);
  } catch {
    return baseName;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`SOS mirror root does not exist or is not a directory: ${root}`);
  }

  const dayDirs = collectDayDirs(root, args.day);
  const summary = {
    ok: true,
    apply: args.apply,
    root,
    day_filter: args.day || null,
    day_directories_scanned: dayDirs.length,
    empty_files_found: 0,
    files_deleted: 0,
    manifests_written: 0,
    manifest_entries_added: 0,
    skipped_non_empty_files: 0,
    invalid_json_files: 0,
    days: [],
  };

  for (const dayDir of dayDirs) {
    const manifestPath = path.join(dayDir.dir_path, "_no_data_timeseries.json");
    const manifestEntries = loadNoDataManifest(manifestPath, dayDir.day_utc);
    let entriesAdded = 0;
    let filesDeleted = 0;
    let emptyFilesFound = 0;
    let invalidJsonFiles = 0;

    for (const entry of fs.readdirSync(dayDir.dir_path, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      if (entry.name === "_no_data_timeseries.json") {
        continue;
      }
      const filePath = path.join(dayDir.dir_path, entry.name);
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        invalidJsonFiles += 1;
        continue;
      }
      if (!isEmptySosPayload(payload)) {
        summary.skipped_non_empty_files += 1;
        continue;
      }

      emptyFilesFound += 1;
      const timeseriesRef = decodeTimeseriesRef(entry.name);
      if (!manifestEntries.has(timeseriesRef)) {
        manifestEntries.set(timeseriesRef, {
          day_utc: dayDir.day_utc,
          timeseries_ref: timeseriesRef,
          station_ref: null,
          recorded_at_utc: nowIso(),
        });
        entriesAdded += 1;
      }

      if (args.verbose) {
        console.log(`${args.apply ? "migrate" : "would_migrate"} ${filePath}`);
      }
      if (args.apply) {
        fs.unlinkSync(filePath);
        filesDeleted += 1;
      }
    }

    if (args.apply && entriesAdded > 0) {
      writeNoDataManifest(manifestPath, dayDir.day_utc, manifestEntries);
      summary.manifests_written += 1;
    }

    summary.empty_files_found += emptyFilesFound;
    summary.files_deleted += filesDeleted;
    summary.manifest_entries_added += entriesAdded;
    summary.invalid_json_files += invalidJsonFiles;
    if (emptyFilesFound > 0 || entriesAdded > 0 || invalidJsonFiles > 0) {
      summary.days.push({
        day_utc: dayDir.day_utc,
        empty_files_found: emptyFilesFound,
        manifest_entries_added: entriesAdded,
        files_deleted: filesDeleted,
        invalid_json_files: invalidJsonFiles,
      });
    }
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});
