import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { addDiscoveryDays, createLateArrivalReader, discoverAndProcessLateArrivals, LATE_ARRIVAL_LIMITS, validatePresenceResponse } from "../workers/uk_aq_prune_daily/late_arrival_discovery.mjs";
import { openLateArrivalProgress } from "../workers/uk_aq_prune_daily/late_arrival_progress.mjs";
import { runLateArrivalCleanup, runPruneForTest } from "../workers/uk_aq_prune_daily/server.mjs";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const CUTOFF = "2026-11-01T00:00:00.000Z";
function payload(from, to, present = () => true, checked = NOW) {
  const days = [];
  for (let d = from; d < to; d = addDiscoveryDays(d, 1)) days.push({ day_utc: d, present: present(d) });
  return { schema_version: 1, from_day_utc: from, to_day_utc_exclusive: to,
    checked_day_count: days.length, complete: true, checked_at_utc: new Date(checked).toISOString(),
    current_day_utc: new Date(checked).toISOString().slice(0, 10), days };
}
function state(next = "2026-10-20", cutoff = CUTOFF) {
  return { schema_version: 1, progress_version: "1", sweep_cutoff: cutoff, next_day_utc: next, sweep_complete: next === null };
}
function memoryProgress(initial = null) {
  return { state: initial, writes: [], async assertOwned() {}, async close() {},
    async save(next, report) {
      this.state = { ...structuredClone(next), progress_version: String(this.writes.length + 2) };
      this.writes.push({ state: structuredClone(this.state), report: structuredClone(report) });
    } };
}
function harness(options = {}) {
  const progress = options.progress || memoryProgress(options.state ?? null);
  const calls = [];
  const reader = { earliest: async () => "2026-10-20T01:00:00.000Z",
    presence: async (from, to) => payload(from, to), ...options.reader };
  const args = { cutoff: CUTOFF, dryRun: false, progress, reader, now: () => NOW,
    classifyDay: () => "repair", runId: "test-run",
    processDay: async (d, route) => { calls.push([d, route]); return { run_id: d, alert_condition_count: 0 }; }, ...options };
  return { progress, calls, args, run: () => discoverAndProcessLateArrivals(args) };
}

test("bounded calendar discovery reaches later dates without fetching observations in pages", async () => {
  const h = harness();
  const { report } = await h.run();
  assert.equal(report.status, "complete");
  assert.equal(report.processed_day_count, 12);
  assert.equal(report.discovery_request_count, 2);
  assert.ok(h.calls.some(([d]) => d === "2026-10-23"));
  assert.equal(h.progress.state.next_day_utc, null);
});

for (const route of ["repair", "direct_delete"]) {
  test(`${route} stops at 14 and resumes at the first deferred positive`, async () => {
    const h = harness({ cutoff: "2026-11-09T00:00:00.000Z", classifyDay: () => route });
    const first = await h.run();
    assert.equal(h.calls.length, 14);
    assert.equal(first.report.status, "deferred");
    assert.equal(first.report.deferred_day_count, 6);
    assert.equal(h.progress.state.next_day_utc, "2026-11-03");
    const resumed = harness({ ...h.args, progress: h.progress });
    const second = await resumed.run();
    assert.equal(second.report.processed_day_count, 6);
    assert.equal(second.report.status, "complete");
  });
}

test("blocked dates durably record their outcome and do not starve following dates", async () => {
  const h = harness({ processDay: async (d) => ({ run_id: d, alert_condition_count: 1, connector_history_gate_blocked_bucket_count: 1 }) });
  const { report } = await h.run();
  assert.equal(report.blocked_day_count, 12);
  assert.equal(report.attention_required, true);
  assert.equal(h.progress.state.sweep_complete, true);
  assert.equal(h.progress.writes.at(-1).report.outcomes.length, 12);
  assert.ok(h.progress.writes.at(-1).report.outcomes.every((x) => x.outcome === "blocked"));
});

test("completed sweep wraps to new earliest data, including inserts behind the old cursor", async () => {
  const h = harness({ state: state(null), cutoff: "2026-11-02T00:00:00.000Z",
    reader: { earliest: async (cutoff) => { assert.equal(cutoff, "2026-11-02T00:00:00.000Z"); return "2026-09-01T00:00:00.000Z"; },
      presence: async (from, to) => payload(from, to, (d) => d === "2026-09-01") } });
  const { report } = await h.run();
  assert.equal(report.wraparound, true);
  assert.deepEqual(h.calls, [["2026-09-01", "repair"]]);
  assert.equal(report.sweep_complete, true);
});

test("active sweep retains its fixed cutoff; earlier current cutoff restarts conservatively", async () => {
  const h = harness({ state: state(), cutoff: "2026-11-02T00:00:00.000Z",
    reader: { earliest: async () => { throw new Error("must not restart active sweep"); } } });
  assert.equal((await h.run()).report.cutoff_window_start, CUTOFF);
  const restart = harness({ state: state(), cutoff: "2026-10-25T00:00:00.000Z" });
  const result = await restart.run();
  assert.equal(result.report.restarted_for_earlier_cutoff, true);
  assert.equal(restart.calls.at(-1)[0], "2026-10-24");
});

test("dry-run simulates continuation without saving or changing stored state", async () => {
  const progress = memoryProgress(state());
  const before = structuredClone(progress.state);
  const h = harness({ progress, dryRun: true });
  const { report } = await h.run();
  assert.equal(report.status, "complete");
  assert.equal(report.progress_persisted, false);
  assert.equal(report.persisted_next_day_utc, "2026-10-20");
  assert.deepEqual(progress.state, before);
  assert.equal(progress.writes.length, 0);
});

test("partial cutoff date uses exact timestamp seek and never whole-day nomination", async () => {
  const h = harness({ state: state("2026-10-20", "2026-10-20T12:00:00.000Z"), cutoff: "2026-10-20T12:00:00.000Z",
    reader: { earliest: async (cutoff, from) => { assert.equal(from, "2026-10-20"); assert.equal(cutoff, "2026-10-20T12:00:00.000Z"); return null; },
      presence: async () => { throw new Error("whole day must not be requested"); } } });
  const { report } = await h.run();
  assert.equal(report.absent_day_count, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(report.status, "complete");
});

test("empty sweep is explicit and completes without day processing", async () => {
  const h = harness({ reader: { earliest: async () => null } });
  const { report } = await h.run();
  assert.equal(report.stop_reason, "empty_sweep");
  assert.equal(report.discovery_request_count, 1);
  assert.equal(h.calls.length, 0);
});

test("expired runtime, page and request budgets retain next unexamined date", async () => {
  for (const [field, value, reason] of [["maxMilliseconds", 0, "runtime_budget"], ["maxPages", 0, "page_budget"], ["maxRequests", 0, "request_budget"]]) {
    const h = harness({ state: state(), limits: { ...LATE_ARRIVAL_LIMITS, [field]: value } });
    const { report } = await h.run();
    assert.equal(report.stop_reason, reason);
    assert.equal(h.calls.length, 0);
    assert.equal(h.progress.state.next_day_utc, "2026-10-20");
  }
});

test("budget expiring after a safe day records it but does not dispatch another", async () => {
  let clock = NOW;
  const h = harness({ state: state(), now: () => clock,
    processDay: async () => { clock += LATE_ARRIVAL_LIMITS.maxMilliseconds; return { alert_condition_count: 0 }; } });
  const { report } = await h.run();
  assert.equal(report.processed_day_count, 1);
  assert.equal(report.stop_reason, "runtime_budget");
  assert.equal(h.progress.state.next_day_utc, "2026-10-21");
});

test("strict RPC validation rejects malformed, partial, stale and unordered responses without progress", async () => {
  const mutations = [
    (p) => { p.complete = false; }, (p) => { p.schema_version = 2; },
    (p) => { p.from_day_utc = "2026-10-19"; }, (p) => { p.to_day_utc_exclusive = "2026-11-02"; },
    (p) => { p.checked_day_count--; }, (p) => { p.days.pop(); },
    (p) => { p.days[0].present = "true"; }, (p) => { p.days.reverse(); },
    (p) => { p.checked_at_utc = "2026-01-01T00:00:00Z"; },
    (p) => { p.current_day_utc = "2026-11-09"; },
    (p) => { p.checked_at_utc = "2026-02-30T00:00:00Z"; },
  ];
  for (const mutate of mutations) {
    const h = harness({ state: state(), reader: { presence: async (from, to) => {
      const p = payload(from, to); mutate(p); return p;
    } } });
    const { report } = await h.run();
    assert.equal(report.status, "failed");
    assert.equal(h.progress.writes.length, 0);
    assert.equal(h.calls.length, 0);
  }
  assert.equal(validatePresenceResponse(payload("2026-10-20", "2026-10-21"), "2026-10-20", "2026-10-21", NOW).length, 1);
});

test("RPC and ambiguous day failures never advance the failed date", async () => {
  for (const extra of [
    { reader: { presence: async () => { throw new Error("RPC timeout"); } } },
    { processDay: async () => { throw new Error("lost connection during work"); } },
    { processDay: async () => ({ delete_error_count: 1 }) },
    { processDay: async () => ({ repair_replay_error_count: 1 }) },
  ]) {
    const h = harness({ state: state(), ...extra });
    const { report } = await h.run();
    assert.equal(report.status, "failed");
    assert.equal(report.attention_required, true);
    assert.equal(h.progress.state.next_day_utc, "2026-10-20");
    assert.equal(h.progress.writes.length, 0);
  }
});

test("ambiguous checkpoint stops processing and exposes last acknowledged position", async () => {
  const progress = memoryProgress(state());
  progress.save = async () => { throw new Error("COMMIT response lost"); };
  const h = harness({ progress });
  const { report } = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(report.checkpoint_outcome_unknown, true);
  assert.equal(report.next_day_utc, "2026-10-20");
  assert.equal(report.status, "failed");
});

class ScriptedClient extends EventEmitter {
  constructor(responses) { super(); this.responses = responses; this.queries = []; this.ended = false; }
  async connect() {}
  async end() { this.ended = true; }
  async query(sql, args) {
    this.queries.push({ sql, args });
    const response = this.responses.shift();
    assert.ok(response, `Unexpected query: ${sql}`);
    if (response instanceof Error) throw response;
    return response;
  }
}
const rows = (...values) => ({ rows: values });
test("overlapping progress claim is rejected before any table mutation", async () => {
  const client = new ScriptedClient([rows({ acquired: false })]);
  await assert.rejects(openLateArrivalProgress({ databaseUrl: "injected", dryRun: false, createClient: () => client }), /owned by another/);
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended, true);
});
test("progress adapter dry-run performs only SELECT and refuses save", async () => {
  const client = new ScriptedClient([rows(state())]);
  const progress = await openLateArrivalProgress({ databaseUrl: "injected", dryRun: true, createClient: () => client });
  await assert.rejects(progress.save(state(), {}), /Dry-run/);
  assert.equal(client.queries.length, 1);
  assert.match(client.queries[0].sql, /^select /);
  await progress.close();
});
test("version-fenced checkpoint rejects a stale owner and session loss stops further work", async () => {
  const client = new ScriptedClient([rows({ acquired: true }), rows(), rows(), rows(state()), rows(), rows(state()), rows()]);
  const progress = await openLateArrivalProgress({ databaseUrl: "injected", dryRun: false, createClient: () => client });
  await assert.rejects(progress.save(state("2026-10-21"), {}), /ownership\/version lost/);
  client.emit("error", new Error("session lost"));
  await assert.rejects(progress.assertOwned(), /session lost/);
  assert.equal(client.responses.length, 0);
  await progress.close();
  assert.equal(client.ended, true);
});

test("checkpoint commits outcome with cursor using the claimed owner and version", async () => {
  const client = new ScriptedClient([rows({ acquired: true }), rows(), rows(), rows(state()), rows(), rows(state()),
    rows({ progress_version: "1" }), rows({ progress_version: "2" }), rows({ progress_version: "2" })]);
  const progress = await openLateArrivalProgress({ databaseUrl: "injected", dryRun: false, createClient: () => client });
  const report = { outcomes: [{ day_utc: "2026-10-20", outcome: "blocked" }] };
  await progress.save(state("2026-10-21"), report);
  await progress.assertOwned();
  const checkpoint = client.queries.find(({ sql }) => sql.includes("last_report ="));
  assert.equal(checkpoint.args[1], "1");
  assert.equal(checkpoint.args[3], "2026-10-21");
  assert.deepEqual(JSON.parse(checkpoint.args[5]), report);
  assert.equal(client.queries.at(-1).args[1], "2");
  assert.equal(client.queries.at(-1).args[0], checkpoint.args[0]);
  await progress.close();
});

test("corrupt cursor fails before any presence or processing work", async () => {
  const h = harness({ state: { ...state(), schema_version: 9 } });
  const { report } = await h.run();
  assert.equal(report.status, "failed");
  assert.equal(report.discovery_request_count, 0);
  assert.equal(h.progress.writes.length, 0);
  assert.equal(h.calls.length, 0);
});

test("existing timestamp adapter uses one-row ordered seek and exact cutoff", async () => {
  const calls = [];
  const query = Object.fromEntries(["schema", "from", "select", "lt", "order", "limit", "gte"].map((method) => [method, (...args) => { calls.push([method, ...args]); return query; }]));
  query.abortSignal = async () => ({ data: [{ observed_at: "2026-10-20T01:00:00+00:00" }], error: null });
  assert.equal(await createLateArrivalReader(query).earliest(CUTOFF, "2026-10-20", 1000), "2026-10-20T01:00:00.000Z");
  assert.ok(calls.some(([method, value]) => method === "limit" && value === 1));
  assert.ok(calls.some(([method, field, value]) => method === "lt" && field === "observed_at" && value === CUTOFF));
});

test("real cleanup routes days to existing processors with shared duplicate avoidance", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const first = addDiscoveryDays(today, -15);
  const boundary = addDiscoveryDays(today, -14);
  const cutoff = `${addDiscoveryDays(today, -13)}T00:00:00.000Z`;
  const shared = new Set(["already-considered"]);
  const routes = [];
  const progress = memoryProgress(state(first, cutoff));
  const summary = await runLateArrivalCleanup({ dryRun: true, obsAqidbObservsRetentionDays: 14 }, { window_start: cutoff },
    { processed_connector_days: shared }, {
      ingestClient: {}, openProgress: async () => progress,
      reader: { presence: async (from, to) => payload(from, to, () => true, Date.now()) },
      directDeleteDay: async (_config, _client, window, _run, _index, _count, seen) => {
        assert.equal(seen, shared); routes.push(["direct", window.day_utc]); return {};
      },
      pruneSingleWindow: async (_config, window, context) => {
        assert.equal(context.processed_connector_days, shared); routes.push(["repair", window.day_utc]); return {};
      },
    });
  assert.deepEqual(routes, [["direct", first], ["repair", boundary]]);
  assert.equal(summary.status, "complete");
  assert.equal(progress.writes.length, 0);
});

test("outer runner never reports failed/deferred discovery as green success", async () => {
  for (const failure of [async () => { throw new Error("progress unavailable"); }, async () => ({ status: "deferred", attention_required: true })]) {
    await assert.rejects(runPruneForTest({ dryRun: false, maxHoursPerRun: 48, ingestDbRetentionDays: 5, phaseB: {} }, {
      runPhaseARecent: async () => ({}), runPhaseBBackup: async () => ({ status: "completed" }),
      runPruneSingleWindow: async () => ({}), runLateArrivalCleanup: failure,
    }), (error) => error.code === "UK_AQ_PRUNE_PARTIAL_ATTENTION_REQUIRED" && error.prune_summary.attention_required);
  }
});
