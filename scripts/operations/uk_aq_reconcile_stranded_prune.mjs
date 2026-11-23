import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import { withObservationsGlobalOperationLock } from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  askApproval, backupLocator, maintenanceBudget, readBounded, utc, validateApproval, validateBaseline, verifyBackup, writePrivate,
} from "./lib/stranded_prune_authority.mjs";
import { readSelectedHistory } from "./lib/stranded_prune_history.mjs";
import {
  CommitOutcomeUnknown, CommittedNeedsInspection, digest, encodeMultiset, executeTransaction, IMPACT, LIMITATION,
  MAX_LOCK_MS, MAX_TRANSACTION_MS, PREDICATE, readCounts, readEvidence, readPartitionLayout, readReceipts,
  readSource, requireFact, scopeArgs,
} from "./lib/stranded_prune_source.mjs";

const SESSION_HEARTBEAT_DISABLED_MS = 2_147_483_647;
const TABLE_FENCE = "LOCK TABLE uk_aq_core.observations IN SHARE ROW EXCLUSIVE MODE";
const helpText = `Usage
  node scripts/operations/uk_aq_reconcile_stranded_prune.mjs [plan] --directory DIR --backup-prefix REMOTE:DIR --expires-at UTC
  node scripts/operations/uk_aq_reconcile_stranded_prune.mjs execute --directory DIR
  node scripts/operations/uk_aq_reconcile_stranded_prune.mjs inspect --directory DIR
See docs/stranded_prune_reconciliation.md.`;

function configuration(env) {
  const connectionString = env.SUPABASE_DB_URL || env.DATABASE_URL;
  requireFact(connectionString, "An explicit session-preserving IngestDB connection is required");
  let db;
  let r2Endpoint;
  try {
    db = new URL(connectionString);
    r2Endpoint = new URL(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT);
  } catch {
    throw new Error("IngestDB or canonical R2 endpoint is absent or invalid");
  }
  requireFact(["postgresql:", "postgres:"].includes(db.protocol) && db.hostname && db.username &&
    db.pathname.length > 1 && db.searchParams.get("sslmode") === "verify-full" &&
    db.port !== "6543", "Direct/session-mode PostgreSQL URL with sslmode=verify-full is required");
  requireFact(r2Endpoint.protocol === "https:" && !r2Endpoint.username && !r2Endpoint.password &&
    !r2Endpoint.search && !r2Endpoint.hash && r2Endpoint.pathname === "/",
  "Canonical R2 requires an explicit HTTPS endpoint");
  const r2 = {
    endpoint: r2Endpoint.origin,
    bucket: env.R2_BUCKET || env.CFLARE_R2_BUCKET,
    access_key_id: env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID,
    secret_access_key: env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY,
    region: env.CFLARE_R2_REGION || env.R2_REGION || "auto",
  };
  requireFact(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(r2.bucket) &&
    r2.access_key_id?.trim() && r2.secret_access_key?.trim(), "Canonical R2 bucket or read credentials are missing");
  return {
    connectionString, r2,
    connection_sha256: digest([db.host, db.pathname, db.username]),
    r2_target_sha256: digest([r2.endpoint, r2.bucket, r2.region]),
  };
}

async function withDatabase(config, callback) {
  const client = new Client({
    connectionString: config.connectionString, application_name: "stranded_prune_reconciliation",
    connectionTimeoutMillis: 10_000, query_timeout: 135_000, statement_timeout: MAX_TRANSACTION_MS,
  });
  // The original writer lock also listens for session failure during its lifetime.
  client.on("error", () => {});
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function readOnly(client, callback) {
  await client.query("begin isolation level repeatable read read only");
  try {
    await client.query("set local time zone 'UTC'");
    await client.query("set local row_security = off");
    const result = await callback();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function databaseIdentity(client, config) {
  const { rows: [row] } = await client.query(`select oid::text, datname,
    current_setting('server_version_num')::integer as server_version
    from pg_database where datname = current_database()`);
  requireFact(row?.oid && row.server_version >= 170000, "IngestDB must support PostgreSQL 17+ transaction_timeout");
  return { connection_sha256: config.connection_sha256, database_oid: row.oid,
    database_name: row.datname, server_version: row.server_version };
}

function loadProvenance(directory) {
  const baselineBody = readBounded(join(directory, "baseline.json"), 64 * 1024);
  const baseline = JSON.parse(baselineBody);
  const workflow = readBounded(join(directory, "workflow.json"), 8 * 1024 * 1024);
  const log = readBounded(join(directory, "workflow.log"), 32 * 1024 * 1024);
  validateBaseline(baseline, workflow, log);
  return { baseline, baselineBody, workflow, log, baselineSha: sha256Hex(baselineBody) };
}

async function createPlan({ client, lock, config, directory, operation, provenance, expires, locator }) {
  const { baseline, baselineSha } = provenance;
  const db = await readOnly(client, async () => {
    const target = await databaseIdentity(client, config);
    requireFact((await readReceipts(client, { baseline, operation_id: operation })).length === 0, "Reconciliation has already been recorded");
    const layout = await readPartitionLayout(client);
    const evidence = await readEvidence(client, baseline);
    return { target, layout, evidence, source: await readSource(client, baseline) };
  });
  const history = await readSelectedHistory({ r2: config.r2, baseline, lock });
  requireFact(isDeepStrictEqual(history.encoded, encodeMultiset(db.source.canonical)),
    "Selected R2 Parquet multiset differs from IngestDB");
  requireFact(Date.now() < utc(expires), "Repeated verification requires a new plan expiry");
  const plan = {
    version: 2, operation_id: operation, created_at: new Date().toISOString(), expires_at: expires,
    baseline, baseline_document_sha256: baselineSha, database: db.target, r2_target_sha256: config.r2_target_sha256,
    layout: db.layout, evidence: db.evidence, source: db.source.summary, history: history.proof,
    deletion: { table: "uk_aq_core.observations", predicate: PREDICATE, parameters: scopeArgs(baseline),
      isolation: "REPEATABLE READ", fence: TABLE_FENCE, max_transaction_ms: MAX_TRANSACTION_MS, max_lock_ms: MAX_LOCK_MS },
    row_incarnation_limitation: LIMITATION, write_fence_impact: IMPACT,
    backup: { locator, local_file: "backup-bundle.json",
      restore: "Retain both private copies. See the runbook for exact-row restoration under separate approval." },
  };
  const planSha = digest(plan);
  writePrivate(join(directory, "backup-bundle.json"), {
    version: 2, plan_sha256: planSha, plan, source_rows: db.source.rows,
    baseline_document: provenance.baselineBody.toString("base64"),
    workflow_record: provenance.workflow.toString("base64"), workflow_log: provenance.log.toString("base64"),
  });
  writePrivate(join(directory, "plan.json"), { plan_sha256: planSha, plan });
  return { result: "planned", operation_id: operation, plan_sha256: planSha, backup_locator: locator };
}

async function inspectOperation({ config, lock, plan, planSha, approval = null, expected = null, reportPath }) {
  const report = await withDatabase(config, (client) => readOnly(client, async () => {
    requireFact(isDeepStrictEqual(await databaseIdentity(client, config), plan.database), "Inspection database differs from the plan");
    const receipts = await readReceipts(client, plan);
    const counts = await readCounts(client, plan.baseline);
    let evidenceMatches = false;
    try { evidenceMatches = isDeepStrictEqual(await readEvidence(client, plan.baseline), plan.evidence); } catch { /* report mismatch */ }
    const receipt = receipts[0] ?? null;
    let approvalMatches = false;
    if (receipt) {
      try {
        const recorded = validateApproval(receipt.approval, plan, planSha);
        approvalMatches = (!approval || isDeepStrictEqual(recorded, approval)) &&
          receipt.approval_sha256 === digest(recorded) && receipt.approval_reference === recorded.reference &&
          isDeepStrictEqual(receipt.backup, recorded.backup);
      } catch { /* report mismatch */ }
    }
    const receiptMatches = receipts.length === 1 && receipt.day_utc === plan.baseline.day_utc &&
      receipt.connector_id === plan.baseline.connector_id && receipt.operation_id === plan.operation_id &&
      receipt.original_run_id === plan.baseline.original_run_id && receipt.plan_sha256 === planSha &&
      receipt.source_sha256 === plan.baseline.source_content_hash && receipt.manifest_sha256 === plan.baseline.manifest_hash &&
      receipt.deleted_rows === plan.baseline.row_count && approvalMatches &&
      typeof receipt.transaction_id === "string" && /^\d+$/.test(receipt.transaction_id) &&
      (!expected || isDeepStrictEqual(receipt, expected));
    return { counts, evidence_matches: evidenceMatches, receipt, receipt_matches: receiptMatches,
      database_outcome: receiptMatches ? "committed_receipt" : receipts.length ? "conflicting_receipt" : "no_receipt" };
  }));
  try {
    const current = await readSelectedHistory({ r2: config.r2, baseline: plan.baseline, lock });
    report.history_matches = isDeepStrictEqual(current.proof, plan.history);
  } catch {
    report.history_matches = false;
  }
  const complete = report.receipt_matches && report.evidence_matches &&
    report.counts.raw === 0 && report.counts.canonical === 0 && report.history_matches;
  report.status = complete ? "verified_committed" : "review_required";
  report.plan_sha256 = planSha;
  report.operation_id = plan.operation_id;
  report.inspected_at = new Date().toISOString();
  writePrivate(reportPath, { report_sha256: digest(report), report });
  return { result: report.status, database_outcome: report.database_outcome };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    directory: { type: "string" }, "backup-prefix": { type: "string" },
    "expires-at": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(helpText); return; }
  const command = positionals[0] ?? "plan";
  requireFact(positionals.length <= 1 && ["plan", "execute", "inspect"].includes(command), "Unknown operation");
  requireFact(values.directory, "An evidence directory is required");
  const directory = values.directory;
  const stat = lstatSync(directory);
  requireFact(stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(),
    "Use an operator-owned evidence directory with mode 0700");
  const config = configuration(env);
  const provenance = loadProvenance(directory);
  let operation = randomUUID();
  let plan;
  let planSha;
  let approval;
  let locator;
  const attemptPath = join(directory, "execution-attempt.json");
  if (command === "plan") {
    const expires = utc(values["expires-at"]);
    requireFact(expires > Date.now() && expires <= Date.now() + 86_400_000, "Plan expiry must be within 24 hours");
    locator = backupLocator(values["backup-prefix"], operation);
  } else {
    requireFact(!values["expires-at"] && !values["backup-prefix"], "Expiry and backup destination can only be set during plan");
    ({ plan, plan_sha256: planSha } = JSON.parse(readBounded(join(directory, "plan.json"))));
    requireFact(plan?.version === 2 && planSha === digest(plan) &&
      isDeepStrictEqual(plan.baseline, provenance.baseline) && plan.baseline_document_sha256 === provenance.baselineSha &&
      plan.r2_target_sha256 === config.r2_target_sha256,
    "Plan or its target and original provenance changed");
    operation = plan.operation_id;
    if (command === "execute") {
      requireFact(!existsSync(attemptPath), "Execution already attempted. Use read-only inspect.");
      const bundlePath = join(directory, "backup-bundle.json");
      approval = await askApproval(plan, planSha, bundlePath);
      verifyBackup(approval.backup, plan, planSha, bundlePath);
    } else if (existsSync(attemptPath)) {
      const attempt = JSON.parse(readBounded(attemptPath));
      approval = validateApproval(attempt.approval, plan, planSha);
      requireFact(attempt.approval_sha256 === digest(approval), "Saved execution-attempt approval differs from its digest");
    }
  }
  let committed = false;
  try {
    const outcome = await withDatabase(config, (client) => withObservationsGlobalOperationLock({
      client, owner: "stranded_prune_reconciliation", runId: operation, timeoutMs: MAX_LOCK_MS,
      // Use the exact session that owns the lock and explicit assertions at the
      // critical points. A scheduled heartbeat SELECT must never precede LOCK
      // in the transaction. Bounded phases finish well before this timer.
      heartbeatMs: SESSION_HEARTBEAT_DISABLED_MS,
    }, async (_identity, lock) => {
      await lock.assertOwned();
      if (command === "plan") return createPlan({ client, lock, config, directory, operation, provenance,
        expires: values["expires-at"], locator });
      if (command === "inspect") return inspectOperation({
        config, lock, plan, planSha, approval, reportPath: join(directory, `inspection-${randomUUID()}.json`),
      });

      const assertWindow = () => maintenanceBudget(approval);
      requireFact(isDeepStrictEqual(await databaseIdentity(client, config), plan.database), "Execution database differs from the plan");
      requireFact((await readReceipts(client, plan)).length === 0, "Reconciliation already committed or operation identity used");
      const current = await readSelectedHistory({ r2: config.r2, baseline: plan.baseline, lock });
      requireFact(isDeepStrictEqual(current.proof, plan.history) &&
        current.proof.canonical_multiset_sha256 === plan.source.canonical_multiset_sha256,
      "Selected R2 canonical or index authority changed since planning");
      await lock.assertOwned();
      assertWindow();
      writePrivate(attemptPath, {
        operation_id: operation, plan_sha256: planSha, approval, approval_sha256: digest(approval), attempted_at: new Date().toISOString(),
      });
      const receipt = await executeTransaction({ client, lock, plan, planSha, approval, assertWindow });
      committed = true;
      const verified = await inspectOperation({
        config, lock, plan, planSha, approval, expected: receipt, reportPath: join(directory, "post-commit.json"),
      });
      if (verified.result !== "verified_committed") throw new CommittedNeedsInspection("COMMIT acknowledged. Independent checks require review. Use inspect.");
      return verified;
    }));
    if (outcome.result === "review_required") process.exitCode = 2;
    console.log(JSON.stringify(outcome));
  } catch (error) {
    if (committed && !(error instanceof CommittedNeedsInspection)) {
      throw new CommittedNeedsInspection("COMMIT acknowledged. Post-commit verification or reporting failed. Use inspect.", { cause: error });
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const status = error instanceof CommitOutcomeUnknown ? "commit_outcome_unknown" :
      error instanceof CommittedNeedsInspection ? "committed_needs_inspection" : "blocked";
    // PostgreSQL and filesystem errors can contain observations, paths or values.
    const known = { "55P03": "Lock contention or lock timeout", "57014": "SQL statement deadline exceeded",
      "25P04": "SQL transaction deadline exceeded", "40001": "Concurrent change rolled back", "40P01": "Deadlock rolled back",
      EEXIST: "Evidence file or one-time attempt already exists", ENOENT: "Required evidence file is missing" };
    const message = known[error.code] || (error.code || error instanceof SyntaxError
      ? "Operation failed. Inspect the protected evidence and database state before any further action."
      : error.message);
    console.error(JSON.stringify({ status, message }));
    process.exitCode = 2;
  });
}
