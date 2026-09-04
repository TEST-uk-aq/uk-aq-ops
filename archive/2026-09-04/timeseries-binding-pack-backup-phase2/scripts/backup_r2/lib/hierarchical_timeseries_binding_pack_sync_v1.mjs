import {
  assertSha256,
  normalizeRelativePath,
  sha256Hex,
  validateTimeseriesBindingPackInventoryReference,
} from "./hierarchical_backup_v2.mjs";

export const TIMESERIES_BINDING_PACK_RANGE_STATE_KIND =
  "uk_aq_r2_history_backup_state_timeseries_binding_pack_range";
export const TIMESERIES_BINDING_PACK_ROOT_STATE_KIND =
  "uk_aq_r2_history_backup_state_timeseries_binding_packs_root";

const RANGE_SIZE = 1_000;

function validPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

function normalizeBounds(rangeStart, rangeEnd) {
  const start = Number(rangeStart);
  const end = Number(rangeEnd);
  if (
    !Number.isSafeInteger(start)
    || start < 0
    || start % RANGE_SIZE !== 0
    || end !== start + RANGE_SIZE - 1
  ) {
    throw new Error(`Invalid timeseries binding pack state range ${start}-${end}`);
  }
  return { range_start: start, range_end: end };
}

export function timeseriesBindingPackRangeStateShardKey(
  stateRootPrefix,
  rangeStart,
  rangeEnd,
) {
  const bounds = normalizeBounds(rangeStart, rangeEnd);
  return `${normalizeRelativePath(stateRootPrefix, "state root prefix")}`
    + `/timeseries_binding_packs/range=`
    + `${String(bounds.range_start).padStart(6, "0")}-`
    + `${String(bounds.range_end).padStart(6, "0")}.json`;
}

export function validateTimeseriesBindingPackRangeState(
  raw,
  rangeStart,
  rangeEnd,
) {
  const bounds = normalizeBounds(rangeStart, rangeEnd);
  if (!raw) {
    return {
      schema_version: 1,
      kind: TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
      backup_pack_version: "v1",
      range_size: RANGE_SIZE,
      ...bounds,
      processed_source_range_hash: null,
      pack_relative_path: null,
      pack_sha256: null,
      pack_size: null,
      member_count: null,
      copied_at: null,
      verified: false,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Timeseries binding pack range state must be an object");
  }
  if (
    Number(raw.schema_version) !== 1
    || raw.kind !== TIMESERIES_BINDING_PACK_RANGE_STATE_KIND
    || raw.backup_pack_version !== "v1"
    || Number(raw.range_size) !== RANGE_SIZE
    || Number(raw.range_start) !== bounds.range_start
    || Number(raw.range_end) !== bounds.range_end
  ) {
    throw new Error(
      `Timeseries binding pack range state identity mismatch for ${bounds.range_start}-${bounds.range_end}`,
    );
  }
  const processedHash = raw.processed_source_range_hash
    ? assertSha256(
      raw.processed_source_range_hash,
      "timeseries binding pack processed_source_range_hash",
    )
    : null;
  const verified = raw.verified === true;
  if (verified !== Boolean(processedHash)) {
    throw new Error("Timeseries binding pack range verified/hash evidence mismatch");
  }
  const copiedAt = processedHash ? String(raw.copied_at || "").trim() : "";
  if (verified && !copiedAt) {
    throw new Error("Timeseries binding pack range copied_at evidence is required");
  }
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
    backup_pack_version: "v1",
    range_size: RANGE_SIZE,
    ...bounds,
    processed_source_range_hash: processedHash,
    pack_relative_path: processedHash
      ? normalizeRelativePath(raw.pack_relative_path)
      : null,
    pack_sha256: processedHash
      ? assertSha256(raw.pack_sha256, "timeseries binding pack state SHA-256")
      : null,
    pack_size: processedHash
      ? validPositiveInteger(raw.pack_size, "timeseries binding pack state size")
      : null,
    member_count: processedHash
      ? validPositiveInteger(raw.member_count, "timeseries binding pack state member_count")
      : null,
    copied_at: copiedAt || null,
    verified,
  };
}

function rangeStateComplete(state, reference) {
  return state.verified
    && state.processed_source_range_hash === reference.source_range_hash
    && state.pack_relative_path === reference.pack_relative_path
    && state.pack_sha256 === reference.pack_sha256
    && state.pack_size === reference.pack_size
    && state.member_count === reference.member_count;
}

function normalizeRootRange(raw) {
  const bounds = normalizeBounds(raw?.range_start, raw?.range_end);
  return {
    ...bounds,
    state_shard_key: normalizeRelativePath(raw?.state_shard_key),
    processed_source_range_hash: assertSha256(
      raw?.processed_source_range_hash,
      "timeseries binding pack root state source range hash",
    ),
    pack_relative_path: normalizeRelativePath(raw?.pack_relative_path),
    pack_sha256: assertSha256(
      raw?.pack_sha256,
      "timeseries binding pack root state pack SHA-256",
    ),
    pack_size: validPositiveInteger(
      raw?.pack_size,
      "timeseries binding pack root state pack size",
    ),
    member_count: validPositiveInteger(
      raw?.member_count,
      "timeseries binding pack root state member_count",
    ),
    state_shard_hash: assertSha256(
      raw?.state_shard_hash,
      "timeseries binding pack root state shard SHA-256",
    ),
  };
}

export function normalizeTimeseriesBindingPackRootState(stateRoot) {
  const raw = stateRoot.timeseries_binding_packs;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("Timeseries binding pack root state must be an object");
  }
  if (raw && (
    Number(raw.schema_version) !== 1
    || raw.kind !== TIMESERIES_BINDING_PACK_ROOT_STATE_KIND
    || raw.backup_pack_version !== "v1"
  )) {
    throw new Error("Timeseries binding pack root state identity mismatch");
  }
  const ranges = Array.isArray(raw?.ranges)
    ? raw.ranges.map(normalizeRootRange)
      .sort((left, right) => left.range_start - right.range_start)
    : [];
  const seen = new Set();
  for (const range of ranges) {
    if (seen.has(range.range_start)) {
      throw new Error(`Duplicate timeseries binding pack root state range ${range.range_start}`);
    }
    seen.add(range.range_start);
  }
  const processedSourceRootHash = raw?.processed_source_root_hash
    ? assertSha256(
      raw.processed_source_root_hash,
      "timeseries binding pack processed source root hash",
    )
    : null;
  const processedPackRootSha256 = raw?.processed_pack_root_sha256
    ? assertSha256(
      raw.processed_pack_root_sha256,
      "timeseries binding pack processed pack root SHA-256",
    )
    : null;
  const verified = raw?.verified === true;
  if (
    verified !== Boolean(processedSourceRootHash && processedPackRootSha256)
  ) {
    throw new Error("Timeseries binding pack root verified/hash evidence mismatch");
  }
  const copiedAt = verified ? String(raw.copied_at || "").trim() : "";
  if (verified && !copiedAt) {
    throw new Error("Timeseries binding pack root copied_at evidence is required");
  }
  stateRoot.timeseries_binding_packs = {
    schema_version: 1,
    kind: TIMESERIES_BINDING_PACK_ROOT_STATE_KIND,
    backup_pack_version: "v1",
    processed_source_root_hash: processedSourceRootHash,
    processed_pack_root_sha256: processedPackRootSha256,
    pack_root_relative_path: verified
      ? normalizeRelativePath(raw.pack_root_relative_path)
      : null,
    pack_root_size: verified
      ? validPositiveInteger(raw.pack_root_size, "timeseries binding pack root state size")
      : null,
    copied_at: copiedAt || null,
    verified,
    ranges,
  };
  return stateRoot.timeseries_binding_packs;
}

function rootRange(rootState, rangeStart) {
  return rootState.ranges.find(
    (entry) => entry.range_start === Number(rangeStart),
  ) || null;
}

function rootRangeComplete(rootState, reference, stateRootPrefix) {
  const entry = rootRange(rootState, reference.range_start);
  return entry
    && entry.range_end === reference.range_end
    && entry.state_shard_key === timeseriesBindingPackRangeStateShardKey(
      stateRootPrefix,
      reference.range_start,
      reference.range_end,
    )
    && entry.processed_source_range_hash === reference.source_range_hash
    && entry.pack_relative_path === reference.pack_relative_path
    && entry.pack_sha256 === reference.pack_sha256
    && entry.pack_size === reference.pack_size
    && entry.member_count === reference.member_count;
}

function upsertRootRange(rootState, reference, stateShardKey, stateShardHash) {
  const current = rootRange(rootState, reference.range_start);
  const next = {
    range_start: reference.range_start,
    range_end: reference.range_end,
    state_shard_key: stateShardKey,
    processed_source_range_hash: reference.source_range_hash,
    pack_relative_path: reference.pack_relative_path,
    pack_sha256: reference.pack_sha256,
    pack_size: reference.pack_size,
    member_count: reference.member_count,
    state_shard_hash: stateShardHash,
  };
  if (current) Object.assign(current, next);
  else rootState.ranges.push(next);
  rootState.ranges.sort((left, right) => left.range_start - right.range_start);
}

function invalidateRootCompletion(rootState) {
  rootState.processed_source_root_hash = null;
  rootState.processed_pack_root_sha256 = null;
  rootState.pack_root_relative_path = null;
  rootState.pack_root_size = null;
  rootState.copied_at = null;
  rootState.verified = false;
}

function rootCompletionMatches(rootState, inventory) {
  return rootState.verified
    && rootState.processed_source_root_hash === inventory.source_root_hash
    && rootState.processed_pack_root_sha256 === inventory.pack_root_sha256
    && rootState.pack_root_relative_path === inventory.pack_root_relative_path
    && rootState.pack_root_size === inventory.pack_root_size;
}

function destinationIdentityMatches(identity, inventory) {
  return identity?.exists === true
    && identity.verified === true
    && identity.sha256 === inventory.pack_root_sha256
    && identity.size === inventory.pack_root_size;
}

export function syncTimeseriesBindingPacksToDropbox({
  inventoryRoot,
  stateRoot,
  stateRootPrefix,
  dryRun,
  readStateJsonMaybe,
  writeStateJson,
  copyAndVerifyFile,
  readDestinationFileIdentity,
}) {
  const inventory = validateTimeseriesBindingPackInventoryReference(
    inventoryRoot?.timeseries_binding_packs,
  );
  if (!inventory) {
    throw new Error("Hierarchical inventory root is missing timeseries_binding_packs");
  }
  const rootState = normalizeTimeseriesBindingPackRootState(stateRoot);
  let stateRootDirty = false;
  const currentStarts = new Set(inventory.ranges.map((range) => range.range_start));
  const retained = rootState.ranges.filter((range) => currentStarts.has(range.range_start));
  if (retained.length !== rootState.ranges.length) {
    rootState.ranges = retained;
    invalidateRootCompletion(rootState);
    stateRootDirty = true;
  }
  const destinationRootIdentity = readDestinationFileIdentity(
    inventory.pack_root_relative_path,
  );
  const destinationRootMatches = destinationIdentityMatches(
    destinationRootIdentity,
    inventory,
  );
  const report = {
    mode: "pack",
    source_root_hash: inventory.source_root_hash,
    processed_source_root_hash: rootState.processed_source_root_hash,
    pack_root_relative_path: inventory.pack_root_relative_path,
    pack_root_sha256: inventory.pack_root_sha256,
    pack_root_size: inventory.pack_root_size,
    packs_total: inventory.range_count,
    packs_skipped: 0,
    packs_candidates: 0,
    packs_copied: 0,
    packs_dry_run: 0,
    bytes_candidates: 0,
    bytes_copied: 0,
    state_shards_written: 0,
    checkpoint_flush_count: 0,
    incomplete_ranges: [],
    pack_root: {
      candidate: false,
      skipped: false,
      copied: false,
      dry_run: false,
      destination_missing_before_copy: destinationRootIdentity?.exists !== true,
      destination_missing: destinationRootIdentity?.exists !== true,
      destination_identity_match: destinationRootMatches,
      verification_status: destinationRootMatches ? "verified" : "pending",
    },
    complete: false,
  };

  if (rootCompletionMatches(rootState, inventory) && destinationRootMatches) {
    report.packs_skipped = inventory.range_count;
    report.pack_root.skipped = true;
    report.processed_source_root_hash = rootState.processed_source_root_hash;
    report.complete = true;
    return { report, state_root_dirty: stateRootDirty };
  }
  if (rootState.verified) {
    invalidateRootCompletion(rootState);
    stateRootDirty = true;
  }

  for (const reference of inventory.ranges) {
    const stateShardKey = timeseriesBindingPackRangeStateShardKey(
      stateRootPrefix,
      reference.range_start,
      reference.range_end,
    );
    if (rootRangeComplete(rootState, reference, stateRootPrefix)) {
      report.packs_skipped += 1;
      continue;
    }
    const existing = readStateJsonMaybe(stateShardKey);
    const rangeState = validateTimeseriesBindingPackRangeState(
      existing?.parsed || null,
      reference.range_start,
      reference.range_end,
    );
    if (rangeStateComplete(rangeState, reference)) {
      upsertRootRange(
        rootState,
        reference,
        stateShardKey,
        sha256Hex(existing.text),
      );
      report.packs_skipped += 1;
      stateRootDirty = true;
      continue;
    }

    report.packs_candidates += 1;
    report.bytes_candidates += reference.pack_size;
    const copy = copyAndVerifyFile(reference.pack_relative_path);
    if (
      copy.source_hash !== reference.pack_sha256
      || copy.source_size !== reference.pack_size
    ) {
      throw new Error(
        `Timeseries binding pack source identity mismatch for ${reference.range_start}-${reference.range_end}`,
      );
    }
    if (dryRun) {
      report.packs_dry_run += 1;
      report.incomplete_ranges.push(
        `${reference.range_start}-${reference.range_end}`,
      );
      continue;
    }
    if (!copy.verified) {
      throw new Error(
        `Timeseries binding pack verification failed: ${reference.pack_relative_path}`,
      );
    }
    const completedState = validateTimeseriesBindingPackRangeState({
      schema_version: 1,
      kind: TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
      backup_pack_version: "v1",
      range_size: RANGE_SIZE,
      range_start: reference.range_start,
      range_end: reference.range_end,
      processed_source_range_hash: reference.source_range_hash,
      pack_relative_path: reference.pack_relative_path,
      pack_sha256: reference.pack_sha256,
      pack_size: reference.pack_size,
      member_count: reference.member_count,
      copied_at: new Date().toISOString(),
      verified: true,
    }, reference.range_start, reference.range_end);
    const write = writeStateJson(stateShardKey, completedState);
    report.checkpoint_flush_count += 1;
    if (write.written) report.state_shards_written += 1;
    upsertRootRange(rootState, reference, stateShardKey, write.hash);
    stateRootDirty = true;
    report.packs_copied += 1;
    report.bytes_copied += reference.pack_size;
  }

  if (!dryRun) {
    for (const reference of inventory.ranges) {
      if (!rootRangeComplete(rootState, reference, stateRootPrefix)) {
        report.incomplete_ranges.push(`${reference.range_start}-${reference.range_end}`);
      }
    }
  }

  const childrenComplete = report.incomplete_ranges.length === 0
    && inventory.ranges.every(
      (reference) => rootRangeComplete(rootState, reference, stateRootPrefix),
    );
  report.pack_root.candidate = !rootCompletionMatches(rootState, inventory)
    || !destinationRootMatches;
  if (dryRun) {
    if (report.pack_root.candidate) {
      const rootCopy = copyAndVerifyFile(inventory.pack_root_relative_path);
      if (
        rootCopy.source_hash !== inventory.pack_root_sha256
        || rootCopy.source_size !== inventory.pack_root_size
      ) {
        throw new Error("Timeseries binding pack root source identity mismatch");
      }
      report.pack_root.dry_run = true;
      report.pack_root.verification_status = "dry_run_not_verified";
    }
  } else if (childrenComplete && report.pack_root.candidate) {
    const rootCopy = copyAndVerifyFile(inventory.pack_root_relative_path);
    if (
      rootCopy.source_hash !== inventory.pack_root_sha256
      || rootCopy.source_size !== inventory.pack_root_size
      || !rootCopy.verified
    ) {
      throw new Error("Timeseries binding pack root copy verification failed");
    }
    rootState.processed_source_root_hash = inventory.source_root_hash;
    rootState.processed_pack_root_sha256 = inventory.pack_root_sha256;
    rootState.pack_root_relative_path = inventory.pack_root_relative_path;
    rootState.pack_root_size = inventory.pack_root_size;
    rootState.copied_at = new Date().toISOString();
    rootState.verified = true;
    report.pack_root.copied = true;
    report.pack_root.destination_missing = false;
    report.pack_root.destination_identity_match = true;
    report.pack_root.verification_status = "verified";
    stateRootDirty = true;
  }

  report.processed_source_root_hash = rootState.processed_source_root_hash;
  report.complete = rootCompletionMatches(rootState, inventory)
    && (destinationRootMatches || report.pack_root.copied)
    && report.incomplete_ranges.length === 0;
  return { report, state_root_dirty: stateRootDirty };
}
