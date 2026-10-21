import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deliverHealth, executeBackupOrReport, initialiseHealth } from "../local/history_dropbox_backup/health.mjs";
import { createDailyTaskHealthClient } from "../workers/shared/daily_task_health.mjs";

test("accepted backup survives terminal response loss and recompute outage without another backup", async () => {
  const c = { fingerprint: "a".repeat(64), max_attempts: 3, env: {} };
  let state = { operation_id: randomUUID(), configuration_identity: c.fingerprint,
    started_at: "2026-10-21T23:59:00Z", attempts: 2 };
  initialiseHealth(state, c, { environment: "TEST", label: "uk.co.ukaq.history-dropbox-backup.test" });
  state.successful_completion = { operation_id: state.operation_id };
  state.last_accepted_report = { operation_id: state.operation_id, report_identity: "b".repeat(64) };
  state.completed_at = "2026-10-22T01:00:00Z";
  state.health.run_id = state.operation_id;
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

test("real shared client confirms explicit recompute only after a successful response, without repeating accepted backup", async () => {
  const c = { fingerprint: "a".repeat(64), max_attempts: 3,
    env: { OBS_AQIDB_SUPABASE_URL: "https://example.invalid", OBS_AQIDB_SECRET_KEY: "local-test-only" } };
  let state = { operation_id: "11111111-1111-4111-8111-111111111111",
    configuration_identity: c.fingerprint, started_at: "2026-10-21T23:59:00Z", attempts: 1 };
  initialiseHealth(state, c, { environment: "TEST", label: "uk.co.ukaq.history-dropbox-backup.test" });
  state.successful_completion = { operation_id: state.operation_id };
  state.last_accepted_report = { operation_id: state.operation_id, report_identity: "b".repeat(64) };
  state.completed_at = "2026-10-22T01:00:00Z";
  state.health.run_id = state.operation_id;
  state.health.terminal = { kind: "finished", input: { ...state.health.input,
    finished_at: state.completed_at, summary: { one_off_operation_id: state.operation_id,
      accepted_report_identity: state.last_accepted_report.report_identity } } };
  let snapshot, backupCalls = 0, recomputeCalls = 0, clock = Date.parse("2026-10-22T02:00:00Z");
  const calls = [];
  const fetchImpl = async (url, options) => {
    const rpc = url.split("/").at(-1), body = JSON.parse(options.body);
    calls.push(rpc);
    assert.equal(options.method, "POST");
    if (rpc === "uk_aq_rpc_daily_task_finished") {
      assert.equal(body.p.finished_at, "2026-10-22T01:00:00Z");
      return new Response("null");
    }
    assert.equal(url, "https://example.invalid/rest/v1/rpc/uk_aq_rpc_recompute_daily_task_status");
    assert.deepEqual(body, { p_date: "2026-10-21" });
    // Terminal acknowledgement must already be durable before recompute is sent.
    assert.equal(JSON.parse(snapshot).health.terminal_confirmed, true);
    assert.equal(JSON.parse(snapshot).health.recompute_confirmed, false);
    recomputeCalls += 1;
    if (recomputeCalls === 1) return new Response("unavailable", { status: 503 });
    if (recomputeCalls === 2) throw new TypeError("committed recompute response lost");
    return new Response("null");
  };
  const run = () => executeBackupOrReport(state, c, () => { snapshot = JSON.stringify(state); }, {
    runBackup: async () => { backupCalls += 1; }, healthOptions: { fetchImpl, now: () => clock },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(await run(), false);
    state = JSON.parse(snapshot);
    assert.equal(state.health.terminal_confirmed, true);
    assert.equal(state.health.recompute_confirmed, false);
    assert.equal(state.health.status, "pending");
    assert.ok(state.successful_completion);
    clock = Date.parse(state.health.next_attempt_at);
  }
  assert.equal(await run(), true);
  state = JSON.parse(snapshot);
  assert.equal(state.health.recompute_confirmed, true);
  assert.equal(state.health.status, "confirmed");
  assert.equal(await run(), true);
  assert.equal(backupCalls, 0);
  assert.deepEqual(calls, ["uk_aq_rpc_daily_task_finished",
    ...Array(3).fill("uk_aq_rpc_recompute_daily_task_status")]);
});

test("durable operation UUID recovers Started through the real client after a lost response", async () => {
  const c = { fingerprint: "a".repeat(64), max_attempts: 3,
    env: { OBS_AQIDB_SUPABASE_URL: "https://example.invalid", OBS_AQIDB_SECRET_KEY: "local-test-only" } };
  let state = { operation_id: "11111111-1111-4111-8111-111111111111",
    configuration_identity: c.fingerprint, started_at: "2026-10-21T23:59:00Z" };
  initialiseHealth(state, c, { environment: "TEST", label: "uk.co.ukaq.history-dropbox-backup.test" });
  let snapshot, clock = Date.parse("2026-10-22T02:00:00Z");
  const bodies = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://example.invalid/rest/v1/rpc/uk_aq_rpc_daily_task_started");
    const body = JSON.parse(options.body); bodies.push(body);
    assert.equal(JSON.parse(snapshot).health.run_id, null);
    assert.equal(body.p_run_id, JSON.parse(snapshot).operation_id);
    assert.equal(body.p.task_key, "ops.r2_history_dropbox_backup_mbpro");
    assert.equal(body.p.platform_run_id, body.p_run_id);
    assert.equal(body.p.started_at, "2026-10-21T23:59:00Z");
    assert.equal(body.p.scheduled_for_date, "2026-10-21");
    assert.equal(body.p.summary.github_run_attempt, undefined);
    if (bodies.length === 1) throw new TypeError("Started committed but response lost");
    return new Response(JSON.stringify(body.p_run_id));
  };
  const run = () => deliverHealth(state, c, () => { snapshot = JSON.stringify(state); }, {
    fetchImpl, now: () => clock,
  });
  assert.equal(await run(), false);
  state = JSON.parse(snapshot); clock = Date.parse(state.health.next_attempt_at);
  assert.equal(await run(), true);
  assert.equal(state.health.run_id, state.operation_id);
  assert.equal(state.health.status, "started");
  assert.deepEqual(bodies[0], bodies[1]);
});

test("shared client sends the optional UUID as a separate argument and preserves event timestamps", async () => {
  const calls = [];
  const client = createDailyTaskHealthClient({ env: {}, strict: true, recomputeDisabled: true,
    supabaseUrl: "https://example.invalid", supabaseKey: "local-test-only", requestTimeoutMs: 100,
    logHealth: () => {}, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      return new Response(JSON.stringify(calls.length === 1 ? "11111111-1111-4111-8111-111111111111" : null));
    } });
  const input = { task_key: "ops.r2_history_dropbox_backup_mbpro", source_repo: "uk-aq-ops",
    source_worker: "local-supervisor", platform_run_id: "local-uuid", scheduled_for_date: "2026-10-21",
    run_id: "11111111-1111-4111-8111-111111111111",
    started_at: "2026-10-21T23:59:00Z", summary: { execution_source: "macbook_pro_launchd" } };
  const id = await client.dailyTaskStarted(input);
  await client.dailyTaskFinished(id, { ...input, finished_at: "2026-10-22T01:00:00Z" });
  assert.equal(calls[0].p_run_id, input.run_id);
  assert.equal(calls[0].p.summary.github_run_attempt, undefined);
  assert.equal(calls[0].p.started_at, input.started_at);
  assert.equal(calls[1].p.finished_at, "2026-10-22T01:00:00Z");
  assert.equal(calls[1].p.scheduled_for_date, "2026-10-21");
  const { run_id: _requestedId, ...legacyInput } = input;
  await client.dailyTaskStarted(legacyInput);
  assert.equal(Object.hasOwn(calls[2], "p_run_id"), false);
});
