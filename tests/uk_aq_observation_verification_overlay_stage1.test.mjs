import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildObservationVerificationArtifact,
  buildObservationVerificationConnectorArtifact,
  buildObservationVerificationLatest,
  buildObservationVerificationRefreshInputs,
  encodeObservationVerificationJson,
  loadObservationVerificationAuthority,
  loadObservationVerificationDiscovery,
  observationVerificationConnectorManifestKey,
  verificationPeriodsFromRatifiedTo,
} from "../workers/shared/uk_aq_observation_verification_overlay.mjs";
import {
  computeVerificationSourceRootHash,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";

const encoder = new TextEncoder();

class MemoryCache {
  constructor() {
    this.responses = new Map();
  }

  async match(request) {
    return this.responses.get(request.url)?.clone() || null;
  }

  async put(request, response) {
    this.responses.set(request.url, response.clone());
  }
}

function memoryBucket(entries) {
  const objects = new Map(entries);
  const reads = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      const body = objects.get(key);
      if (!body) return null;
      return { arrayBuffer: async () => body.slice().buffer };
    },
  };
}

function manifestInput(ratifiedTo, acquisitionEvidence) {
  const model = verificationPeriodsFromRatifiedTo(ratifiedTo, {
    semanticSourceProvenance: { source_field: "ratified_to" },
  });
  return buildObservationVerificationRefreshInputs({
    connectorId: 1,
    semanticSourceIdentity: { service: "UK-AIR SOS", authority: "ratified_to" },
    acquisitionEvidence,
    timeseries: [{
      connector_id: 1,
      timeseries_id: 101,
      station_id: 201,
      pollutant_code: "pm25",
      ...model,
    }],
  });
}

async function latestArtifact(connectorArtifact) {
  const payload = buildObservationVerificationLatest({
    connectorManifests: [{
      connector_id: 1,
      key: connectorArtifact.key,
      byte_size: connectorArtifact.byte_size,
      sha256: connectorArtifact.sha256,
    }],
  });
  return buildObservationVerificationArtifact({
    key: "history/_index_v3/verification/latest.json",
    payload,
  });
}

test("connector manifests are content-addressed and acquisition evidence is non-semantic", async () => {
  const first = manifestInput("2026-01-31", {
    downloaded_at_utc: "2026-02-01T01:00:00.000Z",
    source_file_sha256: "a".repeat(64),
  });
  const refetch = manifestInput("2026-01-31", {
    downloaded_at_utc: "2026-02-02T01:00:00.000Z",
    source_file_sha256: "b".repeat(64),
  });
  const semanticChange = manifestInput("2026-02-01", {
    downloaded_at_utc: "2026-02-02T01:00:00.000Z",
    source_file_sha256: "b".repeat(64),
  });

  const firstArtifact = await buildObservationVerificationConnectorArtifact(first.canonical_manifest);
  const refetchArtifact = await buildObservationVerificationConnectorArtifact(refetch.canonical_manifest);
  const changedArtifact = await buildObservationVerificationConnectorArtifact(semanticChange.canonical_manifest);

  assert.equal(firstArtifact.sha256, refetchArtifact.sha256);
  assert.deepEqual(firstArtifact.body, refetchArtifact.body);
  assert.notEqual(firstArtifact.sha256, changedArtifact.sha256);
  assert.equal(
    firstArtifact.key,
    observationVerificationConnectorManifestKey(1, firstArtifact.sha256),
  );
  assert.match(firstArtifact.key, new RegExp(`${firstArtifact.sha256}\\.json$`));
  assert.notDeepEqual(first.acquisition_audit_evidence, refetch.acquisition_audit_evidence);
});

test("latest rejects connector identities whose immutable key and SHA disagree", async () => {
  const artifact = await buildObservationVerificationConnectorArtifact(
    manifestInput("2026-01-31", {}).canonical_manifest,
  );
  assert.throws(() => buildObservationVerificationLatest({
    connectorManifests: [{
      connector_id: 1,
      key: observationVerificationConnectorManifestKey(1, "f".repeat(64)),
      byte_size: artifact.byte_size,
      sha256: artifact.sha256,
    }],
  }), /not canonical for its connector and SHA-256/);
});

test("authority caches latest for at most 60 seconds and immutable manifests by identity", async () => {
  const connectorArtifact = await buildObservationVerificationConnectorArtifact(
    manifestInput("2026-01-31", {}).canonical_manifest,
  );
  const latest = await latestArtifact(connectorArtifact);
  const bucket = memoryBucket([
    [latest.key, latest.body],
    [connectorArtifact.key, connectorArtifact.body],
  ]);
  const cache = new MemoryCache();

  const first = await loadObservationVerificationAuthority({
    bucket, connectorId: 1, cache, nowMs: 1_000,
  });
  assert.equal(first.overlay_authoritative, true);
  assert.deepEqual(bucket.reads, [latest.key, connectorArtifact.key]);

  const second = await loadObservationVerificationAuthority({
    bucket, connectorId: 1, cache, nowMs: 60_999,
  });
  assert.equal(second.discovery_cache_status, "hit");
  assert.equal(second.manifest_cache_status, "hit");
  assert.deepEqual(bucket.reads, [latest.key, connectorArtifact.key]);

  await loadObservationVerificationDiscovery({ bucket, cache, nowMs: 61_001 });
  assert.deepEqual(bucket.reads, [latest.key, connectorArtifact.key, latest.key]);
});

test("an unreferenced staged manifest is not authority and backup roots ignore orphans", async () => {
  const oldManifest = await buildObservationVerificationConnectorArtifact(
    manifestInput("2026-01-31", {}).canonical_manifest,
  );
  const stagedManifest = await buildObservationVerificationConnectorArtifact(
    manifestInput("2026-02-01", {}).canonical_manifest,
  );
  const latest = await latestArtifact(oldManifest);
  const bucket = memoryBucket([
    [latest.key, latest.body],
    [oldManifest.key, oldManifest.body],
    [stagedManifest.key, stagedManifest.body],
  ]);
  const authority = await loadObservationVerificationAuthority({ bucket, connectorId: 1 });
  assert.equal(authority.manifest_identity.sha256, oldManifest.sha256);
  assert.equal(bucket.reads.includes(stagedManifest.key), false);

  const latestIdentity = {
    relative_path: latest.key,
    sha256: latest.sha256,
    byte_size: latest.byte_size,
  };
  const connectorIdentities = [{
    connector_id: 1,
    relative_path: oldManifest.key,
    sha256: oldManifest.sha256,
    byte_size: oldManifest.byte_size,
  }];
  const currentRoot = computeVerificationSourceRootHash({
    latest: latestIdentity,
    connectorManifests: connectorIdentities,
  });
  assert.notEqual(currentRoot, computeVerificationSourceRootHash({
    latest: latestIdentity,
    connectorManifests: [...connectorIdentities, {
      connector_id: 1,
      relative_path: stagedManifest.key,
      sha256: stagedManifest.sha256,
      byte_size: stagedManifest.byte_size,
    }],
  }));
  assert.equal(
    encodeObservationVerificationJson(authority.manifest),
    new TextDecoder().decode(oldManifest.body),
  );
});

test("authority rejects manifest bytes that do not match latest", async () => {
  const connectorArtifact = await buildObservationVerificationConnectorArtifact(
    manifestInput("2026-01-31", {}).canonical_manifest,
  );
  const latest = await latestArtifact(connectorArtifact);
  const corrupt = encoder.encode("{}\n");
  const bucket = memoryBucket([
    [latest.key, latest.body],
    [connectorArtifact.key, corrupt],
  ]);
  await assert.rejects(
    loadObservationVerificationAuthority({ bucket, connectorId: 1 }),
    /identity mismatch/,
  );
});

test("backup, restore and local materialisation retain immutable latest-guided ordering", () => {
  const sync = readFileSync("scripts/backup_r2/sync_history_to_dropbox.mjs", "utf8");
  const restore = readFileSync("scripts/backup_r2/restore_history_from_dropbox.mjs", "utf8");
  const local = readFileSync("scripts/backup_r2/verify_local_backup_materialisation.mjs", "utf8");
  const syncConnector = sync.indexOf("for (const expected of inventory.connector_manifests)");
  const syncLatest = sync.indexOf("relativePath: inventory.latest.relative_path", syncConnector);
  assert.ok(syncConnector >= 0 && syncLatest > syncConnector);
  const restoreConnector = restore.indexOf("for (const identity of latest.connectors)");
  const restoreLatest = restore.indexOf("copyFile(args.rclone_bin, sourceLatestPath, destLatestPath", restoreConnector);
  assert.ok(restoreConnector >= 0 && restoreLatest > restoreConnector);
  assert.match(restore, /latest_restored_last: true/);
  assert.match(local, /const latest = validateObservationVerificationLatest/);
  assert.match(local, /const object = readJson\(root, expected\.key\)/);
});

test("active observation writer remains schema 3 and content-hash contract 1", () => {
  const writer = readFileSync("workers/shared/uk_aq_observation_history_target_writer.mjs", "utf8");
  const contentHash = readFileSync("workers/shared/uk_aq_observation_content_hash.mjs", "utf8");
  assert.match(writer, /OBSERVATION_HISTORY_SCHEMA_VERSION_V3/);
  assert.doesNotMatch(writer, /history_schema_version:\s*OBSERVATION_HISTORY_SCHEMA_VERSION_V4/);
  assert.match(contentHash, /OBSERVATION_CONTENT_HASH_CONTRACT_VERSION = 1/);
});
