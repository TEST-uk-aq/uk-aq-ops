#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  withHistoryWriterClient,
  withObservationsGlobalOperationLock,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value === "--") throw new Error(`${flag} requires a value`);
  return value;
}

export function parseLockedCommandArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("Lock coordinator requires -- followed by a command");
  }
  const options = {
    owner: null,
    runId: null,
    timeoutMs: 60_000,
    heartbeatMs: 5_000,
  };
  for (let index = 0; index < separator; index += 1) {
    const flag = argv[index];
    if (flag === "--owner") options.owner = requireValue(argv, index++, flag);
    else if (flag === "--run-id") options.runId = requireValue(argv, index++, flag);
    else if (flag === "--timeout-ms") options.timeoutMs = Number(requireValue(argv, index++, flag));
    else if (flag === "--heartbeat-ms") options.heartbeatMs = Number(requireValue(argv, index++, flag));
    else throw new Error(`Unknown lock coordinator argument: ${flag}`);
  }
  if (!String(options.owner || "").trim()) throw new Error("--owner is required");
  if (!String(options.runId || "").trim()) throw new Error("--run-id is required");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("--timeout-ms must be a non-negative number");
  }
  if (!Number.isFinite(options.heartbeatMs) || options.heartbeatMs < 250) {
    throw new Error("--heartbeat-ms must be at least 250");
  }
  return Object.freeze({
    ...options,
    command: argv[separator + 1],
    commandArgs: Object.freeze(argv.slice(separator + 2)),
  });
}

function terminateProcessGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill(signal);
  }
}

export async function runChildWhileLockHeld({
  command,
  commandArgs = [],
  env,
  lockSignal,
  spawnProcess = spawn,
  terminate = terminateProcessGroup,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, commandArgs, {
      env,
      stdio: "inherit",
      detached: true,
    });
    let lossTimer = null;
    const stopForLostLock = () => {
      terminate(child, "SIGTERM");
      lossTimer = setTimeout(() => terminate(child, "SIGKILL"), 10_000);
      lossTimer.unref?.();
    };
    if (lockSignal?.aborted) stopForLostLock();
    else lockSignal?.addEventListener("abort", stopForLostLock, { once: true });

    const forwardSignal = (signal) => terminate(child, signal);
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = () => {
      if (lossTimer) clearTimeout(lossTimer);
      lockSignal?.removeEventListener("abort", stopForLostLock);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (lockSignal?.aborted) {
        reject(lockSignal.reason || new Error("Observations global operation lock was lost"));
      } else if (signal) {
        const error = new Error(`Locked command terminated by ${signal}`);
        error.code = "UK_AQ_LOCKED_COMMAND_SIGNAL";
        reject(error);
      } else {
        resolve(Number(code || 0));
      }
    });
  });
}

export async function runCommandWithObservationsGlobalOperationLock({
  databaseUrl,
  owner,
  runId,
  command,
  commandArgs = [],
  env = process.env,
  timeoutMs = 60_000,
  heartbeatMs = 5_000,
  diagnostics = [],
  spawnProcess = spawn,
  withClient = withHistoryWriterClient,
} = {}) {
  const connectionString = String(databaseUrl || "").trim();
  if (!connectionString) {
    const error = new Error(
      "Observations global operation lock requires a direct SUPABASE_DB_URL (or DATABASE_URL)",
    );
    error.code = "UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_DATABASE_URL_REQUIRED";
    throw error;
  }
  const nonce = randomUUID();
  return await withClient(connectionString, async (client) => {
    return await withObservationsGlobalOperationLock({
      client,
      owner,
      runId,
      timeoutMs,
      heartbeatMs,
      diagnostics,
      diagnosticEnvironment: env.UKAQ_ENV_NAME || env.UK_AQ_ENV || env.ENVIRONMENT,
    }, async (identity, lock) => {
      const acquiredDiagnostic = [...diagnostics].reverse().find(
        (entry) => entry.event === "lock_acquired",
      );
      const childEnv = {
        ...env,
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: String(owner),
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: String(runId),
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: nonce,
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: String(acquiredDiagnostic?.wait_ms || 0),
        [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
      };
      const code = await runChildWhileLockHeld({
        command,
        commandArgs,
        env: childEnv,
        lockSignal: lock.signal,
        spawnProcess,
      });
      lock.assertHeld();
      return code;
    });
  }, {
    applicationName: `uk-aq-observations-global-operation-lock:${String(owner)}`,
    statementTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
  });
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseLockedCommandArgs(argv);
  const diagnostics = [];
  try {
    return await runCommandWithObservationsGlobalOperationLock({
      databaseUrl: env.SUPABASE_DB_URL || env.DATABASE_URL,
      owner: args.owner,
      runId: args.runId,
      command: args.command,
      commandArgs: args.commandArgs,
      env,
      timeoutMs: args.timeoutMs,
      heartbeatMs: args.heartbeatMs,
      diagnostics,
    });
  } finally {
    for (const diagnostic of diagnostics) {
      process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    }
  }
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
