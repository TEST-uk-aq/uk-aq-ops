// Finite, explicitly configured experiment. No deployment resources or network IDs.
export const COMPRESSED_CHART_SHA256 = /^[0-9a-f]{64}$/;
export const COMPRESSED_CHART_AQI_ALGORITHM = "aqilevels_hourly_v2";
export const COMPRESSED_CHART_SOURCE_MODE = "exploratory_canonical_source_as_read";
export const COMPRESSED_CHART_PARAMETERS = Object.freeze({ pm_window_hours: 24, pm_min_valid_hours: 18, endpoint_convention: "hour_ending" });
export const COMPRESSED_CHART_LIMITS = Object.freeze({ samples: 6, members: 4, days: 93, rows: 100_000, pairs: 5,
  gzip_bytes: 2 * 1024 ** 2, json_bytes: 16 * 1024 ** 2, metadata_bytes: 64 * 1024,
  evidence_bytes: 16 * 1024 ** 2, source_bytes: 128 * 1024 ** 2, duration_ms: 300_000 });
const HOUR = 3_600_000, DAY = 86_400_000;
export const objectRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function requirePilot(condition, message) { if (!condition) throw new Error(message); }
export function canonicalText(value) {
  const encode = entry => Array.isArray(entry) ? `[${entry.map(item => encode(item) ?? "null").join(",")}]`
    : objectRecord(entry) ? `{${Object.keys(entry).sort().filter(key => entry[key] !== undefined).map(key => `${JSON.stringify(key)}:${encode(entry[key])}`).join(",")}}`
      : Object.is(entry, -0) ? "-0" : JSON.stringify(entry);
  return `${encode(value)}\n`;
}

export function canonicalUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
const positive = value => Number.isSafeInteger(value) && value > 0;
const token = value => typeof value === "string" && value !== "constructor" && value !== "prototype" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function pilotIdentity(sample) {
  return { connector_id: sample.connector_id, station_id: sample.station_id,
    timeseries_id: sample.timeseries_id, pollutant_code: sample.pollutant_code };
}
export function sameIdentity(left, right) {
  return !!left && ["connector_id", "station_id", "timeseries_id", "pollutant_code"].every(key => left[key] === right[key]);
}
function exactKeys(value, keys) { return objectRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function validatePilotConfig(config, environment) {
  const fail = message => requirePilot(false, `Experiment configuration: ${message}`);
  if (!exactKeys(config, ["schema_version", "enabled", "experiment_id", "environment", "canonical_generation", "network", "source_mode",
    "verification_mode", "legacy_status_mode", "status_authority_reference", "observation_units", "algorithm_version",
    "source_bucket", "source_endpoint", "derived_bucket", "derived_endpoint", "derived_prefix", "samples"])) fail("required fields or unknown fields");
  if (config.schema_version !== 1 || config.enabled !== true || !token(config.experiment_id)) fail("missing explicit enablement/identity");
  if (typeof environment !== "string" || !/^[A-Z][A-Z0-9_]{0,31}$/.test(environment) || config.environment !== environment) fail("source environment mismatch");
  if (config.canonical_generation !== "v3" || config.source_mode !== COMPRESSED_CHART_SOURCE_MODE) fail("explicit exploratory v3 source required");
  if (!label(config.network) || !label(config.status_authority_reference)
    || !["pre_overlay_accepted", "overlay_accepted"].includes(config.verification_mode)
    || !["sos_compatibility", "persisted_verification_only"].includes(config.legacy_status_mode)
    || config.observation_units !== "ug/m3" || config.algorithm_version !== COMPRESSED_CHART_AQI_ALGORITHM) fail("source/status/units/algorithm declaration");
  const bucket = value => typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);
  const endpoint = value => {
    try { const url = new URL(value); return url.origin === value && url.protocol === "https:"
      && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) && !url.port && !url.username && !url.password; }
    catch { return false; }
  };
  if (!endpoint(config.source_endpoint) || !endpoint(config.derived_endpoint)) fail("explicit source/derived S3 origins");
  if (!bucket(config.source_bucket) || !bucket(config.derived_bucket) || config.source_bucket === config.derived_bucket) fail("separate explicit source/derived buckets");
  if (typeof config.derived_prefix !== "string" || !/^experimental\/[a-z0-9_/-]+$/.test(config.derived_prefix)
    || config.derived_prefix.length > 180 || config.derived_prefix.split("/").some(part => !part || part === "." || part === "..")) fail("isolated experimental prefix");
  if (!Array.isArray(config.samples) || config.samples.length < 1 || config.samples.length > COMPRESSED_CHART_LIMITS.samples) fail("finite sample selection");
  const ids = new Set(), identities = new Set();
  for (const sample of config.samples) {
    if (!exactKeys(sample, ["id", "station_label", "connector_id", "station_id", "timeseries_id", "pollutant_code", "permitted_timeseries_ids", "start_utc", "end_utc", "views"])) fail("sample fields");
    if (!token(sample.id) || ids.has(sample.id) || !label(sample.station_label)
      || !positive(sample.connector_id) || !positive(sample.station_id) || !positive(sample.timeseries_id)
      || !["pm25", "pm10", "no2"].includes(sample.pollutant_code)) fail("sample identity");
    ids.add(sample.id);
    const identity = `${sample.connector_id}:${sample.station_id}:${sample.pollutant_code}`;
    if (identities.has(identity)) fail("duplicate physical selection");
    identities.add(identity);
    if (!Array.isArray(sample.permitted_timeseries_ids) || !sample.permitted_timeseries_ids.includes(sample.timeseries_id)
      || sample.permitted_timeseries_ids.length < 1 || sample.permitted_timeseries_ids.length > COMPRESSED_CHART_LIMITS.members
      || sample.permitted_timeseries_ids.some(id => !positive(id))
      || new Set(sample.permitted_timeseries_ids).size !== sample.permitted_timeseries_ids.length) fail("finite continuity member allowlist");
    if (!canonicalUtc(sample.start_utc) || !canonicalUtc(sample.end_utc)
      || Date.parse(sample.start_utc) % HOUR || Date.parse(sample.end_utc) % HOUR
      || sample.start_utc >= sample.end_utc || Math.floor(Date.parse(sample.end_utc) / DAY) - Math.floor(Date.parse(sample.start_utc) / DAY) + 1 > COMPRESSED_CHART_LIMITS.days) fail("bounded hour-aligned sample interval");
    if (!Array.isArray(sample.views) || sample.views.length < 1 || sample.views.length > 8) fail("finite view selection");
    const viewIds = new Set();
    for (const view of sample.views) {
      if (!exactKeys(view, ["id", "label", "start_utc", "end_utc"]) || !token(view.id) || viewIds.has(view.id) || !label(view.label)
        || !canonicalUtc(view.start_utc) || !canonicalUtc(view.end_utc)
        || Date.parse(view.start_utc) % HOUR || Date.parse(view.end_utc) % HOUR
        || view.start_utc < sample.start_utc || view.end_utc > sample.end_utc || view.start_utc >= view.end_utc) fail("view interval/identity");
      viewIds.add(view.id);
    }
  }
  if (new Set(config.samples.map(sample => sample.connector_id)).size !== 1) fail("one configured evaluation network only");
  return config;
}
export function sampleInterval(sample) {
  return { start_utc: sample.start_utc, end_exclusive_utc: new Date(Date.parse(sample.end_utc) + 1).toISOString() };
}
export function pilotMonths(sample) {
  const interval = sampleInterval(sample), months = [];
  let cursor = new Date(sample.start_utc.slice(0, 7) + "-01T00:00:00.000Z");
  while (cursor.toISOString() < interval.end_exclusive_utc) {
    const start = cursor.toISOString();
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const end = cursor.toISOString();
    months.push({ month_utc: start.slice(0, 7), start_utc: start > interval.start_utc ? start : interval.start_utc,
      end_exclusive_utc: end < interval.end_exclusive_utc ? end : interval.end_exclusive_utc });
  }
  return months;
}
export function selectorKey(config) { return `${config.derived_prefix}/${config.experiment_id}/latest.json`; }
export function manifestKey(config, digest) { return `${config.derived_prefix}/${config.experiment_id}/manifests/${digest}.json`; }
export function artifactKey(config, sample, month, part, digest) {
  requirePilot(["observations", "aqi"].includes(part) && /^\d{4}-\d{2}$/.test(month) && COMPRESSED_CHART_SHA256.test(digest), "Invalid artifact identity");
  return `${config.derived_prefix}/${config.experiment_id}/objects/connector_id=${sample.connector_id}/timeseries_id=${sample.timeseries_id}/pollutant=${sample.pollutant_code}/month_utc=${month}/${part}.${digest}.json.gz`;
}
export function evidenceKey(config, digest) { return `${config.derived_prefix}/${config.experiment_id}/evidence/${digest}.json`; }
export function validAlgorithm(algorithm) {
  return algorithm?.version === COMPRESSED_CHART_AQI_ALGORITHM
    && canonicalText(algorithm.parameters) === canonicalText(COMPRESSED_CHART_PARAMETERS)
    && COMPRESSED_CHART_SHA256.test(algorithm.implementation_sha256 || "")
    && COMPRESSED_CHART_SHA256.test(algorithm.orchestration_sha256 || "");
}
export function validateCompressedChartSelector(selector, config, configSha) {
  return selector?.schema_version === 2 && selector.kind === "uk_aq_compressed_chart_selector"
    && selector.publication_state === "published_complete" && selector.environment === config.environment
    && selector.config_sha256 === configSha && objectRecord(selector.samples)
    && Object.keys(selector.samples).length <= config.samples.length
    && Object.entries(selector.samples).every(([id, entry]) => config.samples.some(sample => sample.id === id)
      && COMPRESSED_CHART_SHA256.test(entry?.manifest_sha256 || "")
      && entry.manifest_key === manifestKey(config, entry.manifest_sha256));
}
export function validateCompressedChartPublication(publication, sampleId, config, configSha) {
  const sample = config.samples.find(entry => entry.id === sampleId);
  if (!sample || publication?.schema_version !== 3 || publication.kind !== "uk_aq_compressed_chart_publication"
    || publication.publication_state !== "published_complete" || publication.sample_id !== sampleId
    || publication.environment !== config.environment || publication.config_sha256 !== configSha
    || publication.source_mode !== COMPRESSED_CHART_SOURCE_MODE || publication.managed_publication_eligible !== false
    || publication.source_generation !== config.canonical_generation || !uuid(publication.publication_id)
    || !sameIdentity(publication.identity, pilotIdentity(sample))
    || canonicalText(publication.requested_interval) !== canonicalText(sampleInterval(sample))
    || !objectRecord(publication.continuity) || typeof publication.continuity.enabled !== "boolean"
    || !Array.isArray(publication.continuity.members) || publication.continuity.members.length < 1 || publication.continuity.members.length > 32
    || !validAlgorithm(publication.algorithm) || !objectRecord(publication.evidence)
    || !COMPRESSED_CHART_SHA256.test(publication.evidence.sha256 || "")
    || publication.evidence.key !== evidenceKey(config, publication.evidence.sha256)
    || !positive(publication.evidence.byte_size) || publication.evidence.byte_size > COMPRESSED_CHART_LIMITS.evidence_bytes
    || !Array.isArray(publication.pairs)) return false;
  const months = pilotMonths(sample);
  if (publication.pairs.length !== months.length || months.length > COMPRESSED_CHART_LIMITS.pairs) return false;
  let totalRows = 0;
  return publication.pairs.every((pair, index) => {
    const month = months[index];
    if (pair.month_utc !== month.month_utc || pair.start_utc !== month.start_utc || pair.end_exclusive_utc !== month.end_exclusive_utc
      || pair.publication_id !== publication.publication_id || pair.source_evidence_sha256 !== publication.evidence.sha256
      || pair.source_complete !== true || pair.context_complete !== true) return false;
    for (const part of ["observations", "aqi"]) {
      const descriptor = pair[part];
      if (!descriptor || !COMPRESSED_CHART_SHA256.test(descriptor.sha256 || "") || !COMPRESSED_CHART_SHA256.test(descriptor.json_sha256 || "")
        || descriptor.key !== artifactKey(config, sample, month.month_utc, part, descriptor.sha256)
        || !positive(descriptor.byte_size) || descriptor.byte_size > COMPRESSED_CHART_LIMITS.gzip_bytes
        || !positive(descriptor.json_byte_size) || descriptor.json_byte_size > COMPRESSED_CHART_LIMITS.json_bytes
        || !Number.isSafeInteger(descriptor.row_count) || descriptor.row_count < 0) return false;
    }
    totalRows += pair.observations.row_count;
    const endpointCount = Math.floor((Date.parse(month.end_exclusive_utc) - 1) / HOUR) - Math.ceil(Date.parse(month.start_utc) / HOUR) + 1;
    return pair.aqi.row_count === endpointCount && pair.aqi.response_complete === true && totalRows <= COMPRESSED_CHART_LIMITS.rows;
  });
}
export function publicPilotCatalog(config, configSha, publications = {}) {
  return { schema_version: 2, kind: "uk_aq_compressed_chart_catalog", environment: config.environment,
    experiment_id: config.experiment_id, config_sha256: configSha, source_generation: config.canonical_generation,
    source_mode: config.source_mode, algorithm_version: config.algorithm_version, observation_units: config.observation_units,
    samples: config.samples.map(sample => ({ id: sample.id, station_label: sample.station_label, identity: pilotIdentity(sample),
      start_utc: sample.start_utc, end_utc: sample.end_utc, views: sample.views,
      publication_sha256: publications[sample.id]?.manifest_sha256 || null })) };
}
