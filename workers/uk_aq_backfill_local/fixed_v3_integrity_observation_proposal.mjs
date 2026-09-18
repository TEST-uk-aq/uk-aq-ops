import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

/**
 * Build (but do not publish) one fixed-v3 SOS Integrity pollutant partition.
 * The shared steady-state writer remains the sole authority for both the
 * physical Parquet files and the pollutant manifest describing those files.
 */
export function buildFixedV3IntegrityObservationProposal({
  rows,
  dayUtc,
  connectorId,
  pollutantCode,
  targetWriterGitSha,
  backedUpAtUtc,
  observationsPrefix,
  indexRoot,
}) {
  return buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows,
    scope: {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
    },
    targetWriterGitSha,
    backedUpAtUtc,
    observationsPrefix,
    indexRoot,
  });
}
