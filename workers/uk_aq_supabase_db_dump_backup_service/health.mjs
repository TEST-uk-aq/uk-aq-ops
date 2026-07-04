import { runBackupWorkflow } from "./core.mjs";
import {
  dailyTaskFailed,
  dailyTaskFinished,
  dailyTaskStarted,
} from "../shared/daily_task_health.mjs";

export const DB_DUMP_HEALTH_TASK_KEY = "ops.supabase_db_dump_backup";
export const DB_DUMP_HEALTH_SOURCE_REPO = "uk-aq-ops";
export const DB_DUMP_HEALTH_SOURCE_WORKER = "uk_aq_supabase_db_dump_backup_service";

export function compactDbDumpHealthSummary(report = {}) {
  const databases = Array.isArray(report.databases) ? report.databases : [];
  const dumpCount = databases.reduce(
    (total, entry) => total + (Array.isArray(entry.dumps) ? entry.dumps.length : 0),
    0,
  );
  const successfulDatabases = databases.filter((entry) => entry.ok).length;
  const failedDatabases = databases.filter((entry) => !entry.ok).length;
  const totalBytes = databases.reduce((dbTotal, entry) => {
    const dumps = Array.isArray(entry.dumps) ? entry.dumps : [];
    return dbTotal + dumps.reduce(
      (dumpTotal, dump) => dumpTotal + Number(dump.gzip_bytes || 0),
      0,
    );
  }, 0);
  const startedMs = Date.parse(report.started_at || "");
  const finishedMs = Date.parse(report.finished_at || "");

  return {
    ok: report.ok,
    trigger_mode: report.trigger_mode,
    databases_backed_up: databases.map((entry) => entry.database),
    requested_databases: report.requested_databases,
    dump_count: dumpCount,
    successful_dump_count: report.ok
      ? dumpCount
      : databases
        .filter((entry) => entry.ok)
        .reduce(
          (total, entry) => total + (Array.isArray(entry.dumps) ? entry.dumps.length : 0),
          0,
        ),
    failed_dump_count: report.ok
      ? 0
      : Math.max(
        0,
        (report.requested_databases?.length || databases.length) * 3 - dumpCount,
      ),
    successful_database_count: successfulDatabases,
    failed_database_count: failedDatabases,
    bytes_written: totalBytes,
    total_bytes: totalBytes,
    destination: {
      type: "dropbox",
      root: report.dropbox_backup_root,
    },
    elapsed_seconds: Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, Math.round((finishedMs - startedMs) / 1000))
      : undefined,
    error: report.error,
    warnings: failedDatabases > 0 ? [`failed databases: ${failedDatabases}`] : [],
  };
}

export function buildDbDumpHealthInput({ triggerMode, requestedDatabases }) {
  return {
    task_key: DB_DUMP_HEALTH_TASK_KEY,
    source_repo: DB_DUMP_HEALTH_SOURCE_REPO,
    source_worker: DB_DUMP_HEALTH_SOURCE_WORKER,
    summary: {
      trigger_mode: triggerMode,
      requested_databases: requestedDatabases,
    },
  };
}

export async function runBackupWithDailyTaskHealth({
  triggerMode,
  requestedDatabases,
  backupRunner = runBackupWorkflow,
  health = {
    started: dailyTaskStarted,
    finished: dailyTaskFinished,
    failed: dailyTaskFailed,
  },
}) {
  const healthInput = buildDbDumpHealthInput({
    triggerMode,
    requestedDatabases,
  });
  const healthRunId = await health.started(healthInput);

  try {
    const report = await backupRunner({
      triggerMode,
      requestedDatabases,
    });
    const healthSummary = compactDbDumpHealthSummary(report);

    if (report.ok) {
      await health.finished(healthRunId, {
        ...healthInput,
        summary: healthSummary,
      });
    } else {
      await health.failed(
        healthRunId,
        new Error(report.error || "Supabase DB dump backup failed."),
        {
          ...healthInput,
          summary: healthSummary,
        },
      );
    }

    return report;
  } catch (error) {
    await health.failed(healthRunId, error, {
      ...healthInput,
      summary: {
        trigger_mode: triggerMode,
        requested_databases: requestedDatabases,
      },
    });
    throw error;
  }
}
