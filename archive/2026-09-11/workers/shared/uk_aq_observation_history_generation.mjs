// Complete storage generation; canonical row/schema versions retain their meanings.
import { assertNoDeprecatedR2HistoryVersionVars } from "./uk_aq_r2_history_version.mjs";

const GENERATIONS = Object.freeze(Object.fromEntries(["v2", "v3"].map((version) => {
  const observations = `history/${version}/observations`;
  const indexes = `history/_index_${version}`;
  return [version, Object.freeze({
    version,
    observations_prefix: observations,
    observations_root_key: `${observations}/_manifests/manifest.json`,
    observations_runs_prefix: `history/${version}/_ops/observations/runs`,
    index_root_prefix: indexes,
    observations_timeseries_index_prefix: `${indexes}/observations_timeseries`,
    observations_timeseries_latest_key: `${indexes}/observations_timeseries_latest.json`,
    timeseries_binding_index_prefix: `${indexes}/timeseries_binding`,
    core_prefix: `history/${version}/core`,
    backup_inventory_prefix: `${indexes}/backup_inventory_v2`,
    backup_state_prefix: `_ops/checkpoints/r2_history_backup_state_v2${version === "v3" ? "/generation=v3" : ""}`,
    timeseries_binding_pack_prefix: `history/_backup_packs_v1/timeseries_binding${version === "v3" ? "/generation=v3" : ""}`,
  })];
})));

// Migration uses explicit source and target objects, independently of runtime.
export function getObservationHistoryGeneration(version) {
  if (version !== "v2" && version !== "v3") {
    throw new Error("Observation history generation must be exactly v2 or v3");
  }
  return GENERATIONS[version];
}

export function resolveObservationHistoryGeneration(env = {}) {
  assertNoDeprecatedR2HistoryVersionVars(env, { context: "Observation history generation" });
  // UK_AQ_R2_HISTORY_INDEX_VERSION has no routing authority.
  return getObservationHistoryGeneration(env.UK_AQ_R2_HISTORY_VERSION);
}

export function assertObservationHistoryGeneration(generation) {
  if (!generation || generation !== getObservationHistoryGeneration(generation.version)) {
    throw new Error("Observation history requires an immutable shared generation");
  }
  return generation;
}

export function assertObservationHistoryGenerationKey(generation, key, domain = "observations") {
  assertObservationHistoryGeneration(generation);
  const prefixes = {
    observations: generation.observations_prefix,
    observation_index: generation.observations_timeseries_index_prefix,
    bindings: generation.timeseries_binding_index_prefix,
    runs: generation.observations_runs_prefix,
    core: generation.core_prefix,
    backup_inventory: generation.backup_inventory_prefix,
    backup_state: generation.backup_state_prefix,
    packs: generation.timeseries_binding_pack_prefix,
  };
  const prefix = prefixes[domain];
  if ((["packs", "backup_state"].includes(domain) && generation.version === "v2" &&
      typeof key === "string" && key.startsWith(`${prefix}/generation=`)) || typeof key !== "string" || key.split("/").some((part) =>
    !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part)
  ) || (domain === "latest"
    ? key !== generation.observations_timeseries_latest_key
    : !prefix || !key.startsWith(`${prefix}/`))) {
    throw new Error(`Object key is outside ${generation.version} ${domain}: ${String(key)}`);
  }
  return key;
}

export function assertObservationHistoryGenerationPrefixes(generation, {
  observationsPrefix = generation.observations_prefix,
  indexRoot = generation.observations_timeseries_index_prefix,
  indexPrefix = generation.index_root_prefix,
  latestKey = generation.observations_timeseries_latest_key,
  bindingPrefix = generation.timeseries_binding_index_prefix,
  runsPrefix = generation.observations_runs_prefix,
  corePrefix = generation.core_prefix,
  inventoryPrefix = generation.backup_inventory_prefix,
  statePrefix = generation.backup_state_prefix,
  packPrefix = generation.timeseries_binding_pack_prefix,
} = {}) {
  assertObservationHistoryGeneration(generation);
  if (observationsPrefix !== generation.observations_prefix ||
      indexRoot !== generation.observations_timeseries_index_prefix ||
      indexPrefix !== generation.index_root_prefix ||
      latestKey !== generation.observations_timeseries_latest_key ||
      bindingPrefix !== generation.timeseries_binding_index_prefix ||
      runsPrefix !== generation.observations_runs_prefix ||
      corePrefix !== generation.core_prefix ||
      inventoryPrefix !== generation.backup_inventory_prefix ||
      statePrefix !== generation.backup_state_prefix ||
      packPrefix !== generation.timeseries_binding_pack_prefix) {
    throw new Error(`Observation history prefixes must describe complete ${generation.version}`);
  }
  return generation;
}
