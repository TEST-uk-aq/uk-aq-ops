/** Authenticate a local official-RData preservation path against its accepted root. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateR2HistoryV2ObservationsAggregateManifest } from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { assertV2ObservationsChildManifest } from "./uk_aq_v2_observations_manifest_validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function localPath(root, key) {
  if (typeof key !== "string" || !key || key.startsWith("/")
      || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Official RData pinned hierarchy key is invalid");
  }
  const resolved = path.join(root, ...key.split("/"));
  let existing = resolved;
  while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(existing));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Official RData pinned hierarchy escapes its local root");
  }
  return resolved;
}

function childReference(parent, fields, parentKey, childKey, identityField) {
  const parentPrefix = parentKey.slice(0, -"/manifest.json".length);
  const childPattern = fields.includes("connector_manifests")
    ? new RegExp(`^${parentPrefix}/connector_id=[1-9]\\d*/manifest\\.json$`)
    : fields.includes("pollutant_manifests")
      ? new RegExp(`^${parentPrefix}/pollutant_code=[a-z0-9_]+/manifest\\.json$`)
      : null;
  const collections = fields.map((field) => {
    const entries = parent[field];
    if (!Array.isArray(entries)) throw new Error(`Invalid pinned child collection: ${parentKey}:${field}`);
    const byKey = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.manifest_key !== "string" || !entry.manifest_key
          || (childPattern && !childPattern.test(entry.manifest_key))
          || !SHA256.test(String(entry[identityField] || ""))
          || byKey.has(entry.manifest_key)) {
        throw new Error(`Invalid or duplicate pinned child reference: ${parentKey}:${field}`);
      }
      byKey.set(entry.manifest_key, entry);
    }
    return byKey;
  });
  const canonicalEntries = (collection) => [...collection.entries()]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (collections.length > 1 && !isDeepStrictEqual(
    canonicalEntries(collections[0]), canonicalEntries(collections[1]),
  )) {
    throw new Error(`Conflicting pinned child aliases: ${parentKey}`);
  }
  return collections[0].get(childKey) || null;
}

function readManifest(root, key) {
  const body = fs.readFileSync(localPath(root, key), "utf8");
  const payload = JSON.parse(body);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid pinned manifest: ${key}`);
  }
  return payload;
}

export function authenticateOfficialRdataPinnedHierarchy(runState, partition) {
  const day = String(partition?.day_utc || "");
  const connectorId = Number(partition?.connector_id);
  const pollutant = String(partition?.pollutant_code || "");
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  const generation = String(runState?.history_generation || "v2");
  if (!["v2", "v3"].includes(generation) || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day
      || ![9, 10].includes(connectorId)
      || !["pm25", "pm10", "no2", "o3"].includes(pollutant)
      || !["partition_present", "partition_absent"].includes(partition?.baseline_state)) {
    throw new Error("Official RData pinned hierarchy scope is invalid");
  }
  const base = `history/${generation}/observations`;
  const keys = [
    `${base}/_manifests/manifest.json`,
    `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`,
    `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`,
    `${base}/day_utc=${day}/manifest.json`,
    `${base}/day_utc=${day}/connector_id=${connectorId}/manifest.json`,
    `${base}/day_utc=${day}/connector_id=${connectorId}/pollutant_code=${pollutant}/manifest.json`,
  ];
  if (partition.manifest_key !== keys[5]) throw new Error("Official RData preservation manifest key changed");
  const root = String(runState?.base_dropbox_root || "");
  const checkpoint = runState?.dropbox_currentness?.checkpoint;
  const liveRoot = runState?.dropbox_currentness?.live_observations_root;
  if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()
      || runState?.dropbox_currentness?.allowed !== true
      || runState?.dropbox_currentness?.checkpoint_live_root_match !== true
      || !SHA256.test(String(checkpoint?.observations_processed_source_root_hash || ""))
      || liveRoot?.key !== keys[0]
      || liveRoot?.content_hash !== checkpoint.observations_processed_source_root_hash) {
    throw new Error("Official RData accepted pinned root is unavailable");
  }
  let parent = null;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const exists = fs.statSync(localPath(root, key), { throwIfNoEntry: false })?.isFile() === true;
    const fields = index <= 3 ? ["children"] : index === 4
      ? ["connector_manifests", "child_manifests"]
      : ["pollutant_manifests", "child_manifests"];
    const identityField = index <= 2 ? "content_hash" : "manifest_hash";
    const reference = parent ? childReference(parent, fields, keys[index - 1], key, identityField) : null;
    if (!exists) {
      if (!parent || reference || partition.baseline_state !== "partition_absent"
          || keys.slice(index).some((later) => fs.existsSync(localPath(root, later))
            || fs.existsSync(path.dirname(localPath(root, later))))) {
        throw new Error("Official RData pinned hierarchy does not authenticate absence");
      }
      return "partition_absent";
    }
    if (parent && !reference) throw new Error(`Unreferenced pinned child exists: ${key}`);
    const payload = readManifest(root, key);
    let actualHash;
    if (index <= 2) {
      const canonical = validateR2HistoryV2ObservationsAggregateManifest(payload, { basePrefix: base });
      if (!isDeepStrictEqual(payload, canonical)) throw new Error(`Noncanonical pinned aggregate: ${key}`);
      actualHash = canonical.content_hash;
    } else {
      const kind = index === 3 ? "day" : index === 4 ? "connector" : "pollutant";
      assertV2ObservationsChildManifest(payload, {
        key, kind, dayUtc: day, connectorId: index === 3 ? null : connectorId,
      });
      if (index === 5 && payload.pollutant_code !== pollutant) {
        throw new Error("Official RData pinned pollutant scope changed");
      }
      actualHash = payload.manifest_hash;
    }
    if (index === 0) {
      if (actualHash !== checkpoint.observations_processed_source_root_hash) {
        throw new Error("Official RData pinned root differs from accepted checkpoint");
      }
    } else if (reference[identityField] !== actualHash) {
      throw new Error(`Official RData pinned parent/child identity changed: ${key}`);
    }
    parent = payload;
  }
  if (partition.baseline_state !== "partition_present") {
    throw new Error("Official RData claimed absence contradicts pinned hierarchy");
  }
  return "partition_present";
}

// The Python admission invokes the same canonical JS hash implementations locally.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(`${authenticateOfficialRdataPinnedHierarchy(input.run_state, input.partition)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
