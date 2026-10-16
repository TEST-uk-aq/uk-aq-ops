#!/usr/bin/env node
// LIVE-only, read-only immutable migration-generation verification. This is NOT
// deployed HTTP/cache acceptance or advanced steady-state post-write validation.
// The accepted global observations lock must remain held by the caller.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readAuthenticatedCutoverBaseline,
  selectedCutoverGeneration,
  verifySelectedCutoverMetadata,
} from "./index_v3_cutover_generation_evidence.mjs";
import { createSideBySideLockAssertion } from "../backup_r2/uk_aq_observation_history_migration_v3.mjs";
import {
  verifySideBySideSourceRoot,
  verifyObservationHistoryV3CurrentDependencies,
} from "../backup_r2/lib/observation_history_migration_v3.mjs";
import { getObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { r2GetObject, r2HeadObject } from "../../workers/shared/r2_sigv4.mjs";

const REPOSITORY = "UK-AQ/uk-aq-ops";
const LIVE_BUCKET = "uk-aq-history-live";
const LIVE_R2_ACCOUNT_ID = "7e20426335c509cc77483210fa7ead0f";
const HELP = `Usage:
  node scripts/index_v3_migration/index_v3_live_immutable_verify.mjs \\
    --phase pre-cutover|read-cutover \\
    --expected-repository-git-sha SHA --expected-bucket uk-aq-history-live \\
    --plan-report PATH --checkpoint PATH [--evidence-root PATH]

Pre-cutover requires selected v2; read-cutover requires selected v3. Both
require the existing supervised global observations lock and complete, current,
authenticated migration checkpoint. This verifier never writes to R2 or
changes Workers, scheduling, GitHub variables or the generation selector.
Read-cutover MUST run before the first normal v3-only history publication.
It does not replace separate deployed website/cache read acceptance.
`;

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 20000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`LIVE verifier cannot authenticate ${name} ${args[0]}: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

function parse(argv) {
  const flags = new Map();
  const allowed = new Set(["--phase", "--expected-repository-git-sha",
    "--expected-bucket", "--plan-report", "--checkpoint", "--evidence-root"]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--")) {
      throw new Error(`Missing, repeated or unsupported LIVE verifier argument: ${key}`);
    }
    flags.set(key, value);
  }
  const required = ["--phase", "--expected-repository-git-sha", "--expected-bucket", "--plan-report", "--checkpoint"];
  if (required.some((name) => !flags.has(name))) throw new Error("LIVE verifier requires all five explicit arguments");
  if (!new Set(["pre-cutover", "read-cutover"]).has(flags.get("--phase"))) {
    throw new Error("LIVE verifier phase must be pre-cutover or read-cutover");
  }
  if (flags.get("--expected-bucket") !== LIVE_BUCKET ||
      !/^[0-9a-f]{40}$/.test(flags.get("--expected-repository-git-sha"))) {
    throw new Error("LIVE verifier requires reviewed LIVE bucket and exact Git SHA");
  }
  return Object.fromEntries([...flags].map(([key, value]) => [key.slice(2), value]));
}

function assertLoadedLiveEnvironment(phase) {
  const env = process.env;
  const names = [env.UKAQ_ENV_NAME, env.UK_AQ_ENV_NAME, env.ENVIRONMENT]
    .filter((name) => String(name || "").trim());
  if (!names.length || names.some((name) => String(name).trim().toUpperCase() !== "LIVE") ||
      env.UK_AQ_R2_HISTORY_VERSION !== (phase === "pre-cutover" ? "v2" : "v3") ||
      env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION !== "v2" ||
      env.CFLARE_R2_BUCKET !== LIVE_BUCKET) {
    throw new Error("LIVE environment, selected generation, Integrity semantics or bucket mismatch");
  }
  let endpoint;
  try { endpoint = new URL(env.CFLARE_R2_ENDPOINT); }
  catch { throw new Error("Missing/malformed LIVE R2 endpoint"); }
  if (endpoint.protocol !== "https:" ||
      endpoint.hostname !== `${LIVE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com` ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("LIVE verifier R2 endpoint does not identify the reviewed Cloudflare account");
  }
  if (!env.CFLARE_R2_ACCESS_KEY_ID || !env.CFLARE_R2_SECRET_ACCESS_KEY) {
    throw new Error("LIVE verifier requires loaded R2 read credentials");
  }
}

function assertLiveRepository(expectedSha, selectedGeneration) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const remote = command("git", ["remote", "get-url", "origin"], root);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)UK-AQ\/uk-aq-ops(?:\.git)?\/?$/.test(remote)) {
    throw new Error("LIVE immutable verifier must execute from UK-AQ/uk-aq-ops");
  }
  if (command("git", ["branch", "--show-current"], root) !== "main" ||
      command("git", ["rev-parse", "HEAD"], root) !== expectedSha ||
      command("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root)) {
    throw new Error("LIVE verifier requires clean reviewed main at the expected Git SHA");
  }
  if (command("gh", ["api", `repos/${REPOSITORY}/commits/main`, "--jq", ".sha"], root) !== expectedSha) {
    throw new Error("Current LIVE GitHub main differs from reviewed verifier implementation");
  }
  if (command("gh", ["variable", "get", "UKAQ_ENV_NAME", "--repo", REPOSITORY], root).toUpperCase() !== "LIVE" ||
      command("gh", ["variable", "get", "UK_AQ_R2_HISTORY_VERSION", "--repo", REPOSITORY], root) !== selectedGeneration) {
    throw new Error("Independently read LIVE GitHub environment or generation differs from loaded verifier configuration");
  }
}

const requireLock = (report) => {
  const runId = report?.result?.migration_run_id;
  if (typeof runId !== "string" || !runId) throw new Error("Migration run ID missing from plan report");
  return createSideBySideLockAssertion({ env: process.env, migrationRunId: runId });
};

export async function verifyLiveImmutableGeneration({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = parse(argv);
  assertLoadedLiveEnvironment(args.phase);
  const generationVersion = args.phase === "pre-cutover" ? "v2" : "v3";
  assertLiveRepository(args["expected-repository-git-sha"], generationVersion);
  const report = JSON.parse(fs.readFileSync(path.resolve(args["plan-report"]), "utf8"));
  const assertLockHeld = requireLock(report);
  assertLockHeld();
  const { plan, checkpoint, provenance } = readAuthenticatedCutoverBaseline({
    checkpointPath: args.checkpoint, planReport: report,
    environment: "LIVE", bucket: LIVE_BUCKET, evidenceRoot: args.evidenceRoot || null,
  });
  // These are intentionally independent identities. The historical writer is
  // authenticated by the immutable checkpoint/plan/recovery authority and the
  // pinned semantic dependency checks. The current verifier checkout was
  // authenticated above by assertLiveRepository and the current dependency
  // trust model; exceptional recovery may therefore have a different SHA.
  const r2 = {
    endpoint: process.env.CFLARE_R2_ENDPOINT,
    bucket: LIVE_BUCKET,
    region: process.env.CFLARE_R2_REGION || "auto",
    access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
    secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
  };
  const guarded = (read) => async ({ key }) => {
    assertLockHeld();
    const value = await read({ r2, key });
    assertLockHeld();
    return value;
  };
  const getObject = guarded(r2GetObject);
  const headObject = guarded(r2HeadObject);
  await verifySideBySideSourceRoot({ plan, getObject });
  const result = await verifyObservationHistoryV3CurrentDependencies({
    plan, checkpoint, getObject, headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  if (!result.ok || !result.cutover_ready || result.blockers?.length ||
      result.recovery_reconciliation?.counts?.fail !== 0 ||
      result.recovery_reconciliation?.counts?.legacy_recovery_ordering !== 0) {
    throw new Error("LIVE complete v3 observations/index closure does not match locked immutable migration");
  }
  let selectedMetadata = null;
  if (args.phase === "read-cutover") {
    const generation = selectedCutoverGeneration(process.env);
    selectedMetadata = await verifySelectedCutoverMetadata({
      generation, getObject, headObject,
    });
  } else {
    // This is the planned target, not a premature change of the selected v2 authority.
    const target = getObservationHistoryGeneration("v3");
    if (target.version !== "v3") throw new Error("Expected v3 target generation is unavailable");
  }
  await verifySideBySideSourceRoot({ plan, getObject });
  assertLockHeld();
  const output = {
    ok: true, phase: args.phase, environment: "LIVE", bucket: LIVE_BUCKET,
    selected_generation: generationVersion,
    immutable_migration_verified: true,
    source_root_unchanged: true,
    complete_v3_dependency_closure: true,
    historical_migration_writer_git_sha: plan.target_writer_git_sha,
    current_verifier_git_sha: args["expected-repository-git-sha"],
    plan_sha256: plan.plan_sha256,
    migration_run_id: plan.migration_run_id,
    checkpoint_evidence: provenance,
    selected_metadata: selectedMetadata,
    deployed_path_verified: false,
    normal_v3_write_permitted: false,
    runtime_switch_performed: false,
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyLiveImmutableGeneration().then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
