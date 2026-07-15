function intInRange(value, fallback, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded >= min && rounded <= max ? rounded : fallback;
}

export const STATION_HISTORY_POLICY_DEFAULTS = Object.freeze({
  stableAqiHeadMaxHours: 168,
  aqiChunkMaxHours: 31 * 24,
  observationChunkMaxHours: 7 * 24,
  observationOverlapHours: 2,
  obsAqiDbTimeoutMs: 10_000,
  ingestRetentionDays: 5,
});

export function resolveStationHistoryPolicy(env = {}) {
  return {
    stableAqiHeadMaxHours: intInRange(env.UK_AQ_STATION_HISTORY_STABLE_AQI_HEAD_MAX_HOURS, STATION_HISTORY_POLICY_DEFAULTS.stableAqiHeadMaxHours, 12, 31 * 24),
    aqiChunkMaxHours: intInRange(env.UK_AQ_STATION_HISTORY_AQI_CHUNK_MAX_HOURS, STATION_HISTORY_POLICY_DEFAULTS.aqiChunkMaxHours, 1, 31 * 24),
    observationChunkMaxHours: intInRange(env.UK_AQ_STATION_HISTORY_OBSERVATION_CHUNK_MAX_HOURS, STATION_HISTORY_POLICY_DEFAULTS.observationChunkMaxHours, 1, 31 * 24),
    observationOverlapHours: intInRange(env.UK_AQ_STATION_HISTORY_OBSERVATION_OVERLAP_HOURS, STATION_HISTORY_POLICY_DEFAULTS.observationOverlapHours, 1, 3),
    obsAqiDbTimeoutMs: intInRange(env.UK_AQ_STATION_HISTORY_OBSAQIDB_TIMEOUT_MS, STATION_HISTORY_POLICY_DEFAULTS.obsAqiDbTimeoutMs, 1_000, 60_000),
    ingestRetentionDays: intInRange(env.INGESTDB_RETENTION_DAYS, STATION_HISTORY_POLICY_DEFAULTS.ingestRetentionDays, 1, 31),
  };
}
