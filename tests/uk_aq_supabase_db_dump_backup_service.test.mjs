import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
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
  splitLargeDataInsertsInFile,
} from "../workers/uk_aq_supabase_db_dump_backup_service/core.mjs";

test("normalizeDropboxPath adds a leading slash and trims trailing slashes", () => {
  assert.equal(normalizeDropboxPath("CIC-Test/"), "/CIC-Test");
  assert.equal(normalizeDropboxPath("/CIC-Test/path/"), "/CIC-Test/path");
  assert.equal(normalizeDropboxPath(""), "");
});

test("buildBackupRoot and buildDatabaseBackupFolder keep the required dated layout", () => {
  assert.equal(
    buildBackupRoot("/CIC-Test", "Supabase_Backup_db_dump"),
    "/CIC-Test/Supabase_Backup_db_dump",
  );
  assert.equal(
    buildDatabaseBackupFolder("/CIC-Test", "Supabase_Backup_db_dump", "ingestdb", "2026-03-16"),
    "/CIC-Test/Supabase_Backup_db_dump/ingestdb/2026-03-16",
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
  assert.doesNotMatch(updated, /\|cron"/);
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
    const insertCount = (output.match(/INSERT INTO "uk_aq_core"\."uk_aq_ingest_runs"/g) || []).length;

    assert.equal(insertCount, 6);
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
