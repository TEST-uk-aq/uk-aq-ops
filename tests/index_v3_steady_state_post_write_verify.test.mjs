import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  STEADY_STATE_BASELINE_KIND,
  assertExactAffectedBranchDelta,
  assertExactLatestGlobalDelta,
  assertExactPollutantSet,
  assertReadOnlyAdapters,
  assertSafeLocalReportPath,
  bindIndependentControlStateToCanonical,
  classifyDependencyIdentity,
  summarizeDependencyReconciliation,
  validateAcceptanceReport,
  validateIndependentControlState,
  validateSteadyStateBaselineProvenance,
  withReadOnlyPgTransaction,
} from "../scripts/index_v3_migration/index_v3_steady_state_post_write_verify.mjs";
import { computePruneConnectorSourceIdentity } from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import { CONTROLLED_PHASE_B_SOURCE_TABLES } from "../scripts/index_v3_migration/index_v3_controlled_phase_b_source_freeze.mjs";

const DAY = "2026-08-21";
const RUN_ID = "test-index-v3-controlled-phaseb-20260821";
const ACCEPTANCE_GIT_SHA = "a".repeat(40);

function sourceRow(overrides = {}) {
  return {
    connector_id: 1,
    station_id: 10,
    timeseries_id: 100,
    pollutant_code: "no2",
    observed_at_utc: "2026-08-21T12:00:00.000Z",
    value: 12.5,
    status: "P",
    ...overrides,
  };
}

const SOURCE_ROWS = [sourceRow()];
const SOURCE_IDENTITY = computePruneConnectorSourceIdentity(SOURCE_ROWS);

function expected(overrides = {}) {
  return {
    environment: "TEST",
    acceptance_git_sha: ACCEPTANCE_GIT_SHA,
    run_id: RUN_ID,
    day_utc: DAY,
    connector_id: 1,
    source_row_count: 1,
    source_content_hash: SOURCE_IDENTITY.source_content_hash,
    source_content_hash_contract_version: 1,
    pollutant_count: 1,
    ...overrides,
  };
}

function acceptanceReport(overrides = {}) {
  const report = {
    ok: true,
    mode: "apply",
    environment: "TEST",
    run_id: RUN_ID,
    repository_git_sha: ACCEPTANCE_GIT_SHA,
    logical_history_version: "v2",
    observation_history_index_version: "v3",
    rollback_data_preservation_mode: "retain_upstream_source",
    execution_scope: "runPhaseBBackup_only_no_full_prune_job",
    plan: {
      candidate: {
        day_utc: DAY,
        connector_id: 1,
        source_row_count: "1",
        pollutant_codes: ["no2"],
        source_identity: { ...SOURCE_IDENTITY },
      },
    },
    completed_candidate: {
      day_utc: DAY,
      connector_id: 1,
      written_row_count: "1",
      source_content_hash: SOURCE_IDENTITY.source_content_hash,
    },
    phase_b_summary: {
      completed_candidates: 1,
      failed_candidates: 0,
      failures: [],
    },
    postflight: {
      source_preservation: {
        source_row_count_after: "1",
        source_identity_after: { ...SOURCE_IDENTITY },
        source_deletion_committed: false,
      },
      connector_manifest: {
        final_pollutant_codes: ["no2"],
      },
    },
    source_write_freeze: {
      held_during_controlled_child: true,
      lock_mode: "SHARE",
      acquired_at_utc: "2026-08-29T10:00:00.000Z",
      released_at_utc: "2026-08-29T10:01:00.000Z",
      child_exit_code: 0,
      child_timezone: "UTC",
      tables: [...CONTROLLED_PHASE_B_SOURCE_TABLES],
      persistent_database_mutation: false,
    },
  };
  return { ...report, ...overrides };
}

function accepted() {
  return validateAcceptanceReport(acceptanceReport(), expected());
}

function controlState(overrides = {}) {
  return {
    candidate: [{
      day_utc: DAY,
      connector_id: 1,
      status: "complete",
      run_id: RUN_ID,
      manifest_key: `history/v2/observations/day_utc=${DAY}/connector_id=1/manifest.json`,
      history_row_count: "1",
      history_file_count: 1,
      history_total_bytes: "100",
      source_content_hash: SOURCE_IDENTITY.source_content_hash,
      source_content_hash_contract_version: 1,
      source_content_hash_row_count: "1",
    }],
    connector_gate: [{
      day_utc: DAY,
      connector_id: 1,
      history_done: true,
      history_run_id: RUN_ID,
      history_manifest_key: `history/v2/observations/day_utc=${DAY}/connector_id=1/manifest.json`,
      history_manifest_hash: "b".repeat(64),
      history_row_count: "1",
      history_file_count: 1,
      history_total_bytes: "100",
      source_content_hash: SOURCE_IDENTITY.source_content_hash,
      source_content_hash_contract_version: 1,
      source_content_hash_row_count: "1",
      completion_source: "prune_daily_phase_b",
    }],
    day_gate: [{ day_utc: DAY, history_done: false }],
    peers: [
      { day_utc: DAY, connector_id: 1, status: "complete", run_id: RUN_ID },
      { day_utc: DAY, connector_id: 2, status: "pending", run_id: null },
      { day_utc: DAY, connector_id: 3, status: "pending", run_id: null },
      { day_utc: DAY, connector_id: 7, status: "pending", run_id: null },
    ],
    source_rows: SOURCE_ROWS,
    ...overrides,
  };
}

test("verifier adapter surface is read-only and rejects mutation adapters", () => {
  let calls = 0;
  const adapters = assertReadOnlyAdapters({
    query: async () => { calls += 1; },
    getObject: async () => { calls += 1; },
    headObject: async () => { calls += 1; },
    httpGet: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(typeof adapters.getObject, "function");
  assert.throws(
    () => assertReadOnlyAdapters({ ...adapters, putObject: async () => {} }),
    /mutation adapter is forbidden/,
  );
});

test("acceptance-report exact identity mismatch fails closed", () => {
  assert.throws(
    () => validateAcceptanceReport(acceptanceReport(), expected({ run_id: "different-run" })),
    /acceptance run_id mismatch/,
  );
});

test("independently retained source mismatch fails closed", () => {
  assert.throws(
    () => validateIndependentControlState(controlState({ source_rows: [sourceRow({ value: 99 })] }), accepted()),
    /recomputed retained source hash mismatch/,
  );
});

test("whole-day blocked state is accepted when peer connectors are pending", () => {
  const result = validateIndependentControlState(controlState(), accepted());
  assert.equal(result.whole_day_blocked_due_to_pending_peers, true);
  assert.deepEqual(result.pending_peer_connector_ids, [2, 3, 7]);
  assert.equal(result.source_retention.independently_recoverable, true);
});

test("missing or extra pollutant child fails exact-set validation", () => {
  assert.throws(() => assertExactPollutantSet(["no2"], ["no2", "pm10"]), /missing or extra/);
  assert.throws(() => assertExactPollutantSet(["no2", "pm10"], ["no2"]), /missing or extra/);
  assert.deepEqual(assertExactPollutantSet(["pm10", "no2"], ["no2", "pm10"]), ["no2", "pm10"]);
});

test("canonical dependency mismatch is classified FAIL", () => {
  assert.deepEqual(
    classifyDependencyIdentity(
      { exists: true, byte_size: 10, sha256: "b".repeat(64) },
      { byte_size: 10, sha256: "a".repeat(64) },
    ),
    { classification: "FAIL", reason: "exact_identity_mismatch" },
  );
});

test("new TEST and LIVE steady-state scope both reject legacy recovery ordering", () => {
  const legacy = classifyDependencyIdentity(
    { exists: true, byte_size: 10, sha256: "a".repeat(64) },
    { key: "legacy-hashless.json" },
    { allowLegacy: true },
  );
  assert.equal(legacy.classification, "LEGACY_RECOVERY_ORDERING");
  assert.throws(
    () => summarizeDependencyReconciliation([{ key: "legacy-hashless.json", ...legacy }], "TEST"),
    /TEST steady-state scope rejects LEGACY_RECOVERY_ORDERING=1/,
  );
  assert.throws(
    () => summarizeDependencyReconciliation([{ key: "legacy-hashless.json", ...legacy }], "LIVE"),
    /LIVE steady-state scope rejects LEGACY_RECOVERY_ORDERING=1/,
  );
});

test("report output cannot overwrite input, recovery, Dropbox or operator evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-steady-report-"));
  try {
    const checkpoint = path.join(root, "checkpoint.json");
    const recoveryRoot = `${checkpoint}.recovery`;
    const dropboxRoot = path.join(root, "Dropbox");
    const acceptance = path.join(root, "acceptance.json");
    const freeze = path.join(root, "writer-freeze.json");
    for (const directory of [recoveryRoot, dropboxRoot]) fs.mkdirSync(directory, { recursive: true });
    for (const file of [checkpoint, acceptance, freeze]) fs.writeFileSync(file, "{}\n");
    const args = {
      evidencePaths: [acceptance, freeze], checkpoint, recoveryRoot, dropboxRoot,
    };
    assert.throws(() => assertSafeLocalReportPath({ ...args, reportOut: acceptance }), /equals protected input/);
    assert.throws(() => assertSafeLocalReportPath({ ...args, reportOut: path.join(recoveryRoot, "report.json") }), /protected evidence directory/);
    assert.throws(() => assertSafeLocalReportPath({ ...args, reportOut: path.join(dropboxRoot, "report.json") }), /protected evidence directory/);
    assert.equal(
      assertSafeLocalReportPath({ ...args, reportOut: path.join(root, "reports", "result.json") }),
      path.join(fs.realpathSync(root), "reports", "result.json"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("affected hierarchy branch rejects an omitted baseline sibling", () => {
  const oldDay = { day_utc: "2026-08-20", manifest_key: "day-20", manifest_hash: "1".repeat(64) };
  const newDay = { day_utc: DAY, manifest_key: "day-21", manifest_hash: "2".repeat(64) };
  const july = { month: "07", manifest_key: "month-07", content_hash: "3".repeat(64) };
  const august = { month: "08", manifest_key: "month-08", content_hash: "4".repeat(64) };
  const year2025 = { year: 2025, manifest_key: "year-2025", content_hash: "5".repeat(64) };
  const year2026 = { year: 2026, manifest_key: "year-2026", content_hash: "6".repeat(64) };
  assert.throws(() => assertExactAffectedBranchDelta({
    baselineMonthChildren: [oldDay],
    baselineYearChildren: [july, { ...august, content_hash: "7".repeat(64) }],
    baselineRootChildren: [year2025, { ...year2026, content_hash: "8".repeat(64) }],
    currentMonth: { month: "08", manifest_key: "month-08", content_hash: august.content_hash, children: [newDay] },
    currentYear: { year: 2026, manifest_key: "year-2026", content_hash: year2026.content_hash, children: [july, august] },
    currentRoot: { children: [year2025, year2026] },
    acceptedDay: newDay,
  }), /advanced month aggregate differs/);
});

test("latest-global delta rejects removal of a baseline canonical day", () => {
  const old = { day_utc: "2026-08-20", scoped_roots: [] };
  const added = { day_utc: DAY, scoped_roots: [] };
  assert.throws(() => assertExactLatestGlobalDelta({
    baselineLatest: { days: [old.day_utc], day_summaries: [old] },
    currentLatest: { days: [DAY], day_summaries: [added] },
    acceptedDayUtc: DAY,
  }), /day set differs from baseline canonical days plus accepted day/);
});

test("connector gate semantic hash and totals must bind to canonical R2", () => {
  const independent = validateIndependentControlState(controlState(), accepted());
  const canonical = {
    connector: { manifest_hash: "b".repeat(64) },
    parquet: { row_count: 1, file_count: 1, total_bytes: 100 },
  };
  assert.equal(bindIndependentControlStateToCanonical(independent, canonical).connector_day_gate_exact, true);
  assert.throws(
    () => bindIndependentControlStateToCanonical(independent, {
      ...canonical,
      connector: { manifest_hash: "c".repeat(64) },
    }),
    /semantic manifest_hash mismatch/,
  );
});

test("PostgreSQL verifier work is enclosed in READ ONLY and always rolled back", async () => {
  const statements = [];
  const client = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
  await assert.rejects(
    withReadOnlyPgTransaction(client, async () => { throw new Error("probe failed"); }),
    /probe failed/,
  );
  assert.deepEqual(statements, ["begin transaction read only", "rollback"]);
});

test("pre-migration Dropbox hierarchy cannot be a steady-state baseline", () => {
  assert.throws(
    () => validateSteadyStateBaselineProvenance({
      kind: "pinned_pre_migration_dropbox_source_hierarchy",
      pre_migration_dropbox_source: true,
      checkpoint_sha256: "a".repeat(64),
      recovery_head_sha256: "b".repeat(64),
      immutable_authority_sha256: "c".repeat(64),
    }),
    /not authenticated post-migration recovery evidence/,
  );
  assert.equal(validateSteadyStateBaselineProvenance({
    kind: STEADY_STATE_BASELINE_KIND,
    pre_migration_dropbox_source: false,
    checkpoint_sha256: "a".repeat(64),
    recovery_head_sha256: "b".repeat(64),
    immutable_authority_sha256: "c".repeat(64),
  }).kind, STEADY_STATE_BASELINE_KIND);
});

test("UTC day identities remain exact YYYY-MM-DD and reject Date drift inputs", () => {
  assert.equal(accepted().day_utc, DAY);
  assert.throws(
    () => validateAcceptanceReport(acceptanceReport(), expected({ day_utc: "2026-08-21T00:00:00.000Z" })),
    /exact UTC YYYY-MM-DD identity/,
  );
});
