#!/usr/bin/env node
// Dedicated, fail-closed LIVE GCP admission for the existing shared side-by-side
// clean-build operator. No deployment, selector switch or writer release occurs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { admitGcpRunner, GCP_PROFILE } from "./lib/observation_history_migration_gcp.mjs";
import { main as sharedMain, buildObservationHistoryV3RecoveryProgressContext,
  createObservationHistoryMigrationExecutionContext, parseObservationHistoryMigrationArgs } from "./uk_aq_observation_history_migration_v3.mjs";
import { superviseOperatorInvocation, finishOperatorProgress } from "../index_v3_migration/operator_execution.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { hasRequiredR2Config, r2GetObject, sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import {
  EXCEPTIONAL_LIVE_RECOVERY,
  authenticateExceptionalRecovery,
  exceptionalRecoveryApprovalPhrase,
  exceptionalRecoveryCodeSha256,
  getExceptionalRecoveryCodeIdentity,
  validateExceptionalRecoveryApproval,
} from "../index_v3_migration/exceptional_recovery_authority.mjs";

const REPOSITORY = "UK-AQ/uk-aq-ops";
const BUCKET = "uk-aq-history-live";
const R2_ACCOUNT_ID = "7e20426335c509cc77483210fa7ead0f";
const REQUIRED_KEYS = Object.freeze(["--expected-gcp-project-id", "--expected-gcp-zone"]);

const HELP = `Usage:
  node scripts/backup_r2/uk_aq_observation_history_migration_v3_live_gcp.mjs \\
    --expected-gcp-project-id PROJECT_ID --expected-gcp-zone europe-west2-ZONE \\
    --environment LIVE --transition v2-to-v3 --mode plan|migrate|verify|locked-clean-build \\
    --expected-bucket uk-aq-history-live --target-writer-git-sha REVIEWED_SHA \\
    [other shared migration parameters]

This entry point requires an authenticated c4a-standard-32 Google Compute Engine
instance in the explicitly pinned GCP project and London zone; a clean main
checkout of UK-AQ/uk-aq-ops; the LIVE R2 account and bucket; and the existing
global observation lock, v2 source-root and empty-v3 clean-build safeguards.
Migrate requires --apply --writers-frozen and a fresh --checkpoint-out.
GCP clean-build resume with --checkpoint-in is not accepted for migration.
For the single pinned failed LIVE run, --exceptional-recovery permits only
--mode recovery-preflight (read-only) or --mode migrate with an exact
preflight-generated --recovery-approval-file; see the GCP operator README.
Resume must pin the original checkpoint as both --checkpoint-in and
--checkpoint-out and use its recorded concurrency settings. The exception does
not alter normal clean-build policy.
Locked clean build requires --apply --writers-frozen, a fresh checkpoint-out,
and an operator-created post-plan approval file while the same lock is held.
The TEST runner remains separate. No cut-over or scheduler change occurs.
`;

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 20000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`LIVE GCP admission could not verify ${name} ${args[0]}: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

function oneValue(argv, flag) {
  const indexes = argv.flatMap((value, i) => value === flag ? [i] : []);
  if (indexes.length !== 1 || !argv[indexes[0] + 1] ||
      argv[indexes[0] + 1].startsWith("--")) {
    throw new Error(`LIVE GCP admission requires exactly one ${flag}`);
  }
  return argv[indexes[0] + 1];
}

export function parseLiveArguments(argv) {
  const stripped = [];
  let exceptionalRecovery = false;
  let approvalFile = null;
  const expected = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--exceptional-recovery") {
      if (exceptionalRecovery) throw new Error("Exceptional recovery flag may be specified only once");
      exceptionalRecovery = true;
    } else if (flag === "--recovery-approval-file") {
      if (approvalFile || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("Exceptional recovery requires exactly one --recovery-approval-file");
      approvalFile = argv[++index];
    } else if (REQUIRED_KEYS.includes(flag)) {
      if (Object.hasOwn(expected, flag) || !argv[index + 1] ||
          argv[index + 1].startsWith("--")) {
        throw new Error(`LIVE GCP admission requires exactly one value for ${flag}`);
      }
      expected[flag] = argv[++index];
    } else {
      stripped.push(flag);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!expected[key]) throw new Error(`LIVE GCP admission requires ${key}`);
  }
  const projectId = expected["--expected-gcp-project-id"];
  const zone = expected["--expected-gcp-zone"];
  if (!/^[a-z][a-z0-9-]{5,62}$/.test(projectId)) {
    throw new Error("Expected GCP project ID is malformed");
  }
  if (!/^europe-west2-[a-z]$/.test(zone)) {
    throw new Error("LIVE migration requires an explicitly selected London GCE zone");
  }
  if (oneValue(stripped, "--environment") !== "LIVE" ||
      oneValue(stripped, "--transition") !== "v2-to-v3" ||
      oneValue(stripped, "--expected-bucket") !== BUCKET ||
      !/^[0-9a-f]{40}$/.test(oneValue(stripped, "--target-writer-git-sha"))) {
    throw new Error("LIVE migration identity, transition, bucket or writer SHA is inconsistent");
  }
  const mode = oneValue(stripped, "--mode");
  if (!new Set(["plan", "migrate", "verify", "locked-clean-build", "recovery-preflight"]).has(mode)) {
    throw new Error("LIVE GCP entry point only accepts plan/migrate/verify/locked-clean-build");
  }
  if (exceptionalRecovery) {
    if (!approvalFile || !new Set(["migrate", "recovery-preflight"]).has(mode) ||
        oneValue(stripped, "--environment") !== "LIVE" ||
        oneValue(stripped, "--migration-run-id") !== EXCEPTIONAL_LIVE_RECOVERY.run_id ||
        oneValue(stripped, "--expected-plan-sha256") !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
        oneValue(stripped, "--target-writer-git-sha") !== EXCEPTIONAL_LIVE_RECOVERY.original_commit ||
        !stripped.includes("--checkpoint-in")) {
      throw new Error("Exceptional recovery is restricted to its exact LIVE run, plan, original writer and existing checkpoint");
    }
    oneValue(stripped, "--checkpoint-out");
    if (path.resolve(oneValue(stripped, "--checkpoint-in")) !== path.resolve(oneValue(stripped, "--checkpoint-out"))) {
      throw new Error("Exceptional recovery must keep the authenticated original checkpoint as both input and output");
    }
    if (mode === "migrate" && (!stripped.includes("--apply") || !stripped.includes("--writers-frozen"))) {
      throw new Error("Exceptional recovery migrate requires explicit --apply and --writers-frozen");
    }
    if (mode === "recovery-preflight" && (stripped.includes("--apply") || stripped.includes("--writers-frozen"))) {
      throw new Error("Read-only recovery preflight does not accept mutation or writer-freeze flags");
    }
  } else if (mode === "recovery-preflight" || approvalFile) {
    throw new Error("Recovery preflight and approval require --exceptional-recovery");
  }
  if (new Set(["migrate", "locked-clean-build"]).has(mode) && !exceptionalRecovery) {
    if (stripped.includes("--checkpoint-in")) {
      throw new Error("LIVE GCP clean-build migration must start from a fresh plan, never a partial checkpoint");
    }
    // The shared side-by-side runner invokes the write operation from --mode.
    // Do not rely on the shared executor to require an explicit --apply flag.
    // The LIVE wrapper must independently require the complete operator GO.
    if (!stripped.includes("--apply") || !stripped.includes("--writers-frozen")) {
      throw new Error("LIVE migrate requires explicit --apply and --writers-frozen");
    }
    oneValue(stripped, "--checkpoint-out");
    if (mode === "migrate") {
      const planSha = oneValue(stripped, "--expected-plan-sha256");
      if (!/^[0-9a-f]{64}$/.test(planSha)) throw new Error("LIVE migrate requires an exact pinned 64-character migration plan SHA-256");
    } else {
      if (stripped.includes("--expected-plan-sha256")) throw new Error("Combined LIVE build requires post-plan approval, not a pre-plan SHA");
      oneValue(stripped, "--post-plan-approval-file");
    }
  }
  return { sharedArgv: stripped, projectId, zone, exceptionalRecovery, approvalFile, mode };
}

function assertLiveEnvironment(env = process.env) {
  const names = [env.UKAQ_ENV_NAME, env.UK_AQ_ENV_NAME, env.ENVIRONMENT]
    .filter((value) => String(value || "").trim());
  if (!names.length || names.some((value) => String(value).trim().toUpperCase() !== "LIVE") ||
      env.UK_AQ_R2_HISTORY_VERSION !== "v2" ||
      env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION !== "v2" ||
      env.CFLARE_R2_BUCKET !== BUCKET) {
    throw new Error("Loaded LIVE environment, v2 source generation, Integrity semantics or R2 bucket are inconsistent");
  }
  let endpoint;
  try { endpoint = new URL(env.CFLARE_R2_ENDPOINT); }
  catch { throw new Error("LIVE R2 endpoint is missing or malformed"); }
  if (endpoint.protocol !== "https:" ||
      endpoint.hostname !== `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("LIVE R2 endpoint must identify the reviewed LIVE Cloudflare account");
  }
}

function assertLiveRepository(writerSha, { exceptionalRecovery = false } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const remote = command("git", ["remote", "get-url", "origin"], root);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)UK-AQ\/uk-aq-ops(?:\.git)?\/?$/.test(remote)) {
    throw new Error("LIVE GCP migration requires UK-AQ/uk-aq-ops origin, not a TEST repository");
  }
  const currentHead = command("git", ["rev-parse", "HEAD"], root);
  if (command("git", ["branch", "--show-current"], root) !== "main" ||
      (!exceptionalRecovery && currentHead !== writerSha) ||
      command("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root)) {
    throw new Error("LIVE migration requires clean main at the explicitly reviewed writer SHA");
  }
  const githubMain = command("gh", ["api", `repos/${REPOSITORY}/commits/main`, "--jq", ".sha"], root);
  if (githubMain !== currentHead || currentHead !== writerSha) {
    if (!exceptionalRecovery || githubMain !== currentHead) {
      throw new Error("LIVE GitHub main differs from the exact reviewed recovery implementation");
    }
  }
}

function validateExceptionalRecoveryPreflightPaths(argv, approvalFile) {
  const value = (flag) => oneValue(argv, flag);
  const checkpointPath = path.resolve(value("--checkpoint-in"));
  const checkpointOutPath = path.resolve(value("--checkpoint-out"));
  const reportPath = path.resolve(value("--report-out"));
  const approvalPath = path.resolve(approvalFile);
  if (checkpointPath !== checkpointOutPath) {
    throw new Error("Exceptional recovery must keep the authenticated original checkpoint as both input and output");
  }
  const protectedPaths = ["", ".authority", ".staging", ".recovery", ".publication.json", ".exceptional-recovery-epochs"]
    .map((suffix) => `${checkpointPath}${suffix}`);
  for (const [label, candidate] of [["preflight report", reportPath], ["approval file", approvalPath]]) {
    if ((label === "approval file" && candidate === reportPath) ||
        protectedPaths.some((protectedPath) => candidate === protectedPath || candidate.startsWith(`${protectedPath}${path.sep}`))) {
      throw new Error(`Exceptional recovery ${label} must be outside checkpoint and journal paths`);
    }
  }
  return Object.freeze({ checkpointPath, reportPath, approvalPath,
    approvalAlreadyExists: fs.existsSync(approvalPath) });
}

function validateExceptionalRecoveryPreflightRequest(argv, approvalFile, runnerPermit) {
  const parsed = parseObservationHistoryMigrationArgs(argv, runnerPermit, { allowRecoveryPreflight: true });
  if (parsed.mode !== "recovery-preflight" || parsed.environment !== "LIVE" || parsed.transition !== "v2-to-v3" ||
      parsed.migrationRunId !== EXCEPTIONAL_LIVE_RECOVERY.run_id ||
      parsed.targetWriterGitSha !== EXCEPTIONAL_LIVE_RECOVERY.original_commit ||
      parsed.expectedPlanSha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
      !parsed.checkpointIn || !parsed.checkpointOut || path.resolve(parsed.checkpointIn) !== path.resolve(parsed.checkpointOut) ||
      parsed.apply || parsed.writersFrozen || !parsed.writerLimitsPath || !parsed.reportOut) {
    throw new Error("Exceptional recovery preflight arguments are incomplete or include mutation authority");
  }
  const paths = validateExceptionalRecoveryPreflightPaths(argv, approvalFile);
  if (paths.approvalAlreadyExists) throw new Error("Exceptional recovery approval file must not exist before preflight");
  return Object.freeze({ ...paths, parsed });
}

function writeExceptionalRecoveryPreflightReport(reportPath, report) {
  const fd = fs.openSync(reportPath, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok === true ? 0 : 1;
}

async function runExceptionalRecoveryPreflight({ argv, approvalFile, repositoryRoot, runnerPermit, request = null }) {
  const { parsed, checkpointPath, reportPath } = request || validateExceptionalRecoveryPreflightRequest(argv, approvalFile, runnerPermit);
  let auth;
  try {
    auth = authenticateExceptionalRecovery({ checkpointPath, repositoryRoot });
    const recoveryState = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath, checkpoint: auth.checkpoint, repositoryRoot,
      create: false, repairHead: false, allowInterruptedTail: true, requireCurrentImplementation: false,
      readOnly: true, authenticatedJournal: auth.journal,
    });
    const authenticatedSequence = auth.journal.interrupted_append?.sequence ?? auth.journal.last_sequence;
    const authenticatedEntrySha = auth.journal.interrupted_append?.payload_sha256 ?? auth.journal.last_entry_sha256;
    if (recoveryState.sequence !== authenticatedSequence || recoveryState.entrySha256 !== authenticatedEntrySha) {
      throw new Error("Recovery journal changed between authenticated preflight reads");
    }
    auth = Object.freeze({ ...auth, recoveryState });
  } catch (error) {
    const report = { kind: "uk_aq_observation_history_v3_exceptional_recovery_preflight_v1",
      ok: false, status: "recovery_preflight_blocked",
      generated_at_utc: new Date().toISOString(), read_only: true,
      checkpoint_authenticated: false, journal_authenticated: false,
      original_run_id: EXCEPTIONAL_LIVE_RECOVERY.run_id,
      original_plan_sha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
      original_implementation_commit: EXCEPTIONAL_LIVE_RECOVERY.original_commit,
      original_journal_anchor: { sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence,
        entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256 },
      source_root: { status: "not_checked" }, approval_phrase: null,
      blockers: [`checkpoint_or_journal_or_original_code_authentication_failed:${error.message}`] };
    return writeExceptionalRecoveryPreflightReport(reportPath, report);
  }
  const recordedRunner = auth.checkpoint.authority?.runner;
  const concurrencyMatches = Boolean(recordedRunner && recordedRunner.runner_kind === "gcp" &&
    recordedRunner.runner_profile === "gcp-c4a-32" && recordedRunner.inventory_concurrency === 48 &&
    recordedRunner.partition_concurrency === 16 && recordedRunner.publication_concurrency === 80 &&
    parsed.inventoryConcurrency === recordedRunner.inventory_concurrency &&
    parsed.partitionConcurrency === recordedRunner.partition_concurrency &&
    parsed.publicationConcurrency === recordedRunner.publication_concurrency);
  let sourceRoot = null;
  let sourceReadError = null;
  try {
    const config = resolveR2HistoryIndexConfig(process.env);
    if (!hasRequiredR2Config(config.r2) || config.r2.bucket !== "uk-aq-history-live") {
      throw new Error("Recovery preflight requires the exact configured LIVE history bucket");
    }
    const sourceObject = await r2GetObject({ r2: config.r2, key: EXCEPTIONAL_LIVE_RECOVERY.source_root_key });
    sourceRoot = { key: sourceObject.key, byte_size: sourceObject.bytes, sha256: sha256Hex(sourceObject.body) };
  } catch (error) {
    sourceReadError = error.message;
  }
  let identity = null;
  let codeSha = null;
  let implementationReadError = null;
  try {
    identity = getExceptionalRecoveryCodeIdentity(repositoryRoot);
    codeSha = exceptionalRecoveryCodeSha256(identity);
  } catch (error) {
    implementationReadError = error.message;
  }
  const sourceMatches = sourceRoot?.sha256 === EXCEPTIONAL_LIVE_RECOVERY.source_root_sha256 && sourceRoot?.byte_size === 559;
  const journal = auth.journal;
  const publicationCount = auth.recoveryState.publicationEvidence.length;
  const blockers = [];
  if (!concurrencyMatches) blockers.push("requested_concurrency_does_not_match_original_checkpoint_runner_48_16_80");
  if (!sourceMatches) blockers.push(sourceReadError
    ? `source_root_read_failed:${sourceReadError}`
    : "source_root_identity_differs_from_authorised_live_source");
  if (implementationReadError) blockers.push(`recovery_implementation_identity_unavailable:${implementationReadError}`);
  let approvalPhrase = null;
  if (blockers.length === 0) {
    try {
      approvalPhrase = exceptionalRecoveryApprovalPhrase({ auth, sourceRoot, codeSha,
        codeHead: identity.repository_head, runner: runnerPermit });
      if (typeof approvalPhrase !== "string" || !approvalPhrase.trim()) {
        blockers.push("approval_phrase_was_not_created");
      }
    } catch (error) {
      blockers.push(`approval_phrase_creation_failed:${error.message}`);
    }
  }
  const report = {
    kind: "uk_aq_observation_history_v3_exceptional_recovery_preflight_v1",
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "recovery_preflight_passed" : "recovery_preflight_blocked",
    generated_at_utc: new Date().toISOString(),
    read_only: true,
    environment: "LIVE",
    r2_account_id: R2_ACCOUNT_ID,
    bucket: BUCKET,
    runner: runnerPermit,
    original_checkpoint: journal.manifest.payload.original_checkpoint,
    original_checkpoint_authenticated: true,
    immutable_authority_sha256: journal.manifest.payload.immutable_authority_sha256,
    plan_sha256: journal.manifest.payload.plan_sha256,
    original_implementation: auth.originalImplementation,
    original_implementation_verified: true,
    recovery_implementation: identity,
    recovery_implementation_sha256: codeSha,
    journal: { authenticated: true, semantically_replayed: true,
      original_anchor_sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence,
      original_anchor_entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256,
      original_anchor_completed_objects: EXCEPTIONAL_LIVE_RECOVERY.authenticated_completed_objects,
      original_anchor_v3_publications: EXCEPTIONAL_LIVE_RECOVERY.authenticated_v3_publications,
      last_sequence: auth.recoveryState.sequence,
      committed_head_payload_sha256: journal.head.payload_sha256,
      last_entry_sha256: auth.recoveryState.entrySha256,
      interrupted_append_candidate: journal.interrupted_append ? {
        sequence: journal.interrupted_append.sequence,
        entry_sha256: journal.interrupted_append.payload_sha256,
      } : null,
      completed_objects: auth.recoveryState.completedEvidence.size,
      v3_publications: publicationCount },
    recovery_concurrency: {
      requested: { inventory: parsed.inventoryConcurrency, partition: parsed.partitionConcurrency,
        publication: parsed.publicationConcurrency },
      checkpoint_recorded: recordedRunner ? { inventory: recordedRunner.inventory_concurrency,
        partition: recordedRunner.partition_concurrency, publication: recordedRunner.publication_concurrency } : null,
      matches_original_48_16_80: concurrencyMatches,
    },
    recovery_epoch_ledger: { sequence: auth.recoveryEpoch.sequence,
      last_epoch_sha256: auth.recoveryEpoch.last_epoch_sha256,
      next_sequence: auth.recoveryEpoch.next_sequence,
      previous_epoch_sha256: auth.recoveryEpoch.previous_epoch_sha256 },
    expected_v3_publication_objects: EXCEPTIONAL_LIVE_RECOVERY.expected_v3_publications,
    remaining_v3_publication_objects: EXCEPTIONAL_LIVE_RECOVERY.expected_v3_publications - publicationCount,
    source_root: sourceRoot ? { ...sourceRoot, status: sourceMatches ? "matches_authorised_identity" : "identity_mismatch" }
      : { status: "unavailable", read_error: sourceReadError },
    blockers,
    writers_frozen_confirmation_required_at_migrate: true,
    approval_file: path.resolve(approvalFile),
    approval_phrase: blockers.length === 0 ? approvalPhrase : null,
  };
  return writeExceptionalRecoveryPreflightReport(reportPath, report);
}

export async function mainLiveGcp({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const { sharedArgv, projectId, zone, exceptionalRecovery, approvalFile, mode } = parseLiveArguments(argv);
  if (exceptionalRecovery && mode === "recovery-preflight") {
    const paths = validateExceptionalRecoveryPreflightPaths(sharedArgv, approvalFile);
    if (paths.approvalAlreadyExists) {
      return writeExceptionalRecoveryPreflightReport(paths.reportPath, {
        kind: "uk_aq_observation_history_v3_exceptional_recovery_preflight_v1",
        ok: false,
        status: "recovery_preflight_blocked",
        generated_at_utc: new Date().toISOString(),
        read_only: true,
        environment: "LIVE",
        checkpoint_authenticated: false,
        journal_authenticated: false,
        original_run_id: EXCEPTIONAL_LIVE_RECOVERY.run_id,
        original_plan_sha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
        original_implementation_commit: EXCEPTIONAL_LIVE_RECOVERY.original_commit,
        original_journal_anchor: { sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence,
          entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256 },
        source_root: { status: "not_checked" },
        approval_phrase: null,
        blockers: ["approval_file_must_not_exist_before_preflight"],
      });
    }
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    let runnerPermit;
    let request;
    try {
      assertLiveEnvironment();
      const requestedCodeHead = command("git", ["rev-parse", "HEAD"], repositoryRoot);
      assertLiveRepository(requestedCodeHead, { exceptionalRecovery: true });
      runnerPermit = await admitGcpRunner({ profile: GCP_PROFILE });
      if (runnerPermit.project_id !== projectId || runnerPermit.zone !== zone ||
          runnerPermit.machine_type !== "c4a-standard-32") {
        throw new Error("GCE metadata disagrees with explicitly reviewed LIVE GCP project, zone or machine");
      }
      request = validateExceptionalRecoveryPreflightRequest(sharedArgv, approvalFile, runnerPermit);
      process.stderr.write(`LIVE GCE admission: ${JSON.stringify(runnerPermit)}\n`);
    } catch (error) {
      return writeExceptionalRecoveryPreflightReport(paths.reportPath, {
        kind: "uk_aq_observation_history_v3_exceptional_recovery_preflight_v1",
        ok: false,
        status: "recovery_preflight_blocked",
        generated_at_utc: new Date().toISOString(),
        read_only: true,
        environment: "LIVE",
        runner: runnerPermit || null,
        checkpoint_authenticated: false,
        journal_authenticated: false,
        original_run_id: EXCEPTIONAL_LIVE_RECOVERY.run_id,
        original_plan_sha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
        original_implementation_commit: EXCEPTIONAL_LIVE_RECOVERY.original_commit,
        original_journal_anchor: { sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence,
          entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256 },
        source_root: { status: "not_checked" },
        approval_phrase: null,
        blockers: [`gcp_or_repository_admission_failed:${error.message}`],
      });
    }
    return runExceptionalRecoveryPreflight({ argv: sharedArgv, approvalFile,
      repositoryRoot, runnerPermit, request });
  }
  assertLiveEnvironment();
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const requestedCodeHead = exceptionalRecovery
    ? command("git", ["rev-parse", "HEAD"], repositoryRoot)
    : oneValue(sharedArgv, "--target-writer-git-sha");
  assertLiveRepository(requestedCodeHead, { exceptionalRecovery });
  const runnerPermit = await admitGcpRunner({ profile: GCP_PROFILE });
  if (runnerPermit.project_id !== projectId || runnerPermit.zone !== zone ||
      runnerPermit.machine_type !== "c4a-standard-32") {
    throw new Error("GCE metadata disagrees with explicitly reviewed LIVE GCP project, zone or machine");
  }
  process.stderr.write(`LIVE GCE admission: ${JSON.stringify(runnerPermit)}\n`);
  let exceptionalRecoveryApproval = null;
  if (exceptionalRecovery) {
    const auth = authenticateExceptionalRecovery({ checkpointPath: oneValue(sharedArgv, "--checkpoint-in"), repositoryRoot });
    const config = resolveR2HistoryIndexConfig(process.env);
    const sourceObject = await r2GetObject({ r2: config.r2, key: EXCEPTIONAL_LIVE_RECOVERY.source_root_key });
    const sourceRoot = { key: sourceObject.key, byte_size: sourceObject.bytes, sha256: sha256Hex(sourceObject.body) };
    const identity = getExceptionalRecoveryCodeIdentity(repositoryRoot);
    const expectedPhrase = exceptionalRecoveryApprovalPhrase({ auth, sourceRoot,
      codeSha: exceptionalRecoveryCodeSha256(identity), codeHead: identity.repository_head, runner: runnerPermit });
    exceptionalRecoveryApproval = validateExceptionalRecoveryApproval({ filePath: approvalFile, expectedPhrase,
      validFromMs: Date.now() - 30 * 60 * 1000, auth, sourceRoot,
      codeSha: exceptionalRecoveryCodeSha256(identity), runner: runnerPermit });
    process.stderr.write(`Exceptional LIVE recovery approval authenticated sha256=${exceptionalRecoveryApproval.approval_file_sha256}\n`);
  }
  // Preserve the full invocation for re-entry by the lock-holding child. That
  // child must independently re-establish both LIVE and GCE admission.
  const effectiveSharedArgv = [];
  for (let index = 0; index < sharedArgv.length; index += 1) {
    if (sharedArgv[index] === "--exceptional-recovery" || sharedArgv[index] === "--recovery-approval-file") {
      if (sharedArgv[index] === "--recovery-approval-file") index += 1;
      continue;
    }
    effectiveSharedArgv.push(sharedArgv[index]);
  }
  return sharedMain({
    argv: effectiveSharedArgv, reentryArgv: argv, runnerPermit,
    entrypoint: fileURLToPath(import.meta.url), exceptionalRecoveryApproval,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const recoveryPreflight = process.argv.includes("--exceptional-recovery") &&
    process.argv.some((value, index) => value === "--mode" && process.argv[index + 1] === "recovery-preflight");
  const execution = recoveryPreflight || process.env.UK_AQ_OPERATOR_SUPERVISED === "1" ||
    process.argv.includes("--help") || process.argv.includes("-h")
    ? mainLiveGcp()
    : superviseOperatorInvocation(process.argv[1], process.argv.slice(2));
  execution.then((code) => {
    finishOperatorProgress(code ? "failed" : "complete");
    process.exitCode = code;
  }).catch((error) => {
    finishOperatorProgress("failed");
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
