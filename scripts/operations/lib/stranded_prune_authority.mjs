import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";

import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { connectorManifestKey } from "./stranded_prune_history.mjs";
import { digest, IMPACT, LIMITATION, MAX_LOCK_MS, MAX_TRANSACTION_MS, requireFact } from "./stranded_prune_source.mjs";

const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxBundleBytes = 128 * 1024 * 1024;
const backupAttestation = "I verified the destination is private and retains an independent durable copy of the exact local bundle.";
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
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  requireFact(body.length <= maxBundleBytes, "Evidence exceeds the supported size");
  writeFileSync(path, body, { flag: "wx", mode: 0o600, flush: true });
}

export function utc(value) {
  requireFact(typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value, "A canonical UTC instant is required");
  return Date.parse(value);
}

export function validateBaseline(baseline, workflow, log) {
  const start = utc(`${baseline.day_utc}T00:00:00.000Z`);
  const cutoff = utc(baseline.publication_cutoff);
  requireFact(baseline.version === 2 && Number.isInteger(baseline.connector_id) &&
    baseline.connector_id > 0 && baseline.connector_id <= 2_147_483_647 &&
    Number.isInteger(baseline.row_count) && baseline.row_count > 0 && baseline.row_count <= 2_147_483_647 &&
    Array.isArray(baseline.hourly_counts) && baseline.hourly_counts.length === 24 &&
    baseline.hourly_counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    baseline.hourly_counts.reduce((sum, count) => sum + count, 0) === baseline.row_count &&
    Array.isArray(baseline.pollutants) && baseline.pollutants.length > 0 && baseline.pollutants.length <= baseline.row_count &&
    baseline.pollutants.every((code, index) => typeof code === "string" && code.length > 0 &&
      (index === 0 || baseline.pollutants[index - 1] < code)) &&
    baseline.manifest_key === connectorManifestKey(baseline.day_utc, baseline.connector_id) &&
    sha.test(baseline.manifest_hash) && sha.test(baseline.source_content_hash) && uuid.test(baseline.original_run_id) &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(baseline.workflow_url) &&
    cutoff >= start + 86_400_000 && cutoff <= Date.now() &&
    baseline.workflow_record_sha256 === sha256Hex(workflow) && baseline.workflow_log_sha256 === sha256Hex(log),
  "Incident baseline is malformed or differs from its workflow evidence");
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
  requireFact(Number(publication.expected_row_count) === baseline.row_count &&
    Number(publication.written_row_count) === baseline.row_count &&
    Number(publication.source_identity_rows) === baseline.row_count && publication.source_identity_contract_version === 1 &&
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

export function backupLocator(prefix, operation) {
  requireFact(typeof prefix === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*:[a-zA-Z0-9][a-zA-Z0-9_. /-]*$/.test(prefix) &&
    prefix.length <= 512 && prefix.trim() === prefix &&
    prefix.split(":")[1].split("/").every((part) => part && part !== "." && part !== "..") &&
    uuid.test(operation), "Use a configured private rclone remote and directory in remote:path form");
  return `${prefix}/stranded-prune/${operation}.json`;
}

export function validateApproval(approval, plan, planSha) {
  requireFact(approval?.version === 2 && approval.operation_id === plan.operation_id &&
    approval.plan_sha256 === planSha && sha.test(planSha) &&
    approval.connector_id === plan.baseline.connector_id && approval.day_utc === plan.baseline.day_utc &&
    approval.row_count === plan.baseline.row_count &&
    approval.backup?.locator === plan.backup.locator && sha.test(approval.backup.sha256) &&
    Number.isInteger(approval.backup.bytes) && approval.backup.bytes > 0 && approval.backup.bytes <= maxBundleBytes &&
    approval.accepted_private_durable_backup === backupAttestation &&
    typeof approval.reference === "string" && /^[\x20-\x7e]{1,256}$/.test(approval.reference) && approval.reference.trim() &&
    approval.accepted_row_incarnation_limitation === plan.row_incarnation_limitation && plan.row_incarnation_limitation === LIMITATION &&
    approval.accepted_cross_connector_impact === plan.write_fence_impact && plan.write_fence_impact === IMPACT &&
    Number.isSafeInteger(approval.transaction_ms) && approval.transaction_ms > 0 && approval.transaction_ms <= MAX_TRANSACTION_MS &&
    Number.isSafeInteger(approval.lock_ms) && approval.lock_ms > 0 && approval.lock_ms <= MAX_LOCK_MS &&
    approval.lock_ms <= approval.transaction_ms &&
    utc(approval.window_start) >= utc(plan.created_at) && utc(approval.window_end) <= utc(plan.expires_at) &&
    utc(approval.window_end) - utc(approval.window_start) > approval.transaction_ms,
  "Manual approval does not bind the exact plan, backup, risks and window");
  return approval;
}

export async function askApproval(plan, planSha, bundlePath) {
  requireFact(process.stdin.isTTY && process.stdout.isTTY, "Execution requires interactive approval in a terminal");
  const local = readBounded(bundlePath);
  const { connector_id, day_utc, row_count } = plan.baseline;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reference = await prompt.question("Operator name and approval reference: ");
    const windowStart = await prompt.question("Maintenance window start (UTC, including milliseconds): ");
    const windowEnd = await prompt.question("Maintenance window end (UTC, including milliseconds): ");
    const transactionMs = Number(await prompt.question(`Maximum cross-connector write block in ms (up to ${MAX_TRANSACTION_MS}): `));
    const lockMs = Number(await prompt.question(`Maximum recursive lock wait in ms (up to ${MAX_LOCK_MS}): `));
    const backupSha = await prompt.question("SHA-256 reviewed for the independently retained backup: ");
    requireFact(backupSha === sha256Hex(local), "Approved backup checksum differs from the local bundle");
    const approval = validateApproval({
      version: 2, operation_id: plan.operation_id, plan_sha256: planSha, connector_id, day_utc, row_count,
      reference, window_start: windowStart, window_end: windowEnd, transaction_ms: transactionMs, lock_ms: lockMs,
      backup: { locator: plan.backup.locator, sha256: backupSha, bytes: local.length },
      accepted_private_durable_backup: backupAttestation,
      accepted_row_incarnation_limitation: LIMITATION, accepted_cross_connector_impact: IMPACT,
    }, plan, planSha);
    maintenanceBudget(approval);
    console.log(JSON.stringify(approval, null, 2));
    const confirmation = `APPROVE ${planSha} ${plan.operation_id} ${connector_id}/${day_utc} ${row_count}`;
    const answer = await prompt.question(`To accept these exact details and risks, enter:\n${confirmation}\n> `);
    requireFact(answer === confirmation, "Operator did not confirm this exact plan and operation");
    return approval;
  } finally {
    prompt.close();
  }
}

export function maintenanceBudget(approval) {
  const now = Date.now();
  requireFact(now >= utc(approval.window_start) && now + approval.transaction_ms < utc(approval.window_end),
    "An approved, unexpired maintenance window with its full SQL allowance is required");
  return approval.transaction_ms;
}

function readRemoteBackup(locator, expectedBytes) {
  try {
    return execFileSync("rclone", ["cat", locator, "--retries", "1", "--low-level-retries", "1"],
      { timeout: 90_000, maxBuffer: expectedBytes + 1, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Independent readback from the configured private backup failed");
  }
}

export function verifyBackup(backup, plan, planSha, bundlePath, readRemote = readRemoteBackup) {
  const body = readRemote(backup.locator, backup.bytes);
  requireFact(body.length === backup.bytes && sha256Hex(body) === backup.sha256 &&
    body.equals(readBounded(bundlePath, backup.bytes)), "Private backup readback differs from the approved local bundle");
  const bundle = JSON.parse(body);
  requireFact(bundle.version === 2 && bundle.plan_sha256 === planSha && digest(bundle.plan) === planSha &&
    Array.isArray(bundle.source_rows) && bundle.source_rows.length === plan.baseline.row_count &&
    digest(bundle.source_rows) === plan.source.raw_sha256 &&
    sha256Hex(Buffer.from(bundle.workflow_record, "base64")) === plan.baseline.workflow_record_sha256 &&
    sha256Hex(Buffer.from(bundle.workflow_log, "base64")) === plan.baseline.workflow_log_sha256 &&
    sha256Hex(Buffer.from(bundle.baseline_document, "base64")) === plan.baseline_document_sha256,
  "Backup does not contain the exact planned source and evidence bundle");
}
