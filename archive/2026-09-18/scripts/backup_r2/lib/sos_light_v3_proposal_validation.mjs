/** Fixed-v3, SOS-light-only proposal validation boundary. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadImmutableSourcePartition,
} from "../uk_aq_apply_integrity_proposal.mjs";

const OBSERVATIONS_PREFIX = "history/v3/observations";
const INDEX_PREFIX = "history/_index_v3";
const V2_OBSERVATIONS_PREFIX = "history/v2/observations";
const V2_INDEX_PREFIX = "history/_index_v2";
const DAY_PREFIX = /^history\/v3\/observations\/day_utc=(\d{4}-\d{2}-\d{2})$/;
const POLLUTANT_PREFIX = /^history\/v3\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
const POLLUTANT_MANIFEST = new RegExp(`${POLLUTANT_PREFIX.source.slice(1, -1)}\\/manifest\\.json$`);
const SHA256 = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function sha256(body) { return createHash("sha256").update(body).digest("hex"); }
function safeKey(raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe fixed-v3 proposal key: ${String(raw)}`);
  }
  return key;
}
function validDay(day) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return DAY.test(day) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
function exactArray(value, expected) { return JSON.stringify(value) === JSON.stringify(expected); }
function localBody(entry, key) {
  const localPath = String(entry?.local_path || "");
  if (!entry?.proposed || !entry?.built || !entry?.structurally_validated
      || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Fixed-v3 staged object is not structurally validated: ${key}`);
  }
  const body = fs.readFileSync(localPath);
  if (!Number.isSafeInteger(Number(entry.bytes)) || body.byteLength !== Number(entry.bytes)
      || !SHA256.test(String(entry.sha256 || "")) || sha256(body) !== entry.sha256) {
    throw new Error(`Fixed-v3 staged object identity changed: ${key}`);
  }
  return { localPath, body };
}
function externalDependency(runState, objectKey, dependencyKey, identity) {
  if (!identity || !["dropbox", "overlay"].includes(identity.source)) {
    throw new Error(`Fixed-v3 dependency is neither current-run nor pinned baseline: ${objectKey} -> ${dependencyKey}`);
  }
  const root = path.resolve(String(identity.source === "dropbox" ? runState.base_dropbox_root : runState.overlay_root));
  const localPath = path.resolve(root, ...dependencyKey.split("/"));
  if (!localPath.startsWith(`${root}${path.sep}`) || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Fixed-v3 external dependency is unavailable: ${objectKey} -> ${dependencyKey}`);
  }
  const body = fs.readFileSync(localPath);
  if (body.byteLength !== Number(identity.bytes) || sha256(body) !== identity.sha256) {
    throw new Error(`Fixed-v3 external dependency identity changed: ${objectKey} -> ${dependencyKey}`);
  }
}
function validateDependencies(runState, key, entry) {
  if (!Array.isArray(entry.dependencies)) throw new Error(`Fixed-v3 dependencies are not an array: ${key}`);
  const dependencies = entry.dependencies.map(safeKey);
  if (new Set(dependencies).size !== dependencies.length) throw new Error(`Fixed-v3 dependencies are duplicated: ${key}`);
  const identities = entry.dependency_identities;
  if (!identities || typeof identities !== "object" || Array.isArray(identities)
      || !exactArray(Object.keys(identities).sort(), [...dependencies].sort())) {
    throw new Error(`Fixed-v3 dependency identities are not exact: ${key}`);
  }
  for (const dependencyKey of dependencies) {
    const identity = identities[dependencyKey];
    if (!identity || !SHA256.test(String(identity.sha256 || ""))
        || !Number.isSafeInteger(Number(identity.bytes)) || Number(identity.bytes) < 0) {
      throw new Error(`Fixed-v3 dependency identity is invalid: ${key} -> ${dependencyKey}`);
    }
    const staged = runState.objects?.[dependencyKey];
    if (staged) {
      const { body } = localBody(staged, dependencyKey);
      if (identity.source !== "planned_overlay" || body.byteLength !== Number(identity.bytes)
          || sha256(body) !== identity.sha256) {
        throw new Error(`Fixed-v3 current-run dependency identity is invalid: ${key} -> ${dependencyKey}`);
      }
    } else externalDependency(runState, key, dependencyKey, identity);
  }
}

export function validateDedicatedSosHistoricalProposalV3({ runState, proposal }) {
  if (runState?.execution_path !== "sos_light" || runState.mode !== "sos-light"
      || !["TEST", "LIVE"].includes(runState.environment)
      || !exactArray(runState.mutation_connector_ids, [1])
      || !exactArray(runState.selected_mutation_connector_ids, [1])
      || !exactArray(runState.protected_connector_ids, [1])
      || runState.aqi_policy !== "bypassed_observation_history_only") {
    throw new Error("SOS-light-v3 proposal has invalid execution or connector scope");
  }
  const audit = runState.sos_light;
  if (audit?.mode !== "sos-light" || audit?.validation_status !== "complete_local_days_validated"
      || audit?.old_live_r2_observation_bodies_used !== false
      || audit?.no_old_live_r2_body_planning_or_preservation !== true) {
    throw new Error("SOS-light-v3 proposal has invalid reconstruction authority evidence");
  }
  for (const scope of ["AQILEVELS_CHANGED", "AQI_MANIFESTS_CHANGED", "AQI_INDEXES_CHANGED"]) {
    if ((runState.changed_scopes?.[scope] || []).length) throw new Error("SOS-light-v3 must not mutate AQI");
  }
  const selectedDays = [...new Set((audit.days || []).map((entry) => String(entry?.day_utc || "")))].sort();
  if (!selectedDays.length || selectedDays.some((day) => !validDay(day))) throw new Error("SOS-light-v3 selected days are invalid");
  const deletionDays = proposal.prefixes.map(({ prefix, entry }) => {
    const match = prefix.match(DAY_PREFIX);
    if (!match || entry?.stage !== "sos_light_complete_day") throw new Error(`SOS-light-v3 deletion is not a complete observation day: ${prefix}`);
    return match[1];
  }).sort();
  if (!exactArray(selectedDays, deletionDays)) throw new Error("SOS-light-v3 requires exactly one complete observation-day deletion per selected day");
  const keys = new Set(proposal.objects.map(({ key }) => key));
  for (const day of selectedDays) {
    const root = `${OBSERVATIONS_PREFIX}/day_utc=${day}`;
    if (!keys.has(`${root}/manifest.json`) || !keys.has(`${root}/connector_id=1/manifest.json`)) {
      throw new Error(`SOS-light-v3 assembled day lacks required parents: ${day}`);
    }
  }
  return { dedicated: true, mode: "sos-light", connector_id: 1, selected_days: selectedDays };
}

export function validateLocalSosLightV3Proposal(runState) {
  if (!runState || typeof runState !== "object") throw new Error("SOS-light-v3 run state must be an object");
  const objects = Object.entries(runState.objects || {}).map(([rawKey, entry]) => {
    const key = safeKey(rawKey);
    if (key.startsWith(V2_OBSERVATIONS_PREFIX) || key.startsWith(V2_INDEX_PREFIX)
        || !(key.startsWith(`${OBSERVATIONS_PREFIX}/`) || key.startsWith(`${INDEX_PREFIX}/`))
        || key.includes("/aqilevels/")) throw new Error(`Non-v3 SOS-light proposal key: ${key}`);
    const loaded = localBody(entry, key);
    validateDependencies(runState, key, entry);
    return { key, entry, ...loaded, domain: "observations" };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const prefixes = (runState.tombstone_prefixes || []).map((entry) => {
    const prefix = safeKey(entry?.prefix).replace(/\/+$/, "");
    if (!entry?.proposed || !DAY_PREFIX.test(prefix)) throw new Error(`Non-v3 SOS-light deletion prefix: ${prefix}`);
    return { entry, prefix, domain: "observations" };
  }).sort((a, b) => a.prefix.localeCompare(b.prefix));
  if (!objects.length || !prefixes.length) throw new Error("SOS-light-v3 proposal has no complete-day operations");
  const proposal = { objects, prefixes };
  validateDedicatedSosHistoricalProposalV3({ runState, proposal });
  return proposal;
}

export async function validateFinalSosLightV3ProposalGraph({ runState, proposal }) {
  const dedicated = validateDedicatedSosHistoricalProposalV3({ runState, proposal });
  const evidence = runState.source_evidence_partitions;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("SOS-light-v3 immutable source evidence is absent");
  const objects = new Map(proposal.objects.map((object) => [object.key, object]));
  for (const object of proposal.objects.filter(({ key }) => key.endsWith("/manifest.json") && key.includes("/pollutant_code="))) {
    const match = object.key.match(POLLUTANT_MANIFEST);
    if (!match || !dedicated.selected_days.includes(match[1])) {
      throw new Error(`SOS-light-v3 pollutant manifest is outside the selected complete days: ${object.key}`);
    }
    let manifest;
    try { manifest = JSON.parse(object.body.toString("utf8")); }
    catch { throw new Error(`SOS-light-v3 pollutant manifest is invalid JSON: ${object.key}`); }
    const partKeys = (manifest.parquet_object_keys || []).map(String);
    const prefix = object.key.slice(0, -"/manifest.json".length);
    if (!Number.isSafeInteger(Number(manifest.row_count)) || Number(manifest.row_count) < 0
        || partKeys.some((key) => !objects.has(key) || !key.startsWith(`${prefix}/`) || !key.endsWith(".parquet"))) {
      throw new Error(`SOS-light-v3 canonical pollutant partition is structurally incomplete: ${object.key}`);
    }
  }
  const partitions = [];
  for (const [identity] of Object.entries(evidence).sort()) {
    const match = identity.match(/^day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/);
    if (!match || !dedicated.selected_days.includes(match[1]) || Number(match[2]) !== 1) throw new Error(`SOS-light-v3 source evidence scope is invalid: ${identity}`);
    const prefix = `${OBSERVATIONS_PREFIX}/${identity}`;
    const manifestKey = `${prefix}/manifest.json`;
    const manifestObject = objects.get(manifestKey);
    if (!manifestObject || !POLLUTANT_MANIFEST.test(manifestKey)) throw new Error(`SOS-light-v3 canonical pollutant partition is missing: ${identity}`);
    const source = loadImmutableSourcePartition({ runState, dayUtc: match[1], connectorId: 1, pollutantCode: match[3] });
    const manifest = JSON.parse(manifestObject.body.toString("utf8"));
    const partKeys = (manifest.parquet_object_keys || []).map(String);
    if (partKeys.some((key) => !objects.has(key) || !key.startsWith(`${prefix}/`) || !key.endsWith(".parquet"))) {
      throw new Error(`SOS-light-v3 pollutant partition is structurally incomplete: ${identity}`);
    }
    if (Number(manifest.row_count) !== source.rows.length) throw new Error(`SOS-light-v3 source/manifest row count differs: ${identity}`);
    partitions.push({ status: "validated", manifest_key: manifestKey, source_content_hash: source.metadata.observation_content_hash, row_count: source.rows.length });
    manifestObject.entry.final_proposal_graph_validated = true;
  }
  const requestedPollutants = [...new Set((runState.requested_repair_pollutants || []).map((value) => String(value).trim().toLowerCase()))].sort();
  for (const day of dedicated.selected_days) for (const pollutant of requestedPollutants) {
    if (!partitions.some((entry) => entry.manifest_key === `${OBSERVATIONS_PREFIX}/day_utc=${day}/connector_id=1/pollutant_code=${pollutant}/manifest.json`)) {
      throw new Error(`SOS-light-v3 selected day lacks requested canonical pollutant partition: ${day}/${pollutant}`);
    }
  }
  runState.final_proposal_graph_validation = {
    status: "succeeded", selected_partition_count: partitions.length,
    validated_partition_count: partitions.length, partitions,
    parent_and_index_dependencies_validated: true, tombstones_validated: true,
    generation: "v3", completed_at_utc: new Date().toISOString(),
  };
  return runState.final_proposal_graph_validation;
}
