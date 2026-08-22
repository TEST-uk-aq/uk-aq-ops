// Disconnected post-cutover-only adapters for the validated Integrity apply graph.
import {
  loadImmutableSourcePartition,
  readCanonicalObservationRows,
  validateDedicatedSosHistoricalProposal,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  runDisconnectedIntegrityObservationHistoryV3Writer,
  runDisconnectedSosHistoricalReplacementObservationHistoryV3Writer,
  runDisconnectedSupportedBackfillObservationHistoryV3Writer,
} from "../../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  validateCanonicalHistoryV2Manifest,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";

const POLLUTANT_MANIFEST_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/;

function assertValidatedApplyRepresentation({ runState, validatedProposal }) {
  if (!runState || typeof runState !== "object") {
    throw new TypeError("Integrity v3 apply requires the validated run state");
  }
  if (
    !validatedProposal ||
    !Array.isArray(validatedProposal.objects) ||
    !Array.isArray(validatedProposal.prefixes)
  ) {
    throw new TypeError("Integrity v3 apply requires validateLocalProposal() output");
  }
  const audit = runState.final_proposal_graph_validation;
  if (
    audit?.status !== "succeeded" ||
    audit?.parent_and_index_dependencies_validated !== true ||
    audit?.tombstones_validated !== true ||
    !Array.isArray(audit.partitions) ||
    audit.validated_partition_count !== audit.partitions.length ||
    audit.partitions.some((partition) => partition?.status !== "validated")
  ) {
    throw new Error(
      "Integrity v3 apply requires a successful immutable final proposal-graph validation",
    );
  }
  return audit;
}

function proposalObjectsByKey(validatedProposal) {
  const byKey = new Map();
  for (const object of validatedProposal.objects) {
    const key = String(object?.key || "").trim();
    if (!key || byKey.has(key)) {
      throw new Error(`Validated Integrity proposal has a duplicate/invalid key: ${key}`);
    }
    byKey.set(key, object);
  }
  return byKey;
}

function parsePollutantManifest(object, scope) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(object.body).toString("utf8"));
  } catch {
    throw new Error(`Validated Integrity pollutant manifest is invalid JSON: ${object.key}`);
  }
  validateCanonicalHistoryV2Manifest(payload, {
    history_version: "v2",
    domain: "observations",
    manifest_kind: "pollutant",
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    manifest_key: object.key,
  });
  return payload;
}

function scopeFromManifestKey(key) {
  const match = String(key || "").match(POLLUTANT_MANIFEST_PATTERN);
  if (!match) throw new Error(`Invalid observation pollutant manifest key: ${key}`);
  return Object.freeze({
    day_utc: match[1],
    connector_id: Number(match[2]),
    pollutant_code: match[3],
  });
}

function assertUniquePartitionScopes(partitions) {
  const identities = new Set();
  for (const partition of partitions) {
    const identity = [
      partition.scope.day_utc,
      partition.scope.connector_id,
      partition.scope.pollutant_code,
    ].join("/");
    if (identities.has(identity)) {
      throw new Error(`Integrity v3 apply contains a duplicate partition: ${identity}`);
    }
    identities.add(identity);
  }
  return Object.freeze(partitions.sort((left, right) =>
    left.scope.day_utc.localeCompare(right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id ||
    left.scope.pollutant_code.localeCompare(right.scope.pollutant_code)
  ));
}

function buildSelectedIntegrityPartitions({ runState, validatedProposal, audit }) {
  const objects = proposalObjectsByKey(validatedProposal);
  const partitions = audit.partitions.map((entry) => {
    const scope = scopeFromManifestKey(entry.manifest_key);
    const manifestObject = objects.get(entry.manifest_key);
    if (!manifestObject?.entry?.final_proposal_graph_validated) {
      throw new Error(
        `Integrity v3 apply partition lost final validation: ${entry.manifest_key}`,
      );
    }
    const manifest = parsePollutantManifest(manifestObject, scope);
    const source = loadImmutableSourcePartition({
      runState,
      dayUtc: scope.day_utc,
      connectorId: scope.connector_id,
      pollutantCode: scope.pollutant_code,
    });
    if (
      source.metadata.observation_content_hash !== entry.source_content_hash ||
      source.rows.length !== Number(entry.row_count)
    ) {
      throw new Error(
        `Integrity v3 immutable source identity changed after validation: ${entry.manifest_key}`,
      );
    }
    return {
      scope,
      rows: source.rows,
      backed_up_at_utc: manifest.backed_up_at_utc ?? null,
    };
  });
  return assertUniquePartitionScopes(partitions);
}

async function buildCompleteSosPartitions({ runState, validatedProposal }) {
  const dedicated = validateDedicatedSosHistoricalProposal({
    runState,
    proposal: validatedProposal,
  });
  if (dedicated.dedicated !== true) {
    throw new Error("SOS v3 apply requires the validated SOS-light execution path");
  }
  const selectedDays = new Set(dedicated.selected_days);
  const objects = proposalObjectsByKey(validatedProposal);
  const manifestObjects = validatedProposal.objects.filter((object) => {
    const match = String(object.key || "").match(POLLUTANT_MANIFEST_PATTERN);
    return match && selectedDays.has(match[1]);
  });
  const partitions = [];
  for (const manifestObject of manifestObjects) {
    const scope = scopeFromManifestKey(manifestObject.key);
    const manifest = parsePollutantManifest(manifestObject, scope);
    const partKeys = Array.isArray(manifest.parquet_object_keys)
      ? manifest.parquet_object_keys.map(String)
      : [];
    const rows = [];
    for (const key of partKeys) {
      const part = objects.get(key);
      if (!part || !key.endsWith(".parquet")) {
        throw new Error(`SOS complete-day proposal is missing Parquet: ${key}`);
      }
      const decoded = await readCanonicalObservationRows({
        body: part.body,
        connectorId: scope.connector_id,
      });
      if (decoded.some((row) =>
        row.connector_id !== scope.connector_id ||
        row.pollutant_code !== scope.pollutant_code ||
        row.observed_at_utc.slice(0, 10) !== scope.day_utc
      )) {
        throw new Error(`SOS complete-day Parquet scope disagrees: ${key}`);
      }
      rows.push(...decoded);
    }
    if (rows.length !== Number(manifest.row_count)) {
      throw new Error(
        `SOS complete-day row count disagrees: ${manifestObject.key}`,
      );
    }
    partitions.push({
      scope,
      rows,
      backed_up_at_utc: manifest.backed_up_at_utc ?? null,
    });
  }
  if (!partitions.length) {
    throw new Error("SOS complete-day proposal has no canonical pollutant partitions");
  }
  const representedDays = new Set(partitions.map((partition) => partition.scope.day_utc));
  if (
    representedDays.size !== selectedDays.size ||
    [...selectedDays].some((day) => !representedDays.has(day))
  ) {
    throw new Error("SOS complete-day proposal does not represent every selected day");
  }
  return Object.freeze({
    dedicated,
    partitions: assertUniquePartitionScopes(partitions),
  });
}

export function buildValidatedIntegrityObservationHistoryV3Partitions({
  runState,
  validatedProposal,
}) {
  const audit = assertValidatedApplyRepresentation({ runState, validatedProposal });
  if (runState.execution_path === "sos_light") {
    throw new Error("SOS-light must use the complete-day v3 adapter");
  }
  return buildSelectedIntegrityPartitions({ runState, validatedProposal, audit });
}

export async function buildValidatedSosObservationHistoryV3Partitions({
  runState,
  validatedProposal,
}) {
  assertValidatedApplyRepresentation({ runState, validatedProposal });
  return await buildCompleteSosPartitions({ runState, validatedProposal });
}

export async function runValidatedIntegrityObservationHistoryV3Writer({
  runState,
  validatedProposal,
  ...options
}) {
  const partitions = buildValidatedIntegrityObservationHistoryV3Partitions({
    runState,
    validatedProposal,
  });
  return await runDisconnectedIntegrityObservationHistoryV3Writer({
    ...options,
    partitions,
  });
}

export async function runValidatedSupportedBackfillObservationHistoryV3Writer({
  runState,
  validatedProposal,
  ...options
}) {
  const partitions = buildValidatedIntegrityObservationHistoryV3Partitions({
    runState,
    validatedProposal,
  });
  return await runDisconnectedSupportedBackfillObservationHistoryV3Writer({
    ...options,
    partitions,
  });
}

export async function runValidatedSosHistoricalReplacementObservationHistoryV3Writer({
  runState,
  validatedProposal,
  prepareCompleteDayReplacement,
  ...options
}) {
  if (typeof prepareCompleteDayReplacement !== "function") {
    throw new TypeError("SOS v3 apply requires complete-day deletion verification");
  }
  const prepared = await buildValidatedSosObservationHistoryV3Partitions({
    runState,
    validatedProposal,
  });
  return await runDisconnectedSosHistoricalReplacementObservationHistoryV3Writer({
    ...options,
    partitions: prepared.partitions,
    prepareCompleteDayReplacement,
  });
}
