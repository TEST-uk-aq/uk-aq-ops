import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  prepareCanonicalObservationManifestCompatibility,
} from "./canonical_manifest_compatibility.mjs";
import {
  deduplicateCanonicalManifestDeclarations,
} from "./canonical_manifest_declarations.mjs";

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";

function directRepairPlan(input) {
  if (input?.history_version === "v2" && input?.domain === "observations"
    && Array.isArray(input.repair_plan)) return input.repair_plan;
  const observations = input?.history_version_results?.v2?.observations;
  return Array.isArray(observations?.repair_plan) ? observations.repair_plan : [];
}

function targetedDays(input) {
  return [...new Set(directRepairPlan(input)
    .map((action) => String(action?.day_utc || ""))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
}

function localPathForKey(root, key) {
  const normalised = String(key || "").replace(/^\/+/, "");
  if (!normalised || normalised.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe local object key: ${key}`);
  }
  return path.join(root, ...normalised.split("/"));
}

function readJson(filePath, key) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function connectorManifestEntries({ dropboxRoot, prefix, days }) {
  const values = [];
  for (const dayUtc of days) {
    const dayKey = `${prefix}/day_utc=${dayUtc}`;
    const dayPath = localPathForKey(dropboxRoot, dayKey);
    if (!fs.existsSync(dayPath)) continue;
    for (const entry of fs.readdirSync(dayPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^connector_id=\d+$/.test(entry.name)) continue;
      const connectorKey = `${dayKey}/${entry.name}/manifest.json`;
      const connectorPath = localPathForKey(dropboxRoot, connectorKey);
      if (!fs.existsSync(connectorPath)) continue;
      values.push({ connectorKey, connectorPath });
    }
  }
  return values;
}

function duplicateDeclarationCount(entries) {
  return entries.reduce((total, entry) => {
    const result = deduplicateCanonicalManifestDeclarations(
      readJson(entry.connectorPath, entry.connectorKey),
      { connectorKey: entry.connectorKey },
    );
    return total + result.duplicate_count;
  }, 0);
}

function linkOrCopyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    fs.copyFileSync(source, target);
  }
}

function cloneTree({ source, target, relative = "", prefix }) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const followed = entry.isSymbolicLink() ? fs.statSync(sourcePath) : null;
    const isDirectory = entry.isDirectory() || followed?.isDirectory();
    const isFile = entry.isFile() || followed?.isFile();
    if (isDirectory) {
      cloneTree({ source: sourcePath, target: targetPath, relative: relativePath, prefix });
      continue;
    }
    if (!isFile) continue;
    if (/^connector_id=\d+\/manifest\.json$/.test(relativePath)) {
      const connectorKey = `${prefix}/${relativePath}`;
      const result = deduplicateCanonicalManifestDeclarations(
        readJson(sourcePath, connectorKey),
        { connectorKey },
      );
      fs.writeFileSync(targetPath, `${JSON.stringify(result.parent, null, 2)}\n`, "utf8");
      continue;
    }
    linkOrCopyFile(entry.isSymbolicLink() ? fs.realpathSync(sourcePath) : sourcePath, targetPath);
  }
}

function buildTemporaryBaselineView({ dropboxRoot, prefix, days }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-manifest-baseline-"));
  try {
    for (const dayUtc of days) {
      const dayKey = `${prefix}/day_utc=${dayUtc}`;
      const source = localPathForKey(dropboxRoot, dayKey);
      if (!fs.existsSync(source)) continue;
      const target = localPathForKey(root, dayKey);
      cloneTree({ source, target, prefix: dayKey });
    }
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareCanonicalObservationManifestCompatibilityFromNormalisedView({
  env = process.env,
  repairPlan,
} = {}) {
  const days = targetedDays(repairPlan);
  const dropboxRoot = String(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim();
  if (!days.length || !dropboxRoot) {
    return prepareCanonicalObservationManifestCompatibility({ env, repairPlan });
  }
  const prefix = String(
    env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_OBSERVATIONS_PREFIX,
  ).replace(/^\/+|\/+$/g, "");
  const entries = connectorManifestEntries({ dropboxRoot, prefix, days });
  const duplicateCount = duplicateDeclarationCount(entries);
  if (!duplicateCount) {
    return prepareCanonicalObservationManifestCompatibility({ env, repairPlan });
  }

  const temporaryRoot = buildTemporaryBaselineView({ dropboxRoot, prefix, days });
  try {
    const preparation = await prepareCanonicalObservationManifestCompatibility({
      env: {
        ...env,
        UK_AQ_R2_HISTORY_DROPBOX_ROOT: temporaryRoot,
      },
      repairPlan,
    });
    return {
      ...preparation,
      duplicate_declaration_count: duplicateCount,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
