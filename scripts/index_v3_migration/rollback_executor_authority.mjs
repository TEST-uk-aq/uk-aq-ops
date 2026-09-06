#!/usr/bin/env node

import fs from "node:fs";
import { withOperatorPhase } from "./operator_execution.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { recoverySha256 } from "./recovery_journal_authority.mjs";

// Explicit local load/command closure, not the migration mutation directory
// scopes. Current reviewed machinery may evolve; every entry must match HEAD.
export const ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES = Object.freeze([
  "scripts/index_v3_migration/operator_execution.mjs",
  "scripts/index_v3_migration/v2_runtime_artifact.mjs",
  "scripts/index_v3_migration/v2_runtime_recovery.mjs",
  "scripts/index_v3_migration/capture_v2_runtime_authority.mjs",
  "scripts/index_v3_migration/index_v3_capture_operator_evidence.mjs",
  // Operator controls, evidence authentication, replay, restore orchestration.
  "scripts/index_v3_migration/rollback_executor_authority.mjs",
  "scripts/index_v3_migration/index_v3_migration.sh",
  "scripts/index_v3_migration/index_v3_preflight.sh",
  "scripts/index_v3_migration/index_v3_operator_evidence.mjs",
  "scripts/index_v3_migration/recovery_journal_authority.mjs",
  "scripts/index_v3_migration/recovery_post_migration_root_evidence.mjs",
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  "scripts/backup_r2/lib/observation_history_migration_v3.mjs",
  // Pinned Dropbox generation interpretation and v2 index rebuild/verification.
  "scripts/backup_r2/lib/hierarchical_backup_v2.mjs",
  "scripts/backup_r2/uk_aq_build_r2_history_index.mjs",
  "scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs",
  "workers/shared/uk_aq_r2_history_index.mjs",
  "workers/shared/uk_aq_r2_history_canonical.mjs",
  "workers/shared/uk_aq_r2_history_manifest_validation.mjs",
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs",
  "workers/shared/uk_aq_observation_content_hash.mjs",
  "workers/shared/uk_aq_observation_property_code.mjs",
  "workers/shared/uk_aq_r2_file_identity.mjs",
  // R2 transport, checksum publication, retained-session lock and child liveness.
  "workers/shared/r2_sigv4.mjs",
  "workers/shared/uk_aq_r2_checksum_publication.mjs",
  "workers/shared/uk_aq_r2_history_writer.mjs",
  "workers/shared/uk_aq_connector_day_gate.mjs",
  "workers/shared/uk_aq_prune_connector_source_identity.mjs",
  "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
  "scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs",
  // Runtime binding verification and preflight scheduler/freeze configuration.
  "workers/uk_aq_cache_proxy/resolve_station_history_service.sh",
  "cloudflare/scheduler/jobs.toml",
  "cloudflare/scheduler/wrangler.toml",
  // Third-party dependency authority and the migration module's eagerly loaded
  // v3/Parquet dependencies. Rollback does not run the v3 planner, so these are
  // current-trusted only, not historical planner-output authority.
  "package.json",
  "package-lock.json",
  "scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs",
  "workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs",
  "workers/shared/uk_aq_observation_history_index_v3.mjs",
  "workers/shared/uk_aq_observation_history_schema.mjs",
  "workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs",
  "workers/shared/uk_aq_observation_history_target_writer.mjs",
  "workers/shared/uk_aq_observation_history_writer_limits_v3.mjs",
]);

// These schemas/normalizers define the meaning of the OLD backup and canonical
// manifest/file evidence. Rebuilding derived v2 indexes and publishing exact
// pinned bytes use current machinery; neither redefines the restore selection.
export const ROLLBACK_PINNED_HISTORICAL_DEPENDENCIES = Object.freeze([
  "scripts/backup_r2/lib/hierarchical_backup_v2.mjs",
  "workers/shared/uk_aq_observation_content_hash.mjs",
  "workers/shared/uk_aq_observation_property_code.mjs",
  "workers/shared/uk_aq_r2_file_identity.mjs",
  "workers/shared/uk_aq_r2_history_canonical.mjs",
  "workers/shared/uk_aq_r2_history_manifest_validation.mjs",
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs",
]);

const MIGRATION_LIBRARY = "scripts/backup_r2/lib/observation_history_migration_v3.mjs";
const RECOVERY_IMPLEMENTATION_PATHS = Object.freeze([
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  MIGRATION_LIBRARY,
  "scripts/index_v3_migration/index_v3_migration.sh",
  "scripts/index_v3_migration/recovery_journal_authority.mjs",
]);

// Pin only the restore interpretation/selection portions of the mixed-purpose
// library, not its unrelated v3 planner, progress, retry or recovery orchestration.
// Exact source ranges deliberately fail closed on missing/duplicate boundaries;
// historical code is read as data and is never imported or executed.
export const ROLLBACK_PINNED_LIBRARY_RANGES = Object.freeze([
  ["export const OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION =", "const CANONICAL_STAGE_RANK ="],
  ["function stableObject(", "function updateRecoveryReplayDigest("],
  ["function sameJson(", "function canonicalJsonObject("],
  ["function requireHistoricalSortedCheckpointExpectedIdentity(", "async function reverifyPinnedSourceManifestReference("],
  ["function restoreStageForKey(", "export async function executeObservationHistoryV2Rollback("],
]);

function git(repositoryRoot, args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Rollback Git authority check failed: ${args.join(" ")}`);
  return result.stdout;
}

function readGithubRepository(repositoryRoot) {
  // gh resolves owner/repo from the same authenticated repository context used
  // by the operator tooling. One uncached query obtains branch name and commit
  // together; no local remote-tracking ref or hard-coded branch is authority.
  const result = spawnSync("gh", [
    "api", "graphql",
    "-F", "owner={owner}", "-F", "name={repo}",
    "-f", "query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner defaultBranchRef { name target { ... on Commit { oid } } } } }",
  ], { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("Rollback GitHub repository/default-branch identity could not be established by gh");
  let response;
  try { response = JSON.parse(result.stdout); } catch {
    throw new Error("Rollback GitHub repository/default-branch response is invalid JSON");
  }
  if (response?.errors?.length) throw new Error("Rollback GitHub repository/default-branch query failed");
  return response?.data?.repository;
}

export function validateRollbackReviewedHead({ repositoryRoot, resolveGithubRepository = readGithubRepository }) {
  let remote;
  try { remote = resolveGithubRepository(repositoryRoot); } catch (error) {
    throw new Error("Rollback GitHub repository/default-branch identity is unavailable", { cause: error });
  }
  if (typeof remote?.nameWithOwner !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(remote.nameWithOwner)) {
    throw new Error("Rollback GitHub repository identity is missing or invalid");
  }
  const branch = remote.defaultBranchRef?.name;
  if (typeof branch !== "string" || !branch.trim()) throw new Error("Rollback GitHub default branch could not be established");
  const githubHead = remote.defaultBranchRef?.target?.oid;
  if (!/^[0-9a-f]{40}$/.test(String(githubHead || ""))) throw new Error("Rollback GitHub default-branch HEAD could not be established");
  const localBranch = git(repositoryRoot, ["branch", "--show-current"]).toString().trim();
  if (localBranch !== branch) {
    throw new Error(`Rollback local branch ${localBranch || "(detached HEAD)"} differs from GitHub default branch ${branch}`);
  }
  const localHead = git(repositoryRoot, ["rev-parse", "HEAD"]).toString().trim();
  if (localHead !== githubHead) {
    throw new Error(`Rollback local HEAD ${localHead} differs from GitHub default-branch HEAD ${githubHead}`);
  }
  return Object.freeze({ repository: remote.nameWithOwner, branch, local_head: localHead, github_default_branch_head: githubHead });
}

function requireAncestor(repositoryRoot, commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ""))) throw new Error("Rollback historical Git SHA is malformed");
  git(repositoryRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  git(repositoryRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]);
}

function sourceRange(source, start, end) {
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => line.startsWith(start) ? [index] : []);
  const ends = lines.flatMap((line, index) => line.startsWith(end) ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(`Rollback historical semantic boundary is invalid: ${start}`);
  }
  return lines.slice(starts[0], ends[0]).join("\n");
}

export function validateRollbackDependencies({ repositoryRoot, targetWriterGitSha }) {
  requireAncestor(repositoryRoot, targetWriterGitSha);
  for (const dependency of ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES) {
    // Check the index AND actual bytes (including assume-unchanged files).
    // A symlink, missing/untracked path, staged edit or changed mode fails closed.
    const entry = git(repositoryRoot, ["ls-tree", "HEAD", "--", dependency]).toString();
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error(`Rollback dependency is not tracked at HEAD: ${dependency}`);
    const local = path.join(repositoryRoot, dependency);
    if (!fs.lstatSync(local).isFile() || !fs.readFileSync(local).equals(
      git(repositoryRoot, ["show", `HEAD:${dependency}`]),
    )) throw new Error(`Rollback current dependency differs from HEAD: ${dependency}`);
    git(repositoryRoot, ["diff", "--exit-code", "HEAD", "--", dependency]);
    git(repositoryRoot, ["diff", "--cached", "--exit-code", "HEAD", "--", dependency]);
  }
  for (const dependency of ROLLBACK_PINNED_HISTORICAL_DEPENDENCIES) {
    if (!git(repositoryRoot, ["show", `${targetWriterGitSha}:${dependency}`]).equals(
      git(repositoryRoot, ["show", `HEAD:${dependency}`]),
    )) throw new Error(`Rollback historical semantic dependency changed: ${dependency}`);
  }
  const historical = git(repositoryRoot, ["show", `${targetWriterGitSha}:${MIGRATION_LIBRARY}`]).toString();
  const current = git(repositoryRoot, ["show", `HEAD:${MIGRATION_LIBRARY}`]).toString();
  for (const [start, end] of ROLLBACK_PINNED_LIBRARY_RANGES) {
    if (sourceRange(historical, start, end) !== sourceRange(current, start, end)) {
      throw new Error(`Rollback historical restore semantics changed: ${start}`);
    }
  }
}

export async function authenticateRollbackExecutor({
  repositoryRoot, checkpointPath, migrationRunId, planSha256,
  targetWriterGitSha, transition, inventoryRootSha256, stateRootSha256,
  resolveGithubRepository = readGithubRepository,
}) {
  if (!String(migrationRunId || "").trim() || !["v2-to-v3", "v3-rebuild"].includes(transition) ||
      [planSha256, inventoryRootSha256, stateRootSha256].some((value) => !/^[0-9a-f]{64}$/.test(String(value || "")))) {
    throw new Error("Rollback requires explicit original run, transition, plan and backup identities");
  }
  // Executor trust only: never use the current GitHub HEAD as migration or
  // recovery authority. The resolver seam is for local tests, not a CLI bypass.
  const executorIdentity = await withOperatorPhase("Rollback: authenticating current executor", () => {
    const identity = validateRollbackReviewedHead({ repositoryRoot, resolveGithubRepository });
    validateRollbackDependencies({ repositoryRoot, targetWriterGitSha });
    return identity;
  });
  const body = fs.readFileSync(checkpointPath);
  const checkpoint = JSON.parse(body);
  const recoveryRoot = `${path.resolve(checkpointPath)}.recovery`;
  // The shared replay helper ensures an entries directory exists. Require the
  // original complete structure here so this path cannot create or repair it.
  if (!fs.statSync(path.join(recoveryRoot, "entries")).isDirectory() ||
      !fs.statSync(path.join(recoveryRoot, "head.json")).isFile() ||
      !fs.statSync(path.join(recoveryRoot, "manifest.json")).isFile()) {
    throw new Error("Rollback recovery authority structure is missing or invalid");
  }
  const { buildObservationHistoryV3RecoveryProgressContext } = await import(
    "../backup_r2/uk_aq_observation_history_migration_v3.mjs"
  );
  // Existing readAndValidateRecoveryJournal authenticates ALL entries before
  // applying updates. Replay once in memory, with create/repair disabled; no
  // completed-object evidence reaches rollback until every gate below passes.
  const recovery = await withOperatorPhase("Rollback: authenticating historical recovery journal", () => buildObservationHistoryV3RecoveryProgressContext({
    checkpointPath, checkpoint, repositoryRoot, requireCurrentImplementation: false,
  }));
  const implementation = recovery.manifest.payload.recovery_implementation;
  requireAncestor(repositoryRoot, implementation.repository_head);
  if (JSON.stringify(implementation.files.map((file) => file.path).sort()) !==
      JSON.stringify([...RECOVERY_IMPLEMENTATION_PATHS].sort())) {
    throw new Error("Rollback recovery implementation file set is incomplete or unsupported");
  }
  for (const file of implementation.files) {
    const historical = git(repositoryRoot, ["show", `${implementation.repository_head}:${file.path}`]);
    if (historical.byteLength !== file.byte_size || recoverySha256(historical) !== file.sha256) {
      throw new Error(`Rollback historical recovery implementation identity mismatch: ${file.path}`);
    }
  }
  const authority = recovery.checkpoint.authority;
  if (authority.migration_run_id !== migrationRunId || authority.plan_sha256 !== planSha256 ||
      authority.target_writer_git_sha !== targetWriterGitSha || authority.transition.kind !== transition ||
      authority.backup_gate?.inventory_root?.sha256 !== inventoryRootSha256 ||
      authority.backup_gate?.state_root?.sha256 !== stateRootSha256) {
    throw new Error("Rollback checkpoint differs from the original run, plan, writer, transition or backup authority");
  }
  if (git(repositoryRoot, ["rev-parse", "HEAD"]).toString().trim() !== executorIdentity.local_head ||
      git(repositoryRoot, ["branch", "--show-current"]).toString().trim() !== executorIdentity.branch) {
    throw new Error("Rollback local executor changed during authority authentication");
  }
  // Returned diagnostic metadata only; not part of checkpoint/manifest hashes.
  recovery.executor_identity = executorIdentity;
  return recovery;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [checkpointPath, migrationRunId, planSha256, targetWriterGitSha, transition,
      inventoryRootSha256, stateRootSha256] = process.argv.slice(2);
    if (process.argv.length !== 9) throw new Error("Rollback authority requires checkpoint, run, plan, writer, transition, inventory and state identities");
    await authenticateRollbackExecutor({
      repositoryRoot: path.resolve(path.dirname(process.argv[1]), "../.."),
      checkpointPath, migrationRunId, planSha256, targetWriterGitSha, transition,
      inventoryRootSha256, stateRootSha256,
    });
  } catch (error) {
    process.stderr.write(`Rollback executor is not authorized: ${error.message}\n`);
    process.exitCode = 1;
  }
}
