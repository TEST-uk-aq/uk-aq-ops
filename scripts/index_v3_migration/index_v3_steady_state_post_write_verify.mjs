#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
  encodeObservationHistoryIndexV3Json,
} from "../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { validateObservationHistoryV3ChildForRead } from "../../workers/shared/uk_aq_observation_history_reader_v3.mjs";
import { validateObservationHistoryIndexV3ScopedManifestBody } from "../../workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION } from "../../workers/shared/uk_aq_observation_history_target_writer.mjs";
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 } from "../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import { computePruneConnectorSourceIdentity } from "../../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import {
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { r2GetObject, r2HeadObject } from "../../workers/shared/r2_sigv4.mjs";
import {
  buildObservationHistoryV3RecoveryReplayStateSha256,
  buildObservationHistoryV3RerunVerificationPlan,
} from "../backup_r2/lib/observation_history_migration_v3.mjs";
import { readAndValidateRecoveryJournal } from "./recovery_journal_authority.mjs";
import { CONTROLLED_PHASE_B_SOURCE_TABLES } from "./index_v3_controlled_phase_b_source_freeze.mjs";

export const STEADY_STATE_POST_WRITE_VERIFIER_VERSION = 1;
export const STEADY_STATE_BASELINE_KIND =
  "authenticated_completed_migration_recovery_journal";
export const FINAL_SUCCESS = Object.freeze([
  "STEADY-STATE POST-WRITE VERIFY PASS",
  "ELIGIBLE FOR FIRST LOCKED POST-v3 DROPBOX BACKUP.",
  "MAINTENANCE AND WRITER FREEZE REMAIN REQUIRED.",
]);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const READ_ONLY_SQL_PATTERN = /^\s*(?:select|with)\b/i;
const MUTATING_SQL_PATTERN = /\b(?:insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|copy|call|do)\b/i;

function fail(message) {
  const error = new Error(message);
  error.code = "UK_AQ_INDEX_V3_STEADY_STATE_VERIFY_FAILED";
  throw error;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactBuffer(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail(`${label} body is unavailable`);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactDay(value, label) {
  const day = String(value || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (
    !DAY_PATTERN.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    fail(`${label} must be an exact UTC YYYY-MM-DD identity`);
  }
  return day;
}

function exactPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} must be a positive integer`);
  return number;
}

function exactSha256(value, label) {
  const normalized = String(value || "").trim();
  if (!SHA256_PATTERN.test(normalized)) fail(`${label} must be lower-case SHA-256`);
  return normalized;
}

function exactGitSha(value, label) {
  const normalized = String(value || "").trim();
  if (!GIT_SHA_PATTERN.test(normalized)) fail(`${label} must be a 40-character Git SHA`);
  return normalized;
}

function sameSorted(left, right) {
  const a = [...left].map(String).sort();
  const b = [...right].map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function assertExactPollutantSet(actual, expected, label = "pollutant child set") {
  if (!Array.isArray(actual) || !Array.isArray(expected) || !sameSorted(actual, expected)) {
    fail(`${label} has a missing or extra pollutant child`);
  }
  return Object.freeze([...actual].map(String).sort());
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    fail(`${label} mismatch: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function canonicalizeLocalPath(input, label) {
  const resolved = path.resolve(String(input || ""));
  let existing = resolved;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail(`${label} has no existing canonical ancestor`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical;
  try {
    canonical = fs.realpathSync(existing);
  } catch (error) {
    fail(`${label} cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path.join(canonical, ...missing);
}

function pathIsWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function assertSafeLocalReportPath({
  reportOut,
  evidencePaths,
  checkpoint,
  recoveryRoot,
  dropboxRoot,
}) {
  const output = canonicalizeLocalPath(reportOut, "report output path");
  const protectedFiles = [...(evidencePaths || []), checkpoint]
    .map((entry) => canonicalizeLocalPath(entry, "protected evidence path"));
  if (protectedFiles.includes(output)) fail("report output path equals protected input evidence");
  const protectedDirectories = [
    canonicalizeLocalPath(recoveryRoot, "checkpoint recovery directory"),
    canonicalizeLocalPath(dropboxRoot, "Dropbox root"),
  ];
  if (protectedDirectories.some((root) => pathIsWithin(output, root))) {
    fail("report output path is inside a protected evidence directory");
  }
  return output;
}

export function validateAcceptanceReport(reportInput, expectedInput) {
  const report = plainObject(reportInput, "controlled acceptance report");
  const expected = plainObject(expectedInput, "expected acceptance identity");
  const dayUtc = exactDay(expected.day_utc, "expected day_utc");
  const connectorId = exactPositiveInteger(expected.connector_id, "expected connector_id");
  const rowCount = exactPositiveInteger(expected.source_row_count, "expected source row count");
  const expectedHash = exactSha256(expected.source_content_hash, "expected source content hash");
  const expectedGitSha = exactGitSha(expected.acceptance_git_sha, "expected acceptance Git SHA");
  const expectedPollutantCount = exactPositiveInteger(
    expected.pollutant_count,
    "expected pollutant count",
  );

  if (report.ok !== true || report.mode !== "apply") fail("controlled acceptance report is not a successful apply report");
  requireEqual(String(report.environment || "").toUpperCase(), expected.environment, "acceptance environment");
  requireEqual(report.repository_git_sha, expectedGitSha, "acceptance Git SHA");
  requireEqual(report.run_id, expected.run_id, "acceptance run_id");
  requireEqual(report.logical_history_version, "v2", "acceptance logical history version");
  requireEqual(report.observation_history_index_version, "v3", "acceptance index authority");
  requireEqual(report.rollback_data_preservation_mode, "retain_upstream_source", "acceptance rollback preservation mode");
  requireEqual(report.execution_scope, "runPhaseBBackup_only_no_full_prune_job", "acceptance execution scope");

  const candidate = plainObject(report.plan?.candidate, "acceptance planned candidate");
  requireEqual(exactDay(candidate.day_utc, "acceptance candidate day_utc"), dayUtc, "acceptance day_utc");
  requireEqual(candidate.connector_id, connectorId, "acceptance connector_id");
  requireEqual(candidate.source_row_count, rowCount, "acceptance source row count");
  const sourceIdentity = plainObject(candidate.source_identity, "acceptance source identity");
  requireEqual(sourceIdentity.source_content_hash, expectedHash, "acceptance source content hash");
  requireEqual(
    sourceIdentity.source_content_hash_contract_version,
    expected.source_content_hash_contract_version,
    "acceptance source hash contract version",
  );
  requireEqual(sourceIdentity.source_content_hash_row_count, rowCount, "acceptance source hash row count");
  const pollutants = Array.isArray(candidate.pollutant_codes) ? candidate.pollutant_codes : [];
  if (pollutants.length !== expectedPollutantCount || new Set(pollutants).size !== pollutants.length) {
    fail("acceptance complete pollutant set count is invalid or duplicated");
  }

  const completed = plainObject(report.completed_candidate, "acceptance completed candidate");
  requireEqual(completed.day_utc, dayUtc, "completed candidate day_utc");
  requireEqual(completed.connector_id, connectorId, "completed candidate connector_id");
  requireEqual(completed.written_row_count, rowCount, "completed candidate row count");
  requireEqual(completed.source_content_hash, expectedHash, "completed candidate source hash");
  const summary = plainObject(report.phase_b_summary, "acceptance Phase B summary");
  requireEqual(summary.completed_candidates, 1, "Phase B completed candidates");
  requireEqual(summary.failed_candidates, 0, "Phase B failed candidates");
  if (Array.isArray(summary.failures) && summary.failures.length !== 0) fail("Phase B summary contains failures");

  const source = plainObject(
    report.postflight?.source_preservation,
    "acceptance source-preservation evidence",
  );
  if (source.source_deletion_committed !== false) fail("acceptance report does not prove source deletion committed=false");
  requireEqual(source.source_row_count_after, rowCount, "postflight retained source row count");
  requireEqual(source.source_identity_after?.source_content_hash, expectedHash, "postflight retained source hash");
  const connectorManifest = plainObject(report.postflight?.connector_manifest, "postflight connector manifest");
  assertExactPollutantSet(
    connectorManifest.final_pollutant_codes || [],
    pollutants,
    "postflight connector pollutant set",
  );

  const freeze = plainObject(report.source_write_freeze, "acceptance source-write freeze");
  const acquiredAt = new Date(String(freeze.acquired_at_utc || ""));
  const releasedAt = new Date(String(freeze.released_at_utc || ""));
  if (
    freeze.held_during_controlled_child !== true ||
    freeze.lock_mode !== "SHARE" ||
    freeze.persistent_database_mutation !== false ||
    freeze.child_exit_code !== 0 ||
    freeze.child_timezone !== "UTC" ||
    Number.isNaN(acquiredAt.getTime()) ||
    Number.isNaN(releasedAt.getTime()) ||
    acquiredAt.toISOString() !== freeze.acquired_at_utc ||
    releasedAt.toISOString() !== freeze.released_at_utc ||
    acquiredAt > releasedAt ||
    !sameSorted(freeze.tables || [], CONTROLLED_PHASE_B_SOURCE_TABLES)
  ) {
    fail("acceptance source-write freeze was not acquired/released around a successful UTC child");
  }

  return Object.freeze({
    environment: expected.environment,
    run_id: String(expected.run_id),
    repository_git_sha: expectedGitSha,
    day_utc: dayUtc,
    connector_id: connectorId,
    source_row_count: rowCount,
    source_content_hash: expectedHash,
    source_content_hash_contract_version: Number(expected.source_content_hash_contract_version),
    pollutant_codes: Object.freeze([...pollutants].map(String).sort()),
    source_deletion_committed: false,
    source_write_freeze: Object.freeze({
      acquired_at_utc: freeze.acquired_at_utc,
      released_at_utc: freeze.released_at_utc,
      child_exit_code: 0,
      child_timezone: "UTC",
    }),
  });
}

export function assertReadOnlyAdapters(adaptersInput) {
  const adapters = plainObject(adaptersInput, "verifier adapters");
  const forbidden = /(?:put|delete|insert|update|write|mutate|dispatch|prune|backup|enable|disable)/i;
  const forbiddenNames = Object.keys(adapters).filter((name) => forbidden.test(name));
  if (forbiddenNames.length) fail(`mutation adapter is forbidden: ${forbiddenNames.join(",")}`);
  for (const required of ["query", "getObject", "headObject", "httpGet"]) {
    if (typeof adapters[required] !== "function") fail(`read-only adapter is missing: ${required}`);
  }
  return adapters;
}

export function assertReadOnlySql(sql) {
  const text = String(sql || "");
  if (!READ_ONLY_SQL_PATTERN.test(text) || MUTATING_SQL_PATTERN.test(text)) {
    fail("verifier attempted non-SELECT PostgreSQL SQL");
  }
  return text;
}

function sourceRowsSql() {
  return `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)`;
}

async function readControlState(query, accepted) {
  const params = [accepted.day_utc, accepted.connector_id];
  const candidate = await query(`
select day_utc::text, connector_id, status, run_id, manifest_key,
       history_row_count::text, history_file_count, history_total_bytes::text,
       source_content_hash, source_content_hash_contract_version,
       source_content_hash_row_count::text
from uk_aq_ops.history_candidates
where day_utc = $1::date and connector_id = $2::integer`, params);
  const gate = await query(`
select day_utc::text, connector_id, history_done, history_run_id,
       history_manifest_key, history_manifest_hash, history_row_count::text,
       history_file_count, history_total_bytes::text, source_content_hash,
       source_content_hash_contract_version, source_content_hash_row_count::text,
       completion_source
from uk_aq_ops.prune_connector_day_gates
where day_utc = $1::date and connector_id = $2::integer`, params);
  const dayGate = await query(`
select day_utc::text, history_done, history_run_id, history_manifest_key,
       history_row_count::text, history_file_count, history_total_bytes::text
from uk_aq_ops.prune_day_gates
where day_utc = $1::date`, [accepted.day_utc]);
  const peers = await query(`
select day_utc::text, connector_id, status, run_id
from uk_aq_ops.history_candidates
where day_utc = $1::date
order by connector_id`, [accepted.day_utc]);
  const start = `${accepted.day_utc}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  const sourceRows = await query(sourceRowsSql(), [accepted.connector_id, start, end]);
  return {
    candidate: candidate.rows,
    connector_gate: gate.rows,
    day_gate: dayGate.rows,
    peers: peers.rows,
    source_rows: sourceRows.rows,
  };
}

export function validateIndependentControlState(stateInput, accepted) {
  const state = plainObject(stateInput, "independent control state");
  if (state.candidate?.length !== 1) fail("independent history candidate is missing or duplicated");
  const candidate = state.candidate[0];
  if (candidate.status !== "complete") fail("independent history candidate is not complete");
  requireEqual(candidate.run_id, accepted.run_id, "candidate run identity");
  requireEqual(candidate.history_row_count, accepted.source_row_count, "candidate history row count");
  requireEqual(candidate.source_content_hash, accepted.source_content_hash, "candidate source content hash");
  requireEqual(candidate.source_content_hash_contract_version, accepted.source_content_hash_contract_version, "candidate source hash contract");
  requireEqual(candidate.source_content_hash_row_count, accepted.source_row_count, "candidate source hash row count");
  if (!candidate.manifest_key || exactPositiveInteger(candidate.history_file_count, "candidate history file count") < 1) {
    fail("candidate history manifest/file evidence is incomplete");
  }
  const expectedManifestKey = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    accepted.day_utc,
    accepted.connector_id,
  );
  requireEqual(candidate.manifest_key, expectedManifestKey, "candidate canonical connector manifest key");
  exactPositiveInteger(candidate.history_total_bytes, "candidate history total bytes");

  if (state.connector_gate?.length !== 1) fail("independent connector-day gate is missing or duplicated");
  const gate = state.connector_gate[0];
  if (gate.history_done !== true) fail("connector-day gate is not history_done=true");
  requireEqual(gate.history_run_id, accepted.run_id, "connector-day gate run identity");
  requireEqual(gate.history_manifest_key, candidate.manifest_key, "connector-day gate manifest key");
  requireEqual(gate.history_row_count, accepted.source_row_count, "connector-day gate row count");
  requireEqual(gate.history_file_count, candidate.history_file_count, "connector-day gate file count");
  requireEqual(gate.history_total_bytes, candidate.history_total_bytes, "connector-day gate total bytes");
  requireEqual(gate.source_content_hash, accepted.source_content_hash, "connector-day gate source hash");
  requireEqual(gate.source_content_hash_contract_version, accepted.source_content_hash_contract_version, "connector-day gate source hash contract");
  requireEqual(gate.source_content_hash_row_count, accepted.source_row_count, "connector-day gate source hash row count");
  exactSha256(gate.history_manifest_hash, "connector-day gate manifest hash");
  requireEqual(gate.completion_source, "prune_daily_phase_b", "connector-day gate completion source");

  const peerRows = Array.isArray(state.peers) ? state.peers : [];
  const peerPending = peerRows.filter((row) => Number(row.connector_id) !== accepted.connector_id);
  const wholeDay = Array.isArray(state.day_gate) && state.day_gate.length === 1 ? state.day_gate[0] : null;
  if (wholeDay?.history_done === true) {
    // A later safe completion is acceptable; connector acceptance never requires it.
  } else if (
    !wholeDay ||
    wholeDay.history_done !== false ||
    peerPending.length === 0 ||
    !peerPending.every((row) => row.status === "pending")
  ) {
    fail("whole-day blocked state is not explained solely by pending peer connectors");
  }

  const sourceRows = Array.isArray(state.source_rows) ? state.source_rows : [];
  requireEqual(sourceRows.length, accepted.source_row_count, "independent retained source row count");
  const sourceIdentity = computePruneConnectorSourceIdentity(sourceRows);
  requireEqual(sourceIdentity.source_content_hash, accepted.source_content_hash, "recomputed retained source hash");
  requireEqual(sourceIdentity.source_content_hash_contract_version, accepted.source_content_hash_contract_version, "recomputed source hash contract");
  requireEqual(sourceIdentity.source_content_hash_row_count, accepted.source_row_count, "recomputed source hash row count");

  return Object.freeze({
    candidate: { ...candidate },
    connector_day_gate: { ...gate },
    whole_day_gate: wholeDay ? { ...wholeDay } : null,
    pending_peer_connector_ids: peerPending.map((row) => Number(row.connector_id)).sort((a, b) => a - b),
    whole_day_blocked_due_to_pending_peers: wholeDay?.history_done === false,
    source_retention: {
      independently_recoverable: true,
      row_count: sourceRows.length,
      ...sourceIdentity,
      source_deletion_committed: false,
    },
  });
}

export function bindIndependentControlStateToCanonical(independentInput, canonicalInput) {
  const independent = plainObject(independentInput, "independent control state");
  const canonical = plainObject(canonicalInput, "canonical R2 state");
  const candidate = plainObject(independent.candidate, "independent candidate evidence");
  const gate = plainObject(independent.connector_day_gate, "independent connector gate evidence");
  const connector = plainObject(canonical.connector, "canonical connector manifest evidence");
  const parquet = plainObject(canonical.parquet, "canonical Parquet totals");
  requireEqual(gate.history_manifest_hash, connector.manifest_hash, "connector-day gate semantic manifest_hash");
  for (const [label, record] of [["candidate", candidate], ["connector-day gate", gate]]) {
    requireEqual(record.history_row_count, parquet.row_count, `${label} independently counted row total`);
    requireEqual(record.history_file_count, parquet.file_count, `${label} independently counted file total`);
    requireEqual(record.history_total_bytes, parquet.total_bytes, `${label} independently counted byte total`);
  }
  return Object.freeze({
    semantic_manifest_hash: connector.manifest_hash,
    row_count: parquet.row_count,
    file_count: parquet.file_count,
    total_bytes: parquet.total_bytes,
    candidate_exact: true,
    connector_day_gate_exact: true,
  });
}

async function getIdentity(getObject, key) {
  const object = await getObject({ key });
  const body = exactBuffer(object?.body, key);
  return Object.freeze({ key, body, byte_size: body.byteLength, sha256: sha256(body) });
}

export function classifyDependencyIdentity(actual, expected, { allowLegacy = false } = {}) {
  if (!actual || actual.exists === false) return { classification: "FAIL", reason: "missing" };
  const hasExact = Number.isSafeInteger(Number(expected?.byte_size)) &&
    Number(expected.byte_size) > 0 && SHA256_PATTERN.test(String(expected?.sha256 || ""));
  if (!hasExact) {
    return allowLegacy
      ? { classification: "LEGACY_RECOVERY_ORDERING", reason: "dependency_descriptor_lacks_exact_identity" }
      : { classification: "FAIL", reason: "dependency_descriptor_lacks_exact_identity" };
  }
  if (
    Number(actual.byte_size ?? actual.bytes) !== Number(expected.byte_size) ||
    String(actual.sha256 || "") !== String(expected.sha256)
  ) {
    return { classification: "FAIL", reason: "exact_identity_mismatch" };
  }
  return { classification: "EXACT", reason: null };
}

export function summarizeDependencyReconciliation(entriesInput, environment) {
  const entries = Array.isArray(entriesInput) ? entriesInput : [];
  const counts = {
    total: entries.length,
    EXACT: entries.filter((entry) => entry.classification === "EXACT").length,
    LEGACY_RECOVERY_ORDERING: entries.filter((entry) => entry.classification === "LEGACY_RECOVERY_ORDERING").length,
    FAIL: entries.filter((entry) => entry.classification === "FAIL").length,
  };
  if (counts.FAIL !== 0) fail(`v3 dependency reconciliation has FAIL=${counts.FAIL}`);
  if (counts.LEGACY_RECOVERY_ORDERING !== 0) {
    fail(`new ${String(environment).toUpperCase()} steady-state scope rejects LEGACY_RECOVERY_ORDERING=${counts.LEGACY_RECOVERY_ORDERING}`);
  }
  return Object.freeze({ counts: Object.freeze(counts), entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) });
}

async function reconcileJsonDependency(getObject, descriptor, kind, entries, { allowLegacy = false } = {}) {
  let actual;
  try {
    actual = await getIdentity(getObject, descriptor.key);
  } catch (error) {
    entries.push({ kind, key: descriptor.key, classification: "FAIL", reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const result = classifyDependencyIdentity(actual, descriptor, { allowLegacy });
  entries.push({ kind, key: descriptor.key, ...result, byte_size: actual.byte_size, sha256: actual.sha256 });
  return result.classification === "FAIL" ? null : actual;
}

async function reconcileParquetDependency(headObject, descriptor, kind, entries) {
  let head;
  try {
    head = await headObject({ key: descriptor.key });
  } catch (error) {
    entries.push({ kind, key: descriptor.key, classification: "FAIL", reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const actual = {
    exists: head?.exists !== false,
    byte_size: Number(head?.bytes),
    sha256: String(head?.sha256 || ""),
  };
  const result = classifyDependencyIdentity(actual, descriptor);
  entries.push({ kind, key: descriptor.key, ...result, byte_size: actual.byte_size, sha256: actual.sha256 || null });
  return result.classification === "EXACT" ? actual : null;
}

function assertPhysicalManifest(manifest, label) {
  if (
    Number(manifest.history_schema_version) !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    manifest.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    JSON.stringify(manifest.columns) !== JSON.stringify(OBSERVATION_HISTORY_COLUMNS_V3)
  ) {
    fail(`${label} does not declare the accepted observation physical schema v3`);
  }
}

function assertChildWriterLimits(child, label) {
  const limits = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3;
  for (const file of child.files) {
    if (
      file.row_count > limits.max_file_rows ||
      file.byte_size > limits.max_file_bytes ||
      file.row_group_count > limits.max_row_groups_per_file
    ) {
      fail(`${label} exceeds an accepted file or row-group-count limit`);
    }
  }
  const groups = new Map();
  for (const timeseries of child.timeseries) {
    for (const segment of timeseries.segments) {
      const key = `${segment.file_key}\u0000${segment.row_group_ordinal}`;
      const start = segment.row_start - segment.row_group_row_start;
      const end = segment.row_start + segment.row_count;
      const current = groups.get(key) || { start, end };
      current.start = Math.min(current.start, start);
      current.end = Math.max(current.end, end);
      groups.set(key, current);
    }
  }
  for (const group of groups.values()) {
    if (group.end - group.start > limits.max_row_group_rows) {
      fail(`${label} exceeds max_row_group_rows`);
    }
  }
}

export async function verifyCanonicalHierarchy({ getObject, headObject, accepted, candidateManifestKey }) {
  const connectorObject = await getIdentity(getObject, candidateManifestKey);
  const connector = JSON.parse(connectorObject.body.toString("utf8"));
  validateCanonicalHistoryV2Manifest(connector, {
    history_version: "v2",
    domain: "observations",
    manifest_kind: "connector",
    day_utc: accepted.day_utc,
    connector_id: accepted.connector_id,
    manifest_key: candidateManifestKey,
  });
  assertPhysicalManifest(connector, "connector manifest");
  requireEqual(connector.source_row_count, accepted.source_row_count, "connector manifest row count");
  const refs = Array.isArray(connector.pollutant_manifests) ? connector.pollutant_manifests : [];
  const codes = refs.map((entry) => String(entry.pollutant_code));
  assertExactPollutantSet(codes, accepted.pollutant_codes, "connector manifest pollutant set");

  const pollutants = [];
  const parquetKeys = new Set();
  let parquetRows = 0;
  let parquetBytes = 0;
  for (const ref of refs) {
    const object = await getIdentity(getObject, ref.manifest_key);
    const manifest = JSON.parse(object.body.toString("utf8"));
    validateCanonicalHistoryV2Manifest(manifest, {
      history_version: "v2",
      domain: "observations",
      manifest_kind: "pollutant",
      day_utc: accepted.day_utc,
      connector_id: accepted.connector_id,
      pollutant_code: ref.pollutant_code,
      manifest_key: ref.manifest_key,
    });
    assertPhysicalManifest(manifest, `pollutant manifest ${ref.pollutant_code}`);
    requireEqual(manifest.manifest_hash, ref.manifest_hash, `pollutant child manifest identity ${ref.manifest_key}`);
    requireEqual(manifest.source_row_count, ref.source_row_count, `pollutant child row count ${ref.pollutant_code}`);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length) fail(`pollutant manifest has no Parquet files: ${ref.pollutant_code}`);
    for (const file of files) {
      if (parquetKeys.has(file.key)) fail(`duplicate Parquet authority: ${file.key}`);
      parquetKeys.add(file.key);
      const descriptor = {
        key: file.key,
        byte_size: Number(file.bytes),
        sha256: String(file.etag_or_hash || ""),
      };
      const head = await headObject({ key: file.key });
      const classification = classifyDependencyIdentity({
        exists: head?.exists !== false,
        byte_size: head?.bytes,
        sha256: head?.sha256,
      }, descriptor);
      if (classification.classification !== "EXACT") fail(`canonical Parquet identity failed: ${file.key}`);
      if (Number(file.row_count) > ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3.max_file_rows || Number(file.bytes) > ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3.max_file_bytes) {
        fail(`canonical Parquet file exceeds accepted hard limits: ${file.key}`);
      }
      parquetRows += Number(file.row_count);
      parquetBytes += Number(file.bytes);
    }
    pollutants.push({
      pollutant_code: ref.pollutant_code,
      manifest_key: ref.manifest_key,
      manifest_hash: object.sha256,
      row_count: Number(manifest.row_count),
      file_count: files.length,
      files: files.map((file) => ({
        key: file.key,
        byte_size: Number(file.bytes),
        sha256: String(file.etag_or_hash),
        row_count: Number(file.row_count),
      })),
    });
  }
  requireEqual(parquetRows, accepted.source_row_count, "canonical child Parquet row total");

  const dayKey = buildHistoryV2DayManifestKey("history/v2/observations", accepted.day_utc);
  const dayObject = await getIdentity(getObject, dayKey);
  const day = JSON.parse(dayObject.body.toString("utf8"));
  validateCanonicalHistoryV2Manifest(day, {
    history_version: "v2",
    domain: "observations",
    manifest_kind: "day",
    day_utc: accepted.day_utc,
    manifest_key: dayKey,
  });
  const acceptedRef = (day.connector_manifests || []).find((entry) => Number(entry.connector_id) === accepted.connector_id);
  if (!acceptedRef) fail("day manifest omits the accepted connector");
  requireEqual(acceptedRef.manifest_key, candidateManifestKey, "day parent connector key");
  requireEqual(acceptedRef.manifest_hash, connector.manifest_hash, "day parent connector hash");
  for (const peer of day.connector_manifests || []) {
    const object = await getIdentity(getObject, peer.manifest_key);
    const peerConnector = JSON.parse(object.body.toString("utf8"));
    validateCanonicalHistoryV2Manifest(peerConnector, {
      history_version: "v2",
      domain: "observations",
      manifest_kind: "connector",
      day_utc: accepted.day_utc,
      connector_id: peer.connector_id,
      manifest_key: peer.manifest_key,
    });
    requireEqual(
      peerConnector.manifest_hash,
      peer.manifest_hash,
      `day parent connector child identity ${peer.connector_id}`,
    );
  }
  return Object.freeze({
    connector: { key: connectorObject.key, byte_size: connectorObject.byte_size, sha256: connectorObject.sha256, manifest_hash: connector.manifest_hash },
    day: { key: dayObject.key, byte_size: dayObject.byte_size, sha256: dayObject.sha256, manifest_hash: day.manifest_hash, connector_ids: [...day.connector_ids] },
    pollutants: Object.freeze(pollutants),
    pollutant_count: pollutants.length,
    parquet: { file_count: parquetKeys.size, row_count: parquetRows, total_bytes: parquetBytes },
  });
}

function exactLatestPayload(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    fail("v3 latest-global object is invalid JSON");
  }
  if (
    payload?.schema_version !== 3 ||
    payload?.kind !== "observation_timeseries_latest_global" ||
    payload?.index_generation !== "v3" ||
    payload?.history_version !== "v2" ||
    payload?.domain !== "observations" ||
    payload?.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    payload?.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    payload?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
    payload?.shard_width !== 1000 ||
    !Array.isArray(payload.day_summaries) ||
    body.toString("utf8") !== encodeObservationHistoryIndexV3Json(payload)
  ) {
    fail("v3 latest-global object is non-canonical or contradictory");
  }
  const days = payload.day_summaries.map((entry) => String(entry?.day_utc || ""));
  if (
    days.length === 0 ||
    days.some((day, index) => exactDay(day, "v3 latest day") !== day || (index > 0 && days[index - 1] >= day)) ||
    JSON.stringify(payload.days) !== JSON.stringify(days) ||
    payload.min_day_utc !== days[0] ||
    payload.max_day_utc !== days.at(-1) ||
    Number(payload.day_count) !== days.length
  ) {
    fail("v3 latest-global day hierarchy is contradictory");
  }
  let scopedRootCount = 0;
  let childShardCount = 0;
  let physicalFileReferenceCount = 0;
  let totalRows = 0;
  for (const summary of payload.day_summaries) {
    const roots = Array.isArray(summary.scoped_roots) ? summary.scoped_roots : [];
    const connectorIds = [...new Set(roots.map((entry) => Number(entry.connector_id)))].sort((a, b) => a - b);
    const pollutantCodes = [...new Set(roots.map((entry) => String(entry.pollutant_code)))].sort();
    const rowCount = roots.reduce((sum, entry) => sum + Number(entry.row_count), 0);
    if (
      roots.length === 0 ||
      Number(summary.scoped_root_count) !== roots.length ||
      Number(summary.row_count) !== rowCount ||
      JSON.stringify(summary.connector_ids) !== JSON.stringify(connectorIds) ||
      JSON.stringify(summary.pollutant_codes) !== JSON.stringify(pollutantCodes)
    ) {
      fail(`v3 latest-global affected-day summary is contradictory: ${summary.day_utc}`);
    }
    scopedRootCount += roots.length;
    childShardCount += roots.reduce((sum, entry) => sum + Number(entry.child_shard_count), 0);
    physicalFileReferenceCount += roots.reduce((sum, entry) => sum + Number(entry.physical_file_count), 0);
    totalRows += rowCount;
  }
  if (
    Number(payload.scoped_root_count) !== scopedRootCount ||
    Number(payload.child_shard_count) !== childShardCount ||
    Number(payload.physical_file_reference_count) !== physicalFileReferenceCount ||
    Number(payload.total_rows) !== totalRows ||
    payload.key_layout?.latest_key !== DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY
  ) {
    fail("v3 latest-global aggregate counters or key layout are contradictory");
  }
  return payload;
}

async function verifyV3Authority({ getObject, headObject, accepted, canonical, environment }) {
  const entries = [];
  const latest = await getIdentity(getObject, DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY);
  const latestPayload = exactLatestPayload(latest.body);
  entries.push({ kind: "latest_global", key: latest.key, classification: "EXACT", reason: null, byte_size: latest.byte_size, sha256: latest.sha256 });
  const day = latestPayload.day_summaries.find((entry) => entry.day_utc === accepted.day_utc);
  if (!day) fail("v3 latest-global omits the accepted day");
  const roots = (day.scoped_roots || []).filter((entry) => Number(entry.connector_id) === accepted.connector_id);
  const codes = roots.map((entry) => String(entry.pollutant_code));
  assertExactPollutantSet(codes, accepted.pollutant_codes, "v3 affected-day scope pollutant set");

  let selectedProbe = null;
  for (const root of roots) {
    const scopedObject = await reconcileJsonDependency(getObject, root, "scoped_manifest", entries);
    if (!scopedObject) continue;
    const scoped = validateObservationHistoryIndexV3ScopedManifestBody({ key: root.key, body: scopedObject.body });
    requireEqual(scoped.source.row_count, root.row_count, `v3 scoped canonical source rows ${root.pollutant_code}`);
    await reconcileJsonDependency(
      getObject,
      scoped.source,
      "canonical_source_manifest",
      entries,
    );
    const childFiles = new Map();
    for (const descriptor of scoped.descriptors) {
      const childObject = await reconcileJsonDependency(getObject, descriptor, "child_shard", entries);
      if (!childObject) continue;
      const timeseriesId = descriptor.timeseries_ids[0];
      const child = validateObservationHistoryV3ChildForRead({
        key: descriptor.key,
        body: childObject.body,
        dayUtc: accepted.day_utc,
        connectorId: accepted.connector_id,
        pollutantCode: root.pollutant_code,
        timeseriesId,
      });
      assertChildWriterLimits(child, descriptor.key);
      for (const file of child.files) {
        await reconcileParquetDependency(headObject, file, "child_parquet", entries);
        const prior = childFiles.get(file.key);
        if (prior && (prior.byte_size !== file.byte_size || prior.sha256 !== file.sha256 || prior.row_count !== file.row_count)) {
          fail(`v3 child shards contradict shared file identity: ${file.key}`);
        }
        childFiles.set(file.key, {
          key: file.key,
          byte_size: file.byte_size,
          sha256: file.sha256,
          row_count: file.row_count,
        });
      }
      if (!selectedProbe || root.pollutant_code === "no2") {
        selectedProbe = {
          day_utc: accepted.day_utc,
          connector_id: accepted.connector_id,
          pollutant: root.pollutant_code,
          timeseries_id: timeseriesId,
          scoped_manifest_key: root.key,
        };
      }
    }
    const canonicalPollutant = canonical.pollutants.find((entry) => entry.pollutant_code === root.pollutant_code);
    if (!canonicalPollutant) fail(`v3 scope lacks canonical pollutant authority: ${root.pollutant_code}`);
    const canonicalFiles = new Map(canonicalPollutant.files.map((file) => [file.key, file]));
    if (canonicalFiles.size !== childFiles.size) fail(`v3 scope file set differs from canonical pollutant: ${root.pollutant_code}`);
    for (const [key, file] of canonicalFiles) {
      const childFile = childFiles.get(key);
      if (!childFile || childFile.byte_size !== file.byte_size || childFile.sha256 !== file.sha256 || childFile.row_count !== file.row_count) {
        fail(`v3 scope file identity differs from canonical pollutant: ${key}`);
      }
    }
  }
  if (!selectedProbe) fail("accepted v3 scope cannot provide a deterministic deployed-read probe identity");
  return Object.freeze({
    latest: { key: latest.key, byte_size: latest.byte_size, sha256: latest.sha256 },
    affected_day_scope_count: roots.length,
    reconciliation: summarizeDependencyReconciliation(entries, environment),
    selected_probe: Object.freeze(selectedProbe),
  });
}

export function validateSteadyStateBaselineProvenance(provenanceInput) {
  const provenance = plainObject(provenanceInput, "hierarchy baseline provenance");
  if (
    provenance.kind !== STEADY_STATE_BASELINE_KIND ||
    provenance.pre_migration_dropbox_source === true ||
    !SHA256_PATTERN.test(String(provenance.checkpoint_sha256 || "")) ||
    !SHA256_PATTERN.test(String(provenance.recovery_head_sha256 || "")) ||
    !SHA256_PATTERN.test(String(provenance.immutable_authority_sha256 || ""))
  ) {
    fail("steady-state hierarchy baseline is not authenticated post-migration recovery evidence");
  }
  return provenance;
}

function completedIdentity(completed, key) {
  const record = completed.get(key);
  const evidence = record?.evidence;
  if (
    evidence?.verified !== true || evidence?.durable !== true ||
    !Number.isSafeInteger(Number(evidence.byte_size)) ||
    !SHA256_PATTERN.test(String(evidence.sha256 || ""))
  ) {
    return null;
  }
  return { key, byte_size: Number(evidence.byte_size), sha256: evidence.sha256 };
}

function requireExactJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} differs from the exact expected child set`);
}

export function assertExactAffectedBranchDelta({
  baselineMonthChildren,
  baselineYearChildren,
  baselineRootChildren,
  currentMonth,
  currentYear,
  currentRoot,
  acceptedDay,
}) {
  const accepted = plainObject(acceptedDay, "accepted day hierarchy descriptor");
  const month = plainObject(currentMonth, "current month aggregate");
  const year = plainObject(currentYear, "current year aggregate");
  const root = plainObject(currentRoot, "current root aggregate");
  const monthChildren = Array.isArray(baselineMonthChildren) ? baselineMonthChildren : [];
  if (monthChildren.some((child) => child.day_utc === accepted.day_utc)) {
    fail("accepted day already exists in the authenticated baseline month");
  }
  const expectedMonthChildren = [...monthChildren, {
    day_utc: accepted.day_utc,
    manifest_key: accepted.manifest_key,
    manifest_hash: accepted.manifest_hash,
  }].sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  requireExactJson(month.children, expectedMonthChildren, "advanced month aggregate");

  const expectedYearChildren = [
    ...(Array.isArray(baselineYearChildren) ? baselineYearChildren : [])
      .filter((child) => child.month !== month.month),
    { month: month.month, manifest_key: month.manifest_key, content_hash: month.content_hash },
  ].sort((left, right) => left.month.localeCompare(right.month));
  requireExactJson(year.children, expectedYearChildren, "advanced year aggregate");

  const expectedRootChildren = [
    ...(Array.isArray(baselineRootChildren) ? baselineRootChildren : [])
      .filter((child) => Number(child.year) !== Number(year.year)),
    { year: Number(year.year), manifest_key: year.manifest_key, content_hash: year.content_hash },
  ].sort((left, right) => Number(left.year) - Number(right.year));
  requireExactJson(root.children, expectedRootChildren, "advanced root aggregate");
  return Object.freeze({
    month_child_count: expectedMonthChildren.length,
    year_child_count: expectedYearChildren.length,
    root_child_count: expectedRootChildren.length,
  });
}

export function assertExactLatestGlobalDelta({ baselineLatest, currentLatest, acceptedDayUtc }) {
  const baseline = plainObject(baselineLatest, "authenticated baseline v3 latest-global");
  const current = plainObject(currentLatest, "current v3 latest-global");
  const acceptedDay = exactDay(acceptedDayUtc, "accepted latest-global day");
  const baselineSummaries = Array.isArray(baseline.day_summaries) ? baseline.day_summaries : [];
  const currentSummaries = Array.isArray(current.day_summaries) ? current.day_summaries : [];
  if (baselineSummaries.some((summary) => summary.day_utc === acceptedDay)) {
    fail("accepted day already exists in authenticated baseline v3 latest-global");
  }
  const expectedDays = [...baselineSummaries.map((summary) => summary.day_utc), acceptedDay].sort();
  if (!sameSorted(current.days || [], expectedDays)) {
    fail("current v3 latest-global day set differs from baseline canonical days plus accepted day");
  }
  const currentByDay = new Map(currentSummaries.map((summary) => [summary.day_utc, summary]));
  for (const summary of baselineSummaries) {
    requireExactJson(currentByDay.get(summary.day_utc), summary, `unaffected v3 latest-global day ${summary.day_utc}`);
  }
  if (!currentByDay.has(acceptedDay) || currentSummaries.length !== expectedDays.length) {
    fail("current v3 latest-global has a missing or extra day summary");
  }
  return Object.freeze({ baseline_day_count: baselineSummaries.length, current_day_count: expectedDays.length });
}

function requireAuthenticatedCompletedPlanIdentity(completed, expected, label) {
  const identity = completedIdentity(completed, expected.key);
  if (!identity) fail(`${label} lacks exact authenticated completed-migration identity: ${expected.key}`);
  return identity;
}

function replayAuthenticatedRecoveryCheckpoint(originalCheckpoint, journal) {
  const checkpoint = structuredClone(originalCheckpoint);
  checkpoint.prepared_units ||= {};
  checkpoint.completed_objects ||= {};
  checkpoint.preparation_order ||= [];
  for (const entry of journal.entries) {
    const updates = entry.payload.updates || {};
    for (const prepared of updates.prepared_records || []) {
      if (!prepared?.unit_id || prepared.record?.unit_id !== prepared.unit_id || checkpoint.prepared_units[prepared.unit_id]) {
        fail(`authenticated recovery prepared-record update is invalid: ${String(prepared?.unit_id || "")}`);
      }
      checkpoint.prepared_units[prepared.unit_id] = structuredClone(prepared.record);
    }
    for (const state of updates.prepared_state_updates || []) {
      const record = checkpoint.prepared_units[state?.unit_id];
      if (!record) fail(`authenticated recovery state references unknown unit: ${String(state?.unit_id || "")}`);
      if (state.files_published === true) record.files_published = true;
      if (state.remove_staging_refs === true) {
        record.target_file_intents = record.target_file_intents.map(({ staging_ref: _stagingRef, ...intent }) => intent);
      }
    }
    for (const completed of updates.completed_objects || []) {
      if (!completed?.key || !completed.evidence) fail("authenticated recovery completed-object update is invalid");
      checkpoint.completed_objects[completed.key] ||= structuredClone(completed.evidence);
    }
    for (const unitId of updates.preparation_order_append || []) {
      if (!checkpoint.prepared_units[unitId] || checkpoint.preparation_order.includes(unitId)) {
        fail(`authenticated recovery preparation-order update is invalid: ${String(unitId)}`);
      }
      checkpoint.preparation_order.push(unitId);
    }
    if (updates.final_state) {
      if (typeof updates.final_state.full_verification_complete === "boolean") {
        checkpoint.full_verification_complete = updates.final_state.full_verification_complete;
      }
      if (typeof updates.final_state.cutover_ready === "boolean") {
        checkpoint.cutover_ready = updates.final_state.cutover_ready;
      }
    }
  }
  return checkpoint;
}

async function verifyHierarchyDelta({ getObject, planReport, checkpointPath, recoveryRoot, accepted, requiredUnchangedDay }) {
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  const recoveryManifest = parseJsonFile(path.join(recoveryRoot, "manifest.json"), "recovery manifest");
  const migrationRunId = String(planReport?.result?.migration_run_id || "");
  const planSha = exactSha256(planReport?.result?.plan_sha256, "migration plan SHA-256");
  const authoritySha = exactSha256(checkpoint.authority_sha256, "checkpoint immutable authority SHA-256");
  const targetWriterGitSha = exactGitSha(recoveryManifest?.payload?.target_writer_git_sha, "migration target writer Git SHA");
  const journal = readAndValidateRecoveryJournal({
    recoveryRoot,
    expectedCheckpointSha256: sha256(checkpointBytes),
    expectedCheckpointByteSize: checkpointBytes.byteLength,
    expectedAuthoritySha256: authoritySha,
    expectedMigrationRunId: migrationRunId,
    expectedPlanSha256: planSha,
    expectedTargetWriterGitSha: targetWriterGitSha,
  });
  const replayedCheckpoint = replayAuthenticatedRecoveryCheckpoint(checkpoint, journal);
  const baselinePlan = buildObservationHistoryV3RerunVerificationPlan({
    checkpoint: replayedCheckpoint,
    allowLegacyRecoveryOrdering: true,
    recoveryAuthority: {
      authenticated: true,
      original_checkpoint_sha256: sha256(checkpointBytes),
      immutable_authority_sha256: authoritySha,
      migration_run_id: migrationRunId,
      plan_sha256: planSha,
      last_sequence: journal.last_sequence,
      last_entry_sha256: journal.last_entry_sha256,
      replayed_checkpoint_sha256: buildObservationHistoryV3RecoveryReplayStateSha256(replayedCheckpoint),
    },
  });
  const headBytes = fs.readFileSync(path.join(recoveryRoot, "head.json"));
  const provenance = validateSteadyStateBaselineProvenance({
    kind: STEADY_STATE_BASELINE_KIND,
    pre_migration_dropbox_source: false,
    checkpoint_sha256: sha256(checkpointBytes),
    checkpoint_byte_size: checkpointBytes.byteLength,
    immutable_authority_sha256: authoritySha,
    recovery_head_sha256: sha256(headBytes),
    recovery_last_sequence: journal.last_sequence,
    recovery_last_entry_sha256: journal.last_entry_sha256,
    migration_run_id: migrationRunId,
    plan_sha256: planSha,
    target_writer_git_sha: targetWriterGitSha,
    recovery_reconciliation_mode: baselinePlan.recovery_reconciliation.mode,
  });

  const dayKey = buildHistoryV2DayManifestKey("history/v2/observations", accepted.day_utc);
  if (journal.completed_objects.has(dayKey)) fail("accepted day already exists in the authenticated pre-steady-state baseline");
  const requiredDay = exactDay(requiredUnchangedDay, "required unchanged day");
  const requiredDayKey = buildHistoryV2DayManifestKey("history/v2/observations", requiredDay);
  if (!completedIdentity(journal.completed_objects, requiredDayKey)) {
    fail(`required unchanged day lacks authenticated post-migration evidence: ${requiredDay}`);
  }

  const branchKeys = new Set([
    buildR2HistoryV2ObservationsMonthManifestKey("history/v2/observations", accepted.day_utc.slice(0, 4), accepted.day_utc.slice(5, 7)),
    buildR2HistoryV2ObservationsYearManifestKey("history/v2/observations", accepted.day_utc.slice(0, 4)),
    buildR2HistoryV2ObservationsRootManifestKey("history/v2/observations"),
  ]);
  const baselineCanonical = new Map(
    baselinePlan.canonical_publication_objects.map((object) => [object.key, object]),
  );
  for (const object of baselineCanonical.values()) {
    requireAuthenticatedCompletedPlanIdentity(journal.completed_objects, object, "canonical baseline object");
  }
  const unaffected = [];
  const unaffectedAggregates = [];
  for (const key of journal.completed_objects.keys()) {
    if (!key.startsWith("history/v2/observations/") || !key.endsWith("/manifest.json") || branchKeys.has(key)) continue;
    const identity = completedIdentity(journal.completed_objects, key);
    if (!identity) continue;
    const isDay = /\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key);
    const isAggregate = key.includes("/_manifests/");
    if (!isDay && !isAggregate) continue;
    const current = await getIdentity(getObject, key);
    const classification = classifyDependencyIdentity(current, identity);
    if (classification.classification !== "EXACT") fail(`unaffected post-migration hierarchy identity changed: ${key}`);
    const exact = { key, byte_size: current.byte_size, sha256: current.sha256 };
    if (isDay) unaffected.push(exact);
    else unaffectedAggregates.push(exact);
  }
  if (!unaffected.some((entry) => entry.key === requiredDayKey)) fail(`required unchanged day was not exact: ${requiredDay}`);

  const aggregates = [];
  for (const key of branchKeys) {
    const current = await getIdentity(getObject, key);
    const payload = JSON.parse(current.body.toString("utf8"));
    const canonical = validateR2HistoryV2ObservationsAggregateManifest(payload, { basePrefix: "history/v2/observations" });
    aggregates.push({ key, byte_size: current.byte_size, sha256: current.sha256, content_hash: canonical.content_hash, payload });
  }
  const month = aggregates.find((entry) => entry.key.includes("month="));
  const year = aggregates.find((entry) => /\/_manifests\/year=\d{4}\/manifest\.json$/.test(entry.key));
  const root = aggregates.find((entry) => entry.key.endsWith("/_manifests/manifest.json"));
  const dayIdentity = await getIdentity(getObject, dayKey);
  const dayPayload = JSON.parse(dayIdentity.body.toString("utf8"));
  const acceptedYear = Number(accepted.day_utc.slice(0, 4));
  const acceptedMonth = accepted.day_utc.slice(5, 7);
  const baselineMonthChildren = [...baselineCanonical.values()]
    .filter((object) => object.publication_stage === "day_manifest" && object.payload.day_utc.startsWith(`${acceptedYear}-${acceptedMonth}`))
    .map((object) => ({
      day_utc: object.payload.day_utc,
      manifest_key: object.key,
      manifest_hash: object.payload.manifest_hash,
    }));
  const baselineYearChildren = [...baselineCanonical.values()]
    .filter((object) => object.publication_stage === "month_manifest" && Number(object.payload.year) === acceptedYear)
    .map((object) => ({
      month: object.payload.month,
      manifest_key: object.key,
      content_hash: object.payload.content_hash,
    }));
  const baselineRootChildren = [...baselineCanonical.values()]
    .filter((object) => object.publication_stage === "year_manifest")
    .map((object) => ({
      year: Number(object.payload.year),
      manifest_key: object.key,
      content_hash: object.payload.content_hash,
    }));
  const branchDelta = assertExactAffectedBranchDelta({
    baselineMonthChildren,
    baselineYearChildren,
    baselineRootChildren,
    currentMonth: { ...month.payload, manifest_key: month.key },
    currentYear: { ...year.payload, manifest_key: year.key },
    currentRoot: root.payload,
    acceptedDay: {
      day_utc: accepted.day_utc,
      manifest_key: dayKey,
      manifest_hash: dayPayload.manifest_hash,
    },
  });

  const baselineV3Entries = baselinePlan.v3_publication_plan.entries;
  const unaffectedV3 = [];
  for (const expected of baselineV3Entries) {
    const authenticatedIdentity = requireAuthenticatedCompletedPlanIdentity(journal.completed_objects, expected, "v3 baseline object");
    if (expected.key === DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY) continue;
    const current = await getIdentity(getObject, expected.key);
    if (current.byte_size !== authenticatedIdentity.byte_size || current.sha256 !== authenticatedIdentity.sha256) {
      fail(`unaffected authenticated v3 authority changed: ${expected.key}`);
    }
    unaffectedV3.push({ key: expected.key, byte_size: current.byte_size, sha256: current.sha256 });
  }
  const currentLatestIdentity = await getIdentity(getObject, DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY);
  const currentLatest = exactLatestPayload(currentLatestIdentity.body);
  const baselineCanonicalDays = [...baselineCanonical.keys()]
    .filter((key) => /\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key))
    .map((key) => key.match(/day_utc=(\d{4}-\d{2}-\d{2})/)[1])
    .sort();
  if (!sameSorted(baselinePlan.v3_latest.payload.days || [], baselineCanonicalDays)) {
    fail("authenticated baseline v3 latest-global days differ from baseline canonical day authority");
  }
  const latestDelta = assertExactLatestGlobalDelta({
    baselineLatest: baselinePlan.v3_latest.payload,
    currentLatest,
    acceptedDayUtc: accepted.day_utc,
  });

  return Object.freeze({
    baseline: provenance,
    intended_delta: {
      accepted_day_utc: accepted.day_utc,
      accepted_day_was_absent: true,
      allowed_advanced_keys: [...branchKeys].sort(),
    },
    unaffected_day_identity_count: unaffected.length,
    unaffected_aggregate_identity_count: unaffectedAggregates.length,
    required_unchanged_day: unaffected.find((entry) => entry.key === requiredDayKey),
    advanced_aggregate_identities: aggregates.map(({ payload: _payload, ...identity }) => identity),
    affected_branch_exact_delta: branchDelta,
    unaffected_v3_identity_count: unaffectedV3.length,
    latest_global_exact_delta: latestDelta,
  });
}

function verifyDropboxPrestate({ planReport, dropboxRoot }) {
  const state = plainObject(planReport?.result?.backup_gate?.state_root, "migration backup state root");
  const key = String(state.key || "");
  if (!key || path.isAbsolute(key) || key.split("/").includes("..")) fail("backup state-root key is unsafe");
  const filePath = path.join(path.resolve(dropboxRoot), ...key.split("/"));
  const body = fs.readFileSync(filePath);
  requireEqual(body.byteLength, state.byte_size, "pinned Dropbox state-root byte size");
  requireEqual(sha256(body), state.sha256, "pinned Dropbox state-root SHA-256");
  return Object.freeze({
    first_post_v3_backup_started_by_verifier: false,
    pinned_prestate_unchanged: true,
    state_root: { key, byte_size: body.byteLength, sha256: sha256(body) },
  });
}

async function verifyReadProbe({ httpGet, siteUrl, cacheUrl, bypassSecret, selected }) {
  const startUtc = `${selected.day_utc}T00:00:00.000Z`;
  const endUtc = new Date(Date.parse(startUtc) + 86400000).toISOString();
  const url = new URL("/api/aq/station-series", cacheUrl);
  for (const [key, value] of Object.entries({
    timeseries_id: selected.timeseries_id,
    connector_id: selected.connector_id,
    pollutant: selected.pollutant,
    start_utc: startUtc,
    end_utc: endUtc,
    format: "objects",
    include_observations: "true",
    include_aqi: "false",
    cache: "bypass",
  })) url.searchParams.set(key, String(value));
  const response = await httpGet({
    url: url.toString(),
    headers: {
      Origin: siteUrl,
      "X-CIC-Local-Dev-Token": bypassSecret,
      "X-UK-AQ-Bypass-Token": bypassSecret,
      "Cache-Control": "no-cache, no-store",
    },
  });
  if (Number(response.status) !== 200) fail(`deployed v3 read probe returned HTTP ${response.status}`);
  const cache = response.headers.get("x-uk-aq-cache");
  const route = response.headers.get("x-uk-aq-station-history-route");
  const contract = response.headers.get("x-uk-aq-station-history-contract");
  if (cache !== "BYPASS" || route !== "/v1/station-series" || contract !== "v2") {
    fail("deployed read probe did not prove cache -> station-history candidate routing");
  }
  const payload = await response.json();
  const rows = Array.isArray(payload?.observations?.rows) ? payload.observations.rows : [];
  const r2Rows = rows.filter((row) => row?.source === "r2").length || Number(payload?.observations?.source_counts?.r2 || 0);
  if (r2Rows <= 0) fail("deployed read probe returned no historical R2 rows");
  return Object.freeze({
    status: "PASS_WITH_WARNING",
    selected_identity: selected,
    http_status: 200,
    cache_status: cache,
    station_history_route: route,
    station_history_contract: contract,
    historical_r2_row_count: r2Rows,
    inner_fresh_r2_read_proven: false,
    warning: "Cache BYPASS does not independently prove an inner observation-worker fresh R2 read.",
  });
}

function validateControlAuthority(controlInput, expected) {
  const control = plainObject(controlInput, "repository/control authority evidence");
  for (const field of [
    "repository_exact", "working_tree_clean", "default_branch_current",
    "repository_git_sha_exact", "loaded_history_v2", "loaded_index_v3",
    "persistent_history_v2", "persistent_index_v3", "loaded_integrity_v2",
    "maintenance_on", "three_scheduler_jobs_disabled", "no_active_prune",
    "no_active_backup",
    "writer_freeze_valid", "v2_runtime_rollback_record_valid",
    "cache_to_station_candidate_exact", "station_to_observation_candidate_exact",
  ]) {
    if (control[field] !== true) fail(`repository/control authority proof failed: ${field}`);
  }
  requireEqual(control.environment, expected.environment, "control environment");
  requireEqual(control.repository, expected.repository, "control repository");
  requireEqual(control.repository_git_sha, expected.repository_git_sha, "control repository Git SHA");
  requireEqual(control.bucket, expected.bucket, "control R2 bucket");
  return control;
}

export async function executeSteadyStatePostWriteVerifier(options, adaptersInput) {
  const adapters = assertReadOnlyAdapters(adaptersInput);
  const acceptanceBytes = fs.readFileSync(options.acceptanceReport);
  requireEqual(sha256(acceptanceBytes), options.expectedAcceptanceReportSha256, "acceptance report SHA-256");
  const acceptanceReport = JSON.parse(acceptanceBytes.toString("utf8"));
  const accepted = validateAcceptanceReport(acceptanceReport, {
    environment: options.environment,
    acceptance_git_sha: options.expectedAcceptanceGitSha,
    run_id: options.expectedRunId,
    day_utc: options.expectedDayUtc,
    connector_id: options.expectedConnectorId,
    source_row_count: options.expectedRowCount,
    source_content_hash: options.expectedSourceContentHash,
    source_content_hash_contract_version: options.expectedSourceHashContractVersion,
    pollutant_count: options.expectedPollutantCount,
  });
  const control = validateControlAuthority(
    parseJsonFile(options.controlEvidence, "control evidence"),
    {
      environment: options.environment,
      repository: options.repository,
      repository_git_sha: options.repositoryGitSha,
      bucket: options.bucket,
    },
  );
  const state = await readControlState(async (sql, params) => {
    assertReadOnlySql(sql);
    return await adapters.query({ sql, params });
  }, accepted);
  const independent = validateIndependentControlState(state, accepted);
  const canonical = await verifyCanonicalHierarchy({
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    accepted,
    candidateManifestKey: independent.candidate.manifest_key,
  });
  const controlR2Binding = bindIndependentControlStateToCanonical(independent, canonical);
  const v3 = await verifyV3Authority({
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    accepted,
    canonical,
    environment: options.environment,
  });
  const planReport = parseJsonFile(options.planReport, "migration plan report");
  const hierarchyDelta = await verifyHierarchyDelta({
    getObject: adapters.getObject,
    planReport,
    checkpointPath: options.checkpoint,
    recoveryRoot: `${options.checkpoint}.recovery`,
    accepted,
    requiredUnchangedDay: options.requiredUnchangedDay,
  });
  const backupGate = verifyDropboxPrestate({ planReport, dropboxRoot: options.dropboxRoot });
  const deployedReadProbe = await verifyReadProbe({
    httpGet: adapters.httpGet,
    siteUrl: options.siteUrl,
    cacheUrl: options.cacheUrl,
    bypassSecret: options.cacheBypassSecret,
    selected: v3.selected_probe,
  });
  return Object.freeze({
    schema_version: 1,
    kind: "index_v3_steady_state_post_write_verification",
    verifier_version: STEADY_STATE_POST_WRITE_VERIFIER_VERSION,
    created_at_utc: new Date().toISOString(),
    status: "PASS",
    final_message: FINAL_SUCCESS,
    mutation_performed: false,
    repository_control_authority: control,
    accepted_publication: accepted,
    independent_control_state: independent,
    independent_control_r2_binding: controlR2Binding,
    canonical_hierarchy: canonical,
    observation_index_v3: v3,
    hierarchy_delta: hierarchyDelta,
    rollback_source_preservation: {
      source_deletion_committed: false,
      independently_recoverable: true,
      complete_prestate_v2_rollback_guarantee_closed: false,
      normal_prune_deletion_safe: false,
    },
    backup_gate: {
      ...backupGate,
      eligible_for_first_locked_post_v3_dropbox_backup: true,
      prune_enablement_authorized: false,
      writer_resume_authorized: false,
      maintenance_off_authorized: false,
      source_deletion_authorized: false,
    },
    deployed_read_probe: deployedReadProbe,
    warnings: [deployedReadProbe.warning],
  });
}

function parseFlagValues(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || index + 1 >= argv.length) fail(`invalid argument: ${flag}`);
    values[flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = argv[++index];
  }
  return values;
}

function validateReportPathValues(values) {
  for (const name of [
    "reportOut", "acceptanceReport", "controlEvidence", "planReport", "checkpoint",
    "dropboxRoot", "writerFreezeEvidence", "v2RuntimeRollbackRecord",
  ]) {
    if (!values[name]) fail(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  values.reportOut = assertSafeLocalReportPath({
    reportOut: values.reportOut,
    evidencePaths: [
      values.acceptanceReport,
      values.controlEvidence,
      values.planReport,
      values.writerFreezeEvidence,
      values.v2RuntimeRollbackRecord,
    ],
    checkpoint: values.checkpoint,
    recoveryRoot: `${values.checkpoint}.recovery`,
    dropboxRoot: values.dropboxRoot,
  });
  values.reportOutSafetyValidated = true;
  return values;
}

function parseArgs(argv) {
  const values = parseFlagValues(argv);
  const required = [
    "environment", "repository", "repositoryGitSha", "bucket", "expectedAcceptanceGitSha",
    "acceptanceReport", "expectedAcceptanceReportSha256", "expectedRunId", "expectedDayUtc",
    "expectedConnectorId", "expectedRowCount", "expectedSourceContentHash",
    "expectedSourceHashContractVersion", "expectedPollutantCount", "controlEvidence",
    "planReport", "checkpoint", "dropboxRoot", "writerFreezeEvidence",
    "v2RuntimeRollbackRecord", "requiredUnchangedDay", "siteUrl", "cacheUrl", "reportOut",
  ];
  for (const name of required) if (!values[name]) fail(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  values.environment = String(values.environment).toUpperCase();
  if (!new Set(["TEST", "LIVE"]).has(values.environment)) fail("--environment must be TEST or LIVE");
  values.repositoryGitSha = exactGitSha(values.repositoryGitSha, "repository Git SHA");
  values.expectedAcceptanceGitSha = exactGitSha(values.expectedAcceptanceGitSha, "acceptance Git SHA");
  values.expectedAcceptanceReportSha256 = exactSha256(values.expectedAcceptanceReportSha256, "acceptance report SHA-256");
  values.expectedDayUtc = exactDay(values.expectedDayUtc, "expected day_utc");
  values.requiredUnchangedDay = exactDay(values.requiredUnchangedDay, "required unchanged day");
  values.expectedConnectorId = exactPositiveInteger(values.expectedConnectorId, "expected connector_id");
  values.expectedRowCount = exactPositiveInteger(values.expectedRowCount, "expected row count");
  values.expectedSourceContentHash = exactSha256(values.expectedSourceContentHash, "expected source hash");
  values.expectedSourceHashContractVersion = exactPositiveInteger(values.expectedSourceHashContractVersion, "expected source hash contract version");
  values.expectedPollutantCount = exactPositiveInteger(values.expectedPollutantCount, "expected pollutant count");
  validateReportPathValues(values);
  values.cacheBypassSecret = process.env.UK_AQ_CACHE_BYPASS_SECRET || "";
  if (!values.cacheBypassSecret) fail("UK_AQ_CACHE_BYPASS_SECRET is required for the deployed read probe");
  return values;
}

function writeReport(reportOut, payload, safetyValidated) {
  if (safetyValidated !== true) fail("report output path protection has not passed");
  const output = reportOut;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function withReadOnlyPgTransaction(client, operation) {
  await client.query("begin transaction read only");
  try {
    return await operation();
  } finally {
    await client.query("rollback");
  }
}

async function main() {
  if (process.argv[2] === "--check-report-path") {
    const values = validateReportPathValues(parseFlagValues(process.argv.slice(3)));
    process.stdout.write(`${values.reportOut}\n`);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const r2 = {
    endpoint: process.env.CFLARE_R2_ENDPOINT,
    bucket: process.env.CFLARE_R2_BUCKET,
    region: process.env.CFLARE_R2_REGION || "auto",
    access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
    secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
  };
  requireEqual(r2.bucket, options.bucket, "loaded R2 bucket");
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    application_name: "uk-aq-index-v3-steady-state-post-write-verify",
    statement_timeout: 120000,
    query_timeout: 120000,
    connectionTimeoutMillis: 15000,
  });
  let report;
  try {
    await client.connect();
    report = await withReadOnlyPgTransaction(client, async () =>
      await executeSteadyStatePostWriteVerifier(options, {
        query: async ({ sql, params }) => await client.query(assertReadOnlySql(sql), params),
        getObject: async ({ key }) => await r2GetObject({ r2, key }),
        headObject: async ({ key }) => await r2HeadObject({ r2, key }),
        httpGet: async ({ url, headers }) => await fetch(url, { method: "GET", headers }),
      })
    );
    writeReport(options.reportOut, report, options.reportOutSafetyValidated);
    process.stdout.write(`${FINAL_SUCCESS.join("\n")}\n`);
  } catch (error) {
    report = {
      schema_version: 1,
      kind: "index_v3_steady_state_post_write_verification",
      verifier_version: STEADY_STATE_POST_WRITE_VERIFIER_VERSION,
      created_at_utc: new Date().toISOString(),
      status: "FAIL",
      mutation_performed: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (options?.reportOutSafetyValidated === true) {
      writeReport(options.reportOut, report, true);
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`STEADY-STATE POST-WRITE VERIFY FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("MAINTENANCE AND WRITER FREEZE REMAIN REQUIRED.\n");
    process.exitCode = 1;
  });
}
