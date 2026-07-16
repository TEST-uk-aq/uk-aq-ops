/**
 * Current-value eligibility for the latest-snapshot matrix.
 *
 * This module deliberately has no runtime-specific imports so the Deno builder
 * and a later Node recovery tool use the same decision rules.
 */

/**
 * @param {unknown} value
 * @returns {"pm25" | "pm10" | "no2" | null}
 */
export function normalizeLatestMatrixPollutant(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const compact = normalized.toLowerCase().replace(/[\s_.-]/g, "");
  if (compact === "pm25") return "pm25";
  if (compact === "pm10") return "pm10";
  if (compact === "no2") return "no2";
  return null;
}

/**
 * @typedef {"eligible" | "unsupported_pollutant" | "missing_or_non_finite_value" | "negative_value" | "above_pm25_maximum" | "above_pm10_maximum"} LatestCurrentValueReason
 */

/**
 * @param {{ matrixPollutant: unknown, value: unknown }} input
 * @returns {{ eligible: boolean, matrixPollutant: "pm25" | "pm10" | "no2" | null, reason: LatestCurrentValueReason }}
 */
export function evaluateLatestCurrentValue(input) {
  const matrixPollutant = normalizeLatestMatrixPollutant(input?.matrixPollutant);
  if (!matrixPollutant) {
    return { eligible: false, matrixPollutant: null, reason: "unsupported_pollutant" };
  }

  // Do not coerce null to zero: zero is valid only when it is an actual number.
  if (typeof input?.value !== "number" || !Number.isFinite(input.value)) {
    return { eligible: false, matrixPollutant, reason: "missing_or_non_finite_value" };
  }
  if (input.value < 0) {
    return { eligible: false, matrixPollutant, reason: "negative_value" };
  }
  if (matrixPollutant === "pm25" && input.value > 500) {
    return { eligible: false, matrixPollutant, reason: "above_pm25_maximum" };
  }
  if (matrixPollutant === "pm10" && input.value > 600) {
    return { eligible: false, matrixPollutant, reason: "above_pm10_maximum" };
  }

  return { eligible: true, matrixPollutant, reason: "eligible" };
}
