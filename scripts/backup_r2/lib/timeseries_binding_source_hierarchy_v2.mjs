import { createHash } from "node:crypto";

import {
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../../../workers/shared/r2_sigv4.mjs";

export const TIMESERIES_BINDING_SOURCE_RANGE_SIZE = 1000;
export const TIMESERIES_BINDING_SOURCE_RANGE_KIND =
  "uk_aq_r2_history_timeseries_binding_source_range";
export const TIMESERIES_BINDING_SOURCE_ROOT_KIND =
  "uk_aq_r2_history_timeseries_binding_source_root";
export const TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND =
  "uk_aq_r2_history_timeseries_binding_source_refresh_state";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PHYSICAL_BINDING_PATTERN = /\/timeseries_id=([1-9]\d*)\.json$/;

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

function normalizeRelativePath(value, label = "relative path") {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("\0")
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function stableSortObject(value) {
  if (Array.isArray(value)) return value.map((entry) => stableSortObject(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableSortObject(value[key]);
    return out;
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableSortObject(value), null, 2)}\n`;
}

function stripEtagQuotes(value) {
  const normalized = String(value || "").trim().replace(/^"|"$/g, "").toLowerCase();
  return normalized || null;
}

function md5Hex(body) {
  return createHash("md5").update(body).digest("hex");
}

function normalizeRangeBounds(rangeStart, rangeEnd = null) {
  const start = Number(rangeStart);
  const expectedEnd = start + TIMESERIES_BINDING_SOURCE_RANGE_SIZE - 1;
  const end = rangeEnd === null ? expectedEnd : Number(rangeEnd);
  if (
    !Number.isSafeInteger(start)
    || start < 0
    || start % TIMESERIES_BINDING_SOURCE_RANGE_SIZE !== 0
    || !Number.isSafeInteger(end)
    || end !== expectedEnd
  ) {
    throw new Error(`Invalid timeseries binding source range ${rangeStart}-${rangeEnd}`);
  }
  return { range_start: start, range_end: end };
}

export function timeseriesBindingSourceRangeBounds(timeseriesId) {
  const id = normalizeTimeseriesId(timeseriesId);
  const rangeStart = Math.floor(id / TIMESERIES_BINDING_SOURCE_RANGE_SIZE)
    * TIMESERIES_BINDING_SOURCE_RANGE_SIZE;
  return {
    range_start: rangeStart,
    range_end: rangeStart + TIMESERIES_BINDING_SOURCE_RANGE_SIZE - 1,
  };
}

export function timeseriesBindingSourceRangeKey(rangeStart, rangeEnd = null) {
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  return `range=${String(bounds.range_start).padStart(6, "0")}`
    + `-${String(bounds.range_end).padStart(6, "0")}`;
}

export function timeseriesBindingSourceRootKey(bindingPrefix) {
  return `${normalizePrefix(bindingPrefix)}/_manifests/root.json`;
}

export function timeseriesBindingSourceRangeManifestKey(
  bindingPrefix,
  rangeStart,
  rangeEnd = null,
) {
  return `${normalizePrefix(bindingPrefix)}/_manifests/`
    + `${timeseriesBindingSourceRangeKey(rangeStart, rangeEnd)}.json`;
}

export function timeseriesBindingSourceRefreshStateKey(bindingPrefix) {
  return `${normalizePrefix(bindingPrefix)}/_manifests/_refresh_state.json`;
}

function normalizeSourceUnit(entry) {
  const timeseriesId = normalizeTimeseriesId(entry?.timeseries_id);
  const relativePath = normalizeRelativePath(entry?.relative_path);
  const expectedSuffix = `/timeseries_id=${timeseriesId}.json`;
  if (!relativePath.endsWith(expectedSuffix)) {
    throw new Error(
      `Timeseries binding source unit path/id mismatch: ${relativePath}`,
    );
  }
  const size = Number(entry?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid timeseries binding source unit size: ${entry?.size}`);
  }
  return {
    timeseries_id: timeseriesId,
    relative_path: relativePath,
    sha256: assertSha256(entry?.sha256, "timeseries binding source sha256"),
    size,
    r2_md5: stripEtagQuotes(entry?.r2_md5),
  };
}

function rangeSourceHash(units) {
  const hashUnits = [...units]
    .map(normalizeSourceUnit)
    .sort((left, right) => left.timeseries_id - right.timeseries_id)
    .map((entry) => ({
      timeseries_id: entry.timeseries_id,
      relative_path: entry.relative_path,
      hash: entry.sha256,
      size: entry.size,
    }));
  return sha256Hex(
    `uk_aq:r2_history:v2:timeseries_binding_range:v1\n${JSON.stringify(hashUnits)}`,
  );
}

function rootSourceHash(ranges) {
  const stableRanges = [...ranges]
    .map((entry) => ({
      range_start: Number(entry.range_start),
      range_end: Number(entry.range_end),
      source_range_hash: assertSha256(
        entry.source_range_hash,
        "timeseries binding source range hash",
      ),
      manifest_key: normalizeRelativePath(entry.manifest_key),
      unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
    }))
    .sort((left, right) => left.range_start - right.range_start);
  return sha256Hex(
    `uk_aq:r2_history:v2:timeseries_binding_source_root:v1\n${JSON.stringify(stableRanges)}`,
  );
}

export function buildTimeseriesBindingSourceRangeManifest({
  bindingPrefix,
  rangeStart,
  rangeEnd,
  units,
}) {
  const prefix = normalizePrefix(bindingPrefix);
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  const normalizedUnits = [...units]
    .map(normalizeSourceUnit)
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  const seen = new Set();
  for (const unit of normalizedUnits) {
    if (
      unit.timeseries_id < bounds.range_start
      || unit.timeseries_id > bounds.range_end
    ) {
      throw new Error(
        `Timeseries binding ${unit.timeseries_id} outside source range `
        + `${bounds.range_start}-${bounds.range_end}`,
      );
    }
    if (!unit.relative_path.startsWith(`${prefix}/`)) {
      throw new Error(`Timeseries binding source unit outside prefix: ${unit.relative_path}`);
    }
    if (seen.has(unit.timeseries_id)) {
      throw new Error(`Duplicate timeseries binding source unit ${unit.timeseries_id}`);
    }
    seen.add(unit.timeseries_id);
  }
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_SOURCE_RANGE_KIND,
    history_version: "v2",
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    range_start: bounds.range_start,
    range_end: bounds.range_end,
    source_prefix: prefix,
    source_range_hash: rangeSourceHash(normalizedUnits),
    units: normalizedUnits,
  };
}

export function validateTimeseriesBindingSourceRangeManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Timeseries binding source range manifest must be an object");
  }
  if (
    Number(raw.schema_version) !== 1
    || raw.kind !== TIMESERIES_BINDING_SOURCE_RANGE_KIND
    || raw.history_version !== "v2"
    || Number(raw.range_size) !== TIMESERIES_BINDING_SOURCE_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding source range manifest identity mismatch");
  }
  const canonical = buildTimeseriesBindingSourceRangeManifest({
    bindingPrefix: raw.source_prefix,
    rangeStart: raw.range_start,
    rangeEnd: raw.range_end,
    units: Array.isArray(raw.units) ? raw.units : [],
  });
  if (canonical.source_range_hash !== raw.source_range_hash) {
    throw new Error("Timeseries binding source range hash mismatch");
  }
  return canonical;
}

export function buildTimeseriesBindingSourceRootManifest({
  bindingPrefix,
  ranges,
}) {
  const prefix = normalizePrefix(bindingPrefix);
  const normalizedRanges = [...ranges]
    .map((entry) => {
      const bounds = normalizeRangeBounds(entry.range_start, entry.range_end);
      const manifestKey = normalizeRelativePath(entry.manifest_key);
      const expectedKey = timeseriesBindingSourceRangeManifestKey(
        prefix,
        bounds.range_start,
        bounds.range_end,
      );
      if (manifestKey !== expectedKey) {
        throw new Error(`Timeseries binding source range key mismatch: ${manifestKey}`);
      }
      return {
        range_start: bounds.range_start,
        range_end: bounds.range_end,
        source_range_hash: assertSha256(
          entry.source_range_hash,
          "timeseries binding source range hash",
        ),
        manifest_key: manifestKey,
        unit_count: Math.max(0, Math.trunc(Number(entry.unit_count) || 0)),
      };
    })
    .sort((left, right) => left.range_start - right.range_start);
  const seen = new Set();
  for (const range of normalizedRanges) {
    if (seen.has(range.range_start)) {
      throw new Error(`Duplicate timeseries binding source range ${range.range_start}`);
    }
    seen.add(range.range_start);
  }
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_SOURCE_ROOT_KIND,
    history_version: "v2",
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    source_prefix: prefix,
    source_root_hash: rootSourceHash(normalizedRanges),
    unit_count: normalizedRanges.reduce((sum, entry) => sum + entry.unit_count, 0),
    ranges: normalizedRanges,
  };
}

export function validateTimeseriesBindingSourceRootManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Timeseries binding source root manifest must be an object");
  }
  if (
    Number(raw.schema_version) !== 1
    || raw.kind !== TIMESERIES_BINDING_SOURCE_ROOT_KIND
    || raw.history_version !== "v2"
    || Number(raw.range_size) !== TIMESERIES_BINDING_SOURCE_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding source root manifest identity mismatch");
  }
  const canonical = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: raw.source_prefix,
    ranges: Array.isArray(raw.ranges) ? raw.ranges : [],
  });
  if (canonical.source_root_hash !== raw.source_root_hash) {
    throw new Error("Timeseries binding source root hash mismatch");
  }
  if (canonical.unit_count !== Number(raw.unit_count)) {
    throw new Error("Timeseries binding source root unit_count mismatch");
  }
  return canonical;
}

async function readJsonMaybe(r2, key) {
  const head = await r2HeadObject({ r2, key });
  if (!head?.exists) return null;
  const object = await r2GetObject({ r2, key });
  try {
    return JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${key}: ${error?.message || error}`);
  }
}

async function writeJsonIfChanged({ r2, key, payload, writeR2 }) {
  const text = stableJson(payload);
  const nextMd5 = md5Hex(text);
  const head = await r2HeadObject({ r2, key });
  const existingMd5 = head?.exists ? stripEtagQuotes(head.etag) : null;
  if (existingMd5 && existingMd5 === nextMd5) {
    return { changed: false, written: false, hash: sha256Hex(text), size: Buffer.byteLength(text) };
  }
  if (!writeR2) {
    return { changed: true, written: false, hash: sha256Hex(text), size: Buffer.byteLength(text) };
  }
  await r2PutObject({
    r2,
    key,
    body: text,
    content_type: "application/json; charset=utf-8",
  });
  const verified = await r2GetObject({ r2, key });
  if (verified.body.toString("utf8") !== text) {
    throw new Error(`Timeseries binding source hierarchy verification failed: ${key}`);
  }
  return { changed: true, written: true, hash: sha256Hex(text), size: Buffer.byteLength(text) };
}

function normalizeListedPhysicalBinding(entry, bindingPrefix) {
  const key = normalizeRelativePath(entry?.key || entry?.Key || "", "R2 binding key");
  const match = PHYSICAL_BINDING_PATTERN.exec(`/${key}`);
  if (!match || !key.startsWith(`${bindingPrefix}/timeseries_id=`)) return null;
  const size = Number(entry?.size ?? entry?.Size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid R2 binding size for ${key}`);
  }
  return {
    timeseries_id: Number(match[1]),
    relative_path: key,
    size,
    r2_md5: stripEtagQuotes(entry?.etag || entry?.e_tag || entry?.ETag),
  };
}

function metadataMatches(current, prior) {
  return Boolean(
    prior
    && prior.sha256
    && current.size === prior.size
    && current.r2_md5
    && prior.r2_md5
    && current.r2_md5 === prior.r2_md5
  );
}

function sourceUnitMap(rangeManifests) {
  const out = new Map();
  for (const range of rangeManifests) {
    for (const unit of range.units) out.set(unit.timeseries_id, unit);
  }
  return out;
}

async function loadExistingSourceUnits(r2, root) {
  if (!root) return new Map();
  const ranges = [];
  for (const rangeRef of root.ranges) {
    const raw = await readJsonMaybe(r2, rangeRef.manifest_key);
    if (!raw) {
      throw new Error(`Timeseries binding source range missing: ${rangeRef.manifest_key}`);
    }
    const range = validateTimeseriesBindingSourceRangeManifest(raw);
    if (
      range.source_range_hash !== rangeRef.source_range_hash
      || range.units.length !== rangeRef.unit_count
    ) {
      throw new Error(`Timeseries binding source root/range mismatch: ${rangeRef.manifest_key}`);
    }
    ranges.push(range);
  }
  return sourceUnitMap(ranges);
}

async function loadBackupInventoryUnits(r2, backupInventoryRootPrefix) {
  const rootKey = `${normalizePrefix(backupInventoryRootPrefix)}/timeseries_binding/root.json`;
  const rawRoot = await readJsonMaybe(r2, rootKey);
  if (!rawRoot || !Array.isArray(rawRoot.ranges)) return new Map();
  const out = new Map();
  for (const rangeRef of rawRoot.ranges) {
    const shardKey = normalizeRelativePath(rangeRef?.inventory_shard_key || "");
    const raw = await readJsonMaybe(r2, shardKey);
    if (!raw || !Array.isArray(raw.units)) continue;
    for (const unit of raw.units) {
      const timeseriesId = Number(unit?.timeseries_id);
      const hash = String(unit?.hash || "").trim().toLowerCase();
      const size = Number(unit?.size);
      if (
        !Number.isSafeInteger(timeseriesId)
        || timeseriesId <= 0
        || !SHA256_PATTERN.test(hash)
        || !Number.isSafeInteger(size)
        || size < 0
      ) continue;
      out.set(timeseriesId, {
        timeseries_id: timeseriesId,
        relative_path: normalizeRelativePath(unit.relative_path),
        sha256: hash,
        size,
        r2_md5: stripEtagQuotes(unit.r2_md5),
      });
    }
  }
  return out;
}

function groupUnitsByRange(units) {
  const groups = new Map();
  for (const unit of units) {
    const bounds = timeseriesBindingSourceRangeBounds(unit.timeseries_id);
    if (!groups.has(bounds.range_start)) groups.set(bounds.range_start, []);
    groups.get(bounds.range_start).push(unit);
  }
  return groups;
}

function normalizeSourceFingerprint(value) {
  const fingerprint = String(value || "").trim().toLowerCase();
  return SHA256_PATTERN.test(fingerprint) ? fingerprint : null;
}

function buildRefreshState({ bindingPrefix, sourceFingerprint, sourceRoot }) {
  return {
    schema_version: 1,
    kind: TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND,
    history_version: "v2",
    source_prefix: normalizePrefix(bindingPrefix),
    source_fingerprint: normalizeSourceFingerprint(sourceFingerprint),
    source_root_hash: sourceRoot.source_root_hash,
  };
}

function validRefreshState(raw, { bindingPrefix, sourceFingerprint, sourceRoot }) {
  const fingerprint = normalizeSourceFingerprint(sourceFingerprint);
  return Boolean(
    raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && Number(raw.schema_version) === 1
    && raw.kind === TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND
    && raw.history_version === "v2"
    && raw.source_prefix === normalizePrefix(bindingPrefix)
    && raw.source_fingerprint === fingerprint
    && raw.source_root_hash === sourceRoot.source_root_hash
  );
}

export async function refreshTimeseriesBindingSourceHierarchy({
  r2,
  bindingPrefix = "history/_index_v2/timeseries_binding",
  backupInventoryRootPrefix = "history/_index_v2/backup_inventory_v2",
  sourceFingerprint = null,
  forceRebuild = false,
  writeR2 = true,
} = {}) {
  const prefix = normalizePrefix(bindingPrefix);
  const rootKey = timeseriesBindingSourceRootKey(prefix);
  const refreshStateKey = timeseriesBindingSourceRefreshStateKey(prefix);
  const existingRootRaw = await readJsonMaybe(r2, rootKey);
  const existingRoot = existingRootRaw
    ? validateTimeseriesBindingSourceRootManifest(existingRootRaw)
    : null;
  const existingRefreshState = await readJsonMaybe(r2, refreshStateKey);
  const fingerprint = normalizeSourceFingerprint(sourceFingerprint);

  if (
    !forceRebuild
    && existingRoot
    && fingerprint
    && validRefreshState(existingRefreshState, {
      bindingPrefix: prefix,
      sourceFingerprint: fingerprint,
      sourceRoot: existingRoot,
    })
  ) {
    return {
      status: "skipped",
      reason: "source_fingerprint_already_published",
      source_root_key: rootKey,
      source_root_hash: existingRoot.source_root_hash,
      source_fingerprint: fingerprint,
      physical_listing_performed: false,
      physical_bindings_listed: 0,
      read_and_hashed: 0,
      range_count: existingRoot.ranges.length,
      range_manifests_changed: 0,
      range_manifests_written: 0,
      source_root_changed: false,
      source_root_written: false,
    };
  }

  const priorSourceUnits = await loadExistingSourceUnits(r2, existingRoot);
  const backupUnits = priorSourceUnits.size === 0
    ? await loadBackupInventoryUnits(r2, backupInventoryRootPrefix)
    : new Map();
  const listed = await r2ListAllObjects({
    r2,
    prefix: `${prefix}/`,
    max_keys: 1000,
  });
  const physical = listed
    .map((entry) => normalizeListedPhysicalBinding(entry, prefix))
    .filter(Boolean)
    .sort((left, right) => left.timeseries_id - right.timeseries_id);

  const seen = new Set();
  const units = [];
  let reusedFromSourceHierarchy = 0;
  let reusedFromBackupInventory = 0;
  let readAndHashed = 0;
  for (const current of physical) {
    if (seen.has(current.timeseries_id)) {
      throw new Error(`Duplicate physical timeseries binding ${current.timeseries_id}`);
    }
    seen.add(current.timeseries_id);
    const priorSource = priorSourceUnits.get(current.timeseries_id) || null;
    const priorBackup = backupUnits.get(current.timeseries_id) || null;
    let sha256 = null;
    if (metadataMatches(current, priorSource)) {
      sha256 = priorSource.sha256;
      reusedFromSourceHierarchy += 1;
    } else if (metadataMatches(current, priorBackup)) {
      sha256 = priorBackup.sha256;
      reusedFromBackupInventory += 1;
    } else {
      const object = await r2GetObject({ r2, key: current.relative_path });
      const body = object.body instanceof Buffer ? object.body : Buffer.from(object.body);
      if (body.byteLength !== current.size) {
        throw new Error(`Timeseries binding size changed during hierarchy build: ${current.relative_path}`);
      }
      sha256 = sha256Hex(body);
      readAndHashed += 1;
    }
    units.push({ ...current, sha256 });
  }

  const groups = groupUnitsByRange(units);
  const rangeRefs = [];
  let rangeManifestsChanged = 0;
  let rangeManifestsWritten = 0;
  for (const rangeStart of [...groups.keys()].sort((a, b) => a - b)) {
    const rangeEnd = rangeStart + TIMESERIES_BINDING_SOURCE_RANGE_SIZE - 1;
    const manifest = buildTimeseriesBindingSourceRangeManifest({
      bindingPrefix: prefix,
      rangeStart,
      rangeEnd,
      units: groups.get(rangeStart),
    });
    const manifestKey = timeseriesBindingSourceRangeManifestKey(
      prefix,
      rangeStart,
      rangeEnd,
    );
    const write = await writeJsonIfChanged({
      r2,
      key: manifestKey,
      payload: manifest,
      writeR2,
    });
    if (write.changed) rangeManifestsChanged += 1;
    if (write.written) rangeManifestsWritten += 1;
    rangeRefs.push({
      range_start: rangeStart,
      range_end: rangeEnd,
      source_range_hash: manifest.source_range_hash,
      manifest_key: manifestKey,
      unit_count: manifest.units.length,
    });
  }

  const root = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: prefix,
    ranges: rangeRefs,
  });
  const rootWrite = await writeJsonIfChanged({
    r2,
    key: rootKey,
    payload: root,
    writeR2,
  });

  let refreshStateWrite = { changed: false, written: false };
  if (fingerprint) {
    refreshStateWrite = await writeJsonIfChanged({
      r2,
      key: refreshStateKey,
      payload: buildRefreshState({
        bindingPrefix: prefix,
        sourceFingerprint: fingerprint,
        sourceRoot: root,
      }),
      writeR2,
    });
  }

  return {
    status: writeR2 ? "succeeded" : "planned",
    source_root_key: rootKey,
    source_root_hash: root.source_root_hash,
    source_fingerprint: fingerprint,
    physical_listing_performed: true,
    physical_bindings_listed: units.length,
    reused_from_source_hierarchy: reusedFromSourceHierarchy,
    reused_from_backup_inventory: reusedFromBackupInventory,
    read_and_hashed: readAndHashed,
    range_count: rangeRefs.length,
    range_manifests_changed: rangeManifestsChanged,
    range_manifests_written: rangeManifestsWritten,
    source_root_changed: rootWrite.changed,
    source_root_written: rootWrite.written,
    refresh_state_changed: refreshStateWrite.changed,
    refresh_state_written: refreshStateWrite.written,
  };
}
