/** Official-network source and preservation authentication; local files only. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCanonicalObservationRows } from "../uk_aq_apply_integrity_proposal.mjs";
import { encodeCanonicalObservationRow } from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  canonicalOfficialRdataJson as canonical,
  officialRdataAvailabilitySemanticIdentity,
  officialRdataSha256,
  OFFICIAL_RDATA_V10_SEMANTIC_EVIDENCE_FIELDS,
} from "./official_rdata_semantic_projection.mjs";
import { authenticateOfficialRdataPinnedHierarchy } from "./official_rdata_pinned_hierarchy.mjs";
import { validateOfficialRdataV10Columns } from "./official_rdata_v10_validation.mjs";

const digest = (body) => createHash("sha256").update(body).digest("hex");
const equal = (a, b) => canonical(a) === canonical(b);
const encoded = (rows) => rows.map(encodeCanonicalObservationRow).sort();
const V9_TIMESTAMP_MAPPING = "rdata_date_beginning_plus_one_hour_to_observed_at_utc";
const INPUT_FIELDS = [
  "source_adapter", "day_utc", "connector_id", "source_file_identities_sha256",
  "requested_pollutant_set", "contract", "evidence_contract_version",
  "history_generation", "source_label_registry_snapshot_content_sha256",
  "authoritative_station_timeseries_mapping_sha256", "sos_site_ref_bridge_mapping_identity",
  "sos_site_ref_bridge_artifact_sha256", "observed_property_mapping_sha256",
  "source_artifact_availability_sha256", "source_artifact_availability_contract_version",
  "preserved_baseline_dependency_sha256", "preserved_baseline_dependency_contract_version",
  "rdata_decoder_contract_version", "timestamp_mapping", "observation_content_hash_contract_version",
];
const AUDIT_FIELDS = [
  "schema_version", "audit_contract", "audit_contract_version", "source_adapter",
  "day_utc", "connector_id", "history_generation", "source_evidence_input_sha256",
  "semantic_evidence_sha256", "source_file_acquisition_audit",
  "source_unavailable_scope_acquisition_audit", "ratification_audit", "rscript_identity",
  "backed_up_at_utc", "proposal_writer_git_sha",
];

function unavailable(row, scopes) {
  return scopes.some((scope) => scope.timeseries_id === row.timeseries_id
    && scope.pollutant_code === row.pollutant_code
    && scope.canonical_unavailable_windows.some((window) => {
      const start = Date.parse(window.canonical_start_utc);
      const end = Date.parse(window.canonical_end_exclusive_utc);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error("Official RData unavailable window is invalid");
      }
      const observed = Date.parse(row.observed_at_utc);
      return start <= observed && observed < end;
    }));
}

function hasAvailableWindow(day, scopes) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86400000;
  let coveredUntil = start;
  const windows = scopes.flatMap((scope) => scope.canonical_unavailable_windows)
    .map((window) => [Date.parse(window.canonical_start_utc), Date.parse(window.canonical_end_exclusive_utc)])
    .sort((a, b) => a[0] - b[0]);
  for (const [left, right] of windows) {
    if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right) {
      throw new Error("Official RData unavailable window is invalid");
    }
    if (right <= coveredUntil || left >= end) continue;
    if (left > coveredUntil) return true;
    coveredUntil = Math.max(coveredUntil, right);
  }
  return coveredUntil < end;
}

function pinnedPath(root, key) {
  if (typeof key !== "string" || !key || key.startsWith("/")
      || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Official RData pinned object key is invalid");
  }
  return path.join(root, ...key.split("/"));
}

export async function validateOfficialRdataPreservationDependencies({ runState, source }) {
  const evidence = source.evidence;
  const audit = evidence.acquisition_audit;
  if (![8, 9, 10].includes(evidence.evidence_contract_version)) {
    throw new Error("Official RData evidence contract version is unsupported");
  }
  if (evidence.evidence_contract_version >= 9
      && evidence.timestamp_mapping !== V9_TIMESTAMP_MAPPING) {
    throw new Error("Official RData timestamp mapping is invalid");
  }
  if (!["waqn", "saqn"].includes(evidence.source_adapter)
      || !["v2", "v3"].includes(evidence.history_generation)) {
    throw new Error("Official RData source scope is invalid");
  }
  const v10 = evidence.evidence_contract_version === 10;
  const auditFields = v10
    ? [...AUDIT_FIELDS, "source_column_classification_acquisition_audit"] : AUDIT_FIELDS;
  const inputFields = v10
    ? [...INPUT_FIELDS, "source_column_classifications_sha256"] : INPUT_FIELDS;
  if (!audit || !equal(Object.keys(audit).sort(), [...auditFields].sort())
      || audit.audit_contract_version !== (v10 ? 2 : 1)) {
    throw new Error("Official RData acquisition audit shape is invalid");
  }
  if (officialRdataSha256(audit) !== evidence.acquisition_audit_sha256) {
    throw new Error("Official RData acquisition audit hash changed");
  }
  if (audit.source_evidence_input_sha256 !== evidence.source_evidence_input_sha256
      || audit.semantic_evidence_sha256 !== evidence.semantic_evidence_sha256) {
    throw new Error("Official RData acquisition audit linkage changed");
  }
  if (inputFields.some((field) => !Object.hasOwn(evidence, field))) {
    throw new Error("Official RData source-input fields are incomplete");
  }
  if (officialRdataSha256(Object.fromEntries(inputFields.map((field) => [field, evidence[field]])))
      !== evidence.source_evidence_input_sha256) {
    throw new Error("Official RData source-input hash changed");
  }
  if (v10) {
    const allowed = new Set([...OFFICIAL_RDATA_V10_SEMANTIC_EVIDENCE_FIELDS,
      "semantic_evidence_sha256", "acquisition_audit", "acquisition_audit_sha256"]);
    if (!equal(Object.keys(evidence).sort(), [...allowed].sort())
        || officialRdataSha256(Object.fromEntries(
          OFFICIAL_RDATA_V10_SEMANTIC_EVIDENCE_FIELDS.map((field) => [field, evidence[field]]),
        )) !== evidence.semantic_evidence_sha256
        || evidence.source_artifact_availability_contract_version !== 10
        || evidence.preserved_baseline_dependency_contract_version !== 2) {
      throw new Error("Official RData v10 semantic evidence authentication failed");
    }
  }
  for (const field of ["source_adapter", "day_utc", "connector_id", "history_generation"]) {
    if (audit[field] !== evidence[field]) throw new Error("Official RData acquisition scope changed");
  }
  const scopes = officialRdataAvailabilitySemanticIdentity(evidence.source_unavailable_scopes);
  if (officialRdataSha256(scopes) !== evidence.source_artifact_availability_sha256
      || !equal(scopes, officialRdataAvailabilitySemanticIdentity(audit.source_unavailable_scope_acquisition_audit))) {
    throw new Error("Official RData availability authentication failed");
  }
  const files = new Map(audit.source_file_acquisition_audit.map((item) => [item.source_file, item]));
  if (files.size !== evidence.source_file_identities.length
      || files.size !== audit.source_file_acquisition_audit.length
      || digest(Buffer.from(JSON.stringify(evidence.source_file_identities), "utf8")) !== evidence.source_file_identities_sha256
      || !equal([...new Set([...evidence.files_read, ...evidence.files_authoritatively_absent])].sort(), evidence.files_required)
      || evidence.files_read.some((key) => evidence.files_authoritatively_absent.includes(key))) {
    throw new Error("Official RData source-file enumeration changed");
  }
  for (const identity of evidence.source_file_identities) {
    const acquisition = files.get(identity.source_file);
    if (!acquisition || acquisition.bytes !== identity.bytes || acquisition.sha256 !== identity.sha256) {
      throw new Error("Official RData source-file acquisition identity changed");
    }
    const body = fs.readFileSync(String(acquisition.local_path || ""));
    if (body.byteLength !== identity.bytes || digest(body) !== identity.sha256) {
      throw new Error("Official RData authenticated source bytes changed");
    }
  }
  if (scopes.some((scope) => (!v10 && (scope.http_status !== 404
      || !evidence.files_authoritatively_absent.includes(scope.source_file_key)))
      || scope.day_utc !== evidence.day_utc || !scope.canonical_unavailable_windows.length)) {
    throw new Error("Official RData unavailable classification lacks authenticated absence");
  }
  if (v10) validateOfficialRdataV10Columns(evidence, audit, scopes, files);
  const preservedBody = fs.readFileSync(path.join(path.dirname(source.rowsPath), "preserved_baseline_rows.json"));
  const preserved = JSON.parse(preservedBody.toString("utf8")).map((row) => ({
    ...row, connector_id: evidence.connector_id, observed_at_utc: new Date(row.observed_at).toISOString(),
  }));
  const sourceRows = JSON.parse(fs.readFileSync(source.rowsPath, "utf8")).map((row) => ({
    ...row, connector_id: evidence.connector_id, observed_at_utc: new Date(row.observed_at).toISOString(),
  }));
  const mappings = evidence.mapping_audit.mapped_source_groups;
  const selectedMappings = mappings.filter((item) => evidence.requested_pollutant_set.includes(item.pollutant_code));
  const bindings = new Map(selectedMappings.map((item) => [item.timeseries_id, item]));
  const available = selectedMappings.filter((item) => hasAvailableWindow(evidence.day_utc,
    scopes.filter((scope) => scope.timeseries_id === item.timeseries_id)));
  if (officialRdataSha256(mappings) !== evidence.authoritative_station_timeseries_mapping_sha256
      || bindings.size !== selectedMappings.length
      || !equal(available.map((item) => item.timeseries_id).sort((a, b) => a - b), evidence.source_available_timeseries_ids)
      || !equal([...new Set(available.map((item) => item.pollutant_code))].sort(), evidence.source_available_pollutant_codes)
      || !equal([...new Set(scopes.map((scope) => scope.timeseries_id))].sort((a, b) => a - b), evidence.source_unavailable_timeseries_ids)
      || [...sourceRows, ...preserved, ...scopes].some((row) => {
        const binding = bindings.get(row.timeseries_id);
        return !binding || binding.station_id !== row.station_id || binding.pollutant_code !== row.pollutant_code
          || (row.site_code !== undefined && binding.site_code !== row.site_code);
      })) {
    throw new Error("Official RData mapping or repairable availability authority changed");
  }
  if (sourceRows.some((row) => unavailable(row, scopes))
      || preserved.some((row) => !unavailable(row, scopes))) {
    throw new Error("Official RData source/preserved row availability changed");
  }
  // Hash persisted dependency fields verbatim: historical v8 meaning is retained.
  if (officialRdataSha256({ preserved_baseline_identity: evidence.preserved_baseline_identity,
    preserved_baseline_rows_sha256: evidence.preserved_baseline_rows_sha256,
    source_unavailable_scopes: scopes }) !== evidence.preserved_baseline_dependency_sha256) {
    throw new Error("Official RData preservation dependency identity changed");
  }
  const preservation = evidence.preserved_baseline_identity;
  if (preservation.source !== "dropbox"
      || !equal(preservation.partition_identities.map((p) => p.pollutant_code).sort(),
        [...new Set(scopes.map((s) => s.pollutant_code))].sort())) {
    throw new Error("Official RData preservation dependency set changed");
  }
  for (const partition of preservation.partition_identities) {
    const prefix = `history/${evidence.history_generation}/observations/day_utc=${evidence.day_utc}/connector_id=${evidence.connector_id}/pollutant_code=${partition.pollutant_code}`;
    const partitionScopes = scopes.filter((scope) => scope.pollutant_code === partition.pollutant_code);
    if (partition.day_utc !== evidence.day_utc || partition.connector_id !== evidence.connector_id
        || partition.manifest_key !== `${prefix}/manifest.json`
        || !equal(partitionScopes, officialRdataAvailabilitySemanticIdentity(partition.source_unavailable_scopes))
        || !equal(partition.source_unavailable_timeseries_ids,
          [...new Set(partitionScopes.map((scope) => scope.timeseries_id))].sort((a, b) => a - b))) {
      throw new Error("Official RData preservation partition escaped authority");
    }
    authenticateOfficialRdataPinnedHierarchy(runState, partition);
    const baselineRows = [];
    const objects = new Map(partition.object_identities.map((item) => [item.object_key, item]));
    if (objects.size !== partition.object_identities.length) throw new Error("Duplicate preserved baseline object");
    if (partition.baseline_state === "partition_present") {
      const manifest = JSON.parse(fs.readFileSync(pinnedPath(runState.base_dropbox_root, partition.manifest_key), "utf8"));
      if (!equal([...objects.keys()].sort(), [partition.manifest_key, ...manifest.files.map((f) => f.key)].sort())) {
        throw new Error("Official RData preservation child closure changed");
      }
      for (const item of objects.values()) {
        if (!item.object_key.startsWith(`${prefix}/`)) throw new Error("Preservation object escaped scope");
        const body = fs.readFileSync(pinnedPath(runState.base_dropbox_root, item.object_key));
        if (body.byteLength !== item.bytes || digest(body) !== item.sha256) throw new Error("Preservation byte identity changed");
        if (item.object_key.endsWith(".parquet")) {
          const file = manifest.files.find((entry) => entry.key === item.object_key);
          if (file.bytes !== item.bytes || file.etag_or_hash !== item.sha256) throw new Error("Preserved manifest identity disagrees");
          baselineRows.push(...await readCanonicalObservationRows({ body, connectorId: evidence.connector_id }));
        }
      }
    } else if (partition.baseline_state !== "partition_absent" || objects.size) {
      throw new Error("Official RData preservation baseline state is invalid");
    }
    const selectedBaseline = baselineRows.filter((row) => unavailable(row, partitionScopes));
    if (selectedBaseline.length !== partition.preserved_row_count
        || !equal(encoded(selectedBaseline), encoded(preserved.filter((row) => row.pollutant_code === partition.pollutant_code)))) {
      throw new Error("Official RData preserved rows differ from authenticated baseline");
    }
  }
  const targetStatus = new Map();
  for (const row of [...sourceRows, ...preserved]) {
    const identity = `${row.timeseries_id}|${new Date(row.observed_at_utc).toISOString()}`;
    if (targetStatus.has(identity)) throw new Error("Official RData final target has duplicate observation identity");
    targetStatus.set(identity, row.verification_status);
  }
  for (const pollutantCode of evidence.source_available_pollutant_codes) {
    const prefix = `history/${evidence.history_generation}/observations/day_utc=${evidence.day_utc}`
      + `/connector_id=${evidence.connector_id}/pollutant_code=${pollutantCode}`;
    const manifestKey = `${prefix}/manifest.json`;
    const manifestPath = pinnedPath(runState.base_dropbox_root, manifestKey);
    const exists = fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile() === true;
    authenticateOfficialRdataPinnedHierarchy(runState, {
      day_utc: evidence.day_utc, connector_id: evidence.connector_id,
      pollutant_code: pollutantCode, manifest_key: manifestKey,
      baseline_state: exists ? "partition_present" : "partition_absent",
    });
    if (!exists) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.files)) throw new Error("Official RData ratification baseline files are invalid");
    const expected = new Set();
    const baselineRows = [];
    for (const file of manifest.files) {
      if (typeof file?.key !== "string" || !/^part-\d+\.parquet$/.test(file.key.slice(prefix.length + 1))
          || !file.key.startsWith(`${prefix}/`) || expected.has(file.key)) {
        throw new Error("Official RData ratification baseline file closure is invalid");
      }
      expected.add(file.key);
      const body = fs.readFileSync(pinnedPath(runState.base_dropbox_root, file.key));
      if (body.byteLength !== file.bytes || digest(body) !== file.etag_or_hash) {
        throw new Error("Official RData ratification baseline bytes changed");
      }
      baselineRows.push(...await readCanonicalObservationRows({ body, connectorId: evidence.connector_id }));
    }
    const actual = new Set(fs.readdirSync(pinnedPath(runState.base_dropbox_root, prefix))
      .filter((name) => name.startsWith("part-") && name.endsWith(".parquet"))
      .map((name) => `${prefix}/${name}`));
    if (!equal([...expected].sort(), [...actual].sort())) {
      throw new Error("Official RData ratification baseline file closure changed");
    }
    for (const row of baselineRows) {
      if (row.connector_id !== evidence.connector_id || row.pollutant_code !== pollutantCode
          || String(row.observed_at_utc).slice(0, 10) !== evidence.day_utc) {
        throw new Error("Official RData ratification baseline row escaped scope");
      }
      const identity = `${row.timeseries_id}|${new Date(row.observed_at_utc).toISOString()}`;
      if (row.verification_status === "R" && targetStatus.has(identity)
          && targetStatus.get(identity) !== "R") {
        throw new Error("Official RData ratification boundary regressed");
      }
    }
  }
}
