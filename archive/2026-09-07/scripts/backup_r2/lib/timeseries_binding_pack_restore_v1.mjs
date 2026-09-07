import {
  assertSha256,
  sha256Hex,
  stableJson,
  validateHierarchicalStateRoot,
} from "./hierarchical_backup_v2.mjs";
import {
  normalizeTimeseriesBindingPackRootState,
  timeseriesBindingPackRangeStateShardKey,
  validateTimeseriesBindingPackRangeState,
} from "./hierarchical_timeseries_binding_pack_sync_v1.mjs";
import {
  DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  serializeTimeseriesBindingBackupPackRootV1,
  serializeTimeseriesBindingBackupPackV1,
  timeseriesBindingBackupPackRootKey,
  validateTimeseriesBindingBackupPackRootV1,
  validateTimeseriesBindingBackupPackV1,
} from "./timeseries_binding_backup_pack_v1.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey,
  timeseriesBindingSourceRootKey,
} from "./timeseries_binding_source_hierarchy_v2.mjs";

export const TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX =
  "history/_index_v2/timeseries_binding";
export const TIMESERIES_BINDING_RESTORE_STATE_PREFIX =
  "_ops/checkpoints/r2_history_backup_state_v2";
export const TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY =
  `${TIMESERIES_BINDING_RESTORE_STATE_PREFIX}/root.json`;
export const TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY =
  timeseriesBindingBackupPackRootKey(
    DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  );

function bytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`${label} must be bytes`);
}

function parseJsonBytes(body, label) {
  const input = bytes(body, label);
  try {
    return JSON.parse(input.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireStrictRelativePath(value, label) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be a normalized POSIX relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains traversal or non-normalized segments`);
  }
  return value;
}

function exactBindingPath(timeseriesId) {
  return `${TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX}/timeseries_id=${timeseriesId}.json`;
}

function requireCanonicalJsonBytes(actual, canonical, label) {
  const expected = Buffer.from(stableJson(canonical), "utf8");
  if (!bytes(actual, label).equals(expected)) {
    throw new Error(`${label} is not canonical deterministic JSON`);
  }
}

async function readRequired(readObject, relativePath, label) {
  const result = await readObject(relativePath);
  if (result === null || result === undefined) {
    throw new Error(`${label} is missing: ${relativePath}`);
  }
  return bytes(result, label);
}

function rangeIdentityMatches(left, right) {
  return left.range_start === right.range_start
    && left.range_end === right.range_end
    && left.processed_source_range_hash === right.source_range_hash
    && left.pack_relative_path === right.pack_relative_path
    && left.pack_sha256 === right.pack_sha256
    && left.pack_size === right.pack_size
    && left.member_count === right.member_count;
}

function shardIdentityMatches(shard, reference) {
  return shard.range_start === reference.range_start
    && shard.range_end === reference.range_end
    && shard.processed_source_range_hash === reference.source_range_hash
    && shard.pack_relative_path === reference.pack_relative_path
    && shard.pack_sha256 === reference.pack_sha256
    && shard.pack_size === reference.pack_size
    && shard.member_count === reference.member_count
    && shard.verified === true;
}

function createReport({
  sourceRoot,
  destRoot,
  dryRun,
  expectedSourceRootHash,
  expectedPackRootSha256,
}) {
  return {
    ok: false,
    mode: dryRun ? "dry-run" : "write-r2",
    dry_run: dryRun,
    source_root: sourceRoot,
    dest_root: destRoot,
    checkpoint_root_path: TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
    checkpoint_root_sha256: null,
    pack_root_path: TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY,
    pack_root_sha256: null,
    pack_root_size: null,
    pack_source_root_hash: null,
    requested_expected_source_root_hash: expectedSourceRootHash,
    requested_expected_pack_root_sha256: expectedPackRootSha256,
    ranges_total: 0,
    ranges_verified: 0,
    members_total: 0,
    members_verified: 0,
    members_planned: 0,
    members_written: 0,
    members_readback_verified: 0,
    range_manifests_planned: 0,
    range_manifests_written: 0,
    range_manifests_readback_verified: 0,
    expected_source_root_hash: null,
    reconstructed_source_root_hash: null,
    source_root_hash_match: false,
    source_root_path: timeseriesBindingSourceRootKey(
      TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
    ),
    source_root_written: false,
    source_root_readback_verified: false,
    control_products_restored: false,
    control_products_intentionally_not_restored: [
      `${TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX}/_source_state.json`,
      `${TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX}/_manifests/_refresh_state.json`,
      "history/_index_v2/backup_inventory_v2/",
      `${TIMESERIES_BINDING_RESTORE_STATE_PREFIX}/`,
    ],
    root_publication_planned_last: true,
    root_published_last: false,
    failure: null,
  };
}

function throwWithReport(error, report) {
  const failure = error instanceof Error ? error : new Error(String(error));
  report.ok = false;
  report.failure = failure.message;
  failure.restore_report = report;
  throw failure;
}

async function runBounded(items, concurrency, handler) {
  let cursor = 0;
  let firstError = null;
  async function worker() {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await handler(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, items.length)) },
      () => worker(),
    ),
  );
  if (firstError) throw firstError;
}

function verifyReadback(actual, expected, label) {
  const actualBytes = bytes(actual, label);
  const expectedBytes = bytes(expected, label);
  if (
    actualBytes.byteLength !== expectedBytes.byteLength
    || sha256Hex(actualBytes) !== sha256Hex(expectedBytes)
    || !actualBytes.equals(expectedBytes)
  ) {
    throw new Error(`${label} exact-byte readback mismatch`);
  }
}

export async function restoreTimeseriesBindingPacksToR2({
  sourceRoot,
  destRoot,
  readSourceObject,
  writeDestinationObject = null,
  readDestinationObject = null,
  dryRun = true,
  writeConcurrency = 8,
  expectedSourceRootHash = null,
  expectedPackRootSha256 = null,
} = {}) {
  if (typeof readSourceObject !== "function") {
    throw new Error("readSourceObject is required");
  }
  if (!dryRun && (
    typeof writeDestinationObject !== "function"
    || typeof readDestinationObject !== "function"
  )) {
    throw new Error("write mode requires destination write and read functions");
  }
  const concurrency = requirePositiveInteger(
    writeConcurrency,
    "timeseries binding restore write concurrency",
  );
  const expectedSourceHash = expectedSourceRootHash
    ? assertSha256(expectedSourceRootHash, "expected source root SHA-256")
    : null;
  const expectedPackHash = expectedPackRootSha256
    ? assertSha256(expectedPackRootSha256, "expected pack root SHA-256")
    : null;
  const report = createReport({
    sourceRoot,
    destRoot,
    dryRun,
    expectedSourceRootHash: expectedSourceHash,
    expectedPackRootSha256: expectedPackHash,
  });

  try {
    const checkpointBody = await readRequired(
      readSourceObject,
      TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY,
      "Dropbox hierarchical checkpoint root",
    );
    report.checkpoint_root_sha256 = sha256Hex(checkpointBody);
    const checkpointRaw = requireObject(
      parseJsonBytes(checkpointBody, "Dropbox hierarchical checkpoint root"),
      "Dropbox hierarchical checkpoint root",
    );
    const rawPackState = requireObject(
      checkpointRaw.timeseries_binding_packs,
      "Dropbox timeseries binding pack checkpoint root",
    );
    requireStrictRelativePath(
      rawPackState.pack_root_relative_path,
      "Dropbox checkpoint pack root path",
    );
    if (!Array.isArray(rawPackState.ranges)) {
      throw new Error("Dropbox timeseries binding pack checkpoint ranges must be an array");
    }
    for (const range of rawPackState.ranges) {
      requireObject(range, "Dropbox timeseries binding pack checkpoint range");
      requireStrictRelativePath(
        range.state_shard_key,
        "Dropbox timeseries binding pack checkpoint shard path",
      );
      requireStrictRelativePath(
        range.pack_relative_path,
        "Dropbox timeseries binding pack checkpoint child path",
      );
    }
    const checkpoint = validateHierarchicalStateRoot(
      checkpointRaw,
      TIMESERIES_BINDING_RESTORE_STATE_PREFIX,
    );
    const packState = normalizeTimeseriesBindingPackRootState(checkpoint);
    requireCanonicalJsonBytes(
      checkpointBody,
      checkpoint,
      "Dropbox hierarchical checkpoint root",
    );
    if (!packState.verified || packState.ranges.length === 0) {
      throw new Error("Dropbox timeseries binding pack checkpoint root is incomplete");
    }
    if (packState.pack_root_relative_path !== TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY) {
      throw new Error("Dropbox checkpoint does not identify the required pack root");
    }

    const packRootBody = await readRequired(
      readSourceObject,
      packState.pack_root_relative_path,
      "Dropbox timeseries binding pack root",
    );
    const packRootSha256 = sha256Hex(packRootBody);
    report.pack_root_sha256 = packRootSha256;
    report.pack_root_size = packRootBody.byteLength;
    if (
      packRootBody.byteLength !== packState.pack_root_size
      || packRootSha256 !== packState.processed_pack_root_sha256
    ) {
      throw new Error("Dropbox pack root byte identity does not match checkpoint evidence");
    }
    if (expectedPackHash && packRootSha256 !== expectedPackHash) {
      throw new Error("Dropbox pack root does not match the explicitly selected SHA-256");
    }
    const packRootRaw = requireObject(
      parseJsonBytes(packRootBody, "Dropbox timeseries binding pack root"),
      "Dropbox timeseries binding pack root",
    );
    if (packRootRaw.source_prefix !== TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX) {
      throw new Error("Dropbox pack root source prefix is not the runtime binding namespace");
    }
    requireStrictRelativePath(packRootRaw.source_root_key, "pack source root key");
    if (!Array.isArray(packRootRaw.ranges)) {
      throw new Error("Dropbox pack root ranges must be an array");
    }
    for (const range of packRootRaw.ranges) {
      requireObject(range, "Dropbox pack root range");
      requireStrictRelativePath(range.pack_relative_path, "Dropbox child pack path");
    }
    const packRoot = validateTimeseriesBindingBackupPackRootV1(packRootRaw, {
      packPrefix: DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
    });
    const canonicalPackRoot = serializeTimeseriesBindingBackupPackRootV1(packRoot);
    if (!packRootBody.equals(canonicalPackRoot.bytes)) {
      throw new Error("Dropbox timeseries binding pack root is not canonical deterministic JSON");
    }
    report.pack_source_root_hash = packRoot.source_root_hash;
    report.expected_source_root_hash = packRoot.source_root_hash;
    report.ranges_total = packRoot.range_count;
    report.members_total = packRoot.member_count;
    if (packState.processed_source_root_hash !== packRoot.source_root_hash) {
      throw new Error("Dropbox pack root source identity does not match checkpoint evidence");
    }
    if (expectedSourceHash && packRoot.source_root_hash !== expectedSourceHash) {
      throw new Error("Dropbox pack source root does not match the explicitly selected SHA-256");
    }

    const stateRanges = new Map(
      packState.ranges.map((range) => [range.range_start, range]),
    );
    if (stateRanges.size !== packRoot.ranges.length) {
      throw new Error("Dropbox checkpoint and pack root occupied range sets differ");
    }
    for (const reference of packRoot.ranges) {
      const stateRange = stateRanges.get(reference.range_start);
      if (!stateRange || !rangeIdentityMatches(stateRange, reference)) {
        throw new Error(
          `Dropbox checkpoint range does not match pack root: ${reference.range_start}`,
        );
      }
      const expectedShardKey = timeseriesBindingPackRangeStateShardKey(
        TIMESERIES_BINDING_RESTORE_STATE_PREFIX,
        reference.range_start,
        reference.range_end,
      );
      if (stateRange.state_shard_key !== expectedShardKey) {
        throw new Error(
          `Dropbox checkpoint range shard path mismatch: ${reference.range_start}`,
        );
      }
      const shardBody = await readRequired(
        readSourceObject,
        stateRange.state_shard_key,
        `Dropbox checkpoint range ${reference.range_start}`,
      );
      if (sha256Hex(shardBody) !== stateRange.state_shard_hash) {
        throw new Error(
          `Dropbox checkpoint range shard SHA-256 mismatch: ${reference.range_start}`,
        );
      }
      const shardRaw = requireObject(
        parseJsonBytes(shardBody, `Dropbox checkpoint range ${reference.range_start}`),
        `Dropbox checkpoint range ${reference.range_start}`,
      );
      requireStrictRelativePath(
        shardRaw.pack_relative_path,
        `Dropbox checkpoint range ${reference.range_start} pack path`,
      );
      const shard = validateTimeseriesBindingPackRangeState(
        shardRaw,
        reference.range_start,
        reference.range_end,
      );
      requireCanonicalJsonBytes(
        shardBody,
        shard,
        `Dropbox checkpoint range ${reference.range_start}`,
      );
      if (!shardIdentityMatches(shard, reference)) {
        throw new Error(
          `Dropbox checkpoint range shard is not current: ${reference.range_start}`,
        );
      }
    }

    const restoredMembers = [];
    const reconstructedRanges = [];
    const seenTimeseriesIds = new Set();
    const seenMemberPaths = new Set();
    for (const reference of packRoot.ranges) {
      const packBody = await readRequired(
        readSourceObject,
        reference.pack_relative_path,
        `Dropbox child pack ${reference.range_start}-${reference.range_end}`,
      );
      if (
        packBody.byteLength !== reference.pack_size
        || sha256Hex(packBody) !== reference.pack_sha256
      ) {
        throw new Error(
          `Dropbox child pack byte identity mismatch: ${reference.pack_relative_path}`,
        );
      }
      const rawPack = requireObject(
        parseJsonBytes(
          packBody,
          `Dropbox child pack ${reference.range_start}-${reference.range_end}`,
        ),
        `Dropbox child pack ${reference.range_start}-${reference.range_end}`,
      );
      if (!Array.isArray(rawPack.members)) {
        throw new Error(`Dropbox child pack members must be an array: ${reference.range_start}`);
      }
      const sourceUnits = [];
      let previousTimeseriesId = 0;
      for (const rawMember of rawPack.members) {
        const member = requireObject(rawMember, "Dropbox child pack member");
        const timeseriesId = requirePositiveInteger(
          member.timeseries_id,
          "Dropbox child pack member timeseries_id",
        );
        if (
          timeseriesId < reference.range_start
          || timeseriesId > reference.range_end
        ) {
          throw new Error(`Packed timeseries ${timeseriesId} is outside its fixed range`);
        }
        if (timeseriesId <= previousTimeseriesId) {
          throw new Error("Dropbox child pack members are not strictly sorted");
        }
        previousTimeseriesId = timeseriesId;
        const relativePath = requireStrictRelativePath(
          member.relative_path,
          `packed timeseries ${timeseriesId} path`,
        );
        if (relativePath !== exactBindingPath(timeseriesId)) {
          throw new Error(
            `Packed timeseries ${timeseriesId} is outside the exact binding namespace`,
          );
        }
        if (seenTimeseriesIds.has(timeseriesId) || seenMemberPaths.has(relativePath)) {
          throw new Error(`Duplicate packed timeseries binding member: ${timeseriesId}`);
        }
        seenTimeseriesIds.add(timeseriesId);
        seenMemberPaths.add(relativePath);
        sourceUnits.push({
          timeseries_id: timeseriesId,
          relative_path: relativePath,
          sha256: member.sha256,
          size: member.size,
          r2_md5: null,
        });
      }
      const sourceRange = buildTimeseriesBindingSourceRangeManifest({
        bindingPrefix: TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
        rangeStart: reference.range_start,
        rangeEnd: reference.range_end,
        units: sourceUnits,
      });
      if (sourceRange.source_range_hash !== reference.source_range_hash) {
        throw new Error(
          `Reconstructed source range hash does not match pack authority: ${reference.range_start}`,
        );
      }
      const pack = validateTimeseriesBindingBackupPackV1(rawPack, sourceRange);
      const canonicalPack = serializeTimeseriesBindingBackupPackV1(pack);
      if (!packBody.equals(canonicalPack.bytes)) {
        throw new Error(
          `Dropbox child pack is not canonical deterministic JSON: ${reference.pack_relative_path}`,
        );
      }
      for (const member of pack.members) {
        restoredMembers.push({
          timeseries_id: member.timeseries_id,
          relative_path: member.relative_path,
          size: member.size,
          sha256: member.sha256,
          body: Buffer.from(member.body_base64, "base64"),
        });
      }
      const manifestKey = timeseriesBindingSourceRangeManifestKey(
        TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
        reference.range_start,
        reference.range_end,
      );
      reconstructedRanges.push({
        manifest: sourceRange,
        manifest_key: manifestKey,
        bytes: Buffer.from(stableJson(sourceRange), "utf8"),
      });
      report.ranges_verified += 1;
      report.members_verified += pack.member_count;
    }
    if (
      report.ranges_verified !== packRoot.range_count
      || report.members_verified !== packRoot.member_count
      || restoredMembers.length !== packRoot.member_count
    ) {
      throw new Error("Globally verified packed binding totals do not match pack root");
    }

    const reconstructedRoot = buildTimeseriesBindingSourceRootManifest({
      bindingPrefix: TIMESERIES_BINDING_RESTORE_SOURCE_PREFIX,
      ranges: reconstructedRanges.map(({ manifest, manifest_key: manifestKey }) => ({
        range_start: manifest.range_start,
        range_end: manifest.range_end,
        source_range_hash: manifest.source_range_hash,
        manifest_key: manifestKey,
        unit_count: manifest.units.length,
      })),
    });
    report.reconstructed_source_root_hash = reconstructedRoot.source_root_hash;
    report.source_root_hash_match =
      reconstructedRoot.source_root_hash === packRoot.source_root_hash;
    if (!report.source_root_hash_match) {
      throw new Error("Reconstructed source root hash does not match pack authority");
    }
    if (reconstructedRoot.unit_count !== packRoot.member_count) {
      throw new Error("Reconstructed source root member count does not match pack authority");
    }
    validateTimeseriesBindingBackupPackRootV1(packRootRaw, {
      packPrefix: DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
      sourceRootManifest: reconstructedRoot,
    });

    const sourceRootBody = Buffer.from(stableJson(reconstructedRoot), "utf8");
    report.members_planned = restoredMembers.length;
    report.range_manifests_planned = reconstructedRanges.length;
    if (dryRun) {
      report.ok = true;
      return report;
    }

    await runBounded(restoredMembers, concurrency, async (member) => {
      await writeDestinationObject(member.relative_path, member.body);
      report.members_written += 1;
      const readback = await readRequired(
        readDestinationObject,
        member.relative_path,
        `restored binding ${member.timeseries_id}`,
      );
      if (
        readback.byteLength !== member.size
        || sha256Hex(readback) !== member.sha256
        || !readback.equals(member.body)
      ) {
        throw new Error(
          `Restored binding exact-byte readback mismatch: ${member.timeseries_id}`,
        );
      }
      report.members_readback_verified += 1;
    });

    for (const range of reconstructedRanges) {
      await writeDestinationObject(range.manifest_key, range.bytes);
      report.range_manifests_written += 1;
      const readback = await readRequired(
        readDestinationObject,
        range.manifest_key,
        `restored source range ${range.manifest.range_start}`,
      );
      verifyReadback(
        readback,
        range.bytes,
        `Restored source range ${range.manifest.range_start}`,
      );
      report.range_manifests_readback_verified += 1;
    }

    if (
      report.members_readback_verified !== report.members_planned
      || report.range_manifests_readback_verified !== report.range_manifests_planned
    ) {
      throw new Error("Restore children are incomplete; refusing source root publication");
    }
    await writeDestinationObject(report.source_root_path, sourceRootBody);
    report.source_root_written = true;
    report.root_published_last = true;
    const sourceRootReadback = await readRequired(
      readDestinationObject,
      report.source_root_path,
      "restored source root",
    );
    verifyReadback(sourceRootReadback, sourceRootBody, "Restored source root");
    report.source_root_readback_verified = true;
    report.ok = true;
    return report;
  } catch (error) {
    throwWithReport(error, report);
  }
}
