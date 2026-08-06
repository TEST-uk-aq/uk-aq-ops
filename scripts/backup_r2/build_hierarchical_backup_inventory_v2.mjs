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
  validateHierarchicalInventoryRoot,
  validateObservationRunManifestInventoryShard,
} from "./lib/hierarchical_backup_v2.mjs";
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
  process.env.UK_AQ_R2_HISTORY_V2_RUNS_PREFIX
  || "history/v2/_ops/observations/runs",
);
const DEFAULT_INVENTORY_ROOT_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX
  || "history/_index_v2/backup_inventory_v2",
);
const DEFAULT_LEGACY_INVENTORY_KEY =
  String(
    process.env.UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH
    || "history/_index_v2/backup_inventory_v2.json",
  ).trim().replace(/^\/+/, "");
const DEFAULT_REPORT_OUT = String(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_REPORT_OUT || "",
).trim();

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/build_hierarchical_backup_inventory_v2.mjs \\",
    "    --source-root <rclone-source-root> [options]",
    "",
    "Required:",
    "  --source-root <root>          Example: uk_aq_r2_test:uk-aq-history-cic-test",
    "",
    "Options:",
    `  --observations-prefix <p>    Default: ${DEFAULT_OBSERVATIONS_PREFIX}`,
    `  --runs-prefix <p>            Default: ${DEFAULT_RUNS_PREFIX}`,
    `  --inventory-root-prefix <p>  Default: ${DEFAULT_INVENTORY_ROOT_PREFIX}`,
    `  --legacy-inventory-key <p>   Default: ${DEFAULT_LEGACY_INVENTORY_KEY}`,
    `  --rclone-bin <name>          Default: ${DEFAULT_RCLONE_BIN}`,
    "  --full-scan                  Independently enumerate and verify every day manifest",
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
    inventory_root_prefix: DEFAULT_INVENTORY_ROOT_PREFIX,
    legacy_inventory_key: DEFAULT_LEGACY_INVENTORY_KEY,
    rclone_bin: DEFAULT_RCLONE_BIN,
    full_scan: false,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-root") {
      args.source_root = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--observations-prefix") {
      args.observations_prefix = normalizePrefix(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--runs-prefix") {
      args.runs_prefix = normalizePrefix(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--inventory-root-prefix") {
      args.inventory_root_prefix = normalizePrefix(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--legacy-inventory-key") {
      args.legacy_inventory_key = String(argv[index + 1] || "")
        .trim().replace(/^\/+/, "");
      index += 1;
      continue;
    }
    if (arg === "--rclone-bin") {
      args.rclone_bin = String(argv[index + 1] || "").trim() || DEFAULT_RCLONE_BIN;
      index += 1;
      continue;
    }
    if (arg === "--full-scan") {
      args.full_scan = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.source_root) throw new Error("--source-root is required");
  if (!args.observations_prefix) throw new Error("--observations-prefix is required");
  if (!args.inventory_root_prefix) {
    throw new Error("--inventory-root-prefix is required");
  }
  if (!args.legacy_inventory_key) {
    throw new Error("--legacy-inventory-key is required");
  }
  return args;
}

function readJson(rcloneBin, sourceRoot, relativePath) {
  const text = rcloneCat(
    rcloneBin,
    joinTargetPath(sourceRoot, relativePath),
  );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON at ${relativePath}: ${error?.message || error}`,
    );
  }
  return { text, parsed };
}

function readJsonMaybe(rcloneBin, sourceRoot, relativePath) {
  const normalizedPath = String(relativePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parentRelativePath = path.posix.dirname(normalizedPath);
  const fileName = path.posix.basename(normalizedPath);
  const parentPath = joinTargetPath(
    sourceRoot,
    parentRelativePath === "." ? "" : parentRelativePath,
  );
  const entry = rcloneLsjsonFile(rcloneBin, parentPath, fileName);
  if (!entry) return null;
  return readJson(rcloneBin, sourceRoot, normalizedPath);
}

function writeReport(reportOut, payload) {
  if (!reportOut) return;
  const output = path.resolve(reportOut);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeRemoteJson({
  rcloneBin,
  sourceRoot,
  relativePath,
  payload,
  dryRun,
}) {
  const text = stableJson(payload);
  const targetPath = joinTargetPath(sourceRoot, relativePath);
  const existing = rcloneCatMaybe(rcloneBin, targetPath);
  const changed = !existing.found || existing.text !== text;
  if (changed && !dryRun) {
    uploadFromTempFile(
      rcloneBin,
      targetPath,
      text,
      "uk_aq_hierarchical_inventory_",
    );
  }
  return {
    changed,
    written: changed && !dryRun,
    hash: sha256Hex(text),
    size: Buffer.byteLength(text, "utf8"),
  };
}

function entryRelativePath(entry) {
  return String(entry?.Path || entry?.Name || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function entryMetadata(entry) {
  const hashes = entry?.Hashes && typeof entry.Hashes === "object"
    ? entry.Hashes
    : {};
  const size = Number(entry?.Size);
  return {
    size: Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : null,
    r2_md5: String(hashes.md5 || hashes.MD5 || "").trim() || null,
    r2_modtime: String(entry?.ModTime || "").trim() || null,
  };
}

function previousRunUnitMap(previousRunShard) {
  return new Map(
    (previousRunShard?.units || [])
      .map((entry) => [String(entry.unit_key || ""), entry]),
  );
}

function scanRunManifestUnits({
  rcloneBin,
  sourceRoot,
  runsPrefix,
  previousRunShard,
}) {
  const previous = previousRunUnitMap(previousRunShard);
  const entries = rcloneLsjsonRecursive(
    rcloneBin,
    joinTargetPath(sourceRoot, runsPrefix),
    { hash: true, maxDepth: 2 },
  );
  const units = [];
  let reused = 0;
  let read = 0;
  for (const entry of entries) {
    const relative = entryRelativePath(entry);
    const match = /^(run_id=[^/]+\/run_manifest\.json)$/.exec(relative);
    if (!match) continue;
    const unitKey = match[1];
    const relativePath = `${runsPrefix}/${unitKey}`;
    const metadata = entryMetadata(entry);
    const prior = previous.get(unitKey);
    const metadataMatches = prior
      && Number(prior.size) === metadata.size
      && metadata.r2_md5
      && prior.r2_md5 === metadata.r2_md5;
    if (metadataMatches && prior.hash) {
      units.push({ ...prior });
      reused += 1;
      continue;
    }
    const text = rcloneCat(
      rcloneBin,
      joinTargetPath(sourceRoot, relativePath),
    );
    units.push({
      unit_key: unitKey,
      relative_path: relativePath,
      hash: sha256Hex(text),
      size: Buffer.byteLength(text, "utf8"),
      r2_md5: metadata.r2_md5,
    });
    read += 1;
  }
  units.sort((left, right) => left.unit_key.localeCompare(right.unit_key));
  return { units, listed: units.length, reused, read };
}

function previousYearMap(previousRoot) {
  return new Map(
    (previousRoot?.observations?.years || [])
      .map((entry) => [String(entry.year), entry]),
  );
}

function previousMonthMap(yearEntry) {
  return new Map(
    (yearEntry?.months || [])
      .map((entry) => [String(entry.month), entry]),
  );
}

function parseDayManifestHash(manifest, relativePath) {
  const hash = String(manifest?.manifest_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Day manifest has invalid manifest_hash: ${relativePath}`);
  }
  return hash;
}

function fullScanDayManifestMap({
  rcloneBin,
  sourceRoot,
  observationsPrefix,
}) {
  const entries = rcloneLsjsonRecursive(
    rcloneBin,
    joinTargetPath(sourceRoot, observationsPrefix),
    { hash: false, maxDepth: 2 },
  );
  const days = new Map();
  for (const entry of entries) {
    const relative = entryRelativePath(entry);
    const match = /^day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/.exec(relative);
    if (!match) continue;
    const dayUtc = match[1];
    const manifestKey = `${observationsPrefix}/${relative}`;
    const { text, parsed } = readJson(rcloneBin, sourceRoot, manifestKey);
    days.set(dayUtc, {
      day_utc: dayUtc,
      manifest_key: manifestKey,
      manifest_hash: parseDayManifestHash(parsed, manifestKey),
      manifest_file_hash: sha256Hex(text),
      manifest_size: Buffer.byteLength(text, "utf8"),
    });
  }
  return days;
}


function readDayInventoryEntries({
  rcloneBin,
  sourceRoot,
  hierarchyDays,
  fullScanDays = null,
}) {
  return hierarchyDays.map((day) => {
    const cached = fullScanDays?.get(day.day_utc) || null;
    let actual = cached;
    if (!actual) {
      const { text, parsed } = readJson(
        rcloneBin,
        sourceRoot,
        day.manifest_key,
      );
      actual = {
        day_utc: day.day_utc,
        manifest_key: day.manifest_key,
        manifest_hash: parseDayManifestHash(parsed, day.manifest_key),
        manifest_file_hash: sha256Hex(text),
        manifest_size: Buffer.byteLength(text, "utf8"),
      };
    }
    if (actual.manifest_key !== day.manifest_key) {
      throw new Error(
        `Day ${day.day_utc} manifest path mismatch: hierarchy=${day.manifest_key} `
        + `actual=${actual.manifest_key}`,
      );
    }
    if (actual.manifest_hash !== day.manifest_hash) {
      throw new Error(
        `Day ${day.day_utc} manifest hash mismatch: hierarchy=${day.manifest_hash} `
        + `actual=${actual.manifest_hash}`,
      );
    }
    return {
      ...day,
      manifest_file_hash: actual.manifest_file_hash,
      manifest_size: actual.manifest_size,
    };
  });
}

function assertFullScanAgrees(hierarchyDays, fullScanDays) {
  const hierarchyMap = new Map(
    hierarchyDays.map((entry) => [entry.day_utc, entry]),
  );
  const errors = [];
  for (const [dayUtc, actual] of fullScanDays.entries()) {
    const expected = hierarchyMap.get(dayUtc);
    if (!expected) {
      errors.push(`unexpected committed day manifest ${dayUtc}`);
      continue;
    }
    if (expected.manifest_key !== actual.manifest_key) {
      errors.push(
        `${dayUtc} manifest path mismatch hierarchy=${expected.manifest_key} `
        + `actual=${actual.manifest_key}`,
      );
    }
    if (expected.manifest_hash !== actual.manifest_hash) {
      errors.push(
        `${dayUtc} manifest hash mismatch hierarchy=${expected.manifest_hash} `
        + `actual=${actual.manifest_hash}`,
      );
    }
  }
  for (const dayUtc of hierarchyMap.keys()) {
    if (!fullScanDays.has(dayUtc)) {
      errors.push(`hierarchy references missing committed day manifest ${dayUtc}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Full-scan hierarchy comparison failed (${errors.length} finding(s)): `
      + errors.slice(0, 20).join("; "),
    );
  }
}



function validateSourceRootManifest(raw, observationsPrefix) {
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(
    raw,
    { basePrefix: observationsPrefix },
  );
  if (canonical.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root) {
    throw new Error(
      `Expected observations root aggregate manifest, got ${canonical.kind}`,
    );
  }
  return {
    manifest: canonical,
    content_hash: canonical.content_hash,
    years: canonical.children.map((entry) => ({
      year: String(entry.year),
      manifest_key: entry.manifest_key,
      content_hash: entry.content_hash,
    })),
  };
}

function validateSourceYearManifest(raw, expectedYear, observationsPrefix) {
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(
    raw,
    { basePrefix: observationsPrefix },
  );
  if (canonical.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year) {
    throw new Error(
      `Expected observations year aggregate manifest, got ${canonical.kind}`,
    );
  }
  if (String(canonical.year) !== String(expectedYear)) {
    throw new Error(
      `Observations year manifest identity mismatch: expected ${expectedYear}, `
      + `got ${canonical.year}`,
    );
  }
  return {
    manifest: canonical,
    year: String(canonical.year),
    content_hash: canonical.content_hash,
    months: canonical.children.map((entry) => ({
      month: entry.month,
      manifest_key: entry.manifest_key,
      content_hash: entry.content_hash,
    })),
  };
}

function validateSourceMonthManifest(
  raw,
  expectedYear,
  expectedMonth,
  observationsPrefix,
) {
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(
    raw,
    { basePrefix: observationsPrefix },
  );
  if (canonical.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month) {
    throw new Error(
      `Expected observations month aggregate manifest, got ${canonical.kind}`,
    );
  }
  if (
    String(canonical.year) !== String(expectedYear)
    || canonical.month !== String(expectedMonth).padStart(2, "0")
  ) {
    throw new Error(
      `Observations month manifest identity mismatch: expected `
      + `${expectedYear}-${String(expectedMonth).padStart(2, "0")}`,
    );
  }
  return {
    manifest: canonical,
    year: String(canonical.year),
    month: canonical.month,
    content_hash: canonical.content_hash,
    days: canonical.children.map((entry) => ({ ...entry })),
  };
}

function assertHierarchyPaths({
  observationsPrefix,
  sourceRoot,
  yearManifests,
  monthManifests,
}) {
  for (const year of sourceRoot.years) {
    const expectedYearKey =
      `${observationsPrefix}/_manifests/year=${year.year}/manifest.json`;
    if (year.manifest_key !== expectedYearKey) {
      throw new Error(
        `Observations root has non-canonical year path for ${year.year}: `
        + `${year.manifest_key}; expected ${expectedYearKey}`,
      );
    }
  }
  for (const yearManifest of yearManifests) {
    for (const month of yearManifest.months) {
      const expectedMonthKey =
        `${observationsPrefix}/_manifests/year=${yearManifest.year}`
        + `/month=${month.month}/manifest.json`;
      if (month.manifest_key !== expectedMonthKey) {
        throw new Error(
          `Observations year has non-canonical month path for `
          + `${yearManifest.year}-${month.month}: ${month.manifest_key}; `
          + `expected ${expectedMonthKey}`,
        );
      }
    }
  }
  for (const monthManifest of monthManifests) {
    for (const day of monthManifest.days) {
      const expectedDayKey =
        `${observationsPrefix}/day_utc=${day.day_utc}/manifest.json`;
      if (day.manifest_key !== expectedDayKey) {
        throw new Error(
          `Observations month has non-canonical day path for ${day.day_utc}: `
          + `${day.manifest_key}; expected ${expectedDayKey}`,
        );
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const inventoryRootKey = `${args.inventory_root_prefix}/root.json`;
  const observationsRootManifestKey =
    `${args.observations_prefix}/_manifests/manifest.json`;

  const previousResult = readJsonMaybe(
    args.rclone_bin,
    args.source_root,
    inventoryRootKey,
  );
  const previousRoot = previousResult
    ? validateHierarchicalInventoryRoot(previousResult.parsed)
    : null;

  const { parsed: rootManifestRaw } = readJson(
    args.rclone_bin,
    args.source_root,
    observationsRootManifestKey,
  );
  const sourceRoot = validateSourceRootManifest(
    rootManifestRaw,
    args.observations_prefix,
  );
  const sourceRootUnchanged = previousRoot
    && previousRoot.observations.source_root_hash === sourceRoot.content_hash;
  const runManifestInventoryShardKey =
    `${args.inventory_root_prefix}/global/observation_run_manifests.json`;
  const previousRunShardResult = previousRoot
    ? readJsonMaybe(
      args.rclone_bin,
      args.source_root,
      previousRoot.global_units.observation_run_manifests.inventory_shard_key,
    )
    : null;
  const previousRunShard = previousRunShardResult
    ? validateObservationRunManifestInventoryShard(
      previousRunShardResult.parsed,
    )
    : null;


  const fullScanDays = args.full_scan
    ? fullScanDayManifestMap({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      observationsPrefix: args.observations_prefix,
    })
    : null;

  const previousYears = previousYearMap(previousRoot);
  const years = [];
  const changedMonthShards = [];
  const hierarchyDaysForAudit = [];
  const yearManifestsForPathCheck = [];
  const monthManifestsForPathCheck = [];
  let yearsInspected = 0;
  let yearsSkipped = 0;
  let monthsInspected = 0;
  let monthsSkipped = 0;

  for (const sourceYearEntry of sourceRoot.years) {
    const priorYear = previousYears.get(sourceYearEntry.year);
    if (
      !args.full_scan
      && priorYear
      && priorYear.content_hash === sourceYearEntry.content_hash
    ) {
      years.push({ ...priorYear });
      yearsSkipped += 1;
      continue;
    }

    yearsInspected += 1;
    const { parsed: yearManifestRaw } = readJson(
      args.rclone_bin,
      args.source_root,
      sourceYearEntry.manifest_key,
    );
    const yearManifest = validateSourceYearManifest(
      yearManifestRaw,
      sourceYearEntry.year,
      args.observations_prefix,
    );
    yearManifestsForPathCheck.push(yearManifest);
    if (yearManifest.content_hash !== sourceYearEntry.content_hash) {
      throw new Error(
        `Year ${sourceYearEntry.year} content_hash differs from root child identity`,
      );
    }

    const priorMonths = previousMonthMap(priorYear);
    const months = [];
    for (const sourceMonthEntry of yearManifest.months) {
      const priorMonth = priorMonths.get(sourceMonthEntry.month);
      if (
        !args.full_scan
        && priorMonth
        && priorMonth.content_hash === sourceMonthEntry.content_hash
      ) {
        months.push({ ...priorMonth });
        monthsSkipped += 1;
        continue;
      }

      monthsInspected += 1;
      const { parsed: monthManifestRaw } = readJson(
        args.rclone_bin,
        args.source_root,
        sourceMonthEntry.manifest_key,
      );
      const monthManifest = validateSourceMonthManifest(
        monthManifestRaw,
        sourceYearEntry.year,
        sourceMonthEntry.month,
        args.observations_prefix,
      );
      monthManifestsForPathCheck.push(monthManifest);
      if (monthManifest.content_hash !== sourceMonthEntry.content_hash) {
        throw new Error(
          `Month ${sourceYearEntry.year}-${sourceMonthEntry.month} `
          + "content_hash differs from year child identity",
        );
      }
      const inventoryDays = readDayInventoryEntries({
        rcloneBin: args.rclone_bin,
        sourceRoot: args.source_root,
        hierarchyDays: monthManifest.days,
        fullScanDays,
      });
      hierarchyDaysForAudit.push(...inventoryDays);

      const shardKey = observationMonthInventoryShardKey(
        args.inventory_root_prefix,
        sourceYearEntry.year,
        sourceMonthEntry.month,
      );
      const shard = buildObservationMonthInventoryShard({
        observationsPrefix: args.observations_prefix,
        year: sourceYearEntry.year,
        month: sourceMonthEntry.month,
        sourceMonthManifestKey: sourceMonthEntry.manifest_key,
        sourceMonthHash: sourceMonthEntry.content_hash,
        days: inventoryDays,
      });
      const writeResult = writeRemoteJson({
        rcloneBin: args.rclone_bin,
        sourceRoot: args.source_root,
        relativePath: shardKey,
        payload: shard,
        dryRun: args.dry_run,
      });
      changedMonthShards.push({
        year: sourceYearEntry.year,
        month: sourceMonthEntry.month,
        shard_key: shardKey,
        changed: writeResult.changed,
        written: writeResult.written,
        day_count: shard.days.length,
      });
      months.push({
        month: sourceMonthEntry.month,
        manifest_key: sourceMonthEntry.manifest_key,
        content_hash: sourceMonthEntry.content_hash,
        inventory_shard_key: shardKey,
      });
    }

    years.push({
      year: sourceYearEntry.year,
      manifest_key: sourceYearEntry.manifest_key,
      content_hash: sourceYearEntry.content_hash,
      months,
    });
  }

  assertHierarchyPaths({
    observationsPrefix: args.observations_prefix,
    sourceRoot,
    yearManifests: yearManifestsForPathCheck,
    monthManifests: monthManifestsForPathCheck,
  });

  if (args.full_scan) {
    assertFullScanAgrees(hierarchyDaysForAudit, fullScanDays);
  }

  const runScan = scanRunManifestUnits({
    rcloneBin: args.rclone_bin,
    sourceRoot: args.source_root,
    runsPrefix: args.runs_prefix,
    previousRunShard,
  });

  const runManifestInventoryShard =
    buildObservationRunManifestInventoryShard(runScan.units);
  const runManifestShardWrite = writeRemoteJson({
    rcloneBin: args.rclone_bin,
    sourceRoot: args.source_root,
    relativePath: runManifestInventoryShardKey,
    payload: runManifestInventoryShard,
    dryRun: args.dry_run,
  });

  const root = buildHierarchicalInventoryRoot({
    observationsRootManifestKey,
    observationsRootHash: sourceRoot.content_hash,
    years,
    runManifestInventoryShardKey,
    runManifestInventoryShardHash: runManifestShardWrite.hash,
    runManifestUnitCount: runScan.units.length,
    legacyInventoryKey: args.legacy_inventory_key,
  });
  const rootWrite = writeRemoteJson({
    rcloneBin: args.rclone_bin,
    sourceRoot: args.source_root,
    relativePath: inventoryRootKey,
    payload: root,
    dryRun: args.dry_run,
  });

  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    inventory_mode: args.full_scan ? "full_scan" : "hierarchical",
    source_root: args.source_root,
    observations_prefix: args.observations_prefix,
    observations_root_manifest_key: observationsRootManifestKey,
    observations_source_root_hash: sourceRoot.content_hash,
    previous_source_root_hash:
      previousRoot?.observations?.source_root_hash || null,
    source_root_unchanged: Boolean(sourceRootUnchanged),
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
    run_manifests: {
      listed: runScan.listed,
      reused_by_metadata: runScan.reused,
      read_and_hashed: runScan.read,
      inventory_shard_key: runManifestInventoryShardKey,
      inventory_shard_changed: runManifestShardWrite.changed,
      inventory_shard_written: runManifestShardWrite.written,
    },
    compatibility: {
      legacy_inventory_key: args.legacy_inventory_key,
      legacy_inventory_retained: true,
    },
  };
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ok: false, error: message };
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  });
}
