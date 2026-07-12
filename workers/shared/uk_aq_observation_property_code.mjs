export const OBSERVATION_PROPERTY_CODE_SQL_PATTERN = "^[a-z0-9_]+$";

const OBSERVATION_PROPERTY_CODE_REGEX = new RegExp(
  OBSERVATION_PROPERTY_CODE_SQL_PATTERN,
);

export function normalizeObservationPropertyCode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return OBSERVATION_PROPERTY_CODE_REGEX.test(value) ? value : null;
}
