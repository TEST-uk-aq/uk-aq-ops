import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { refreshAndCommitTimeseriesBindingSource } from "../scripts/backup_r2/uk_aq_refresh_timeseries_binding_source_hierarchy.mjs";
import { buildTimeseriesBindingSourceState } from "../scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs";

const bindingPrefix = "history/_index_v2/timeseries_binding";
const sourceKey = `${bindingPrefix}/_source_state.json`;
const rangeKey = `${bindingPrefix}/_manifests/range=000000-000999.json`;
const rootKey = `${bindingPrefix}/_manifests/root.json`;
const refreshKey = `${bindingPrefix}/_manifests/_refresh_state.json`;
const fingerprint = "b".repeat(64);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const md5 = (value) => createHash("md5").update(value).digest("hex");

function fixture() {
  const proposal = buildTimeseriesBindingSourceState({
    bindingPrefix, sourceSchema: "uk_aq_core", sourceFingerprint: fingerprint,
    sourceTables: ["timeseries", "phenomena", "observed_properties"].map((table) => ({
      table, row_count: 1, sha256_uncompressed: "c".repeat(64),
    })),
    authoritativeTimeseriesCount: 1,
  });
  const previous = json({ ...proposal, source_fingerprint: "a".repeat(64) });
  const objects = new Map([
    [sourceKey, previous],
    [`${bindingPrefix}/timeseries_id=1.json`, '{"timeseries_id":1,"connector_id":1}\n'],
  ]);
  const events = [];
  const delays = [];
  const coreSnapshotReport = {
    ok: true, dry_run: false, completed_at: "2026-09-05T00:00:00Z", source_schema: "uk_aq_core",
    timeseries_binding_reconciliation: {
      status: "succeeded", invalid_binding_count: 0, authoritative_timeseries_count: 1,
      current_source_fingerprint: fingerprint, source_state_key: sourceKey,
      source_state_status: "awaiting_hierarchy_commit", proposed_source_state: proposal,
    },
  };
  const adapter = {
    async headObject({ key }) {
      events.push(["HEAD", key]);
      return objects.has(key) ? { exists: true, etag: md5(objects.get(key)) } : { exists: false };
    },
    async getObject({ key }) {
      events.push(["GET", key]);
      if (!objects.has(key)) throw new Error(`R2 GET failed (404): ${key}`);
      return { body: Buffer.from(objects.get(key)) };
    },
    async putObject({ key, body }) {
      events.push(["PUT", key]);
      objects.set(key, Buffer.from(body).toString("utf8"));
      return {};
    },
    async listAllObjects({ prefix }) {
      events.push(["LIST", prefix]);
      return [...objects.entries()].filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: Buffer.byteLength(body), etag: md5(body) }));
    },
  };
  return {
    adapter, objects, events, previous, proposal, coreSnapshotReport, delays,
    run: (options = {}) => refreshAndCommitTimeseriesBindingSource({
      r2: { adapter }, bindingPrefix, sourceFingerprint: fingerprint, coreSnapshotReport,
      sleepFn: async (ms) => { delays.push(ms); }, ...options,
    }),
  };
}

// This guard covers the producer side of the boundary without a real DB export.
test("core snapshot defers source-state publication and workflow passes its report", () => {
  const source = fs.readFileSync(new URL("../scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs", import.meta.url), "utf8");
  const reconciliation = source.slice(source.indexOf('const sourceStateKey ='), source.indexOf('report.completed_at ='));
  assert.match(reconciliation, /proposed_source_state = state/);
  assert.match(reconciliation, /source_state_status = "awaiting_hierarchy_commit"/);
  assert.doesNotMatch(reconciliation, /r2PutObject/);
  const workflow = fs.readFileSync(new URL("../.github/workflows/uk_aq_r2_core_snapshot.yml", import.meta.url), "utf8");
  assert.match(workflow, /--core-snapshot-report "tmp\/uk_aq_core_snapshot_to_r2_report.json"/);
});

test("source state is the final PUT and exact read-back after hierarchy verification", async () => {
  const f = fixture();
  const report = await f.run();
  assert.deepEqual(f.events.filter(([op]) => op === "PUT" || op === "GET").slice(-8), [
    ["PUT", rangeKey], ["GET", rangeKey], ["PUT", rootKey], ["GET", rootKey],
    ["PUT", refreshKey], ["GET", refreshKey], ["PUT", sourceKey], ["GET", sourceKey],
  ]);
  assert.equal(f.objects.get(sourceKey), json(f.proposal));
  assert.equal(report.source_state_status, "written_and_verified");
  assert.equal(report.source_state_verified, true);
  assert.equal(report.hierarchy.status, "succeeded");
});

for (const key of [rangeKey, rootKey, refreshKey]) {
  for (const operation of ["putObject", "getObject"]) {
    test(`${operation} failure at ${key} cannot advance source state`, async () => {
      const f = fixture();
      const original = f.adapter[operation];
      let failures = 0;
      f.adapter[operation] = async (args) => {
        if (args.key === key) {
          failures += 1;
          throw new Error(operation === "putObject" ? "R2 request failed (500)" : "R2 request failed (403)");
        }
        return original(args);
      };
      await assert.rejects(f.run(), (error) => {
        assert.equal(error.report.ok, false);
        assert.equal(error.report.source_state_status, "awaiting_hierarchy_commit");
        return true;
      });
      assert.equal(f.objects.get(sourceKey), f.previous);
      assert.equal(f.events.some(([op, path]) => op === "PUT" && path === sourceKey), false);
      assert.equal(failures, operation === "putObject" ? 3 : 1);
      assert.deepEqual(f.delays, operation === "putObject" ? [15000, 30000] : []);
    });
  }
}

test("failed reconciliation or mismatched handoff is rejected before hierarchy writes", async () => {
  const f = fixture();
  f.coreSnapshotReport.timeseries_binding_reconciliation.status = "failed";
  await assert.rejects(f.run(), /Invalid core snapshot source-state proposal/);
  assert.equal(f.objects.get(sourceKey), f.previous);
  assert.equal(f.events.length, 0);
  f.coreSnapshotReport.timeseries_binding_reconciliation.status = "succeeded";
  await assert.rejects(f.run({ sourceFingerprint: "d".repeat(64) }), /disagree/);
  assert.equal(f.events.length, 0);
});

test("dry run writes neither hierarchy nor source state", async () => {
  const f = fixture();
  const report = await f.run({ dryRun: true });
  assert.equal(report.hierarchy.status, "planned");
  assert.equal(report.source_state_status, "dry_run");
  assert.equal(f.events.some(([op]) => op === "PUT"), false);
  assert.equal(f.objects.get(sourceKey), f.previous);
});

test("unchanged fingerprint preserves reconciliation/hierarchy skips without rewrites", async () => {
  const f = fixture();
  await f.run();
  f.events.length = 0;
  f.coreSnapshotReport.timeseries_binding_reconciliation = {
    status: "skipped", reason: "source_fingerprint_unchanged", source_fingerprint_match: true,
    current_source_fingerprint: fingerprint,
  };
  const report = await f.run();
  assert.equal(report.hierarchy.status, "skipped");
  assert.equal(report.source_state_status, "unchanged");
  assert.equal(f.events.some(([op]) => op === "PUT" || op === "LIST"), false);
});

test("changed fingerprint with identical hierarchy writes only refresh and final source state", async () => {
  const f = fixture();
  await f.run();
  f.events.length = 0;
  const nextFingerprint = "e".repeat(64);
  const nextProposal = {
    ...f.proposal,
    source_fingerprint: nextFingerprint,
  };
  f.coreSnapshotReport.timeseries_binding_reconciliation = {
    status: "succeeded",
    invalid_binding_count: 0,
    authoritative_timeseries_count: 1,
    current_source_fingerprint: nextFingerprint,
    source_state_key: sourceKey,
    source_state_status: "awaiting_hierarchy_commit",
    proposed_source_state: nextProposal,
  };
  const report = await f.run({ sourceFingerprint: nextFingerprint });
  assert.equal(report.hierarchy.range_manifests_changed, 0);
  assert.equal(report.hierarchy.range_manifests_written, 0);
  assert.equal(report.hierarchy.source_root_changed, false);
  assert.equal(report.hierarchy.source_root_written, false);
  assert.equal(report.hierarchy.refresh_state_changed, true);
  assert.equal(report.hierarchy.refresh_state_written, true);
  assert.equal(report.hierarchy.change_detection_get_count, 0);
  assert.equal(report.source_state_status, "written_and_verified");
  assert.deepEqual(
    f.events.filter(([operation]) => operation === "PUT").map(([, key]) => key),
    [refreshKey, sourceKey],
  );
});

test("final PUT and read-back retry transient failures independently", async () => {
  const f = fixture();
  const put = f.adapter.putObject;
  const get = f.adapter.getObject;
  let putAttempts = 0;
  let verificationAttempts = 0;
  f.adapter.putObject = async (args) => {
    if (args.key === sourceKey && ++putAttempts === 1) throw new Error("R2 PUT failed (503)");
    return put(args);
  };
  f.adapter.getObject = async (args) => {
    if (args.key === sourceKey && f.objects.get(sourceKey) !== f.previous && ++verificationAttempts === 1) {
      throw new Error("fetch failed");
    }
    return get(args);
  };
  const report = await f.run();
  assert.equal(report.source_state_verified, true);
  assert.equal(putAttempts, 2);
  assert.equal(verificationAttempts, 2);
  assert.equal(f.events.filter(([op, key]) => op === "PUT" && key === sourceKey).length, 1);
  assert.deepEqual(f.delays, [15000, 15000]);
});

test("permanent final PUT error fails without retry; rerun can commit an already completed hierarchy", async () => {
  const f = fixture();
  const put = f.adapter.putObject;
  f.adapter.putObject = async (args) => {
    if (args.key === sourceKey) throw new Error("R2 PUT failed (403)");
    return put(args);
  };
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.report.hierarchy.status, "succeeded");
    assert.equal(error.report.source_state_status, "commit_pending");
    return true;
  });
  assert.equal(f.objects.get(sourceKey), f.previous);
  assert.deepEqual(f.delays, []);
  f.adapter.putObject = put;
  const report = await f.run();
  assert.equal(report.hierarchy.status, "skipped");
  assert.equal(report.source_state_status, "written_and_verified");
});

for (const mismatch of [false, true]) {
  test(`final ${mismatch ? "byte mismatch" : "exhausted GET retry"} cannot report verified success`, async () => {
    const f = fixture();
    const get = f.adapter.getObject;
    f.adapter.getObject = async (args) => {
      if (args.key === sourceKey && f.objects.get(sourceKey) !== f.previous) {
        if (mismatch) return { body: Buffer.from("{}") };
        throw new Error("R2 GET failed (500)");
      }
      return get(args);
    };
    await assert.rejects(f.run(), (error) => {
      assert.equal(error.report.hierarchy.status, "succeeded");
      assert.equal(error.report.source_state_written, true);
      assert.equal(error.report.source_state_verified, false);
      assert.equal(error.report.source_state_status, "written_awaiting_verification");
      return true;
    });
    assert.equal(f.objects.get(sourceKey), json(f.proposal));
    assert.equal(f.events.filter(([op, key]) => op === "PUT" && key === sourceKey).length, 1);
    assert.deepEqual(f.delays, mismatch ? [] : [15000, 30000]);
  });
}
