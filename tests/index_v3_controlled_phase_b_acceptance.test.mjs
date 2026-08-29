import assert from "node:assert/strict";
import test from "node:test";

import {
  assertControlledPlanMatchesExpected,
  buildControlledPhaseBConfig,
  executeControlledPhaseBAcceptance,
  parseControlledPhaseBAcceptanceArgs,
} from "../scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.mjs";

const GIT_SHA = "a".repeat(40);
const SOURCE_HASH = "b".repeat(64);

function baseEnv() {
  return {
    UKAQ_ENV_NAME: "TEST",
    UK_AQ_R2_HISTORY_INTEGRITY_VERSION: "v2",
    GITHUB_SHA: GIT_SHA,
    INGESTDB_RETENTION_DAYS: "5",
  };
}

function basePhaseB() {
  return {
    history_write_version: "v2",
    observation_history_index_version: "v3",
    supabase_db_url: "postgres://example.invalid/test",
    observs_source: {
      base_url: "https://example.invalid",
      privileged_key: "test-key",
    },
    r2: {
      bucket: "test-bucket",
      endpoint: "https://example.invalid",
      access_key_id: "access",
      secret_access_key: "secret",
    },
    max_candidates_per_run: 500,
    phase_b_observation_snapshot_max_rows: 250000,
    phase_b_observation_snapshot_max_bytes: 268435456,
    observations_pollutant_codes: [],
    staging_retention_days: 7,
    prune_check_dropbox: {
      enabled: true,
      required: true,
      dir: "prune_r2_check",
    },
  };
}

function plan() {
  return {
    window: {
      latest_eligible_day_utc: "2026-08-21",
      latest_eligible_window_end_utc: "2026-08-22T00:00:00.000Z",
    },
    selection_reason: "new_candidate",
    candidate: {
      day_utc: "2026-08-21",
      connector_id: 1,
      source_row_count: "10",
      min_observed_at: "2026-08-21T00:00:00.000Z",
      max_observed_at: "2026-08-21T23:00:00.000Z",
      source_identity: {
        source_content_hash: SOURCE_HASH,
        source_content_hash_contract_version: 1,
        source_content_hash_row_count: 10,
      },
      pollutant_counts: { no2: 10 },
      pollutant_codes: ["no2"],
    },
  };
}

function dryRunOptions() {
  return {
    mode: "dry-run",
    environment: "TEST",
    expectedBucket: "test-bucket",
    expectedGitSha: GIT_SHA,
    expectedDay: null,
    expectedConnector: null,
    expectedRowCount: null,
    expectedSourceContentHash: null,
    expectedSourceContractVersion: null,
    reportOut: null,
    runId: null,
  };
}

function applyOptions() {
  return {
    mode: "apply",
    environment: "TEST",
    expectedBucket: "test-bucket",
    expectedGitSha: GIT_SHA,
    expectedDay: "2026-08-21",
    expectedConnector: 1,
    expectedRowCount: 10,
    expectedSourceContentHash: SOURCE_HASH,
    expectedSourceContractVersion: 1,
    reportOut: "/tmp/not-used-by-unit-test.json",
    runId: "test-controlled-run",
  };
}

test("strict dry-run rejects a report path", () => {
  assert.throws(
    () => parseControlledPhaseBAcceptanceArgs([
      "--environment", "TEST",
      "--expected-bucket", "test-bucket",
      "--expected-git-sha", GIT_SHA,
      "--dry-run",
      "--report-out", "/tmp/report.json",
    ]),
    /strict dry-run does not write a local evidence file/,
  );
});

test("controlled config hard-limits one candidate and disables optional Dropbox comparison", () => {
  const controlled = buildControlledPhaseBConfig(basePhaseB());
  assert.equal(controlled.max_candidates_per_run, 1);
  assert.equal(controlled.phase_b_observation_snapshot_max_rows, 250000);
  assert.equal(controlled.phase_b_observation_snapshot_max_bytes, 268435456);
  assert.equal(controlled.prune_check_dropbox.enabled, false);
  assert.equal(controlled.prune_check_dropbox.required, false);
  assert.equal(controlled.staging_retention_days, 365000);
});

test("strict dry-run never invokes the Phase B writer", async () => {
  let writerCalled = false;
  const result = await executeControlledPhaseBAcceptance(dryRunOptions(), {
    env: baseEnv(),
    resolveConfig: () => basePhaseB(),
    discoverCandidate: async () => plan(),
    runPhaseB: async () => {
      writerCalled = true;
      throw new Error("writer must not run in dry-run");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.mutation_performed, false);
  assert.equal(writerCalled, false);
});

test("apply rejects a changed pinned candidate before invoking the writer", async () => {
  let writerCalled = false;
  const options = {
    ...applyOptions(),
    expectedRowCount: 11,
  };
  await assert.rejects(
    executeControlledPhaseBAcceptance(options, {
      env: baseEnv(),
      resolveConfig: () => basePhaseB(),
      discoverCandidate: async () => plan(),
      runPhaseB: async () => {
        writerCalled = true;
        return {};
      },
      lockContext: () => ({ valid: true }),
    }),
    /Controlled Phase B candidate changed: source_row_count/,
  );
  assert.equal(writerCalled, false);
});

test("apply uses one-candidate Phase B only and accepts retained source evidence", async () => {
  let observedPhaseB = null;
  const options = applyOptions();
  const result = await executeControlledPhaseBAcceptance(options, {
    env: baseEnv(),
    resolveConfig: () => basePhaseB(),
    discoverCandidate: async () => plan(),
    lockContext: () => ({ valid: true }),
    runPhaseB: async ({ phaseB, logStructured, runId }) => {
      observedPhaseB = phaseB;
      logStructured("INFO", "phase_b_history_candidate_complete", {
        run_id: runId,
        day_utc: "2026-08-21",
        connector_id: 1,
        expected_row_count: "10",
        written_row_count: "10",
        source_content_hash: SOURCE_HASH,
      });
      return {
        enabled: true,
        status: "completed",
        stopped_for_budget: false,
        processed_candidates: 1,
        completed_candidates: 1,
        failed_candidates: 0,
        failures: [],
        aggregate_day_failures: [],
        staging_cleanup: { deleted_count: 0 },
        prune_check_dropbox_exports: 0,
        prune_check_dropbox_failures: 0,
      };
    },
    postflight: async () => ({
      source_preservation: {
        source_row_count_after: "10",
        source_identity_after: plan().candidate.source_identity,
        source_deletion_committed: false,
      },
      connector_manifest: {
        final_pollutant_codes: ["no2"],
      },
    }),
  });

  assert.equal(observedPhaseB.max_candidates_per_run, 1);
  assert.equal(observedPhaseB.prune_check_dropbox.enabled, false);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "apply");
  assert.equal(result.execution_scope, "runPhaseBBackup_only_no_full_prune_job");
  assert.equal(result.rollback_data_preservation_mode, "retain_upstream_source");
  assert.equal(result.postflight.source_preservation.source_deletion_committed, false);
});

test("expected candidate comparison includes exact source-content identity", () => {
  const expected = {
    day_utc: "2026-08-21",
    connector_id: 1,
    source_row_count: "10",
    source_identity: {
      source_content_hash: "c".repeat(64),
      source_content_hash_contract_version: 1,
      source_content_hash_row_count: 10,
    },
  };
  assert.throws(
    () => assertControlledPlanMatchesExpected(plan(), expected),
    /source_content_hash/,
  );
});
