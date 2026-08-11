import {
  sha256Hex,
} from "./hierarchical_backup_v2.mjs";
import {
  TIMESERIES_BINDING_RANGE_SIZE,
  TIMESERIES_BINDING_RANGE_STATE_KIND,
  buildTimeseriesBindingRangeStateSkeleton,
  timeseriesBindingRangeStateShardKey,
  validateTimeseriesBindingRangeInventoryShard,
  validateTimeseriesBindingRootReference,
} from "./timeseries_binding_ranges_v2.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function normalizeStateUnit(entry, rangeStart, rangeEnd) {
  const timeseriesId = normalizeTimeseriesId(entry?.timeseries_id);
  if (timeseriesId < rangeStart || timeseriesId > rangeEnd) {
    throw new Error(
      `Timeseries binding state unit ${timeseriesId} is outside range `
      + `${rangeStart}-${rangeEnd}`,
    );
  }
  return {
    timeseries_id: timeseriesId,
    hash: assertSha256(entry?.hash, "timeseries binding state hash"),
    copied_at: String(entry?.copied_at || "").trim() || null,
  };
}

export function validateTimeseriesBindingRangeState(
  rawState,
  rangeStart,
  rangeEnd,
) {
  const start = Number(rangeStart);
  const end = Number(rangeEnd);
  if (!rawState) {
    return buildTimeseriesBindingRangeStateSkeleton(start, end);
  }
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    throw new Error("Timeseries binding range state must be an object");
  }
  if (
    Number(rawState.schema_version) !== 1
    || rawState.kind !== TIMESERIES_BINDING_RANGE_STATE_KIND
    || rawState.backup_version !== "v2"
    || Number(rawState.range_size) !== TIMESERIES_BINDING_RANGE_SIZE
    || Number(rawState.range_start) !== start
    || Number(rawState.range_end) !== end
  ) {
    throw new Error(
      `Timeseries binding range state identity mismatch for ${start}-${end}`,
    );
  }
  const units = Array.isArray(rawState.units)
    ? rawState.units.map((entry) => normalizeStateUnit(entry, start, end))
    : [];
  units.sort((left, right) => left.timeseries_id - right.timeseries_id);
  const seen = new Set();
  for (const unit of units) {
    if (seen.has(unit.timeseries_id)) {
      throw new Error(
        `Duplicate timeseries binding state unit ${unit.timeseries_id}`,
      );
    }
    seen.add(unit.timeseries_id);
  }
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_RANGE_STATE_KIND,
    backup_version: "v2",
    range_size: TIMESERIES_BINDING_RANGE_SIZE,
    range_start: start,
    range_end: end,
    processed_source_range_hash: rawState.processed_source_range_hash
      ? assertSha256(
        rawState.processed_source_range_hash,
        "timeseries binding processed_source_range_hash",
      )
      : null,
    units,
  };
}

function stateUnitMap(state) {
  return new Map(state.units.map((entry) => [entry.timeseries_id, entry]));
}

function legacyBindingUnitMap(legacyState) {
  const rawUnits = legacyState?.index_tree_units?.timeseries_binding_v2?.units;
  if (!rawUnits || typeof rawUnits !== "object" || Array.isArray(rawUnits)) {
    return new Map();
  }
  const out = new Map();
  for (const [unitKey, entry] of Object.entries(rawUnits)) {
    const candidate = String(entry?.relative_path || unitKey || "");
    const match = /(?:^|\/)timeseries_id=([1-9]\d*)\.json$/.exec(candidate);
    const hash = String(entry?.hash || "").trim().toLowerCase();
    if (!match || !SHA256_PATTERN.test(hash)) continue;
    out.set(Number(match[1]), {
      timeseries_id: Number(match[1]),
      hash,
      copied_at: String(entry?.copied_at || "").trim() || null,
    });
  }
  return out;
}

export function migrateLegacyTimeseriesBindingRangeState(
  inventoryShard,
  legacyState,
) {
  const inventory = validateTimeseriesBindingRangeInventoryShard(inventoryShard);
  const legacyUnits = legacyBindingUnitMap(legacyState);
  const state = buildTimeseriesBindingRangeStateSkeleton(
    inventory.range_start,
    inventory.range_end,
  );
  state.units = inventory.units.flatMap((unit) => {
    const legacy = legacyUnits.get(unit.timeseries_id);
    if (legacy?.hash !== unit.hash) return [];
    return [{
      timeseries_id: unit.timeseries_id,
      hash: unit.hash,
      copied_at: legacy.copied_at,
    }];
  });
  if (timeseriesBindingRangeStateIsComplete(state, inventory)) {
    state.processed_source_range_hash = inventory.source_range_hash;
  }
  return state;
}

export function planTimeseriesBindingRangeCopies(state, inventoryShard) {
  const inventory = validateTimeseriesBindingRangeInventoryShard(inventoryShard);
  const current = validateTimeseriesBindingRangeState(
    state,
    inventory.range_start,
    inventory.range_end,
  );
  if (current.processed_source_range_hash === inventory.source_range_hash) {
    return [];
  }
  const copied = stateUnitMap(current);
  return inventory.units.filter(
    (unit) => copied.get(unit.timeseries_id)?.hash !== unit.hash,
  );
}

export function markTimeseriesBindingCopied(state, unit, copiedAt) {
  const current = validateTimeseriesBindingRangeState(
    state,
    state.range_start,
    state.range_end,
  );
  const timeseriesId = normalizeTimeseriesId(unit.timeseries_id);
  if (
    timeseriesId < current.range_start
    || timeseriesId > current.range_end
  ) {
    throw new Error(
      `Timeseries binding ${timeseriesId} is outside state range `
      + `${current.range_start}-${current.range_end}`,
    );
  }
  const units = stateUnitMap(current);
  units.set(timeseriesId, {
    timeseries_id: timeseriesId,
    hash: assertSha256(unit.hash, `timeseries binding ${timeseriesId} hash`),
    copied_at: String(copiedAt || "").trim() || null,
  });
  current.units = Array.from(units.values())
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  current.processed_source_range_hash = null;
  return current;
}

export function trimTimeseriesBindingRangeState(state, inventoryShard) {
  const inventory = validateTimeseriesBindingRangeInventoryShard(inventoryShard);
  const current = validateTimeseriesBindingRangeState(
    state,
    inventory.range_start,
    inventory.range_end,
  );
  const currentIds = new Set(inventory.units.map((unit) => unit.timeseries_id));
  const filtered = current.units.filter((unit) => currentIds.has(unit.timeseries_id));
  const changed = filtered.length !== current.units.length;
  if (changed) {
    current.units = filtered;
    current.processed_source_range_hash = null;
  }
  return { state: current, changed };
}

export function timeseriesBindingRangeStateIsComplete(state, inventoryShard) {
  const inventory = validateTimeseriesBindingRangeInventoryShard(inventoryShard);
  const current = validateTimeseriesBindingRangeState(
    state,
    inventory.range_start,
    inventory.range_end,
  );
  const copied = stateUnitMap(current);
  return inventory.units.every(
    (unit) => copied.get(unit.timeseries_id)?.hash === unit.hash,
  );
}

export function completeTimeseriesBindingRangeState(state, inventoryShard) {
  const inventory = validateTimeseriesBindingRangeInventoryShard(inventoryShard);
  const current = validateTimeseriesBindingRangeState(
    state,
    inventory.range_start,
    inventory.range_end,
  );
  if (!timeseriesBindingRangeStateIsComplete(current, inventory)) {
    throw new Error(
      `Cannot complete timeseries binding range `
      + `${inventory.range_start}-${inventory.range_end}: `
      + "one or more binding identities are incomplete",
    );
  }
  const inventoryIds = new Set(inventory.units.map((unit) => unit.timeseries_id));
  current.units = current.units
    .filter((unit) => inventoryIds.has(unit.timeseries_id))
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  current.processed_source_range_hash = inventory.source_range_hash;
  return current;
}

function normalizeRootState(stateRoot) {
  const raw = stateRoot.timeseries_binding;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("Timeseries binding root state must be an object");
  }
  const ranges = Array.isArray(raw?.ranges)
    ? raw.ranges.map((entry) => ({
      range_start: Number(entry.range_start),
      range_end: Number(entry.range_end),
      state_shard_key: String(entry.state_shard_key || "").trim(),
      processed_source_range_hash: entry.processed_source_range_hash
        ? assertSha256(
          entry.processed_source_range_hash,
          "timeseries binding root processed_source_range_hash",
        )
        : null,
      state_shard_hash: entry.state_shard_hash
        ? assertSha256(
          entry.state_shard_hash,
          "timeseries binding root state_shard_hash",
        )
        : null,
    })).sort((left, right) => left.range_start - right.range_start)
    : [];
  const seen = new Set();
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.range_start)
      || range.range_start < 0
      || range.range_start % TIMESERIES_BINDING_RANGE_SIZE !== 0
      || range.range_end !== range.range_start + TIMESERIES_BINDING_RANGE_SIZE - 1
      || !range.state_shard_key
    ) {
      throw new Error(
        `Invalid timeseries binding root state range `
        + `${range.range_start}-${range.range_end}`,
      );
    }
    if (seen.has(range.range_start)) {
      throw new Error(
        `Duplicate timeseries binding root state range ${range.range_start}`,
      );
    }
    seen.add(range.range_start);
  }
  stateRoot.timeseries_binding = {
    processed_source_root_hash: raw?.processed_source_root_hash
      ? assertSha256(
        raw.processed_source_root_hash,
        "timeseries binding processed_source_root_hash",
      )
      : null,
    ranges,
  };
  return stateRoot.timeseries_binding;
}

function rootRangeEntry(rootState, rangeStart) {
  return rootState.ranges.find(
    (entry) => entry.range_start === Number(rangeStart),
  ) || null;
}

function upsertRootRangeSummary(
  rootState,
  {
    rangeStart,
    rangeEnd,
    stateShardKey,
    processedSourceRangeHash,
    stateShardHash,
  },
) {
  let entry = rootRangeEntry(rootState, rangeStart);
  if (!entry) {
    entry = {
      range_start: Number(rangeStart),
      range_end: Number(rangeEnd),
      state_shard_key: String(stateShardKey),
      processed_source_range_hash: null,
      state_shard_hash: null,
    };
    rootState.ranges.push(entry);
    rootState.ranges.sort((left, right) => left.range_start - right.range_start);
  }
  entry.range_end = Number(rangeEnd);
  entry.state_shard_key = String(stateShardKey);
  entry.processed_source_range_hash = processedSourceRangeHash || null;
  entry.state_shard_hash = stateShardHash || null;
  rootState.processed_source_root_hash = null;
}

function rootIsComplete(rootState, inventoryReference) {
  return inventoryReference.ranges.every((range) => (
    rootRangeEntry(rootState, range.range_start)?.processed_source_range_hash
      === range.source_range_hash
  ));
}

export function syncTimeseriesBindingsToDropbox({
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
  copyAndVerifyFile,
}) {
  const inventoryReference = validateTimeseriesBindingRootReference(
    inventoryRoot?.timeseries_binding,
  );
  if (!inventoryReference) {
    throw new Error("Hierarchical inventory root is missing timeseries_binding");
  }
  const rootState = normalizeRootState(stateRoot);
  let stateRootDirty = false;
  const currentRangeStarts = new Set(
    inventoryReference.ranges.map((range) => range.range_start),
  );
  const retainedRootRanges = rootState.ranges.filter(
    (range) => currentRangeStarts.has(range.range_start),
  );
  if (retainedRootRanges.length !== rootState.ranges.length) {
    rootState.ranges = retainedRootRanges;
    rootState.processed_source_root_hash = null;
    stateRootDirty = true;
  }

  const report = {
    source_root_hash: inventoryReference.source_root_hash,
    processed_source_root_hash: rootState.processed_source_root_hash,
    ranges_total: inventoryReference.ranges.length,
    ranges_skipped: 0,
    ranges_inspected: 0,
    files_candidates: 0,
    files_copied: 0,
    files_dry_run: 0,
    state_shards_written: 0,
    checkpoint_flush_count: 0,
    incomplete_ranges: [],
  };

  if (rootState.processed_source_root_hash === inventoryReference.source_root_hash) {
    report.ranges_skipped = inventoryReference.ranges.length;
    return { report, state_root_dirty: stateRootDirty };
  }

  for (const rangeReference of inventoryReference.ranges) {
    const existingSummary = rootRangeEntry(
      rootState,
      rangeReference.range_start,
    );
    if (
      existingSummary?.processed_source_range_hash
      === rangeReference.source_range_hash
    ) {
      report.ranges_skipped += 1;
      continue;
    }

    report.ranges_inspected += 1;
    const inventoryShard = validateTimeseriesBindingRangeInventoryShard(
      readInventoryJson(rangeReference.inventory_shard_key),
    );
    if (
      inventoryShard.range_start !== rangeReference.range_start
      || inventoryShard.range_end !== rangeReference.range_end
      || inventoryShard.source_range_hash !== rangeReference.source_range_hash
      || inventoryShard.units.length !== rangeReference.unit_count
    ) {
      throw new Error(
        `Timeseries binding inventory range mismatch for `
        + `${rangeReference.range_start}-${rangeReference.range_end}`,
      );
    }

    const stateShardKey = timeseriesBindingRangeStateShardKey(
      stateRootPrefix,
      rangeReference.range_start,
      rangeReference.range_end,
    );
    if (
      existingSummary?.state_shard_key
      && existingSummary.state_shard_key !== stateShardKey
    ) {
      throw new Error(
        `Timeseries binding state shard path mismatch for range `
        + `${rangeReference.range_start}-${rangeReference.range_end}`,
      );
    }
    const stateResult = readStateJsonMaybe(stateShardKey);
    let rangeState = stateResult
      ? validateTimeseriesBindingRangeState(
        stateResult.parsed,
        inventoryShard.range_start,
        inventoryShard.range_end,
      )
      : migrateLegacyTimeseriesBindingRangeState(
        inventoryShard,
        legacyState,
      );
    const trimmed = trimTimeseriesBindingRangeState(
      rangeState,
      inventoryShard,
    );
    rangeState = trimmed.state;
    let rangeStateDirty = stateResult === null || trimmed.changed;
    let dirtyUnits = 0;
    let lastFlushAt = Date.now();

    const flushRangeState = ({ force = false } = {}) => {
      if (!rangeStateDirty) return null;
      const due = force
        || dirtyUnits >= checkpointBatchUnits
        || Date.now() - lastFlushAt >= checkpointFlushSeconds * 1_000;
      if (!due) return null;
      const write = writeStateJson(stateShardKey, rangeState);
      report.checkpoint_flush_count += 1;
      if (write.written) report.state_shards_written += 1;
      upsertRootRangeSummary(rootState, {
        rangeStart: inventoryShard.range_start,
        rangeEnd: inventoryShard.range_end,
        stateShardKey,
        processedSourceRangeHash: rangeState.processed_source_range_hash,
        stateShardHash: write.hash,
      });
      stateRootDirty = true;
      rangeStateDirty = false;
      dirtyUnits = 0;
      lastFlushAt = Date.now();
      return write;
    };

    const candidates = planTimeseriesBindingRangeCopies(
      rangeState,
      inventoryShard,
    );
    report.files_candidates += candidates.length;
    for (const unit of candidates) {
      try {
        const copy = copyAndVerifyFile(unit.relative_path);
        if (copy.source_hash !== unit.hash) {
          throw new Error(
            `Timeseries binding source hash mismatch for ${unit.timeseries_id}: `
            + `inventory=${unit.hash} source=${copy.source_hash}`,
          );
        }
        if (dryRun) {
          report.files_dry_run += 1;
        } else {
          rangeState = markTimeseriesBindingCopied(
            rangeState,
            unit,
            new Date().toISOString(),
          );
          rangeStateDirty = true;
          dirtyUnits += 1;
          report.files_copied += 1;
          flushRangeState();
        }
      } catch (error) {
        if (!dryRun) flushRangeState({ force: true });
        throw error;
      }
    }

    if (
      !dryRun
      && timeseriesBindingRangeStateIsComplete(rangeState, inventoryShard)
    ) {
      rangeState = completeTimeseriesBindingRangeState(
        rangeState,
        inventoryShard,
      );
      rangeStateDirty = true;
      dirtyUnits += 1;
    }

    const write = flushRangeState({ force: true });
    if (!write && stateResult === null) {
      const migrationWrite = writeStateJson(stateShardKey, rangeState);
      report.checkpoint_flush_count += 1;
      if (migrationWrite.written) report.state_shards_written += 1;
      upsertRootRangeSummary(rootState, {
        rangeStart: inventoryShard.range_start,
        rangeEnd: inventoryShard.range_end,
        stateShardKey,
        processedSourceRangeHash: rangeState.processed_source_range_hash,
        stateShardHash: migrationWrite.hash,
      });
      stateRootDirty = true;
    } else if (!write && stateResult) {
      upsertRootRangeSummary(rootState, {
        rangeStart: inventoryShard.range_start,
        rangeEnd: inventoryShard.range_end,
        stateShardKey,
        processedSourceRangeHash: rangeState.processed_source_range_hash,
        stateShardHash: sha256Hex(stateResult.text),
      });
      stateRootDirty = true;
    }

    if (
      rangeState.processed_source_range_hash
      !== rangeReference.source_range_hash
    ) {
      report.incomplete_ranges.push(
        `${rangeReference.range_start}-${rangeReference.range_end}`,
      );
    }
  }

  if (!dryRun && rootIsComplete(rootState, inventoryReference)) {
    rootState.processed_source_root_hash = inventoryReference.source_root_hash;
    stateRootDirty = true;
  }
  report.processed_source_root_hash = rootState.processed_source_root_hash;
  return { report, state_root_dirty: stateRootDirty };
}
