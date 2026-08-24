#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinTargetPath,
  normalizePrefix,
  rcloneCat,
  rcloneCatMaybe,
  rcloneLsjsonFile,
  rcloneLsjsonRecursive,
  uploadFromTempFile,
} from "./lib/rclone.mjs";
import {
  buildHierarchicalInventoryRoot,
  buildObservationMonthInventoryShard,
  buildObservationRunManifestInventoryShard,
  observationMonthInventoryShardKey,
  sha256Hex,
  stableJson,
  validateLatestTimeseriesInventoryUnit,
  validateHierarchicalInventoryRoot,
  validateObservationRunManifestInventoryShard,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  buildTimeseriesBindingInventory,
} from "./lib/timeseries_binding_ranges_v2.mjs";
import {
  buildCoreInventory,
} from "./lib/hierarchical_core_backup_v2.mjs";
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";

const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim() || "rclone";
const DEFAULT_OBSERVATIONS_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || "history/v2/observations",
);
const DEFAULT_RUNS_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_V2_RUNS_PREFIX || "history/v2/_ops/observations/runs",
);
const DEFAULT_CORE_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_V2_CORE_PREFIX || "history/v2/core",
);
const DEFAULT_INDEX_V2_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_INDEX_V2_PREFIX || "history/_index_v2",
);
const DEFAULT_TIMESERIES_BINDING_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_TIMESERIES_BINDING_V2_PREFIX
  || `${DEFAULT_INDEX_V2_PREFIX}/timeseries_binding`,
);
const DEFAULT_INVENTORY_ROOT_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX
  || "history/_index_v2/backup_inventory_v2",
);
const DEFAULT_LATEST_TIMESERIES_KEY = normalizePrefix(
  `${DEFAULT_INDEX_V2_PREFIX}/observations_timeseries_latest.json`,
);
const DEFAULT_REPORT_OUT = String(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_REPORT_OUT || "",
).trim();

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/build_backup_inventory.mjs \\",
    "    --source-root <rclone-source-root> [options]",
    "",
    "Required:",
    "  --source-root <root>          Example: uk_aq_r2_test:uk-aq-history-cic-test",
    "",
    "Options:",
    `  --observations-prefix <p>    Default: ${DEFAULT_OBSERVATIONS_PREFIX}`,
    `  --runs-prefix <p>            Default: ${DEFAULT_RUNS_PREFIX}`,
    `  --core-prefix <p>            Default: ${DEFAULT_CORE_PREFIX}`,
    `  --timeseries-binding-prefix <p> Default: ${DEFAULT_TIMESERIES_BINDING_PREFIX}`,
    `  --inventory-root-prefix <p>  Default: ${DEFAULT_INVENTORY_ROOT_PREFIX}`,
    `  --latest-timeseries-key <p>  Default: ${DEFAULT_LATEST_TIMESERIES_KEY}`,
    `  --rclone-bin <name>          Default: ${DEFAULT_RCLONE_BIN}`,
    "  --full-scan                  Independently hash observations, bindings and core",
    "  --dry-run                    Build and compare only; do not write inventory objects",
    "  --report-out <file>          Write JSON report",
    "  -h, --help",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    observations_prefix: DEFAULT_OBSERVATIONS_PREFIX,
    runs_prefix: DEFAULT_RUNS_PREFIX,
    core_prefix: DEFAULT_CORE_PREFIX,
    timeseries_binding_prefix: DEFAULT_TIMESERIES_BINDING_PREFIX,
    inventory_root_prefix: DEFAULT_INVENTORY_ROOT_PREFIX,
    latest_timeseries_key: DEFAULT_LATEST_TIMESERIES_KEY,
    rclone_bin: DEFAULT_RCLONE_BIN,
    full_scan: false,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => String(argv[++i] || "").trim();
    if (arg === "--source-root") args.source_root = next();
    else if (arg === "--observations-prefix") args.observations_prefix = normalizePrefix(next());
    else if (arg === "--runs-prefix") args.runs_prefix = normalizePrefix(next());
    else if (arg === "--core-prefix") args.core_prefix = normalizePrefix(next());
    else if (arg === "--timeseries-binding-prefix") {
      args.timeseries_binding_prefix = normalizePrefix(next());
    } else if (arg === "--inventory-root-prefix") {
      args.inventory_root_prefix = normalizePrefix(next());
    } else if (arg === "--latest-timeseries-key") {
      args.latest_timeseries_key = normalizePrefix(next());
    } else if (arg === "--rclone-bin") args.rclone_bin = next() || DEFAULT_RCLONE_BIN;
    else if (arg === "--report-out") args.report_out = next();
    else if (arg === "--full-scan") args.full_scan = true;
    else if (arg === "--dry-run") args.dry_run = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.source_root) throw new Error("--source-root is required");
  if (!args.observations_prefix) throw new Error("--observations-prefix is required");
  if (!args.core_prefix) throw new Error("--core-prefix is required");
  if (!args.timeseries_binding_prefix) {
    throw new Error("--timeseries-binding-prefix is required");
  }
  if (!args.inventory_root_prefix) throw new Error("--inventory-root-prefix is required");
  if (!args.latest_timeseries_key) throw new Error("--latest-timeseries-key is required");
  return args;
}

function readJson(rcloneBin, root, relativePath) {
  const text = rcloneCat(rcloneBin, joinTargetPath(root, relativePath));
  try {
    return { text, parsed: JSON.parse(text) };
  } catch (error) {
    throw new Error(`Invalid JSON at ${relativePath}: ${error?.message || error}`);
  }
}

function readJsonMaybe(rcloneBin, root, relativePath) {
  const rel = String(relativePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const dir = path.posix.dirname(rel);
  const entry = rcloneLsjsonFile(
    rcloneBin,
    joinTargetPath(root, dir === "." ? "" : dir),
    path.posix.basename(rel),
  );
  return entry ? readJson(rcloneBin, root, rel) : null;
}

function writeRemoteJson(rcloneBin, root, relativePath, payload, dryRun) {
  const text = stableJson(payload);
  const target = joinTargetPath(root, relativePath);
  const existing = rcloneCatMaybe(rcloneBin, target);
  const changed = !existing.found || existing.text !== text;
  if (changed && !dryRun) {
    uploadFromTempFile(rcloneBin, target, text, "uk_aq_hierarchical_inventory_");
  }
  return {
    changed,
    written: changed && !dryRun,
    hash: sha256Hex(text),
  };
}

function writeReport(filename, report) {
  if (!filename) return;
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function validateAggregate(raw, expectedKind, observationsPrefix, identity = {}) {
  const manifest = validateR2HistoryV2ObservationsAggregateManifest(
    raw,
    { basePrefix: observationsPrefix },
  );
  if (manifest.kind !== expectedKind) {
    throw new Error(`Unexpected aggregate manifest kind ${manifest.kind}`);
  }
  if (identity.year !== undefined && String(manifest.year) !== String(identity.year)) {
    throw new Error(`Observation year identity mismatch: ${manifest.year}`);
  }
  if (
    identity.month !== undefined
    && String(manifest.month).padStart(2, "0") !== String(identity.month).padStart(2, "0")
  ) {
    throw new Error(`Observation month identity mismatch: ${manifest.year}-${manifest.month}`);
  }
  return manifest;
}

function dayManifestRecord(rcloneBin, sourceRoot, manifestKey, expectedHash = null) {
  const { text, parsed } = readJson(rcloneBin, sourceRoot, manifestKey);
  const manifestHash = String(parsed?.manifest_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) {
    throw new Error(`Day manifest has invalid manifest_hash: ${manifestKey}`);
  }
  if (expectedHash && manifestHash !== expectedHash) {
    throw new Error(`Day manifest hash mismatch at ${manifestKey}`);
  }
  const match = /day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/.exec(manifestKey);
  if (!match) throw new Error(`Invalid observation day manifest path: ${manifestKey}`);
  return {
    day_utc: match[1],
    manifest_key: manifestKey,
    manifest_hash: manifestHash,
    manifest_file_hash: sha256Hex(text),
    manifest_size: Buffer.byteLength(text, "utf8"),
  };
}

function fullScanObservationDays(args) {
  const entries = rcloneLsjsonRecursive(
    args.rclone_bin,
    joinTargetPath(args.source_root, args.observations_prefix),
    { hash: false, maxDepth: 2 },
  );
  const days = new Map();
  for (const entry of entries) {
    const rel = String(entry?.Path || entry?.Name || "").replace(/\\/g, "/");
    const match = /^day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/.exec(rel);
    if (!match) continue;
    const key = `${args.observations_prefix}/${rel}`;
    days.set(match[1], dayManifestRecord(args.rclone_bin, args.source_root, key));
  }
  return days;
}

function scanRunManifests(args, previousShard) {
  const previous = new Map(
    (previousShard?.units || []).map((unit) => [unit.unit_key, unit]),
  );
  const entries = rcloneLsjsonRecursive(
    args.rclone_bin,
    joinTargetPath(args.source_root, args.runs_prefix),
    { hash: true, maxDepth: 2 },
  );
  const units = [];
  let reused = 0;
  let read = 0;
  for (const entry of entries) {
    const rel = String(entry?.Path || entry?.Name || "").replace(/\\/g, "/");
    const match = /^(run_id=[^/]+\/run_manifest\.json)$/.exec(rel);
    if (!match) continue;
    const unitKey = match[1];
    const hashes = entry?.Hashes || {};
    const md5 = String(hashes.md5 || hashes.MD5 || "").trim() || null;
    const size = Number(entry?.Size);
    const prior = previous.get(unitKey);
    if (
      prior
      && prior.hash
      && md5
      && prior.r2_md5 === md5
      && Number(prior.size) === size
    ) {
      units.push({ ...prior });
      reused += 1;
      continue;
    }
    const relativePath = `${args.runs_prefix}/${unitKey}`;
    const text = rcloneCat(
      args.rclone_bin,
      joinTargetPath(args.source_root, relativePath),
    );
    units.push({
      unit_key: unitKey,
      relative_path: relativePath,
      hash: sha256Hex(text),
      size: Buffer.byteLength(text, "utf8"),
      r2_md5: md5,
    });
    read += 1;
  }
  units.sort((a, b) => a.unit_key.localeCompare(b.unit_key));
  return { units, listed: units.length, reused, read };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const inventoryRootKey = `${args.inventory_root_prefix}/root.json`;
  const observationsRootKey = `${args.observations_prefix}/_manifests/manifest.json`;

  const previousRaw = readJsonMaybe(args.rclone_bin, args.source_root, inventoryRootKey);
  const previousRoot = previousRaw
    ? validateHierarchicalInventoryRoot(
      previousRaw.parsed,
      { requireLatestTimeseries: false },
    )
    : null;

  const latestTimeseriesSource = readJson(
    args.rclone_bin,
    args.source_root,
    args.latest_timeseries_key,
  );
  const latestTimeseriesIdentity = validateLatestTimeseriesInventoryUnit({
    relative_path: args.latest_timeseries_key,
    sha256: sha256Hex(latestTimeseriesSource.text),
    byte_size: Buffer.byteLength(latestTimeseriesSource.text, "utf8"),
  });
  const previousLatestTimeseries =
    previousRoot?.global_units?.observations_timeseries_latest || null;
  const latestTimeseries = previousLatestTimeseries
    && previousLatestTimeseries.relative_path === latestTimeseriesIdentity.relative_path
    && previousLatestTimeseries.sha256 === latestTimeseriesIdentity.sha256
    && previousLatestTimeseries.byte_size === latestTimeseriesIdentity.byte_size
    ? previousLatestTimeseries
    : latestTimeseriesIdentity;

  const sourceRoot = validateAggregate(
    readJson(args.rclone_bin, args.source_root, observationsRootKey).parsed,
    OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root,
    args.observations_prefix,
  );
  const sourceRootUnchanged = Boolean(
    previousRoot?.observations?.source_root_hash === sourceRoot.content_hash,
  );
  const fullScanDays = args.full_scan ? fullScanObservationDays(args) : null;
  const fullScanSeen = new Set();
  const previousYears = new Map(
    (previousRoot?.observations?.years || []).map((year) => [String(year.year), year]),
  );

  const years = [];
  const changedMonthShards = [];
  let yearsInspected = 0;
  let yearsSkipped = 0;
  let monthsInspected = 0;
  let monthsSkipped = 0;

  for (const rootYear of sourceRoot.children) {
    const yearId = String(rootYear.year);
    const priorYear = previousYears.get(yearId);
    if (!args.full_scan && priorYear?.content_hash === rootYear.content_hash) {
      years.push({ ...priorYear });
      yearsSkipped += 1;
      continue;
    }

    yearsInspected += 1;
    const yearManifest = validateAggregate(
      readJson(args.rclone_bin, args.source_root, rootYear.manifest_key).parsed,
      OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year,
      args.observations_prefix,
      { year: yearId },
    );
    if (yearManifest.content_hash !== rootYear.content_hash) {
      throw new Error(`Year ${yearId} content_hash differs from root`);
    }
    const priorMonths = new Map(
      (priorYear?.months || []).map((month) => [String(month.month), month]),
    );
    const months = [];

    for (const yearMonth of yearManifest.children) {
      const monthId = String(yearMonth.month).padStart(2, "0");
      const priorMonth = priorMonths.get(monthId);
      if (!args.full_scan && priorMonth?.content_hash === yearMonth.content_hash) {
        months.push({ ...priorMonth });
        monthsSkipped += 1;
        continue;
      }

      monthsInspected += 1;
      const monthManifest = validateAggregate(
        readJson(args.rclone_bin, args.source_root, yearMonth.manifest_key).parsed,
        OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month,
        args.observations_prefix,
        { year: yearId, month: monthId },
      );
      if (monthManifest.content_hash !== yearMonth.content_hash) {
        throw new Error(`Month ${yearId}-${monthId} content_hash differs from year`);
      }

      const inventoryDays = monthManifest.children.map((day) => {
        const cached = fullScanDays?.get(day.day_utc) || null;
        const record = cached || dayManifestRecord(
          args.rclone_bin,
          args.source_root,
          day.manifest_key,
          day.manifest_hash,
        );
        if (record.manifest_hash !== day.manifest_hash) {
          throw new Error(`Day ${day.day_utc} differs from month hierarchy`);
        }
        fullScanSeen.add(day.day_utc);
        return record;
      });
      const shardKey = observationMonthInventoryShardKey(
        args.inventory_root_prefix,
        yearId,
        monthId,
      );
      const shard = buildObservationMonthInventoryShard({
        observationsPrefix: args.observations_prefix,
        year: yearId,
        month: monthId,
        sourceMonthManifestKey: yearMonth.manifest_key,
        sourceMonthHash: yearMonth.content_hash,
        days: inventoryDays,
      });
      const write = writeRemoteJson(
        args.rclone_bin,
        args.source_root,
        shardKey,
        shard,
        args.dry_run,
      );
      changedMonthShards.push({
        year: yearId,
        month: monthId,
        shard_key: shardKey,
        changed: write.changed,
        written: write.written,
        day_count: shard.days.length,
      });
      months.push({
        month: monthId,
        manifest_key: yearMonth.manifest_key,
        content_hash: yearMonth.content_hash,
        inventory_shard_key: shardKey,
      });
    }

    years.push({
      year: yearId,
      manifest_key: rootYear.manifest_key,
      content_hash: rootYear.content_hash,
      months,
    });
  }

  if (args.full_scan) {
    if (fullScanSeen.size !== fullScanDays.size) {
      const extras = [...fullScanDays.keys()].filter((day) => !fullScanSeen.has(day));
      throw new Error(
        `Full observation scan disagrees with hierarchy: ${extras.length} unrepresented day(s)`,
      );
    }
  }

  const runShardKey = `${args.inventory_root_prefix}/global/observation_run_manifests.json`;
  const previousRunRaw = previousRoot
    ? readJsonMaybe(
      args.rclone_bin,
      args.source_root,
      previousRoot.global_units.observation_run_manifests.inventory_shard_key,
    )
    : null;
  const previousRunShard = previousRunRaw
    ? validateObservationRunManifestInventoryShard(previousRunRaw.parsed)
    : null;
  const runScan = scanRunManifests(args, previousRunShard);
  const runShard = buildObservationRunManifestInventoryShard(runScan.units);
  const runWrite = writeRemoteJson(
    args.rclone_bin,
    args.source_root,
    runShardKey,
    runShard,
    args.dry_run,
  );

  const bindingInventory = buildTimeseriesBindingInventory({
    rcloneBin: args.rclone_bin,
    sourceRoot: args.source_root,
    sourcePrefix: args.timeseries_binding_prefix,
    inventoryRootPrefix: args.inventory_root_prefix,
    previousRootReference: previousRoot?.timeseries_binding || null,
    fullScan: args.full_scan,
    dryRun: args.dry_run,
  });

  const coreInventory = buildCoreInventory({
    rcloneBin: args.rclone_bin,
    sourceRoot: args.source_root,
    sourcePrefix: args.core_prefix,
    inventoryRootPrefix: args.inventory_root_prefix,
    previousRootReference: previousRoot?.core || null,
    fullScan: args.full_scan,
    dryRun: args.dry_run,
  });

  const root = buildHierarchicalInventoryRoot({
    observationsRootManifestKey: observationsRootKey,
    observationsRootHash: sourceRoot.content_hash,
    years,
    runManifestInventoryShardKey: runShardKey,
    runManifestInventoryShardHash: runWrite.hash,
    runManifestUnitCount: runScan.units.length,
    latestTimeseries,
  });
  root.timeseries_binding = bindingInventory.root_reference;
  root.core = coreInventory.root_reference;
  const rootWrite = writeRemoteJson(
    args.rclone_bin,
    args.source_root,
    inventoryRootKey,
    root,
    args.dry_run,
  );

  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    inventory_mode: args.full_scan ? "full_scan" : "hierarchical",
    source_root: args.source_root,
    observations_prefix: args.observations_prefix,
    core_prefix: args.core_prefix,
    observations_root_manifest_key: observationsRootKey,
    observations_source_root_hash: sourceRoot.content_hash,
    previous_source_root_hash: previousRoot?.observations?.source_root_hash || null,
    source_root_unchanged: sourceRootUnchanged,
    inventory_root_key: inventoryRootKey,
    inventory_root_changed: rootWrite.changed,
    inventory_root_written: rootWrite.written,
    dry_run: args.dry_run,
    first_build: previousRoot === null,
    years_total: years.length,
    years_inspected: yearsInspected,
    years_skipped_by_hash: yearsSkipped,
    months_total: years.reduce((sum, year) => sum + year.months.length, 0),
    months_inspected: monthsInspected,
    months_skipped_by_hash: monthsSkipped,
    month_shards_changed: changedMonthShards.filter((entry) => entry.changed).length,
    month_shards_written: changedMonthShards.filter((entry) => entry.written).length,
    month_shards: changedMonthShards,
    full_scan_day_count: fullScanDays?.size ?? null,
    full_scan_hierarchy_agreed: args.full_scan ? true : null,
    timeseries_binding: bindingInventory.report,
    core: coreInventory.report,
    run_manifests: {
      listed: runScan.listed,
      reused_by_metadata: runScan.reused,
      read_and_hashed: runScan.read,
      inventory_shard_key: runShardKey,
      inventory_shard_changed: runWrite.changed,
      inventory_shard_written: runWrite.written,
    },
    latest_timeseries: {
      source_path: latestTimeseries.relative_path,
      sha256: latestTimeseries.sha256,
      byte_size: latestTimeseries.byte_size,
      inventory_identity_reused: latestTimeseries === previousLatestTimeseries,
    },
  };
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

function isMainModule(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  });
}
