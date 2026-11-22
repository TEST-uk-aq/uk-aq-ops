import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { connectorManifestKey } from "./stranded_prune_history.mjs";
import { digest, IMPACT, LIMITATION, MAX_LOCK_MS, MAX_TRANSACTION_MS, POLLUTANTS, requireFact, ROWS } from "./stranded_prune_source.mjs";

const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxBundleBytes = 128 * 1024 * 1024;
const phaseB = {
  publication: "phase_b_history_connector_publication_complete",
  batchStart: "phase_b_history_v3_run_finalization_batch_start",
  batchFailure: "phase_b_history_v3_run_finalization_failed",
  batchComplete: "phase_b_history_v3_run_finalization_complete",
  gateComplete: "phase_b_history_candidate_complete",
  summary: "phase_b_history_run_summary",
};

function originalPhaseBEvents(log, runId) {
  const eventNames = new Set(Object.values(phaseB));
  const events = [];
  for (const line of log.toString("utf8").split(/\r?\n/)) {
    // gh prefixes each JSON record with the job, step and display timestamp.
    const json = line.indexOf("{");
    if (json < 0) continue;
    let event;
    try { event = JSON.parse(line.slice(json)); } catch { continue; }
    if (event?.run_id === runId && eventNames.has(event.event)) events.push(event);
  }
  return events;
}

export function readBounded(path, limit = maxBundleBytes) {
  const stat = lstatSync(path);
  requireFact(stat.isFile() && stat.size > 0 && stat.size <= limit, "Evidence file is missing, empty or too large");
  const data = readFileSync(path);
  requireFact(data.length === stat.size, "Evidence file changed while reading");
  return data;
}

export function writePrivate(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
}

export function utc(value) {
  requireFact(typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value, "A canonical UTC instant is required");
  return Date.parse(value);
}

export function readSigned(path, signature, keyPath) {
  const key = createPublicKey(readBounded(keyPath, 8_192));
  requireFact(key.asymmetricKeyType === "ed25519", "The trusted operator public key must be Ed25519");
  const body = readBounded(path, 64 * 1024);
  const sig = readBounded(signature, 64);
  requireFact(sig.length === 64 && verify(null, body, key, sig), "Operator signature verification failed");
  return { value: JSON.parse(body), body, signature: sig, key_sha256: sha256Hex(key.export({ type: "spki", format: "der" })) };
}

export function validateBaseline(baseline, workflow, log) {
  const start = utc(`${baseline.day_utc}T00:00:00.000Z`);
  const cutoff = utc(baseline.publication_cutoff);
  requireFact(baseline.version === 1 && Number.isSafeInteger(baseline.connector_id) && baseline.connector_id > 0 &&
    baseline.row_count === ROWS && baseline.pollutant_count === POLLUTANTS &&
    baseline.manifest_key === connectorManifestKey(baseline.day_utc, baseline.connector_id) &&
    sha.test(baseline.manifest_hash) && sha.test(baseline.source_content_hash) && uuid.test(baseline.original_run_id) &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(baseline.workflow_url) &&
    cutoff >= start + 86_400_000 && cutoff <= Date.now() &&
    baseline.workflow_record_sha256 === sha256Hex(workflow) && baseline.workflow_log_sha256 === sha256Hex(log),
  "Signed incident baseline is malformed or differs from its workflow evidence");
  const metadata = JSON.parse(workflow);
  requireFact(metadata.url === baseline.workflow_url && String(metadata.databaseId) === baseline.workflow_url.split("/").at(-1) &&
    metadata.status === "completed" && ["success", "failure", "cancelled", "timed_out"].includes(metadata.conclusion) &&
    /^[a-f0-9]{40}$/.test(metadata.headSha) && metadata.headSha === baseline.writer_git_sha && Number.isFinite(Date.parse(metadata.startedAt)) &&
    Date.parse(metadata.startedAt) <= cutoff && Date.parse(metadata.updatedAt) >= cutoff &&
    typeof metadata.workflowName === "string" && /prune/i.test(metadata.workflowName) &&
    Array.isArray(metadata.jobs) && metadata.jobs.some((job) => job.status === "completed"),
  "Original workflow metadata does not identify the completed Prune workflow");

  const events = originalPhaseBEvents(log, baseline.original_run_id);
  const inScope = (event) => event.day_utc === baseline.day_utc && event.connector_id === baseline.connector_id;
  const [publication, duplicatePublication] = events.filter((event) => event.event === phaseB.publication && inScope(event));
  requireFact(publication && !duplicatePublication, "Workflow log does not contain one matching original connector publication");
  requireFact(Number(publication.expected_row_count) === ROWS && Number(publication.written_row_count) === ROWS &&
    Number(publication.source_identity_rows) === ROWS && publication.source_identity_contract_version === 1 &&
    publication.source_content_hash === baseline.source_content_hash && publication.source_identity_match === true &&
    publication.source_owner === "phase_b_export" && publication.manifest_key === baseline.manifest_key &&
    publication.connector_gate_complete === false && publication.awaiting_run_finalization === true &&
    Math.floor(utc(publication.timestamp) / 1000) === Math.floor(cutoff / 1000),
  "Original connector publication event contradicts the baseline");

  // The writer and its Prune batch caller emit the same failure event name.
  // The writer records the days and outcome. The caller records the trigger
  // and gate count. Require both in sequence without crossing a batch boundary.
  const boundaryNames = new Set([phaseB.batchStart, phaseB.batchFailure, phaseB.batchComplete, phaseB.summary]);
  const [batch, writerFailure, failure, followingBoundary] = events.slice(events.indexOf(publication) + 1)
    .filter((event) => boundaryNames.has(event.event));
  requireFact(batch?.event === phaseB.batchStart && Array.isArray(batch.affected_days_utc) &&
    batch.affected_days_utc.includes(baseline.day_utc) &&
    Number.isSafeInteger(batch.connector_publication_count) && batch.connector_publication_count > 0 &&
    typeof batch.finalization_batch_trigger === "string" && batch.finalization_batch_trigger.length > 0 &&
    utc(batch.timestamp) >= utc(publication.timestamp) &&
    writerFailure?.event === phaseB.batchFailure && writerFailure.failure_outcome === "budget_stop" &&
    isDeepStrictEqual(writerFailure.affected_days_utc, batch.affected_days_utc) &&
    writerFailure.connector_count === batch.connector_publication_count &&
    writerFailure.finalization_batch_trigger === undefined && writerFailure.connector_gate_completed_count === undefined &&
    utc(writerFailure.timestamp) >= utc(batch.timestamp) &&
    failure?.event === phaseB.batchFailure && failure.finalization_batch_trigger === batch.finalization_batch_trigger &&
    failure.failure_outcome === undefined &&
    failure.connector_publication_count === batch.connector_publication_count && failure.stopped_for_budget === true &&
    failure.connector_gate_completed_count === 0 && utc(failure.timestamp) >= utc(writerFailure.timestamp),
  "Original v3 finalization batch lacks matching writer and batch budget failures with zero completed connector gates");

  const [summary, duplicateSummary] = events.filter((event) => event.event === phaseB.summary);
  requireFact(summary && !duplicateSummary && followingBoundary === summary &&
    summary.status === "stopped_budget" && summary.stopped_for_budget === true && summary.dry_run === false &&
    utc(summary.timestamp) >= utc(failure.timestamp) &&
    Array.isArray(summary.blocked_preview) && summary.blocked_preview.some((day) =>
      day?.day_utc === baseline.day_utc && day.history_done === false && day.reason === "phase_b_history_budget_exhausted"),
  "Original Phase B summary does not confirm the budget stop and blocked observation day");
  requireFact(!events.some((event) => event.event === phaseB.gateComplete && inScope(event)) &&
    !events.slice(events.indexOf(failure) + 1).some((event) =>
      event.event === phaseB.batchComplete && event.affected_days_utc?.includes(baseline.day_utc)),
  "Original workflow contains contradictory finalization or connector gate completion evidence");
}

export function readApproval(path, signature, key, plan, planSha) {
  const signed = readSigned(path, signature, key);
  const approval = signed.value;
  requireFact(signed.key_sha256 === plan.operator_key_sha256 &&
    approval.version === 1 && approval.operation_id === plan.operation_id && approval.plan_sha256 === planSha &&
    typeof approval.reference === "string" && /^[\x20-\x7e]{1,256}$/.test(approval.reference) && approval.reference.trim() &&
    approval.accepted_row_incarnation_limitation === LIMITATION && approval.accepted_cross_connector_impact === IMPACT &&
    Number.isSafeInteger(approval.transaction_ms) && approval.transaction_ms > 0 && approval.transaction_ms <= MAX_TRANSACTION_MS &&
    Number.isSafeInteger(approval.lock_ms) && approval.lock_ms > 0 && approval.lock_ms <= MAX_LOCK_MS &&
    approval.lock_ms <= approval.transaction_ms &&
    utc(approval.window_start) >= utc(plan.created_at) && utc(approval.window_end) <= utc(plan.expires_at) &&
    utc(approval.window_end) - utc(approval.window_start) >= approval.transaction_ms,
  "Signed approval is invalid or does not bind the exact plan, risk and window");
  return approval;
}

export function maintenanceBudget(approval) {
  const now = Date.now();
  requireFact(now >= utc(approval.window_start) && now + approval.transaction_ms < utc(approval.window_end),
    "An approved, unexpired maintenance window with its full SQL allowance is required");
  return approval.transaction_ms;
}

export function verifyBackup(backup, plan, planSha) {
  requireFact(backup && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(backup.bucket) &&
    /^[0-9]{12}$/.test(backup.owner_account) && /^[a-z0-9-]{1,32}$/.test(backup.region) &&
    /^stranded-prune\/[0-9a-f-]{36}\.json$/.test(backup.key) &&
    backup.key === `stranded-prune/${plan.operation_id}.json` &&
    typeof backup.version_id === "string" && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(backup.version_id) &&
    backup.version_id !== "null" && sha.test(backup.sha256) &&
    Number.isSafeInteger(backup.bytes) && backup.bytes > 0 && backup.bytes <= maxBundleBytes &&
    utc(backup.retain_until) > utc(plan.expires_at),
  "Backup identity, retention or size is invalid");

  const aws = (request, args) => {
    // Provider endpoint selection is fixed to AWS by this backup adapter.
    // AWS_PROFILE and the standard credential chain remain operator-managed.
    try {
      return JSON.parse(execFileSync("aws", ["--no-cli-pager", "--no-cli-auto-prompt", "--region", backup.region,
        "--cli-connect-timeout", "10", "--cli-read-timeout", "60", "s3api", request,
        "--bucket", backup.bucket, "--expected-bucket-owner", backup.owner_account, "--output", "json", ...args],
      { timeout: 90_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true" } }));
    } catch {
      throw new Error(`Private immutable backup check failed for AWS S3 ${request}`);
    }
  };
  const pab = aws("get-public-access-block", []).PublicAccessBlockConfiguration;
  requireFact(["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]
    .every((name) => pab?.[name] === true) && aws("get-bucket-policy-status", []).PolicyStatus?.IsPublic === false &&
    isDeepStrictEqual(aws("get-bucket-ownership-controls", []).OwnershipControls?.Rules,
      [{ ObjectOwnership: "BucketOwnerEnforced" }]), "Backup bucket privacy cannot be verified");
  const locator = ["--key", backup.key, "--version-id", backup.version_id];
  const head = aws("head-object", locator);
  requireFact(head.ContentLength === backup.bytes && head.VersionId === backup.version_id &&
    head.ObjectLockMode === "COMPLIANCE" &&
    Date.parse(head.ObjectLockRetainUntilDate) === utc(backup.retain_until),
  "Backup version is missing, changed or lacks verified compliance retention");
  const directory = mkdtempSync(join(tmpdir(), "stranded-prune-backup-"));
  const file = join(directory, "readback.json");
  try {
    const get = aws("get-object", [...locator, file]);
    const body = readBounded(file, backup.bytes);
    requireFact(get.VersionId === backup.version_id && get.ContentLength === backup.bytes &&
      body.length === backup.bytes && sha256Hex(body) === backup.sha256, "Immutable backup readback differs");
    const bundle = JSON.parse(body);
    requireFact(bundle.version === 1 && bundle.plan_sha256 === planSha && digest(bundle.plan) === planSha &&
      Array.isArray(bundle.source_rows) && bundle.source_rows.length === ROWS && digest(bundle.source_rows) === plan.source.raw_sha256 &&
      sha256Hex(Buffer.from(bundle.workflow_record, "base64")) === plan.baseline.workflow_record_sha256 &&
      sha256Hex(Buffer.from(bundle.workflow_log, "base64")) === plan.baseline.workflow_log_sha256 &&
      sha256Hex(Buffer.from(bundle.signed_baseline, "base64")) === plan.baseline_document_sha256 &&
      sha256Hex(Buffer.from(bundle.baseline_signature, "base64")) === plan.baseline_signature_sha256,
    "Backup does not contain the exact planned source and evidence bundle");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
