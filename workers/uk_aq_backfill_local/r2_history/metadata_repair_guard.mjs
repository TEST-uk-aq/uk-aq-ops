import fs from "node:fs";
import path from "node:path";

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const CANONICAL_CODE = /^[a-z][a-z0-9_]*$/;
const LEGACY_ALIASES = new Map([
  ["pm2.5", "pm25"],
  ["pm2_5", "pm25"],
  ["pm 2.5", "pm25"],
  ["pm₂.₅", "pm25"],
]);

function canonicalPollutantCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (LEGACY_ALIASES.has(normalized)) return LEGACY_ALIASES.get(normalized);
  return CANONICAL_CODE.test(normalized) ? normalized : null;
}

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
  const normalized = String(key || "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe local object key: ${key}`);
  }
  return path.join(root, ...normalized.split("/"));
}

function readJson(filePath, key) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateLegacyObservationManifestCompatibilityInputs({
  env = process.env,
  repairPlan,
} = {}) {
  const dropboxRoot = String(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim();
  if (!dropboxRoot) return { checked_connectors: 0, legacy_connectors: 0 };
  const prefix = String(
    env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_OBSERVATIONS_PREFIX,
  ).replace(/^\/+|\/+$/g, "");
  let checkedConnectors = 0;
  let legacyConnectors = 0;

  for (const dayUtc of targetedDays(repairPlan)) {
    const dayPrefix = `${prefix}/day_utc=${dayUtc}`;
    const dayDirectory = localPathForKey(dropboxRoot, dayPrefix);
    if (!fs.existsSync(dayDirectory)) continue;
    for (const entry of fs.readdirSync(dayDirectory, { withFileTypes: true })) {
      const match = entry.isDirectory() ? entry.name.match(/^connector_id=(\d+)$/) : null;
      if (!match) continue;
      const connectorId = Number(match[1]);
      const connectorPrefix = `${dayPrefix}/${entry.name}/`;
      const connectorKey = `${connectorPrefix}manifest.json`;
      const connectorPath = localPathForKey(dropboxRoot, connectorKey);
      if (!fs.existsSync(connectorPath)) continue;
      checkedConnectors += 1;
      const parent = readJson(connectorPath, connectorKey);
      if (parent?.history_version !== "v2" || parent?.domain !== "observations"
        || parent?.manifest_kind !== "connector") continue;
      const declarations = [
        ...(Array.isArray(parent.pollutant_manifests) ? parent.pollutant_manifests : []),
        ...(Array.isArray(parent.child_manifests) ? parent.child_manifests : []),
      ];
      const legacyDeclarations = declarations.filter((child) =>
        /\/pollutant=[^/]+\/manifest\.json$/.test(String(child?.manifest_key || "")));
      if (!legacyDeclarations.length) continue;
      legacyConnectors += 1;

      const identityMatches = parent.day_utc === dayUtc
        && Number.isInteger(parent.connector_id)
        && parent.connector_id === connectorId
        && (
          parent.manifest_key === connectorKey
          || (parent.manifest_key === undefined && parent.current_prefix === connectorPrefix)
        );
      if (!identityMatches) {
        throw new Error(
          `Blocked dependency: legacy connector identity mismatch in ${connectorKey}`,
        );
      }

      const escapedPrefix = connectorPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const childPattern = new RegExp(
        `^${escapedPrefix}pollutant=([^/]+)/manifest\\.json$`,
      );
      const canonicalSources = new Map();
      for (const child of legacyDeclarations) {
        const childKey = String(child?.manifest_key || "").trim();
        const childMatch = childKey.match(childPattern);
        const declaredCode = canonicalPollutantCode(child?.pollutant_code);
        const pathCode = canonicalPollutantCode(childMatch?.[1]);
        if (!childMatch || !declaredCode || !pathCode || declaredCode !== pathCode) {
          throw new Error(
            `Blocked dependency: invalid or mismatched legacy pollutant declaration in ${connectorKey}`,
          );
        }
        const previous = canonicalSources.get(declaredCode);
        if (previous && previous !== childKey) {
          throw new Error(
            `Blocked dependency: multiple legacy children map to ${declaredCode} in ${connectorKey}`,
          );
        }
        canonicalSources.set(declaredCode, childKey);

        const childPath = localPathForKey(dropboxRoot, childKey);
        if (!fs.existsSync(childPath)) continue;
        const childPayload = readJson(childPath, childKey);
        const childPayloadCode = canonicalPollutantCode(childPayload?.pollutant_code);
        const childIdentityMatches = (childPayload.day_utc === undefined
            || childPayload.day_utc === dayUtc)
          && (childPayload.connector_id === undefined
            || Number(childPayload.connector_id) === connectorId)
          && (childPayloadCode === null || childPayloadCode === declaredCode);
        if (!childIdentityMatches) {
          throw new Error(
            `Blocked dependency: legacy pollutant manifest identity mismatch: ${childKey}`,
          );
        }
      }
    }
  }

  return {
    checked_connectors: checkedConnectors,
    legacy_connectors: legacyConnectors,
  };
}
