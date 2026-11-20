import { flushPhaseBServiceEgressMetrics } from "./pg_source_egress_diagnostic.mjs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from 'node:crypto';
import { createPruneOriginalOperation } from '../../scripts/operations/lib/uk_aq_prune_original_operation.mjs';
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
import { createDailyTaskHealthClient } from "../shared/daily_task_health.mjs";
import { resolveWorkerLaunch } from "./worker_budget.mjs";

const REPORT_PATH = "tmp/uk_aq_prune_daily_report.json";
const HEALTH_REQUEST_MS = 10_000;
// Existing connection (15s), lock acquisition (60s plus a last query of up to
// 30s), initial ownership assertion (30s) and a startup margin.
const GLOBAL_LOCK_ADMISSION_MS = 140_000;

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
  const pendingPath = `${REPORT_PATH}.${process.pid}.tmp`;
  await writeFile(pendingPath, `${JSON.stringify(boundedValue(payload), null, 2)}\n`, "utf8");
  await rename(pendingPath, REPORT_PATH);
}

export async function runPruneDailyJob({
  env = process.env,
  workerBudget = null,
  buildRunConfigAdapter = buildRunConfig,
  executePruneDailyAdapter = executePruneDaily,
  reportPruneDailyErrorAdapter = reportPruneDailyError,
  writeReportAdapter = writeReport,
  createOriginalOperationAdapter = (context) => process.connected && typeof process.send === "function"
    ? createPruneOriginalOperation({ runId: context.run_id, nonce: context.nonce }) : null,
  createHealthClientAdapter = createDailyTaskHealthClient,
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
  const originalOperation = lockContext.valid ? createOriginalOperationAdapter(lockContext) : null;
  const url = new URL("http://localhost/");
  if (env.INPUT_DRY_RUN === "true") {
    url.searchParams.set("dryRun", "true");
  }
  let terminalHealth;
  let reportSaved = false;
  async function optionalHealth(operation) {
    try {
      return await operation();
    } catch {
      console.warn(JSON.stringify({ severity: "WARNING", event: "prune_optional_task_health_failed" }));
      return null;
    }
  }
  async function supervisedTaskRun(input, run) {
    const health = createHealthClientAdapter({ env, requestTimeoutMs: HEALTH_REQUEST_MS });
    const healthRunId = workerBudget.fits(HEALTH_REQUEST_MS)
      ? await optionalHealth(() => health.dailyTaskStarted({ ...input, summary: input.startSummary }))
      : null;
    try {
      const summary = await run();
      if (healthRunId) terminalHealth = () => health.dailyTaskFinished(healthRunId, {
        ...input, summary: input.buildFinishedSummary(summary),
      });
      return summary;
    } catch (error) {
      if (healthRunId) terminalHealth = () => health.dailyTaskFailed(healthRunId, error, {
        ...input, summary: input.buildFailedSummary(error),
      });
      throw error;
    }
  }
  function timingReport(outcome) {
    return workerBudget ? { ...workerBudget.report(), outcome } : { clock: "no_supervised_worker_deadline", outcome };
  }

  try {
    if (workerBudget) {
      if (!originalOperation) throw new Error("Supervised Prune Daily requires the original-operation channel");
      await originalOperation.assertHeld("publication");
    }
    const config = buildRunConfigAdapter(url);
    const summary = workerBudget
      ? await executePruneDailyAdapter(config, { originalOperation, workerBudget, withDailyTaskRun: supervisedTaskRun })
      : originalOperation
      ? await executePruneDailyAdapter(config, { originalOperation })
      : await executePruneDailyAdapter(config);
    const payload = {
      ok: true,
      summary,
      worker_timing: timingReport(summary.status ?? (summary.reason === "phase_b_stopped_budget" ? "stopped_budget" : "completed")),
      ...(lockReport ? { observations_global_operation_lock: lockReport } : {}),
    };
    await writeReportAdapter(payload);
    reportSaved = true;
    return payload;
  } catch (error) {
    const errorReport = workerBudget ? {
      error_code: error?.code,
      summary: error?.prune_summary,
    } : await reportPruneDailyErrorAdapter(error, {
      execution_mode: "github_actions",
    });
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...errorReport,
      worker_timing: timingReport("failed"),
      ...(lockReport ? { observations_global_operation_lock: lockReport } : {}),
    };
    await writeReportAdapter(payload);
    reportSaved = true;
    setExitCode(1);
    return payload;
  } finally {
    try {
      if (reportSaved && terminalHealth
        && workerBudget.nowMs() + (2 * HEALTH_REQUEST_MS) < workerBudget.shellDeadlineMs) {
        await optionalHealth(terminalHealth);
      }
      if (!workerBudget || (reportSaved && workerBudget.fits(HEALTH_REQUEST_MS))) {
        await flushPhaseBServiceEgressMetrics({ env });
      }
    } catch (_metricsError) {
      // Metrics are observational and must never change Prune Daily's outcome.
    } finally {
      originalOperation?.close();
    }
  }
}

export async function runPruneDailyJobWithGlobalLock({
  env = process.env,
  argv = [],
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
  const jobPath = fileURLToPath(import.meta.url);
  const launch = resolveWorkerLaunch({ argv, env, lockContext, jobPath });
  if (lockContext.valid) return await runJob({ env, ...(launch ? { workerBudget: launch.budget } : {}) });
  if (launch && !launch.budget.admit("global_lock_acquisition", GLOBAL_LOCK_ADMISSION_MS)) {
    const payload = {
      ok: true,
      summary: { status: "stopped_budget", deletion_attempted: false },
      worker_timing: { ...launch.budget.report(), outcome: "stopped_budget" },
    };
    await writeReport(payload);
    return payload;
  }
  const runId = randomUUID();
  try {
    const exitCode = await runLockedCommand({
      databaseUrl: env.SUPABASE_DB_URL || env.DATABASE_URL,
      owner: "prune_daily",
      runId,
      command: process.execPath,
      commandArgs: [jobPath, ...(launch?.childArgs(runId) ?? [])],
      env,
    });
    return { delegated: true, exitCode };
  } catch (error) {
    if (!launch) throw error;
    // A coordinator failure after the child saved verified results must keep
    // those results, while the overall invocation still exits as failed.
    const saved = await readFile(REPORT_PATH, "utf8").then(JSON.parse).catch(() => null);
    const childReport = saved?.observations_global_operation_lock?.run_id === runId
      && saved?.worker_timing?.launch_ms === launch.budget.originMs ? saved : null;
    await writeReport({
      ...childReport,
      ok: false,
      coordinator_error: { message: error.message, code: error.code },
      worker_timing: { ...(childReport?.worker_timing || launch.budget.report()), outcome: "failed" },
    });
    console.error(error.message);
    return { delegated: true, exitCode: 1 };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await runPruneDailyJobWithGlobalLock({ argv: process.argv.slice(2) });
    if (result?.delegated) process.exitCode = result.exitCode;
  } catch (error) {
    await writeReport({
      ok: false, error: error.message, error_code: error.code,
      worker_timing: { outcome: "failed", ...(error.code === "UK_AQ_PRUNE_WORKER_TIMING_AUTHORITY_INVALID"
        ? { clock: "invalid_supervised_worker_origin" } : {}) },
    });
    console.error(error.message);
    process.exitCode = 1;
  }
}
