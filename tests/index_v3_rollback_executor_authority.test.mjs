import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  authenticateRollbackExecutor, validateRollbackDependencies, validateRollbackReviewedHead,
  ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES, ROLLBACK_PINNED_HISTORICAL_DEPENDENCIES,
} from "../scripts/index_v3_migration/rollback_executor_authority.mjs";
import { buildObservationHistoryV3RecoveryProgressContext } from "../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
import { stableMigrationJson, normalizeObservationHistoryV3MigrationTransition } from "../scripts/backup_r2/lib/observation_history_migration_v3.mjs";
import { recoverySha256 } from "../scripts/index_v3_migration/recovery_journal_authority.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const historicalWriter = "e418f286577097a5b1d91e0c52da21c245df0c49";
const library = "scripts/backup_r2/lib/observation_history_migration_v3.mjs";
const wrapper = "scripts/index_v3_migration/index_v3_migration.sh";
const cli = "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
const preflight = "scripts/index_v3_migration/index_v3_preflight.sh";
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const write = (repo, name, body) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), body);
};
const commit = (repo) => {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Rollback fixture", "-c", "user.email=rollback@example.invalid", "commit", "-qm", "local fixture");
  return git(repo, "rev-parse", "HEAD").toString().trim();
};

async function fixture(t) {
  // Node resolves import.meta.url through macOS /var symlinks; use the same
  // canonical path for argv so the executable helper's main guard is exercised.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-rollback-compatibility-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=reviewed-default");
  // Small temporary Git history only. Real repository and real authority are
  // read-only. Pin real historical semantic/recovery bytes at the fixture base.
  for (const file of ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES) {
    const original = spawnSync("git", ["show", `${historicalWriter}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    write(repo, file, original.status === 0 ? original.stdout : read(file));
  }
  const targetWriterGitSha = commit(repo);
  const transition = normalizeObservationHistoryV3MigrationTransition("v2-to-v3");
  const planIdentity = { transition, fixture: "rollback compatibility" };
  const planSha256 = recoverySha256(stableMigrationJson(planIdentity));
  const authority = {
    migration_run_id: "local-rollback-compatibility", transition,
    target_writer_git_sha: targetWriterGitSha, plan_identity: planIdentity, plan_sha256: planSha256,
    backup_gate: { verified: true, inventory_root: { sha256: "a".repeat(64) }, state_root: { sha256: "b".repeat(64) } },
  };
  const checkpoint = {
    kind: "uk_aq_observation_history_v3_migration_checkpoint",
    authority, authority_sha256: recoverySha256(stableMigrationJson(authority)),
    migration_run_id: authority.migration_run_id, transition, plan_sha256: planSha256,
    prepared_units: {}, completed_objects: {}, preparation_order: [],
  };
  const checkpointPath = path.join(temp, "checkpoint.json");
  fs.writeFileSync(checkpointPath, stableMigrationJson(checkpoint));
  const context = buildObservationHistoryV3RecoveryProgressContext({
    repositoryRoot: repo, checkpointPath, checkpoint, create: true,
  });
  await context.persistCheckpoint({ ...checkpoint, full_verification_complete: true });
  for (const file of ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES) write(repo, file, read(file));
  write(repo, "scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs", "// unrelated reviewed change\n");
  write(repo, "scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs", "// unrelated reviewed change\n");
  const reviewedHead = commit(repo);
  const githubRepository = {
    nameWithOwner: "TEST-uk-aq/uk-aq-ops",
    defaultBranchRef: { name: "reviewed-default", target: { oid: reviewedHead } },
  };
  const options = {
    repositoryRoot: repo, checkpointPath, migrationRunId: authority.migration_run_id,
    planSha256, targetWriterGitSha, transition: transition.kind,
    inventoryRootSha256: "a".repeat(64), stateRootSha256: "b".repeat(64),
    resolveGithubRepository: () => structuredClone(githubRepository),
  };
  return { repo, options, context, githubRepository };
}

test("rollback accepts historical authority with clean current descendant, without repinning or evidence writes", async (t) => {
  const { repo, options, context, githubRepository } = await fixture(t);
  const evidence = [options.checkpointPath, context.paths.manifest, context.paths.head,
    path.join(context.paths.entries, "0000000001.json")];
  const before = evidence.map((file) => fs.readFileSync(file));
  const recovery = await authenticateRollbackExecutor(options);
  assert.notEqual(git(repo, "rev-parse", "HEAD").toString().trim(), options.targetWriterGitSha);
  assert.equal(recovery.checkpoint.authority.target_writer_git_sha, options.targetWriterGitSha);
  assert.equal(recovery.manifest.payload.recovery_implementation.repository_head, options.targetWriterGitSha);
  assert.deepEqual(recovery.executor_identity, {
    repository: githubRepository.nameWithOwner, branch: "reviewed-default",
    local_head: githubRepository.defaultBranchRef.target.oid,
    github_default_branch_head: githubRepository.defaultBranchRef.target.oid,
  });
  assert.equal(recovery.sequence, 1);
  assert.equal(recovery.checkpoint.full_verification_complete, true);
  assert.deepEqual(evidence.map((file) => fs.readFileSync(file)), before);
  assert.equal(git(repo, "status", "--short").toString(), "");
  // Exercise the same read-only entrypoint used by wrapper/preflight, including
  // its positional identities and fixture-local import resolution.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"), "dir");
  fs.appendFileSync(path.join(repo, ".git/info/exclude"), "\n/node_modules\n");
  // Fake only the read-only gh process; exercise the production resolver and
  // helper entrypoint without network access or an authority-bypass flag.
  const bin = path.join(path.dirname(repo), "bin");
  const responsePath = path.join(bin, "github.json");
  fs.mkdirSync(bin);
  const ghResponse = (status, response) => fs.writeFileSync(responsePath, JSON.stringify({ status, response }));
  ghResponse(0, JSON.stringify({ data: { repository: githubRepository } }));
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2, 4), ['api', 'graphql']);
assert.ok(process.argv.includes('owner={owner}') && process.argv.includes('name={repo}'));
assert.ok(process.argv.some(arg => arg.includes('defaultBranchRef') && arg.includes('oid')));
assert.ok(!process.argv.includes('--cache'));
const state = JSON.parse(fs.readFileSync(${JSON.stringify(responsePath)}, 'utf8'));
process.stdout.write(state.response);
process.exit(state.status);
`, { mode: 0o755 });
  const runHelper = () => spawnSync(process.execPath, [
    path.join(repo, "scripts/index_v3_migration/rollback_executor_authority.mjs"),
    options.checkpointPath, options.migrationRunId, options.planSha256,
    options.targetWriterGitSha, options.transition, options.inventoryRootSha256, options.stateRootSha256,
  ], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const result = runHelper();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(evidence.map((file) => fs.readFileSync(file)), before);
  for (const [status, response] of [[1, ""], [0, "not JSON"], [0, JSON.stringify({ errors: [{ message: "denied" }], data: { repository: githubRepository } })]]) {
    ghResponse(status, response);
    const failed = runHelper();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /GitHub repository\/default-branch identity is unavailable/);
  }
});

test("rollback requires the exact current GitHub default-branch HEAD, not merely a clean descendant", async (t) => {
  const { repo, options, githubRepository } = await fixture(t);
  const publishedHead = githubRepository.defaultBranchRef.target.oid;
  assert.equal(validateRollbackReviewedHead(options).local_head, publishedHead);
  // Main regression: a clean committed change to current-trusted machinery
  // passes local dependency compatibility but is not on GitHub.
  write(repo, "workers/shared/r2_sigv4.mjs", read("workers/shared/r2_sigv4.mjs") + "\n// locally committed executor change\n");
  const unpushedHead = commit(repo);
  assert.equal(git(repo, "status", "--short").toString(), "");
  assert.doesNotThrow(() => validateRollbackDependencies(options));
  await assert.rejects(authenticateRollbackExecutor(options), /local HEAD .* differs from GitHub default-branch HEAD/);
  // Model GitHub advancing while the local default branch is behind.
  git(repo, "reset", "--hard", publishedHead);
  const advanced = structuredClone(githubRepository);
  advanced.defaultBranchRef.target.oid = unpushedHead;
  await assert.rejects(authenticateRollbackExecutor({ ...options, resolveGithubRepository: () => advanced }), /local HEAD .* differs from GitHub default-branch HEAD/);
  const wrongBranch = structuredClone(githubRepository);
  wrongBranch.defaultBranchRef.name = "different-default";
  await assert.rejects(authenticateRollbackExecutor({ ...options, resolveGithubRepository: () => wrongBranch }), /local branch .* differs from GitHub default branch/);
  for (const [remote, expected] of [
    [null, /repository identity is missing/],
    [{ ...githubRepository, nameWithOwner: "" }, /repository identity is missing/],
    [{ ...githubRepository, defaultBranchRef: null }, /default branch could not be established/],
    [{ ...githubRepository, defaultBranchRef: { name: "reviewed-default" } }, /default-branch HEAD could not be established/],
    [{ ...githubRepository, defaultBranchRef: { name: "reviewed-default", target: { oid: "invalid" } } }, /default-branch HEAD could not be established/],
  ]) await assert.rejects(authenticateRollbackExecutor({ ...options, resolveGithubRepository: () => remote }), expected);
  await assert.rejects(authenticateRollbackExecutor({ ...options, resolveGithubRepository: () => { throw new Error("offline"); } }), /GitHub repository\/default-branch identity is unavailable/);
});

test("rollback critical dependencies reject dirty, staged and missing/untracked replacements", async (t) => {
  const { repo, options } = await fixture(t);
  for (const name of [
    "scripts/index_v3_migration/rollback_executor_authority.mjs", cli, library,
    "workers/shared/r2_sigv4.mjs",
    "scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs",
  ]) {
    const original = fs.readFileSync(path.join(repo, name));
    write(repo, name, Buffer.concat([original, Buffer.from("\n// dirty\n")]));
    assert.throws(() => validateRollbackDependencies(options), /dependency differs from HEAD/);
    write(repo, name, original);
  }
  write(repo, cli, read(cli) + "\n// staged\n");
  git(repo, "add", cli);
  write(repo, cli, read(cli)); // Worktree restored, index still changed.
  assert.throws(() => validateRollbackDependencies(options), /Git authority check failed/);
  git(repo, "reset", "-q", "HEAD", "--", cli);
  git(repo, "rm", "--cached", "--", cli); // Bytes remain but are untracked.
  assert.throws(() => validateRollbackDependencies(options), /Git authority check failed/);
});

test("rollback rejects committed historical schema and restore-selection drift but permits planner evolution", async (t) => {
  const { repo, options } = await fixture(t);
  const name = ROLLBACK_PINNED_HISTORICAL_DEPENDENCIES[0];
  write(repo, name, read(name) + "\n// semantic change\n");
  commit(repo);
  assert.throws(() => validateRollbackDependencies(options), /historical semantic dependency changed/);
  write(repo, name, read(name));
  write(repo, library, read(library).replace("function restoreStageForKey(key) {", "function restoreStageForKey(key) {\n  key = 'current-r2-selection';"));
  commit(repo);
  assert.throws(() => validateRollbackDependencies(options), /historical restore semantics changed/);
});

test("rollback rejects missing, tampered, truncated or mismatched historical recovery authority", async (t) => {
  const { options, context } = await fixture(t);
  for (const [field, value] of Object.entries({
    migrationRunId: "wrong-run", planSha256: "c".repeat(64),
    targetWriterGitSha: "f".repeat(40), transition: "v3-rebuild",
    inventoryRootSha256: "c".repeat(64), stateRootSha256: "c".repeat(64),
  })) await assert.rejects(authenticateRollbackExecutor({ ...options, [field]: value }));
  const entryPath = path.join(context.paths.entries, "0000000001.json");
  const entry = fs.readFileSync(entryPath);
  fs.writeFileSync(entryPath, entry.subarray(0, entry.length - 4));
  await assert.rejects(authenticateRollbackExecutor(options), /invalid JSON|unreadable/);
  fs.unlinkSync(entryPath);
  await assert.rejects(authenticateRollbackExecutor(options), /journal|head/i);
  fs.writeFileSync(entryPath, entry);
  const manifestBody = fs.readFileSync(context.paths.manifest);
  const manifest = JSON.parse(manifestBody);
  manifest.payload.recovery_implementation.files[0].sha256 = "d".repeat(64);
  manifest.payload_sha256 = recoverySha256(stableMigrationJson(manifest.payload));
  fs.writeFileSync(context.paths.manifest, stableMigrationJson(manifest));
  await assert.rejects(authenticateRollbackExecutor(options), /historical recovery implementation identity mismatch/);
  fs.unlinkSync(context.paths.manifest);
  await assert.rejects(authenticateRollbackExecutor(options), /manifest/i);
  fs.writeFileSync(context.paths.manifest, manifestBody);
  const checkpoint = JSON.parse(fs.readFileSync(options.checkpointPath));
  checkpoint.authority.backup_gate.state_root.sha256 = "e".repeat(64);
  fs.writeFileSync(options.checkpointPath, stableMigrationJson(checkpoint));
  await assert.rejects(authenticateRollbackExecutor(options), /checkpoint/i);
});

test("rollback load closure includes local imports and subprocess helpers; unrelated implementations stay outside", () => {
  const trusted = new Set(ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES);
  for (const name of trusted) {
    if (!name.endsWith(".mjs")) continue;
    for (const match of read(name).matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const dependency = path.relative(root, path.resolve(root, path.dirname(name), match[1]));
      assert.ok(trusted.has(dependency), `${name} loads unlisted ${dependency}`);
    }
  }
  for (const name of ["scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs", "scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs"]) {
    assert.equal(trusted.has(name), false);
  }
  assert.ok(trusted.has("scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs"));
  assert.ok(trusted.has("workers/uk_aq_cache_proxy/resolve_station_history_service.sh"));
});

test("migrate, resume and verify gates and rollback mutation controls remain unchanged", () => {
  const before = (name) => git(root, "show", `2c63d98937f52a874c48cfc427fa5af0b500ae42:${name}`).toString();
  const section = (source, start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `missing source boundaries: ${start} / ${end}`);
    return source.slice(first, last);
  };
  for (const [start, end] of [
    ["VERIFY_CURRENT_TRUSTED_DEPENDENCIES=(", "self_test() {"],
    ['  elif [ "$MODE" = "resume" ]; then', "  write_writer_limits\n}"],
    ['\nif [ "$MODE" = "rollback" ]; then', '\n[ "$APPLY" -eq 0 ] || stop "verify mode'],
  ]) assert.equal(section(read(wrapper), start, end).replace(/^  scripts\/index_v3_migration\/(?:operator_execution|v2_runtime_artifact|v2_runtime_recovery|capture_v2_runtime_authority|index_v3_capture_operator_evidence|rollback_executor_authority|index_v3_operator_evidence)\.mjs\n/gm, ""), section(before(wrapper), start, end));
  assert.match(read(wrapper), /elif \[ "\$MODE" = "rollback" \]; then\n\s+node[^\n]+rollback_executor_authority/);
  assert.match(read(preflight), /if \[ "\$STAGE" = "rollback" \]; then\n  # Rollback interprets/);
  for (const [start, end] of [
    ['  if (checkpoint && args.mode === "migrate") {', '  } else if ('],
    ['  if (new Set(["migrate", "rollback"]).has(args.mode)) {', '  const getBackupObject'],
  ]) assert.equal(section(read(cli), start, end), section(before(cli), start, end));
  assert.match(read(library), /checkV2RuntimeRecoverability/);
  assert.match(read(library), /rollback_complete_v2_authority_verified/);
  assert.match(read(preflight), /v2 runtime is not recoverable; canonical rollback is prohibited/);
  assert.ok(ROLLBACK_CURRENT_TRUSTED_DEPENDENCIES.includes("scripts/index_v3_migration/operator_execution.mjs"));
  assert.ok(!ROLLBACK_PINNED_HISTORICAL_DEPENDENCIES.includes("scripts/index_v3_migration/operator_execution.mjs"));
});
