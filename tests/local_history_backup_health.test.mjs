import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executeBackupOrReport, initialiseHealth } from "../local/history_dropbox_backup/health.mjs";
import { createDailyTaskHealthClient } from "../workers/shared/daily_task_health.mjs";

test("accepted backup survives terminal response loss and recompute outage without another backup", async () => {
  const c = { fingerprint: "a".repeat(64), max_attempts: 3, env: {} };
  let state = { operation_id: randomUUID(), configuration_identity: c.fingerprint,
    started_at: "2026-10-21T23:59:00Z", attempts: 2 };
  initialiseHealth(state, c, { environment: "TEST", label: "uk.co.ukaq.history-dropbox-backup.test" });
  state.successful_completion = { operation_id: state.operation_id };
  state.last_accepted_report = { operation_id: state.operation_id, report_identity: "b".repeat(64) };
  state.completed_at = "2026-10-22T01:00:00Z";
  state.health.run_id = randomUUID();
  state.health.terminal = { kind: "finished", input: { ...state.health.input,
    finished_at: state.completed_at, summary: { one_off_operation_id: state.operation_id,
      accepted_report_identity: state.last_accepted_report.report_identity } } };
  let backupCalls = 0, finishedCalls = 0, recomputeCalls = 0, snapshot, clock = Date.now();
  const bodies = [];
  const client = {
    async dailyTaskFinished(id, input) {
      bodies.push(JSON.stringify({ id, input })); finishedCalls += 1;
      if (finishedCalls === 1) throw new TypeError("response lost after commit");
    },
    async recomputeDailyTaskStatus(date) {
      assert.equal(date, "2026-10-21"); recomputeCalls += 1;
      if (recomputeCalls === 1) throw new TypeError("temporary recompute failure");
    },
  };
  const run = () => executeBackupOrReport(state, c, () => { snapshot = JSON.stringify(state); }, {
    runBackup: async () => { backupCalls += 1; }, healthOptions: { client, now: () => clock },
  });
  assert.equal(await run(), false);
  assert.ok(state.successful_completion);
  state = JSON.parse(snapshot); clock += 3600001;
  assert.equal(await run(), false);
  assert.equal(state.health.terminal_confirmed, true);
  state = JSON.parse(snapshot); clock += 3600001;
  assert.equal(await run(), true);
  assert.equal(backupCalls, 0);
  assert.equal(finishedCalls, 2);
  assert.equal(recomputeCalls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(state.health.status, "confirmed");
  assert.equal(state.health.terminal.input.finished_at, "2026-10-22T01:00:00Z");
  state.health.operation_id = randomUUID();
  await assert.rejects(run, /health_.*identity/);
  assert.equal(backupCalls, 0);
});

test("shared client sends the optional identity as a separate argument and preserves event timestamps", async () => {
  const calls = [];
  const client = createDailyTaskHealthClient({ env: {}, strict: true, recomputeDisabled: true,
    supabaseUrl: "https://example.invalid", supabaseKey: "local-test-only", requestTimeoutMs: 100,
    logHealth: () => {}, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      return new Response(JSON.stringify(calls.length === 1 ? "11111111-1111-4111-8111-111111111111" : null));
    } });
  const input = { task_key: "ops.r2_history_dropbox_backup", source_repo: "uk-aq-ops",
    source_worker: "local-supervisor", platform_run_id: "local-uuid", scheduled_for_date: "2026-10-21",
    execution_identity: { key: "launchd:TEST:local-uuid", fingerprint: "a".repeat(64) },
    started_at: "2026-10-21T23:59:00Z", summary: { execution_source: "macbook_pro_launchd" } };
  const id = await client.dailyTaskStarted(input);
  await client.dailyTaskFinished(id, { ...input, finished_at: "2026-10-22T01:00:00Z" });
  assert.deepEqual(calls[0].p_execution_identity, input.execution_identity);
  assert.equal(calls[0].p.summary.github_run_attempt, undefined);
  assert.equal(calls[0].p.started_at, input.started_at);
  assert.equal(calls[1].p.finished_at, "2026-10-22T01:00:00Z");
  assert.equal(calls[1].p.scheduled_for_date, "2026-10-21");
});
