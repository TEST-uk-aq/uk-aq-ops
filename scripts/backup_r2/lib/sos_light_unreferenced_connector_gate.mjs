/** Read-only, pinned Dropbox connector membership gate for fixed SOS-light. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { validateCanonicalHistoryV2Manifest } from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { validateR2HistoryV2ObservationsAggregateManifest } from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";

export const UNREFERENCED_CONNECTOR_BLOCK = "dropbox_unreferenced_physical_connector_blocked";
const SHA256 = /^[a-f0-9]{64}$/;
const SAMPLE_LIMIT = 10;
const sha256 = (body) => createHash("sha256").update(body).digest("hex");

function pinnedFile(root, key, required = true) {
  const candidate = path.join(root, ...key.split("/"));
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) {
    if (required) throw new Error(`Pinned Dropbox object is missing: ${key}`);
    return null;
  }
  if (!stat.isFile()) throw new Error(`Pinned Dropbox object is not a regular file: ${key}`);
  return fs.readFileSync(candidate);
}

function pinnedAggregate(root, key, prefix, expectedHash) {
  const body = pinnedFile(root, key);
  const payload = validateR2HistoryV2ObservationsAggregateManifest(
    JSON.parse(body.toString("utf8")), { basePrefix: prefix },
  );
  if (payload.content_hash !== expectedHash) {
    throw new Error(`Pinned Dropbox aggregate identity changed: ${key}`);
  }
  return payload;
}

function pinnedDayMembership(root, prefix, dayUtc, rootManifest) {
  const dayKey = `${prefix}/day_utc=${dayUtc}/manifest.json`;
  const year = dayUtc.slice(0, 4);
  const month = dayUtc.slice(5, 7);
  const yearReference = rootManifest.children.find((entry) => Number(entry.year) === Number(year));
  let dayReference = null;
  if (yearReference) {
    const yearKey = `${prefix}/_manifests/year=${year}/manifest.json`;
    if (yearReference.manifest_key !== yearKey) throw new Error(`Pinned Dropbox year key changed: ${yearKey}`);
    const yearManifest = pinnedAggregate(root, yearKey, prefix, yearReference.content_hash);
    if (yearManifest.kind !== "uk_aq_observations_year_manifest"
        || Number(yearManifest.year) !== Number(year)) {
      throw new Error(`Pinned Dropbox year identity changed: ${yearKey}`);
    }
    const monthReference = yearManifest.children.find((entry) => entry.month === month);
    if (monthReference) {
      const monthKey = `${prefix}/_manifests/year=${year}/month=${month}/manifest.json`;
      if (monthReference.manifest_key !== monthKey) throw new Error(`Pinned Dropbox month key changed: ${monthKey}`);
      const monthManifest = pinnedAggregate(root, monthKey, prefix, monthReference.content_hash);
      if (monthManifest.kind !== "uk_aq_observations_month_manifest"
          || Number(monthManifest.year) !== Number(year) || monthManifest.month !== month) {
        throw new Error(`Pinned Dropbox month identity changed: ${monthKey}`);
      }
      dayReference = monthManifest.children.find((entry) => entry.day_utc === dayUtc) || null;
    }
  }
  const dayBody = pinnedFile(root, dayKey, false);
  if (Boolean(dayReference) !== Boolean(dayBody)) {
    throw new Error(`Pinned Dropbox day presence contradicts its aggregate parent: ${dayKey}`);
  }
  if (!dayBody) return { dayKey, present: false, hash: null, connectorIds: [] };
  const manifest = JSON.parse(dayBody.toString("utf8"));
  validateCanonicalHistoryV2Manifest(manifest, {
    history_version: "v2", domain: "observations", manifest_kind: "day",
    day_utc: dayUtc, manifest_key: dayKey,
  });
  if (manifest.manifest_hash !== dayReference.manifest_hash) {
    throw new Error(`Pinned Dropbox day identity changed: ${dayKey}`);
  }
  const references = (field) => {
    if (!Array.isArray(manifest[field])) throw new Error(`Pinned day connector ${field} is invalid: ${dayKey}`);
    const seen = new Set();
    return manifest[field].map((entry) => {
      const id = Number(entry?.connector_id);
      const key = `${prefix}/day_utc=${dayUtc}/connector_id=${id}/manifest.json`;
      const hash = String(entry?.manifest_hash || "").trim().toLowerCase();
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)
          || entry?.manifest_key !== key || !SHA256.test(hash)) {
        throw new Error(`Pinned day connector ${field} is invalid: ${dayKey}`);
      }
      seen.add(id);
      return { connector_id: id, manifest_key: key, manifest_hash: hash };
    }).sort((left, right) => left.connector_id - right.connector_id);
  };
  const connectorReferences = references("connector_manifests");
  const childReferences = references("child_manifests");
  const ids = connectorReferences.map((entry) => entry.connector_id);
  const scalarIds = Array.isArray(manifest.connector_ids)
    ? manifest.connector_ids.map(Number) : null;
  if (JSON.stringify(connectorReferences) !== JSON.stringify(childReferences)
      || JSON.stringify(ids) !== JSON.stringify(scalarIds)
      || JSON.stringify(ids) !== JSON.stringify([...new Set(ids)].sort((a, b) => a - b))) {
    throw new Error(`Pinned day connector representations disagree: ${dayKey}`);
  }
  return { dayKey, present: true, hash: manifest.manifest_hash, connectorIds: ids };
}

function physicalConnectors(root, prefix, dayUtc) {
  const dayKey = `${prefix}/day_utc=${dayUtc}`;
  const dayPath = path.join(root, ...dayKey.split("/"));
  if (!fs.lstatSync(dayPath, { throwIfNoEntry: false })) return [];
  const found = [];
  for (const dirent of fs.readdirSync(dayPath, { withFileTypes: true })) {
    const match = dirent.name.match(/^connector_id=([1-9]\d*)$/);
    if (!match || Number(match[1]) === 1) continue;
    if (!dirent.isDirectory()) throw new Error(`Pinned Dropbox connector path is not a directory: ${dayKey}/${dirent.name}`);
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) throw new Error(`Pinned Dropbox connector ID is invalid: ${dayKey}/${dirent.name}`);
    const connectorKey = `${dayKey}/${dirent.name}`;
    const keys = [];
    const connectorPath = path.join(dayPath, dirent.name);
    for (const entry of fs.readdirSync(connectorPath, { withFileTypes: true })) {
      if (entry.name === "manifest.json") {
        if (!entry.isFile()) throw new Error(`Pinned Dropbox connector manifest is not a regular file: ${connectorKey}/manifest.json`);
        keys.push(`${connectorKey}/manifest.json`);
      } else if (/^pollutant_code=[a-z0-9_]+$/.test(entry.name) && entry.isDirectory()) {
        const pollutantKey = `${connectorKey}/${entry.name}`;
        for (const leaf of fs.readdirSync(path.join(connectorPath, entry.name), { withFileTypes: true })) {
          if (leaf.name === "manifest.json" || /^[^/]+\.parquet$/.test(leaf.name)) {
            if (!leaf.isFile()) throw new Error(`Pinned Dropbox observation object is not a regular file: ${pollutantKey}/${leaf.name}`);
            keys.push(`${pollutantKey}/${leaf.name}`);
          }
        }
      }
    }
    if (keys.length) found.push({
      connector_id: id,
      connector_parent_manifest_present: keys.includes(`${connectorKey}/manifest.json`),
      physical_object_count: keys.length,
      representative_keys: keys.sort().slice(0, SAMPLE_LIMIT),
    });
  }
  return found.sort((a, b) => a.connector_id - b.connector_id);
}

export function inspectPinnedSosLightConnectorGate({ runState, generation, selectedDays, dropboxRoot = null }) {
  const selected = getObservationHistoryGeneration(generation);
  const prefix = selected.observations_prefix;
  const root = path.resolve(String(runState?.base_dropbox_root || ""));
  if (dropboxRoot !== null && path.resolve(String(dropboxRoot)) !== root) {
    throw new Error("SOS-light planner Dropbox root differs from its pinned run state");
  }
  const currentness = runState?.dropbox_currentness;
  const checkpoint = currentness?.checkpoint;
  const liveRoot = currentness?.live_observations_root;
  const rootKey = `${prefix}/_manifests/manifest.json`;
  const checkpointKey = `${selected.backup_state_prefix}/root.json`;
  if (runState?.execution_path !== "sos_light" || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()
      || currentness?.allowed !== true || currentness?.checkpoint_live_root_match !== true
      || checkpoint?.relative_key !== checkpointKey
      || path.resolve(String(checkpoint?.path || "")) !== path.join(root, ...checkpointKey.split("/"))
      || !SHA256.test(String(checkpoint?.sha256 || ""))
      || checkpoint?.sha256 !== sha256(pinnedFile(root, checkpointKey))
      || !SHA256.test(String(checkpoint?.observations_processed_source_root_hash || ""))
      || liveRoot?.key !== rootKey
      || liveRoot?.content_hash !== checkpoint.observations_processed_source_root_hash) {
    throw new Error("SOS-light pinned Dropbox/checkpoint authority is unavailable");
  }
  const rootManifest = pinnedAggregate(
    root, rootKey, prefix, checkpoint.observations_processed_source_root_hash,
  );
  if (rootManifest.kind !== "uk_aq_observations_root_manifest") {
    throw new Error(`Pinned Dropbox root identity changed: ${rootKey}`);
  }
  const days = [];
  const blocked = [];
  for (const dayUtc of [...new Set(selectedDays)].sort()) {
    const parsed = new Date(`${dayUtc}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || Number.isNaN(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== dayUtc) {
      throw new Error(`SOS-light selected day is invalid: ${dayUtc}`);
    }
    const day = pinnedDayMembership(root, prefix, dayUtc, rootManifest);
    const physical = physicalConnectors(root, prefix, dayUtc);
    const offending = physical.filter((entry) => !day.connectorIds.includes(entry.connector_id));
    const evidence = {
      history_generation: generation,
      day_utc: dayUtc,
      pinned_day_manifest_key: day.dayKey,
      pinned_day_manifest_present: day.present,
      pinned_day_manifest_hash: day.hash,
      pinned_baseline_connector_ids: day.connectorIds,
      accepted_dropbox_checkpoint: {
        relative_key: checkpointKey,
        sha256: checkpoint.sha256,
        observations_processed_source_root_hash: checkpoint.observations_processed_source_root_hash,
      },
      physical_non_sos_connectors: physical,
      offending_connector_ids: offending.map((entry) => entry.connector_id),
    };
    days.push(evidence);
    if (offending.length) blocked.push({
      ...evidence,
      status: "blocked_dependency",
      classification: UNREFERENCED_CONNECTOR_BLOCK,
      reason: "Physical Dropbox observation objects belong to a connector absent from the pinned day manifest",
      r2_observation_index_mutation_count: 0,
    });
  }
  return { days, blocked };
}

export function requirePinnedSosLightConnectorGate({ runState, generation, selectedDays }) {
  const actual = inspectPinnedSosLightConnectorGate({ runState, generation, selectedDays });
  if (actual.blocked.length) {
    const error = new Error(`Blocked dependency: ${UNREFERENCED_CONNECTOR_BLOCK}: ${JSON.stringify(actual.blocked)}`);
    error.classification = UNREFERENCED_CONNECTOR_BLOCK;
    error.evidence = actual.blocked;
    throw error;
  }
  const auditDays = runState?.sos_light?.days;
  if (!Array.isArray(auditDays) || auditDays.length !== actual.days.length
      || actual.days.some((day) => JSON.stringify(
        auditDays.find((entry) => entry?.day_utc === day.day_utc)?.unreferenced_physical_connector_gate,
      ) !== JSON.stringify(day))) {
    throw new Error("SOS-light pinned physical-connector gate evidence is missing or changed");
  }
  return actual.days;
}
