import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyObservationPruneAuditMonthState,
  observationPruneAuditMonthShardKey,
  recordObservationPruneAuditOutcome,
  selectObservationPruneAuditBatch,
  validateObservationPruneAuditMonthState,
} from "../scripts/backup_r2/lib/observation_prune_audit.mjs";
import {
  parseLockedHistoryBackupArgs,
  runLockedHistoryBackup,
} from "../scripts/backup_r2/uk_aq_run_locked_history_backup.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

const h = (char) => char.repeat(64);

function day(dayUtc, manifestHash) {
  return {
    day_utc: dayUtc,
    manifest_hash: manifestHash,
    relative_path: `history/v3/observations/day_utc=${dayUtc}`,
  };
}

test("never-audited days precede oldest audits with day tie-breaks and a hard limit", () => {
  const inventoryDays = [
    day("2026-10-05", h("e")),
    day("2026-10-01", h("a")),
    day("2026-10-04", h("d")),
    day("2026-10-02", h("b")),
    day("2026-10-03", h("c")),
  ];
  const acceptedCopyDays = inventoryDays.map(({ day_utc, manifest_hash }) => ({
    day_utc,
    manifest_hash,
  }));
  const auditCheckpoints = [
    {
      day_utc: "2026-10-01",
      manifest_hash: h("a"),
      last_successful_audit_at: "2026-09-02T00:00:00.000Z",
    },
    {
      day_utc: "2026-10-03",
      manifest_hash: h("c"),
      last_successful_audit_at: "2026-09-02T00:00:00.000Z",
    },
    {
      day_utc: "2026-10-04",
      manifest_hash: h("d"),
      last_successful_audit_at: "2026-09-01T00:00:00.000Z",
    },
  ];

  const selected = selectObservationPruneAuditBatch({
    inventoryDays,
    acceptedCopyDays,
    auditCheckpoints,
    maxDays: 4,
  });

  assert.deepEqual(
    selected.selected_days.map((entry) => entry.day_utc),
    ["2026-10-02", "2026-10-05", "2026-10-04", "2026-10-01"],
  );
  assert.equal(selected.selected_days.length, 4);
  assert.equal(selected.never_successfully_audited_eligible_count, 2);
  assert.equal(
    selected.oldest_successful_audit_at,
    "2026-09-01T00:00:00.000Z",
  );
  assert.throws(
    () => selectObservationPruneAuditBatch({
      inventoryDays,
      acceptedCopyDays,
      auditCheckpoints,
      maxDays: 0,
    }),
    /positive integer/,
  );
});

test("a current day is eligible only when Dropbox accepted the exact source identity", () => {
  const inventoryDays = [
    day("2026-10-01", h("a")),
    day("2026-10-02", h("b")),
  ];
  const selected = selectObservationPruneAuditBatch({
    inventoryDays,
    acceptedCopyDays: [
      { day_utc: "2026-10-01", manifest_hash: h("f") },
      { day_utc: "2026-10-02", manifest_hash: h("b") },
    ],
    auditCheckpoints: [],
    maxDays: 5,
  });

  assert.equal(selected.total_current_days_considered, 2);
  assert.equal(selected.eligible_days_count, 1);
  assert.equal(selected.excluded_source_identity_not_accepted_count, 1);
  assert.deepEqual(
    selected.selected_days.map((entry) => entry.day_utc),
    ["2026-10-02"],
  );
});

test("successful audit advances only its day while failure and dry run preserve freshness", () => {
  const initial = validateObservationPruneAuditMonthState({
    schema_version: 1,
    kind: "uk_aq_r2_history_backup_observation_prune_audit_month",
    backup_version: "v2",
    domain: "observation_prune_audit",
    year: "2026",
    month: "10",
    days: [{
      day_utc: "2026-10-01",
      manifest_hash: h("a"),
      last_successful_audit_at: "2026-09-01T00:00:00.000Z",
    }],
  }, "2026", "10");

  const succeeded = recordObservationPruneAuditOutcome({
    state: initial,
    day: day("2026-10-02", h("b")),
    successful: true,
    dryRun: false,
    auditedAt: "2026-10-05T12:00:00.000Z",
  });
  assert.deepEqual(succeeded.days, [
    initial.days[0],
    {
      day_utc: "2026-10-02",
      manifest_hash: h("b"),
      last_successful_audit_at: "2026-10-05T12:00:00.000Z",
    },
  ]);

  const failed = recordObservationPruneAuditOutcome({
    state: succeeded,
    day: day("2026-10-01", h("f")),
    successful: false,
    dryRun: false,
    auditedAt: "2026-10-05T13:00:00.000Z",
  });
  assert.deepEqual(failed, succeeded);

  const dryRun = recordObservationPruneAuditOutcome({
    state: succeeded,
    day: day("2026-10-01", h("f")),
    successful: true,
    dryRun: true,
    auditedAt: "2026-10-05T14:00:00.000Z",
  });
  assert.deepEqual(dryRun, succeeded);

  const sameInvocationSelection = selectObservationPruneAuditBatch({
    inventoryDays: [
      day("2026-10-01", h("a")),
      day("2026-10-02", h("b")),
    ],
    acceptedCopyDays: [
      { day_utc: "2026-10-01", manifest_hash: h("a") },
      { day_utc: "2026-10-02", manifest_hash: h("b") },
    ],
    auditCheckpoints: succeeded.days,
    alreadyAuditedThisInvocationDays: ["2026-10-02"],
    maxDays: 50,
  });
  assert.deepEqual(
    sameInvocationSelection.selected_days.map((entry) => entry.day_utc),
    ["2026-10-01"],
  );
});

test("monthly shard path is independent and malformed existing state fails closed", () => {
  assert.equal(
    observationPruneAuditMonthShardKey("2026", "10"),
    "_ops/checkpoints/r2_history_backup_state_v2/observation_prune_audit/year=2026/month=10.json",
  );
  assert.deepEqual(
    emptyObservationPruneAuditMonthState("2026", "10").days,
    [],
  );
  assert.throws(
    () => validateObservationPruneAuditMonthState({
      schema_version: 1,
      kind: "uk_aq_r2_history_backup_observation_prune_audit_month",
      backup_version: "v2",
      domain: "observation_prune_audit",
      year: "2026",
      month: "10",
      days: [{
        day_utc: "2026-10-01",
        manifest_hash: "not-a-hash",
        last_successful_audit_at: "not-utc",
      }],
    }, "2026", "10"),
    /manifest_hash/,
  );
});

test("locked wrapper defaults and forwards a positive independent forced-prune limit", () => {
  const required = [
    "--source-root", "r2:bucket",
    "--dest-root", "dropbox:backup",
    "--inventory-report-out", "tmp/inventory.json",
    "--backup-report-out", "tmp/backup.json",
  ];
  assert.equal(
    parseLockedHistoryBackupArgs(required).forcePruneMaxDaysPerRun,
    null,
  );
  assert.throws(
    () => parseLockedHistoryBackupArgs([
      ...required,
      "--force-prune-max-days-per-run", "0",
    ]),
    /positive integer/,
  );

  const identity = observationsGlobalOperationLockIdentity();
  const env = {
    UK_AQ_R2_HISTORY_VERSION: "v2",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "r2_history_dropbox_backup",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "backup:prune-audit-test",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "prune-audit-test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
  const invoke = (cli, configured, calls) => runLockedHistoryBackup({
    args: parseLockedHistoryBackupArgs([
      ...required,
      ...(cli === undefined ? [] : ["--force-prune-max-days-per-run", cli]),
    ]),
    env: { ...env, UK_AQ_R2_HISTORY_FORCE_PRUNE_MAX_DAYS_PER_RUN: configured },
    log: () => {},
    run: (_command, commandArgs) => {
      calls.push(commandArgs);
      return { status: 0, signal: null, error: null };
    },
  });
  for (const [cli, configured, expected] of [
    [undefined, undefined, "50"],
    [undefined, "   ", "50"],
    [undefined, "20", "20"],
    ["7", "20", "7"],
    ["7", "invalid", "7"],
  ]) {
    const calls = [];
    invoke(cli, configured, calls);
    const sync = calls.find((call) => /sync_history_to_dropbox\.mjs$/.test(call[0]));
    assert.ok(sync);
    const limitIndex = sync.indexOf("--force-prune-max-days-per-run");
    assert.ok(limitIndex > 0);
    assert.equal(sync[limitIndex + 1], expected);
    assert.equal(sync[sync.indexOf("--max-days-per-run") + 1], "0");
  }
  for (const invalid of ["0", "-1", "1.5", "invalid", "9007199254740992"]) {
    const calls = [];
    assert.throws(() => invoke(undefined, invalid, calls), /positive integer/);
    assert.deepEqual(calls, []);
    assert.throws(() => parseLockedHistoryBackupArgs([
      ...required, "--force-prune-max-days-per-run", invalid,
    ]), /positive integer/);
  }
});
