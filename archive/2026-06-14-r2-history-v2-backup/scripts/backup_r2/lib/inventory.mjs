// Inventory schema constants and loader. Used by:
// - build_backup_inventory.mjs (permissive load — any unreadable previous
//   inventory means "first build")
// - sync_history_to_dropbox.mjs (strict load — sync requires a valid inventory
//   and exits non-zero with an actionable message if not present)

import { joinTargetPath, rcloneCatMaybe } from "./rclone.mjs";

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_KIND = "uk_aq_r2_history_backup_inventory";

export const DOMAIN_NAMES = Object.freeze(["observations", "aqilevels", "core"]);
export const INDEX_FILE_KEYS = Object.freeze([
  "observations_latest",
  "aqilevels_latest",
  "observations_timeseries_latest",
  "aqilevels_timeseries_latest",
  "observations_timeseries_v2_latest",
  "aqilevels_hourly_data_timeseries_v2_latest",
]);
export const INDEX_TREE_KEYS = Object.freeze([
  "observations_timeseries",
  "aqilevels_timeseries",
  "observations_timeseries_v2",
  "aqilevels_hourly_data_timeseries_v2",
]);
export const COMMITTED_CONNECTOR_UNIT_KEYS = Object.freeze([
  "observations",
]);

export const DEFAULT_INVENTORY_REL_PATH = "history/_index/backup_inventory_v1.json";

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
