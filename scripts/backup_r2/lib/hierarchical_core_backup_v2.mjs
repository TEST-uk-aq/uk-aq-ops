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
  assertSha256,
  normalizeDay,
  normalizeRelativePath,
  sha256Hex,
  stableJson,
} from "./hierarchical_backup_v2.mjs";

const CORE_INVENTORY_KIND = "uk_aq_r2_history_backup_inventory_core";
const CORE_STATE_KIND = "uk_aq_r2_history_backup_state_core";
const CORE_MANIFEST_PATTERN = /^day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/;

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

function normalizeCoreDay(entry, sourcePrefix) {
  const dayUtc = normalizeDay(entry?.day_utc, "core day_utc");
  const prefix = normalizeRelativePath(sourcePrefix, "core source prefix");
  return {
    day_utc: dayUtc,
    relative_path: `${prefix}/day_utc=${dayUtc}`,
    manifest_key: `${prefix}/day_utc=${dayUtc}/manifest.json`,
    manifest_hash: assertSha256(entry?.manifest_hash, `core ${dayUtc} manifest hash`),
    manifest_size: Number.isFinite(Number(entry?.manifest_size))
      ? Math.max(0, Math.trunc(Number(entry.manifest_size)))
      : null,
    r2_md5: String(entry?.r2_md5 || "").trim() || null,
    r2_modtime: String(entry?.r2_modtime || "").trim() || null,
  };
}

function coreSourceHash(days) {
  const stableDays = days.map((entry) => ({
    day_utc: entry.day_utc,
    manifest_key: entry.manifest_key,
    manifest_hash: entry.manifest_hash,
    manifest_size: entry.manifest_size,
  }));
  return sha256Hex(
    `uk_aq:r2_history:v2:core:v1\n${JSON.stringify(stableDays)}`,
  );
}

function metadataMatches(current, previous) {
  if (!previous?.manifest_hash) return false;
  if (
    current.size === null
    || previous.manifest_size === null
    || current.size !== previous.manifest_size
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

function readJsonMaybe(rcloneBin, root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parent = path.posix.dirname(normalized);
  const entry = rcloneLsjsonFile(
    rcloneBin,
    joinTargetPath(root, parent === "." ? "" : parent),
    path.posix.basename(normalized),
  );
  if (!entry) return null;
  const text = rcloneCat(rcloneBin, joinTargetPath(root, normalized));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON at ${normalized}: ${error?.message || error}`);
  }
}

function writeRemoteJson({ rcloneBin, root, relativePath, payload, dryRun }) {
  const text = stableJson(payload);
  const target = joinTargetPath(root, relativePath);
  const existing = rcloneCatMaybe(rcloneBin, target);
  const changed = !existing.found || existing.text !== text;
  if (changed && !dryRun) {
    uploadFromTempFile(
      rcloneBin,
      target,
      text,
      "uk_aq_core_backup_inventory_",
    );
  }
  return {
    changed,
    written: changed && !dryRun,
    hash: sha256Hex(text),
  };
}

export function buildCoreInventoryShard(sourcePrefix, days) {
  const prefix = normalizeRelativePath(sourcePrefix, "core source prefix");
  const normalizedDays = [...days]
    .map((entry) => normalizeCoreDay(entry, prefix))
    .sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  return {
    schema_version: 1,
    kind: CORE_INVENTORY_KIND,
    backup_version: "v2",
    source_prefix: prefix,
    source_hash: coreSourceHash(normalizedDays),
    days: normalizedDays,
  };
}

export function validateCoreInventoryShard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Core inventory shard must be an object");
  }
  if (
    Number(raw.schema_version) !== 1
    || raw.kind !== CORE_INVENTORY_KIND
    || raw.backup_version !== "v2"
  ) {
    throw new Error("Core inventory shard identity mismatch");
  }
  const shard = buildCoreInventoryShard(raw.source_prefix, raw.days || []);
  if (shard.source_hash !== raw.source_hash) {
    throw new Error("Core inventory shard source_hash mismatch");
  }
  return shard;
}

export function validateCoreRootReference(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    source_prefix: normalizeRelativePath(raw.source_prefix, "core source prefix"),
    inventory_shard_key: normalizeRelativePath(raw.inventory_shard_key),
    inventory_shard_hash: assertSha256(
      raw.inventory_shard_hash,
      "core inventory shard hash",
    ),
    source_hash: assertSha256(raw.source_hash, "core source hash"),
    unit_count: Math.max(0, Math.trunc(Number(raw.unit_count) || 0)),
  };
}

function legacyInventoryDayMap(legacyInventory) {
  const raw = legacyInventory?.domains?.core?.days;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  return new Map(Object.entries(raw));
}

export function buildCoreInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  inventoryRootPrefix,
  previousRootReference = null,
  legacyInventoryKey,
  fullScan = false,
  dryRun = false,
}) {
  const prefix = normalizeRelativePath(sourcePrefix, "core source prefix");
  const shardKey = `${normalizeRelativePath(inventoryRootPrefix)}/global/core.json`;
  const previousReference = validateCoreRootReference(previousRootReference);
  const previousShard = previousReference
    ? validateCoreInventoryShard(
      readJsonMaybe(rcloneBin, sourceRoot, previousReference.inventory_shard_key),
    )
    : null;
  const previousDays = new Map(
    (previousShard?.days || []).map((entry) => [entry.day_utc, entry]),
  );
  let legacyDays = new Map();
  let previousSource = previousShard ? "hierarchical" : null;
  if (!previousShard && legacyInventoryKey) {
    const legacy = readJsonMaybe(rcloneBin, sourceRoot, legacyInventoryKey);
    legacyDays = legacyInventoryDayMap(legacy);
    if (legacyDays.size > 0) previousSource = "legacy";
  }

  const entries = rcloneLsjsonRecursive(
    rcloneBin,
    joinTargetPath(sourceRoot, prefix),
    { hash: true, maxDepth: 2 },
  );
  const days = [];
  let reused = 0;
  let readAndHashed = 0;
  for (const entry of entries) {
    const relative = String(entry?.Path || entry?.Name || "")
      .trim()
      .replace(/\\/g, "/");
    const match = CORE_MANIFEST_PATTERN.exec(relative);
    if (!match) continue;
    const dayUtc = normalizeDay(match[1], "core day_utc");
    const metadata = entryMetadata(entry);
    const prior = previousDays.get(dayUtc) || legacyDays.get(dayUtc) || null;
    if (!fullScan && metadataMatches(metadata, prior)) {
      days.push({
        day_utc: dayUtc,
        manifest_hash: prior.manifest_hash,
        manifest_size: metadata.size,
        r2_md5: metadata.r2_md5,
        r2_modtime: metadata.r2_modtime,
      });
      reused += 1;
      continue;
    }
    const manifestKey = `${prefix}/day_utc=${dayUtc}/manifest.json`;
    const text = rcloneCat(rcloneBin, joinTargetPath(sourceRoot, manifestKey));
    days.push({
      day_utc: dayUtc,
      manifest_hash: sha256Hex(text),
      manifest_size: Buffer.byteLength(text, "utf8"),
      r2_md5: metadata.r2_md5,
      r2_modtime: metadata.r2_modtime,
    });
    readAndHashed += 1;
  }

  const shard = buildCoreInventoryShard(prefix, days);
  const write = writeRemoteJson({
    rcloneBin,
    root: sourceRoot,
    relativePath: shardKey,
    payload: shard,
    dryRun,
  });
  return {
    root_reference: {
      source_prefix: prefix,
      inventory_shard_key: shardKey,
      inventory_shard_hash: write.hash,
      source_hash: shard.source_hash,
      unit_count: shard.days.length,
    },
    report: {
      source_prefix: prefix,
      previous_unit_source: previousSource,
      listed: shard.days.length,
      reused_by_metadata: reused,
      read_and_hashed: readAndHashed,
      inventory_shard_key: shardKey,
      source_hash: shard.source_hash,
      inventory_shard_changed: write.changed,
      inventory_shard_written: write.written,
    },
  };
}

function emptyCoreState() {
  return {
    schema_version: 1,
    kind: CORE_STATE_KIND,
    backup_version: "v2",
    processed_source_hash: null,
    days: [],
  };
}

export function validateCoreState(raw) {
  if (!raw) return emptyCoreState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Core state shard must be an object");
  }
  if (
    Number(raw.schema_version) !== 1
    || raw.kind !== CORE_STATE_KIND
    || raw.backup_version !== "v2"
  ) {
    throw new Error("Core state shard identity mismatch");
  }
  const days = Array.isArray(raw.days)
    ? raw.days.map((entry) => ({
      day_utc: normalizeDay(entry.day_utc, "core state day_utc"),
      manifest_hash: assertSha256(entry.manifest_hash, "core state manifest hash"),
      copied_at: String(entry.copied_at || "").trim() || null,
    })).sort((left, right) => left.day_utc.localeCompare(right.day_utc))
    : [];
  return {
    schema_version: 1,
    kind: CORE_STATE_KIND,
    backup_version: "v2",
    processed_source_hash: raw.processed_source_hash
      ? assertSha256(raw.processed_source_hash, "core processed source hash")
      : null,
    days,
  };
}

function migrateLegacyCoreState(inventory, legacyState) {
  const legacyDays = legacyState?.domains?.core?.days;
  const sourceDays = legacyDays && typeof legacyDays === "object"
    ? legacyDays
    : {};
  const state = emptyCoreState();
  state.days = inventory.days.flatMap((day) => {
    const legacy = sourceDays[day.day_utc];
    const legacyHash = String(legacy?.manifest_hash || "").trim().toLowerCase();
    if (legacyHash !== day.manifest_hash) return [];
    return [{
      day_utc: day.day_utc,
      manifest_hash: day.manifest_hash,
      copied_at: String(legacy?.copied_at || "").trim() || null,
    }];
  });
  if (coreStateIsComplete(state, inventory)) {
    state.processed_source_hash = inventory.source_hash;
  }
  return state;
}

function coreStateIsComplete(state, inventory) {
  const map = new Map(state.days.map((entry) => [entry.day_utc, entry]));
  return inventory.days.every(
    (day) => map.get(day.day_utc)?.manifest_hash === day.manifest_hash,
  );
}

export function syncCoreToDropbox({
  inventoryRoot,
  stateRoot,
  legacyState,
  stateRootPrefix,
  dryRun,
  checkpointBatchUnits,
  checkpointFlushSeconds,
  readInventoryJson,
  readStateJsonMaybe,
  writeStateJson,
  copyAndVerifyDay,
}) {
  const reference = validateCoreRootReference(inventoryRoot?.core);
  if (!reference) {
    throw new Error("Hierarchical inventory root is missing core");
  }
  const inventory = validateCoreInventoryShard(
    readInventoryJson(reference.inventory_shard_key),
  );
  const actualShardHash = sha256Hex(stableJson(inventory));
  if (
    actualShardHash !== reference.inventory_shard_hash
    || inventory.source_hash !== reference.source_hash
    || inventory.days.length !== reference.unit_count
  ) {
    throw new Error("Core inventory root/shard mismatch");
  }

  const stateShardKey = stateRoot?.core?.state_shard_key
    || `${normalizeRelativePath(stateRootPrefix)}/global/core.json`;
  const stateResult = readStateJsonMaybe(stateShardKey);
  let state = stateResult
    ? validateCoreState(stateResult.parsed)
    : migrateLegacyCoreState(inventory, legacyState);
  const inventoryDays = new Set(inventory.days.map((entry) => entry.day_utc));
  const trimmedDays = state.days.filter((entry) => inventoryDays.has(entry.day_utc));
  let dirty = stateResult === null || trimmedDays.length !== state.days.length;
  if (trimmedDays.length !== state.days.length) {
    state.days = trimmedDays;
    state.processed_source_hash = null;
  }
  const report = {
    source_hash: inventory.source_hash,
    processed_source_hash: state.processed_source_hash,
    listed: inventory.days.length,
    candidates: 0,
    copied: 0,
    dry_run: 0,
    state_shards_written: 0,
    checkpoint_flush_count: 0,
    complete: false,
    pruning_enabled: false,
  };

  if (state.processed_source_hash === inventory.source_hash) {
    report.complete = true;
    if (stateResult !== null || dryRun) {
      return { report, state_root_dirty: false };
    }
    const adoptedWrite = writeStateJson(stateShardKey, state);
    report.checkpoint_flush_count += 1;
    if (adoptedWrite.written) report.state_shards_written += 1;
    stateRoot.core = {
      state_shard_key: stateShardKey,
      processed_source_hash: state.processed_source_hash,
      state_shard_hash: adoptedWrite.hash,
    };
    return { report, state_root_dirty: true };
  }

  const stateMap = new Map(state.days.map((entry) => [entry.day_utc, entry]));
  const candidates = inventory.days.filter(
    (day) => stateMap.get(day.day_utc)?.manifest_hash !== day.manifest_hash,
  );
  report.candidates = candidates.length;
  let dirtyUnits = 0;
  let lastFlushAt = Date.now();
  let stateRootDirty = false;

  const flush = ({ force = false } = {}) => {
    if (!dirty) return null;
    const due = force
      || dirtyUnits >= checkpointBatchUnits
      || Date.now() - lastFlushAt >= checkpointFlushSeconds * 1_000;
    if (!due) return null;
    const write = writeStateJson(stateShardKey, state);
    report.checkpoint_flush_count += 1;
    if (write.written) report.state_shards_written += 1;
    stateRoot.core = {
      state_shard_key: stateShardKey,
      processed_source_hash: state.processed_source_hash,
      state_shard_hash: write.hash,
    };
    stateRootDirty = true;
    dirty = false;
    dirtyUnits = 0;
    lastFlushAt = Date.now();
    return write;
  };

  for (const day of candidates) {
    try {
      const copy = copyAndVerifyDay(day);
      if (copy.source_hash !== day.manifest_hash) {
        throw new Error(
          `Core source manifest hash mismatch for ${day.day_utc}: `
          + `inventory=${day.manifest_hash} source=${copy.source_hash}`,
        );
      }
      if (dryRun) {
        report.dry_run += 1;
        continue;
      }
      stateMap.set(day.day_utc, {
        day_utc: day.day_utc,
        manifest_hash: day.manifest_hash,
        copied_at: new Date().toISOString(),
      });
      state.days = Array.from(stateMap.values())
        .sort((left, right) => left.day_utc.localeCompare(right.day_utc));
      state.processed_source_hash = null;
      dirty = true;
      dirtyUnits += 1;
      report.copied += 1;
      flush();
    } catch (error) {
      if (!dryRun) flush({ force: true });
      throw error;
    }
  }

  if (!dryRun && coreStateIsComplete(state, inventory)) {
    state.processed_source_hash = inventory.source_hash;
    dirty = true;
    dirtyUnits += 1;
  }
  const write = flush({ force: true });
  if (!write && stateResult === null) {
    const initialWrite = writeStateJson(stateShardKey, state);
    report.checkpoint_flush_count += 1;
    if (initialWrite.written) report.state_shards_written += 1;
    stateRoot.core = {
      state_shard_key: stateShardKey,
      processed_source_hash: state.processed_source_hash,
      state_shard_hash: initialWrite.hash,
    };
    stateRootDirty = true;
  }

  report.processed_source_hash = state.processed_source_hash;
  report.complete = state.processed_source_hash === inventory.source_hash;
  return { report, state_root_dirty: stateRootDirty };
}
