import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  authenticateObservationDayParquetFiles,
  authenticatePrecedingObservationDayState,
  buildObservationParquetExcludePatterns,
  normalizeObservationParquetCopyMode,
  planObservationParquetReuse,
  snapshotPrecedingObservationMonthState,
} from "../scripts/backup_r2/lib/observation_parquet_reuse.mjs";
import {
  emptyObservationMonthState,
  markObservationDayCopied,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  parseLockedHistoryBackupArgs,
  runLockedHistoryBackup,
} from "../scripts/backup_r2/uk_aq_run_locked_history_backup.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_UTC = "2026-08-06";
const DAY_ROOT = `history/v2/observations/day_utc=${DAY_UTC}`;
const DAY_KEY = `${DAY_ROOT}/manifest.json`;
const CONNECTOR_KEY = `${DAY_ROOT}/connector_id=7/manifest.json`;
const POLLUTANT_KEY = `${DAY_ROOT}/connector_id=7/pollutant_code=pm25/manifest.json`;
const PARQUET_KEY = `${DAY_ROOT}/connector_id=7/pollutant_code=pm25/part-000.parquet`;
const HASH = "a".repeat(64);

function withHash(payload) {
  return { ...payload, manifest_hash: sha256Hex(JSON.stringify(payload)) };
}

function baseManifest({ kind, key, connectorId, pollutantCode, files, children }) {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    manifest_schema_version: 3,
    history_schema_version: 3,
    history_version: "v2",
    manifest_kind: kind,
    domain: "observations",
    day_utc: DAY_UTC,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
    manifest_key: key,
    source_row_count: 1,
    row_count: 1,
    file_count: files.length,
    total_bytes: totalBytes,
    parquet_object_keys: files.map((file) => file.key),
    files,
    child_manifests: children,
  };
}

function manifestChain({ sha256 = HASH, bytes = 123 } = {}) {
  const files = [{ key: PARQUET_KEY, bytes, etag_or_hash: sha256 }];
  const pollutant = withHash(baseManifest({
    kind: "pollutant",
    key: POLLUTANT_KEY,
    connectorId: 7,
    pollutantCode: "pm25",
    files,
    children: [],
  }));
  const pollutantRef = {
    pollutant_code: "pm25",
    manifest_key: POLLUTANT_KEY,
    manifest_hash: pollutant.manifest_hash,
  };
  const connector = withHash({
    ...baseManifest({
      kind: "connector",
      key: CONNECTOR_KEY,
      connectorId: 7,
      pollutantCode: null,
      files,
      children: [pollutantRef],
    }),
    pollutant_manifests: [pollutantRef],
  });
  const connectorRef = {
    connector_id: 7,
    manifest_key: CONNECTOR_KEY,
    manifest_hash: connector.manifest_hash,
  };
  const day = withHash({
    ...baseManifest({
      kind: "day",
      key: DAY_KEY,
      connectorId: null,
      pollutantCode: null,
      files,
      children: [connectorRef],
    }),
    connector_manifests: [connectorRef],
  });
  return new Map([
    [DAY_KEY, day],
    [CONNECTOR_KEY, connector],
    [POLLUTANT_KEY, pollutant],
  ]);
}

function authenticate(chain) {
  return authenticateObservationDayParquetFiles({
    dayUtc: DAY_UTC,
    dayManifestKey: DAY_KEY,
    expectedDayManifestHash: chain.get(DAY_KEY).manifest_hash,
    dayManifest: chain.get(DAY_KEY),
    readManifest: (key) => chain.get(key),
  });
}

function lockedArgs(extra = []) {
  return parseLockedHistoryBackupArgs([
    "--source-root", "r2:bucket",
    "--dest-root", "dropbox:backup",
    "--inventory-report-out", "tmp/inventory.json",
    "--backup-report-out", "tmp/backup.json",
    ...extra,
  ]);
}

function lockEnv() {
  const identity = observationsGlobalOperationLockIdentity();
  return {
    UK_AQ_R2_HISTORY_VERSION: "v2",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "r2_history_dropbox_backup",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "backup:parquet-reuse-test",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "parquet-reuse-test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

test("copy mode omission and explicit full both resolve to unchanged full mode", () => {
  assert.equal(normalizeObservationParquetCopyMode(), "full");
  const omitted = lockedArgs();
  const explicit = lockedArgs(["--observation-parquet-copy-mode", "full"]);
  assert.equal(omitted.observationParquetCopyMode, "full");
  assert.equal(omitted.observationParquetCopyModeExplicit, false);
  assert.equal(explicit.observationParquetCopyMode, "full");
  assert.equal(explicit.observationParquetCopyModeExplicit, true);
  assert.throws(
    () => lockedArgs(["--observation-parquet-copy-mode", "unsafe"]),
    /must be exactly full or reuse_matching/,
  );
});

test("locked runner preserves omission and forwards only an explicit copy mode", () => {
  const run = (calls) => (_command, commandArgs) => {
    calls.push(commandArgs);
    return { status: 0, signal: null, error: null };
  };
  const omittedCalls = [];
  runLockedHistoryBackup({
    args: lockedArgs(),
    env: lockEnv(),
    run: run(omittedCalls),
    log: () => {},
  });
  const omittedSync = omittedCalls.find((args) => /sync_history_to_dropbox\.mjs$/.test(args[0]));
  assert.ok(omittedSync);
  assert.equal(omittedSync.includes("--observation-parquet-copy-mode"), false);

  const explicitCalls = [];
  runLockedHistoryBackup({
    args: lockedArgs(["--observation-parquet-copy-mode", "reuse_matching"]),
    env: lockEnv(),
    run: run(explicitCalls),
    log: () => {},
  });
  const explicitSync = explicitCalls.find((args) => /sync_history_to_dropbox\.mjs$/.test(args[0]));
  const modeIndex = explicitSync.indexOf("--observation-parquet-copy-mode");
  assert.equal(explicitSync[modeIndex + 1], "reuse_matching");
});

test("exact authenticated key, bytes and SHA-256 is reusable", () => {
  const files = authenticate(manifestChain());
  const plan = planObservationParquetReuse({
    dayRelativePath: DAY_ROOT,
    currentFiles: files,
    previousFiles: files,
    destinationFiles: new Map([[PARQUET_KEY, { size: 123 }]]),
  });
  assert.equal(plan.reused_count, 1);
  assert.equal(plan.reused_bytes, 123);
  assert.equal(plan.copy_required_count, 0);
  assert.deepEqual(
    buildObservationParquetExcludePatterns(plan.reusable),
    ["/connector_id=7/pollutant_code=pm25/part-000.parquet"],
  );
});

test("copy-required and proof-fallback reporting classifications remain distinct", () => {
  const current = authenticate(manifestChain());
  const cases = [
    {
      name: "exact match",
      previous: current,
      destination: new Map([[PARQUET_KEY, { size: 123 }]]),
      copyRequired: 0,
      fallback: 0,
      reason: null,
    },
    {
      name: "new key",
      previous: [],
      destination: new Map([[PARQUET_KEY, { size: 123 }]]),
      copyRequired: 1,
      fallback: 0,
      reason: null,
    },
    {
      name: "SHA mismatch",
      previous: authenticate(manifestChain({ sha256: "b".repeat(64) })),
      destination: new Map([[PARQUET_KEY, { size: 123 }]]),
      copyRequired: 1,
      fallback: 0,
      reason: null,
    },
    {
      name: "canonical size mismatch",
      previous: authenticate(manifestChain({ bytes: 122 })),
      destination: new Map([[PARQUET_KEY, { size: 123 }]]),
      copyRequired: 1,
      fallback: 0,
      reason: null,
    },
    {
      name: "unauthenticated checkpoint",
      previous: [],
      destination: new Map(),
      baselineFailureReason: "preceding_checkpoint_shard_unauthenticated",
      copyRequired: 1,
      fallback: 1,
      reason: "preceding_checkpoint_shard_unauthenticated",
    },
    {
      name: "missing preceding checkpoint day",
      previous: [],
      destination: new Map(),
      baselineFailureReason: "preceding_checkpoint_day_missing",
      copyRequired: 1,
      fallback: 1,
      reason: "preceding_checkpoint_day_missing",
    },
    {
      name: "unauthenticated preceding manifest chain",
      previous: [],
      destination: new Map(),
      baselineFailureReason: "preceding_manifest_chain_unauthenticated",
      copyRequired: 1,
      fallback: 1,
      reason: "preceding_manifest_chain_unauthenticated",
    },
    {
      name: "unauthenticated current manifest chain",
      previous: [],
      destination: new Map(),
      baselineFailureReason: "current_manifest_chain_unauthenticated",
      copyRequired: 1,
      fallback: 1,
      reason: "current_manifest_chain_unauthenticated",
    },
    {
      name: "missing destination",
      previous: current,
      destination: new Map(),
      copyRequired: 1,
      fallback: 1,
      reason: "destination_missing",
    },
    {
      name: "destination size mismatch",
      previous: current,
      destination: new Map([[PARQUET_KEY, { size: 122 }]]),
      copyRequired: 1,
      fallback: 1,
      reason: "destination_byte_size_mismatch",
    },
    {
      name: "unsafe filter path",
      current: [{
        ...current[0],
        key: "history/v2/observations/day_utc=2026-08-05/part-000.parquet",
      }],
      previous: [{
        ...current[0],
        key: "history/v2/observations/day_utc=2026-08-05/part-000.parquet",
      }],
      destination: new Map([
        ["history/v2/observations/day_utc=2026-08-05/part-000.parquet", { size: 123 }],
      ]),
      copyRequired: 1,
      fallback: 1,
      reason: "unsafe_filter_path",
    },
  ];
  for (const entry of cases) {
    const plan = planObservationParquetReuse({
      dayRelativePath: DAY_ROOT,
      currentFiles: entry.current || current,
      previousFiles: entry.previous,
      destinationFiles: entry.destination,
      baselineFailureReason: entry.baselineFailureReason,
    });
    assert.equal(
      plan.reused_count,
      entry.name === "exact match" ? 1 : 0,
      entry.name,
    );
    assert.equal(plan.copy_required_count, entry.copyRequired, entry.name);
    assert.equal(plan.copy_required_bytes, entry.copyRequired * 123, entry.name);
    assert.equal(plan.fallback_count, entry.fallback, entry.name);
    assert.deepEqual(
      plan.fallback_reasons,
      entry.reason ? { [entry.reason]: 1 } : {},
      entry.name,
    );
  }
});

test("all changed days authenticate against one immutable preceding month state", () => {
  const secondDayUtc = "2026-08-07";
  const monthState = {
    ...emptyObservationMonthState("2026", "08"),
    processed_source_month_hash: "c".repeat(64),
    days: [
      {
        day_utc: DAY_UTC,
        manifest_hash: "d".repeat(64),
        copied_at: "2026-08-08T00:00:00.000Z",
      },
      {
        day_utc: secondDayUtc,
        manifest_hash: "e".repeat(64),
        copied_at: "2026-08-08T00:00:00.000Z",
      },
    ],
  };
  const monthStateText = `${JSON.stringify(monthState)}\n`;
  const summary = {
    state_shard_key: "state/2026-08.json",
    state_shard_hash: sha256Hex(monthStateText),
    processed_source_month_hash: monthState.processed_source_month_hash,
  };
  const precedingMonthState = snapshotPrecedingObservationMonthState(monthState);

  assert.equal(authenticatePrecedingObservationDayState({
    monthStateText,
    monthState: precedingMonthState,
    monthStateRelativePath: summary.state_shard_key,
    stateMonthSummary: summary,
    dayUtc: DAY_UTC,
  }).ok, true);

  const advancingMonthState = markObservationDayCopied(
    monthState,
    { day_utc: DAY_UTC, manifest_hash: "f".repeat(64) },
    "2026-08-09T00:00:00.000Z",
  );
  assert.equal(advancingMonthState.processed_source_month_hash, null);
  assert.deepEqual(authenticatePrecedingObservationDayState({
    monthStateText,
    monthState: advancingMonthState,
    monthStateRelativePath: summary.state_shard_key,
    stateMonthSummary: summary,
    dayUtc: secondDayUtc,
  }), {
    ok: false,
    reason: "preceding_checkpoint_shard_unauthenticated",
  });
  const secondDayAuthority = authenticatePrecedingObservationDayState({
    monthStateText,
    monthState: precedingMonthState,
    monthStateRelativePath: summary.state_shard_key,
    stateMonthSummary: summary,
    dayUtc: secondDayUtc,
  });
  assert.equal(secondDayAuthority.ok, true);
  const secondDayRoot = `history/v2/observations/day_utc=${secondDayUtc}`;
  const secondDayParquetKey = `${secondDayRoot}/connector_id=7/part-000.parquet`;
  const secondDayFiles = [{
    key: secondDayParquetKey,
    byte_size: 123,
    sha256: HASH,
  }];
  const secondDayPlan = planObservationParquetReuse({
    dayRelativePath: secondDayRoot,
    currentFiles: secondDayFiles,
    previousFiles: secondDayFiles,
    destinationFiles: new Map([[secondDayParquetKey, { size: 123 }]]),
  });
  assert.equal(secondDayPlan.reused_count, 1);
  assert.equal(secondDayPlan.copy_required_count, 0);
});

test("checkpoint shard authentication is required before prior manifests can be used", () => {
  const monthState = {
    processed_source_month_hash: "c".repeat(64),
    days: [{
      day_utc: DAY_UTC,
      manifest_hash: "d".repeat(64),
      copied_at: "2026-08-07T00:00:00.000Z",
    }],
  };
  const monthStateText = `${JSON.stringify(monthState)}\n`;
  const summary = {
    state_shard_key: "state/2026-08.json",
    state_shard_hash: sha256Hex(monthStateText),
    processed_source_month_hash: monthState.processed_source_month_hash,
  };
  assert.equal(authenticatePrecedingObservationDayState({
    monthStateText,
    monthState,
    monthStateRelativePath: summary.state_shard_key,
    stateMonthSummary: summary,
    dayUtc: DAY_UTC,
  }).ok, true);
  const unauthenticated = authenticatePrecedingObservationDayState({
    monthStateText,
    monthState,
    monthStateRelativePath: summary.state_shard_key,
    stateMonthSummary: { ...summary, state_shard_hash: "e".repeat(64) },
    dayUtc: DAY_UTC,
  });
  assert.deepEqual(unauthenticated, {
    ok: false,
    reason: "preceding_checkpoint_shard_unauthenticated",
  });
  const fallback = planObservationParquetReuse({
    dayRelativePath: DAY_ROOT,
    currentFiles: authenticate(manifestChain()),
    previousFiles: [],
    destinationFiles: new Map(),
    baselineFailureReason: unauthenticated.reason,
  });
  assert.equal(fallback.reused_count, 0);
  assert.equal(fallback.copy_required_count, 1);
});

test("reuse filter contains only Parquet while normal prune and verification gates remain", () => {
  const patterns = buildObservationParquetExcludePatterns([{
    filter_relative_path: "connector_id=7/pollutant_code=pm25/part-000.parquet",
  }]);
  assert.ok(patterns.every((pattern) => pattern.endsWith(".parquet")));
  assert.ok(patterns.every((pattern) => !pattern.endsWith("manifest.json")));

  const syncSource = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/backup_r2/sync_history_to_dropbox.mjs"),
    "utf8",
  );
  const copyStart = syncSource.indexOf("function copyAndVerifyObservationDay");
  const prune = syncSource.indexOf("pruneStaleParquetForUnit", copyStart);
  const verification = syncSource.indexOf("parseDayManifestHash", copyStart);
  const markProcessed = syncSource.indexOf("markObservationDayCopied", verification);
  assert.ok(copyStart >= 0 && prune > copyStart);
  assert.ok(verification > prune);
  assert.ok(markProcessed > verification);
});

test("workflow exposes full default and forwards the selected copy mode", () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/uk_aq_r2_history_dropbox_backup.yml"),
    "utf8",
  );
  const start = workflow.indexOf("      observation_parquet_copy_mode:");
  const end = workflow.indexOf("      timeseries_binding_backup_mode:", start);
  const block = workflow.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /default: "full"/);
  assert.match(block, /options:\n\s+- full\n\s+- reuse_matching/);
  assert.match(workflow, /--observation-parquet-copy-mode "\$\{observation_parquet_copy_mode\}"/);
});
