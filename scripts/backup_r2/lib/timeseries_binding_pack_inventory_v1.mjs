import {
  joinTargetPath,
  rcloneCat,
} from "./rclone.mjs";
import {
  TIMESERIES_BINDING_PACK_INVENTORY_KIND,
  sha256Hex,
  stableJson,
  validateTimeseriesBindingPackInventoryReference,
} from "./hierarchical_backup_v2.mjs";
import {
  DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  timeseriesBindingBackupPackRootKey,
  validateTimeseriesBindingBackupPackRootV1,
} from "./timeseries_binding_backup_pack_v1.mjs";
import {
  timeseriesBindingSourceRootKey,
  validateTimeseriesBindingSourceRootManifest,
} from "./timeseries_binding_source_hierarchy_v2.mjs";

export const TIMESERIES_BINDING_BACKUP_MODES = Object.freeze([
  "individual",
  "dual",
  "pack",
]);
export const DEFAULT_TIMESERIES_BINDING_BACKUP_MODE = "individual";
export const NORMAL_TEST_DROPBOX_BACKUP_DESTINATION =
  "uk_aq_dropbox:TEST/R2_history_backup";
export const ISOLATED_TEST_PACK_BACKUP_DESTINATION =
  "uk_aq_dropbox:TEST/R2_history_backup_pack_test";

function parseJson(text, relativePath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON at ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeTimeseriesBindingBackupMode(value) {
  const mode = String(value || DEFAULT_TIMESERIES_BINDING_BACKUP_MODE).trim();
  if (!TIMESERIES_BINDING_BACKUP_MODES.includes(mode)) {
    throw new Error(
      `Timeseries binding backup mode must be exactly individual, dual or pack: ${mode || "unset"}`,
    );
  }
  return mode;
}

export function assertExperimentalPackOnlyDestination({
  mode,
  destRoot,
  allowExperimentalPackOnly = false,
}) {
  const normalizedMode = normalizeTimeseriesBindingBackupMode(mode);
  if (normalizedMode !== "pack") return;
  if (!allowExperimentalPackOnly) {
    throw new Error(
      "Pack-only timeseries binding backup requires --allow-experimental-pack-only",
    );
  }
  const destination = String(destRoot || "").trim().replace(/\/+$/g, "");
  if (destination === NORMAL_TEST_DROPBOX_BACKUP_DESTINATION) {
    throw new Error(
      "Pack-only timeseries binding backup is forbidden against the normal TEST backup destination",
    );
  }
  if (destination !== ISOLATED_TEST_PACK_BACKUP_DESTINATION) {
    throw new Error(
      `Pack-only timeseries binding backup requires isolated destination ${ISOLATED_TEST_PACK_BACKUP_DESTINATION}`,
    );
  }
}

export function buildTimeseriesBindingPackInventory({
  rcloneBin,
  sourceRoot,
  sourcePrefix,
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  previousRootReference = null,
}) {
  const sourceRootKey = timeseriesBindingSourceRootKey(sourcePrefix);
  const packRootKey = timeseriesBindingBackupPackRootKey(packPrefix);
  const sourceText = rcloneCat(
    rcloneBin,
    joinTargetPath(sourceRoot, sourceRootKey),
  );
  const sourceManifest = validateTimeseriesBindingSourceRootManifest(
    parseJson(sourceText, sourceRootKey),
  );
  const packText = rcloneCat(
    rcloneBin,
    joinTargetPath(sourceRoot, packRootKey),
  );
  return buildTimeseriesBindingPackInventoryReference({
    sourceRootManifest: sourceManifest,
    packRootManifest: parseJson(packText, packRootKey),
    packRootText: packText,
    packPrefix,
    previousRootReference,
  });
}

export function buildTimeseriesBindingPackInventoryReference({
  sourceRootManifest,
  packRootManifest,
  packRootText,
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  previousRootReference = null,
}) {
  const sourceManifest = validateTimeseriesBindingSourceRootManifest(
    sourceRootManifest,
  );
  const packRootKey = timeseriesBindingBackupPackRootKey(packPrefix);
  const packText = String(packRootText || "");
  const packRoot = validateTimeseriesBindingBackupPackRootV1(
    packRootManifest,
    { packPrefix, sourceRootManifest: sourceManifest },
  );
  const canonicalPackText = stableJson(packRoot);
  if (packText !== canonicalPackText) {
    throw new Error(
      `Timeseries binding backup-pack root is not canonical deterministic JSON: ${packRootKey}`,
    );
  }
  if (packRoot.source_root_hash !== sourceManifest.source_root_hash) {
    throw new Error("Timeseries binding backup-pack source root hash mismatch");
  }

  const builtReference = validateTimeseriesBindingPackInventoryReference({
    schema_version: 1,
    kind: TIMESERIES_BINDING_PACK_INVENTORY_KIND,
    backup_pack_version: "v1",
    range_size: packRoot.range_size,
    source_prefix: packRoot.source_prefix,
    source_root_key: packRoot.source_root_key,
    source_root_hash: packRoot.source_root_hash,
    pack_root_relative_path: packRootKey,
    pack_root_sha256: sha256Hex(packText),
    pack_root_size: Buffer.byteLength(packText, "utf8"),
    range_count: packRoot.range_count,
    member_count: packRoot.member_count,
    ranges: packRoot.ranges,
  });
  const previousReference = previousRootReference
    ? validateTimeseriesBindingPackInventoryReference(previousRootReference)
    : null;
  const reused = Boolean(
    previousReference
    && stableJson(previousReference) === stableJson(builtReference),
  );
  const rootReference = reused
    ? previousRootReference
    : builtReference;

  return {
    root_reference: rootReference,
    report: {
      available: true,
      source_root_hash: rootReference.source_root_hash,
      pack_root_relative_path: rootReference.pack_root_relative_path,
      pack_root_sha256: rootReference.pack_root_sha256,
      pack_root_size: rootReference.pack_root_size,
      ranges_total: rootReference.range_count,
      member_count: rootReference.member_count,
      inventory_reference_reused: reused,
      derived_from_roots_only: true,
    },
  };
}
