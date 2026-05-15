#!/usr/bin/env node
// Build the R2 History backup inventory used by the Dropbox sync.
//
// The inventory lives at <source-root>/<inventory-rel-path> (default
// history/_index/backup_inventory_v1.json) and records one entry per backup
// unit: per-domain day manifests, the four *_latest.json index files, and the
// per-(day, connector) manifests under the timeseries index trees.
//
// On subsequent runs, `rclone lsjson` is used to compare each remote file's
// size + MD5 etag against the previous inventory; matching entries are reused
// verbatim and only changed/new ones are re-read. The first build is
// unavoidably slow (full scan); steady-state runs are near-instant.
//
// Sync (scripts/backup_r2/sync_history_to_dropbox.mjs) reads this file and
// plans copies from inventory <-> Dropbox-checkpoint hash comparison alone —
// it never re-scans manifests directly.

import fs from "node:fs";
import path from "node:path";

import {
  joinTargetPath,
  normalizePrefix,
  rcloneCat,
  rcloneLsjsonFile,
  rcloneLsjsonRecursive,
  sha256Hex,
  uploadFromTempFile,
} from "./lib/rclone.mjs";
import {
  DOMAIN_NAMES,
  INDEX_FILE_KEYS,
  INDEX_TREE_KEYS,
  INVENTORY_KIND,
  INVENTORY_SCHEMA_VERSION,
  loadInventory,
} from "./lib/inventory.mjs";

const DEFAULT_DOMAIN_PREFIXES = Object.freeze({
  observations: normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || "history/v1/observations",
  ),
  aqilevels: normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || "history/v1/aqilevels",
  ),
  core: normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_CORE_PREFIX || "history/v1/core",
  ),
});
const DEFAULT_INDEX_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_INDEX_PREFIX || "history/_index",
);
const DEFAULT_INVENTORY_REL_PATH =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH || "").trim()
  || `${DEFAULT_INDEX_PREFIX || "history/_index"}/backup_inventory_v1.json`;
const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim() || "rclone";
const DEFAULT_REPORT_OUT =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REPORT_OUT || "").trim();

const DAY_MANIFEST_PATTERN = /^day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/;
const INDEX_TREE_UNIT_PATTERN =
  /^day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=(\d+)\/manifest\.json$/;

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/build_backup_inventory.mjs \\",
      "    --source-root <rclone-source-root> [options]",
      "",
      "Required:",
      "  --source-root              Example: uk_aq_r2:uk-aq-history-cic-test",
      "",
      "Optional:",
      `  --inventory-rel-path <p>   Default: ${DEFAULT_INVENTORY_REL_PATH}`,
      "  --domain <name>            observations | aqilevels | core (repeatable)",
      `  --index-prefix <prefix>    Default: ${DEFAULT_INDEX_PREFIX || "history/_index"}`,
      `  --rclone-bin <name>        Default: ${DEFAULT_RCLONE_BIN}`,
      "  --report-out <file>        Write JSON report to file",
      "  --dry-run                  Build/validate only; do not upload inventory",
      "  --full-rebuild             Ignore previous inventory; re-read every manifest",
      "  -h, --help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    inventory_rel_path: DEFAULT_INVENTORY_REL_PATH,
    domains: [],
    index_prefix: DEFAULT_INDEX_PREFIX,
    rclone_bin: DEFAULT_RCLONE_BIN,
    report_out: DEFAULT_REPORT_OUT,
    dry_run: false,
    full_rebuild: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-root") {
      args.source_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--inventory-rel-path") {
      args.inventory_rel_path =
        String(argv[i + 1] || "").trim() || DEFAULT_INVENTORY_REL_PATH;
      i += 1;
      continue;
    }
    if (arg === "--domain") {
      const domain = String(argv[i + 1] || "").trim();
      if (!DOMAIN_NAMES.includes(domain)) {
        throw new Error(`Invalid --domain value: ${domain}`);
      }
      args.domains.push(domain);
      i += 1;
      continue;
    }
    if (arg === "--index-prefix") {
      args.index_prefix =
        normalizePrefix(argv[i + 1] || "") || DEFAULT_INDEX_PREFIX;
      i += 1;
      continue;
    }
    if (arg === "--rclone-bin") {
      args.rclone_bin = String(argv[i + 1] || "").trim() || DEFAULT_RCLONE_BIN;
      i += 1;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "--full-rebuild") {
      args.full_rebuild = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.source_root) {
    throw new Error("--source-root is required");
  }
  if (!args.inventory_rel_path) {
    throw new Error("--inventory-rel-path cannot be empty");
  }
  if (args.domains.length === 0) {
    args.domains = [...DOMAIN_NAMES];
  } else {
    args.domains = Array.from(new Set(args.domains));
  }

  return args;
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) return;
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ---- Etag-skip helpers ----

// Extract the bits of rclone lsjson metadata we use for skip-key building +
// telemetry.
//
// Cloudflare R2 (and other S3-compatible backends) only populates `Hashes.md5`
// in lsjson output when called with `--hash --hash-type MD5`. Our lsjson
// wrappers in lib/rclone.mjs do this by default. If the MD5 is still missing
// after that, rclone's backend version or this specific object isn't exposing
// it (e.g. multipart upload composite etag) — we fall back to Size + ModTime
// for the skip decision, which is weaker but still detects rewrites.
function extractLsjsonMetadata(entry) {
  if (!entry || typeof entry !== "object") {
    return { size: null, md5: null, modtime: null, has_md5: false };
  }
  const rawSize = Number(entry.Size);
  const size = Number.isFinite(rawSize) ? rawSize : null;
  const hashes = entry.Hashes || {};
  const md5 = (hashes.md5 || hashes.MD5 || "").trim() || null;
  const modtime = (entry.ModTime || "").trim() || null;
  return { size, md5, modtime, has_md5: Boolean(md5) };
}

// Read previous-inventory metadata for skip comparison. `r2_md5` is the only
// MD5 source — legacy `r2_etag` fields (from inventories written before the
// --hash fix) are intentionally ignored, since they were always null in
// practice and there's nothing to gain by trying to bridge them.
function previousMetadata(prev, sizeField) {
  if (!prev) return { size: null, md5: null, modtime: null };
  const rawSize = Number(prev[sizeField]);
  const size = Number.isFinite(rawSize) ? rawSize : null;
  const md5 = (prev.r2_md5 || "").trim() || null;
  const modtime = (prev.r2_modtime || "").trim() || null;
  return { size, md5, modtime };
}

// Decide whether the previous inventory entry can be reused for a current
// lsjson entry, and if so by which signal. Returns one of:
//   "md5"      — both sides have an MD5 and they match (with size match)
//   "modtime"  — MD5 missing on either side, but size + modtime match
//   null       — different, or insufficient signal; current must be re-read
function classifyReuse(currentMeta, prevMeta) {
  if (!currentMeta || !prevMeta) return null;
  if (currentMeta.size === null || prevMeta.size === null) return null;
  if (currentMeta.size !== prevMeta.size) return null;
  if (currentMeta.md5 && prevMeta.md5) {
    return currentMeta.md5 === prevMeta.md5 ? "md5" : null;
  }
  if (currentMeta.modtime && prevMeta.modtime
      && currentMeta.modtime === prevMeta.modtime) {
    return "modtime";
  }
  return null;
}

// ---- Entry builders ----

function safeIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function buildDayInventoryEntry({
  manifestRelativePath,
  dayRelativePath,
  manifestText,
  lsjsonEntry,
}) {
  let parsed = null;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    parsed = null;
  }
  const meta = extractLsjsonMetadata(lsjsonEntry);
  return {
    unit_type: "day_folder",
    relative_path: dayRelativePath,
    manifest_relative_path: manifestRelativePath,
    manifest_hash: sha256Hex(manifestText),
    manifest_size: Buffer.byteLength(manifestText, "utf8"),
    r2_md5: meta.md5,
    r2_modtime: meta.modtime,
    file_count: safeIntOrNull(parsed?.file_count),
    total_bytes: safeIntOrNull(parsed?.total_bytes),
    source_row_count: safeIntOrNull(parsed?.source_row_count),
  };
}

function buildFileInventoryEntry({ relativePath, fileText, lsjsonEntry }) {
  const meta = extractLsjsonMetadata(lsjsonEntry);
  return {
    unit_type: "file",
    relative_path: relativePath,
    hash: sha256Hex(fileText),
    size: Buffer.byteLength(fileText, "utf8"),
    r2_md5: meta.md5,
    r2_modtime: meta.modtime,
  };
}


function recordMd5Availability(stats, hasMd5) {
  if (hasMd5) stats.r2_md5_available_count += 1;
  else stats.r2_md5_missing_count += 1;
}

function recordReuseOutcome(stats, classification) {
  if (classification === "md5") stats.reuse_by_r2_md5_size += 1;
  else if (classification === "modtime") stats.reuse_by_size_modtime += 1;
}

// ---- Phase: per-domain day folders ----

function scanDayDomain({
  rcloneBin,
  sourceRoot,
  domain,
  domainPrefix,
  previousDays,
  excludeRelativePaths,
  stats,
}) {
  const domainSourcePath = joinTargetPath(sourceRoot, domainPrefix);
  const lsjsonEntries = rcloneLsjsonRecursive(rcloneBin, domainSourcePath);

  const days = {};
  for (const entry of lsjsonEntries) {
    const relPath = String(entry?.Path || "");
    const match = relPath.match(DAY_MANIFEST_PATTERN);
    if (!match) continue;
    const manifestRelativePath = `${domainPrefix}/${relPath}`;
    if (excludeRelativePaths.has(manifestRelativePath)) continue;
    const dayUtc = match[1];
    stats.manifests_listed += 1;

    const currentMeta = extractLsjsonMetadata(entry);
    recordMd5Availability(stats, currentMeta.has_md5);
    const previousEntry = previousDays?.[dayUtc] || null;
    const prevMeta = previousMetadata(previousEntry, "manifest_size");
    const reuseClass = previousEntry && previousEntry.manifest_hash
      ? classifyReuse(currentMeta, prevMeta)
      : null;

    if (reuseClass) {
      days[dayUtc] = { ...previousEntry };
      recordReuseOutcome(stats, reuseClass);
      continue;
    }

    const dayRelativePath = `${domainPrefix}/day_utc=${dayUtc}`;
    const manifestSourcePath = joinTargetPath(sourceRoot, manifestRelativePath);
    const manifestText = rcloneCat(rcloneBin, manifestSourcePath);
    stats.manifests_reread += 1;
    days[dayUtc] = buildDayInventoryEntry({
      manifestRelativePath,
      dayRelativePath,
      manifestText,
      lsjsonEntry: entry,
    });
  }

  return { domain, days };
}

// ---- Phase: latest index files ----

function scanIndexFile({
  rcloneBin,
  sourceRoot,
  indexKey,
  indexPrefix,
  previousEntry,
  excludeRelativePaths,
  stats,
}) {
  const fileName = `${indexKey}.json`;
  const relativePath = indexPrefix ? `${indexPrefix}/${fileName}` : fileName;
  if (excludeRelativePaths.has(relativePath)) return null;
  const parentPath = joinTargetPath(sourceRoot, indexPrefix || "");
  const lsjsonEntry = rcloneLsjsonFile(rcloneBin, parentPath, fileName);

  if (!lsjsonEntry) {
    stats.index_files_missing += 1;
    return null;
  }
  stats.index_files_listed += 1;

  const currentMeta = extractLsjsonMetadata(lsjsonEntry);
  recordMd5Availability(stats, currentMeta.has_md5);
  const prevMeta = previousMetadata(previousEntry, "size");
  const reuseClass = previousEntry && previousEntry.hash
    ? classifyReuse(currentMeta, prevMeta)
    : null;

  if (reuseClass) {
    stats.index_files_skipped += 1;
    recordReuseOutcome(stats, reuseClass);
    return { ...previousEntry };
  }

  const fileSourcePath = joinTargetPath(sourceRoot, relativePath);
  const fileText = rcloneCat(rcloneBin, fileSourcePath);
  stats.index_files_reread += 1;
  return buildFileInventoryEntry({ relativePath, fileText, lsjsonEntry });
}

// ---- Phase: per-(day, connector) index tree units ----

function scanIndexTree({
  rcloneBin,
  sourceRoot,
  treeKey,
  indexPrefix,
  previousUnits,
  excludeRelativePaths,
  stats,
}) {
  const treePrefix = indexPrefix ? `${indexPrefix}/${treeKey}` : treeKey;
  const treeSourcePath = joinTargetPath(sourceRoot, treePrefix);
  const lsjsonEntries = rcloneLsjsonRecursive(rcloneBin, treeSourcePath);

  const units = {};
  for (const entry of lsjsonEntries) {
    const relPath = String(entry?.Path || "");
    if (!INDEX_TREE_UNIT_PATTERN.test(relPath)) continue;
    const unitRelativePath = `${treePrefix}/${relPath}`;
    if (excludeRelativePaths.has(unitRelativePath)) continue;
    stats.index_tree_units_listed += 1;

    const currentMeta = extractLsjsonMetadata(entry);
    recordMd5Availability(stats, currentMeta.has_md5);
    const previousEntry = previousUnits?.[relPath] || null;
    const prevMeta = previousMetadata(previousEntry, "size");
    const reuseClass = previousEntry && previousEntry.hash
      ? classifyReuse(currentMeta, prevMeta)
      : null;

    if (reuseClass) {
      units[relPath] = { ...previousEntry };
      stats.index_tree_units_skipped += 1;
      recordReuseOutcome(stats, reuseClass);
      continue;
    }

    const unitSourcePath = joinTargetPath(sourceRoot, unitRelativePath);
    const fileText = rcloneCat(rcloneBin, unitSourcePath);
    stats.index_tree_units_reread += 1;
    units[relPath] = buildFileInventoryEntry({
      relativePath: unitRelativePath,
      fileText,
      lsjsonEntry: entry,
    });
  }

  return { treeKey, units };
}

// ---- Inventory composition ----

// Deterministic key ordering: sort object keys alphabetically at every level.
function sortObjectKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeysDeep(item));
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObjectKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function buildDeterministicJson(inventory) {
  return `${JSON.stringify(sortObjectKeysDeep(inventory), null, 2)}\n`;
}

function computeSummary(inventory) {
  const domainDayCount = {};
  for (const domain of DOMAIN_NAMES) {
    domainDayCount[domain] = Object.keys(
      inventory.domains?.[domain]?.days || {},
    ).length;
  }
  const indexFileCount = Object.keys(inventory.index_files || {}).length;
  const indexTreeUnitCount = {};
  for (const treeKey of INDEX_TREE_KEYS) {
    indexTreeUnitCount[treeKey] = Object.keys(
      inventory.index_tree_units?.[treeKey]?.units || {},
    ).length;
  }
  return {
    domain_day_count: domainDayCount,
    index_file_count: indexFileCount,
    index_tree_unit_count: indexTreeUnitCount,
  };
}

// ---- Main ----

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const previousInventory = args.full_rebuild
    ? null
    : loadInventory(args.rclone_bin, args.source_root, args.inventory_rel_path, { strict: false });
  const firstBuild = previousInventory === null;

  const inventory = {
    version: INVENTORY_SCHEMA_VERSION,
    kind: INVENTORY_KIND,
    generated_at: new Date().toISOString(),
    source: {
      index_prefix: args.index_prefix,
      domain_prefixes: {
        observations: DEFAULT_DOMAIN_PREFIXES.observations,
        aqilevels: DEFAULT_DOMAIN_PREFIXES.aqilevels,
        core: DEFAULT_DOMAIN_PREFIXES.core,
      },
    },
    domains: {
      observations: { days: {} },
      aqilevels: { days: {} },
      core: { days: {} },
    },
    index_files: {},
    index_tree_units: {
      observations_timeseries: { units: {} },
      aqilevels_timeseries: { units: {} },
    },
    summary: {},
  };

  const stats = {
    manifests_listed: 0,
    manifests_reread: 0,
    index_files_listed: 0,
    index_files_reread: 0,
    index_files_skipped: 0,
    index_files_missing: 0,
    index_tree_units_listed: 0,
    index_tree_units_reread: 0,
    index_tree_units_skipped: 0,
    // MD5 availability per lsjson entry across all three categories.
    // r2_md5_missing_count > 0 means rclone didn't return Hashes.md5 for
    // some objects (despite --hash --hash-type MD5) — could be multipart-style
    // etags or a backend version quirk.
    r2_md5_available_count: 0,
    r2_md5_missing_count: 0,
    // Reuse outcomes split by the signal used to decide reuse. The first is
    // the strong path (Size + MD5); the second is the weaker fallback that
    // kicks in only when MD5 is missing on either side. A high
    // reuse_by_size_modtime suggests either rclone isn't being called with
    // --hash or R2 isn't exposing MD5 for those objects.
    reuse_by_r2_md5_size: 0,
    reuse_by_size_modtime: 0,
    elapsed_ms: {},
  };

  // Defensive: never include the inventory file itself (or other control
  // files) in any of the scans. The current paths don't overlap by accident,
  // but this guards against future refactors that move the inventory into a
  // scanned subtree.
  const excludeRelativePaths = new Set([args.inventory_rel_path]);

  // Phase: day folders per domain
  const tDays = Date.now();
  for (const domain of args.domains) {
    const domainPrefix = DEFAULT_DOMAIN_PREFIXES[domain];
    if (!domainPrefix) {
      throw new Error(`No domain prefix configured for ${domain}`);
    }
    const previousDays =
      previousInventory?.domains?.[domain]?.days || {};
    const { days } = scanDayDomain({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      domain,
      domainPrefix,
      previousDays,
      excludeRelativePaths,
      stats,
    });
    inventory.domains[domain] = { days };
  }
  stats.elapsed_ms.days = Date.now() - tDays;

  // Phase: latest index files (only included if present in R2)
  const tIndexFiles = Date.now();
  for (const indexKey of INDEX_FILE_KEYS) {
    const previousEntry = previousInventory?.index_files?.[indexKey] || null;
    const entry = scanIndexFile({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      indexKey,
      indexPrefix: args.index_prefix,
      previousEntry,
      excludeRelativePaths,
      stats,
    });
    if (entry) {
      inventory.index_files[indexKey] = entry;
    }
  }
  stats.elapsed_ms.index_files = Date.now() - tIndexFiles;

  // Phase: timeseries index tree per-(day, connector) units
  const tTrees = Date.now();
  for (const treeKey of INDEX_TREE_KEYS) {
    const previousUnits =
      previousInventory?.index_tree_units?.[treeKey]?.units || {};
    const { units } = scanIndexTree({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      treeKey,
      indexPrefix: args.index_prefix,
      previousUnits,
      excludeRelativePaths,
      stats,
    });
    inventory.index_tree_units[treeKey] = { units };
  }
  stats.elapsed_ms.index_trees = Date.now() - tTrees;

  inventory.summary = computeSummary(inventory);

  const inventoryJson = buildDeterministicJson(inventory);
  const inventoryHash = sha256Hex(inventoryJson);

  if (!args.dry_run) {
    const inventoryTargetPath = joinTargetPath(
      args.source_root,
      args.inventory_rel_path,
    );
    uploadFromTempFile(
      args.rclone_bin,
      inventoryTargetPath,
      inventoryJson,
      "uk_aq_r2_history_backup_inventory_",
    );
  }

  stats.elapsed_ms.total = Date.now() - t0;

  const totalLs = stats.manifests_listed;
  const totalReread = stats.manifests_reread;
  const manifestReuseRate = totalLs > 0 ? (totalLs - totalReread) / totalLs : null;

  // Split the day-manifest re-reads by reason: full-rebuild forced them all,
  // otherwise they're either net-new days or days whose signals didn't match.
  // (Index files / tree units have their own per-category counters above.)
  const totalRereadAllCategories =
    stats.manifests_reread + stats.index_files_reread + stats.index_tree_units_reread;
  const rereadFullRebuild = args.full_rebuild ? totalRereadAllCategories : 0;
  const rereadNewOrChanged = args.full_rebuild ? 0 : totalRereadAllCategories;

  const r2Md5Available = stats.r2_md5_available_count > 0
    && stats.r2_md5_missing_count === 0;
  const metadataWarnings = [];
  if (stats.r2_md5_missing_count > 0) {
    metadataWarnings.push(
      `${stats.r2_md5_missing_count} entries had no Hashes.md5 from rclone lsjson — `
      + `skip decisions for those entries fall back to Size + ModTime (weaker). `
      + `Confirm rclone is being called with --hash --hash-type MD5 and that R2 is `
      + `exposing the etag for these objects.`,
    );
  }

  const report = {
    ok: true,
    first_build: firstBuild,
    dry_run: args.dry_run,
    full_rebuild: args.full_rebuild,
    inventory_rel_path: args.inventory_rel_path,
    inventory_size: Buffer.byteLength(inventoryJson, "utf8"),
    inventory_hash: inventoryHash,
    generated_at: inventory.generated_at,
    domains: args.domains,
    manifests_listed: totalLs,
    manifests_reread: totalReread,
    manifest_reuse_rate: manifestReuseRate,
    reread_new_or_changed: rereadNewOrChanged,
    reread_full_rebuild: rereadFullRebuild,
    index_files_listed: stats.index_files_listed,
    index_files_reread: stats.index_files_reread,
    index_files_skipped: stats.index_files_skipped,
    index_files_missing: stats.index_files_missing,
    index_tree_units_listed: stats.index_tree_units_listed,
    index_tree_units_reread: stats.index_tree_units_reread,
    index_tree_units_skipped: stats.index_tree_units_skipped,
    r2_md5_available_count: stats.r2_md5_available_count,
    r2_md5_missing_count: stats.r2_md5_missing_count,
    reuse_by_r2_md5_size: stats.reuse_by_r2_md5_size,
    reuse_by_size_modtime: stats.reuse_by_size_modtime,
    r2_md5_metadata_available: r2Md5Available,
    metadata_warnings: metadataWarnings,
    elapsed_ms: stats.elapsed_ms,
    summary: inventory.summary,
  };

  if (args.report_out) writeReport(args.report_out, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
  );
  process.exit(1);
});
