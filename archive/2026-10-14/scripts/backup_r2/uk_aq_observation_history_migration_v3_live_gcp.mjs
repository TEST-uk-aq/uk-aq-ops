#!/usr/bin/env node
// Dedicated, fail-closed LIVE GCP admission for the existing shared side-by-side
// clean-build operator. No deployment, selector switch or writer release occurs.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { admitGcpRunner, GCP_PROFILE } from "./lib/observation_history_migration_gcp.mjs";
import { main as sharedMain } from "./uk_aq_observation_history_migration_v3.mjs";
import { superviseOperatorInvocation, finishOperatorProgress } from "../index_v3_migration/operator_execution.mjs";

const REPOSITORY = "UK-AQ/uk-aq-ops";
const BUCKET = "uk-aq-history-live";
const R2_ACCOUNT_ID = "7e20426335c509cc77483210fa7ead0f";
const REQUIRED_KEYS = Object.freeze(["--expected-gcp-project-id", "--expected-gcp-zone"]);

const HELP = `Usage:
  node scripts/backup_r2/uk_aq_observation_history_migration_v3_live_gcp.mjs \\
    --expected-gcp-project-id PROJECT_ID --expected-gcp-zone europe-west2-ZONE \\
    --environment LIVE --transition v2-to-v3 --mode plan|migrate|verify \\
    --expected-bucket uk-aq-history-live --target-writer-git-sha REVIEWED_SHA \\
    [other shared migration parameters]

This entry point requires an authenticated c4a-standard-32 Google Compute Engine
instance in the explicitly pinned GCP project and London zone; a clean main
checkout of UK-AQ/uk-aq-ops; the LIVE R2 account and bucket; and the existing
global observation lock, v2 source-root and empty-v3 clean-build safeguards.
Migrate requires --apply --writers-frozen and a fresh --checkpoint-out.
GCP clean-build resume with --checkpoint-in is not accepted for migration.
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

function parseLiveArguments(argv) {
  const stripped = [];
  const expected = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (REQUIRED_KEYS.includes(flag)) {
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
  if (!new Set(["plan", "migrate", "verify"]).has(oneValue(stripped, "--mode"))) {
    throw new Error("LIVE GCP entry point only accepts plan/migrate/verify");
  }
  if (oneValue(stripped, "--mode") === "migrate") {
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
    const planSha = oneValue(stripped, "--expected-plan-sha256");
    if (!/^[0-9a-f]{64}$/.test(planSha)) {
      throw new Error("LIVE migrate requires an exact pinned 64-character migration plan SHA-256");
    }
  }
  return { sharedArgv: stripped, projectId, zone };
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

function assertLiveRepository(writerSha) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const remote = command("git", ["remote", "get-url", "origin"], root);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)UK-AQ\/uk-aq-ops(?:\.git)?\/?$/.test(remote)) {
    throw new Error("LIVE GCP migration requires UK-AQ/uk-aq-ops origin, not a TEST repository");
  }
  if (command("git", ["branch", "--show-current"], root) !== "main" ||
      command("git", ["rev-parse", "HEAD"], root) !== writerSha ||
      command("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root)) {
    throw new Error("LIVE migration requires clean main at the explicitly reviewed writer SHA");
  }
  const githubMain = command("gh", ["api", `repos/${REPOSITORY}/commits/main`, "--jq", ".sha"], root);
  if (githubMain !== writerSha) {
    throw new Error("LIVE GitHub main differs from the exact reviewed GCP migration implementation");
  }
}

export async function mainLiveGcp({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const { sharedArgv, projectId, zone } = parseLiveArguments(argv);
  assertLiveEnvironment();
  assertLiveRepository(oneValue(sharedArgv, "--target-writer-git-sha"));
  const runnerPermit = await admitGcpRunner({ profile: GCP_PROFILE });
  if (runnerPermit.project_id !== projectId || runnerPermit.zone !== zone ||
      runnerPermit.machine_type !== "c4a-standard-32") {
    throw new Error("GCE metadata disagrees with explicitly reviewed LIVE GCP project, zone or machine");
  }
  process.stderr.write(`LIVE GCE admission: ${JSON.stringify(runnerPermit)}\n`);
  // Preserve the full invocation for re-entry by the lock-holding child. That
  // child must independently re-establish both LIVE and GCE admission.
  return sharedMain({
    argv: sharedArgv, reentryArgv: argv, runnerPermit,
    entrypoint: fileURLToPath(import.meta.url),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const execution = process.env.UK_AQ_OPERATOR_SUPERVISED === "1" ||
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
