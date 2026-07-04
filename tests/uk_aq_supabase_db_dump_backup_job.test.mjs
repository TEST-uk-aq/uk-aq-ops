import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DB_DUMP_HEALTH_TASK_KEY,
  compactDbDumpHealthSummary,
  runBackupWithDailyTaskHealth,
} from "../workers/uk_aq_supabase_db_dump_backup_service/health.mjs";
import {
  JOB_NAME,
  resolveJobSelection,
} from "../workers/uk_aq_supabase_db_dump_backup_service/job.mjs";

const workflowText = readFileSync(
  ".github/workflows/uk_aq_supabase_db_dump_backup_service_deploy.yml",
  "utf8",
);

function successfulReport() {
  return {
    ok: true,
    run_id: "backup-run-1",
    trigger_mode: "scheduler",
    requested_databases: ["ingestdb", "obs_aqidb"],
    started_at: "2026-07-04T00:55:00.000Z",
    finished_at: "2026-07-04T01:10:47.000Z",
    dropbox_backup_root: "/CIC-Test/Supabase_Backup_db_dump",
    error: null,
    databases: [
      {
        database: "ingestdb",
        ok: true,
        dumps: [
          { gzip_bytes: 100 },
          { gzip_bytes: 200 },
          { gzip_bytes: 300 },
          { gzip_bytes: 400 },
        ],
      },
      {
        database: "obs_aqidb",
        ok: true,
        dumps: [
          { gzip_bytes: 500 },
          { gzip_bytes: 600 },
          { gzip_bytes: 700 },
          { gzip_bytes: 800 },
        ],
      },
    ],
  };
}

test("Job defaults to scheduler mode and both databases", () => {
  assert.equal(JOB_NAME, "uk-aq-supabase-db-dump-backup-job");
  assert.deepEqual(resolveJobSelection({}), {
    triggerMode: "scheduler",
    requestedDatabases: ["ingestdb", "obs_aqidb"],
  });
});

test("Job accepts an explicit manual database selection", () => {
  assert.deepEqual(
    resolveJobSelection({
      UK_AQ_SUPABASE_DB_DUMP_JOB_DATABASES: "obs_aqidb",
    }),
    {
      triggerMode: "manual",
      requestedDatabases: ["obs_aqidb"],
    },
  );
});

test("compact Job health summary preserves service summary semantics", () => {
  const summary = compactDbDumpHealthSummary(successfulReport());
  assert.equal(summary.ok, true);
  assert.equal(summary.dump_count, 8);
  assert.equal(summary.successful_dump_count, 8);
  assert.equal(summary.failed_dump_count, 0);
  assert.equal(summary.successful_database_count, 2);
  assert.equal(summary.failed_database_count, 0);
  assert.equal(summary.bytes_written, 3600);
  assert.equal(summary.total_bytes, 3600);
  assert.equal(summary.elapsed_seconds, 947);
  assert.deepEqual(summary.databases_backed_up, ["ingestdb", "obs_aqidb"]);
});

test("shared wrapper records started and finished health lifecycle", async () => {
  const calls = [];
  const report = successfulReport();
  const result = await runBackupWithDailyTaskHealth({
    triggerMode: "scheduler",
    requestedDatabases: ["ingestdb", "obs_aqidb"],
    backupRunner: async () => report,
    health: {
      started: async (input) => {
        calls.push(["started", input]);
        return "health-run-1";
      },
      finished: async (runId, input) => calls.push(["finished", runId, input]),
      failed: async (...args) => calls.push(["failed", ...args]),
    },
  });

  assert.equal(result, report);
  assert.equal(calls[0][0], "started");
  assert.equal(calls[0][1].task_key, DB_DUMP_HEALTH_TASK_KEY);
  assert.equal(calls[1][0], "finished");
  assert.equal(calls[1][1], "health-run-1");
  assert.equal(calls[1][2].summary.dump_count, 8);
  assert.equal(calls.some(([event]) => event === "failed"), false);
});

test("shared wrapper records failed report and leaves it for Job exit handling", async () => {
  const calls = [];
  const report = {
    ...successfulReport(),
    ok: false,
    error: "One or more database backups failed.",
    databases: [
      successfulReport().databases[0],
      {
        database: "obs_aqidb",
        ok: false,
        dumps: [],
      },
    ],
  };

  const result = await runBackupWithDailyTaskHealth({
    triggerMode: "scheduler",
    requestedDatabases: ["ingestdb", "obs_aqidb"],
    backupRunner: async () => report,
    health: {
      started: async () => "health-run-2",
      finished: async (...args) => calls.push(["finished", ...args]),
      failed: async (...args) => calls.push(["failed", ...args]),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "failed");
  assert.equal(calls[0][1], "health-run-2");
  assert.equal(calls[0][3].summary.failed_database_count, 1);
});

test("shared wrapper records an unhandled exception and rethrows it", async () => {
  const calls = [];
  const failure = new Error("unexpected backup failure");

  await assert.rejects(
    runBackupWithDailyTaskHealth({
      triggerMode: "scheduler",
      requestedDatabases: ["ingestdb", "obs_aqidb"],
      backupRunner: async () => {
        throw failure;
      },
      health: {
        started: async () => "health-run-3",
        finished: async (...args) => calls.push(["finished", ...args]),
        failed: async (...args) => calls.push(["failed", ...args]),
      },
    }),
    failure,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "failed");
  assert.equal(calls[0][1], "health-run-3");
  assert.equal(calls[0][2], failure);
});

test("deployment targets Jobs API and protects the old Scheduler", () => {
  assert.match(workflowText, /gcloud run jobs deploy "\$\{JOB_NAME\}"/);
  assert.match(workflowText, /--tasks "1"/);
  assert.match(workflowText, /--parallelism "1"/);
  assert.match(workflowText, /--max-retries "\$\{JOB_MAX_RETRIES\}"/);
  assert.match(workflowText, /jobs\/\$\{JOB_NAME\}:run/);
  assert.match(workflowText, /--oauth-service-account-email/);
  assert.match(workflowText, /roles\/run\.invoker/);
  assert.match(workflowText, /Old service Scheduler trigger must remain PAUSED/);
  assert.doesNotMatch(
    workflowText,
    /--uri "\$\{service_uri\}\/run-backup"/,
  );
});
