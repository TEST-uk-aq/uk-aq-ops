import { resolveR2HistoryVersion, UK_AQ_R2_HISTORY_VERSION_ENV } from "./uk_aq_r2_history_version.mjs";

const PROFILES = Object.freeze({
  v1: Object.freeze({
    version: "v1",
    observations_prefix: "history/v1/observations",
    aqilevels_hourly_data_prefix: "history/v1/aqilevels/hourly",
    aqilevels_hourly_debug_prefix: null,
    core_prefix: "history/v1/core",
    observations_runs_prefix: "history/v1/_ops/observations/runs",
    index_root_prefix: "history/_index",
    observations_timeseries_index_prefix: "history/_index/observations_timeseries",
    aqilevels_timeseries_index_prefix: "history/_index/aqilevels_timeseries",
    timeseries_metadata_index_prefix: null,
    backup_inventory_rel_path: "history/_index/backup_inventory_v1.json",
    backup_state_rel_path: "_ops/checkpoints/r2_history_backup_state_v1.json"
  }),
  v2: Object.freeze({
    version: "v2",
    observations_prefix: "history/v2/observations",
    aqilevels_hourly_data_prefix: "history/v2/aqilevels/hourly/data",
    aqilevels_hourly_debug_prefix: "history/v2/aqilevels/hourly/debug",
    core_prefix: "history/v2/core",
    observations_runs_prefix: "history/v2/_ops/observations/runs",
    index_root_prefix: "history/_index_v2",
    observations_timeseries_index_prefix: "history/_index_v2/observations_timeseries",
    aqilevels_timeseries_index_prefix: "history/_index_v2/aqilevels_hourly_data_timeseries",
    timeseries_metadata_index_prefix: "history/_index_v2/timeseries",
    backup_inventory_rel_path: "history/_index_v2/backup_inventory_v2.json",
    backup_state_rel_path: "_ops/checkpoints/r2_history_backup_state_v2.json"
  })
});

export function getR2HistoryProfile(version) {
  if (version !== "v1" && version !== "v2") {
    throw new Error(`Invalid R2 history version: ${version}`);
  }
  return PROFILES[version];
}

export function resolveR2HistoryProfile(env, options = {}) {
  const version = resolveR2HistoryVersion(env, options);
  return getR2HistoryProfile(version);
}

export function assertR2HistoryProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("Missing or invalid profile object");
  }
  if (!profile.version || (profile.version !== "v1" && profile.version !== "v2")) {
    throw new Error("Profile is missing a valid version field");
  }
  if (profile !== PROFILES[profile.version]) {
    throw new Error("Profile is not an official immutable profile object");
  }
}
