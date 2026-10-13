#!/usr/bin/env node
// Read-only LIVE side-by-side migration writer-freeze admission.
// This supplements (never replaces) the global operations lock, canonical v2
// source-root identity, current locked Dropbox baseline and operator GO gates.
// It does not change D1, GitHub, schedules, backup, R2 or the selected generation.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateIndexV3OperatorEvidence } from "./index_v3_operator_evidence.mjs";

const REPO = "UK-AQ/uk-aq-ops";
const BUCKET = "uk-aq-history-live";
const D1_NAME = "uk_aq_cron_scheduler_ops_db";
const D1_ID = "9b5f32af-fb17-4bff-b9df-6c211cc8b307";
const CONFIG = "cloudflare/scheduler/wrangler.toml";
const WRANGLER = "4.130.0";
const SCHEDULES = Object.freeze({
  uk_aq_prune_daily: "uk_aq_prune_daily.yml",
  uk_aq_r2_core_snapshot: "uk_aq_r2_core_snapshot.yml",
  uk_aq_r2_history_dropbox_backup: "uk_aq_r2_history_dropbox_backup.yml",
  uk_aq_r2_history_dropbox_backup_force_prune_recheck: "uk_aq_r2_history_dropbox_backup.yml",
});
const WORKFLOWS = Object.freeze([...new Set(Object.values(SCHEDULES))]);
const USAGE = `Usage:
  node scripts/index_v3_migration/index_v3_live_writer_freeze_preflight.mjs \\
    --expected-git-sha LIVE_MAIN_SHA \\
    --plan-report /durable/plan.json \\
    --writer-freeze-evidence /durable/sealed-freeze-evidence.json

Read-only gate. Fails closed unless Prune Daily, Core Snapshot and both
history Dropbox backup scheduler rows are disabled in LIVE D1 and their
workflows have no unfinished recent runs. Requires validated plan-bound manual
writer-freeze evidence. Does not prove Dropbox/root currentness or grant APPLY.
`;

function requireFlags(argv) {
  const allowed = new Set(["--expected-git-sha", "--plan-report", "--writer-freeze-evidence"]);
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!allowed.has(name) || flags.has(name) || !value || value.startsWith("--")) {
      throw new Error(`Missing, duplicate or unsupported preflight flag: ${name}`);
    }
    flags.set(name, value);
  }
  if (flags.size !== allowed.size || !/^[a-f0-9]{40}$/.test(flags.get("--expected-git-sha"))) {
    throw new Error("Preflight requires three explicit inputs and a full reviewed main SHA");
  }
  return Object.fromEntries([...flags].map(([name, value]) => [name.slice(2), value]));
}

function run(binary, args, cwd) {
  const completed = spawnSync(binary, args, {
    cwd, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  if (completed.error || completed.status !== 0) {
    throw new Error(`Preflight read failed: ${binary} ${args[0]}: ${completed.error?.message || completed.stderr?.slice(0, 600) || "non-zero exit"}`);
  }
  return completed.stdout.trim();
}

function readJson(p, label) {
  try { return JSON.parse(fs.readFileSync(path.resolve(p), "utf8")); }
  catch (error) { throw new Error(`${label} is unreadable or malformed: ${error.message}`); }
}

function assertRepository(root, sha) {
  const git = (...args) => run("git", args, root);
  const origin = git("remote", "get-url", "origin");
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)UK-AQ\/uk-aq-ops(?:\.git)?\/?$/.test(origin)) {
    throw new Error("Writer-freeze preflight requires the LIVE ops repository");
  }
  if (git("branch", "--show-current") !== "main" ||
      git("rev-parse", "HEAD") !== sha ||
      git("status", "--porcelain=v1", "--untracked-files=normal")) {
    throw new Error("Preflight requires an unchanged reviewed LIVE main checkout");
  }
  if (run("gh", ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"], root) !== sha) {
    throw new Error("LIVE remote main differs from reviewed preflight implementation");
  }
  if (run("gh", ["variable", "get", "UKAQ_ENV_NAME", "--repo", REPO], root).toUpperCase() !== "LIVE" ||
      run("gh", ["variable", "get", "UK_AQ_R2_HISTORY_VERSION", "--repo", REPO], root) !== "v2") {
    throw new Error("LIVE GitHub environment or selected-generation authority disagrees with frozen v2");
  }
}

function assertEnvironment() {
  const env = process.env;
  const names = [env.UKAQ_ENV_NAME, env.UK_AQ_ENV_NAME, env.ENVIRONMENT]
    .filter(x => String(x || "").trim());
  if (!names.length || names.some(x => String(x).toUpperCase() !== "LIVE") ||
      env.UK_AQ_R2_HISTORY_VERSION !== "v2" ||
      env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION !== "v2" ||
      env.CFLARE_R2_BUCKET !== BUCKET) {
    throw new Error("Loaded LIVE environment, logical Integrity semantics, generation or R2 bucket differ");
  }
}

function assertSchedulerConfig(root) {
  const toml = fs.readFileSync(path.join(root, CONFIG), "utf8");
  if (!toml.includes(`database_name = "${D1_NAME}"`) ||
      !toml.includes(`database_id = "${D1_ID}"`)) {
    throw new Error("LIVE scheduler Wrangler config has an unreviewed D1 database identity");
  }
  const jobs = fs.readFileSync(path.join(root, "cloudflare/scheduler/jobs.toml"), "utf8");
  for (const [job, workflow] of Object.entries(SCHEDULES)) {
    const block = jobs.match(new RegExp(`\\[jobs\\.${job}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1];
    if (!block || !/enabled\s*=\s*false/.test(block) ||
        !block.includes(`github_workflow_file = "${workflow}"`)) {
      throw new Error(`Canonical LIVE jobs.toml does not declare disabled ${job}`);
    }
  }
}

function readD1Rows(root) {
  const escaped = Object.keys(SCHEDULES).map(s => `'${s}'`).join(",");
  const sql = `SELECT job_key, enabled, github_workflow_file FROM scheduler_jobs WHERE job_key IN (${escaped}) ORDER BY job_key`;
  const raw = run("npx", [
    "--yes", `wrangler@${WRANGLER}`, "d1", "execute", D1_NAME,
    "--config", CONFIG, "--remote", "--command", sql, "--json",
  ], root);
  let response;
  try { response = JSON.parse(raw); }
  catch { throw new Error("LIVE remote D1 query did not yield valid JSON"); }
  const result = Array.isArray(response) ? response : response?.result;
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.results)) {
    throw new Error("LIVE remote D1 scheduler query returned an unexpected response shape");
  }
  return result[0].results;
}

function assertSchedulerFrozen(rows) {
  if (rows.length !== Object.keys(SCHEDULES).length) {
    throw new Error("The LIVE scheduler does not contain exactly four migration-sensitive jobs");
  }
  const seen = new Set();
  for (const row of rows) {
    if (!Object.hasOwn(SCHEDULES, row.job_key) || seen.has(row.job_key) ||
        row.enabled !== 0 || row.github_workflow_file !== SCHEDULES[row.job_key]) {
      throw new Error(`Migration-sensitive LIVE schedule is enabled, duplicated or contradictory: ${row.job_key}`);
    }
    seen.add(row.job_key);
  }
}

function assertWorkflowsIdle(root) {
  const results = [];
  for (const workflow of WORKFLOWS) {
    const raw = run("gh", [
      "run", "list", "--repo", REPO, "--workflow", workflow, "--limit", "100",
      "--json", "databaseId,status,conclusion,createdAt,url",
    ], root);
    let rows;
    try { rows = JSON.parse(raw); }
    catch { throw new Error(`Cannot decode GitHub workflow state for ${workflow}`); }
    if (!Array.isArray(rows)) throw new Error(`Unexpected GitHub workflow state for ${workflow}`);
    const active = rows.filter(row => row.status !== "completed");
    if (active.length) throw new Error(`LIVE ${workflow} still has ${active.length} unfinished runs`);
    results.push({ workflow, unfinished: 0, reviewed_recent_runs: rows.length });
  }
  return results;
}

export function mainLiveWriterFreezePreflight(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = requireFlags(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  assertEnvironment();
  assertRepository(root, args["expected-git-sha"]);
  assertSchedulerConfig(root);
  const planReport = readJson(args["plan-report"], "Migration plan report");
  const evidence = readJson(args["writer-freeze-evidence"], "Writer-freeze evidence");
  if (evidence.kind !== "uk_aq_index_v3_writer_freeze_evidence") {
    throw new Error("LIVE writer-freeze evidence has the wrong authority kind");
  }
  const validated = validateIndexV3OperatorEvidence({
    evidence, repositoryRoot: root, planReport,
  });
  if (validated.environment.toUpperCase() !== "LIVE" ||
      validated.repository !== REPO || validated.branch !== "main" ||
      evidence.payload.repository_head !== args["expected-git-sha"]) {
    throw new Error("LIVE writer-freeze evidence does not match the reviewed LIVE commit");
  }
  const rows = readD1Rows(root);
  assertSchedulerFrozen(rows);
  const workflows = assertWorkflowsIdle(root);
  const summary = {
    ok: true,
    environment: "LIVE",
    migration_run_id: evidence.payload.migration_run_id,
    plan_sha256: evidence.payload.plan_sha256,
    writer_freeze_sha256: validated.payload_sha256,
    scheduled_jobs_frozen: Object.keys(SCHEDULES).sort(),
    workflows,
    manual_operator_exclusion_attested: true,
    global_lock_verified: false,
    final_backup_verified: false,
    v2_root_verified: false,
    live_apply_authorised: false,
    note: "Only the read-only LIVE scheduler and plan-bound freeze-evidence gate passed.",
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = mainLiveWriterFreezePreflight(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
