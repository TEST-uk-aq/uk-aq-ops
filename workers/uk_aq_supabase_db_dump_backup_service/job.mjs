import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SERVICE_NAME,
  logStructured,
  resolveRequestedDatabases,
} from "./core.mjs";
import { runBackupWithDailyTaskHealth } from "./health.mjs";

export const JOB_NAME = "uk-aq-supabase-db-dump-backup";
const DATABASE_ENV = "UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES";
const TRIGGER_MODE_ENV = "UK_AQ_SUPABASE_DB_DUMP_TRIGGER_MODE";
const ALLOWED_TRIGGER_MODES = new Set(["manual", "scheduler"]);

export function resolveJobSelection(env = process.env) {
  const triggerMode = String(env[TRIGGER_MODE_ENV] || "manual").trim();
  if (!ALLOWED_TRIGGER_MODES.has(triggerMode)) {
    throw new Error(`Unsupported trigger mode: ${triggerMode || "blank"}`);
  }

  const rawSelection = String(env[DATABASE_ENV] || "").trim();
  const requested = rawSelection
    ? rawSelection
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : null;

  return {
    triggerMode,
    requestedDatabases: resolveRequestedDatabases("manual", requested),
  };
}

export async function main(env = process.env) {
  const { triggerMode, requestedDatabases } = resolveJobSelection(env);

  logStructured("INFO", "supabase_db_backup_job_started", {
    job: JOB_NAME,
    trigger_mode: triggerMode,
    requested_databases: requestedDatabases,
    github_run_id: env.GITHUB_RUN_ID || null,
    github_run_attempt: env.GITHUB_RUN_ATTEMPT || null,
    github_workflow: env.GITHUB_WORKFLOW || null,
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
