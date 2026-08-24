import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCronJobsRestoreSql,
  buildBackupRoot,
  buildDatabaseBackupFolder,
  buildDumpArgs,
  ensurePgCronExtensionAtTopOfSchemaFile,
  extractDryRunScript,
  includeCronJobsInDryRunScript,
  normalizeDropboxPath,
  parseBooleanEnv,
  planRetentionDeletes,
  resolveInsertSplitConfig,
  resolveOldestKeptDate,
  resolveRequestedDatabases,
  runRequestedDatabaseBackups,
  splitLargeDataInsertsInFile,
} from "../workers/uk_aq_supabase_db_dump_backup_service/core.mjs";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("normalizeDropboxPath adds a leading slash and trims trailing slashes", () => {
  assert.equal(normalizeDropboxPath("TEST/"), "/TEST");
  assert.equal(normalizeDropboxPath("/TEST/path/"), "/TEST/path");
  assert.equal(normalizeDropboxPath(""), "");
});

test("buildBackupRoot and buildDatabaseBackupFolder keep the required dated layout", () => {
  assert.equal(
    buildBackupRoot("/TEST", "Supabase_Backup_db_dump"),
    "/TEST/Supabase_Backup_db_dump",
  );
  assert.equal(
    buildDatabaseBackupFolder("/TEST", "Supabase_Backup_db_dump", "ingestdb", "2026-03-16"),
    "/TEST/Supabase_Backup_db_dump/ingestdb/2026-03-16",
  );
});

test("resolveRequestedDatabases defaults scheduler runs to both databases", () => {
  assert.deepEqual(resolveRequestedDatabases("scheduler", "ingestdb"), [
    "ingestdb",
    "obs_aqidb",
  ]);
});

test("resolveRequestedDatabases accepts a single manual database selection", () => {
  assert.deepEqual(resolveRequestedDatabases("manual", "obs_aqidb"), [
    "obs_aqidb",
  ]);
});

test("resolveRequestedDatabases rejects unsupported selections", () => {
  assert.throws(
    () => resolveRequestedDatabases("manual", "unknown_db"),
    /Unsupported database selection/,
  );
});

test("requested database backups start together, wait for both, and retain canonical order", async () => {
  const deferredByDatabase = {
    ingestdb: createDeferred(),
    obs_aqidb: createDeferred(),
  };
  const started = [];
  let combinedSettled = false;

  const combinedPromise = runRequestedDatabaseBackups({
    databaseNames: ["ingestdb", "obs_aqidb"],
    databaseRunner: (databaseName) => {
      started.push(databaseName);
      return deferredByDatabase[databaseName].promise;
    },
  });
  combinedPromise.then(() => {
    combinedSettled = true;
  });

  await Promise.resolve();
  assert.deepEqual(started, ["ingestdb", "obs_aqidb"]);

  deferredByDatabase.obs_aqidb.resolve({
    database: "obs_aqidb",
    ok: true,
    dumps: [{ dump_kind: "roles" }],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(combinedSettled, false);

  deferredByDatabase.ingestdb.resolve({
    database: "ingestdb",
    ok: true,
    dumps: [{ dump_kind: "roles" }],
  });
  const combined = await combinedPromise;

  assert.equal(combined.ok, true);
  assert.equal(combined.error, null);
  assert.deepEqual(
    combined.databases.map((entry) => entry.database),
    ["ingestdb", "obs_aqidb"],
  );
});

test("a failed database retains partial dumps and does not discard the other result", async () => {
  const deferredByDatabase = {
    ingestdb: createDeferred(),
    obs_aqidb: createDeferred(),
  };
  const combinedPromise = runRequestedDatabaseBackups({
    databaseNames: ["ingestdb", "obs_aqidb"],
    databaseRunner: (databaseName) => deferredByDatabase[databaseName].promise,
  });

  await Promise.resolve();
  deferredByDatabase.ingestdb.resolve({
    database: "ingestdb",
    ok: false,
    dumps: [
      { dump_kind: "roles" },
      { dump_kind: "schema" },
    ],
    error: "data dump failed",
  });
  deferredByDatabase.obs_aqidb.resolve({
    database: "obs_aqidb",
    ok: true,
    dumps: [
      { dump_kind: "roles" },
      { dump_kind: "schema" },
      { dump_kind: "data" },
      { dump_kind: "cron_jobs" },
    ],
  });

  const combined = await combinedPromise;
  assert.equal(combined.ok, false);
  assert.equal(combined.error, "One or more database backups failed.");
  assert.deepEqual(
    combined.databases.map((entry) => [entry.database, entry.ok, entry.dumps.length]),
    [
      ["ingestdb", false, 2],
      ["obs_aqidb", true, 4],
    ],
  );
});

test("an unexpected database rejection becomes a failed database result", async () => {
  const failure = new Error("unexpected branch failure");
  const combined = await runRequestedDatabaseBackups({
    databaseNames: ["ingestdb", "obs_aqidb"],
    databaseRunner: async (databaseName) => {
      if (databaseName === "ingestdb") {
        throw failure;
      }
      return { database: databaseName, ok: true, dumps: [] };
    },
  });

  assert.equal(combined.ok, false);
  assert.deepEqual(
    combined.databases.map((entry) => entry.database),
    ["ingestdb", "obs_aqidb"],
  );
  assert.equal(combined.databases[0].ok, false);
  assert.equal(combined.databases[0].error, failure.message);
  assert.equal(combined.databases[1].ok, true);
});

test("a single-database backup starts only the selected database", async () => {
  const started = [];
  const combined = await runRequestedDatabaseBackups({
    databaseNames: ["obs_aqidb"],
    databaseRunner: async (databaseName) => {
      started.push(databaseName);
      return { database: databaseName, ok: true, dumps: [] };
    },
  });

  assert.deepEqual(started, ["obs_aqidb"]);
  assert.equal(combined.ok, true);
  assert.deepEqual(
    combined.databases.map((entry) => entry.database),
    ["obs_aqidb"],
  );
});

test("buildDumpArgs emits the expected Supabase CLI flags", () => {
  assert.deepEqual(
    buildDumpArgs({
      dbUrl: "postgresql://example",
      outputFile: "/tmp/roles.sql",
      dumpKind: "roles",
    }),
    [
      "db",
      "dump",
      "--dry-run",
      "--db-url",
      "postgresql://example",
      "--file",
      "/tmp/roles.sql",
      "--role-only",
    ],
  );

  assert.deepEqual(
    buildDumpArgs({
      dbUrl: "postgresql://example",
      outputFile: "/tmp/data.sql",
      dumpKind: "data",
    }).slice(-1),
    ["--data-only"],
  );
});

test("extractDryRunScript strips the banner and keeps the bash script", () => {
  const script = extractDryRunScript([
    "DRY RUN: *only* printing the pg_dump script to console.",
    "Dumping roles from remote database...",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo test",
  ].join("\n"));

  assert.equal(
    script,
    "#!/usr/bin/env bash\nset -euo pipefail\necho test",
  );
});

test("includeCronJobsInDryRunScript removes cron from exclude-schema filters", () => {
  const updated = includeCronJobsInDryRunScript([
    "#!/usr/bin/env bash",
    "pg_dump \\",
    "  --data-only \\",
    "  --exclude-schema \"information_schema|pg_*|cron|extensions\" \\",
    "  --schema \"public|uk_aq_core|uk_aq_raw\"",
  ].join("\n"));

  assert.match(updated, /--exclude-schema "information_schema\|pg_\*\|extensions"/);
  assert.doesNotMatch(updated, /\|cron\|/);
  assert.doesNotMatch(updated, /--exclude-schema "[^"]*\|cron[^"]*"/);
  assert.match(updated, /--schema "public\|uk_aq_core\|uk_aq_raw\|cron"/);
});

test("includeCronJobsInDryRunScript is a no-op when cron is not excluded", () => {
  const script = [
    "#!/usr/bin/env bash",
    "pg_dump \\",
    "  --data-only \\",
    "  --exclude-schema \"information_schema|pg_*|extensions\" \\",
    "  --schema \"*\"",
  ].join("\n");
  assert.equal(includeCronJobsInDryRunScript(script), script);
});

test("includeCronJobsInDryRunScript appends cron to explicit include-schema lists", () => {
  const updated = includeCronJobsInDryRunScript([
    "#!/usr/bin/env bash",
    "pg_dump \\",
    "  --data-only \\",
    "  --schema \"public|auth|storage\"",
  ].join("\n"));

  assert.match(updated, /--schema "public\|auth\|storage\|cron"/);
});

test("buildCronJobsRestoreSql emits deterministic restore SQL for cron.job rows", () => {
  const sql = buildCronJobsRestoreSql({
    databaseName: "obs_aqidb",
    generatedAt: "2026-05-21T16:00:00.000Z",
    rows: [
      {
        jobid: 7,
        schedule: "10 6 * * *",
        command: "select * from uk_aq_ops.fn('a');",
        nodename: "localhost",
        nodeport: 5432,
        database: "postgres",
        username: "postgres",
        active: true,
        jobname: "job_a",
      },
      {
        jobid: 3,
        schedule: "55 * * * *",
        command: "select 1;",
        nodename: "localhost",
        nodeport: 5432,
        database: "postgres",
        username: "postgres",
        active: false,
        jobname: "job_b",
      },
    ],
  });

  assert.match(sql, /create extension if not exists pg_cron;/);
  assert.match(sql, /delete from cron\.job;/);
  assert.match(sql, /insert into cron\.job \("jobid", "schedule", "command", "nodename", "nodeport", "database", "username", "active", "jobname"\) values/);
  assert.match(sql, /\(3, '55 \* \* \* \*', 'select 1;'/);
  assert.match(sql, /\(7, '10 6 \* \* \*', 'select \* from uk_aq_ops\.fn\(''a''\);'/);
  assert.match(sql, /select pg_catalog\.setval\('cron\.jobid_seq', coalesce\(\(select max\(jobid\) from cron\.job\), 1\), true\);/);
  assert.match(sql, /commit;/);
});

test("buildCronJobsRestoreSql emits empty restore scaffold when no rows are present", () => {
  const sql = buildCronJobsRestoreSql({
    databaseName: "ingestdb",
    generatedAt: "2026-05-21T16:00:00.000Z",
    rows: [],
  });

  assert.match(sql, /-- No rows found in source cron\.job\./);
  assert.match(sql, /select pg_catalog\.setval\('cron\.jobid_seq', 1, false\);/);
  assert.doesNotMatch(sql, /insert into cron\.job/i);
});

test("resolveOldestKeptDate keeps the latest seven UTC folders inclusive", () => {
  assert.equal(resolveOldestKeptDate("2026-03-16", 7), "2026-03-10");
});

test("planRetentionDeletes selects only dated folders older than the cutoff", () => {
  const plan = planRetentionDeletes([
    { name: "2026-03-08", path_display: "/backup/2026-03-08" },
    { name: "2026-03-10", path_display: "/backup/2026-03-10" },
    { name: "2026-03-16", path_display: "/backup/2026-03-16" },
    { name: "_ops", path_display: "/backup/_ops" },
  ], "2026-03-10");

  assert.deepEqual(plan.deletes, [
    {
      name: "2026-03-08",
      path_display: "/backup/2026-03-08",
      path_lower: null,
    },
  ]);
  assert.deepEqual(plan.keeps.map((entry) => entry.name), [
    "2026-03-10",
    "2026-03-16",
  ]);
});

test("parseBooleanEnv accepts true-ish and false-ish values", () => {
  assert.equal(parseBooleanEnv("true", false), true);
  assert.equal(parseBooleanEnv("1", false), true);
  assert.equal(parseBooleanEnv("yes", false), true);
  assert.equal(parseBooleanEnv("on", false), true);

  assert.equal(parseBooleanEnv("false", true), false);
  assert.equal(parseBooleanEnv("0", true), false);
  assert.equal(parseBooleanEnv("no", true), false);
  assert.equal(parseBooleanEnv("off", true), false);
  assert.equal(parseBooleanEnv("", true), true);
  assert.equal(parseBooleanEnv("unknown", true), true);
});

test("resolveInsertSplitConfig reads defaults and clamps chunk size", () => {
  const defaults = resolveInsertSplitConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.threshold_rows, 10_000);
  assert.equal(defaults.chunk_rows, 5_000);

  const custom = resolveInsertSplitConfig({
    UK_AQ_DB_DUMP_SPLIT_LARGE_INSERTS: "no",
    UK_AQ_DB_DUMP_INSERT_SPLIT_THRESHOLD_ROWS: "12000",
    UK_AQ_DB_DUMP_INSERT_CHUNK_ROWS: "9",
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.threshold_rows, 12_000);
  assert.equal(custom.chunk_rows, 100);
});

function buildInsertBlock({ schema, table, rows }) {
  const header = `INSERT INTO "${schema}"."${table}" ("id", "payload") VALUES`;
  const body = [];
  for (let index = 1; index <= rows; index += 1) {
    const delimiter = index === rows ? ";" : ",";
    body.push(`\t(${index}, '{"k":"v${index}"}')${delimiter}`);
  }
  return [header, ...body].join("\n");
}

async function withTempSqlFile(content, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-db-dump-test-"));
  const filePath = path.join(tempDir, "data.sql");
  await fs.writeFile(filePath, content, "utf8");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("ensurePgCronExtensionAtTopOfSchemaFile prepends pg_cron enable SQL", async () => {
  const sql = [
    "create schema if not exists uk_aq_core;",
    "set search_path = uk_aq_core, public;",
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const updated = await ensurePgCronExtensionAtTopOfSchemaFile(filePath);
    const content = await fs.readFile(filePath, "utf8");
    assert.equal(updated, true);
    assert.match(content, /^create extension if not exists pg_cron;\n\ncreate schema if not exists uk_aq_core;/);
  });
});

test("ensurePgCronExtensionAtTopOfSchemaFile does not duplicate existing statement", async () => {
  const sql = [
    "create extension if not exists pg_cron;",
    "",
    "create schema if not exists uk_aq_core;",
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const before = await fs.readFile(filePath, "utf8");
    const updated = await ensurePgCronExtensionAtTopOfSchemaFile(filePath);
    const after = await fs.readFile(filePath, "utf8");
    assert.equal(updated, false);
    assert.equal(after, before);
  });
});

test("splitLargeDataInsertsInFile rewrites 25,001-row INSERT into 6 statements", async () => {
  const header = "INSERT INTO \"uk_aq_core\".\"uk_aq_ingest_runs\" (\"id\", \"payload\") VALUES";
  const sql = [
    "-- preface",
    "SET statement_timeout = 0;",
    buildInsertBlock({ schema: "uk_aq_core", table: "uk_aq_ingest_runs", rows: 25_001 }),
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const summary = await splitLargeDataInsertsInFile({
      filePath,
      thresholdRows: 10_000,
      chunkRows: 5_000,
      runId: "test-run",
      databaseName: "ingestdb",
      enabled: true,
    });
    const output = await fs.readFile(filePath, "utf8");
    const statements = [];
    let currentRows = null;
    for (const line of output.split("\n")) {
      if (line === header) {
        currentRows = [];
        continue;
      }
      if (currentRows) {
        currentRows.push(line);
        if (/;\s*$/.test(line)) {
          statements.push(currentRows);
          currentRows = null;
        }
      }
    }

    assert.deepEqual(statements.map((rows) => rows.length), [5_000, 5_000, 5_000, 5_000, 5_000, 1]);
    for (const rows of statements) {
      assert.equal(rows.filter((line) => /;\s*$/.test(line)).length, 1);
      assert.ok(rows.slice(0, -1).every((line) => /,\s*$/.test(line)));
      assert.match(rows.at(-1), /;\s*$/);
    }
    const ids = statements
      .flat()
      .map((line) => Number(line.match(/^\s*\((\d+),/)?.[1]));
    assert.deepEqual(ids, Array.from({ length: 25_001 }, (_, index) => index + 1));

    const tempEntries = await fs.readdir(path.dirname(filePath));
    assert.equal(
      tempEntries.some((entry) => (
        entry.startsWith("data.sql.insert-spool-")
        || entry.startsWith("data.sql.split-")
      )),
      false,
    );

    assert.equal(statements.length, 6);
    assert.equal(summary.insert_statements_seen, 1);
    assert.equal(summary.insert_statements_split, 1);
    assert.equal(summary.output_insert_statements, 6);
    assert.equal(summary.input_rows_total, 25_001);
  });
});

test("splitLargeDataInsertsInFile keeps threshold-sized INSERT unchanged", async () => {
  const sql = [
    buildInsertBlock({ schema: "uk_aq_core", table: "uk_aq_ingest_runs", rows: 10_000 }),
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const before = await fs.readFile(filePath, "utf8");
    const summary = await splitLargeDataInsertsInFile({
      filePath,
      thresholdRows: 10_000,
      chunkRows: 5_000,
      runId: "test-run",
      databaseName: "ingestdb",
      enabled: true,
    });
    const after = await fs.readFile(filePath, "utf8");
    assert.equal(after, before);
    assert.equal(summary.insert_statements_split, 0);
    assert.equal(summary.output_insert_statements, 1);
  });
});

test("splitLargeDataInsertsInFile keeps small INSERT unchanged", async () => {
  const sql = [
    "SET lock_timeout = 0;",
    buildInsertBlock({ schema: "uk_aq_core", table: "small_table", rows: 3 }),
    "RESET lock_timeout;",
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const before = await fs.readFile(filePath, "utf8");
    const summary = await splitLargeDataInsertsInFile({
      filePath,
      thresholdRows: 10_000,
      chunkRows: 5_000,
      runId: "test-run",
      databaseName: "ingestdb",
      enabled: true,
    });
    const after = await fs.readFile(filePath, "utf8");
    assert.equal(after, before);
    assert.equal(summary.insert_statements_split, 0);
    assert.equal(summary.output_insert_statements, 1);
  });
});

test("splitLargeDataInsertsInFile leaves single-line INSERT statements unchanged", async () => {
  const sql = [
    "SET lock_timeout = 0;",
    "INSERT INTO \"uk_aq_core\".\"single_line\" (\"id\", \"payload\") VALUES (1, '{\"k\":\"v\"}');",
    "RESET lock_timeout;",
    "",
  ].join("\n");

  await withTempSqlFile(sql, async (filePath) => {
    const before = await fs.readFile(filePath, "utf8");
    const summary = await splitLargeDataInsertsInFile({
      filePath,
      thresholdRows: 10_000,
      chunkRows: 5_000,
      runId: "test-run",
      databaseName: "ingestdb",
      enabled: true,
    });
    const after = await fs.readFile(filePath, "utf8");
    assert.equal(after, before);
    assert.equal(summary.insert_statements_seen, 1);
    assert.equal(summary.output_insert_statements, 1);
    assert.equal(summary.insert_statements_split, 0);
  });
});
