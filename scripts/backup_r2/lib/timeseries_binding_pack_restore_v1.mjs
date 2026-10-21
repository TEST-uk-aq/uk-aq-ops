import { getObservationHistoryGeneration, assertObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
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
  "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2";
export const TIMESERIES_BINDING_RESTORE_STATE_ROOT_KEY =
  `${TIMESERIES_BINDING_RESTORE_STATE_PREFIX}/root.json`;
export const TIMESERIES_BINDING_RESTORE_PACK_ROOT_KEY =
  timeseriesBindingBackupPackRootKey(
    DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  );

export const TIMESERIES_BINDING_RESTORE_RESERVATION_KEY =
  "_ops/restores/timeseries_binding_pack_restore_v1/reservation.json";

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

function exactBindingPath(timeseriesId, generation) {
  return `${generation.timeseries_binding_index_prefix}/timeseries_id=${timeseriesId}.json`;
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
  generation,
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
    checkpoint_root_path: `${generation.backup_state_prefix}/root.json`,
    checkpoint_root_sha256: null,
    pack_root_path: `${generation.timeseries_binding_pack_prefix}/root.json`,
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
    members_reused: 0,
    members_readback_verified: 0,
    range_manifests_planned: 0,
    range_manifests_written: 0,
    range_manifests_reused: 0,
    range_manifests_readback_verified: 0,
    expected_source_root_hash: null,
    reconstructed_source_root_hash: null,
    source_root_hash_match: false,
    source_root_path: timeseriesBindingSourceRootKey(
      generation.timeseries_binding_index_prefix,
    ),
    source_root_written: false,
    source_root_reused: false,
    destination_safety: { mode: "not_inspected", reservation_key: TIMESERIES_BINDING_RESTORE_RESERVATION_KEY, objects_inspected: 0 },
    source_root_readback_verified: false,
    control_products_restored: false,
    control_products_intentionally_not_restored: [
      `${generation.timeseries_binding_index_prefix}/_source_state.json`,
      `${generation.timeseries_binding_index_prefix}/_manifests/_refresh_state.json`,
      `${generation.backup_inventory_prefix}/`,
      `${generation.backup_state_prefix}/`,
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

// Called only after every source pack/member and the reconstructed root pass.
// The single immutable reservation belongs to this exact pinned closed set.
async function reserveRestoreDestination({
  sourceRoot, destRoot, generation, expectedSourceHash, expectedPackHash,
  objects, readObject, createObject, listObjects, report,
}) {
  const descriptors = objects.map(({ key, body }) => ({
    key, size: body.byteLength, sha256: sha256Hex(body),
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const reservationBody = Buffer.from(stableJson({
    schema_version: 1, kind: "uk_aq_timeseries_binding_pack_restore_reservation",
    observation_generation: generation.version, source_root: sourceRoot, destination_root: destRoot,
    source_root_sha256: expectedSourceHash, pack_root_sha256: expectedPackHash,
    object_count: objects.length, object_set_sha256: sha256Hex(stableJson(descriptors)),
  }));
  const reservationKey = TIMESERIES_BINDING_RESTORE_RESERVATION_KEY;
  const reservation = await readObject(reservationKey);
  const existingKeys = new Set();
  const expected = new Map(objects.map((object) => [object.key, object.body]));
  expected.set(reservationKey, reservationBody);
  const rootKey = timeseriesBindingSourceRootKey(generation.timeseries_binding_index_prefix);
  function admitted() {
    return {
      existingKeys,
      verifyBeforeRoot: async () => {
        // A single final bounded metadata pass detects foreign/missing keys
        // introduced during writes. Exact payload readbacks have just passed.
        const seen = new Set();
        const tokens = new Set();
        const rootAlreadyPresent = existingKeys.has(rootKey);
        const expectedCount = expected.size - (rootAlreadyPresent ? 0 : 1);
        let token = null;
        do {
          const remaining = expectedCount + 1 - seen.size;
          if (remaining <= 0) throw new Error("Restore destination exceeds its reserved set before root publication");
          const listing = await page(Math.min(1000, remaining), token);
          for (const entry of listing.entries) {
            if (!entry || seen.has(entry.key) || !expected.has(entry.key)
                || (!rootAlreadyPresent && entry.key === rootKey)
                || entry.size !== expected.get(entry.key).byteLength) {
              throw new Error("Restore destination has unrelated or changed objects before root publication");
            }
            seen.add(entry.key);
          }
          token = listing.is_truncated ? listing.next_token : null;
          if (token && tokens.has(token)) throw new Error("Repeated final restore destination listing token");
          if (token) tokens.add(token);
        } while (token);
        if (seen.size !== expectedCount) throw new Error("Restore destination is incomplete before root publication");
        report.destination_safety.objects_final_checked = seen.size;
      },
    };
  }
  async function page(maxKeys, continuationToken = null) {
    const result = await listObjects({ maxKeys, continuationToken });
    if (!result || !Array.isArray(result.entries) || result.entries.length > maxKeys
        || typeof result.is_truncated !== "boolean"
        || (result.is_truncated && (!result.next_token || !result.entries.length))
        || (!result.is_truncated && result.next_token)) {
      throw new Error("Invalid bounded restore destination listing");
    }
    return result;
  }
  if (reservation == null) {
    const first = await page(1);
    if (first.entries.length || first.is_truncated) {
      throw new Error("Restore destination is not empty and has no matching reservation");
    }
    await createObject(reservationKey, reservationBody, { ifNoneMatch: "*" });
    verifyReadback(await readRequired(readObject, reservationKey, "restore reservation"),
      reservationBody, "Restore reservation");
    // Close the empty-LIST/reservation-create window with one tiny probe.
    const reserved = await page(2);
    if (reserved.is_truncated || reserved.entries.length !== 1
        || reserved.entries[0]?.key !== reservationKey
        || reserved.entries[0].size !== reservationBody.byteLength) {
      throw new Error("Restore reservation admission found unrelated destination content");
    }
    report.destination_safety.mode = "fresh";
    return admitted();
  }
  if (!bytes(reservation, "restore reservation").equals(reservationBody)) {
    throw new Error("Restore reservation identity does not match the authorised pinned restore");
  }
  const seenKeys = new Set();
  const seenTokens = new Set();
  let token = null;
  do {
    // At most the closed-set size plus one unexpected key. No unbounded scan.
    const remaining = expected.size + 1 - seenKeys.size;
    if (remaining <= 0) throw new Error("Restore destination exceeds its reserved object set");
    const listing = await page(Math.min(1000, remaining), token);
    for (const entry of listing.entries) {
      if (!entry || typeof entry.key !== "string" || seenKeys.has(entry.key)
          || !expected.has(entry.key)) {
        throw new Error("Restore destination contains unrelated or duplicate objects");
      }
      seenKeys.add(entry.key);
      const body = expected.get(entry.key);
      if (entry.size !== body.byteLength) throw new Error("Restore destination object identity mismatch");
      verifyReadback(await readRequired(readObject, entry.key, "reserved destination object"),
        body, "Reserved destination object identity");
      report.destination_safety.objects_inspected += 1;
      existingKeys.add(entry.key);
    }
    token = listing.is_truncated ? listing.next_token : null;
    if (token && seenTokens.has(token)) throw new Error("Repeated restore destination listing token");
    if (token) seenTokens.add(token);
  } while (token);
  if (!existingKeys.has(reservationKey)) throw new Error("Restore reservation disappeared during inspection");
  if (existingKeys.has(rootKey) && existingKeys.size !== expected.size) {
    throw new Error("Published restore root has incomplete destination children");
  }
  report.destination_safety.mode = "resume";
  return admitted();
}

export async function restoreTimeseriesBindingPacksToR2({
  generation = getObservationHistoryGeneration("v2"),
  sourceRoot,
  destRoot,
  readSourceObject,
  writeDestinationObject = null,
  readDestinationObject = null,
  listDestinationObjects = null,
  dryRun = true,
  writeConcurrency = 8,
  expectedSourceRootHash = null,
  expectedPackRootSha256 = null,
} = {}) {
  assertObservationHistoryGeneration(generation);
  if (typeof readSourceObject !== "function") {
    throw new Error("readSourceObject is required");
  }
  if (!dryRun && (
    typeof writeDestinationObject !== "function"
    || typeof readDestinationObject !== "function"
    || typeof listDestinationObjects !== "function"
  )) {
    throw new Error("write mode requires destination create-only write, read and bounded listing functions");
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
  if (!dryRun && (!expectedSourceHash || !expectedPackHash)) {
    throw new Error("Restore writes require both explicit source-root and pack-root SHA-256 pins");
  }
  const report = createReport({
    generation,
    sourceRoot,
    destRoot,
    dryRun,
    expectedSourceRootHash: expectedSourceHash,
    expectedPackRootSha256: expectedPackHash,
  });

  try {
    const checkpointBody = await readRequired(
      readSourceObject,
      `${generation.backup_state_prefix}/root.json`,
      "Dropbox hierarchical checkpoint root",
    );
    report.checkpoint_root_sha256 = sha256Hex(checkpointBody);
    const checkpointRaw = requireObject(
      parseJsonBytes(checkpointBody, "Dropbox hierarchical checkpoint root"),
      "Dropbox hierarchical checkpoint root",
    );
    if (checkpointRaw.observation_generation !== generation.version) throw new Error("Pack checkpoint contradicts selected generation");
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
      generation.backup_state_prefix,
      generation,
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
    if (packState.pack_root_relative_path !== `${generation.timeseries_binding_pack_prefix}/root.json`) {
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
    if (packRootRaw.source_prefix !== generation.timeseries_binding_index_prefix) {
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
      packPrefix: generation.timeseries_binding_pack_prefix,
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
        generation.backup_state_prefix,
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
        if (relativePath !== exactBindingPath(timeseriesId, generation)) {
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
        bindingPrefix: generation.timeseries_binding_index_prefix,
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
        generation.timeseries_binding_index_prefix,
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
      bindingPrefix: generation.timeseries_binding_index_prefix,
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
      packPrefix: generation.timeseries_binding_pack_prefix,
      sourceRootManifest: reconstructedRoot,
    });

    const sourceRootBody = Buffer.from(stableJson(reconstructedRoot), "utf8");
    report.members_planned = restoredMembers.length;
    report.range_manifests_planned = reconstructedRanges.length;
    if (dryRun) {
      report.ok = true;
      return report;
    }

    const admission = await reserveRestoreDestination({
      sourceRoot, destRoot, generation, expectedSourceHash, expectedPackHash,
      objects: [
        ...restoredMembers.map((member) => ({ key: member.relative_path, body: member.body })),
        ...reconstructedRanges.map((range) => ({ key: range.manifest_key, body: range.bytes })),
        { key: report.source_root_path, body: sourceRootBody },
      ],
      readObject: readDestinationObject, createObject: writeDestinationObject,
      listObjects: listDestinationObjects, report,
    });
    const { existingKeys } = admission;
    await runBounded(restoredMembers, concurrency, async (member) => {
      if (existingKeys.has(member.relative_path)) report.members_reused += 1;
      else {
        await writeDestinationObject(member.relative_path, member.body, { ifNoneMatch: "*" });
        report.members_written += 1;
      }
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
      if (existingKeys.has(range.manifest_key)) report.range_manifests_reused += 1;
      else {
        await writeDestinationObject(range.manifest_key, range.bytes, { ifNoneMatch: "*" });
        report.range_manifests_written += 1;
      }
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
    await admission.verifyBeforeRoot();
    if (existingKeys.has(report.source_root_path)) report.source_root_reused = true;
    else {
      await writeDestinationObject(report.source_root_path, sourceRootBody, { ifNoneMatch: "*" });
      report.source_root_written = true;
      report.root_published_last = true;
    }
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
