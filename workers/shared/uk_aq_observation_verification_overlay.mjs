// @ts-nocheck -- shared deterministic verification-overlay model for Workers and Node tools.

export const OBSERVATION_VERIFICATION_FORMAT_VERSION = 1;
export const OBSERVATION_VERIFICATION_CONNECTOR_MANIFEST_KIND =
  "uk_aq_observation_verification_connector_manifest";
export const OBSERVATION_VERIFICATION_LATEST_KIND =
  "uk_aq_observation_verification_latest";
export const OBSERVATION_VERIFICATION_ROOT = "history/v3/verification";
export const OBSERVATION_VERIFICATION_LATEST_KEY =
  "history/_index_v3/verification/latest.json";
export const OBSERVATION_VERIFICATION_RATIFICATION_BOUNDARY_MODEL =
  "ratification-boundary-v1";
export const OBSERVATION_VERIFICATION_PER_OBSERVATION_MODEL =
  "per-observation-status-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const POLLUTANT = /^[a-z0-9_]+$/;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();

function bytewiseCompare(left, right) {
  const leftBytes = encoder.encode(String(left));
  const rightBytes = encoder.encode(String(right));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(bytewiseCompare)
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function encodeObservationVerificationJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nullablePositiveInteger(value, label) {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, label);
}

function canonicalStatus(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (value !== "P" && value !== "R") {
    throw new TypeError(`${label} must be P${nullable ? ", R or null" : " or R"}`);
  }
  return value;
}

function canonicalUtc(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const text = String(value || "").trim();
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return text;
}

function canonicalPollutant(value, label) {
  const text = String(value || "").trim();
  if (!POLLUTANT.test(text) || text !== text.toLowerCase()) {
    throw new TypeError(`${label} must be a canonical lower-case pollutant code`);
  }
  return text;
}

function canonicalKey(value, label) {
  const key = String(value || "").trim().replace(/^\/+/, "");
  if (!key || key.endsWith("/") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${label} is invalid`);
  }
  return key;
}

function canonicalSha256(value, label) {
  const sha256 = String(value || "").trim();
  if (!SHA256.test(sha256)) throw new TypeError(`${label} must be lower-case SHA-256`);
  return sha256;
}

function canonicalProvenance(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return canonicalize(value);
}

export function normalizeObservationVerificationPeriods(periods = []) {
  if (!Array.isArray(periods)) {
    throw new TypeError("verification periods must be an array");
  }
  const collapsed = [];
  let previousFrom = null;
  for (const [index, raw] of periods.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`verification periods[${index}] must be an object`);
    }
    const period = {
      from_observed_at_utc: canonicalUtc(
        raw.from_observed_at_utc,
        `verification periods[${index}].from_observed_at_utc`,
        { nullable: true },
      ),
      to_observed_at_utc: canonicalUtc(
        raw.to_observed_at_utc,
        `verification periods[${index}].to_observed_at_utc`,
        { nullable: true },
      ),
      status: canonicalStatus(raw.status, `verification periods[${index}].status`),
    };
    if (
      period.from_observed_at_utc !== null &&
      period.to_observed_at_utc !== null &&
      period.from_observed_at_utc >= period.to_observed_at_utc
    ) {
      throw new Error(`verification periods[${index}] is empty or reversed`);
    }
    if (index > 0 && period.from_observed_at_utc === null) {
      throw new Error("only the first verification period may have an open start");
    }
    if (index < periods.length - 1 && period.to_observed_at_utc === null) {
      throw new Error("only the last verification period may have an open end");
    }
    if (
      previousFrom !== null &&
      period.from_observed_at_utc !== null &&
      period.from_observed_at_utc < previousFrom
    ) {
      throw new Error("verification periods must be sorted deterministically");
    }
    const previous = collapsed.at(-1);
    if (previous) {
      if (previous.to_observed_at_utc === null) {
        throw new Error("an open-ended verification period must be last");
      }
      if (
        period.from_observed_at_utc === null ||
        period.from_observed_at_utc < previous.to_observed_at_utc
      ) {
        throw new Error("verification periods must not overlap");
      }
      if (
        period.from_observed_at_utc === previous.to_observed_at_utc &&
        period.status === previous.status
      ) {
        previous.to_observed_at_utc = period.to_observed_at_utc;
        previousFrom = period.from_observed_at_utc;
        continue;
      }
    }
    collapsed.push(period);
    previousFrom = period.from_observed_at_utc;
  }
  return collapsed.map((period) => Object.freeze({ ...period }));
}

export function verificationPeriodsFromRatifiedTo(ratifiedTo) {
  const sourceValue = ratifiedTo === null || ratifiedTo === undefined
    ? null
    : String(ratifiedTo).trim();
  if (sourceValue === null || sourceValue === "" || sourceValue.toLowerCase() === "never") {
    return Object.freeze({
      source_verification_model: OBSERVATION_VERIFICATION_RATIFICATION_BOUNDARY_MODEL,
      source_provenance: Object.freeze({ ratified_to: sourceValue || null }),
      default_status: "P",
      periods: Object.freeze([]),
    });
  }
  const parsed = new Date(`${sourceValue}T00:00:00.000Z`);
  if (
    !UTC_DAY.test(sourceValue) || Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== sourceValue
  ) {
    throw new TypeError("ratified_to must be YYYY-MM-DD, Never or a valid missing value");
  }
  const nextMidnight = new Date(parsed.getTime() + 86_400_000).toISOString();
  return Object.freeze({
    source_verification_model: OBSERVATION_VERIFICATION_RATIFICATION_BOUNDARY_MODEL,
    source_provenance: Object.freeze({ ratified_to: sourceValue }),
    default_status: "P",
    periods: Object.freeze(normalizeObservationVerificationPeriods([{
      from_observed_at_utc: null,
      to_observed_at_utc: nextMidnight,
      status: "R",
    }])),
  });
}

export function verificationPeriodsFromObservationEvidence(evidence = []) {
  if (!Array.isArray(evidence)) {
    throw new TypeError("source observation verification evidence must be an array");
  }
  const transitions = [];
  let previousTimestamp = null;
  for (const [index, raw] of evidence.entries()) {
    const observedAtUtc = canonicalUtc(
      raw?.observed_at_utc,
      `source evidence[${index}].observed_at_utc`,
    );
    const status = canonicalStatus(raw?.status, `source evidence[${index}].status`);
    if (previousTimestamp !== null && observedAtUtc < previousTimestamp) {
      throw new Error("source observation verification evidence must be ordered");
    }
    const previous = transitions.at(-1);
    if (previousTimestamp === observedAtUtc) {
      if (previous.status !== status) {
        throw new Error("source observation verification evidence contradicts at one timestamp");
      }
      continue;
    }
    if (!previous || previous.status !== status) {
      transitions.push({ observed_at_utc: observedAtUtc, status });
    }
    previousTimestamp = observedAtUtc;
  }
  const periods = transitions.map((transition, index) => ({
    from_observed_at_utc: transition.observed_at_utc,
    to_observed_at_utc: transitions[index + 1]?.observed_at_utc ?? null,
    status: transition.status,
  }));
  return Object.freeze({
    source_verification_model: OBSERVATION_VERIFICATION_PER_OBSERVATION_MODEL,
    default_status: "P",
    periods: Object.freeze(normalizeObservationVerificationPeriods(periods)),
  });
}

function normalizeTimeseriesEntry(raw, connectorId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("verification timeseries entry must be an object");
  }
  const entryConnectorId = positiveInteger(raw.connector_id, "timeseries.connector_id");
  if (entryConnectorId !== connectorId) {
    throw new Error("verification timeseries connector_id does not match manifest");
  }
  const sourceModel = String(raw.source_verification_model || "").trim();
  if (![OBSERVATION_VERIFICATION_RATIFICATION_BOUNDARY_MODEL,
    OBSERVATION_VERIFICATION_PER_OBSERVATION_MODEL].includes(sourceModel)) {
    throw new TypeError("timeseries.source_verification_model is unsupported");
  }
  return {
    connector_id: entryConnectorId,
    timeseries_id: positiveInteger(raw.timeseries_id, "timeseries.timeseries_id"),
    station_id: nullablePositiveInteger(raw.station_id, "timeseries.station_id"),
    pollutant_code: canonicalPollutant(raw.pollutant_code, "timeseries.pollutant_code"),
    source_verification_model: sourceModel,
    source_provenance: canonicalProvenance(
      raw.source_provenance,
      "timeseries.source_provenance",
    ),
    default_status: canonicalStatus(
      raw.default_status,
      "timeseries.default_status",
      { nullable: true },
    ),
    periods: normalizeObservationVerificationPeriods(raw.periods || []),
  };
}

export function buildObservationVerificationConnectorManifest({
  connectorId,
  sourceIdentity,
  timeseries,
}) {
  const connector = positiveInteger(connectorId, "connectorId");
  const normalizedTimeseries = (Array.isArray(timeseries) ? timeseries : [])
    .map((entry) => normalizeTimeseriesEntry(entry, connector))
    .sort((left, right) => left.timeseries_id - right.timeseries_id);
  for (let index = 1; index < normalizedTimeseries.length; index += 1) {
    if (normalizedTimeseries[index - 1].timeseries_id === normalizedTimeseries[index].timeseries_id) {
      throw new Error("verification connector manifest contains duplicate timeseries_id");
    }
  }
  return Object.freeze({
    schema_version: OBSERVATION_VERIFICATION_FORMAT_VERSION,
    kind: OBSERVATION_VERIFICATION_CONNECTOR_MANIFEST_KIND,
    verification_format_version: OBSERVATION_VERIFICATION_FORMAT_VERSION,
    history_generation: "v3",
    connector_id: connector,
    source_identity: canonicalProvenance(sourceIdentity, "sourceIdentity"),
    timeseries: Object.freeze(normalizedTimeseries.map((entry) => Object.freeze(entry))),
  });
}

export function validateObservationVerificationConnectorManifest(raw) {
  if (
    raw?.schema_version !== OBSERVATION_VERIFICATION_FORMAT_VERSION ||
    raw?.kind !== OBSERVATION_VERIFICATION_CONNECTOR_MANIFEST_KIND ||
    raw?.verification_format_version !== OBSERVATION_VERIFICATION_FORMAT_VERSION ||
    raw?.history_generation !== "v3"
  ) throw new Error("verification connector manifest identity is invalid");
  const normalized = buildObservationVerificationConnectorManifest({
    connectorId: raw.connector_id,
    sourceIdentity: raw.source_identity,
    timeseries: raw.timeseries,
  });
  if (encodeObservationVerificationJson(raw) !== encodeObservationVerificationJson(normalized)) {
    throw new Error("verification connector manifest is not canonical");
  }
  return normalized;
}

export function observationVerificationConnectorManifestKey(connectorId) {
  return `${OBSERVATION_VERIFICATION_ROOT}/connector_id=${positiveInteger(
    connectorId,
    "connectorId",
  )}/manifest.json`;
}

function normalizeManifestIdentity(raw) {
  const connectorId = positiveInteger(raw?.connector_id, "connector identity.connector_id");
  const identity = {
    connector_id: connectorId,
    key: canonicalKey(raw?.key, "connector identity.key"),
    byte_size: positiveInteger(raw?.byte_size, "connector identity.byte_size"),
    sha256: canonicalSha256(raw?.sha256, "connector identity.sha256"),
  };
  if (identity.key !== observationVerificationConnectorManifestKey(connectorId)) {
    throw new Error("verification connector identity key is not canonical");
  }
  return identity;
}

export function buildObservationVerificationLatest({ connectorManifests = [] } = {}) {
  const connectors = connectorManifests
    .map(normalizeManifestIdentity)
    .sort((left, right) => left.connector_id - right.connector_id);
  for (let index = 1; index < connectors.length; index += 1) {
    if (connectors[index - 1].connector_id === connectors[index].connector_id) {
      throw new Error("verification latest contains duplicate connector_id");
    }
  }
  return Object.freeze({
    schema_version: OBSERVATION_VERIFICATION_FORMAT_VERSION,
    kind: OBSERVATION_VERIFICATION_LATEST_KIND,
    verification_format_version: OBSERVATION_VERIFICATION_FORMAT_VERSION,
    history_generation: "v3",
    connectors: Object.freeze(connectors.map((entry) => Object.freeze(entry))),
  });
}

export function validateObservationVerificationLatest(raw) {
  if (
    raw?.schema_version !== OBSERVATION_VERIFICATION_FORMAT_VERSION ||
    raw?.kind !== OBSERVATION_VERIFICATION_LATEST_KIND ||
    raw?.verification_format_version !== OBSERVATION_VERIFICATION_FORMAT_VERSION ||
    raw?.history_generation !== "v3"
  ) throw new Error("verification latest identity is invalid");
  const normalized = buildObservationVerificationLatest({
    connectorManifests: raw.connectors,
  });
  if (encodeObservationVerificationJson(raw) !== encodeObservationVerificationJson(normalized)) {
    throw new Error("verification latest is not canonical");
  }
  return normalized;
}

export async function sha256ObservationVerificationBytes(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) :
    value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export async function buildObservationVerificationArtifact({ key, payload }) {
  const body = encoder.encode(encodeObservationVerificationJson(payload));
  return Object.freeze({
    key: canonicalKey(key, "verification artifact key"),
    body,
    byte_size: body.byteLength,
    sha256: await sha256ObservationVerificationBytes(body),
    content_type: "application/json; charset=utf-8",
  });
}

async function r2ObjectBytes(object) {
  if (typeof object?.arrayBuffer === "function") {
    return new Uint8Array(await object.arrayBuffer());
  }
  if (object?.body instanceof Uint8Array) return object.body;
  if (object?.body instanceof ArrayBuffer) return new Uint8Array(object.body);
  throw new Error("verification R2 object body is not readable");
}

function parseVerificationJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

export async function loadObservationVerificationAuthority({ bucket, connectorId }) {
  const connector = positiveInteger(connectorId, "connectorId");
  const latestObject = await bucket.get(OBSERVATION_VERIFICATION_LATEST_KEY);
  if (!latestObject) {
    return Object.freeze({
      latest_present: false,
      overlay_authoritative: false,
      connector_id: connector,
      manifest: null,
      manifest_identity: null,
      cache_identity: "legacy-embedded-status",
    });
  }
  const latestBytes = await r2ObjectBytes(latestObject);
  const latest = validateObservationVerificationLatest(
    parseVerificationJson(latestBytes, "verification latest"),
  );
  const latestIdentity = Object.freeze({
    key: OBSERVATION_VERIFICATION_LATEST_KEY,
    byte_size: latestBytes.byteLength,
    sha256: await sha256ObservationVerificationBytes(latestBytes),
  });
  const manifestIdentity = latest.connectors.find((entry) =>
    entry.connector_id === connector) || null;
  if (!manifestIdentity) {
    return Object.freeze({
      latest_present: true,
      overlay_authoritative: false,
      connector_id: connector,
      latest_identity: latestIdentity,
      manifest: null,
      manifest_identity: null,
      cache_identity: "legacy-embedded-status",
    });
  }
  const manifestObject = await bucket.get(manifestIdentity.key);
  if (!manifestObject) {
    throw new Error(`verification latest references a missing connector manifest: ${manifestIdentity.key}`);
  }
  const manifestBytes = await r2ObjectBytes(manifestObject);
  if (
    manifestBytes.byteLength !== manifestIdentity.byte_size ||
    await sha256ObservationVerificationBytes(manifestBytes) !== manifestIdentity.sha256
  ) {
    throw new Error(`verification connector manifest identity mismatch: ${manifestIdentity.key}`);
  }
  const manifest = validateObservationVerificationConnectorManifest(
    parseVerificationJson(manifestBytes, "verification connector manifest"),
  );
  if (manifest.connector_id !== connector) {
    throw new Error("verification connector manifest connector_id mismatch");
  }
  return Object.freeze({
    latest_present: true,
    overlay_authoritative: true,
    connector_id: connector,
    latest_identity: latestIdentity,
    manifest,
    manifest_identity: manifestIdentity,
    cache_identity: manifestIdentity.sha256,
  });
}

export function resolveEffectiveObservationVerificationStatus({
  authority,
  timeseriesId,
  observedAtUtc,
  legacyStatus = null,
}) {
  if (!authority?.overlay_authoritative) {
    return legacyStatus === "P" || legacyStatus === "R" ? legacyStatus : null;
  }
  const timeseries = positiveInteger(timeseriesId, "timeseriesId");
  const observedAt = canonicalUtc(observedAtUtc, "observedAtUtc");
  const entry = authority.manifest.timeseries.find((candidate) =>
    candidate.timeseries_id === timeseries);
  if (!entry) return null;
  for (const period of entry.periods) {
    const afterStart = period.from_observed_at_utc === null ||
      observedAt >= period.from_observed_at_utc;
    const beforeEnd = period.to_observed_at_utc === null ||
      observedAt < period.to_observed_at_utc;
    if (afterStart && beforeEnd) return period.status;
  }
  return entry.default_status;
}

export function applyObservationVerificationOverlay({
  rows,
  authority,
  timeseriesId,
  timestampField = "observed_at_utc",
}) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    verification_status: resolveEffectiveObservationVerificationStatus({
      authority,
      timeseriesId,
      observedAtUtc: row?.[timestampField],
      legacyStatus: row?.verification_status,
    }),
  }));
}
