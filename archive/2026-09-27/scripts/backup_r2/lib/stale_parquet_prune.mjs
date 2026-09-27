import path from "node:path";

import {
  joinTargetPath,
  rcloneCat,
  rcloneDeleteFile,
  rcloneLsjsonRecursive,
} from "./rclone.mjs";

function normalizePosixRelativePath(rawPath) {
  const cleaned = String(rawPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return "";
  const normalized = path.posix.normalize(cleaned);
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    return "";
  }
  return normalized;
}

function pathFromLsjsonEntry(entry) {
  return normalizePosixRelativePath(entry?.Path || entry?.Name || "");
}

function toUnitRelativeManifestPath(
  rawPath,
  unitRelativePath,
  manifestRelativePath,
) {
  const raw = normalizePosixRelativePath(rawPath);
  if (!raw || !raw.endsWith(".parquet")) return null;

  const unit = normalizePosixRelativePath(unitRelativePath);
  if (!unit) {
    throw new Error(`Invalid prune unit path: ${unitRelativePath}`);
  }

  let relPath = "";
  if (raw === unit || raw.startsWith(`${unit}/`)) {
    relPath = raw.slice(unit.length).replace(/^\/+/, "");
  } else if (raw.startsWith("history/")) {
    throw new Error(
      `Manifest parquet path is outside prune unit: unit=${unit} path=${raw}`,
    );
  } else if (raw.includes("/")) {
    relPath = raw;
  } else {
    const manifestRel = normalizePosixRelativePath(manifestRelativePath);
    const manifestDir = manifestRel && manifestRel.includes("/")
      ? path.posix.dirname(manifestRel)
      : "";
    relPath = manifestDir ? path.posix.join(manifestDir, raw) : raw;
  }

  const normalizedRel = normalizePosixRelativePath(relPath);
  if (
    !normalizedRel
    || normalizedRel.startsWith("history/")
    || !normalizedRel.endsWith(".parquet")
  ) {
    throw new Error(
      `Manifest parquet path cannot be normalized safely: unit=${unit} path=${raw}`,
    );
  }
  return normalizedRel;
}

function addManifestParquetReference(expectedPaths, rawPath, context) {
  const relPath = toUnitRelativeManifestPath(
    rawPath,
    context.unit_relative_path,
    context.manifest_relative_path,
  );
  if (relPath) expectedPaths.add(relPath);
}

export function buildStaleParquetPrunePlan({
  unit_relative_path,
  manifest_entries,
  actual_file_entries,
} = {}) {
  const unitRelativePath = normalizePosixRelativePath(unit_relative_path);
  if (!unitRelativePath) {
    throw new Error(`Invalid prune unit path: ${unit_relative_path}`);
  }
  const manifests = Array.isArray(manifest_entries) ? manifest_entries : [];
  if (manifests.length === 0) {
    throw new Error(`No manifest.json files found for prune unit: ${unitRelativePath}`);
  }

  const expectedPaths = new Set();
  for (const entry of manifests) {
    const manifestRelativePath = normalizePosixRelativePath(
      entry?.relative_path || "",
    );
    if (!manifestRelativePath || !manifestRelativePath.endsWith("manifest.json")) {
      throw new Error(
        `Invalid manifest path for prune unit ${unitRelativePath}: `
        + `${entry?.relative_path || ""}`,
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(String(entry?.text || ""));
    } catch (error) {
      throw new Error(
        `Failed to parse manifest for prune unit ${unitRelativePath} at `
        + `${manifestRelativePath}: ${error?.message || error}`,
      );
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(
        `Manifest root is not a JSON object for prune unit `
        + `${unitRelativePath} at ${manifestRelativePath}`,
      );
    }

    const context = {
      unit_relative_path: unitRelativePath,
      manifest_relative_path: manifestRelativePath,
    };
    if (Array.isArray(manifest.parquet_object_keys)) {
      for (const rawPath of manifest.parquet_object_keys) {
        addManifestParquetReference(expectedPaths, rawPath, context);
      }
    }
    if (Array.isArray(manifest.files)) {
      for (const fileEntry of manifest.files) {
        addManifestParquetReference(
          expectedPaths,
          fileEntry?.key
            || fileEntry?.relative_path
            || fileEntry?.path
            || fileEntry?.name,
          context,
        );
      }
    }
  }

  const actualPaths = new Set();
  for (const entry of Array.isArray(actual_file_entries) ? actual_file_entries : []) {
    const relPath = pathFromLsjsonEntry(entry);
    if (relPath && relPath.endsWith(".parquet")) {
      actualPaths.add(relPath);
    }
  }

  if (expectedPaths.size === 0 && actualPaths.size > 0) {
    throw new Error(
      `No manifest-referenced Parquet paths found for prune unit `
      + `${unitRelativePath}; refusing to delete destination files`,
    );
  }

  return {
    unit_relative_path: unitRelativePath,
    manifest_count: manifests.length,
    manifest_referenced_parquet_count: expectedPaths.size,
    actual_destination_parquet_count: actualPaths.size,
    stale_relative_paths: Array.from(actualPaths)
      .filter((relPath) => !expectedPaths.has(relPath))
      .sort(),
  };
}

function loadManifestEntriesForPrune(
  rcloneBin,
  manifestRootPath,
  retryOptions = null,
  listedEntries = null,
) {
  const entries = listedEntries || rcloneLsjsonRecursive(rcloneBin, manifestRootPath, {
    hash: false,
    retryOptions,
  });
  return entries
    .map((entry) => pathFromLsjsonEntry(entry))
    .filter((relPath) => relPath.endsWith("manifest.json"))
    .sort()
    .map((relativePath) => ({
      relative_path: relativePath,
      text: rcloneCat(
        rcloneBin,
        joinTargetPath(manifestRootPath, relativePath),
        retryOptions,
      ),
    }));
}

function loadActualParquetEntriesForPrune(
  rcloneBin,
  destUnitPath,
  retryOptions = null,
  listedEntries = null,
) {
  return (listedEntries || rcloneLsjsonRecursive(rcloneBin, destUnitPath, {
    hash: false,
    retryOptions,
  }))
    .map((entry) => ({ ...entry, Path: pathFromLsjsonEntry(entry) }))
    .filter((entry) => entry.Path.endsWith(".parquet"));
}

export function pruneStaleParquetForUnit({
  rcloneBin,
  manifestRootPath,
  destUnitPath,
  unitRelativePath,
  dryRun = false,
  readListRetryOptions = null,
  manifestReadListRetryOptions = readListRetryOptions,
  destinationReadListRetryOptions = readListRetryOptions,
  deleteRetryOptions = null,
} = {}) {
  const canReuseDestinationListing =
    manifestRootPath === destUnitPath
    && manifestReadListRetryOptions === destinationReadListRetryOptions;
  const destinationListing = canReuseDestinationListing
    ? rcloneLsjsonRecursive(rcloneBin, destUnitPath, {
      hash: false,
      retryOptions: destinationReadListRetryOptions,
    })
    : null;
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: unitRelativePath,
    manifest_entries: loadManifestEntriesForPrune(
      rcloneBin,
      manifestRootPath,
      manifestReadListRetryOptions,
      destinationListing,
    ),
    actual_file_entries: loadActualParquetEntriesForPrune(
      rcloneBin,
      destUnitPath,
      destinationReadListRetryOptions,
      destinationListing,
    ),
  });

  const deletedPaths = [];
  const dryRunPaths = [];
  for (const relPath of plan.stale_relative_paths) {
    if (dryRun) {
      dryRunPaths.push(relPath);
      continue;
    }
    rcloneDeleteFile(
      rcloneBin,
      joinTargetPath(destUnitPath, relPath),
      deleteRetryOptions,
    );
    deletedPaths.push(relPath);
  }

  return {
    prune_attempted: true,
    prune_skipped: false,
    unit_relative_path: plan.unit_relative_path,
    manifest_count: plan.manifest_count,
    manifest_referenced_parquet_count: plan.manifest_referenced_parquet_count,
    actual_destination_parquet_count: plan.actual_destination_parquet_count,
    prune_deleted_count: deletedPaths.length,
    prune_dry_run_delete_count: dryRunPaths.length,
    prune_error_count: 0,
    pruned_relative_paths: dryRun ? dryRunPaths : deletedPaths,
    pruned_relative_paths_truncated: false,
  };
}
