import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "../../shared/r2_sigv4.mjs";
import {
  computeObservationContentHash,
  validateObservationContentHashMetadata,
} from "../../shared/uk_aq_observation_content_hash.mjs";
import {
  inspectObservationParquetFile,
} from "../../../scripts/backup_r2/lib/uk_aq_observation_parquet_content_hash.mjs";
import {
  combineObservationHistoryPhysicalSchemas,
  observationHistoryPhysicalSchemaForColumns,
} from "../../shared/uk_aq_observation_history_schema.mjs";

const SOURCE_DERIVED_OWNER = "source_derived_observation_repair";
const OBSERVATION_MANIFEST_SCHEMA_VERSION = 3;
const POLLUTANT_MANIFEST_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readOwnedObject(state, key, overlayRoot) {
  const entry = state?.objects?.[key];
  if (!isPlainObject(entry)
    || entry.stage !== "observations_data"
    || entry.proposed !== true
    || entry.built !== true
    || entry.structurally_validated !== true) return null;
  const localPath = String(entry.local_path || "");
  if (!localPath || !isWithin(overlayRoot, localPath)
    || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Source-derived proposal owner has no valid staged object: ${key}`);
  }
  const body = fs.readFileSync(localPath);
  if (body.byteLength !== Number(entry.bytes) || sha256Hex(body) !== entry.sha256) {
    throw new Error(`Source-derived proposal owner identity changed: ${key}`);
  }
  return { entry, localPath, body };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function timeseriesRowCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const key = String(row.timeseries_id);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function minMax(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
  if (!values.length) return { min: null, max: null };
  return { min: values.reduce((left, right) => left < right ? left : right), max: values.reduce((left, right) => left > right ? left : right) };
}

function manifestContentProjection(payload) {
  const files = Object.fromEntries((Array.isArray(payload?.files) ? payload.files : [])
    .map((entry) => [String(entry?.key || ""), {
      key: String(entry?.key || ""),
      row_count: Number(entry?.row_count),
      bytes: Number(entry?.bytes),
      etag_or_hash: String(entry?.etag_or_hash || ""),
      pollutant_code: entry?.pollutant_code ?? null,
      pollutant_codes: Array.isArray(entry?.pollutant_codes) ? [...entry.pollutant_codes].sort() : null,
      min_timeseries_id: entry?.min_timeseries_id ?? null,
      max_timeseries_id: entry?.max_timeseries_id ?? null,
      min_observed_at_utc: entry?.min_observed_at_utc ?? entry?.min_observed_at ?? null,
      max_observed_at_utc: entry?.max_observed_at_utc ?? entry?.max_observed_at ?? null,
      timeseries_row_counts: entry?.timeseries_row_counts ?? null,
    }])
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    manifest_schema_version: Number(payload?.manifest_schema_version),
    history_version: payload?.history_version,
    domain: payload?.domain,
    manifest_kind: payload?.manifest_kind,
    grain: payload?.grain ?? null,
    profile: payload?.profile ?? null,
    day_utc: payload?.day_utc,
    connector_id: Number(payload?.connector_id),
    pollutant_code: payload?.pollutant_code,
    pollutant_codes: Array.isArray(payload?.pollutant_codes) ? [...payload.pollutant_codes].sort() : null,
    manifest_key: payload?.manifest_key,
    parquet_object_keys: Array.isArray(payload?.parquet_object_keys) ? [...payload.parquet_object_keys].map(String).sort() : null,
    file_count: Number(payload?.file_count),
    total_bytes: Number(payload?.total_bytes),
    files,
    source_row_count: Number(payload?.source_row_count),
    row_count: Number(payload?.row_count),
    min_timeseries_id: payload?.min_timeseries_id ?? null,
    max_timeseries_id: payload?.max_timeseries_id ?? null,
    min_observed_at_utc: payload?.min_observed_at_utc ?? null,
    max_observed_at_utc: payload?.max_observed_at_utc ?? null,
    min_timestamp_hour_utc: payload?.min_timestamp_hour_utc ?? null,
    max_timestamp_hour_utc: payload?.max_timestamp_hour_utc ?? null,
    timeseries_row_counts: payload?.timeseries_row_counts ?? null,
    child_manifests: payload?.child_manifests ?? null,
    bytes_per_row_estimate: payload?.bytes_per_row_estimate ?? null,
    avg_file_bytes: payload?.avg_file_bytes ?? null,
    min_file_bytes: payload?.min_file_bytes ?? null,
    max_file_bytes: payload?.max_file_bytes ?? null,
    observation_content_hash: payload?.observation_content_hash,
    observation_content_hash_algorithm: payload?.observation_content_hash_algorithm,
    observation_content_hash_contract_version: payload?.observation_content_hash_contract_version,
    observation_content_hash_row_count: Number(payload?.observation_content_hash_row_count),
    observation_content_hash_columns: payload?.observation_content_hash_columns,
    verification_status_counts: payload?.verification_status_counts,
    history_schema_version: payload?.history_schema_version,
    columns: payload?.columns,
    writer_version: payload?.writer_version,
    physical_schemas: payload?.physical_schemas ?? null,
  };
}

function differingContentFields(actual, expected) {
  const fields = [];
  const visit = (left, right, field) => {
    if (isPlainObject(left) && isPlainObject(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        visit(left[key], right[key], field ? `${field}.${key}` : key);
      }
      return;
    }
    if (!sameJson(left, right)) fields.push(field);
  };
  visit(actual, expected, "");
  return fields;
}

export function compareSourceDerivedManifestContent(proposal, contentFacts) {
  let payload;
  try {
    payload = JSON.parse(String(proposal?.proposed_body || ""));
  } catch {
    return { identical: false, differing_fields: ["manifest_json"] };
  }
  const differingFields = differingContentFields(
    manifestContentProjection(payload),
    contentFacts,
  );
  const expectedDependencies = Object.keys(contentFacts.files || {}).sort();
  const actualDependencies = [...new Set((proposal?.dependencies || []).map(String))].sort();
  if (!sameJson(actualDependencies, expectedDependencies)) differingFields.push("dependencies");
  for (const key of expectedDependencies) {
    const expected = contentFacts.files[key];
    const actual = proposal?.dependency_identities?.[key];
    if (String(actual?.sha256 || "") !== expected.etag_or_hash) {
      differingFields.push(`dependency_identities.${key}.sha256`);
    }
    if (Number(actual?.bytes) !== expected.bytes) {
      differingFields.push(`dependency_identities.${key}.bytes`);
    }
    if (!["overlay", "planned_overlay"].includes(String(actual?.source || ""))) {
      differingFields.push(`dependency_identities.${key}.source`);
    }
  }
  return {
    identical: differingFields.length === 0,
    differing_fields: [...new Set(differingFields)],
  };
}

export async function inspectSourceDerivedObservationManifestOwner({
  state,
  manifestKey,
  overlayRoot,
} = {}) {
  const match = String(manifestKey || "").match(POLLUTANT_MANIFEST_PATTERN);
  if (!match) return null;
  const ownedManifest = readOwnedObject(state, manifestKey, overlayRoot);
  if (!ownedManifest) return null;
  const [, dayUtc, connectorIdRaw, pollutantCode] = match;
  const connectorId = Number(connectorIdRaw);
  let payload;
  try {
    payload = JSON.parse(ownedManifest.body.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Source-derived proposal owner has invalid manifest JSON: ${manifestKey} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (payload?.history_version !== "v2"
    || payload?.domain !== "observations"
    || payload?.manifest_kind !== "pollutant"
    || payload?.manifest_key !== manifestKey
    || payload?.day_utc !== dayUtc
    || Number(payload?.connector_id) !== connectorId
    || payload?.pollutant_code !== pollutantCode) {
    throw new Error(`Source-derived proposal owner has invalid manifest identity: ${manifestKey}`);
  }
  validateObservationContentHashMetadata(payload, { rowCount: Number(payload.source_row_count) });
  const manifestPrefix = manifestKey.slice(0, -"manifest.json".length);
  const partKeys = Object.keys(state.objects || {}).filter((key) =>
    key.startsWith(manifestPrefix) && key.endsWith(".parquet")
  ).sort();
  if (!partKeys.length) {
    throw new Error(`Source-derived proposal owner has no staged Parquet: ${manifestKey}`);
  }
  const canonicalRows = [];
  const physicalSchemas = [];
  const derivedFiles = {};
  const dependencyIdentities = {};
  for (const partKey of partKeys) {
    const ownedPart = readOwnedObject(state, partKey, overlayRoot);
    if (!ownedPart) {
      throw new Error(`Source-derived proposal owner is missing its staged Parquet: ${manifestKey} -> ${partKey}`);
    }
    const inspected = await inspectObservationParquetFile({
      filePath: ownedPart.localPath,
      connectorId,
    });
    if (inspected.canonicalRows.some((row) => row.connector_id !== connectorId
      || row.pollutant_code !== pollutantCode
      || row.observed_at_utc.slice(0, 10) !== dayUtc)) {
      throw new Error(`Source-derived staged Parquet has invalid partition identity: ${manifestKey} -> ${partKey}`);
    }
    const partTimeseriesCounts = timeseriesRowCounts(inspected.canonicalRows);
    const timeseriesRange = minMax(inspected.canonicalRows, "timeseries_id");
    const observedRange = minMax(inspected.canonicalRows, "observed_at_utc");
    derivedFiles[partKey] = {
      key: partKey,
      row_count: inspected.rowCount,
      bytes: ownedPart.body.byteLength,
      etag_or_hash: sha256Hex(ownedPart.body),
      pollutant_code: pollutantCode,
      pollutant_codes: [pollutantCode],
      min_timeseries_id: timeseriesRange.min,
      max_timeseries_id: timeseriesRange.max,
      min_observed_at_utc: observedRange.min,
      max_observed_at_utc: observedRange.max,
      timeseries_row_counts: partTimeseriesCounts,
    };
    canonicalRows.push(...inspected.canonicalRows);
    physicalSchemas.push(observationHistoryPhysicalSchemaForColumns(inspected.physicalColumns));
    dependencyIdentities[partKey] = {
      sha256: sha256Hex(ownedPart.body),
      bytes: ownedPart.body.byteLength,
      source: "overlay",
    };
  }
  const physicalSchema = combineObservationHistoryPhysicalSchemas(physicalSchemas);
  if (Array.isArray(physicalSchema.physical_schemas)) {
    throw new Error(`Source-derived staged Parquet has mixed physical schemas: ${manifestKey}`);
  }
  const { canonical_rows: _canonicalRows, ...semantic } =
    computeObservationContentHash(canonicalRows);
  const timeseriesRange = minMax(canonicalRows, "timeseries_id");
  const observedRange = minMax(canonicalRows, "observed_at_utc");
  const totalBytes = Object.values(derivedFiles).reduce((sum, entry) => sum + entry.bytes, 0);
  const fileBytes = Object.values(derivedFiles).map((entry) => entry.bytes);
  const contentFacts = manifestContentProjection({
    manifest_schema_version: OBSERVATION_MANIFEST_SCHEMA_VERSION,
    history_version: "v2",
    domain: "observations",
    manifest_kind: "pollutant",
    grain: null,
    profile: null,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
    pollutant_codes: [pollutantCode],
    manifest_key: manifestKey,
    parquet_object_keys: partKeys,
    file_count: partKeys.length,
    total_bytes: totalBytes,
    files: Object.values(derivedFiles),
    source_row_count: canonicalRows.length,
    row_count: canonicalRows.length,
    min_timeseries_id: timeseriesRange.min,
    max_timeseries_id: timeseriesRange.max,
    min_observed_at_utc: observedRange.min,
    max_observed_at_utc: observedRange.max,
    min_timestamp_hour_utc: null,
    max_timestamp_hour_utc: null,
    timeseries_row_counts: timeseriesRowCounts(canonicalRows),
    child_manifests: [],
    bytes_per_row_estimate: totalBytes / canonicalRows.length,
    avg_file_bytes: totalBytes / fileBytes.length,
    min_file_bytes: Math.min(...fileBytes),
    max_file_bytes: Math.max(...fileBytes),
    ...semantic,
    ...physicalSchema,
  });
  const comparison = compareSourceDerivedManifestContent({
    proposed_body: ownedManifest.body.toString("utf8"),
    dependencies: partKeys,
    dependency_identities: dependencyIdentities,
  }, contentFacts);
  if (!comparison.identical) {
    throw new Error(
      `Source-derived proposal manifest does not describe final staged Parquet: ${manifestKey} differing_fields=${comparison.differing_fields.join(",")}`,
    );
  }
  Object.assign(ownedManifest.entry, {
    proposal_owner: SOURCE_DERIVED_OWNER,
    proposal_ownership_validated: true,
    proposal_ownership_semantic_hash: semantic.observation_content_hash,
    dependencies: partKeys,
    dependency_identities: dependencyIdentities,
  });
  for (const partKey of partKeys) {
    Object.assign(state.objects[partKey], {
      proposal_owner: SOURCE_DERIVED_OWNER,
      proposal_ownership_validated: true,
    });
  }
  return {
    owner: SOURCE_DERIVED_OWNER,
    key: manifestKey,
    body: ownedManifest.body.toString("utf8"),
    payload,
    file_entries: Array.isArray(payload.files) ? payload.files : [],
    dependencies: partKeys,
    dependency_identities: dependencyIdentities,
    content_facts: contentFacts,
    semantic,
  };
}

function parsedManifest(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function nonOperationalManifest(payload) {
  const result = structuredClone(payload);
  for (const field of ["run_id", "backed_up_at_utc", "writer_git_sha", "manifest_hash"]) {
    delete result[field];
  }
  return result;
}

function normalizedDependencyIdentities(proposal) {
  const dependencies = [...new Set((proposal?.dependencies || []).map(String))].sort();
  return dependencies.map((key) => {
    const identity = proposal?.dependency_identities?.[key] || {};
    return {
      key,
      sha256: String(identity.sha256 || ""),
      bytes: Number(identity.bytes),
      source: String(identity.source || ""),
    };
  });
}

export function compareProposalCollision(existing, candidate) {
  const existingPayload = parsedManifest(existing?.proposed_body);
  const candidatePayload = parsedManifest(candidate?.proposed_body);
  const differingFields = !existingPayload || !candidatePayload
    ? ["manifest_json"]
    : differingContentFields(
      nonOperationalManifest(existingPayload),
      nonOperationalManifest(candidatePayload),
    );
  if (JSON.stringify(normalizedDependencyIdentities(existing))
    !== JSON.stringify(normalizedDependencyIdentities(candidate))) {
    const existingIdentities = new Map(normalizedDependencyIdentities(existing)
      .map((identity) => [identity.key, identity]));
    const candidateIdentities = new Map(normalizedDependencyIdentities(candidate)
      .map((identity) => [identity.key, identity]));
    for (const key of [...new Set([...existingIdentities.keys(), ...candidateIdentities.keys()])].sort()) {
      const left = existingIdentities.get(key);
      const right = candidateIdentities.get(key);
      if (!left || !right) differingFields.push(`dependency_identities.${key}`);
      else {
        for (const field of ["sha256", "bytes", "source"]) {
          if (!sameJson(left[field], right[field])) {
            differingFields.push(`dependency_identities.${key}.${field}`);
          }
        }
      }
    }
  }
  return {
    identical: differingFields.length === 0,
    differing_fields: [...new Set(differingFields)],
  };
}

export { SOURCE_DERIVED_OWNER };
