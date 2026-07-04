import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SERVICE_NAME,
  logStructured,
  resolveRequestedDatabases,
} from "./core.mjs";
import { runBackupWithDailyTaskHealth } from "./health.mjs";

export const JOB_NAME = "uk-aq-supabase-db-dump-backup-job";
const DATABASE_ENV = "UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES";

export function resolveJobSelection(env = process.env) {
  const rawSelection = String(env[DATABASE_ENV] || "").trim();
  if (!rawSelection) {
    return {
      triggerMode: "scheduler",
      requestedDatabases: resolveRequestedDatabases("scheduler"),
    };
  }

  const requested = rawSelection
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    triggerMode: "manual",
    requestedDatabases: resolveRequestedDatabases("manual", requested),
  };
}

export async function main(env = process.env) {
  const { triggerMode, requestedDatabases } = resolveJobSelection(env);

  logStructured("INFO", "supabase_db_backup_job_started", {
    job: JOB_NAME,
    trigger_mode: triggerMode,
    requested_databases: requestedDatabases,
    cloud_run_execution: env.CLOUD_RUN_EXECUTION || null,
    cloud_run_task_index: env.CLOUD_RUN_TASK_INDEX || null,
  });

  try {
    const report = await runBackupWithDailyTaskHealth({
      triggerMode,
      requestedDatabases,
    });
    logStructured(report.ok ? "INFO" : "ERROR", "supabase_db_backup_job_finished", {
      job: JOB_NAME,
      run_id: report.run_id,
      ok: report.ok,
      trigger_mode: report.trigger_mode,
      requested_databases: report.requested_databases,
      finished_at: report.finished_at,
      error: report.error,
    });
    return report.ok ? 0 : 1;
  } catch (error) {
    logStructured("ERROR", "supabase_db_backup_job_failed", {
      job: JOB_NAME,
      service: SERVICE_NAME,
      trigger_mode: triggerMode,
      requested_databases: requestedDatabases,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await main();
}
