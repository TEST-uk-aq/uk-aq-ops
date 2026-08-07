import path from "node:path";

import {
  joinTargetPath,
  rcloneCat,
  rcloneCatMaybe,
  rcloneLsjsonFile,
  rcloneLsjsonRecursive,
  uploadFromTempFile,
} from "./rclone.mjs";
import {
  normalizeRelativePath,
  sha256Hex,
  stableJson,
} from "./hierarchical_backup_v2.mjs";
import {
  TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
  timeseriesBindingSourceRootKey,
  validateTimeseriesBindingSourceRangeManifest,
  validateTimeseriesBindingSourceRootManifest,
} from "./timeseries_binding_source_hierarchy_v2.mjs";

export const TIMESERIES_BINDING_RANGE_SIZE = 1000;
export const TIMESERIES_BINDING_RANGE_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_timeseries_binding_range";
export const TIMESERIES_BINDING_ROOT_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_timeseries_binding_root";
export const TIMESERIES_BINDING_RANGE_STATE_KIND =
  "uk_aq_r2_history_backup_state_timeseries_binding_range";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_FILE_PATTERN = /^timeseries_id=([1-9]\d*)\.json$/;

if (TIMESERIES_BINDING_SOURCE_RANGE_SIZE !== TIMESERIES_BINDING_RANGE_SIZE) {
  throw new Error("Timeseries binding source/backup range size mismatch");
}

function assertSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  }
  return normalized;
}

function normalizeTimeseriesId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid timeseries_id: ${value}`);
  }
  return id;
}

function normalizeRangeBounds(rangeStart, rangeEnd = null) {
  const start = Number(rangeStart);
  const expectedEnd = start + TIMESERIES_BINDING_RANGE_SIZE - 1;
  const end = rangeEnd === null ? expectedEnd : Number(rangeEnd);
  if (
    !Number.isSafeInteger(start)
    || start < 0
    || start % TIMESERIES_BINDING_RANGE_SIZE !== 0
    || !Number.isSafeInteger(end)
    || end !== expectedEnd
  ) {
    throw new Error(`Invalid timeseries binding range ${rangeStart}-${rangeEnd}`);
  }
  return { range_start: start, range_end: end };
}

export function timeseriesBindingRangeBounds(timeseriesId) {
  const id = normalizeTimeseriesId(timeseriesId);
  const rangeStart = Math.floor(id / TIMESERIES_BINDING_RANGE_SIZE)
    * TIMESERIES_BINDING_RANGE_SIZE;
  return {
    range_start: rangeStart,
    range_end: rangeStart + TIMESERIES_BINDING_RANGE_SIZE - 1,
  };
}

export function timeseriesBindingRangeKey(rangeStart, rangeEnd = null) {
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  return `range=${String(bounds.range_start).padStart(6, "0")}`
    + `-${String(bounds.range_end).padStart(6, "0")}`;
}

export function timeseriesBindingRangeInventoryShardKey(
  inventoryRootPrefix,
  rangeStart,
  rangeEnd = null,
) {
  return `${normalizeRelativePath(inventoryRootPrefix, "inventory root prefix")}`
    + `/timeseries_binding/${timeseriesBindingRangeKey(rangeStart, rangeEnd)}.json`;
}

export function timeseriesBindingInventoryRootKey(inventoryRootPrefix) {
  return `${normalizeRelativePath(inventoryRootPrefix, "inventory root prefix")}`
    + "/timeseries_binding/root.json";
}

export function timeseriesBindingRangeStateShardKey(
  stateRootPrefix,
  rangeStart,
  rangeEnd = null,
) {
  return `${normalizeRelativePath(stateRootPrefix, "state root prefix")}`
    + `/timeseries_binding/${timeseriesBindingRangeKey(rangeStart, rangeEnd)}.json`;
}

function normalizeInventoryUnit(entry) {
  return {
    timeseries_id: normalizeTimeseriesId(entry.timeseries_id),
    relative_path: normalizeRelativePath(entry.relative_path),
    hash: assertSha256(entry.hash, "timeseries binding hash"),
    size: Number.isSafeInteger(Number(entry.size)) && Number(entry.size) >= 0
      ? Number(entry.size)
      : null,
    r2_md5: String(entry.r2_md5 || "").trim().replace(/^"|"$/g, "") || null,
    r2_modtime: String(entry.r2_modtime || "").trim() || null,
  };
}

function rangeSourceHash(units) {
  const hashUnits = [...units]
    .map(normalizeInventoryUnit)
    .sort((left, right) => left.timeseries_id - right.timeseries_id)
    .map((entry) => ({
      timeseries_id: entry.timeseries_id,
      relative_path: entry.relative_path,
      hash: entry.hash,
      size: entry.size,
    }));
  return sha256Hex(
    `uk_aq:r2_history:v2:timeseries_binding_range:v1\n${JSON.stringify(hashUnits)}`,
  );
}

function rootSourceHash(ranges) {
  const hashRanges = [...ranges]
    .map((entry) => ({
      range_start: Number(entry.range_start),
      range_end: Number(entry.range_end),
      source_range_hash: assertSha256(
        entry.source_range_hash,
        "timeseries binding source_range_hash",
      ),
      inventory_shard_key: normalizeRelativePath(entry.inventory_shard_key),
      unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
    }))
    .sort((left, right) => left.range_start - right.range_start);
  return sha256Hex(
    `uk_aq:r2_history:v2:timeseries_binding_root:v1\n${JSON.stringify(hashRanges)}`,
  );
}

export function buildTimeseriesBindingRangeInventoryShard({
  sourcePrefix,
  rangeStart,
  rangeEnd,
  units,
}) {
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  const normalizedUnits = [...units]
    .map(normalizeInventoryUnit)
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  const seen = new Set();
  for (const unit of normalizedUnits) {
    if (
      unit.timeseries_id < bounds.range_start
      || unit.timeseries_id > bounds.range_end
    ) {
      throw new Error(
        `Timeseries binding ${unit.timeseries_id} outside range `
        + `${bounds.range_start}-${bounds.range_end}`,
      );
    }
    if (seen.has(unit.timeseries_id)) {
      throw new Error(`Duplicate timeseries binding ${unit.timeseries_id}`);
    }
    seen.add(unit.timeseries_id);
  }
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_RANGE_INVENTORY_KIND,
    backup_version: "v2",
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    range_start: bounds.range_start,
    range_end: bounds.range_end,
    source_prefix: normalizeRelativePath(sourcePrefix, "timeseries binding prefix"),
    source_range_hash: rangeSourceHash(normalizedUnits),
    units: normalizedUnits,
  };
}

export function validateTimeseriesBindingRangeInventoryShard(shard) {
  if (!shard || typeof shard !== "object" || Array.isArray(shard)) {
    throw new Error("Timeseries binding range inventory shard must be an object");
  }
  if (
    Number(shard.schema_version) !== 1
    || shard.kind !== TIMESERIES_BINDING_RANGE_INVENTORY_KIND
    || shard.backup_version !== "v2"
    || Number(shard.range_size) !== TIMESERIES_BINDING_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding range inventory shard identity mismatch");
  }
  const canonical = buildTimeseriesBindingRangeInventoryShard({
    sourcePrefix: shard.source_prefix,
    rangeStart: shard.range_start,
    rangeEnd: shard.range_end,
    units: Array.isArray(shard.units) ? shard.units : [],
  });
  if (canonical.source_range_hash !== shard.source_range_hash) {
    throw new Error("Timeseries binding range source_range_hash mismatch");
  }
  return canonical;
}

export function buildTimeseriesBindingRootInventory({ sourcePrefix, ranges }) {
  const normalizedRanges = [...ranges]
    .map((entry) => {
      const bounds = normalizeRangeBounds(entry.range_start, entry.range_end);
      return {
        range_start: bounds.range_start,
        range_end: bounds.range_end,
        source_range_hash: assertSha256(
          entry.source_range_hash,
          "timeseries binding source_range_hash",
        ),
        inventory_shard_key: normalizeRelativePath(entry.inventory_shard_key),
        unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
      };
    })
    .sort((left, right) => left.range_start - right.range_start);
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_ROOT_INVENTORY_KIND,
    backup_version: "v2",
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    source_prefix: normalizeRelativePath(sourcePrefix, "timeseries binding prefix"),
    source_root_hash: rootSourceHash(normalizedRanges),
    ranges: normalizedRanges,
  };
}

export function validateTimeseriesBindingRootInventory(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Timeseries binding inventory root must be an object");
  }
  if (
    Number(root.schema_version) !== 1
    || root.kind !== TIMESERIES_BINDING_ROOT_INVENTORY_KIND
    || root.backup_version !== "v2"
    || Number(root.range_size) !== TIMESERIES_BINDING_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding inventory root identity mismatch");
  }
  const canonical = buildTimeseriesBindingRootInventory({
    sourcePrefix: root.source_prefix,
    ranges: Array.isArray(root.ranges) ? root.ranges : [],
  });
  if (canonical.source_root_hash !== root.source_root_hash) {
    throw new Error("Timeseries binding inventory root source_root_hash mismatch");
  }
  return canonical;
}

export function validateTimeseriesBindingRootReference(reference) {
  if (!reference) return null;
  if (typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Timeseries binding root reference must be an object");
  }
  if (Number(reference.range_size) !== TIMESERIES_BINDING_RANGE_SIZE) {
    throw new Error("Timeseries binding root reference range_size mismatch");
  }
  const normalized = {
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    inventory_root_key: normalizeRelativePath(reference.inventory_root_key),
    inventory_root_hash: assertSha256(
      reference.inventory_root_hash,
      "timeseries binding inventory_root_hash",
    ),
    source_root_hash: assertSha256(
      reference.source_root_hash,
      "timeseries binding source_root_hash",
    ),
    ranges: Array.isArray(reference.ranges)
      ? reference.ranges.map((entry) => {
        const bounds = normalizeRangeBounds(entry.range_start, entry.range_end);
        return {
          range_start: bounds.range_start,
          range_end: bounds.range_end,
          source_range_hash: assertSha256(
            entry.source_range_hash,
            "timeseries binding source_range_hash",
          ),
          inventory_shard_key: normalizeRelativePath(entry.inventory_shard_key),
          unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
        };
      }).sort((left, right) => left.range_start - right.range_start)
      : [],
  };
  if (reference.source_manifest_root_key) {
    normalized.source_manifest_root_key = normalizeRelativePath(
      reference.source_manifest_root_key,
    );
  }
  if (reference.source_manifest_root_hash) {
    normalized.source_manifest_root_hash = assertSha256(
      reference.source_manifest_root_hash,
      "timeseries binding source manifest root hash",
    );
  }
  return normalized;
}

function readJsonMaybe(rcloneBin, sourceRoot, relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const parentRelativePath = path.posix.dirname(normalizedPath);
  const fileName = path.posix.basename(normalizedPath);
  const parentPath = joinTargetPath(
    sourceRoot,
    parentRelativePath === "." ? "" : parentRelativePath,
  );
  const entry = rcloneLsjsonFile(rcloneBin, parentPath, fileName);
  if (!entry) return null;
  const text = rcloneCat(rcloneBin, joinTargetPath(sourceRoot, normalizedPath));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON at ${normalizedPath}: ${error?.message || error}`);
  }
}

function writeRemoteJson({ rcloneBin, sourceRoot, relativePath, payload, dryRun }) {
  const text = stableJson(payload);
  const targetPath = joinTargetPath(sourceRoot, relativePath);
  const existing = rcloneCatMaybe(rcloneBin, targetPath);
  const changed = !existing.found || existing.text !== text;
  if (changed && !dryRun) {
    uploadFromTempFile(
      rcloneBin,
      targetPath,
      text,
      "uk_aq_timeseries_binding_inventory_",
    );
  }
  return {
    changed,
    written: changed && !dryRun,
    hash: sha256Hex(text),
  };
}

export function buildTimeseriesBindingRangeStateSkeleton(rangeStart, rangeEnd) {
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_RANGE_STATE_KIND,
    backup_version: "v2",
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    range_start: bounds.range_start,
    range_end: bounds.range_end,
    processed_source_range_hash: null,
    units: [],
  };
}

function sourceUnitsToBackupUnits(sourceRange) {
  return sourceRange.units.map((entry) => ({
    timeseries_id: entry.timeseries_id,
    relative_path: entry.relative_path,
    hash: entry.sha256,
    size: entry.size,
    r2_md5: entry.r2_md5,
    r2_modtime: null,
  }));
}

function sourceRangeMatchesBackupRange(sourceRangeRef, backupRangeRef, expectedShardKey) {
  return Boolean(
    backupRangeRef
    && backupRangeRef.range_start === sourceRangeRef.range_start
    && backupRangeRef.range_end === sourceRangeRef.range_end
    && backupRangeRef.source_range_hash === sourceRangeRef.source_range_hash
    && backupRangeRef.unit_count === sourceRangeRef.unit_count
    && backupRangeRef.inventory_shard_key === expectedShardKey
  );
}

function buildRootReference({
  inventoryRootKey,
  rootWrite,
  bindingRoot,
  ranges,
  sourceManifestRootKey,
  sourceManifestRootHash,
}) {
  return {
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    inventory_root_key: inventoryRootKey,
    inventory_root_hash: rootWrite.hash,
    source_root_hash: bindingRoot.source_root_hash,
    source_manifest_root_key: sourceManifestRootKey,
    source_manifest_root_hash: sourceManifestRootHash,
    ranges,
  };
}

function buildNormalInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  inventoryRootPrefix,
  previousReference,
  dryRun,
}) {
  const sourceManifestRootKey = timeseriesBindingSourceRootKey(sourcePrefix);
  const sourceRootRaw = readJsonMaybe(
    rcloneBin,
    sourceRoot,
    sourceManifestRootKey,
  );
  if (!sourceRootRaw) {
    throw new Error(
      `Authoritative timeseries binding source hierarchy is missing: `
      + `${sourceManifestRootKey}. Run `
      + `scripts/backup_r2/uk_aq_refresh_timeseries_binding_source_hierarchy.mjs `
      + `before the normal backup inventory.`,
    );
  }
  const bindingSourceRoot = validateTimeseriesBindingSourceRootManifest(
    sourceRootRaw,
  );
  if (bindingSourceRoot.source_prefix !== sourcePrefix) {
    throw new Error("Timeseries binding source hierarchy prefix mismatch");
  }

  const inventoryRootKey = timeseriesBindingInventoryRootKey(inventoryRootPrefix);
  if (
    previousReference
    && previousReference.source_manifest_root_key === sourceManifestRootKey
    && previousReference.source_manifest_root_hash
      === bindingSourceRoot.source_root_hash
  ) {
    return {
      root_reference: previousReference,
      report: {
        source_prefix: sourcePrefix,
        range_size: TIMESERIES_BINDING_RANGE_SIZE,
        previous_unit_source: "hierarchical_source_root_match",
        physical_listing_performed: false,
        physical_listing_skipped: true,
        physical_bindings_listed: 0,
        listed: bindingSourceRoot.unit_count,
        reused_by_metadata: 0,
        reused_from_legacy: 0,
        read_and_hashed: 0,
        source_manifest_root_key: sourceManifestRootKey,
        source_manifest_root_hash: bindingSourceRoot.source_root_hash,
        source_ranges_inspected: 0,
        source_ranges_skipped_by_hash: bindingSourceRoot.ranges.length,
        range_count: previousReference.ranges.length,
        range_shards_changed: 0,
        range_shards_written: 0,
        ranges: previousReference.ranges.map((entry) => ({
          ...entry,
          changed: false,
          written: false,
          skipped_by_source_hash: true,
        })),
        inventory_root_key: inventoryRootKey,
        source_root_hash: previousReference.source_root_hash,
        inventory_root_changed: false,
        inventory_root_written: false,
      },
    };
  }

  const previousRanges = new Map(
    (previousReference?.ranges || []).map((entry) => [entry.range_start, entry]),
  );
  const ranges = [];
  const rangeReports = [];
  let sourceRangesInspected = 0;
  let sourceRangesSkippedByHash = 0;

  for (const sourceRangeRef of bindingSourceRoot.ranges) {
    const expectedShardKey = timeseriesBindingRangeInventoryShardKey(
      inventoryRootPrefix,
      sourceRangeRef.range_start,
      sourceRangeRef.range_end,
    );
    const previousRange = previousRanges.get(sourceRangeRef.range_start) || null;
    if (
      sourceRangeMatchesBackupRange(
        sourceRangeRef,
        previousRange,
        expectedShardKey,
      )
    ) {
      ranges.push({ ...previousRange });
      rangeReports.push({
        ...previousRange,
        changed: false,
        written: false,
        skipped_by_source_hash: true,
      });
      sourceRangesSkippedByHash += 1;
      continue;
    }

    sourceRangesInspected += 1;
    const sourceRangeRaw = readJsonMaybe(
      rcloneBin,
      sourceRoot,
      sourceRangeRef.manifest_key,
    );
    if (!sourceRangeRaw) {
      throw new Error(
        `Timeseries binding source range missing: ${sourceRangeRef.manifest_key}`,
      );
    }
    const sourceRange = validateTimeseriesBindingSourceRangeManifest(
      sourceRangeRaw,
    );
    if (
      sourceRange.range_start !== sourceRangeRef.range_start
      || sourceRange.range_end !== sourceRangeRef.range_end
      || sourceRange.source_range_hash !== sourceRangeRef.source_range_hash
      || sourceRange.units.length !== sourceRangeRef.unit_count
    ) {
      throw new Error(
        `Timeseries binding source root/range mismatch: `
        + `${sourceRangeRef.manifest_key}`,
      );
    }
    const backupShard = buildTimeseriesBindingRangeInventoryShard({
      sourcePrefix,
      rangeStart: sourceRange.range_start,
      rangeEnd: sourceRange.range_end,
      units: sourceUnitsToBackupUnits(sourceRange),
    });
    if (backupShard.source_range_hash !== sourceRange.source_range_hash) {
      throw new Error(
        `Timeseries binding source/backup range hash mismatch: `
        + `${sourceRangeRef.manifest_key}`,
      );
    }
    const write = writeRemoteJson({
      rcloneBin,
      sourceRoot,
      relativePath: expectedShardKey,
      payload: backupShard,
      dryRun,
    });
    const summary = {
      range_start: sourceRange.range_start,
      range_end: sourceRange.range_end,
      source_range_hash: sourceRange.source_range_hash,
      inventory_shard_key: expectedShardKey,
      unit_count: sourceRange.units.length,
    };
    ranges.push(summary);
    rangeReports.push({
      ...summary,
      changed: write.changed,
      written: write.written,
      skipped_by_source_hash: false,
    });
  }

  const bindingRoot = buildTimeseriesBindingRootInventory({
    sourcePrefix,
    ranges,
  });
  const rootWrite = writeRemoteJson({
    rcloneBin,
    sourceRoot,
    relativePath: inventoryRootKey,
    payload: bindingRoot,
    dryRun,
  });

  return {
    root_reference: buildRootReference({
      inventoryRootKey,
      rootWrite,
      bindingRoot,
      ranges,
      sourceManifestRootKey,
      sourceManifestRootHash: bindingSourceRoot.source_root_hash,
    }),
    report: {
      source_prefix: sourcePrefix,
      range_size: TIMESERIES_BINDING_RANGE_SIZE,
      previous_unit_source: previousReference ? "hierarchical_source_ranges" : null,
      physical_listing_performed: false,
      physical_listing_skipped: true,
      physical_bindings_listed: 0,
      listed: bindingSourceRoot.unit_count,
      reused_by_metadata: 0,
      reused_from_legacy: 0,
      read_and_hashed: 0,
      source_manifest_root_key: sourceManifestRootKey,
      source_manifest_root_hash: bindingSourceRoot.source_root_hash,
      source_ranges_inspected: sourceRangesInspected,
      source_ranges_skipped_by_hash: sourceRangesSkippedByHash,
      range_count: ranges.length,
      range_shards_changed: rangeReports.filter((entry) => entry.changed).length,
      range_shards_written: rangeReports.filter((entry) => entry.written).length,
      ranges: rangeReports,
      inventory_root_key: inventoryRootKey,
      source_root_hash: bindingRoot.source_root_hash,
      inventory_root_changed: rootWrite.changed,
      inventory_root_written: rootWrite.written,
    },
  };
}

function entryRelativePath(entry) {
  return String(entry?.Path || entry?.Name || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function buildFullScanInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  inventoryRootPrefix,
  dryRun,
}) {
  const sourceManifestRootKey = timeseriesBindingSourceRootKey(sourcePrefix);
  const sourceRootRaw = readJsonMaybe(
    rcloneBin,
    sourceRoot,
    sourceManifestRootKey,
  );
  if (!sourceRootRaw) {
    throw new Error(
      `Cannot full-scan bindings without authoritative source root: `
      + `${sourceManifestRootKey}`,
    );
  }
  const bindingSourceRoot = validateTimeseriesBindingSourceRootManifest(
    sourceRootRaw,
  );
  const entries = rcloneLsjsonRecursive(
    rcloneBin,
    joinTargetPath(sourceRoot, sourcePrefix),
    { hash: true, maxDepth: 1 },
  );
  const units = [];
  for (const entry of entries) {
    const relative = entryRelativePath(entry);
    const match = BINDING_FILE_PATTERN.exec(relative);
    if (!match) continue;
    const timeseriesId = Number(match[1]);
    const relativePath = `${sourcePrefix}/${relative}`;
    const text = rcloneCat(rcloneBin, joinTargetPath(sourceRoot, relativePath));
    const hashes = entry?.Hashes && typeof entry.Hashes === "object"
      ? entry.Hashes
      : {};
    units.push({
      timeseries_id: timeseriesId,
      relative_path: relativePath,
      hash: sha256Hex(text),
      size: Buffer.byteLength(text, "utf8"),
      r2_md5: String(hashes.md5 || hashes.MD5 || "").trim() || null,
      r2_modtime: String(entry?.ModTime || "").trim() || null,
    });
  }
  units.sort((left, right) => left.timeseries_id - right.timeseries_id);

  const groups = new Map();
  for (const unit of units) {
    const bounds = timeseriesBindingRangeBounds(unit.timeseries_id);
    if (!groups.has(bounds.range_start)) groups.set(bounds.range_start, []);
    groups.get(bounds.range_start).push(unit);
  }
  const sourceRangesByStart = new Map(
    bindingSourceRoot.ranges.map((entry) => [entry.range_start, entry]),
  );
  if (groups.size !== sourceRangesByStart.size) {
    throw new Error("Full binding scan disagrees with source hierarchy range count");
  }

  const ranges = [];
  const rangeReports = [];
  for (const rangeStart of [...groups.keys()].sort((a, b) => a - b)) {
    const rangeEnd = rangeStart + TIMESERIES_BINDING_RANGE_SIZE - 1;
    const shard = buildTimeseriesBindingRangeInventoryShard({
      sourcePrefix,
      rangeStart,
      rangeEnd,
      units: groups.get(rangeStart),
    });
    const sourceRef = sourceRangesByStart.get(rangeStart);
    if (
      !sourceRef
      || sourceRef.source_range_hash !== shard.source_range_hash
      || sourceRef.unit_count !== shard.units.length
    ) {
      throw new Error(
        `Full binding scan disagrees with source range ${rangeStart}-${rangeEnd}`,
      );
    }
    const sourceRangeRaw = readJsonMaybe(
      rcloneBin,
      sourceRoot,
      sourceRef.manifest_key,
    );
    const sourceRange = sourceRangeRaw
      ? validateTimeseriesBindingSourceRangeManifest(sourceRangeRaw)
      : null;
    if (!sourceRange || sourceRange.source_range_hash !== shard.source_range_hash) {
      throw new Error(
        `Full binding scan cannot validate source range ${sourceRef.manifest_key}`,
      );
    }
    const sourceUnitMap = new Map(
      sourceRange.units.map((entry) => [entry.timeseries_id, entry]),
    );
    for (const unit of shard.units) {
      const sourceUnit = sourceUnitMap.get(unit.timeseries_id);
      if (
        !sourceUnit
        || sourceUnit.sha256 !== unit.hash
        || sourceUnit.relative_path !== unit.relative_path
        || sourceUnit.size !== unit.size
      ) {
        throw new Error(
          `Full binding scan disagrees with source unit ${unit.timeseries_id}`,
        );
      }
    }
    const shardKey = timeseriesBindingRangeInventoryShardKey(
      inventoryRootPrefix,
      rangeStart,
      rangeEnd,
    );
    const write = writeRemoteJson({
      rcloneBin,
      sourceRoot,
      relativePath: shardKey,
      payload: shard,
      dryRun,
    });
    const summary = {
      range_start: rangeStart,
      range_end: rangeEnd,
      source_range_hash: shard.source_range_hash,
      inventory_shard_key: shardKey,
      unit_count: shard.units.length,
    };
    ranges.push(summary);
    rangeReports.push({ ...summary, changed: write.changed, written: write.written });
  }

  const inventoryRootKey = timeseriesBindingInventoryRootKey(inventoryRootPrefix);
  const bindingRoot = buildTimeseriesBindingRootInventory({ sourcePrefix, ranges });
  const rootWrite = writeRemoteJson({
    rcloneBin,
    sourceRoot,
    relativePath: inventoryRootKey,
    payload: bindingRoot,
    dryRun,
  });

  return {
    root_reference: buildRootReference({
      inventoryRootKey,
      rootWrite,
      bindingRoot,
      ranges,
      sourceManifestRootKey,
      sourceManifestRootHash: bindingSourceRoot.source_root_hash,
    }),
    report: {
      source_prefix: sourcePrefix,
      range_size: TIMESERIES_BINDING_RANGE_SIZE,
      previous_unit_source: "independent_full_scan",
      physical_listing_performed: true,
      physical_listing_skipped: false,
      physical_bindings_listed: units.length,
      listed: units.length,
      reused_by_metadata: 0,
      reused_from_legacy: 0,
      read_and_hashed: units.length,
      source_manifest_root_key: sourceManifestRootKey,
      source_manifest_root_hash: bindingSourceRoot.source_root_hash,
      source_ranges_inspected: bindingSourceRoot.ranges.length,
      source_ranges_skipped_by_hash: 0,
      full_scan_source_hierarchy_agreed: true,
      range_count: ranges.length,
      range_shards_changed: rangeReports.filter((entry) => entry.changed).length,
      range_shards_written: rangeReports.filter((entry) => entry.written).length,
      ranges: rangeReports,
      inventory_root_key: inventoryRootKey,
      source_root_hash: bindingRoot.source_root_hash,
      inventory_root_changed: rootWrite.changed,
      inventory_root_written: rootWrite.written,
    },
  };
}

export function buildTimeseriesBindingInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  inventoryRootPrefix,
  previousRootReference = null,
  legacyInventoryKey: _legacyInventoryKey,
  fullScan = false,
  dryRun = false,
}) {
  const normalizedSourcePrefix = normalizeRelativePath(
    sourcePrefix,
    "timeseries binding source prefix",
  );
  const previousReference = validateTimeseriesBindingRootReference(
    previousRootReference,
  );
  if (fullScan) {
    return buildFullScanInventory({
      rcloneBin,
      sourceRoot,
      sourcePrefix: normalizedSourcePrefix,
      inventoryRootPrefix,
      dryRun,
    });
  }
  return buildNormalInventory({
    rcloneBin,
    sourceRoot,
    sourcePrefix: normalizedSourcePrefix,
    inventoryRootPrefix,
    previousReference,
    dryRun,
  });
}
