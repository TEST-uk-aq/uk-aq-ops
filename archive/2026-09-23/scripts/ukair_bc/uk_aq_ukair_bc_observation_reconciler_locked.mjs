#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import {
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  runDisconnectedSelectedScopeReconciliationObservationHistoryV3Writer,
} from "../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
  buildObservationHistoryV3SteadyStatePartition,
} from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  encodeObservationHistoryIndexV3Json,
} from "../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  r2GetObject,
  r2HeadObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  withHistoryWriterClient,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  normalizeCanonicalObservationRow,
} from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  sha256Hex,
} from "./uk_air_black_carbon_source.mjs";

const LOCK_OWNER = "ukair_bc_observation_reconciler";
const MAX_WRITER_DAYS_PER_BATCH = 31;

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseLockedArgs(argv) {
  const args = { planPath: "", expectedPlanSha256: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--plan") args.planPath = path.resolve(requireValue(argv, index++, flag));
    else if (flag === "--expected-plan-sha256") {
      args.expectedPlanSha256 = requireValue(argv, index++, flag).toLowerCase();
    } else throw new Error(`Unknown locked reconciler argument: ${flag}`);
  }
  if (!args.planPath) throw new Error("--plan is required");
  if (!/^[0-9a-f]{64}$/.test(args.expectedPlanSha256)) {
    throw new Error("--expected-plan-sha256 must be lowercase SHA-256");
  }
  return Object.freeze(args);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

async function loadProtectedPlan(args) {
  const bytes = await fs.readFile(args.planPath);
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== args.expectedPlanSha256) {
    throw new Error(
      `Protected plan SHA-256 changed: expected=${args.expectedPlanSha256} actual=${actualSha256}`,
    );
  }
  let plan;
  try {
    plan = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Protected plan is not valid JSON", { cause: error });
  }
  if (
    plan?.schema_version !== 1 ||
    plan?.kind !== "uk_aq_ukair_bc_observation_reconciliation_plan" ||
    plan?.environment !== "TEST" ||
    !String(plan?.run_id || "").trim() ||
    !/^[0-9a-f]{40}$/.test(String(plan?.target_writer_git_sha || "")) ||
    !Array.isArray(plan?.source_evidence) ||
    !Array.isArray(plan?.partitions) ||
    !Array.isArray(plan?.removed_scopes) ||
    !plan?.selected_timeseries_ids_by_property ||
    !String(plan?.report_path || "").trim()
  ) {
    throw new Error("Protected plan identity or structure is invalid");
  }
  return Object.freeze({ plan, planSha256: actualSha256 });
}

async function verifyPinnedSourceEvidence(plan) {
  const verified = [];
  for (const evidence of plan.source_evidence) {
    if (
      evidence?.status !== "pinned" ||
      !String(evidence?.pinned_path || "").trim() ||
      !/^[0-9a-f]{64}$/.test(String(evidence?.sha256 || "")) ||
      !Number.isSafeInteger(Number(evidence?.downloaded_byte_size)) ||
      Number(evidence.downloaded_byte_size) < 0
    ) {
      throw new Error("Protected plan contains invalid pinned source evidence");
    }
    const bytes = await fs.readFile(evidence.pinned_path);
    if (
      bytes.byteLength !== Number(evidence.downloaded_byte_size) ||
      sha256Hex(bytes) !== evidence.sha256
    ) {
      throw new Error(`Pinned source identity changed: ${evidence.pinned_path}`);
    }
    verified.push(Object.freeze({
      source_url: evidence.source_url,
      sha256: evidence.sha256,
      downloaded_byte_size: bytes.byteLength,
    }));
  }
  return Object.freeze(verified);
}

function parseManifestObject(object, key, expected) {
  if (!object || object.exists === false || object.body === undefined) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(object.body).toString("utf8"));
  } catch {
    throw new Error(`Canonical manifest is invalid JSON: ${key}`);
  }
  validateCanonicalHistoryV2Manifest(payload, {
    history_version: "v2",
    domain: "observations",
    manifest_key: key,
    ...expected,
  });
  return payload;
}

async function optionalR2Object(r2, key) {
  const head = await r2HeadObject({ r2, key });
  if (!head?.exists) return null;
  return await r2GetObject({ r2, key });
}

async function loadExactLatest({ r2, generation }) {
  const key = generation.observations_timeseries_latest_key;
  const object = await optionalR2Object(r2, key);
  if (object === null) throw new Error(`Canonical exact-v3 latest authority is missing: ${key}`);
  const body = Buffer.from(object.body);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`Canonical exact-v3 latest authority is invalid JSON: ${key}`);
  }
  if (
    payload?.kind !== "observation_timeseries_latest_global" ||
    payload?.history_version !== "v2" ||
    payload?.index_generation !== "v3" ||
    payload?.domain !== "observations" ||
    body.toString("utf8") !== encodeObservationHistoryIndexV3Json(payload)
  ) {
    throw new Error(`Canonical exact-v3 latest authority is contradictory: ${key}`);
  }
  const roots = (Array.isArray(payload.day_summaries) ? payload.day_summaries : [])
    .flatMap((day) => Array.isArray(day?.scoped_roots) ? day.scoped_roots : []);
  const byIdentity = new Map();
  for (const root of roots) {
    const identity = `${root?.day_utc}\u0000${root?.connector_id}\u0000${root?.pollutant_code}`;
    if (byIdentity.has(identity)) {
      throw new Error(`Canonical exact-v3 latest authority duplicates scope ${identity}`);
    }
    byIdentity.set(identity, root);
  }
  return Object.freeze({ payload, byIdentity });
}

async function exactScopeMatches({
  r2,
  latest,
  scope,
  expectedScopedManifest = null,
  expectedPublicationObjects = [],
}) {
  const identity = `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
  const root = latest.byIdentity.get(identity) || null;
  if (expectedScopedManifest === null) return root === null;
  if (
    !root || root.key !== expectedScopedManifest.key ||
    Number(root.byte_size) !== expectedScopedManifest.byte_size ||
    root.sha256 !== expectedScopedManifest.sha256
  ) {
    return false;
  }
  const object = await optionalR2Object(r2, expectedScopedManifest.key);
  if (object === null) return false;
  const body = Buffer.from(object.body);
  if (
    body.byteLength !== expectedScopedManifest.byte_size ||
    sha256Hex(body) !== expectedScopedManifest.sha256
  ) {
    return false;
  }
  for (const artifact of expectedPublicationObjects) {
    const head = await r2HeadObject({ r2, key: artifact.key });
    if (
      !head?.exists || Number(head.bytes ?? head.size) !== artifact.byte_size ||
      head.sha256 !== artifact.sha256
    ) {
      return false;
    }
  }
  return true;
}

function comparablePhysicalScope(manifest) {
  return {
    history_schema_version: manifest.history_schema_version,
    columns: manifest.columns,
    writer_version: manifest.writer_version,
    source_row_count: manifest.source_row_count,
    row_count: manifest.row_count,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    files: manifest.files,
    observation_content_hash: manifest.observation_content_hash,
    observation_content_hash_algorithm: manifest.observation_content_hash_algorithm,
    observation_content_hash_contract_version:
      manifest.observation_content_hash_contract_version,
    observation_content_hash_row_count:
      manifest.observation_content_hash_row_count,
    observation_content_hash_columns: manifest.observation_content_hash_columns,
    verification_status_counts: manifest.verification_status_counts,
  };
}

function samePhysicalScope(left, right) {
  return JSON.stringify(comparablePhysicalScope(left)) ===
    JSON.stringify(comparablePhysicalScope(right));
}

async function currentConnectorManifest({ r2, generation, scope, cache }) {
  const identity = `${scope.day_utc}\u0000${scope.connector_id}`;
  if (cache.has(identity)) return cache.get(identity);
  const key = buildHistoryV2ConnectorManifestKey(
    generation.observations_prefix,
    scope.day_utc,
    scope.connector_id,
  );
  const object = await optionalR2Object(r2, key);
  const payload = object === null ? null : parseManifestObject(object, key, {
    manifest_kind: "connector",
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
  });
  cache.set(identity, payload);
  return payload;
}

function connectorPollutantChild(connectorManifest, pollutantCode) {
  if (!connectorManifest) return null;
  const children = Array.isArray(connectorManifest.pollutant_manifests)
    ? connectorManifest.pollutant_manifests
    : [];
  const matches = children.filter((child) => child?.pollutant_code === pollutantCode);
  if (matches.length > 1) {
    throw new Error(`Canonical connector manifest has duplicate ${pollutantCode} children`);
  }
  return matches[0] || null;
}

export function mergeSelectedTimeseriesRows({
  currentRows,
  desiredRows,
  selectedTimeseriesIds,
}) {
  if (!Array.isArray(currentRows) || !Array.isArray(desiredRows)) {
    throw new TypeError("Selected-timeseries reconciliation rows must be arrays");
  }
  const selected = new Set(Array.from(selectedTimeseriesIds || [], Number));
  if (
    selected.size === 0 ||
    [...selected].some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("Selected-timeseries reconciliation requires positive timeseries IDs");
  }
  const finalRows = [
    ...currentRows.filter((row) => !selected.has(Number(row.timeseries_id))),
    ...desiredRows,
  ].map(normalizeCanonicalObservationRow).sort((left, right) =>
    left.observed_at_utc.localeCompare(right.observed_at_utc) ||
    left.timeseries_id - right.timeseries_id
  );
  const seen = new Set();
  for (const row of finalRows) {
    const identity = `${row.timeseries_id}\u0000${row.observed_at_utc}`;
    if (seen.has(identity)) {
      throw new Error(`Final selected scope contains duplicate observation ${identity}`);
    }
    seen.add(identity);
  }
  return Object.freeze(finalRows);
}

function parquetTimestampToIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return new Date(Number(value)).toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Canonical Parquet contains an invalid observed_at_utc: ${String(value)}`);
  }
  return parsed.toISOString();
}

async function readCurrentPollutantState({
  r2,
  generation,
  scope,
  connectorCache,
  pollutantCache,
}) {
  const identity = `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
  if (pollutantCache.has(identity)) return pollutantCache.get(identity);
  const connector = await currentConnectorManifest({
    r2,
    generation,
    scope,
    cache: connectorCache,
  });
  const child = connectorPollutantChild(connector, scope.pollutant_code);
  if (!child) {
    const absent = Object.freeze({
      connector,
      child: null,
      manifest: null,
      manifest_artifact: null,
      rows: Object.freeze([]),
    });
    pollutantCache.set(identity, absent);
    return absent;
  }
  const manifestKey = buildHistoryV2PollutantManifestKey(
    generation.observations_prefix,
    scope.day_utc,
    scope.connector_id,
    scope.pollutant_code,
  );
  if (child.manifest_key !== manifestKey) {
    throw new Error(`Canonical connector child key is contradictory: ${identity}`);
  }
  const object = await optionalR2Object(r2, manifestKey);
  if (object === null) throw new Error(`Canonical pollutant manifest is missing: ${manifestKey}`);
  const manifest = parseManifestObject(object, manifestKey, {
    manifest_kind: "pollutant",
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
  });
  if (manifest.manifest_hash !== child.manifest_hash) {
    throw new Error(`Canonical connector child identity is stale: ${manifestKey}`);
  }
  const manifestBody = Buffer.from(object.body);
  const manifestArtifact = Object.freeze({
    key: manifestKey,
    byte_size: manifestBody.byteLength,
    sha256: sha256Hex(manifestBody),
    manifest_hash: manifest.manifest_hash,
    row_count: manifest.row_count,
    observation_content_hash: manifest.observation_content_hash,
  });
  const rows = [];
  for (const file of manifest.files) {
    const stored = await r2GetObject({ r2, key: file.key });
    const body = Buffer.from(stored.body);
    if (
      body.byteLength !== Number(file.bytes) ||
      !/^[0-9a-f]{64}$/.test(String(file.etag_or_hash || "")) ||
      sha256Hex(body) !== file.etag_or_hash
    ) {
      throw new Error(`Canonical Parquet identity changed: ${file.key}`);
    }
    const arrayBuffer = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    );
    const decoded = await parquetReadObjects({ file: arrayBuffer, compressors });
    for (const row of decoded) {
      const canonical = normalizeCanonicalObservationRow({
        connector_id: Number(row.connector_id),
        station_id: row.station_id === null || row.station_id === undefined
          ? null
          : Number(row.station_id),
        timeseries_id: Number(row.timeseries_id),
        pollutant_code: row.pollutant_code,
        observed_at_utc: parquetTimestampToIso(row.observed_at_utc),
        value: Number(row.value),
        verification_status: row.verification_status,
      });
      if (
        canonical.connector_id !== scope.connector_id ||
        canonical.pollutant_code !== scope.pollutant_code ||
        canonical.observed_at_utc.slice(0, 10) !== scope.day_utc
      ) {
        throw new Error(`Canonical Parquet row is outside manifest scope: ${file.key}`);
      }
      rows.push(canonical);
    }
  }
  if (rows.length !== Number(manifest.row_count)) {
    throw new Error(`Canonical pollutant row count changed: ${manifestKey}`);
  }
  rows.sort((left, right) =>
    left.observed_at_utc.localeCompare(right.observed_at_utc) ||
    left.timeseries_id - right.timeseries_id
  );
  const state = Object.freeze({
    connector,
    child,
    manifest,
    manifest_artifact: manifestArtifact,
    rows: Object.freeze(rows),
  });
  pollutantCache.set(identity, state);
  return state;
}

async function materializeCompleteSelectedScopes({ plan, r2, generation }) {
  const desiredByIdentity = new Map();
  for (const partition of plan.partitions) {
    desiredByIdentity.set(
      `${partition.scope.day_utc}\u0000${partition.scope.connector_id}\u0000${partition.scope.pollutant_code}`,
      { scope: partition.scope, rows: partition.rows },
    );
  }
  for (const scope of plan.removed_scopes) {
    const identity = `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
    if (desiredByIdentity.has(identity)) throw new Error(`Protected plan duplicates scope ${identity}`);
    desiredByIdentity.set(identity, { scope, rows: [] });
  }
  const connectorCache = new Map();
  const pollutantCache = new Map();
  const partitions = [];
  const removedScopes = [];
  for (const desired of [...desiredByIdentity.values()].sort((left, right) =>
    left.scope.day_utc.localeCompare(right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id ||
    left.scope.pollutant_code.localeCompare(right.scope.pollutant_code)
  )) {
    const selectedTimeseriesIds = plan.selected_timeseries_ids_by_property[
      desired.scope.pollutant_code
    ];
    if (!Array.isArray(selectedTimeseriesIds) || selectedTimeseriesIds.length === 0) {
      throw new Error(
        `Protected plan has no selected timeseries authority for ${desired.scope.pollutant_code}`,
      );
    }
    const current = await readCurrentPollutantState({
      r2,
      generation,
      scope: desired.scope,
      connectorCache,
      pollutantCache,
    });
    const finalRows = mergeSelectedTimeseriesRows({
      currentRows: current.rows,
      desiredRows: desired.rows,
      selectedTimeseriesIds,
    });
    if (finalRows.length) partitions.push(Object.freeze({ scope: desired.scope, rows: finalRows }));
    else removedScopes.push(desired.scope);
  }
  return Object.freeze({
    partitions: Object.freeze(partitions),
    removedScopes: Object.freeze(removedScopes),
    connectorCache,
    pollutantCache,
  });
}

async function filterChangedWriterInputs({ plan, r2, generation }) {
  const materialized = await materializeCompleteSelectedScopes({ plan, r2, generation });
  const { connectorCache, pollutantCache } = materialized;
  const exactLatest = await loadExactLatest({ r2, generation });
  const changedPartitions = [];
  const changedRemovals = [];
  const unchangedScopes = [];
  for (const partition of materialized.partitions) {
    const prepared = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation,
      rows: partition.rows,
      scope: partition.scope,
      targetWriterGitSha: plan.target_writer_git_sha,
      observationsPrefix: generation.observations_prefix,
      indexRoot: generation.observations_timeseries_index_prefix,
    });
    const currentState = await readCurrentPollutantState({
      r2,
      generation,
      scope: partition.scope,
      connectorCache,
      pollutantCache,
    });
    const canonicalUnchanged = Boolean(
      currentState.manifest &&
      samePhysicalScope(
        currentState.manifest,
        prepared.canonical_pollutant_manifest.payload,
      ),
    );
    const expectedCurrentExactHierarchy = canonicalUnchanged
      ? buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
          metadata: prepared.target_metadata,
          canonicalManifest: currentState.manifest_artifact,
          indexRoot: generation.observations_timeseries_index_prefix,
        })
      : null;
    const unchanged = canonicalUnchanged && await exactScopeMatches({
      r2,
      latest: exactLatest,
      scope: partition.scope,
      expectedScopedManifest: expectedCurrentExactHierarchy.scoped_manifest,
      expectedPublicationObjects:
        expectedCurrentExactHierarchy.publication_objects,
    });
    if (unchanged) unchangedScopes.push(Object.freeze({ ...partition.scope, status: "unchanged" }));
    else changedPartitions.push(partition);
  }
  for (const scope of materialized.removedScopes) {
    const connector = await currentConnectorManifest({
      r2,
      generation,
      scope,
      cache: connectorCache,
    });
    const canonicalPresent = Boolean(
      connectorPollutantChild(connector, scope.pollutant_code),
    );
    const exactAbsent = await exactScopeMatches({
      r2,
      latest: exactLatest,
      scope,
      expectedScopedManifest: null,
    });
    if (canonicalPresent || !exactAbsent) changedRemovals.push(scope);
    else unchangedScopes.push(Object.freeze({ ...scope, status: "already_absent" }));
  }
  return Object.freeze({
    partitions: Object.freeze(changedPartitions),
    removedScopes: Object.freeze(changedRemovals),
    unchangedScopes: Object.freeze(unchangedScopes),
  });
}

function writerBatches(filtered) {
  const days = [...new Set([
    ...filtered.partitions.map((partition) => partition.scope.day_utc),
    ...filtered.removedScopes.map((scope) => scope.day_utc),
  ])].sort();
  const batches = [];
  for (let index = 0; index < days.length; index += MAX_WRITER_DAYS_PER_BATCH) {
    const selectedDays = new Set(days.slice(index, index + MAX_WRITER_DAYS_PER_BATCH));
    batches.push(Object.freeze({
      partitions: Object.freeze(
        filtered.partitions.filter((partition) => selectedDays.has(partition.scope.day_utc)),
      ),
      removedScopes: Object.freeze(
        filtered.removedScopes.filter((scope) => selectedDays.has(scope.day_utc)),
      ),
    }));
  }
  return Object.freeze(batches);
}

function summarizeWriterResult(writerResults, filtered) {
  const results = Array.isArray(writerResults) ? writerResults : [];
  return Object.freeze({
    invoked: results.length > 0,
    status: results.length ? "writer_batches_complete" : "no_changes",
    source: "selected_scope_reconciliation",
    writer_batch_count: results.length,
    submitted_replacement_scope_count: filtered.partitions.length,
    submitted_removal_scope_count: filtered.removedScopes.length,
    unchanged_scope_count: filtered.unchangedScopes.length,
    unchanged_scope_samples: filtered.unchangedScopes.slice(0, 200),
    affected_partition_count: results.reduce(
      (sum, result) => sum + Number(result?.affected_partition_count || 0),
      0,
    ),
    affected_days_utc: [...new Set(results.flatMap((result) => result?.affected_days_utc || []))].sort(),
    removal_results: results.flatMap((result) => result?.removal_results || [])
      .map((entry) => ({
        day_utc: entry.day_utc,
        connector_id: entry.connector_id,
        pollutant_code: entry.pollutant_code,
        requested_removal: entry.requested_removal === true,
        previously_authoritative: entry.previously_authoritative === true,
        final_scope_present: entry.final_scope_present === true,
      })),
    latest_global_statuses: results.map(
      (result) => result?.v3_publication?.latest_global?.status || null,
    ),
    canonical_aggregate_authority_verified:
      results.every((result) =>
        result?.canonical_aggregate_result?.canonical_aggregate_authority_verified === true
      ),
  });
}

async function updateReport(plan, fields) {
  const reportPath = path.resolve(plan.report_path);
  let report = {};
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    // The protected report remains useful even if the pre-lock report vanished.
  }
  await writeJsonAtomic(reportPath, { ...report, ...fields });
}

export async function runProtectedBlackCarbonReconciliation({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseLockedArgs(argv);
  const { plan, planSha256 } = await loadProtectedPlan(args);
  try {
    const verifiedSources = await verifyPinnedSourceEvidence(plan);
    const configuredEnvironment = String(env.UKAQ_ENV_NAME || env.UK_AQ_ENV_NAME || "")
      .trim().toUpperCase();
    if (configuredEnvironment !== "TEST") {
      throw new Error("Protected Black Carbon reconciliation permits only TEST");
    }
    if (String(env.UK_AQ_R2_HISTORY_VERSION || "").trim() !== "v3") {
      throw new Error("Protected Black Carbon reconciliation requires UK_AQ_R2_HISTORY_VERSION=v3");
    }
    const lockDatabaseUrl = String(env.SUPABASE_DB_URL || env.DATABASE_URL || "").trim();
    if (!lockDatabaseUrl) throw new Error("SUPABASE_DB_URL (or DATABASE_URL) is required");
    const config = resolveR2HistoryIndexConfig(env);
    if (
      !config.r2.endpoint || !config.r2.bucket || !config.r2.access_key_id ||
      !config.r2.secret_access_key
    ) {
      throw new Error("Complete TEST R2 configuration is required");
    }
    if (config.r2.bucket !== "uk-aq-history-cic-test") {
      throw new Error(
        `Protected Black Carbon reconciliation requires TEST R2 bucket uk-aq-history-cic-test, got ${config.r2.bucket}`,
      );
    }
    const generation = getObservationHistoryGeneration("v3");
    const diagnostics = [];
    const result = await withHistoryWriterClient(lockDatabaseUrl, async (client) => {
      const filtered = await filterChangedWriterInputs({
        plan,
        r2: config.r2,
        generation,
      });
      const writerResults = [];
      for (const batch of writerBatches(filtered)) {
        writerResults.push(
          await runDisconnectedSelectedScopeReconciliationObservationHistoryV3Writer({
            env,
            client,
            partitions: batch.partitions,
            removedScopes: batch.removedScopes,
            targetWriterGitSha: plan.target_writer_git_sha,
            observationsPrefix: generation.observations_prefix,
            indexRoot: generation.observations_timeseries_index_prefix,
            latestKey: generation.observations_timeseries_latest_key,
            r2: config.r2,
            diagnosticEnvironment: "TEST",
            diagnostics,
            expectedObservationsGlobalOperationLockOwner: LOCK_OWNER,
            expectedObservationsGlobalOperationLockRunId: plan.run_id,
          }),
        );
      }
      return { filtered, writerResults };
    }, {
      applicationName: "uk-aq-ukair-bc-observation-reconciler",
      statementTimeoutMs: 30_000,
      queryTimeoutMs: 30_000,
      connectionTimeoutMs: 15_000,
    });
    const writer = summarizeWriterResult(result.writerResults, result.filtered);
    await updateReport(plan, {
      protected_plan_sha256: planSha256,
      pinned_source_files_reverified: verifiedSources.length,
      writer,
      non_empty_replacement_scope_count:
        writer.submitted_replacement_scope_count,
      explicit_removal_scope_count: writer.submitted_removal_scope_count,
      unchanged_no_op_scope_count: writer.unchanged_scope_count,
      r2_changed_scope_count:
        writer.submitted_replacement_scope_count + writer.submitted_removal_scope_count,
      final_status: Number(plan.blocked_scope_count || 0) > 0
        ? "completed_with_blocked_scopes"
        : "completed",
      ok: Number(plan.blocked_scope_count || 0) === 0,
      completed_at_utc: new Date().toISOString(),
    });
    return Object.freeze({ plan, writer });
  } catch (error) {
    await updateReport(plan, {
      ok: false,
      final_status: "failed_protected_r2_phase",
      completed_at_utc: new Date().toISOString(),
      failures: [
        ...(Array.isArray(plan.failures) ? plan.failures : []),
        {
          stage: "protected_r2_phase",
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    });
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runProtectedBlackCarbonReconciliation().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
