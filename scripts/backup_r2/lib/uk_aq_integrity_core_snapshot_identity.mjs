import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CORE_PREFIX = "history/v2/core";

function fail({ stage, reason, coordinatorIdentity, requestedIdentity, detail = null }) {
  throw new Error(`Integrity core snapshot identity validation failed: ${JSON.stringify({
    stage,
    reason,
    coordinator_identity: coordinatorIdentity || null,
    requested_identity: requestedIdentity || null,
    detail,
  })}`);
}

export function parseIntegrityCoreSnapshotIdentity(value, { stage, label }) {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) fail({ stage, reason: `${label}_identity_missing` });
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      fail({
        stage,
        reason: `${label}_identity_json_invalid`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail({ stage, reason: `${label}_identity_invalid`, requestedIdentity: parsed });
  }
  const day = String(parsed.core_snapshot_day_utc || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)
    || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    fail({ stage, reason: `${label}_day_invalid`, requestedIdentity: parsed });
  }
  const identity = {
    core_snapshot_day_utc: day,
    core_snapshot_manifest_key: String(parsed.core_snapshot_manifest_key || "").trim(),
    core_snapshot_manifest_hash: String(parsed.core_snapshot_manifest_hash || "").trim().toLowerCase(),
    core_snapshot_manifest_sha256: String(parsed.core_snapshot_manifest_sha256 || "").trim().toLowerCase(),
  };
  const expectedKey = `${CORE_PREFIX}/day_utc=${day}/manifest.json`;
  if (identity.core_snapshot_manifest_key !== expectedKey) {
    fail({
      stage,
      reason: `${label}_manifest_key_noncanonical`,
      requestedIdentity: identity,
      detail: { expected_key: expectedKey },
    });
  }
  for (const field of ["core_snapshot_manifest_hash", "core_snapshot_manifest_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(identity[field])) {
      fail({
        stage,
        reason: `${label}_${field}_invalid`,
        requestedIdentity: identity,
      });
    }
  }
  return identity;
}

export function validateIntegrityCoreSnapshotIdentity({
  env,
  runState,
  dropboxRoot,
  stage,
}) {
  const coordinator = parseIntegrityCoreSnapshotIdentity(
    String(env?.UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_JSON || ""),
    { stage, label: "coordinator" },
  );
  const identityFile = String(
    env?.UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_FILE || "",
  ).trim();
  if (!identityFile || !fs.existsSync(identityFile)) {
    fail({
      stage,
      reason: "coordinator_identity_file_unavailable",
      coordinatorIdentity: coordinator,
      detail: { identity_file: identityFile || null },
    });
  }
  let recorded;
  try {
    recorded = parseIntegrityCoreSnapshotIdentity(
      fs.readFileSync(identityFile, "utf8"),
      { stage, label: "recorded" },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Integrity core snapshot")) throw error;
    fail({
      stage,
      reason: "coordinator_identity_file_invalid",
      coordinatorIdentity: coordinator,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const requested = parseIntegrityCoreSnapshotIdentity(
    runState?.core_snapshot_identity,
    { stage, label: "child_requested" },
  );
  if (JSON.stringify(coordinator) !== JSON.stringify(recorded)
    || JSON.stringify(coordinator) !== JSON.stringify(requested)) {
    fail({
      stage,
      reason: "coordinator_child_identity_mismatch",
      coordinatorIdentity: coordinator,
      requestedIdentity: requested,
      detail: { recorded_identity: recorded },
    });
  }
  const coordinatorDropboxRoot = String(
    env?.UK_AQ_INTEGRITY_CORE_SNAPSHOT_DROPBOX_ROOT || "",
  ).trim();
  if (!dropboxRoot) {
    fail({ stage, reason: "dropbox_baseline_missing", coordinatorIdentity: coordinator });
  }
  if (!coordinatorDropboxRoot) {
    fail({
      stage,
      reason: "coordinator_dropbox_baseline_missing",
      coordinatorIdentity: coordinator,
    });
  }
  const root = path.resolve(String(dropboxRoot));
  const pinnedRoot = path.resolve(coordinatorDropboxRoot);
  if (root !== pinnedRoot) {
    fail({
      stage,
      reason: "coordinator_child_dropbox_baseline_mismatch",
      coordinatorIdentity: coordinator,
      requestedIdentity: requested,
      detail: { coordinator_dropbox_root: pinnedRoot, child_dropbox_root: root },
    });
  }
  const manifestPath = path.resolve(root, ...coordinator.core_snapshot_manifest_key.split("/"));
  if (manifestPath !== root && !manifestPath.startsWith(`${root}${path.sep}`)) {
    fail({
      stage,
      reason: "pinned_manifest_path_escaped_dropbox_baseline",
      coordinatorIdentity: coordinator,
      detail: { manifest_path: manifestPath, dropbox_root: root },
    });
  }
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    fail({
      stage,
      reason: "pinned_manifest_unavailable",
      coordinatorIdentity: coordinator,
      requestedIdentity: requested,
      detail: { manifest_path: manifestPath },
    });
  }
  const manifestBody = fs.readFileSync(manifestPath);
  const actualSha256 = crypto.createHash("sha256").update(manifestBody).digest("hex");
  if (actualSha256 !== coordinator.core_snapshot_manifest_sha256) {
    fail({
      stage,
      reason: "pinned_manifest_sha256_mismatch",
      coordinatorIdentity: coordinator,
      requestedIdentity: requested,
      detail: { expected: coordinator.core_snapshot_manifest_sha256, actual: actualSha256 },
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBody.toString("utf8"));
  } catch (error) {
    fail({
      stage,
      reason: "pinned_manifest_json_invalid",
      coordinatorIdentity: coordinator,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (manifest?.day_utc !== coordinator.core_snapshot_day_utc
    || String(manifest?.manifest_hash || "").trim().toLowerCase()
      !== coordinator.core_snapshot_manifest_hash) {
    fail({
      stage,
      reason: "pinned_manifest_identity_fields_mismatch",
      coordinatorIdentity: coordinator,
      requestedIdentity: requested,
      detail: {
        manifest_day_utc: manifest?.day_utc ?? null,
        manifest_hash: manifest?.manifest_hash ?? null,
      },
    });
  }
  return {
    status: "validated",
    stage,
    ...coordinator,
    coordinator_identity_match: true,
    manifest_source: "dropbox",
    manifest_path: manifestPath,
    identity_file: identityFile,
  };
}
