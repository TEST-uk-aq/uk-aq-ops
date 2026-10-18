import { flushPhaseBServiceEgressMetrics } from "./pg_source_egress_diagnostic.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  observationsGlobalOperationLockContext,
} from "../shared/uk_aq_r2_history_writer.mjs";
import {
  runCommandWithObservationsGlobalOperationLock,
} from "../../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs";
import {
  buildRunConfig,
  executePruneDaily,
  reportPruneDailyError,
} from "./server.mjs";

const REPORT_PATH = "tmp/uk_aq_prune_daily_report.json";

function boundedValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 4_000 ? value : `${value.slice(0, 3_997)}...`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => boundedValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 100).map(([key, entry]) => [key, boundedValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

export async function writeReport(payload) {
  await mkdir("tmp", { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(boundedValue(payload), null, 2)}\n`, "utf8");
}

export async function runPruneDailyJob({
  env = process.env,
  buildRunConfigAdapter = buildRunConfig,
  executePruneDailyAdapter = executePruneDaily,
  reportPruneDailyErrorAdapter = reportPruneDailyError,
  writeReportAdapter = writeReport,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  const lockContext = observationsGlobalOperationLockContext({
    env,
    expectedOwner: "prune_daily",
  });
  const lockReport = lockContext.valid ? {
    owner: lockContext.owner,
    run_id: lockContext.run_id,
    logical_identity: lockContext.logical_identity,
    acquired: lockContext.acquired,
    wait_ms: lockContext.wait_ms,
    outcome: lockContext.outcome,
  } : null;
  const url = new URL("http://localhost/");
  if (env.INPUT_DRY_RUN === "true") {
    url.searchParams.set("dryRun", "true");
  }

  try {
    const config = buildRunConfigAdapter(url);
    const summary = await executePruneDailyAdapter(config);
    const payload = {
      ok: true,
      summary,
      ...(lockReport ? { observations_global_operation_lock: lockReport } : {}),
    };
    await writeReportAdapter(payload);
    return payload;
  } catch (error) {
    const errorReport = await reportPruneDailyErrorAdapter(error, {
      execution_mode: "github_actions",
    });
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...errorReport,
      ...(lockReport ? { observations_global_operation_lock: lockReport } : {}),
    };
    await writeReportAdapter(payload);
    setExitCode(1);
    return payload;
  } finally {
    try {
      await flushPhaseBServiceEgressMetrics({ env });
    } catch (_metricsError) {
      // Metrics are observational and must never change Prune Daily's outcome.
    }
  }
}

export async function runPruneDailyJobWithGlobalLock({
  env = process.env,
  runLockedCommand = runCommandWithObservationsGlobalOperationLock,
  runJob = runPruneDailyJob,
} = {}) {
  const lockContext = observationsGlobalOperationLockContext({
    env,
    expectedOwner: "prune_daily",
  });
  if (lockContext.held && !lockContext.valid) {
    throw new Error("Prune Daily received an invalid observations global operation lock context");
  }
  if (lockContext.valid) return await runJob({ env });
  const runId = `prune-daily:${String(env.GITHUB_RUN_ID || process.pid)}:${String(env.GITHUB_RUN_ATTEMPT || "local")}`;
  return {
    delegated: true,
    exitCode: await runLockedCommand({
      databaseUrl: env.SUPABASE_DB_URL || env.DATABASE_URL,
      owner: "prune_daily",
      runId,
      command: process.execPath,
      commandArgs: [fileURLToPath(import.meta.url)],
      env,
    }),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const result = await runPruneDailyJobWithGlobalLock();
  if (result?.delegated) process.exitCode = result.exitCode;
}
