import { getObservationHistoryGeneration, resolveObservationHistoryGeneration } from "./uk_aq_observation_history_generation.mjs";

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
    timeseries_binding_index_prefix: null
  }),
  v2: Object.freeze({
    version: "v2",
    ...getObservationHistoryGeneration("v2"),
    aqilevels_hourly_data_prefix: "history/v2/aqilevels/hourly/data",
    aqilevels_hourly_debug_prefix: "history/v2/aqilevels/hourly/debug",
    core_prefix: "history/v2/core",
    observations_runs_prefix: "history/v2/_ops/observations/runs",
    index_root_prefix: "history/_index_v2",
    observations_timeseries_index_prefix: "history/_index_v2/observations_timeseries",
    aqilevels_timeseries_index_prefix: "history/_index_v2/aqilevels_hourly_data_timeseries",
    timeseries_binding_index_prefix: "history/_index_v2/timeseries_binding"
  }),
  v3: Object.freeze({
    ...getObservationHistoryGeneration("v3"),
    core_prefix: "history/v2/core",
    aqilevels_hourly_data_prefix: "history/v2/aqilevels/hourly/data",
    aqilevels_hourly_debug_prefix: "history/v2/aqilevels/hourly/debug",
    aqilevels_timeseries_index_prefix: "history/_index_v2/aqilevels_hourly_data_timeseries",
  })
});

export function getR2HistoryProfile(version) {
  if (version !== "v1" && version !== "v2" && version !== "v3") {
    throw new Error(`Invalid R2 history version: ${version}`);
  }
  return PROFILES[version];
}

export function resolveR2HistoryProfile(env, options = {}) {
  const { version } = resolveObservationHistoryGeneration(env);
  return getR2HistoryProfile(version);
}

export function assertR2HistoryProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("Missing or invalid profile object");
  }
  if (!profile.version || (profile.version !== "v1" && profile.version !== "v2" && profile.version !== "v3")) {
    throw new Error("Profile is missing a valid version field");
  }
  if (profile !== PROFILES[profile.version]) {
    throw new Error("Profile is not an official immutable profile object");
  }
}
