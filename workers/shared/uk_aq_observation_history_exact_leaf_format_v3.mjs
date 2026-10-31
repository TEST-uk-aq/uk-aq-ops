// Compatibility only. These validators do not establish offline canonical/layout
// proof or authorise schema-2 publication. Schema-1 production is unchanged.
import { encodeObservationHistoryIndexV3Json } from "./uk_aq_observation_history_index_v3_json.mjs";

export const EXACT_LEAF_FORMATS_V3 = Object.freeze([
  Object.freeze({ schema_version: 1, exact_leaf_index_version: "exact-timeseries-leaf-v1",
    manifest_kind: "observation_timeseries_physical_leaf_scoped_manifest",
    leaf_kind: "observation_timeseries_physical_leaf" }),
  Object.freeze({ schema_version: 2, exact_leaf_index_version: "exact-timeseries-leaf-v2",
    manifest_kind: "observation_timeseries_physical_leaf_scoped_manifest_v2",
    leaf_kind: "observation_timeseries_physical_leaf_v2" }),
]);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMON = ["schema_version", "kind", "index_generation", "history_version", "domain",
  "history_schema_version", "writer_version", "physical_layout_version", "aligned_row_cap",
  "exact_leaf_index_version", "day_utc", "connector_id", "pollutant_code", "key"];

export function exactLeafFormatV3(payload, record = "manifest") {
  const format = EXACT_LEAF_FORMATS_V3.find((candidate) =>
    payload?.schema_version === candidate.schema_version &&
    payload?.exact_leaf_index_version === candidate.exact_leaf_index_version &&
    payload?.kind === candidate[record === "manifest" ? "manifest_kind" : "leaf_kind"]);
  if (!format) throw new Error("unsupported or contradictory exact-index format");
  return format;
}

export function assertExactRecordFieldsV2(payload, record) {
  const fields = [...COMMON, ...(record === "manifest"
    ? ["decode_profile", "coverage", "leaf_descriptor_fields", "leaves_by_timeseries_id", "canonical_source_manifest"]
    : ["timeseries_id", "row_count", "min_observed_at_utc", "max_observed_at_utc", "files", "segments"])];
  assertExactFieldsV3(payload, fields, `schema-2 ${record}`);
  for (const field of ["schema_version", "history_schema_version", "aligned_row_cap", "connector_id"]) {
    positive(payload[field], field);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.day_utc) || !/^[a-z0-9_]+$/.test(payload.pollutant_code)) {
    throw new Error("invalid exact-only scope");
  }
  if (record === "manifest") {
    assertExactFieldsV3(payload.coverage, ["row_count", "timeseries_count", "physical_file_count",
      "physical_leaf_count", "min_observed_at_utc", "max_observed_at_utc"], "exact coverage");
    for (const field of ["row_count", "timeseries_count", "physical_file_count", "physical_leaf_count"]) positive(payload.coverage[field], field);
    timestamp(payload.coverage.min_observed_at_utc); timestamp(payload.coverage.max_observed_at_utc);
    return;
  }
  positive(payload.timeseries_id, "timeseries_id"); positive(payload.row_count, "row_count");
  timestamp(payload.min_observed_at_utc); timestamp(payload.max_observed_at_utc);
  if (!Array.isArray(payload.files) || !payload.files.length || !Array.isArray(payload.segments) || !payload.segments.length) {
    throw new Error("exact-only leaf requires files and segments");
  }
  let previousKey = null;
  for (const file of payload.files) {
    assertExactFieldsV3(file, ["key", "byte_size", "sha256", "row_count", "row_group_count",
      ...(Object.hasOwn(file, "etag") ? ["etag"] : [])], "exact file");
    for (const field of ["byte_size", "row_count", "row_group_count"]) positive(file[field], `file.${field}`);
    if (!SHA256.test(file.sha256) || typeof file.key !== "string" || (previousKey !== null && file.key <= previousKey) ||
        (Object.hasOwn(file, "etag") && (typeof file.etag !== "string" || !file.etag))) throw new Error("invalid or unsorted exact files");
    previousKey = file.key;
  }
  for (const segment of payload.segments) {
    assertExactFieldsV3(segment, ["timeseries_id", "file_key", "row_group_ordinal", "row_start", "row_group_row_start",
      "row_count", "min_observed_at_utc", "max_observed_at_utc", "column_ranges"], "exact segment");
    positive(segment.timeseries_id, "segment.timeseries_id"); positive(segment.row_count, "segment.row_count");
    for (const field of ["row_group_ordinal", "row_start", "row_group_row_start"]) positive(segment[field], field, true);
    timestamp(segment.min_observed_at_utc); timestamp(segment.max_observed_at_utc);
    assertExactFieldsV3(segment.column_ranges, ["observed_at_utc", "value"], "exact columns");
    for (const range of Object.values(segment.column_ranges)) {
      assertExactFieldsV3(range, ["start", "end", "data_page_offset", "dictionary_page_offset", "num_values"], "exact range");
      for (const field of ["start", "data_page_offset"]) positive(range[field], field, true);
      for (const field of ["end", "num_values"]) positive(range[field], field);
      if (range.dictionary_page_offset !== null) positive(range.dictionary_page_offset, "dictionary offset", true);
    }
  }
}

function positive(value, label, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`invalid exact-only ${label}`);
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("invalid exact-only UTC bound");
  }
}

export function assertExactFieldsV3(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

export function exactLeafKeyV3(root, scope, timeseriesId, format, revision = null) {
  const id = String(timeseriesId).padStart(9, "0");
  if (format.schema_version === 1) return `${root}/${scope}/timeseries_id=${id}.json`;
  if (format.schema_version !== 2 || id.length !== 9 || !Number.isSafeInteger(timeseriesId) || timeseriesId <= 0 ||
      !SHA256.test(revision || "")) throw new Error("invalid exact leaf revision");
  return `${root}/${scope}/_exact_v2/timeseries_id=${id}/revision=${revision}.json`;
}

export function assertExactLeafKeyV3(key, root, scope, timeseriesId, format) {
  const revision = format.schema_version === 2 ? /\/revision=([0-9a-f]{64})\.json$/.exec(key)?.[1] : null;
  if (key !== exactLeafKeyV3(root, scope, timeseriesId, format, revision)) {
    throw new Error("exact leaf key is outside its selected format/scope");
  }
  return revision;
}

export function exactLeafRevisionBytesV3(payload) {
  const { key: omittedKey, ...semanticPayload } = payload;
  return new TextEncoder().encode(encodeObservationHistoryIndexV3Json(semanticPayload));
}

export function validateExactCanonicalSourceV2(source, parent, canonicalRoot, scope) {
  assertExactFieldsV3(source, ["key", "byte_size", "sha256", "manifest_hash", "row_count",
    "observation_content_hash", "observation_content_hash_version"], "canonical source descriptor");
  if (source.key !== `${canonicalRoot}/${scope}/manifest.json` ||
      !Number.isSafeInteger(source.byte_size) || source.byte_size <= 0 ||
      ![source.sha256, source.manifest_hash, source.observation_content_hash].every((hash) => SHA256.test(hash)) ||
      !Number.isSafeInteger(source.row_count) || source.row_count <= 0 ||
      source.row_count !== parent.coverage.row_count ||
      ![1, 2].includes(source.observation_content_hash_version)) {
    throw new Error("schema-2 canonical source descriptor is contradictory");
  }
  return source;
}
