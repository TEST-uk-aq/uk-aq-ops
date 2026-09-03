#!/usr/bin/env node

import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
} from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
  encodeObservationHistoryIndexV3Json,
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  resolveObservationHistoryIndexV3BuildConfig,
  runDisconnectedSupportedBackfillObservationHistoryV3Writer,
} from "../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  withHistoryWriterClient,
  withObservationsGlobalOperationLock,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";

const SCRIPT_NAME = "uk_aq_obsaqidb_supported_v3_backfill";
const LOCK_OWNER = "observation_history_supported_backfill";
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

function usage() {
  return [
    "Plan or apply a bounded TEST ObsAQIDB backfill through the existing supported v3 writer.",
    "",
    "Usage (read-only plan):",
    `  node scripts/index_v3_migration/${SCRIPT_NAME}.mjs \\`,
    "    --environment TEST --from-day YYYY-MM-DD --to-day YYYY-MM-DD \\",
    "    --connector-id <positive-integer> [--connector-id ...] \\",
    "    --pollutant <canonical-code> [--pollutant ...]",
    "",
    "Usage (R2 mutation, after reviewing the plan):",
    `  node scripts/index_v3_migration/${SCRIPT_NAME}.mjs \\`,
    "    --from-day YYYY-MM-DD --to-day YYYY-MM-DD \\",
    "    --connector-id <positive-integer> [--connector-id ...] \\",
    "    --pollutant <canonical-code> [--pollutant ...] \\",
    "    --apply --environment TEST --expected-bucket <exact-bucket> \\",
    "    --run-id <stable-id> --target-writer-git-sha <40-hex> \\",
    "    --expected-plan-sha256 <64-hex>",
    "",
    "Options:",
    "  --from-day YYYY-MM-DD            First UTC day, inclusive",
    "  --to-day YYYY-MM-DD              Last UTC day, inclusive",
    "  --connector-id <id>              Connector; repeatable",
    "  --pollutant <code>               Pollutant; repeatable",
    "  --dry-run                        Read-only plan (default)",
    "  --apply                          Permit the authenticated R2 mutation path",
    "  --environment TEST               Required in every mode; this TEST CLI rejects LIVE",
    "  --expected-bucket <bucket>       Required with --apply",
    "  --run-id <id>                    Required with --apply; also identifies the global lock",
    "  --target-writer-git-sha <sha>    Required with --apply and must equal clean HEAD",
    "  --expected-plan-sha256 <sha>     Required with --apply and must equal this source plan",
    "  -h, --help                       Show this help",
    "",
    "Required source DB env (first non-empty):",
    "  UK_AQ_OBSAQIDB_DB_URL",
    "  UK_AQ_OBSAQIDB_DATABASE_URL",
    "  OBS_AQIDB_SUPABASE_DB_URL",
    "  OBS_AQIDB_DATABASE_URL",
    "  OBS_AQI_DB_URL",
    "",
    "Additional --apply requirements:",
    "  UK_AQ_ENV_NAME=TEST (or UKAQ_ENV_NAME=TEST)",
    "  UK_AQ_R2_HISTORY_VERSION=v2",
    "  UK_AQ_R2_HISTORY_INDEX_VERSION=v3",
    "  SUPABASE_DB_URL (or DATABASE_URL) for the advisory-lock client",
    "  existing configured R2 endpoint, bucket and credentials",
    `  UK_AQ_SUPPORTED_V3_BACKFILL_AUTHORIZATION=AUTHORISE_TEST_SUPPORTED_V3_BACKFILL:<run-id>:<plan-sha256>`,
    "",
    `Apply refuses to bootstrap: ${DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY}`,
    "must already exist as canonical v3 authority.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeDay(raw, flag) {
  const day = String(raw || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD UTC day`);
  }
  return day;
}

function normalizeConnectorId(raw) {
  const connectorId = Number(raw);
  if (!Number.isSafeInteger(connectorId) || connectorId <= 0) {
    throw new Error(`--connector-id must be a positive integer: ${String(raw || "")}`);
  }
  return connectorId;
}

function normalizePollutant(raw) {
  const pollutant = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(pollutant)) {
    throw new Error(`--pollutant must be a canonical lower-case code: ${String(raw || "")}`);
  }
  return pollutant;
}

function parseArgs(argv) {
  const args = {
    fromDay: "",
    toDay: "",
    connectorIds: [],
    pollutants: [],
    apply: false,
    sawDryRun: false,
    environment: "",
    expectedBucket: "",
    runId: "",
    targetWriterGitSha: "",
    expectedPlanSha256: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--from-day") args.fromDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--to-day") args.toDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--connector-id") args.connectorIds.push(normalizeConnectorId(requireValue(argv, index++, flag)));
    else if (flag === "--pollutant") args.pollutants.push(normalizePollutant(requireValue(argv, index++, flag)));
    else if (flag === "--dry-run") args.sawDryRun = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--environment") args.environment = requireValue(argv, index++, flag).toUpperCase();
    else if (flag === "--expected-bucket") args.expectedBucket = requireValue(argv, index++, flag);
    else if (flag === "--run-id") args.runId = requireValue(argv, index++, flag);
    else if (flag === "--target-writer-git-sha") args.targetWriterGitSha = requireValue(argv, index++, flag).toLowerCase();
    else if (flag === "--expected-plan-sha256") args.expectedPlanSha256 = requireValue(argv, index++, flag).toLowerCase();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const [field, flag] of [[args.fromDay, "--from-day"], [args.toDay, "--to-day"]]) {
    if (!field) throw new Error(`${flag} is required`);
  }
  if (!args.connectorIds.length) throw new Error("At least one --connector-id is required");
  if (!args.pollutants.length) throw new Error("At least one --pollutant is required");
  if (args.fromDay > args.toDay) throw new Error("--to-day must not be earlier than --from-day");
  if (args.sawDryRun && args.apply) throw new Error("Use either --dry-run or --apply, not both");
  args.connectorIds = [...new Set(args.connectorIds)].sort((left, right) => left - right);
  args.pollutants = [...new Set(args.pollutants)].sort();
  if (!args.environment) throw new Error("--environment TEST is required");
  if (args.environment !== "TEST") throw new Error("This CLI permits only --environment TEST");
  if (args.apply) {
    for (const [field, flag] of [
      [args.expectedBucket, "--expected-bucket"],
      [args.runId, "--run-id"],
      [args.targetWriterGitSha, "--target-writer-git-sha"],
      [args.expectedPlanSha256, "--expected-plan-sha256"],
    ]) {
      if (!field) throw new Error(`${flag} is required with --apply`);
    }
    if (!FULL_GIT_SHA.test(args.targetWriterGitSha)) {
      throw new Error("--target-writer-git-sha must be a full lower-case Git SHA");
    }
    if (!/^[0-9a-f]{64}$/.test(args.expectedPlanSha256)) {
      throw new Error("--expected-plan-sha256 must be lower-case SHA-256");
    }
  } else if (
    args.expectedBucket || args.runId || args.targetWriterGitSha || args.expectedPlanSha256
  ) {
    throw new Error("Apply authority arguments are valid only with --apply");
  }
  return args;
}

function daysInclusive(fromDay, toDay) {
  const result = [];
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  for (let current = Date.parse(`${fromDay}T00:00:00.000Z`); current <= end; current += 86_400_000) {
    result.push(new Date(current).toISOString().slice(0, 10));
  }
  return result;
}

function resolveEnvironmentValue(env, names, label) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return { name, value };
  }
  throw new Error(`${label} is required (${names.join(", ")})`);
}

function sourceDatabase(env) {
  return resolveEnvironmentValue(env, [
    "UK_AQ_OBSAQIDB_DB_URL",
    "UK_AQ_OBSAQIDB_DATABASE_URL",
    "OBS_AQIDB_SUPABASE_DB_URL",
    "OBS_AQIDB_DATABASE_URL",
    "OBS_AQI_DB_URL",
  ], "ObsAQIDB database URL");
}

function assertConfiguredTestEnvironment(env) {
  const configured = String(env.UK_AQ_ENV_NAME || env.UKAQ_ENV_NAME || "")
    .trim()
    .toUpperCase();
  if (configured !== "TEST") {
    throw new Error("TEST ObsAQIDB access requires UK_AQ_ENV_NAME=TEST (or UKAQ_ENV_NAME=TEST)");
  }
}

function timestampBounds(dayUtc) {
  const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86_400_000).toISOString(),
  };
}

async function readPartitionRows(client, scope) {
  const bounds = timestampBounds(scope.day_utc);
  const result = await client.query(
    `
select
  o.connector_id::integer as connector_id,
  ts.station_id::bigint::text as station_id,
  o.timeseries_id::bigint::text as timeseries_id,
  lower(btrim(op.code))::text as pollutant_code,
  (extract(epoch from o.observed_at) * 1000)::numeric::text as observed_at_epoch_ms,
  (date_trunc('milliseconds', o.observed_at) = o.observed_at) as exact_millisecond,
  o.value::double precision as value
from uk_aq_observs.observations o
join uk_aq_core.timeseries ts
  on ts.id = o.timeseries_id
 and ts.connector_id = o.connector_id
join uk_aq_core.phenomena p
  on p.id = ts.phenomenon_id
join uk_aq_core.observed_properties op
  on op.id = p.observed_property_id
where o.connector_id = $1::integer
  and o.observed_at >= $2::timestamptz
  and o.observed_at < $3::timestamptz
  and lower(btrim(op.code)) = $4::text
order by o.observed_at, o.timeseries_id
`,
    [scope.connector_id, bounds.start, bounds.end, scope.pollutant_code],
  );
  return result.rows.map((row) => {
    const epochMs = Number(row.observed_at_epoch_ms);
    if (row.exact_millisecond !== true || !Number.isSafeInteger(epochMs)) {
      throw new Error(
        `ObsAQIDB timestamp is not exact UTC milliseconds: ${scope.day_utc}/${scope.connector_id}/${scope.pollutant_code}`,
      );
    }
    const timeseriesId = Number(row.timeseries_id);
    const stationId = row.station_id === null ? null : Number(row.station_id);
    return normalizeCanonicalObservationRow({
      connector_id: Number(row.connector_id),
      station_id: stationId,
      timeseries_id: timeseriesId,
      pollutant_code: row.pollutant_code,
      observed_at_utc: new Date(epochMs).toISOString(),
      value: row.value,
      verification_status: null,
    });
  });
}

function requestedScopes(args) {
  return daysInclusive(args.fromDay, args.toDay).flatMap((dayUtc) =>
    args.connectorIds.flatMap((connectorId) =>
      args.pollutants.map((pollutantCode) => ({
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
      })),
    ),
  );
}

async function loadPlan(args, env) {
  const source = sourceDatabase(env);
  const client = new Client({
    connectionString: source.value,
    application_name: SCRIPT_NAME,
    statement_timeout: 300_000,
    query_timeout: 300_000,
    connectionTimeoutMillis: 15_000,
  });
  const partitions = [];
  const plannedScopes = [];
  const failures = [];
  await client.connect();
  try {
    await client.query("set extra_float_digits = 3");
    for (const scope of requestedScopes(args)) {
      try {
        const rows = await readPartitionRows(client, scope);
        if (!rows.length) {
          plannedScopes.push({ ...scope, status: "empty_skipped", row_count: 0 });
          continue;
        }
        const content = computeObservationContentHash(rows);
        plannedScopes.push({
          ...scope,
          status: "planned",
          row_count: rows.length,
          first_observation_utc: rows[0].observed_at_utc,
          last_observation_utc: rows.at(-1).observed_at_utc,
          observation_content_hash: content.observation_content_hash,
        });
        partitions.push({ scope, rows });
      } catch (error) {
        failures.push({
          scope,
          stage: "source_query_or_normalization",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await client.end();
  }
  const planAuthority = {
    schema_version: 1,
    source: "TEST_ObsAQIDB",
    from_day: args.fromDay,
    to_day: args.toDay,
    connector_ids: args.connectorIds,
    pollutant_codes: args.pollutants,
    scopes: plannedScopes,
  };
  if (!failures.length && !partitions.length) {
    failures.push({
      scope: null,
      stage: "source_planning",
      error: "The requested selection contains no non-empty ObsAQIDB partitions",
    });
  }
  return {
    sourceEnvName: source.name,
    partitions,
    plannedScopes,
    failures,
    planSha256: sha256Hex(JSON.stringify(planAuthority)),
  };
}

function observationBounds(plannedScopes) {
  const values = plannedScopes.flatMap((scope) => [
    scope.first_observation_utc,
    scope.last_observation_utc,
  ]).filter(Boolean).sort();
  return { first: values[0] || null, last: values.at(-1) || null };
}

function baseReport(args, plan) {
  const bounds = observationBounds(plan.plannedScopes);
  return {
    schema_version: 1,
    kind: "uk_aq_obsaqidb_supported_v3_backfill_report",
    ok: plan.failures.length === 0,
    mode: args.apply ? "apply" : "dry_run",
    source: "TEST_ObsAQIDB",
    source_database_env: plan.sourceEnvName,
    requested: {
      from_day: args.fromDay,
      to_day: args.toDay,
      connector_ids: args.connectorIds,
      pollutant_codes: args.pollutants,
    },
    plan_sha256: plan.planSha256,
    planned_scopes: plan.plannedScopes,
    completed_scopes: [],
    planned_scope_count: plan.plannedScopes.filter((scope) => scope.status === "planned").length,
    completed_scope_count: 0,
    row_count: plan.plannedScopes.reduce((sum, scope) => sum + Number(scope.row_count || 0), 0),
    connectors: args.connectorIds,
    pollutants: args.pollutants,
    first_observation_utc: bounds.first,
    last_observation_utc: bounds.last,
    failures: plan.failures,
    supported_backfill_post_cutover_only: true,
    verification_status: null,
    timeseries_binding_updated: false,
  };
}

function assertCleanPinnedHead(targetWriterGitSha) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  if (head !== targetWriterGitSha) {
    throw new Error(`--target-writer-git-sha ${targetWriterGitSha} does not equal current HEAD ${head}`);
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" });
  if (dirty.trim()) throw new Error("--apply requires a clean repository worktree");
  return head;
}

function validateApplyAuthority(args, env, plan, config) {
  assertConfiguredTestEnvironment(env);
  if (String(env.UK_AQ_R2_HISTORY_VERSION || "").trim() !== "v2") {
    throw new Error("--apply requires UK_AQ_R2_HISTORY_VERSION=v2");
  }
  if (String(env.UK_AQ_R2_HISTORY_INDEX_VERSION || "").trim() !== "v3") {
    throw new Error("--apply requires UK_AQ_R2_HISTORY_INDEX_VERSION=v3");
  }
  resolveObservationHistoryIndexV3BuildConfig({ env });
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("--apply requires complete configured R2 endpoint, bucket, region and credentials");
  }
  if (!config.r2.bucket || config.r2.bucket !== args.expectedBucket) {
    throw new Error("Configured R2 bucket does not equal --expected-bucket");
  }
  if (plan.planSha256 !== args.expectedPlanSha256) {
    throw new Error(`Current source plan SHA-256 ${plan.planSha256} does not equal --expected-plan-sha256`);
  }
  const expectedAuthorization =
    `AUTHORISE_TEST_SUPPORTED_V3_BACKFILL:${args.runId}:${plan.planSha256}`;
  if (env.UK_AQ_SUPPORTED_V3_BACKFILL_AUTHORIZATION !== expectedAuthorization) {
    throw new Error(
      "UK_AQ_SUPPORTED_V3_BACKFILL_AUTHORIZATION does not exactly authorize this TEST run and plan",
    );
  }
  assertCleanPinnedHead(args.targetWriterGitSha);
  return expectedAuthorization;
}

async function assertExistingCanonicalV3Latest(r2) {
  const key = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY;
  let object;
  try {
    object = await r2GetObject({ r2, key });
  } catch (error) {
    throw new Error(`Post-cutover v3 latest authority is required before supported backfill: ${key}`, {
      cause: error,
    });
  }
  const bytes = Buffer.from(object.body);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Post-cutover v3 latest authority is invalid JSON: ${key}`);
  }
  if (
    payload.kind !== "observation_timeseries_latest_global" ||
    payload.index_generation !== "v3" ||
    payload.history_version !== "v2" ||
    payload.domain !== "observations" ||
    payload.key_layout?.latest_key !== key ||
    bytes.toString("utf8") !== encodeObservationHistoryIndexV3Json(payload)
  ) {
    throw new Error(`Post-cutover v3 latest authority is non-canonical or contradictory: ${key}`);
  }
  return { key, sha256: sha256Hex(bytes), byte_size: bytes.byteLength };
}

async function applyPlan(args, env, plan, report) {
  const config = resolveR2HistoryIndexConfig(env);
  validateApplyAuthority(args, env, plan, config);
  if (plan.failures.length) throw new Error("Source planning failed; --apply is not permitted");
  if (!plan.partitions.length) throw new Error("No non-empty source partitions are available to apply");
  const lockDatabaseUrl = String(env.SUPABASE_DB_URL || env.DATABASE_URL || "").trim();
  if (!lockDatabaseUrl) {
    throw new Error("--apply requires SUPABASE_DB_URL (or DATABASE_URL) for PostgreSQL advisory locks");
  }
  return await withHistoryWriterClient(lockDatabaseUrl, async (lockClient) => {
    return await withObservationsGlobalOperationLock({
      client: lockClient,
      owner: LOCK_OWNER,
      runId: args.runId,
      diagnosticEnvironment: "TEST",
    }, async (_identity, held) => {
      held.assertHeld();
      report.preexisting_v3_latest = await assertExistingCanonicalV3Latest(config.r2);
      held.assertHeld();
      const result = await runDisconnectedSupportedBackfillObservationHistoryV3Writer({
        env,
        client: lockClient,
        partitions: plan.partitions,
        targetWriterGitSha: args.targetWriterGitSha,
        observationsPrefix: config.observations_prefix_v2,
        r2: config.r2,
        diagnosticEnvironment: "TEST",
      });
      held.assertHeld();
      return result;
    });
  }, {
    applicationName: SCRIPT_NAME,
    statementTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
    connectionTimeoutMs: 15_000,
  });
}

export async function runObsAqiDbSupportedV3Backfill({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, text: usage() };
  assertConfiguredTestEnvironment(env);
  const plan = await loadPlan(args, env);
  const report = baseReport(args, plan);
  if (plan.failures.length) return { help: false, report };
  if (!args.apply) return { help: false, report };
  try {
    const writerResult = await applyPlan(args, env, plan, report);
    report.completed_scopes = plan.plannedScopes.filter((scope) => scope.status === "planned")
      .map((scope) => ({
        day_utc: scope.day_utc,
        connector_id: scope.connector_id,
        pollutant_code: scope.pollutant_code,
        row_count: scope.row_count,
        status: "completed",
      }));
    report.completed_scope_count = report.completed_scopes.length;
    report.writer = {
      status: writerResult.status,
      source: writerResult.source,
      affected_partition_count: writerResult.affected_partition_count,
      affected_days_utc: writerResult.affected_days_utc,
      latest_global_status: writerResult.v3_publication?.latest_global?.status ?? null,
    };
    report.ok = writerResult.ok === true;
  } catch (error) {
    report.ok = false;
    report.failures.push({
      scope: null,
      stage: "apply",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { help: false, report };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await runObsAqiDbSupportedV3Backfill();
    process.stdout.write(result.help ? `${result.text}\n` : `${JSON.stringify(result.report, null, 2)}\n`);
    if (!result.help && result.report.ok !== true) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema_version: 1,
      kind: "uk_aq_obsaqidb_supported_v3_backfill_error",
      ok: false,
      failures: [{
        scope: null,
        stage: "initialization",
        error: error instanceof Error ? error.message : String(error),
      }],
    })}\n`);
    process.exitCode = 1;
  }
}
