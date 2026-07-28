import { createHash } from "node:crypto";
import {
  encodeCanonicalObservationRow,
  normalizeCanonicalObservationRow,
} from "./uk_aq_observation_content_hash.mjs";

export const PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_CONTRACT_VERSION = 1;
export const PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_PREFIX =
  "uk-aq-prune-connector-source-content-hash:v1\n";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function normalizePruneConnectorSourceRow(row) {
  const observedAt = row?.observed_at_utc ?? row?.observed_at;
  return normalizeCanonicalObservationRow({
    connector_id: Number(row?.connector_id),
    station_id: row?.station_id === null || row?.station_id === undefined
      ? null
      : Number(row.station_id),
    timeseries_id: Number(row?.timeseries_id),
    pollutant_code: String(row?.pollutant_code ?? ""),
    observed_at_utc: observedAt instanceof Date
      ? observedAt.toISOString()
      : new Date(String(observedAt || "")).toISOString(),
    value: typeof row?.value === "number" ? row.value : Number(row?.value),
    verification_status: Object.hasOwn(row || {}, "verification_status")
      ? row.verification_status
      : row?.status ?? null,
  });
}

export function computePruneConnectorSourceIdentity(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError("Prune deletion evidence requires non-empty canonical connector-day rows");
  }
  const encodedRows = rows
    .map(normalizePruneConnectorSourceRow)
    .map(encodeCanonicalObservationRow)
    .sort();
  const hash = createHash("sha256");
  hash.update(PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_PREFIX, "utf8");
  for (const encodedRow of encodedRows) {
    hash.update(encodedRow, "utf8");
    hash.update("\n", "utf8");
  }
  return Object.freeze({
    source_content_hash: hash.digest("hex"),
    source_content_hash_contract_version:
      PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_CONTRACT_VERSION,
    source_content_hash_row_count: encodedRows.length,
  });
}

export function normalizePruneConnectorSourceIdentity(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("source_identity_missing");
  }
  const sourceContentHash = evidence.source_content_hash;
  const contractVersion = Number(evidence.source_content_hash_contract_version);
  const rowCount = Number(evidence.source_content_hash_row_count);
  if (
    typeof sourceContentHash !== "string"
    || !SHA256_PATTERN.test(sourceContentHash)
    || !Number.isSafeInteger(rowCount)
    || rowCount <= 0
  ) {
    throw new TypeError("source_identity_missing");
  }
  if (
    !Number.isSafeInteger(contractVersion)
    || contractVersion !== PRUNE_CONNECTOR_SOURCE_CONTENT_HASH_CONTRACT_VERSION
  ) {
    throw new TypeError("source_identity_contract_unsupported");
  }
  return Object.freeze({
    source_content_hash: sourceContentHash,
    source_content_hash_contract_version: contractVersion,
    source_content_hash_row_count: rowCount,
  });
}

export function comparePruneConnectorSourceIdentities(leftInput, rightInput) {
  const left = normalizePruneConnectorSourceIdentity(leftInput);
  const right = normalizePruneConnectorSourceIdentity(rightInput);
  if (left.source_content_hash_row_count !== right.source_content_hash_row_count) {
    return { match: false, failure_reason: "source_identity_row_count_mismatch" };
  }
  if (left.source_content_hash !== right.source_content_hash) {
    return { match: false, failure_reason: "source_identity_mismatch" };
  }
  return { match: true, failure_reason: null };
}

export function pruneConnectorSourceIdentityFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message === "source_identity_contract_unsupported") return message;
  if (message === "source_identity_missing") return message;
  return "source_identity_canonicalisation_failed";
}
