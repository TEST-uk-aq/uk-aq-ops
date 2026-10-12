/** Independent native-R replay of v10 site-year column and metadata authority. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  canonicalOfficialRdataJson as canonical,
  officialRdataAvailabilitySemanticIdentity,
  officialRdataSha256,
  officialRdataV10ColumnClassifications,
} from "./official_rdata_semantic_projection.mjs";

const equal = (left, right) => canonical(left) === canonical(right);
const bytewise = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const columns = { pm25: "PM2.5", pm10: "PM10", no2: "NO2", o3: "O3" };
const provider = {
  waqn: { base: "https://airquality.gov.wales/sites/default/files/openair/R_data/",
    metadata: "WAQ_metadata.RData", hosts: new Set(["airquality.gov.wales", "www.airquality.gov.wales"]) },
  saqn: { base: "https://www.scottishairquality.scot/openair/R_data/",
    metadata: "SCOT_metadata.RData", hosts: new Set(["scottishairquality.scot", "www.scottishairquality.scot"]) },
};
const SOURCE_YEAR = /^(waqn|saqn):site_ref=([^:]+):year=(\d{4})$/;
const INSPECT = String.raw`
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 5L) stop("v10 inspection argument count changed")
workspace <- new.env(parent=emptyenv())
loaded <- load(args[[2L]], envir=workspace)
if (!(args[[3L]] %in% loaded)) stop("v10 expected RData object missing")
value <- workspace[[args[[3L]]]]
if (!is.data.frame(value) || anyDuplicated(names(value))) stop("v10 RData frame/column identity invalid")
safe <- function(values) {
  values <- as.character(values)
  values[is.na(values)] <- ""
  if (any(grepl("[[:cntrl:]]", values))) stop("v10 RData identity has control characters")
  values
}
if (identical(args[[1L]], "site")) {
  if (!("date" %in% names(value)) || !inherits(value$date, "POSIXct") ||
      !identical(attr(value$date, "tzone"), "GMT") ||
      any(is.na(as.POSIXct(value$date, tz="UTC")))) stop("v10 site-year date is invalid")
  selected <- strsplit(args[[5L]], ",", fixed=TRUE)[[1L]]
  for (column in intersect(selected, names(value))) {
    raw <- as.character(value[[column]])
    numeric <- suppressWarnings(as.numeric(raw))
    if (any(!is.na(raw) & nzchar(trimws(raw)) & is.na(numeric))) {
      stop(paste("v10 selected source column cannot be decoded:", column))
    }
  }
  writeLines(safe(names(value)), stdout())
} else if (identical(args[[1L]], "metadata")) {
  required <- c("site_id", "parameter", "start_date", "end_date", "ratified_to")
  if (!all(required %in% names(value))) stop("v10 metadata columns missing")
  sites <- toupper(trimws(safe(value$site_id)))
  parameters <- toupper(trimws(safe(value$parameter)))
  matches <- which(sites == toupper(args[[4L]]) & parameters == toupper(args[[5L]]))
  if (length(matches) != 1L) stop("v10 metadata row missing or ambiguous")
  writeLines(paste(vapply(required, function(key) safe(value[[key]][matches]), ""),
                   collapse="\t"), stdout())
} else stop("v10 inspection mode invalid")
`;

function inspect(mode, file, object, site = "-", parameter = "-") {
  let output;
  try {
    output = execFileSync("Rscript", ["--vanilla", "-", mode, file.local_path,
      object, site, parameter], { input: INSPECT, encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(`Official RData v10 native-R ${mode} authentication failed: ${
      String(error.stderr || error.message || "").trim().slice(0, 600)}`);
  }
  return output.replace(/\r?\n$/, "");
}

function assertPinnedBytes(file) {
  const body = fs.readFileSync(file.local_path);
  if (body.byteLength !== file.bytes
      || createHash("sha256").update(body).digest("hex") !== file.sha256) {
    throw new Error(`Official RData v10 source bytes changed: ${file.source_file}`);
  }
}

function shiftedWindows(day, year) {
  const start = Date.parse(`${day}T00:00:00Z`) - 3600000;
  const end = start + 86400000;
  const yearStart = Date.parse(`${year}-01-01T00:00:00Z`);
  const yearEnd = Date.parse(`${year + 1}-01-01T00:00:00Z`);
  const left = Math.max(start, yearStart);
  const right = Math.min(end, yearEnd);
  if (!(left < right)) return null;
  const iso = (value) => new Date(value).toISOString().slice(0, 19) + "Z";
  return {
    raw: [{ canonical_day_utc: day, raw_start_utc: iso(left), raw_end_exclusive_utc: iso(right) }],
    canonical: [{ canonical_day_utc: day, canonical_start_utc: iso(left + 3600000),
      canonical_end_exclusive_utc: iso(right + 3600000) }],
  };
}

function lifecycle(row, windows) {
  const start = Date.parse(`${row.start_date}T00:00:00Z`);
  const open = row.end_date.toLowerCase() === "ongoing";
  const end = open ? Infinity : Date.parse(`${row.end_date}T00:00:00Z`) + 86400000;
  if (!Number.isFinite(start) || (!open && (!Number.isFinite(end) || end <= start))) {
    throw new Error("Official RData v10 metadata lifecycle is indeterminate");
  }
  const left = Date.parse(windows.raw[0].raw_start_utc);
  const right = Date.parse(windows.raw[0].raw_end_exclusive_utc);
  if (start < right && end > left) {
    return ["required", "lifecycle_overlaps_selected_source_window"];
  }
  if (start >= right) return ["authoritative_no_coverage", "coverage_starts_after_selected_source_window"];
  if (end <= left) return ["authoritative_no_coverage", "coverage_ends_before_selected_source_window"];
  return ["authoritative_no_coverage", "lifecycle_does_not_overlap_selected_source_window"];
}

function validProviderIdentity(source, file, filename, status) {
  const config = provider[source];
  let finalUrl;
  try { finalUrl = new URL(file.final_url); } catch { return false; }
  return Boolean(config && file.canonical_url === `${config.base}${filename}`
    && (!file.url || file.url === `${config.base}${filename}`)
    && file.http_status === status
    && finalUrl.protocol === "https:"
    && config.hosts.has(finalUrl.hostname)
    && !finalUrl.username && !finalUrl.password
    && (!finalUrl.port || finalUrl.port === "443")
    && finalUrl.pathname === new URL(file.canonical_url).pathname
    && !finalUrl.search && !finalUrl.hash);
}

export function validateOfficialRdataV10Columns(evidence, audit, scopes, files) {
  const entries = officialRdataV10ColumnClassifications(
    evidence.source_column_classifications || [],
  );
  if (!equal(entries, evidence.source_column_classifications)
      || officialRdataSha256(entries) !== evidence.source_column_classifications_sha256) {
    throw new Error("Official RData v10 column classification hash or order changed");
  }
  const selected = new Set(evidence.requested_pollutant_set);
  const mappings = evidence.mapping_audit?.mapped_source_groups || [];
  const byBinding = new Map(mappings.map((binding) => [
    `${binding.site_code}|${binding.pollutant_code}`, binding,
  ]));
  if (byBinding.size !== mappings.length) {
    throw new Error("Official RData v10 authoritative bindings are ambiguous");
  }
  const metadata = files.get(`${evidence.source_adapter}:metadata`);
  if (!metadata || !evidence.files_read.includes(`${evidence.source_adapter}:metadata`)
      || !validProviderIdentity(evidence.source_adapter, metadata,
        provider[evidence.source_adapter]?.metadata, 200)) {
    throw new Error("Official RData v10 authenticated metadata file is missing");
  }
  const metadataObject = evidence.source_adapter === "saqn" ? "meta" : "metadata";
  const expected = new Map();
  const expectedAbsent = new Map();
  for (const key of evidence.files_read) {
    if (key === `${evidence.source_adapter}:metadata`) continue;
    const match = SOURCE_YEAR.exec(key);
    if (!match || match[1] !== evidence.source_adapter || !files.has(key)) {
      throw new Error(`Official RData v10 present file identity is invalid: ${key}`);
    }
    const [, , site, yearText] = match;
    const year = Number(yearText);
    const windows = shiftedWindows(evidence.day_utc, year);
    if (!windows) throw new Error(`Official RData v10 site-year file escaped selected day: ${key}`);
    const file = files.get(key);
    if (!validProviderIdentity(evidence.source_adapter, file, `${site}_${year}.RData`, 200)
        || file.availability && file.availability !== "present") {
      throw new Error(`Official RData v10 present file status is invalid: ${key}`);
    }
    const object = `${site}_${year}`;
    const siteBindings = mappings.filter((item) => item.site_code === site
      && selected.has(item.pollutant_code));
    const selectedColumns = siteBindings.map((item) => columns[item.pollutant_code])
      .filter(Boolean).join(",");
    const actual = inspect("site", file, object, site, selectedColumns).split("\n").sort(bytewise);
    if (actual.length !== new Set(actual).size || actual.some((name) => !name)
        || !actual.includes("date")) {
      throw new Error(`Official RData v10 site-year columns are invalid: ${key}`);
    }
    for (const binding of siteBindings) {
      const column = columns[binding.pollutant_code];
      if (!column) throw new Error("Official RData v10 pollutant column is unsupported");
      const aliases = actual.filter((name) => name !== column
        && name.replace(/[^a-z0-9]/gi, "").toUpperCase()
          === column.replace(/[^a-z0-9]/gi, "").toUpperCase());
      if (aliases.length) throw new Error(`Official RData v10 ambiguous source column: ${site}/${column}`);
      const raw = inspect("metadata", metadata, metadataObject, site, column).split("\t");
      if (raw.length !== 5) throw new Error("Official RData v10 metadata row shape changed");
      const metadataRow = Object.fromEntries(
        ["site_id", "parameter", "start_date", "end_date", "ratified_to"]
          .map((field, index) => [field, raw[index]]),
      );
      const [lifecycleClassification, lifecycleReason] = lifecycle(metadataRow, windows);
      const identity = `${evidence.day_utc}|${site}|${year}|${binding.pollutant_code}`;
      expected.set(identity, {
        day_utc: evidence.day_utc, site_code: site, source_year: year,
        source_file_key: key, object_name: object,
        pollutant_code: binding.pollutant_code, source_column: column,
        station_id: binding.station_id, timeseries_id: binding.timeseries_id,
        classification: actual.includes(column) ? "source_column_present" : "source_column_unavailable",
        actual_columns: actual, metadata_row: metadataRow,
        lifecycle_classification: lifecycleClassification, lifecycle_reason: lifecycleReason,
        metadata_source_discrepancy: !actual.includes(column) && lifecycleClassification === "required"
          ? "metadata_coverage_without_source_column" : null,
        raw_source_windows: windows.raw, canonical_windows: windows.canonical,
      });
    }
    assertPinnedBytes(file);
  }
  for (const key of evidence.files_authoritatively_absent) {
    const match = SOURCE_YEAR.exec(key);
    if (!match || match[1] !== evidence.source_adapter) {
      throw new Error(`Official RData v10 absent file identity is invalid: ${key}`);
    }
    const site = match[2];
    const year = Number(match[3]);
    const windows = shiftedWindows(evidence.day_utc, year);
    if (!windows) throw new Error(`Official RData v10 absent file escaped selected day: ${key}`);
    for (const binding of mappings.filter((item) => item.site_code === site
        && selected.has(item.pollutant_code))) {
      const column = columns[binding.pollutant_code];
      if (!column) throw new Error("Official RData v10 pollutant column is unsupported");
      const raw = inspect("metadata", metadata, metadataObject, site, column).split("\t");
      if (raw.length !== 5) throw new Error(`Official RData v10 absent-file metadata is invalid: ${key}`);
      const [classification] = lifecycle(Object.fromEntries(
        ["site_id", "parameter", "start_date", "end_date", "ratified_to"]
          .map((field, index) => [field, raw[index]]),
      ), windows);
      if (evidence.history_generation === "v2" || classification !== "authoritative_no_coverage") {
        expectedAbsent.set(`${evidence.day_utc}|${site}|${year}|${binding.pollutant_code}`,
          { source_file_key: key, station_id: binding.station_id,
            timeseries_id: binding.timeseries_id });
      }
    }
  }
  assertPinnedBytes(metadata);
  if (!equal([...expected.values()].sort((a, b) => bytewise(canonical(a), canonical(b))), entries)) {
    // Compare keyed records below to keep mismatch diagnostics tied to a site and pollutant.
    if (entries.length !== expected.size) throw new Error("Official RData v10 column inventory is incomplete");
    for (const entry of entries) {
      const identity = `${entry.day_utc}|${entry.site_code}|${entry.source_year}|${entry.pollutant_code}`;
      if (!equal(expected.get(identity), entry)) {
        throw new Error(`Official RData v10 source column or metadata authentication failed: ${identity}`);
      }
    }
  }
  const expectedAudit = entries.map((entry) => ({
    source_file_key: entry.source_file_key, day_utc: entry.day_utc,
    pollutant_code: entry.pollutant_code, classification: entry.classification,
    requested_at_utc: files.get(entry.source_file_key)?.requested_at_utc || null,
  }));
  if (!equal(expectedAudit.sort((a, b) => bytewise(canonical(a), canonical(b))),
    audit.source_column_classification_acquisition_audit)) {
    throw new Error("Official RData v10 column acquisition audit changed");
  }
  const missing = new Set(entries.filter((entry) =>
    entry.classification === "source_column_unavailable"
    && entry.lifecycle_classification !== "authoritative_no_coverage")
    .map((entry) => `${entry.day_utc}|${entry.site_code}|${entry.source_year}|${entry.pollutant_code}`));
  const scoped = new Set();
  const scopedAbsent = new Set();
  const allScopes = new Set();
  for (const scope of scopes) {
    const identity = `${scope.day_utc}|${scope.site_code}|${scope.source_year}|${scope.pollutant_code}`;
    if (allScopes.has(identity)) {
      throw new Error(`Official RData v10 unavailable scope is duplicated: ${identity}`);
    }
    allScopes.add(identity);
    const windows = shiftedWindows(scope.day_utc, scope.source_year);
    if (!windows || !equal(scope.raw_source_windows, windows.raw)
        || !equal(scope.canonical_unavailable_windows, windows.canonical)) {
      throw new Error(`Official RData v10 shifted unavailable windows changed: ${identity}`);
    }
    if (scope.reason === "provider_site_year_pollutant_column_absent") {
      const entry = expected.get(identity);
      const file = files.get(scope.source_file_key);
      if (!missing.has(identity) || !entry || !file || scope.http_status !== 200
          || scope.canonical_url !== file.canonical_url || scope.final_url !== file.final_url
          || !equal(scope.raw_source_windows, entry.raw_source_windows)
          || !equal(scope.canonical_unavailable_windows, entry.canonical_windows)
          || scope.station_id !== entry.station_id || scope.timeseries_id !== entry.timeseries_id) {
        throw new Error(`Official RData v10 missing-column scope is unauthenticated: ${identity}`);
      }
      scoped.add(identity);
    } else if (scope.reason !== "provider_site_year_artifact_absent"
        || scope.http_status !== 404
        || !evidence.files_authoritatively_absent.includes(scope.source_file_key)
        || scope.source_file_key !== `${evidence.source_adapter}:site_ref=${scope.site_code}:year=${scope.source_year}`
        || !expectedAbsent.has(identity)
        || scope.station_id !== expectedAbsent.get(identity).station_id
        || scope.timeseries_id !== expectedAbsent.get(identity).timeseries_id
        || !validProviderIdentity(evidence.source_adapter, scope,
          `${scope.site_code}_${scope.source_year}.RData`, 404)) {
      throw new Error(`Official RData v10 unavailable subtype is invalid: ${identity}`);
    } else {
      scopedAbsent.add(identity);
    }
  }
  if (!equal([...missing].sort(), [...scoped].sort())) {
    throw new Error("Official RData v10 missing-column windows are incomplete");
  }
  if (!equal([...expectedAbsent.keys()].sort(), [...scopedAbsent].sort())) {
    throw new Error("Official RData v10 absent-file windows are incomplete");
  }
}

export function validateOfficialRdataV10PreservedOnlyAuthority(authority) {
  if (!["v2", "v3"].includes(authority.history_generation)
      || authority.contract_version
        !== `uk_aq_generic_${authority.history_generation}_official_rdata_scope_source_authority_v1`) {
    throw new Error("Official RData v10 preserved-only history generation is invalid");
  }
  if (officialRdataSha256(authority.mapping_audit?.mapped_source_groups || [])
      !== authority.authoritative_station_timeseries_mapping_sha256) {
    throw new Error("Official RData v10 preserved-only binding hash changed");
  }
  const acquired = authority.acquisition_audit?.source_file_acquisition_audit;
  if (!Array.isArray(acquired)) {
    throw new Error("Official RData v10 preserved-only acquisition audit is missing");
  }
  const files = new Map(acquired.map((item) => [item.source_file, item]));
  const selectedBindings = (authority.mapping_audit?.mapped_source_groups || [])
    .filter((item) => item.pollutant_code === authority.pollutant_code);
  const expectedIds = [...new Set(selectedBindings.map((item) => item.timeseries_id))]
    .sort((a, b) => a - b);
  const scopedIds = [...new Set(authority.source_unavailable_scopes.map(
    (scope) => scope.timeseries_id))].sort((a, b) => a - b);
  if (!expectedIds.length || !equal(expectedIds, scopedIds)
      || !equal(expectedIds, authority.source_unavailable_timeseries_ids)) {
    throw new Error("Official RData v10 preserved-only timeseries membership changed");
  }
  const dayStart = Date.parse(`${authority.day_utc}T00:00:00Z`);
  for (const id of expectedIds) {
    let covered = dayStart;
    const intervals = authority.source_unavailable_scopes
      .filter((scope) => scope.timeseries_id === id)
      .flatMap((scope) => scope.canonical_unavailable_windows)
      .map((window) => [Date.parse(window.canonical_start_utc),
        Date.parse(window.canonical_end_exclusive_utc)])
      .sort((a, b) => a[0] - b[0]);
    for (const [left, right] of intervals) {
      if (!Number.isFinite(left) || !Number.isFinite(right) || left > covered || right <= left) {
        throw new Error(`Official RData v10 preserved-only window is incomplete: ${id}`);
      }
      covered = Math.max(covered, right);
    }
    if (covered < dayStart + 86400000) {
      throw new Error(`Official RData v10 preserved-only day is not fully unavailable: ${id}`);
    }
  }
  const required = new Set(authority.files_required);
  const read = new Set(authority.files_read);
  const absent = new Set(authority.files_authoritatively_absent);
  if (files.size !== acquired.length
      || !equal([...files.keys()].sort(), authority.files_read)
      || !authority.files_read.includes(`${authority.source_adapter}:metadata`)
      || !equal(authority.source_file_identities,
        acquired.map((item) => ({ source_file: item.source_file, bytes: item.bytes, sha256: item.sha256 })))
      || required.size !== read.size + absent.size
      || [...required].some((key) => !read.has(key) && !absent.has(key))
      || [...read].some((key) => absent.has(key) || !required.has(key))) {
    throw new Error("Official RData v10 preserved-only file enumeration changed");
  }
  if (!equal(officialRdataAvailabilitySemanticIdentity(
    authority.acquisition_audit.source_unavailable_scope_acquisition_audit || [],
  ), authority.source_unavailable_scopes)) {
    throw new Error("Official RData v10 preserved-only availability audit changed");
  }
  for (const file of acquired) {
    assertPinnedBytes(file);
  }
  const evidence = {
    evidence_contract_version: 10,
    history_generation: authority.history_generation,
    source_adapter: authority.source_adapter,
    day_utc: authority.day_utc,
    requested_pollutant_set: authority.requested_pollutant_set,
    mapping_audit: authority.mapping_audit,
    files_read: authority.files_read,
    files_authoritatively_absent: authority.files_authoritatively_absent,
    source_column_classifications: authority.source_column_classifications,
    source_column_classifications_sha256: authority.source_column_classifications_sha256,
  };
  validateOfficialRdataV10Columns(evidence, {
    source_column_classification_acquisition_audit:
      authority.acquisition_audit.source_column_classification_acquisition_audit,
  }, authority.source_unavailable_scopes, files);
}
