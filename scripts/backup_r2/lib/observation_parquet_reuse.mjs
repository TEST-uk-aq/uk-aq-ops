import path from "node:path";

import {
  validateCanonicalHistoryV2Manifest,
} from "../../../workers/shared/uk_aq_r2_history_manifest_validation.mjs";
import {
  classifyManifestFileIdentity,
} from "../../../workers/shared/uk_aq_r2_file_identity.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

export const DEFAULT_OBSERVATION_PARQUET_COPY_MODE = "full";
export const OBSERVATION_PARQUET_COPY_MODES = Object.freeze([
  "full",
  "reuse_matching",
]);

const OBSERVATION_PARQUET_PROOF_FALLBACK_REASONS = new Set([
  "preceding_checkpoint_day_missing",
  "preceding_checkpoint_shard_unauthenticated",
  "preceding_manifest_chain_unauthenticated",
  "current_manifest_chain_unauthenticated",
  "destination_missing",
  "destination_byte_size_mismatch",
  "unsafe_filter_path",
]);

const SAFE_FILTER_RELATIVE_PATH = /^[A-Za-z0-9._=/-]+\.parquet$/;

function normalizeKey(value, label) {
  const key = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe relative object key`);
  }
  return key;
}

function descriptorList(manifest, primary, label) {
  const primaryEntries = manifest?.[primary];
  const childEntries = manifest?.child_manifests;
  if (!Array.isArray(primaryEntries) || !Array.isArray(childEntries)) {
    throw new Error(`${label} must carry both ${primary} and child_manifests`);
  }
  const identity = (entry) => [
    String(entry?.manifest_key || ""),
    String(entry?.manifest_hash || ""),
  ].join("\u0000");
  const primaryIdentities = primaryEntries.map(identity);
  const childIdentities = childEntries.map(identity);
  if (JSON.stringify(primaryIdentities) !== JSON.stringify(childIdentities)) {
    throw new Error(`${label} has contradictory child manifest declarations`);
  }
  if (new Set(primaryIdentities).size !== primaryIdentities.length) {
    throw new Error(`${label} has duplicate child manifest declarations`);
  }
  return primaryEntries;
}

function validateReference(reference, manifest, label) {
  const key = normalizeKey(reference?.manifest_key, `${label} manifest_key`);
  if (manifest.manifest_key !== key) {
    throw new Error(`${label} manifest key does not match its parent reference`);
  }
  if (manifest.manifest_hash !== String(reference?.manifest_hash || "")) {
    throw new Error(`${label} manifest hash does not match its parent reference`);
  }
  return key;
}

function assertManifestWithinDay(key, dayPrefix, label) {
  if (!key.startsWith(`${dayPrefix}/`) || !key.endsWith("/manifest.json")) {
    throw new Error(`${label} is outside the authenticated observation day`);
  }
}

function canonicalPollutantFiles(manifest, dayPrefix, label) {
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.parquet_object_keys)) {
    throw new Error(`${label} lacks canonical Parquet declarations`);
  }
  const declaredKeys = manifest.parquet_object_keys.map((value) => (
    normalizeKey(value, `${label} parquet_object_keys entry`)
  ));
  const files = manifest.files.map((file) => {
    const key = normalizeKey(file?.key, `${label} files[].key`);
    const byteSize = Number(file?.bytes);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error(`${label} has invalid byte size for ${key}`);
    }
    const identity = classifyManifestFileIdentity(file?.etag_or_hash, {
      objectKey: key,
    });
    if (identity.type !== "sha256") {
      throw new Error(`${label} lacks canonical SHA-256 for ${key}`);
    }
    if (!key.startsWith(`${dayPrefix}/`) || !key.endsWith(".parquet")) {
      throw new Error(`${label} references Parquet outside its day: ${key}`);
    }
    return Object.freeze({
      key,
      byte_size: byteSize,
      sha256: identity.value,
    });
  });
  const fileKeys = files.map((file) => file.key);
  if (
    new Set(declaredKeys).size !== declaredKeys.length
    || new Set(fileKeys).size !== fileKeys.length
    || JSON.stringify([...declaredKeys].sort()) !== JSON.stringify([...fileKeys].sort())
  ) {
    throw new Error(`${label} has contradictory Parquet key declarations`);
  }
  return files;
}

function assertSameCanonicalFiles(actual, expected, label) {
  const identity = (file) => `${file.key}\u0000${file.byte_size}\u0000${file.sha256}`;
  const actualIdentities = actual.map(identity).sort();
  const expectedIdentities = expected.map(identity).sort();
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
    throw new Error(`${label} has contradictory aggregate Parquet evidence`);
  }
}

export function normalizeObservationParquetCopyMode(value) {
  const mode = String(value || DEFAULT_OBSERVATION_PARQUET_COPY_MODE).trim();
  if (!OBSERVATION_PARQUET_COPY_MODES.includes(mode)) {
    throw new Error(
      "--observation-parquet-copy-mode must be exactly full or reuse_matching",
    );
  }
  return mode;
}

export function snapshotPrecedingObservationMonthState(monthState) {
  if (!monthState || typeof monthState !== "object" || Array.isArray(monthState)) {
    throw new Error("Preceding observation month state must be an object");
  }
  const days = Object.freeze(
    (Array.isArray(monthState.days) ? monthState.days : [])
      .map((day) => Object.freeze({ ...day })),
  );
  return Object.freeze({ ...monthState, days });
}

export function authenticatePrecedingObservationDayState({
  monthStateText,
  monthState,
  monthStateRelativePath,
  stateMonthSummary,
  dayUtc,
}) {
  if (!monthStateText || !stateMonthSummary) {
    return { ok: false, reason: "preceding_checkpoint_day_missing" };
  }
  if (
    stateMonthSummary.state_shard_key !== monthStateRelativePath
    || !stateMonthSummary.state_shard_hash
    || sha256Hex(monthStateText) !== stateMonthSummary.state_shard_hash
    || !stateMonthSummary.processed_source_month_hash
    || !monthState.processed_source_month_hash
    || stateMonthSummary.processed_source_month_hash
      !== monthState.processed_source_month_hash
  ) {
    return { ok: false, reason: "preceding_checkpoint_shard_unauthenticated" };
  }
  const priorDay = monthState.days.find((entry) => entry.day_utc === dayUtc);
  if (!priorDay?.manifest_hash || !priorDay?.copied_at) {
    return { ok: false, reason: "preceding_checkpoint_day_missing" };
  }
  return { ok: true, prior_day: priorDay };
}

export function authenticateObservationDayParquetFiles({
  dayUtc,
  dayManifestKey,
  expectedDayManifestHash,
  dayManifest,
  readManifest,
}) {
  const dayKey = normalizeKey(dayManifestKey, "observation day manifest key");
  const dayPrefix = path.posix.dirname(dayKey);
  validateCanonicalHistoryV2Manifest(dayManifest, {
    domain: "observations",
    manifest_kind: "day",
    day_utc: dayUtc,
    manifest_key: dayKey,
  });
  if (dayManifest.manifest_hash !== expectedDayManifestHash) {
    throw new Error(`Observation day checkpoint identity mismatch: ${dayUtc}`);
  }

  const filesByKey = new Map();
  const authenticatedDayFiles = [];
  for (const connectorReference of descriptorList(
    dayManifest,
    "connector_manifests",
    `Observation day ${dayKey}`,
  )) {
    const connectorKey = normalizeKey(
      connectorReference?.manifest_key,
      "observation connector manifest key",
    );
    assertManifestWithinDay(
      connectorKey,
      dayPrefix,
      `Observation connector ${connectorKey}`,
    );
    const connectorId = Number(connectorReference?.connector_id);
    if (!Number.isInteger(connectorId)) {
      throw new Error(`Observation connector ${connectorKey} reference lacks connector_id`);
    }
    const connector = readManifest(connectorKey);
    validateCanonicalHistoryV2Manifest(connector, {
      domain: "observations",
      manifest_kind: "connector",
      day_utc: dayUtc,
      connector_id: connectorId,
      manifest_key: connectorKey,
    });
    validateReference(
      connectorReference,
      connector,
      `Observation connector ${connectorKey}`,
    );

    const authenticatedConnectorFiles = [];
    for (const pollutantReference of descriptorList(
      connector,
      "pollutant_manifests",
      `Observation connector ${connectorKey}`,
    )) {
      const pollutantKey = normalizeKey(
        pollutantReference?.manifest_key,
        "observation pollutant manifest key",
      );
      assertManifestWithinDay(
        pollutantKey,
        dayPrefix,
        `Observation pollutant ${pollutantKey}`,
      );
      const pollutantCode = String(pollutantReference?.pollutant_code || "").trim();
      if (!pollutantCode) {
        throw new Error(`Observation pollutant ${pollutantKey} reference lacks pollutant_code`);
      }
      const pollutant = readManifest(pollutantKey);
      validateCanonicalHistoryV2Manifest(pollutant, {
        domain: "observations",
        manifest_kind: "pollutant",
        day_utc: dayUtc,
        connector_id: connector.connector_id,
        pollutant_code: pollutantCode,
        manifest_key: pollutantKey,
      });
      validateReference(
        pollutantReference,
        pollutant,
        `Observation pollutant ${pollutantKey}`,
      );
      for (const file of canonicalPollutantFiles(
        pollutant,
        dayPrefix,
        `Observation pollutant ${pollutantKey}`,
      )) {
        const previous = filesByKey.get(file.key);
        if (
          previous
          && (
            previous.byte_size !== file.byte_size
            || previous.sha256 !== file.sha256
          )
        ) {
          throw new Error(`Contradictory canonical Parquet identity: ${file.key}`);
        }
        if (previous) {
          throw new Error(`Duplicate canonical Parquet reference: ${file.key}`);
        }
        filesByKey.set(file.key, file);
        authenticatedConnectorFiles.push(file);
        authenticatedDayFiles.push(file);
      }
    }
    assertSameCanonicalFiles(
      canonicalPollutantFiles(
        connector,
        dayPrefix,
        `Observation connector ${connectorKey}`,
      ),
      authenticatedConnectorFiles,
      `Observation connector ${connectorKey}`,
    );
  }
  assertSameCanonicalFiles(
    canonicalPollutantFiles(
      dayManifest,
      dayPrefix,
      `Observation day ${dayKey}`,
    ),
    authenticatedDayFiles,
    `Observation day ${dayKey}`,
  );
  return Object.freeze(
    Array.from(filesByKey.values()).sort((left, right) => left.key.localeCompare(right.key)),
  );
}

export function observationParquetFilterRelativePath(key, dayRelativePath) {
  const normalizedKey = normalizeKey(key, "observation Parquet key");
  const normalizedDay = normalizeKey(dayRelativePath, "observation day path");
  if (!normalizedKey.startsWith(`${normalizedDay}/`)) return null;
  const relative = normalizedKey.slice(normalizedDay.length + 1);
  if (!SAFE_FILTER_RELATIVE_PATH.test(relative)) return null;
  return relative;
}

function destinationEntryFor(destinationFiles, key) {
  if (destinationFiles instanceof Map) return destinationFiles.get(key) || null;
  return destinationFiles?.[key] || null;
}

export function planObservationParquetReuse({
  dayRelativePath,
  currentFiles,
  previousFiles,
  destinationFiles,
  baselineFailureReason = null,
}) {
  const priorByKey = new Map((previousFiles || []).map((file) => [file.key, file]));
  const reusable = [];
  const copyRequired = [];
  const fallbackReasons = {};
  let fallbackCount = 0;
  const recordCopyRequired = (file, reason) => {
    const isFallback = OBSERVATION_PARQUET_PROOF_FALLBACK_REASONS.has(reason);
    copyRequired.push({
      ...file,
      copy_reason: reason,
      ...(isFallback ? { fallback_reason: reason } : {}),
    });
    if (!isFallback) return;
    fallbackCount += 1;
    fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
  };

  for (const file of currentFiles || []) {
    if (baselineFailureReason) {
      recordCopyRequired(file, baselineFailureReason);
      continue;
    }
    const prior = priorByKey.get(file.key);
    if (!prior) {
      recordCopyRequired(file, "prior_key_missing");
      continue;
    }
    if (prior.sha256 !== file.sha256) {
      recordCopyRequired(file, "canonical_sha256_mismatch");
      continue;
    }
    if (prior.byte_size !== file.byte_size) {
      recordCopyRequired(file, "canonical_byte_size_mismatch");
      continue;
    }
    const relative = observationParquetFilterRelativePath(file.key, dayRelativePath);
    if (!relative) {
      recordCopyRequired(file, "unsafe_filter_path");
      continue;
    }
    const destination = destinationEntryFor(destinationFiles, file.key);
    if (!destination) {
      recordCopyRequired(file, "destination_missing");
      continue;
    }
    if (Number(destination.size) !== file.byte_size) {
      recordCopyRequired(file, "destination_byte_size_mismatch");
      continue;
    }
    reusable.push({ ...file, filter_relative_path: relative });
  }

  return Object.freeze({
    reusable: Object.freeze(reusable),
    copy_required: Object.freeze(copyRequired),
    reused_count: reusable.length,
    reused_bytes: reusable.reduce((sum, file) => sum + file.byte_size, 0),
    copy_required_count: copyRequired.length,
    copy_required_bytes: copyRequired.reduce((sum, file) => sum + file.byte_size, 0),
    fallback_count: fallbackCount,
    fallback_reasons: Object.freeze({ ...fallbackReasons }),
  });
}

export function buildObservationParquetExcludePatterns(reusableFiles) {
  return (reusableFiles || []).map((file) => {
    const relative = String(file?.filter_relative_path || "");
    if (!SAFE_FILTER_RELATIVE_PATH.test(relative)) {
      throw new Error(`Unsafe observation Parquet exclusion path: ${relative}`);
    }
    return `/${relative}`;
  });
}
