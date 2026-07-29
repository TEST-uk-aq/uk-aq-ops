import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "../../shared/r2_sigv4.mjs";
import {
  validateObservationContentHashMetadata,
} from "../../shared/uk_aq_observation_content_hash.mjs";
import {
  observationContentHashFromLocalParquet,
} from "../../../scripts/backup_r2/lib/uk_aq_observation_parquet_content_hash.mjs";

const SOURCE_DERIVED_OWNER = "source_derived_observation_repair";
const POLLUTANT_MANIFEST_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readOwnedObject(state, key, overlayRoot) {
  const entry = state?.objects?.[key];
  if (!isPlainObject(entry)
    || entry.stage !== "observations_data"
    || entry.proposed !== true
    || entry.built !== true
    || entry.structurally_validated !== true) return null;
  const localPath = String(entry.local_path || "");
  if (!localPath || !isWithin(overlayRoot, localPath)
    || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Source-derived proposal owner has no valid staged object: ${key}`);
  }
  const body = fs.readFileSync(localPath);
  if (body.byteLength !== Number(entry.bytes) || sha256Hex(body) !== entry.sha256) {
    throw new Error(`Source-derived proposal owner identity changed: ${key}`);
  }
  return { entry, localPath, body };
}

function sameStatusCounts(left, right) {
  return ["P", "R", "null"].every((key) =>
    Number(left?.[key]) === Number(right?.[key]));
}

export async function inspectSourceDerivedObservationManifestOwner({
  state,
  manifestKey,
  overlayRoot,
} = {}) {
  const match = String(manifestKey || "").match(POLLUTANT_MANIFEST_PATTERN);
  if (!match) return null;
  const ownedManifest = readOwnedObject(state, manifestKey, overlayRoot);
  if (!ownedManifest) return null;
  const [, dayUtc, connectorIdRaw, pollutantCode] = match;
  const connectorId = Number(connectorIdRaw);
  let payload;
  try {
    payload = JSON.parse(ownedManifest.body.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Source-derived proposal owner has invalid manifest JSON: ${manifestKey} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (payload?.history_version !== "v2"
    || payload?.domain !== "observations"
    || payload?.manifest_kind !== "pollutant"
    || payload?.manifest_key !== manifestKey
    || payload?.day_utc !== dayUtc
    || Number(payload?.connector_id) !== connectorId
    || payload?.pollutant_code !== pollutantCode) {
    throw new Error(`Source-derived proposal owner has invalid manifest identity: ${manifestKey}`);
  }
  validateObservationContentHashMetadata(payload, { rowCount: Number(payload.source_row_count) });
  const partKeys = Array.isArray(payload.parquet_object_keys)
    ? payload.parquet_object_keys.map(String).sort()
    : [];
  const fileEntries = Array.isArray(payload.files) ? payload.files : [];
  if (!partKeys.length || fileEntries.length !== partKeys.length) {
    throw new Error(`Source-derived proposal owner has incomplete Parquet references: ${manifestKey}`);
  }
  const fileEntryByKey = new Map(fileEntries.map((entry) => [String(entry?.key || ""), entry]));
  const filePaths = [];
  const dependencyIdentities = {};
  for (const partKey of partKeys) {
    if (!partKey.startsWith(manifestKey.slice(0, -"manifest.json".length))
      || !partKey.endsWith(".parquet")) {
      throw new Error(`Source-derived proposal owner has an invalid Parquet key: ${manifestKey} -> ${partKey}`);
    }
    const ownedPart = readOwnedObject(state, partKey, overlayRoot);
    if (!ownedPart) {
      throw new Error(`Source-derived proposal owner is missing its staged Parquet: ${manifestKey} -> ${partKey}`);
    }
    const fileEntry = fileEntryByKey.get(partKey);
    if (!isPlainObject(fileEntry)
      || Number(fileEntry.bytes) !== ownedPart.body.byteLength
      || String(fileEntry.etag_or_hash || "") !== sha256Hex(ownedPart.body)) {
      throw new Error(`Source-derived proposal manifest has stale Parquet identity: ${manifestKey} -> ${partKey}`);
    }
    filePaths.push(ownedPart.localPath);
    dependencyIdentities[partKey] = {
      sha256: sha256Hex(ownedPart.body),
      bytes: ownedPart.body.byteLength,
      source: "overlay",
    };
  }
  const semantic = await observationContentHashFromLocalParquet({ filePaths, connectorId });
  if (semantic.observation_content_hash !== payload.observation_content_hash
    || semantic.observation_content_hash_row_count !== payload.observation_content_hash_row_count
    || !sameStatusCounts(semantic.verification_status_counts, payload.verification_status_counts)) {
    throw new Error(`Source-derived proposal manifest does not describe final staged Parquet: ${manifestKey}`);
  }
  Object.assign(ownedManifest.entry, {
    proposal_owner: SOURCE_DERIVED_OWNER,
    proposal_ownership_validated: true,
    proposal_ownership_semantic_hash: semantic.observation_content_hash,
  });
  for (const partKey of partKeys) {
    Object.assign(state.objects[partKey], {
      proposal_owner: SOURCE_DERIVED_OWNER,
      proposal_ownership_validated: true,
    });
  }
  return {
    owner: SOURCE_DERIVED_OWNER,
    key: manifestKey,
    body: ownedManifest.body.toString("utf8"),
    payload,
    file_entries: fileEntries,
    dependencies: partKeys,
    dependency_identities: dependencyIdentities,
    semantic,
  };
}

function substantiveBody(value) {
  try {
    return JSON.stringify(JSON.parse(String(value || "")));
  } catch {
    return null;
  }
}

function normalizedDependencyIdentities(proposal) {
  const dependencies = [...new Set((proposal?.dependencies || []).map(String))].sort();
  return dependencies.map((key) => {
    const identity = proposal?.dependency_identities?.[key] || {};
    return {
      key,
      sha256: String(identity.sha256 || ""),
      bytes: Number(identity.bytes),
      source: String(identity.source || ""),
    };
  });
}

export function compareProposalCollision(existing, candidate) {
  const differingFields = [];
  if (substantiveBody(existing?.proposed_body) === null
    || substantiveBody(candidate?.proposed_body) === null
    || substantiveBody(existing?.proposed_body) !== substantiveBody(candidate?.proposed_body)) {
    differingFields.push("substantive_body");
  }
  if (JSON.stringify(normalizedDependencyIdentities(existing))
    !== JSON.stringify(normalizedDependencyIdentities(candidate))) {
    differingFields.push("dependency_identities");
  }
  return { identical: differingFields.length === 0, differing_fields: differingFields };
}

export { SOURCE_DERIVED_OWNER };
