#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const CONTROLLED_PHASE_B_SOURCE_FREEZE_ENV =
  "UK_AQ_CONTROLLED_PHASE_B_SOURCE_WRITE_FREEZE";
export const CONTROLLED_PHASE_B_CHILD_TIMEZONE = "UTC";

export const CONTROLLED_PHASE_B_SOURCE_TABLES = Object.freeze([
  "uk_aq_core.observations",
  "uk_aq_core.timeseries",
  "uk_aq_core.phenomena",
  "uk_aq_core.observed_properties",
]);

function fail(message) {
  const error = new Error(message);
  error.code = "UK_AQ_CONTROLLED_PHASE_B_SOURCE_FREEZE_FAILED";
  throw error;
}

export function parseControlledPhaseBSourceFreezeArgs(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--");
  if (separator !== 0 || argv.length < 2) {
    fail("Source-freeze coordinator requires -- followed by a command");
  }
  return Object.freeze({
    command: argv[1],
    commandArgs: Object.freeze(argv.slice(2)),
  });
}

function childOptionValue(commandArgs, flag) {
  const index = commandArgs.lastIndexOf(flag);
  if (index < 0 || index >= commandArgs.length - 1) return null;
  const value = String(commandArgs[index + 1] || "").trim();
  return value || null;
}

function appendSourceFreezeEvidence(reportPath, evidence, { required } = { required: false }) {
  if (!reportPath) {
    if (required) fail("Controlled Phase B child did not expose --report-out for source-freeze evidence");
    return false;
  }
  if (!fs.existsSync(reportPath)) {
    if (required) fail(`Controlled Phase B evidence report is missing after successful child: ${reportPath}`);
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    fail(`Controlled Phase B evidence report could not be read for source-freeze evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("Controlled Phase B evidence report is not a JSON object");
  }
  payload.source_write_freeze = evidence;
  fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}

async function defaultRunChild({ command, commandArgs, env }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        const error = new Error(`Controlled Phase B child terminated by ${signal}`);
        error.code = "UK_AQ_CONTROLLED_PHASE_B_CHILD_SIGNAL";
        reject(error);
        return;
      }
      resolve(Number(code || 0));
    });
  });
}

export async function runWithControlledPhaseBSourceWriteFreeze({
  databaseUrl,
  command,
  commandArgs = [],
  env = process.env,
  lockTimeoutMs = 60_000,
  createClient = (config) => new Client(config),
  runChild = defaultRunChild,
  appendEvidence = appendSourceFreezeEvidence,
} = {}) {
  const connectionString = String(databaseUrl || "").trim();
  if (!connectionString) {
    fail("Controlled Phase B source freeze requires SUPABASE_DB_URL");
  }
  if (!String(command || "").trim()) {
    fail("Controlled Phase B source freeze requires a child command");
  }
  if (!Number.isFinite(Number(lockTimeoutMs)) || Number(lockTimeoutMs) < 1) {
    fail("Controlled Phase B source freeze lock timeout must be positive");
  }

  const client = createClient({
    connectionString,
    application_name: "uk-aq-index-v3-controlled-phase-b-source-freeze",
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: 15_000,
  });

  let transactionOpen = false;
  const coordinatorStartedAtUtc = new Date().toISOString();
  let lockAcquiredAtUtc = null;
  await client.connect();
  try {
    await client.query("begin");
    transactionOpen = true;
    await client.query(`set local lock_timeout = '${Math.trunc(Number(lockTimeoutMs))}ms'`);
    await client.query(
      `lock table ${CONTROLLED_PHASE_B_SOURCE_TABLES.join(", ")} in share mode`,
    );
    lockAcquiredAtUtc = new Date().toISOString();

    process.stderr.write(`${JSON.stringify({
      event: "controlled_phase_b_source_write_freeze_acquired",
      lock_mode: "SHARE",
      tables: CONTROLLED_PHASE_B_SOURCE_TABLES,
      acquired_at_utc: lockAcquiredAtUtc,
      child_timezone: CONTROLLED_PHASE_B_CHILD_TIMEZONE,
    })}\n`);

    const childCode = await runChild({
      command,
      commandArgs,
      env: {
        ...env,
        TZ: CONTROLLED_PHASE_B_CHILD_TIMEZONE,
        [CONTROLLED_PHASE_B_SOURCE_FREEZE_ENV]: "held",
      },
    });

    await client.query("rollback");
    transactionOpen = false;
    const releasedAtUtc = new Date().toISOString();

    const freezeEvidence = {
      held_during_controlled_child: true,
      lock_mode: "SHARE",
      tables: CONTROLLED_PHASE_B_SOURCE_TABLES,
      coordinator_started_at_utc: coordinatorStartedAtUtc,
      acquired_at_utc: lockAcquiredAtUtc,
      released_at_utc: releasedAtUtc,
      child_exit_code: childCode,
      child_timezone: CONTROLLED_PHASE_B_CHILD_TIMEZONE,
      persistent_database_mutation: false,
    };

    const isApplyChild = commandArgs.includes("--apply");
    appendEvidence(
      childOptionValue(commandArgs, "--report-out"),
      freezeEvidence,
      { required: childCode === 0 && isApplyChild },
    );

    process.stderr.write(`${JSON.stringify({
      event: "controlled_phase_b_source_write_freeze_released",
      child_exit_code: childCode,
      released_at_utc: releasedAtUtc,
      child_timezone: CONTROLLED_PHASE_B_CHILD_TIMEZONE,
    })}\n`);

    return childCode;
  } finally {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch (_rollbackError) {
        // Preserve the primary failure while still attempting to release locks.
      }
    }
    await client.end();
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseControlledPhaseBSourceFreezeArgs(argv);
  return await runWithControlledPhaseBSourceWriteFreeze({
    databaseUrl: env.SUPABASE_DB_URL,
    command: args.command,
    commandArgs: args.commandArgs,
    env,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
