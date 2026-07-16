/**
 * Pure latest-state transition and serialization helpers.
 *
 * Kept dependency-free for use by both Deno runtime code and later Node tools.
 */

/** @param {number} connectorId @param {number} timeseriesId */
export function latestStateKey(connectorId, timeseriesId) {
  return `${connectorId}:${timeseriesId}`;
}

/**
 * @param {{ observed_at: string, ingested_at: string | null }} a
 * @param {{ observed_at: string, ingested_at: string | null }} b
 */
export function compareLatestStateRows(a, b) {
  const observedAtDifference = Date.parse(a.observed_at) - Date.parse(b.observed_at);
  if (observedAtDifference !== 0) return observedAtDifference;
  const aIngestedAt = a.ingested_at ? Date.parse(a.ingested_at) : 0;
  const bIngestedAt = b.ingested_at ? Date.parse(b.ingested_at) : 0;
  return aIngestedAt - bIngestedAt;
}

/**
 * Applies only rows that were already resolved and accepted by the current-value
 * policy. The observed_at then ingested_at ordering is intentionally unchanged.
 *
 * @param {Map<string, any>} stateMap
 * @param {Array<{ connector_id: number, timeseries_id: number, observed_at: string, value: number, value_float8_hex: string | null, status: string | null }>} rows
 * @param {string} ingestedAt
 */
export function applyEligibleRowsToLatestState(stateMap, rows, ingestedAt) {
  const summary = {
    applied_new: 0,
    applied_newer: 0,
    skipped_older: 0,
    skipped_duplicate: 0,
  };

  for (const row of rows) {
    const key = latestStateKey(row.connector_id, row.timeseries_id);
    const next = { ...row, ingested_at: ingestedAt };
    const current = stateMap.get(key);
    if (!current) {
      stateMap.set(key, next);
      summary.applied_new += 1;
      continue;
    }
    const comparison = compareLatestStateRows(current, next);
    if (comparison < 0) {
      stateMap.set(key, next);
      summary.applied_newer += 1;
    } else if (comparison === 0) {
      summary.skipped_duplicate += 1;
    } else {
      summary.skipped_older += 1;
    }
  }

  return summary;
}

/** @param {unknown} value */
function stableSort(value) {
  if (Array.isArray(value)) return value.map((item) => stableSort(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      output[key] = stableSort(value[key]);
    }
    return output;
  }
  return value;
}

/**
 * @param {Map<string, any>} stateMap
 * @param {string} updatedAt
 */
export function serializeLatestState(stateMap, updatedAt) {
  const entries = [...stateMap.values()].sort((a, b) => {
    if (a.connector_id !== b.connector_id) return a.connector_id - b.connector_id;
    return a.timeseries_id - b.timeseries_id;
  });
  return `${JSON.stringify(stableSort({ schema_version: 1, updated_at: updatedAt, entries }))}\n`;
}
