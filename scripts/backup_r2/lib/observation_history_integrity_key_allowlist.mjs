/** Fail-closed object-key classification for active observation History Integrity. */

const OBSERVATION_DATA =
  /^history\/v(2|3)\/observations\/(.+)$/;
const V2_SCOPED_INDEX =
  /^history\/_index_v2\/observations_timeseries\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/;
const V3_EXACT_SCOPED_INDEX =
  /^history\/_index_v3\/observations_timeseries\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/(manifest\.json|timeseries_id=(\d+)\.json)$/;
const V3_ALIGNED_SCOPED_INDEX =
  /^history\/_index_v3\/observations_timeseries\/_aligned\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/(manifest\.json|range=(\d+)-(\d+)\.json)$/;

const LATEST_INDEX_KEYS = Object.freeze({
  v2: "history/_index_v2/observations_timeseries_latest.json",
  v3: "history/_index_v3/observations_timeseries_latest.json",
});

function validDay(day) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day)
    && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === day;
}

function validCanonicalIntegerToken(token, { width = 0, allowZero = false } = {}) {
  const value = Number(token);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) return false;
  return String(value).padStart(width, "0") === token;
}

function hasCanonicalPathParts(key) {
  return !key.split("/").some((part) =>
    !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part)
  );
}

function scopedIndexResult(generation, layout, match, objectKind) {
  const [, dayUtc, connectorId, pollutantCode] = match;
  if (!validDay(dayUtc) || !validCanonicalIntegerToken(connectorId)) return null;
  return Object.freeze({
    domain: "observations",
    generation,
    family: "observations_timeseries",
    kind: objectKind,
    layout,
    day_utc: dayUtc,
    connector_id: Number(connectorId),
    pollutant_code: pollutantCode,
  });
}

export function classifyObservationHistoryIntegrityKey(rawKey) {
  const key = String(rawKey || "");
  if (!hasCanonicalPathParts(key)) return null;
  const data = key.match(OBSERVATION_DATA);
  if (data) {
    return Object.freeze({
      domain: "observations",
      generation: `v${data[1]}`,
      family: "observation_data",
      kind: "observation_data",
      layout: null,
    });
  }

  for (const generation of ["v2", "v3"]) {
    if (key === LATEST_INDEX_KEYS[generation]) {
      return Object.freeze({
        domain: "observations",
        generation,
        family: "observations_timeseries",
        kind: "observation_latest_index",
        layout: generation === "v3" ? "timeseries-aligned-v2" : "pollutant-manifest-v2",
      });
    }
  }

  const v2 = key.match(V2_SCOPED_INDEX);
  if (v2) return scopedIndexResult("v2", "pollutant-manifest-v2", v2, "observation_scoped_index");

  const v3Exact = key.match(V3_EXACT_SCOPED_INDEX);
  if (v3Exact) {
    const result = scopedIndexResult(
      "v3",
      "timeseries-aligned-v2",
      v3Exact,
      v3Exact[4] === "manifest.json" ? "observation_scoped_index" : "observation_exact_leaf_index",
    );
    if (!result) return null;
    if (v3Exact[5] !== undefined
        && !validCanonicalIntegerToken(v3Exact[5], { width: 9 })) return null;
    return result;
  }

  const v3Aligned = key.match(V3_ALIGNED_SCOPED_INDEX);
  if (v3Aligned) {
    const result = scopedIndexResult(
      "v3",
      "timeseries-aligned-v2",
      v3Aligned,
      v3Aligned[4] === "manifest.json" ? "observation_aligned_scoped_index" : "observation_aligned_shard_index",
    );
    if (!result) return null;
    if (v3Aligned[5] !== undefined) {
      const start = Number(v3Aligned[5]);
      const end = Number(v3Aligned[6]);
      if (!validCanonicalIntegerToken(v3Aligned[5], { width: 6, allowZero: true })
          || !validCanonicalIntegerToken(v3Aligned[6], { width: 6, allowZero: true })
          || start % 1000 !== 0 || end !== start + 999) return null;
    }
    return result;
  }
  return null;
}

export function requireObservationHistoryIntegrityKey(rawKey, { generation = null } = {}) {
  const classification = classifyObservationHistoryIntegrityKey(rawKey);
  if (!classification || (generation && classification.generation !== generation)) {
    throw new Error(
      `Non-observation history is outside the Integrity proposal contract: ${String(rawKey || "")}`,
    );
  }
  return classification;
}

export function isObservationHistoryIntegrityIndexKey(rawKey, { generation = null } = {}) {
  const classification = classifyObservationHistoryIntegrityKey(rawKey);
  return Boolean(classification
    && classification.family === "observations_timeseries"
    && (!generation || classification.generation === generation));
}

export function isVersionedHistoryIndexNamespaceKey(rawKey) {
  return /^history\/_index_v(?:2|3)\//.test(String(rawKey || ""));
}

export function isVersionedHistoryIntegrityNamespaceKey(rawKey) {
  return /^(?:history\/v(?:2|3)\/|history\/_index_v(?:2|3)\/)/.test(
    String(rawKey || ""),
  );
}
