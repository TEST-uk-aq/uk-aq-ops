import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_PHASE_B_CHILD_TIMEZONE,
  CONTROLLED_PHASE_B_SOURCE_FREEZE_ENV,
  CONTROLLED_PHASE_B_SOURCE_TABLES,
  parseControlledPhaseBSourceFreezeArgs,
  runWithControlledPhaseBSourceWriteFreeze,
} from "../scripts/index_v3_migration/index_v3_controlled_phase_b_source_freeze.mjs";

function mockClient(log) {
  return {
    async connect() {
      log.push(["connect"]);
    },
    async query(sql) {
      log.push(["query", String(sql)]);
      return { rows: [], rowCount: 0 };
    },
    async end() {
      log.push(["end"]);
    },
  };
}

test("source-freeze parser requires -- followed by a command", () => {
  assert.throws(
    () => parseControlledPhaseBSourceFreezeArgs(["node", "child.mjs"]),
    /requires -- followed by a command/,
  );
  assert.deepEqual(
    parseControlledPhaseBSourceFreezeArgs(["--", "node", "child.mjs", "--apply"]),
    {
      command: "node",
      commandArgs: ["child.mjs", "--apply"],
    },
  );
});

test("source-freeze holds all canonical source tables while child runs", async () => {
  const log = [];
  let childObserved = null;

  const code = await runWithControlledPhaseBSourceWriteFreeze({
    databaseUrl: "postgres://example.invalid/test",
    command: "node",
    commandArgs: ["child.mjs"],
    env: { TEST_MARKER: "yes", TZ: "Europe/London" },
    createClient: () => mockClient(log),
    runChild: async (args) => {
      childObserved = args;
      log.push(["child"]);
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(childObserved.command, "node");
  assert.deepEqual(childObserved.commandArgs, ["child.mjs"]);
  assert.equal(childObserved.env.TEST_MARKER, "yes");
  assert.equal(childObserved.env.TZ, CONTROLLED_PHASE_B_CHILD_TIMEZONE);
  assert.equal(CONTROLLED_PHASE_B_CHILD_TIMEZONE, "UTC");
  assert.equal(childObserved.env[CONTROLLED_PHASE_B_SOURCE_FREEZE_ENV], "held");

  const sql = log.filter(([kind]) => kind === "query").map(([, value]) => value);
  assert.equal(sql[0], "begin");
  assert.match(sql[1], /^set local lock_timeout = '60000ms'$/);
  assert.equal(
    sql[2],
    `lock table ${CONTROLLED_PHASE_B_SOURCE_TABLES.join(", ")} in share mode`,
  );
  assert.equal(sql[3], "rollback");
  assert.deepEqual(log.at(-1), ["end"]);
  assert.ok(log.findIndex(([kind]) => kind === "child") > log.findIndex(([, value]) => value === sql[2]));
  assert.ok(log.findIndex(([kind]) => kind === "child") < log.findIndex(([, value]) => value === "rollback"));
});

test("source-freeze releases locks even when child fails", async () => {
  const log = [];
  const code = await runWithControlledPhaseBSourceWriteFreeze({
    databaseUrl: "postgres://example.invalid/test",
    command: "node",
    commandArgs: ["child.mjs"],
    createClient: () => mockClient(log),
    runChild: async () => 7,
  });

  assert.equal(code, 7);
  assert.ok(log.some(([kind, value]) => kind === "query" && value === "rollback"));
  assert.deepEqual(log.at(-1), ["end"]);
});

test("source-freeze rolls back transaction when child throws", async () => {
  const log = [];
  await assert.rejects(
    runWithControlledPhaseBSourceWriteFreeze({
      databaseUrl: "postgres://example.invalid/test",
      command: "node",
      commandArgs: ["child.mjs"],
      createClient: () => mockClient(log),
      runChild: async () => {
        throw new Error("child exploded");
      },
    }),
    /child exploded/,
  );
  assert.ok(log.some(([kind, value]) => kind === "query" && value === "rollback"));
  assert.deepEqual(log.at(-1), ["end"]);
});
