import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBackupRoot,
  buildDatabaseBackupFolder,
  buildDumpArgs,
  extractDryRunScript,
  normalizeDropboxPath,
  planRetentionDeletes,
  resolveOldestKeptDate,
  resolveRequestedDatabases,
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
