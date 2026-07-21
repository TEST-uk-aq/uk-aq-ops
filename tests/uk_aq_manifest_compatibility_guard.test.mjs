import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateLegacyObservationManifestCompatibilityInputs,
} from "../workers/uk_aq_backfill_local/r2_history/metadata_repair_guard.mjs";

const DAY = "2026-07-12";
const PREFIX = "history/v2/observations";

function fixture(parent, child = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-manifest-guard-"));
  const connectorPrefix = `${PREFIX}/day_utc=${DAY}/connector_id=7/`;
  const connectorPath = path.join(root, connectorPrefix, "manifest.json");
  fs.mkdirSync(path.dirname(connectorPath), { recursive: true });
  fs.writeFileSync(connectorPath, JSON.stringify(parent));
  if (child) {
    const childPath = path.join(root, child.key);
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.writeFileSync(childPath, JSON.stringify(child.payload));
  }
  return {
    env: { UK_AQ_R2_HISTORY_DROPBOX_ROOT: root },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function repairPlan() {
  return {
    history_version: "v2",
    domain: "observations",
    repair_plan: [{ day_utc: DAY }],
  };
}

function legacyParent(overrides = {}) {
  const connectorPrefix = `${PREFIX}/day_utc=${DAY}/connector_id=7/`;
  return {
    history_version: "v2",
    domain: "observations",
    manifest_kind: "connector",
    day_utc: DAY,
    connector_id: 7,
    current_prefix: connectorPrefix,
    pollutant_manifests: [{
      pollutant_code: "pm2.5",
      manifest_key: `${connectorPrefix}pollutant=pm2.5/manifest.json`,
    }],
    ...overrides,
  };
}

test("legacy connector current_prefix is accepted as path identity", () => {
  const value = fixture(legacyParent());
  try {
    assert.deepEqual(
      validateLegacyObservationManifestCompatibilityInputs({
        env: value.env,
        repairPlan: repairPlan(),
      }),
      { checked_connectors: 1, legacy_connectors: 1 },
    );
  } finally {
    value.cleanup();
  }
});

test("legacy connector identity mismatch blocks before preparation", () => {
  const value = fixture(legacyParent({ current_prefix: `${PREFIX}/day_utc=${DAY}/connector_id=8/` }));
  try {
    assert.throws(
      () => validateLegacyObservationManifestCompatibilityInputs({
        env: value.env,
        repairPlan: repairPlan(),
      }),
      /legacy connector identity mismatch/,
    );
  } finally {
    value.cleanup();
  }
});

test("legacy child path and declared pollutant alias must agree", () => {
  const parent = legacyParent({
    pollutant_manifests: [{
      pollutant_code: "pm10",
      manifest_key: `${PREFIX}/day_utc=${DAY}/connector_id=7/pollutant=pm2.5/manifest.json`,
    }],
  });
  const value = fixture(parent);
  try {
    assert.throws(
      () => validateLegacyObservationManifestCompatibilityInputs({
        env: value.env,
        repairPlan: repairPlan(),
      }),
      /invalid or mismatched legacy pollutant declaration/,
    );
  } finally {
    value.cleanup();
  }
});
