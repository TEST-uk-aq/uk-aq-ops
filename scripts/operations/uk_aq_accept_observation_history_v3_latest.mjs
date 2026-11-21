#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  r2GetObject, r2ListObjectsV2, r2PutObjectConditional, sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  assertExactObject, CONNECTOR, DAY, forEachBounded, latestRegistry, LATEST,
  loadFixture, objectIdentity, SHA256, SOURCE_BUCKET,
} from "./lib/uk_aq_latest_recovery_fixture.mjs";

const tool = fileURLToPath(new URL("uk_aq_repair_observation_history_v3_latest.mjs", import.meta.url));
const audit = fileURLToPath(new URL("lib/uk_aq_latest_recovery_audit.mjs", import.meta.url));
const NORMAL_BUCKET = "uk-aq-history-cic-test";
const REPO = "TEST-uk-aq/uk-aq-ops";
const destinationPattern = /^uk-aq-history-cic-test-v3-recovery-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSettings(env) {
  assert(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === REPO && env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.UK_AQ_ENV_NAME === "TEST" &&
    env.UK_AQ_R2_HISTORY_VERSION === "v3" && env.CFLARE_R2_BUCKET === NORMAL_BUCKET,
  "This operation requires the TEST main Actions workflow, v3 and the normal TEST bucket configuration");
  const mode = env.INPUT_MODE;
  const bucket = env.INPUT_BUCKET;
  const approved = env.INPUT_APPROVED_PLAN_SHA256;
  const precreated = env.INPUT_PRECREATED_BUCKETS === "true";
  assert(["prepare", "plan", "apply"].includes(mode) &&
    (mode === "apply" ? SHA256.test(approved) : !approved) && (!precreated || mode === "prepare"),
  "Choose prepare, plan, or apply. Only apply takes the reviewed SHA-256, and only prepare can use newly precreated buckets");
  assert(destinationPattern.test(bucket) && bucket.length <= 55 && !bucket.endsWith("-invalid"), "Invalid disposable TEST bucket name");
  const account = env.INPUT_TEST_R2_ACCOUNT_ID;
  const project = env.INPUT_TEST_DB_PROJECT_REF;
  const endpoint = env.CFLARE_R2_ENDPOINT;
  assert(/^[a-f0-9]{32}$/.test(account) && account === env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID &&
    [ `https://${account}.r2.cloudflarestorage.com`, `https://${account}.eu.r2.cloudflarestorage.com` ]
      .some(origin => endpoint === origin || endpoint === `${origin}/`), "TEST R2 account or endpoint does not match");
  assert(/^[a-z0-9]{20}$/.test(project) && [`https://${project}.supabase.co`, `https://${project}.supabase.co/`].includes(env.SUPABASE_URL),
    "TEST Supabase project does not match the Actions configuration");
  assert(env.CFLARE_R2_ACCESS_KEY_ID && env.CFLARE_R2_SECRET_ACCESS_KEY && env.SUPABASE_DB_URL,
    "Existing TEST R2 keys and SUPABASE_DB_URL are required");
  assert(["auto", "us-east-1"].includes(env.CFLARE_R2_REGION), "Unexpected TEST R2 signing region");

  let database;
  try { database = new URL(env.SUPABASE_DB_URL); } catch { throw new Error("Invalid TEST PostgreSQL URL"); }
  const direct = database.hostname === `db.${project}.supabase.co`;
  const pooler = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(database.hostname) && database.username.endsWith(`.${project}`);
  assert((direct || pooler) && ["postgresql:", "postgres:"].includes(database.protocol) &&
    (database.port === "5432" || (direct && database.port === "")) && database.pathname === "/postgres" &&
    database.username && database.password && !database.hash && [...database.searchParams.keys()].every(key => key === "sslmode"),
  "SUPABASE_DB_URL must use the independently confirmed TEST project on a dedicated or session-pooler connection");
  database.searchParams.set("sslmode", "verify-full");
  const r2 = { endpoint, region: env.CFLARE_R2_REGION, access_key_id: env.CFLARE_R2_ACCESS_KEY_ID, secret_access_key: env.CFLARE_R2_SECRET_ACCESS_KEY };
  return { mode, approved, precreated, account, project, database, r2, bucket, invalidBucket: `${bucket}-invalid` };
}

export function describeUtilityFailure(result, events, reason) {
  const exit = { exit_status: result.status, signal: result.signal };
  const stage = events.some(item => item.event.startsWith("r2_")) ? "r2"
    : events.some(item => item.event === "db_session_read_only") ? "global_lock" : "before_lock_evidence";
  if (result.error) {
    const code = result.error.code;
    if (code === "ETIMEDOUT" || code === "ENOBUFS") {
      return { ...exit, stage, category: code === "ETIMEDOUT" ? "child_timeout" : "child_output_limit", code };
    }
    return { ...exit, stage: "child_launch", category: "spawn_failed", code };
  }
  if (result.signal) return { ...exit, stage, category: "child_signalled", message: "Child terminated by signal" };

  if (stage === "before_lock_evidence") {
    const connectionFailure = events.find(item => item.event === "db_connection_failed" || item.event === "db_session_setup_failed");
    if (connectionFailure) {
      const { event, code, message } = connectionFailure;
      return { ...exit, stage: event === "db_connection_failed" ? "postgres_connect" : "postgres_session_setup",
        category: event, code, message };
    }
    // The CLI prints messages for configuration errors. Node prints codes for most loader failures.
    // Match fixed signatures and never return text taken from stderr.
    const raw = result.stderr || "";
    const loaderCode = raw.match(/^\s*code: '(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_DLOPEN_FAILED|ERR_PACKAGE_PATH_NOT_EXPORTED)'[,]?$/m)?.[1];
    if (loaderCode) return { ...exit, stage: "child_startup", category: "module_load_failed", code: loaderCode };
    if (/^SyntaxError:/m.test(raw)) {
      return { ...exit, stage: "child_startup", category: "module_load_failed", message: "Node reported a syntax error" };
    }
    const configurationMessage = ["Invalid arguments. Use --help for usage",
      "Observation history generation must be exactly v2 or v3", "Selected profile needs complete v3 R2 configuration",
      "Selected profile needs a dedicated-session PostgreSQL connection URL", "URI malformed", "Invalid URL"].find(message =>
      raw.trim() === message);
    if (configurationMessage) return { ...exit, stage: "utility_configuration", category: "invalid_configuration", message: configurationMessage };
  }
  if (reason !== "utility_failed") return { ...exit, stage, category: reason, message: "Unexpected utility result" };
  return { ...exit, stage, category: "unexpected_utility_exit", message: "No recognised utility error signature" };
}

async function main(env) {
  assert(env.RUNNER_TEMP && env.GITHUB_ACTIONS === "true", "Run through the TEST Actions workflow");
  const directory = join(env.RUNNER_TEMP, "v3-latest-recovery-acceptance");
  mkdirSync(directory, { recursive: true });
  const save = (name, data) => writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  const event = data => appendFileSync(join(directory, "operations.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`);
  let outcome = "failed";
  let stage = "configuration";
  try {
    const settings = validateSettings(env);
    const { mode, approved, precreated, account, project, database, r2, bucket, invalidBucket } = settings;
    const destination = { ...r2, bucket };
    const invalid = { ...r2, bucket: invalidBucket };
    const source = { ...r2, bucket: SOURCE_BUCKET };
    const provenance = `isolated TEST acceptance fixture from ${SOURCE_BUCKET} for ${bucket}`;
    const collection = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`;
    const s3Origin = new URL(r2.endpoint).origin;
    event({ stage, mode, account, project, source: SOURCE_BUCKET, destination: bucket, invalid: invalidBucket, commit: env.GITHUB_SHA });

    const fetchUpstream = globalThis.fetch;
    globalThis.fetch = (input, options = {}) => {
      const url = new URL(input);
      const method = options.method || "GET";
      const requestBucket = url.pathname.split("/")[1];
      const isolated = requestBucket === bucket || requestBucket === invalidBucket;
      const s3 = url.origin === s3Origin &&
        ((method === "GET" && (requestBucket === SOURCE_BUCKET || isolated)) || (mode === "prepare" && isolated && method === "PUT"));
      const provisioning = mode === "prepare" && !precreated &&
        ((method === "POST" && url.href === collection && [bucket, invalidBucket].includes(JSON.parse(options.body).name)) ||
          (method === "GET" && [bucket, invalidBucket].some(name => url.href === `${collection}/${name}`)));
      assert(s3 || provisioning, "Request outside the isolated TEST fixture allowlist");
      return fetchUpstream(input, { ...options, redirect: "error" });
    };

    async function get(target, key) {
      try { return await r2GetObject({ r2: target, key, accept_encoding_identity: true }); } catch (error) {
        throw new Error(`R2 GET failed in ${target.bucket} for ${key}${error.status ? ` (HTTP ${error.status})` : ""}. ` +
          (target === source ? "Check TEST source Object Read permission." : "Check Object Read & Write on the named disposable TEST bucket."));
      }
    }

    async function list(target) {
      const keys = [];
      let token = null;
      do {
        const page = await r2ListObjectsV2({ r2: target, prefix: "", continuation_token: token, require_valid_listing: true })
          .catch(() => { throw new Error(`R2 listing failed for ${target.bucket}. Check Object Read & Write on this disposable TEST bucket.`); });
        keys.push(...page.entries.map(entry => entry.key));
        assert(keys.length <= 4002 && (page.next_token === null || page.next_token !== token), "Invalid or oversized destination listing");
        token = page.next_token;
      } while (token);
      return keys.sort();
    }

    async function provision(target) {
      if (!precreated) {
        const apiToken = env.UK_AQ_R2_CLOUDFLARE_API_TOKEN;
        assert(apiToken, "Bucket creation requires the existing TEST R2 Storage Write API token, or precreate the two empty TEST buckets");
        const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json",
          ...(r2.endpoint.includes(".eu.r2.") ? { "cf-r2-jurisdiction": "eu" } : {}) };
        const options = () => ({ headers, signal: AbortSignal.timeout(30_000) });
        const existing = await fetch(`${collection}/${target.bucket}`, options());
        await existing.body?.cancel();
        assert(existing.status === 404, `Bucket name must be new and TEST bucket lookup must be authorized (HTTP ${existing.status})`);
        event({ stage, action: "create_bucket_attempt", bucket: target.bucket });
        const response = await fetch(collection, { ...options(), method: "POST", body: JSON.stringify({ name: target.bucket }) });
        const result = await response.json().catch(() => ({}));
        event({ stage, action: "create_bucket_result", bucket: target.bucket, status: response.status });
        assert(response.ok && result.success && result.result?.name === target.bucket,
          `TEST bucket creation was not confirmed (HTTP ${response.status}). Provision it separately if the existing token lacks R2 Storage Write.`);
      }
      assert((await list(target)).length === 0, `Expected a newly created and empty TEST bucket: ${target.bucket}`);
      event({ stage, action: "verified_empty_bucket", bucket: target.bucket });
    }

    async function seedObject(target, object) {
      assert(mode === "prepare" && [destination, invalid].includes(target), "Fixture writes require an isolated TEST destination");
      const { key, sha256, byte_size } = objectIdentity(object);
      event({ stage, action: "fixture_put_attempt", bucket: target.bucket, key, byte_size, sha256, if_none_match: "*" });
      const written = await r2PutObjectConditional({ r2: target, key, body: object.body, sha256, if_none_match: "*",
        content_type: key.endsWith(".json") ? "application/json" : "application/octet-stream" })
        .catch(error => { throw new Error(`Conditional fixture PUT failed in ${target.bucket} for ${key} (${error.status || error.code || "transport"}). ` +
          "Check Object Read & Write on this disposable TEST bucket. Inspect any partial setup before choosing fresh names."); });
      event({ stage, action: "fixture_put_succeeded", bucket: target.bucket, key, etag: written.etag });
    }

    stage = "source_verification";
    const fixture = await loadFixture(key => get(source, key));
    const original = objectIdentity(fixture.original);
    const predecessor = { key: LATEST, body: Buffer.from(fixture.predecessor.body) };
    const backup = { ...predecessor, key: fixture.backupKey };
    save("fixture", {
      source: SOURCE_BUCKET, original, predecessor: objectIdentity(predecessor), backup_key: backup.key,
      original_totals: fixture.originalTotals,
      predecessor_totals: { scopes: fixture.predecessor.payload.scoped_root_count, rows: fixture.predecessor.payload.total_rows },
      additions: fixture.additions, omitted_dependency: fixture.omittedKey,
      copied_dependencies: [...fixture.objects.values()].map(objectIdentity).sort((a, b) => a.key.localeCompare(b.key)),
    });

    const expected = (latest, negative = false) => {
      const objects = new Map(fixture.objects);
      objects.set(LATEST, latest);
      if (negative) objects.delete(fixture.omittedKey);
      else objects.set(backup.key, backup);
      return objects;
    };

    async function verifyBucket(target, objects, label) {
      const keys = [...objects.keys()].sort();
      assert((await list(target)).join("\n") === keys.join("\n"), `Unexpected key inventory in ${target.bucket}`);
      const identities = new Map();
      await forEachBounded(keys, async key => {
        const current = await get(target, key);
        assert(current.body.equals(objects.get(key).body), `Exact readback mismatch for ${key} in ${target.bucket}`);
        if (key === LATEST) latestRegistry(current);
        identities.set(key, objectIdentity(current));
      });
      save(label, { bucket: target.bucket, objects: keys.map(key => identities.get(key)) });
      return identities;
    }

    if (mode === "prepare") {
      stage = "prepare";
      // Check both targets before copying. Publish the predecessor only after all dependencies.
      await provision(destination);
      await provision(invalid);
      for (const [target, negative] of [[destination, false], [invalid, true]]) {
        const objects = expected(predecessor, negative);
        await forEachBounded([...objects.values()].filter(object => object.key !== LATEST), object => seedObject(target, object));
        await seedObject(target, predecessor);
        await verifyBucket(target, objects, negative ? "invalid-prepared" : "prepared");
      }
      outcome = "prepared";
      return;
    }

    function runUtility({ label, target = destination, digest, expectedError, pinned }) {
      const report = join(directory, `${label}-requests.ndjson`);
      writeFileSync(report, "");
      const args = ["--import", audit, tool, digest ? "apply" : "plan", "--day", DAY,
        "--connector", String(CONNECTOR), "--evidence", provenance];
      if (digest) args.push("--approved-plan-sha", digest);
      // Pass only the selected credentials and configuration through to the child.
      const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 12 * 60_000, env: {
        PATH: env.PATH, UK_AQ_ENV_NAME: "TEST", UK_AQ_R2_HISTORY_VERSION: "v3",
        CFLARE_R2_ENDPOINT: r2.endpoint, CFLARE_R2_BUCKET: target.bucket, CFLARE_R2_REGION: r2.region,
        CFLARE_R2_ACCESS_KEY_ID: r2.access_key_id, CFLARE_R2_SECRET_ACCESS_KEY: r2.secret_access_key,
        SUPABASE_DB_URL: database.href, RECOVERY_AUDIT_FILE: report,
        RECOVERY_EXPECTED_ETAG: pinned?.etag || "", RECOVERY_EXPECTED_SHA256: pinned ? original.sha256 : "",
      } });
      const events = readFileSync(report, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const writes = events.filter(item => item.event === "r2_request" && item.method !== "GET");
      const raw = result.stderr || "";
      const reason = raw.includes("Target connector is already partly or fully listed in latest") ? "target_already_listed"
        : raw.includes(`R2 GET failed (404) key=${fixture.omittedKey}:`) ? "missing_selected_dependency"
          : raw.includes("Fresh locked plan differs from the approved plan") ? "reviewed_digest_stale"
            : raw.includes("Timed out acquiring observations global operation lock") ? "global_lock_busy"
              : raw.includes("does not match the accepted deterministic writer") ? "canonical_rebuild_mismatch"
                : raw.includes("Conditional PUT precondition failed") ? "r2_precondition_failed"
                  : raw.includes("Conditional PUT outcome unknown") || raw.includes("Conditional PUT transport failure") ? "r2_put_ambiguous"
                    : result.error?.code || (result.status === 0 ? "completed" : "utility_failed");
      const reachedExpectedResult = !result.error && (expectedError ? result.status === 1 && reason === expectedError : result.status === 0);
      const failure = reachedExpectedResult ? undefined : describeUtilityFailure(result, events, reason);
      event({ stage: label, status: result.status, reason, writes: writes.length, failure });
      // Retain an ambiguous PUT reconciliation from the utility without copying its raw stderr.
      const reconciliationLine = raw.split("\n").find(line => line.startsWith("{\"plan_sha256\":"));
      if (reconciliationLine) {
        const { reconciliation } = JSON.parse(reconciliationLine);
        const live = reconciliation?.live;
        save(`${label}-reconciliation`, { status: reconciliation?.status, ...(live ? { live } : {}) });
      }
      assert(reachedExpectedResult, `${label} did not reach the expected result (${reason}): ${JSON.stringify(failure)}`);
      const acquired = events.filter(item => item.event === "lock_acquired");
      const assertions = events.filter(item => item.event === "lock_asserted");
      const backend = assertions[0]?.backend_pid;
      assert(acquired.length === 1 && backend && assertions.every(item => item.backend_pid === backend) &&
        events.at(-1)?.event === "lock_released" && events.at(-1).backend_pid === backend &&
        events[0]?.event === "db_session_read_only" && !events.some(item => item.event.endsWith("_blocked")),
      `${label} did not prove one continuous read-only PostgreSQL lock session`);
      assert.equal(writes.length, pinned ? 1 : 0, `${label} R2 write count differs`);
      if (pinned) {
        const putResult = events.findIndex(item => item.event === "r2_response" && item.method === "PUT");
        const readback = events[putResult + 1];
        const readbackResult = events[putResult + 2];
        assert(putResult >= 0 && events[putResult].status === 200 && events[putResult].if_match === pinned.etag &&
          readback?.event === "r2_request" && readback.method === "GET" && readback.key === LATEST && readback.backend_pid === backend &&
          readbackResult?.event === "r2_response" && readbackResult.method === "GET" && readbackResult.key === LATEST && readbackResult.status === 200,
        "Missing successful conditional PUT and immediate same-session GET");
      }
      if (expectedError) {
        if (expectedError === "missing_selected_dependency") {
          assert(events.some(item => item.event === "r2_response" && item.method === "GET" &&
            item.key === fixture.omittedKey && item.status === 404), "No R2 404 observed for the omitted exact dependency");
        }
        save(label, { outcome: "rejected", reason, canonical_write_attempts: 0, backend_pid: backend });
        return;
      }
      const plan = JSON.parse(result.stdout);
      save(label, plan);
      return plan;
    }

    function verifyPlan(result, before) {
      const { plan_sha256, status, readback, ...plan } = result;
      assert(plan_sha256 === sha256Hex(JSON.stringify(plan)) && (!approved || plan_sha256 === approved), "Plan digest does not match");
      assert.deepEqual(plan.predecessor, before);
      assert.deepEqual(plan.proposed, { key: LATEST, byte_size: original.byte_size, sha256: original.sha256 });
      assert.deepEqual(plan.additions, fixture.additions);
      assert(plan.target.bucket === bucket && plan.unchanged_scope_count === 10 && plan.added_scope_count === 2 &&
        plan.added_row_count === 5106 && plan.backup_key === backup.key && plan.dependency_evidence.retained_index_scopes === 10,
      "The plan does not match the expected add-only recovery");
      if (mode === "apply") {
        assert(status === "verified", "Utility did not verify apply");
        assert(readback.key === LATEST && readback.sha256 === original.sha256 && readback.byte_size === original.byte_size &&
          readback.backup.sha256 === before.sha256 && readback.backup.byte_size === before.byte_size && readback.backup.key === backup.key,
        "Utility did not authenticate the restored latest and predecessor backup");
      }
      return plan_sha256;
    }

    stage = "initial_destination_verification";
    const objectsBefore = expected(predecessor);
    const before = await verifyBucket(destination, objectsBefore, "before");
    if (mode === "plan") {
      stage = "plan";
      const digest = verifyPlan(runUtility({ label: "plan" }), before.get(LATEST));
      assert.deepEqual(await verifyBucket(destination, objectsBefore, "after-plan"), before);
      console.log(`Plan SHA-256 ${digest}`);
      outcome = "planned";
      return;
    }

    stage = "invalid_dependency";
    const invalidObjects = expected(predecessor, true);
    const invalidBefore = await verifyBucket(invalid, invalidObjects, "before-invalid");
    runUtility({ label: "invalid-dependency", target: invalid, digest: approved, expectedError: "missing_selected_dependency" });
    assert.deepEqual(await verifyBucket(invalid, invalidObjects, "after-invalid"), invalidBefore);

    stage = "apply";
    const current = await get(destination, LATEST);
    assert.deepEqual(objectIdentity(current), before.get(LATEST));
    assertExactObject(await get(destination, backup.key), { ...before.get(LATEST), key: backup.key });
    const applied = runUtility({ label: "apply", digest: approved, pinned: before.get(LATEST) });
    verifyPlan(applied, before.get(LATEST));
    stage = "stale_plan";
    const objectsAfter = expected(fixture.original);
    const after = await verifyBucket(destination, objectsAfter, "after-apply");
    const { key, byte_size, sha256, etag } = applied.readback;
    assert.deepEqual(after.get(LATEST), { key, byte_size, sha256, etag });
    for (const [key, identity] of before) {
      if (key !== LATEST) assert.deepEqual(after.get(key), identity, `Non-latest object changed: ${key}`);
    }
    // Replay the same real, now-stale approval after the predecessor has changed.
    runUtility({ label: "stale-plan", digest: approved, expectedError: "target_already_listed" });
    assert.deepEqual(await verifyBucket(destination, objectsAfter, "after-stale-plan"), after);
    outcome = "accepted";
  } catch (error) {
    // Provider payloads and raw command output are excluded from diagnostics.
    const message = String(error.message).split("\n")[0].slice(0, 400);
    event({ stage, outcome, error: message });
    console.error(`${stage}: ${message}`);
    process.exitCode = 1;
  } finally {
    save("result", { outcome, stage });
    console.log(`TEST latest recovery outcome ${outcome}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.env);
}
