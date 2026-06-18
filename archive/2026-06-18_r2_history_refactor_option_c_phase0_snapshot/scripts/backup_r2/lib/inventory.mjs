// Inventory schema constants and loader. Used by:
// - build_backup_inventory.mjs (permissive load — any unreadable previous
//   inventory means "first build")
// - sync_history_to_dropbox.mjs (strict load — sync requires a valid inventory
//   and exits non-zero with an actionable message if not present)

import { joinTargetPath, rcloneCatMaybe } from "./rclone.mjs";

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_KIND = "uk_aq_r2_history_backup_inventory";

export const BACKUP_VERSION_VALUES = Object.freeze(["v1", "v2"]);
export const V1_DOMAIN_NAMES = Object.freeze(["observations", "aqilevels", "core"]);
export const V2_DOMAIN_NAMES = Object.freeze(["observations", "aqilevels", "aqilevels_debug", "core"]);
export const DOMAIN_NAMES = Object.freeze([...new Set([...V1_DOMAIN_NAMES, ...V2_DOMAIN_NAMES])]);
export const V1_INDEX_FILE_KEYS = Object.freeze([
  "observations_latest",
  "aqilevels_latest",
  "observations_timeseries_latest",
  "aqilevels_timeseries_latest",
]);
export const V2_INDEX_FILE_KEYS = Object.freeze([
  "observations_timeseries_v2_latest",
  "aqilevels_hourly_data_timeseries_v2_latest",
]);
export const INDEX_FILE_KEYS = Object.freeze([...V1_INDEX_FILE_KEYS, ...V2_INDEX_FILE_KEYS]);
export const V1_INDEX_TREE_KEYS = Object.freeze([
  "observations_timeseries",
  "aqilevels_timeseries",
]);
export const V2_INDEX_TREE_KEYS = Object.freeze([
  "observations_timeseries_v2",
  "aqilevels_hourly_data_timeseries_v2",
]);
export const INDEX_TREE_KEYS = Object.freeze([...V1_INDEX_TREE_KEYS, ...V2_INDEX_TREE_KEYS]);
export const COMMITTED_CONNECTOR_UNIT_KEYS = Object.freeze([
  "observations",
]);

export const DEFAULT_V1_INVENTORY_REL_PATH = "history/_index/backup_inventory_v1.json";
export const DEFAULT_V2_INVENTORY_REL_PATH = "history/_index_v2/backup_inventory_v2.json";
export const DEFAULT_INVENTORY_REL_PATH = DEFAULT_V1_INVENTORY_REL_PATH;
export const DEFAULT_V1_STATE_REL_PATH = "_ops/checkpoints/r2_history_backup_state_v1.json";
export const DEFAULT_V2_STATE_REL_PATH = "_ops/checkpoints/r2_history_backup_state_v2.json";

export function parseBackupVersion(raw, fallback = "v1") {
  const value = String(raw || "").trim().toLowerCase();
  if (BACKUP_VERSION_VALUES.includes(value)) return value;
  const fallbackValue = String(fallback || "").trim().toLowerCase();
  return BACKUP_VERSION_VALUES.includes(fallbackValue) ? fallbackValue : "v1";
}

export function resolveBackupVersion(env = process.env) {
  const explicitBackupVersion = String(env.UK_AQ_R2_HISTORY_BACKUP_VERSION || "").trim();
  if (explicitBackupVersion) return parseBackupVersion(explicitBackupVersion, "v1");
  return parseBackupVersion(env.UK_AQ_R2_HISTORY_WRITE_VERSION, "v1");
}

export function defaultInventoryRelPathForBackupVersion(backupVersion) {
  return parseBackupVersion(backupVersion) === "v2"
    ? DEFAULT_V2_INVENTORY_REL_PATH
    : DEFAULT_V1_INVENTORY_REL_PATH;
}

export function defaultStateRelPathForBackupVersion(backupVersion) {
  return parseBackupVersion(backupVersion) === "v2"
    ? DEFAULT_V2_STATE_REL_PATH
    : DEFAULT_V1_STATE_REL_PATH;
}

export function domainNamesForBackupVersion(backupVersion) {
  return parseBackupVersion(backupVersion) === "v2"
    ? [...V2_DOMAIN_NAMES]
    : [...V1_DOMAIN_NAMES];
}

export function indexFileKeysForBackupVersion(backupVersion) {
  return parseBackupVersion(backupVersion) === "v2"
    ? [...V2_INDEX_FILE_KEYS]
    : [...V1_INDEX_FILE_KEYS];
}

export function indexTreeKeysForBackupVersion(backupVersion) {
  return parseBackupVersion(backupVersion) === "v2"
    ? [...V2_INDEX_TREE_KEYS]
    : [...V1_INDEX_TREE_KEYS];
}

// Pure validator for an `rcloneCatMaybe`-shaped result. Extracted from
// loadInventory so unit tests can exercise the validation rules without
// shelling out to rclone.
//
// Modes:
//   { strict: true }
//     Throw a clear, actionable error if the inventory is missing, empty,
//     malformed, or schema-mismatched. Used by sync — a bad inventory must
//     fail loudly so the operator re-runs the builder.
//
//   { strict: false }
//     Return null on any unreadable state. Used by the builder when reading
//     the *previous* inventory — the builder is replacing it anyway, so a bad
//     existing file just means "do a full first build."
//
// The error messages include the resolved target path and an instruction to
// re-run the builder script.
export function validateInventoryPayload(
  catResult,
  { strict = false, targetPath = "<unknown>" } = {},
) {
  const buildHint = `re-run scripts/backup_r2/build_backup_inventory.mjs --source-root <root> to regenerate it`;

  if (!catResult || !catResult.found) {
    if (strict) {
      throw new Error(
        `Inventory not found at ${targetPath}. ${buildHint}`,
      );
    }
    return null;
  }

  const text = String(catResult.text || "").trim();
  if (!text) {
    if (strict) {
      throw new Error(
        `Inventory at ${targetPath} is empty (zero bytes). ${buildHint}`,
      );
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (strict) {
      throw new Error(
        `Inventory at ${targetPath} is not valid JSON: ${err?.message || err}. ${buildHint}`,
      );
    }
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (strict) {
      throw new Error(
        `Inventory at ${targetPath} root is not a JSON object. ${buildHint}`,
      );
    }
    return null;
  }

  if (parsed.kind !== INVENTORY_KIND) {
    if (strict) {
      throw new Error(
        `Inventory at ${targetPath} has unexpected kind=${JSON.stringify(parsed.kind)}, expected ${JSON.stringify(INVENTORY_KIND)}. ${buildHint}`,
      );
    }
    return null;
  }

  if (parsed.version !== INVENTORY_SCHEMA_VERSION) {
    if (strict) {
      throw new Error(
        `Inventory at ${targetPath} has version=${JSON.stringify(parsed.version)}, expected ${INVENTORY_SCHEMA_VERSION}. ${buildHint}`,
      );
    }
    return null;
  }

  return parsed;
}

// Load an inventory from R2 via rclone cat, then validate it.
export function loadInventory(
  rcloneBin,
  sourceRoot,
  inventoryRelPath,
  { strict = false } = {},
) {
  const targetPath = joinTargetPath(sourceRoot, inventoryRelPath);
  const result = rcloneCatMaybe(rcloneBin, targetPath);
  return validateInventoryPayload(result, { strict, targetPath });
}
