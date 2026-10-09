/** Independent Node validation for accepted graph/RData timestamp authority. */
import { createHash } from "node:crypto";
import fs from "node:fs";

const SHA256 = /^[a-f0-9]{64}$/u;
const POLLUTANTS = new Set(["pm25", "pm10", "no2", "o3"]);
const BASE_URLS = Object.freeze({
  waqn: "https://airquality.gov.wales/sites/default/files/openair/R_data/",
  saqn: "https://www.scottishairquality.scot/openair/R_data/",
});
const COMPARISON_FIELDS = [
  "source_adapter", "site_code", "pollutant_code", "graph", "rdata",
  "canonical", "europe_london_offset", "hour_convention",
];
const GRAPH_FIELDS = [
  "original_timestamp", "interpreted_europe_london", "observed_at_utc", "value", "unit",
];
const RDATA_FIELDS = [
  "source_url", "source_file_sha256", "object_name", "original_timestamp",
  "source_timezone", "observed_at_utc", "value", "unit",
];
const CANONICAL_FIELDS = ["observed_at_utc", "value", "unit"];
const TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const GMT_TIMESTAMP_WITHOUT_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/u;

function hasExactFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

export const OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT =
  "uk_aq_official_rdata_timestamp_authority_v2";
export const OFFICIAL_RDATA_TIMESTAMP_MAPPING =
  "rdata_posixct_gmt_instant_to_observed_at_utc";
export const OFFICIAL_RDATA_HOUR_CONVENTION =
  "rdata_gmt_instant_equals_graph_canonical_utc";

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => Buffer.compare(
      Buffer.from(left, "utf8"), Buffer.from(right, "utf8"),
    )).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function instant(value, { sourceGmt = false } = {}) {
  if (typeof value !== "string" || !value) {
    throw new Error("Official RData comparison timestamp is invalid or not hourly");
  }
  // Only an authenticated RData GMT source timestamp may omit its UTC offset.
  const text = sourceGmt && GMT_TIMESTAMP_WITHOUT_OFFSET.test(value)
    ? value + "Z" : value;
  if (!TIMESTAMP_WITH_OFFSET.test(text)) {
    throw new Error("Official RData comparison timestamp lacks an explicit timezone");
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(14) !== "00:00.000Z") {
    throw new Error("Official RData comparison timestamp is invalid or not hourly");
  }
  return parsed;
}

function londonOffset(utcMillis) {
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(utcMillis)).find((part) => part.type === "timeZoneName")?.value;
  if (name === "GMT") return "+00:00";
  const match = String(name || "").match(/^GMT([+-]\d{2}:\d{2})$/u);
  if (!match) throw new Error("Europe/London offset cannot be authenticated");
  return match[1];
}

export function requireOfficialRdataTimestampAuthority(runState) {
  const authority = runState?.official_rdata_timestamp_authority;
  const artifactPath = String(
    runState?.official_rdata_timestamp_authority_artifact_path || "",
  );
  let body;
  let artifact;
  try {
    body = fs.readFileSync(artifactPath);
    artifact = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Official RData timestamp authority artifact is unavailable or invalid");
  }
  const sourceAdapter = String(runState?.official_rdata_source_adapter || "");
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
      || authority.contract_version !== OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT
      || authority.status !== "accepted"
      || authority.source_adapter !== sourceAdapter
      || !Object.hasOwn(BASE_URLS, sourceAdapter)
      || authority.timestamp_mapping !== OFFICIAL_RDATA_TIMESTAMP_MAPPING
      || authority.unit_authority !== "accepted_matching_measurement_and_unit"
      || !Array.isArray(authority.comparisons)
      || canonical(artifact) !== canonical({
        contract_version: OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT,
        status: "accepted",
        source_adapter: sourceAdapter,
        timestamp_mapping: OFFICIAL_RDATA_TIMESTAMP_MAPPING,
        unit_authority: "accepted_matching_measurement_and_unit",
        comparisons: authority.comparisons,
      })
      || authority.artifact_sha256 !== sha256(body)) {
    throw new Error("Official RData timestamp and unit authority is not accepted");
  }
  const seasons = new Set();
  for (const comparison of authority.comparisons) {
    const graph = comparison?.graph;
    const rdata = comparison?.rdata;
    const target = comparison?.canonical;
    if (!hasExactFields(comparison, COMPARISON_FIELDS)
        || !hasExactFields(graph, GRAPH_FIELDS)
        || !hasExactFields(rdata, RDATA_FIELDS)
        || !hasExactFields(target, CANONICAL_FIELDS)
        || typeof graph.original_timestamp !== "string"
        || !graph.original_timestamp) {
      throw new Error("Official RData timestamp comparison shape is invalid");
    }
    const sourceUtc = instant(rdata.observed_at_utc);
    const canonicalUtc = instant(target.observed_at_utc);
    const siteCode = String(comparison?.site_code || "");
    const year = new Date(sourceUtc).getUTCFullYear();
    const sourceFile = `${siteCode}_${year}.RData`;
    const offset = londonOffset(canonicalUtc);
    if (comparison.source_adapter !== sourceAdapter
        || !/^[A-Za-z0-9]+$/u.test(siteCode)
        || !POLLUTANTS.has(String(comparison.pollutant_code || ""))
        || comparison.hour_convention !== OFFICIAL_RDATA_HOUR_CONVENTION
        || rdata.source_url !== BASE_URLS[sourceAdapter] + sourceFile
        || rdata.object_name !== sourceFile.replace(/\.RData$/u, "")
        || !SHA256.test(String(rdata.source_file_sha256 || ""))
        || rdata.source_timezone !== "GMT"
        || instant(rdata.original_timestamp, { sourceGmt: true }) !== sourceUtc
        || instant(graph.observed_at_utc) !== canonicalUtc
        || instant(graph.interpreted_europe_london) !== canonicalUtc
        || sourceUtc !== canonicalUtc
        || comparison.europe_london_offset !== offset
        || !String(graph.interpreted_europe_london || "").endsWith(offset)
        || typeof graph.value !== "string" || typeof rdata.value !== "string"
        || typeof target.value !== "string"
        || !Number.isFinite(Number(graph.value))
        || Number(graph.value) !== Number(rdata.value)
        || Number(graph.value) !== Number(target.value)
        || !String(graph.unit || "")
        || graph.unit !== rdata.unit || graph.unit !== target.unit) {
      throw new Error("Official RData timestamp comparison is incomplete");
    }
    seasons.add(offset === "+01:00" ? "bst" : "gmt");
  }
  if (canonical([...seasons].sort()) !== canonical(["bst", "gmt"])) {
    throw new Error("Official RData network lacks accepted GMT and BST comparisons");
  }
  const projection = {
    contract_version: OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT,
    status: "accepted",
    source_adapter: sourceAdapter,
    timestamp_mapping: OFFICIAL_RDATA_TIMESTAMP_MAPPING,
    unit_authority: "accepted_matching_measurement_and_unit",
    comparisons: authority.comparisons,
    artifact_sha256: authority.artifact_sha256,
  };
  if (canonical(authority) !== canonical(projection)) {
    throw new Error("Official RData timestamp authority projection changed");
  }
  return projection;
}
