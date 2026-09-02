export const ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 = Object.freeze({
  target_row_group_rows: 8192,
  max_row_group_rows: 16384,
  target_file_rows: 65536,
  max_file_rows: 131072,
  target_file_bytes: 4194304,
  max_file_bytes: 8388608,
  max_row_groups_per_file: 8,
});

const LIMIT_KEYS = Object.freeze(
  Object.keys(ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3),
);

export function assertAcceptedObservationHistoryWriterLimitsV3(
  value,
  fieldName = "observation-history v3 writer limits",
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...LIMIT_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${fieldName} must contain exactly the accepted Phase 6 fields`);
  }
  for (const key of LIMIT_KEYS) {
    if (Number(value[key]) !== ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3[key]) {
      throw new Error(
        `${fieldName}.${key} must equal the accepted Phase 6 value ` +
          `${ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3[key]}`,
      );
    }
  }
  return ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3;
}
