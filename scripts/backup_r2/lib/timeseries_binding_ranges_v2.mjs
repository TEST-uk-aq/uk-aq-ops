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

export const TIMESERIES_BINDING_RANGE_SIZE = 1000;
export const TIMESERIES_BINDING_RANGE_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_timeseries_binding_range";
export const TIMESERIES_BINDING_ROOT_INVENTORY_KIND =
  "uk_aq_r2_history_backup_inventory_timeseries_binding_root";
export const TIMESERIES_BINDING_RANGE_STATE_KIND =
  "uk_aq_r2_history_backup_state_timeseries_binding_range";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_FILE_PATTERN = /^timeseries_id=([1-9]\d*)\.json$/;

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
  return `range=${String(start).padStart(6, "0")}-${String(end).padStart(6, "0")}`;
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

function normalizeInventoryUnit(entry) {
  return {
    timeseries_id: normalizeTimeseriesId(entry.timeseries_id),
    relative_path: normalizeRelativePath(entry.relative_path),
    hash: assertSha256(entry.hash, "timeseries binding hash"),
    size: Number.isFinite(Number(entry.size))
      ? Math.max(0, Math.trunc(Number(entry.size)))
      : null,
    r2_md5: String(entry.r2_md5 || "").trim() || null,
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
  const key = timeseriesBindingRangeKey(rangeStart, rangeEnd);
  const start = Number(key.slice(6, 12));
  const end = Number(key.slice(13, 19));
  const normalizedUnits = [...units]
    .map(normalizeInventoryUnit)
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  const seen = new Set();
  for (const unit of normalizedUnits) {
    if (unit.timeseries_id < start || unit.timeseries_id > end) {
      throw new Error(`Timeseries binding ${unit.timeseries_id} is outside ${key}`);
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
    range_start: start,
    range_end: end,
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
  for (const range of normalizedRanges) {
    timeseriesBindingRangeKey(range.range_start, range.range_end);
  }
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
  return {
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
      ? reference.ranges.map((entry) => ({
        range_start: Number(entry.range_start),
        range_end: Number(entry.range_end),
        source_range_hash: assertSha256(
          entry.source_range_hash,
          "timeseries binding source_range_hash",
        ),
        inventory_shard_key: normalizeRelativePath(entry.inventory_shard_key),
        unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
      })).sort((left, right) => left.range_start - right.range_start)
      : [],
  };
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

function legacyUnitMap(legacyInventory) {
  const units = legacyInventory?.index_tree_units?.timeseries_binding_v2?.units;
  if (!units || typeof units !== "object" || Array.isArray(units)) return new Map();
  const out = new Map();
  for (const [unitKey, entry] of Object.entries(units)) {
    const candidate = String(entry?.relative_path || unitKey || "");
    const match = /(?:^|\/)timeseries_id=([1-9]\d*)\.json$/.exec(candidate);
    const hash = String(entry?.hash || "").trim().toLowerCase();
    if (!match || !SHA256_PATTERN.test(hash)) continue;
    const size = Number(entry?.size);
    out.set(Number(match[1]), {
      timeseries_id: Number(match[1]),
      relative_path: String(entry?.relative_path || "").trim(),
      hash,
      size: Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : null,
      r2_md5: String(entry?.r2_md5 || "").trim() || null,
      r2_modtime: String(entry?.r2_modtime || "").trim() || null,
    });
  }
  return out;
}

function rangeUnitMap(rangeShards) {
  const out = new Map();
  for (const shard of rangeShards) {
    for (const unit of shard.units) {
      out.set(unit.timeseries_id, { ...unit });
    }
  }
  return out;
}

function metadataMatches(current, previous) {
  if (!previous || !previous.hash) return false;
  if (
    current.size === null
    || previous.size === null
    || current.size !== previous.size
  ) return false;
  if (current.r2_md5 && previous.r2_md5) {
    return current.r2_md5 === previous.r2_md5;
  }
  return Boolean(
    current.r2_modtime
    && previous.r2_modtime
    && current.r2_modtime === previous.r2_modtime
  );
}

function groupByRange(units) {
  const groups = new Map();
  for (const unit of units) {
    const { range_start: rangeStart } = timeseriesBindingRangeBounds(
      unit.timeseries_id,
    );
    if (!groups.has(rangeStart)) groups.set(rangeStart, []);
    groups.get(rangeStart).push(unit);
  }
  return groups;
}

export function buildTimeseriesBindingRangeStateSkeleton(rangeStart, rangeEnd) {
  const key = timeseriesBindingRangeKey(rangeStart, rangeEnd);
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_RANGE_STATE_KIND,
    backup_version: "v2",
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    range_start: Number(key.slice(6, 12)),
    range_end: Number(key.slice(13, 19)),
    processed_source_range_hash: null,
    units: [],
  };
}

export function buildTimeseriesBindingInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  inventoryRootPrefix,
  previousRootReference = null,
  legacyInventoryKey,
  fullScan = false,
  dryRun = false,
}) {
  const previousReference = validateTimeseriesBindingRootReference(
    previousRootReference,
  );
  const previousRangeShards = [];
  if (previousReference) {
    for (const range of previousReference.ranges) {
      const raw = readJsonMaybe(
        rcloneBin,
        sourceRoot,
        range.inventory_shard_key,
      );
      if (!raw) {
        throw new Error(
          `Timeseries binding inventory range missing: ${range.inventory_shard_key}`,
        );
      }
      previousRangeShards.push(
        validateTimeseriesBindingRangeInventoryShard(raw),
      );
    }
  }

  let previousUnits = rangeUnitMap(previousRangeShards);
  let previousUnitSource = previousUnits.size > 0 ? "hierarchical" : null;
  if (previousUnits.size === 0 && legacyInventoryKey) {
    const legacy = readJsonMaybe(rcloneBin, sourceRoot, legacyInventoryKey);
    previousUnits = legacyUnitMap(legacy);
    if (previousUnits.size > 0) previousUnitSource = "legacy";
  }

  const entries = rcloneLsjsonRecursive(
    rcloneBin,
    joinTargetPath(sourceRoot, sourcePrefix),
    { hash: true, maxDepth: 1 },
  );
  const units = [];
  let reused = 0;
  let reusedFromLegacy = 0;
  let readAndHashed = 0;

  for (const entry of entries) {
    const relative = entryRelativePath(entry);
    const match = BINDING_FILE_PATTERN.exec(relative);
    if (!match) continue;
    const timeseriesId = Number(match[1]);
    const relativePath = `${sourcePrefix}/${relative}`;
    const metadata = entryMetadata(entry);
    const previous = previousUnits.get(timeseriesId) || null;
    if (!fullScan && metadataMatches(metadata, previous)) {
      units.push({
        ...previous,
        timeseries_id: timeseriesId,
        relative_path: relativePath,
        size: metadata.size,
        r2_md5: metadata.r2_md5,
        r2_modtime: metadata.r2_modtime,
      });
      reused += 1;
      if (previousUnitSource === "legacy") reusedFromLegacy += 1;
      continue;
    }
    const text = rcloneCat(
      rcloneBin,
      joinTargetPath(sourceRoot, relativePath),
    );
    units.push({
      timeseries_id: timeseriesId,
      relative_path: relativePath,
      hash: sha256Hex(text),
      size: Buffer.byteLength(text, "utf8"),
      r2_md5: metadata.r2_md5,
      r2_modtime: metadata.r2_modtime,
    });
    readAndHashed += 1;
  }
  units.sort((left, right) => left.timeseries_id - right.timeseries_id);

  const ranges = [];
  const rangeReports = [];
  const groups = groupByRange(units);
  for (const rangeStart of Array.from(groups.keys()).sort((a, b) => a - b)) {
    const rangeEnd = rangeStart + TIMESERIES_BINDING_RANGE_SIZE - 1;
    const shardKey = timeseriesBindingRangeInventoryShardKey(
      inventoryRootPrefix,
      rangeStart,
      rangeEnd,
    );
    const shard = buildTimeseriesBindingRangeInventoryShard({
      sourcePrefix,
      rangeStart,
      rangeEnd,
      units: groups.get(rangeStart),
    });
    const writeResult = writeRemoteJson({
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
    rangeReports.push({
      ...summary,
      changed: writeResult.changed,
      written: writeResult.written,
    });
  }

  const inventoryRootKey = timeseriesBindingInventoryRootKey(
    inventoryRootPrefix,
  );
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
    root_reference: {
      range_size: TIMESERIES_BINDING_RANGE_SIZE,
      inventory_root_key: inventoryRootKey,
      inventory_root_hash: rootWrite.hash,
      source_root_hash: bindingRoot.source_root_hash,
      ranges,
    },
    report: {
      source_prefix: sourcePrefix,
      range_size: TIMESERIES_BINDING_RANGE_SIZE,
      previous_unit_source: previousUnitSource,
      listed: units.length,
      reused_by_metadata: reused,
      reused_from_legacy: reusedFromLegacy,
      read_and_hashed: readAndHashed,
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
