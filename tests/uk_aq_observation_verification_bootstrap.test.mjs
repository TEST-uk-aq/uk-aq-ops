import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapObservationVerificationIntegrityV3,
  ensureObservationVerificationRuntimeDirectories,
  parseIntegrityEnvAssignments,
} from "../scripts/backup_r2/lib/observation_verification_bootstrap.mjs";

function fixture(environment = "TEST") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-verification-bootstrap-")));
  const repositoryRoot = path.join(root, "repo");
  const pythonPath = path.join(repositoryRoot, ".venv/bin/python");
  const dropboxAppRoot = path.join(root, "Dropbox App");
  const dropboxRoot = path.join(dropboxAppRoot, environment);
  const r2Root = path.join(dropboxRoot, "R2_history_backup");
  const localRoot = path.join(root, "local-integrity");
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(pythonPath, 0o755);
  fs.mkdirSync(r2Root, { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, ".env"), [
    `export UKAQ_ENV_NAME=${environment}`,
    `UK_AQ_DROPBOX_APP_ROOT="${dropboxAppRoot}"`,
    `UK_AQ_DROPBOX_ROOT='${environment}'`,
    "UK_AQ_R2_HISTORY_DROPBOX_DIR=R2_history_backup # accepted trailing comment",
    "UNEXECUTED_VALUE=$(touch should-never-run)",
    "",
  ].join("\n"), "utf8");
  return { root, repositoryRoot, pythonPath, dropboxRoot, r2Root, localRoot };
}

test("safe env parsing follows the fixed-v3 runner assignment semantics without evaluation", () => {
  assert.deepEqual(parseIntegrityEnvAssignments([
    "# comment",
    "export UKAQ_ENV_NAME=TEST",
    "QUOTED='value # retained' # removed",
    "PLAIN=value # removed",
    "SHELL=$(touch must-not-run)",
    "INVALID-NAME=ignored",
  ].join("\n")), {
    UKAQ_ENV_NAME: "TEST",
    QUOTED: "value # retained",
    PLAIN: "value",
    SHELL: "$(touch must-not-run)",
  });
});

test("fixed-v3 bootstrap derives ordinary TEST runtime paths without a state export", (context) => {
  const current = fixture();
  context.after(() => fs.rmSync(current.root, { recursive: true, force: true }));
  const env = {
    UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT: current.localRoot,
    UK_AQ_R2_HISTORY_VERSION: "v2",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v2",
    UK_AQ_R2_HISTORY_INTEGRITY_VERSION: "v2",
  };
  const bootstrap = bootstrapObservationVerificationIntegrityV3({
    environment: "TEST",
    repositoryRoot: current.repositoryRoot,
    env,
  });
  ensureObservationVerificationRuntimeDirectories(bootstrap);

  const expectedState = path.join(current.localRoot, "state/TEST");
  assert.equal(bootstrap.stateDir, expectedState);
  assert.equal(env.UK_AQ_ENV_NAME, "TEST");
  assert.equal(env.UK_AQ_OPS_REPO_ROOT, current.repositoryRoot);
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_STATE_DIR, expectedState);
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_DB_PATH, path.join(expectedState, "uk_aq_history_integrity.sqlite"));
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR, path.join(expectedState, "source-cache"));
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_TMP_DIR, path.join(expectedState, "tmp"));
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_LOCK_DIR, path.join(expectedState, "locks"));
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_PYTHON, current.pythonPath);
  assert.equal(env.UK_AQ_R2_HISTORY_VERSION, "v3");
  assert.equal(env.UK_AQ_R2_HISTORY_INDEX_VERSION, "v3");
  assert.equal(env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION, "v3");
  assert.equal(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT, current.r2Root);
  assert.equal(env.UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT, path.join(current.r2Root, "history/v3/core"));
  assert.equal(env.UNEXECUTED_VALUE, "$(touch should-never-run)");
  assert.ok(bootstrap.runtimeDirectories.every((directory) => fs.statSync(directory).isDirectory()));
  assert.equal(fs.existsSync(path.join(current.repositoryRoot, "should-never-run")), false);
});

test("bootstrap rejects environment mismatch and keeps --state-dir as an explicit override", (context) => {
  const mismatch = fixture("LIVE");
  const current = fixture("TEST");
  context.after(() => {
    fs.rmSync(mismatch.root, { recursive: true, force: true });
    fs.rmSync(current.root, { recursive: true, force: true });
  });
  assert.throws(() => bootstrapObservationVerificationIntegrityV3({
    environment: "TEST",
    repositoryRoot: mismatch.repositoryRoot,
    env: { UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT: mismatch.localRoot },
  }), /UKAQ_ENV_NAME.*does not match --env=TEST/);

  const stateOverride = path.join(current.root, "debug-state");
  const env = { UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT: current.localRoot };
  const bootstrap = bootstrapObservationVerificationIntegrityV3({
    environment: "TEST",
    repositoryRoot: current.repositoryRoot,
    stateDirOverride: stateOverride,
    env,
  });
  assert.equal(bootstrap.stateDir, stateOverride);
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_STATE_DIR, stateOverride);
  assert.equal(env.UK_AQ_HISTORY_INTEGRITY_DB_PATH, path.join(stateOverride, "uk_aq_history_integrity.sqlite"));
});
