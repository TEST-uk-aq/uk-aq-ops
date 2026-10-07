import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMetadataPlanningProgressTracker,
  createCombinedLocalStore,
  createStagedObjectMap,
  localDependencySnapshot,
  proposalGraphAudit,
  proposalView,
  readChildren,
  validateFinalPlannerProposalGraph,
} from "../uk_aq_execute_v2_observations_repair.mjs";
import {
  runV2ObservationsRepair as runGenerationNeutralObservationMetadataRepair,
} from "../uk_aq_execute_v2_observations_repair_impl.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
} from "../../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

function localStore(objects) {
  return {
    getObjectIfExists: (key) => objects.get(key) || null,
    listAllObjects: ({ prefix }) => [...objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .map((object) => ({
        key: object.key,
        size: object.bytes,
        source: object.source,
        content_sha256: object.content_sha256,
        r2_etag: null,
      })),
  };
}

function localObject(key, body, source = "dropbox") {
  const buffer = Buffer.from(body);
  return {
    key,
    body: buffer,
    bytes: buffer.byteLength,
    source,
    content_sha256: sha256Hex(buffer),
  };
}

test("all-empty authoritative repair rebuilds zero-child connector and day parents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-all-empty-parents-"));
  try {
    const dayUtc = "2026-09-28";
    const connectorId = 9;
    const dataPrefix = "history/v3/observations";
    const dayPrefix = `${dataPrefix}/day_utc=${dayUtc}`;
    const dropboxRoot = path.join(root, "dropbox");
    const overlayRoot = path.join(root, "overlay");
    fs.mkdirSync(overlayRoot, { recursive: true });
    const pollutantManifests = ["no2", "pm10"].map((pollutantCode, index) => {
      const manifestKey = `${dayPrefix}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
      const partKey = manifestKey.replace("manifest.json", "part-00000.parquet");
      const { canonical_rows: _canonicalRows, ...observationContentHash } =
        computeObservationContentHash([{
          connector_id: connectorId,
          station_id: 101 + index,
          timeseries_id: 1001 + index,
          pollutant_code: pollutantCode,
          observed_at_utc: `${dayUtc}T01:00:00.000Z`,
          value: 10 + index,
          verification_status: "P",
        }]);
      return buildHistoryV2PollutantManifest({
        domain: "observations",
        dayUtc,
        connectorId,
        pollutantCode,
        manifestKey,
        sourceRowCount: 1,
        fileEntries: [{
          key: partKey,
          row_count: 1,
          bytes: 10,
          etag_or_hash: "a".repeat(64),
          min_timeseries_id: 1001 + index,
          max_timeseries_id: 1001 + index,
          min_observed_at_utc: `${dayUtc}T01:00:00.000Z`,
          max_observed_at_utc: `${dayUtc}T01:00:00.000Z`,
          timeseries_row_counts: { [String(1001 + index)]: 1 },
        }],
        writerGitSha: "b".repeat(40),
        backedUpAtUtc: `${dayUtc}T02:00:00.000Z`,
        observationContentHash,
      });
    });
    const connectorKey = `${dayPrefix}/connector_id=${connectorId}/manifest.json`;
    const connectorManifest = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      manifestKey: connectorKey,
      pollutantManifests,
      writerGitSha: "b".repeat(40),
      backedUpAtUtc: `${dayUtc}T02:00:00.000Z`,
    });
    const dayKey = `${dayPrefix}/manifest.json`;
    const dayManifest = buildHistoryV2DayManifest({
      domain: "observations",
      dayUtc,
      manifestKey: dayKey,
      connectorManifests: [connectorManifest],
      writerGitSha: "b".repeat(40),
      backedUpAtUtc: `${dayUtc}T02:00:00.000Z`,
    });
    for (const payload of [...pollutantManifests, connectorManifest, dayManifest]) {
      const filePath = path.join(dropboxRoot, ...payload.manifest_key.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    }
    const runStatePath = path.join(root, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify({
      objects: {},
      tombstones: {},
      tombstone_prefixes: ["no2", "pm10"].map((pollutantCode) => ({
        prefix: `${dayPrefix}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`,
        proposed: true,
      })),
    }));
    const baseAction = {
      status: "planned",
      executes: false,
      data_changes_required: false,
      operator_action_required: false,
      history_version: "v2",
      domain: "observations",
      day_utc: dayUtc,
      requires_index_rebuild: true,
      gap_types: ["observation_repaired"],
    };
    const repairPlan = {
      history_version: "v2",
      domain: "observations",
      repair_plan: [
        ...["no2", "pm10"].map((pollutantCode) => ({
          ...baseAction,
          kind: "observation_index_repair",
          connector_id: connectorId,
          pollutant_code: pollutantCode,
        })),
        {
          ...baseAction,
          kind: "observation_connector_manifest_repair",
          connector_id: connectorId,
        },
        { ...baseAction, kind: "observation_day_manifest_repair" },
      ],
    };
    const output = await runGenerationNeutralObservationMetadataRepair({
      repairPlan,
      storageGeneration: "v3",
      planIndexes: false,
      env: {
        UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT: overlayRoot,
        UK_AQ_R2_HISTORY_DROPBOX_ROOT: dropboxRoot,
        UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON: runStatePath,
        CFLARE_R2_ENDPOINT: "https://example.invalid",
        CFLARE_R2_BUCKET: "test-fixture",
        CFLARE_R2_ACCESS_KEY_ID: "test-fixture",
        CFLARE_R2_SECRET_ACCESS_KEY: "test-fixture",
      },
    });
    assert.equal(output.status, "planned");
    const proposals = new Map(output.planning.proposals.map((item) => [item.key, item]));
    const rebuiltConnector = JSON.parse(proposals.get(connectorKey).proposed_body);
    const rebuiltDay = JSON.parse(proposals.get(dayKey).proposed_body);
    assert.deepEqual(rebuiltConnector.pollutant_manifests, []);
    assert.deepEqual(rebuiltConnector.child_manifests, []);
    assert.equal(rebuiltConnector.source_row_count, 0);
    assert.deepEqual(
      rebuiltDay.connector_manifests.map((item) => item.manifest_key),
      [connectorKey],
    );
    assert.equal(
      [...proposals.keys()].some((key) => key.includes("/pollutant_code=")),
      false,
    );
    const incompleteAuthorityPlan = structuredClone(repairPlan);
    incompleteAuthorityPlan.repair_plan = incompleteAuthorityPlan.repair_plan.filter(
      (action) => action.pollutant_code !== "pm10",
    );
    await assert.rejects(
      runGenerationNeutralObservationMetadataRepair({
        repairPlan: incompleteAuthorityPlan,
        storageGeneration: "v3",
        planIndexes: false,
        env: {
          UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT: overlayRoot,
          UK_AQ_R2_HISTORY_DROPBOX_ROOT: dropboxRoot,
          UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON: runStatePath,
          CFLARE_R2_ENDPOINT: "https://example.invalid",
          CFLARE_R2_BUCKET: "test-fixture",
          CFLARE_R2_ACCESS_KEY_ID: "test-fixture",
          CFLARE_R2_SECRET_ACCESS_KEY: "test-fixture",
        },
      }),
      /Connector manifest has children hidden by the proposed final state/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function preservationParentAction(kind, dayUtc, connectorId = null) {
  return {
    kind,
    day_utc: dayUtc,
    ...(connectorId === null ? {} : { connector_id: connectorId }),
    status: "planned",
    executes: false,
    data_changes_required: false,
    operator_action_required: false,
    history_version: "v2",
    domain: "observations",
    requires_index_rebuild: false,
    gap_types: ["source_artifact_unavailable_preserved"],
  };
}

function preservationPollutantManifest({ dayUtc, connectorId, pollutantCode, timeseriesId }) {
  const manifestKey = `history/v3/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
  const partKey = manifestKey.replace("manifest.json", "part-00000.parquet");
  const { canonical_rows: _canonicalRows, ...observationContentHash } =
    computeObservationContentHash([{
      connector_id: connectorId,
      station_id: timeseriesId,
      timeseries_id: timeseriesId,
      pollutant_code: pollutantCode,
      observed_at_utc: `${dayUtc}T01:00:00.000Z`,
      value: 10,
      verification_status: "P",
    }]);
  return buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    pollutantCode,
    manifestKey,
    sourceRowCount: 1,
    fileEntries: [{
      key: partKey,
      row_count: 1,
      bytes: 10,
      etag_or_hash: "a".repeat(64),
      min_timeseries_id: timeseriesId,
      max_timeseries_id: timeseriesId,
      min_observed_at_utc: `${dayUtc}T01:00:00.000Z`,
      max_observed_at_utc: `${dayUtc}T01:00:00.000Z`,
      timeseries_row_counts: { [String(timeseriesId)]: 1 },
    }],
    writerGitSha: "b".repeat(40),
    backedUpAtUtc: `${dayUtc}T02:00:00.000Z`,
    observationContentHash,
  });
}

function writeLocalManifest(root, payload) {
  const filePath = path.join(root, ...payload.manifest_key.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  fs.writeFileSync(filePath, body);
  return { filePath, body };
}

function preservationPlannerEnvironment({ overlayRoot, dropboxRoot, runStatePath }) {
  return {
    UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT: overlayRoot,
    UK_AQ_R2_HISTORY_DROPBOX_ROOT: dropboxRoot,
    UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON: runStatePath,
    CFLARE_R2_ENDPOINT: "https://example.invalid",
    CFLARE_R2_BUCKET: "test-fixture",
    CFLARE_R2_ACCESS_KEY_ID: "test-fixture",
    CFLARE_R2_SECRET_ACCESS_KEY: "test-fixture",
  };
}

test("preservation-only parent actions stage connector and day without leaf or index work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-preservation-only-"));
  try {
    const dayUtc = "2026-09-28";
    const connectorId = 9;
    const dropboxRoot = path.join(root, "dropbox");
    const overlayRoot = path.join(root, "overlay");
    fs.mkdirSync(overlayRoot, { recursive: true });
    const pollutant = preservationPollutantManifest({
      dayUtc, connectorId, pollutantCode: "pm10", timeseriesId: 1001,
    });
    const { body: pollutantBody } = writeLocalManifest(dropboxRoot, pollutant);
    const runStatePath = path.join(root, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify({
      objects: {}, tombstones: {}, tombstone_prefixes: [],
    }));
    const output = await runGenerationNeutralObservationMetadataRepair({
      repairPlan: {
        history_version: "v2",
        domain: "observations",
        repair_plan: [
          preservationParentAction(
            "observation_connector_manifest_repair", dayUtc, connectorId,
          ),
          preservationParentAction("observation_day_manifest_repair", dayUtc),
        ],
      },
      storageGeneration: "v3",
      planIndexes: false,
      env: preservationPlannerEnvironment({ overlayRoot, dropboxRoot, runStatePath }),
    });
    assert.equal(output.status, "planned");
    const proposals = new Map(output.planning.proposals.map((item) => [item.key, item]));
    const dayPrefix = `history/v3/observations/day_utc=${dayUtc}`;
    const pollutantKey = pollutant.manifest_key;
    const connectorKey = `${dayPrefix}/connector_id=${connectorId}/manifest.json`;
    const dayKey = `${dayPrefix}/manifest.json`;
    assert.deepEqual([...proposals.keys()].sort(), [connectorKey, dayKey].sort());
    assert.equal(proposals.get(connectorKey).changed, true);
    assert.equal(proposals.get(dayKey).changed, true);
    assert.deepEqual(proposals.get(connectorKey).dependency_identities[pollutantKey], {
      source: "dropbox",
      sha256: sha256Hex(pollutantBody),
      bytes: pollutantBody.byteLength,
    });
    assert.deepEqual(proposals.get(dayKey).dependency_identities[connectorKey], {
      source: "planned_overlay",
      sha256: proposals.get(connectorKey).new_sha256,
      bytes: proposals.get(connectorKey).bytes,
    });
    assert.equal(
      [...proposals.keys()].some((key) => key.startsWith(
        pollutantKey.replace(/\/manifest\.json$/, "/"),
      )),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preservation parents compose with a repaired sibling and another connector", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-preservation-mixed-"));
  try {
    const dayUtc = "2026-09-28";
    const dropboxRoot = path.join(root, "dropbox");
    const overlayRoot = path.join(root, "overlay");
    fs.mkdirSync(overlayRoot, { recursive: true });
    const preservedNo2 = preservationPollutantManifest({
      dayUtc, connectorId: 9, pollutantCode: "no2", timeseriesId: 1001,
    });
    const repairedPm10 = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
      rows: [{
        connector_id: 9,
        station_id: 1002,
        timeseries_id: 1002,
        pollutant_code: "pm10",
        observed_at_utc: `${dayUtc}T01:00:00.000Z`,
        value: 12,
        verification_status: "P",
      }],
      scope: { day_utc: dayUtc, connector_id: 9, pollutant_code: "pm10" },
      targetWriterGitSha: "b".repeat(40),
      backedUpAtUtc: `${dayUtc}T02:00:00.000Z`,
    });
    const preservedO3 = preservationPollutantManifest({
      dayUtc, connectorId: 10, pollutantCode: "o3", timeseriesId: 1003,
    });
    const { body: no2Body } = writeLocalManifest(dropboxRoot, preservedNo2);
    const { body: o3Body } = writeLocalManifest(dropboxRoot, preservedO3);
    const changedObjects = {};
    for (const artifact of [
      ...repairedPm10.file_intents.map((intent) => ({
        key: intent.key,
        body: Buffer.from(intent.body),
      })),
      {
        key: repairedPm10.canonical_pollutant_manifest.key,
        body: Buffer.from(repairedPm10.canonical_pollutant_manifest.body),
      },
    ]) {
      const localPath = path.join(overlayRoot, ...artifact.key.split("/"));
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, artifact.body);
      changedObjects[artifact.key] = {
        object_key: artifact.key,
        local_path: localPath,
        sha256: sha256Hex(artifact.body),
        bytes: artifact.body.byteLength,
        stage: "observations_data",
        proposed: true,
        built: true,
        structurally_validated: true,
        changed: true,
        included_in_write_set: true,
        status: "planned",
      };
    }
    const repairedPm10Key = repairedPm10.canonical_pollutant_manifest.key;
    const pm10Body = Buffer.from(repairedPm10.canonical_pollutant_manifest.body);
    const runStatePath = path.join(root, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify({
      objects: changedObjects,
      tombstones: {},
      tombstone_prefixes: [],
    }));
    const output = await runGenerationNeutralObservationMetadataRepair({
      repairPlan: {
        history_version: "v2",
        domain: "observations",
        repair_plan: [
          {
            ...preservationParentAction(
              "observation_pollutant_manifest_repair", dayUtc, 9,
            ),
            pollutant_code: "pm10",
            gap_types: ["observation_repaired"],
          },
          preservationParentAction(
            "observation_connector_manifest_repair", dayUtc, 9,
          ),
          preservationParentAction(
            "observation_connector_manifest_repair", dayUtc, 10,
          ),
          preservationParentAction("observation_day_manifest_repair", dayUtc),
        ],
      },
      storageGeneration: "v3",
      planIndexes: false,
      env: preservationPlannerEnvironment({ overlayRoot, dropboxRoot, runStatePath }),
    });
    assert.equal(output.status, "planned");
    const proposals = new Map(output.planning.proposals.map((item) => [item.key, item]));
    const dayPrefix = `history/v3/observations/day_utc=${dayUtc}`;
    const connector9Key = `${dayPrefix}/connector_id=9/manifest.json`;
    const connector10Key = `${dayPrefix}/connector_id=10/manifest.json`;
    const dayKey = `${dayPrefix}/manifest.json`;
    assert.deepEqual(proposals.get(connector9Key).dependency_identities, {
      [preservedNo2.manifest_key]: {
        source: "dropbox", sha256: sha256Hex(no2Body), bytes: no2Body.byteLength,
      },
      [repairedPm10Key]: {
        source: "planned_overlay", sha256: sha256Hex(pm10Body), bytes: pm10Body.byteLength,
      },
    });
    assert.deepEqual(proposals.get(connector10Key).dependency_identities, {
      [preservedO3.manifest_key]: {
        source: "dropbox", sha256: sha256Hex(o3Body), bytes: o3Body.byteLength,
      },
    });
    assert.deepEqual(proposals.get(dayKey).dependencies.sort(), [
      connector10Key, connector9Key,
    ].sort());
    for (const connectorKey of [connector9Key, connector10Key]) {
      assert.deepEqual(proposals.get(dayKey).dependency_identities[connectorKey], {
        source: "planned_overlay",
        sha256: proposals.get(connectorKey).new_sha256,
        bytes: proposals.get(connectorKey).bytes,
      });
    }
    assert.equal(
      [...proposals.keys()].filter((key) => key === dayKey).length,
      1,
    );
    assert.equal(
      [...proposals.keys()].some((key) => key.startsWith(
        preservedNo2.manifest_key.replace(/\/manifest\.json$/, "/"),
      )),
      false,
    );
    assert.equal(
      [...proposals.keys()].some((key) => key.startsWith(
        preservedO3.manifest_key.replace(/\/manifest\.json$/, "/"),
      )),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata planning progress reports by count, time, and final completion", () => {
  const events = [];
  let nowMs = 0;
  const tracker = createMetadataPlanningProgressTracker({
    totalObjects: 60,
    reportProgress: (event) => events.push(event),
    now: () => nowMs,
  });

  tracker.update(24, { blocked_count: 1 });
  tracker.update(25, { blocked_count: 1 });
  nowMs = 15_000;
  tracker.update(26, { blocked_count: 2 });
  tracker.update(50, { blocked_count: 2 });
  tracker.finish(60, { blocked_count: 3 });

  assert.deepEqual(events, [
    {
      phase: "metadata_planning_progress",
      completed_objects: 25,
      total_objects: 60,
      blocked_count: 1,
    },
    {
      phase: "metadata_planning_progress",
      completed_objects: 26,
      total_objects: 60,
      blocked_count: 2,
    },
    {
      phase: "metadata_planning_progress",
      completed_objects: 60,
      total_objects: 60,
      blocked_count: 3,
    },
  ]);
});

test("combined local store classifies current-run objects independently of their overlay path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-planner-provenance-"));
  try {
    const overlayRoot = path.join(root, "overlay");
    const dropboxRoot = path.join(root, "dropbox");
    const key = "history/v2/observations/day_utc=2026-07-30/connector_id=1/pollutant_code=no2/part-00000.parquet";
    const externalKey = "history/v2/observations/day_utc=2026-07-30/connector_id=2/pollutant_code=no2/part-00000.parquet";
    const localPath = path.join(overlayRoot, ...key.split("/"));
    const externalPath = path.join(overlayRoot, ...externalKey.split("/"));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, "current-run-part");
    fs.mkdirSync(path.dirname(externalPath), { recursive: true });
    fs.writeFileSync(externalPath, "immutable-overlay-part");
    const body = fs.readFileSync(localPath);
    const externalBody = fs.readFileSync(externalPath);
    const runStatePath = path.join(root, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify({
      objects: {
        [key]: {
          local_path: localPath,
          proposed: true,
          built: true,
          structurally_validated: true,
          bytes: body.byteLength,
          sha256: sha256Hex(body),
          stage: "observations_data",
        },
        [externalKey]: {
          local_path: externalPath,
          proposed: false,
          changed: false,
          included_in_write_set: false,
          status: "skipped_unchanged",
          structurally_validated: true,
          bytes: externalBody.byteLength,
          sha256: sha256Hex(externalBody),
        },
      },
      tombstones: {},
      tombstone_prefixes: [],
    }));
    fs.mkdirSync(dropboxRoot, { recursive: true });
    const store = createCombinedLocalStore({
      overlayRoot,
      dropboxRoot,
      runStateJson: runStatePath,
      prefixes: ["history/v2/observations/day_utc=2026-07-30"],
    });
    const resolved = store.getObject(key);
    assert.equal(resolved.source, "planned_overlay");
    assert.equal(resolved.content_sha256, sha256Hex(body));
    assert.equal(resolved.bytes, body.byteLength);
    const external = store.getObject(externalKey);
    assert.equal(external.source, "overlay");
    assert.equal(external.content_sha256, sha256Hex(externalBody));
    assert.equal(external.bytes, externalBody.byteLength);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("combined local store filters manifest listings before reading object bodies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-manifest-only-listing-"));
  try {
    const overlayRoot = path.join(root, "overlay");
    const dropboxRoot = path.join(root, "dropbox");
    const prefix = "history/v3/observations/day_utc=2026-07-30/connector_id=1/pollutant_code=no2";
    const manifestKey = `${prefix}/manifest.json`;
    const parquetKey = `${prefix}/part-00000.parquet`;
    for (const [key, body] of [[manifestKey, "{}"], [parquetKey, "historical-parquet"]]) {
      const filePath = path.join(dropboxRoot, ...key.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }
    const runStatePath = path.join(root, "run-state.json");
    fs.mkdirSync(overlayRoot, { recursive: true });
    fs.writeFileSync(runStatePath, JSON.stringify({
      objects: {}, tombstones: {}, tombstone_prefixes: [],
    }));
    const store = createCombinedLocalStore({
      overlayRoot,
      dropboxRoot,
      runStateJson: runStatePath,
      prefixes: [prefix],
    });
    fs.unlinkSync(path.join(dropboxRoot, ...parquetKey.split("/")));
    const keyFilter = (key) => key.endsWith("/manifest.json");
    assert.deepEqual(
      store.listAllObjects({ prefix, keyFilter }).map(({ key }) => key),
      [manifestKey],
    );
    assert.deepEqual(
      store.listObjectsFromSource({ prefix, source: "dropbox", keyFilter })
        .map(({ key }) => key),
      [manifestKey],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final planner validation rejects staged overlay provenance before Python", () => {
  const childKey = "history/v2/observations/day_utc=2026-07-30/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const parentKey = childKey.replace("part-00000.parquet", "manifest.json");
  const childSha256 = "a".repeat(64);
  const output = {
    planning: {
      proposals: [{
        key: parentKey,
        changed: true,
        bytes: 100,
        new_sha256: "b".repeat(64),
        dependencies: [childKey],
        dependency_identities: {
          [childKey]: { source: "overlay", sha256: childSha256, bytes: 25 },
        },
        proposal_owner: "source_derived_observation_repair",
        proposal_provenance: "current_run_source_derived_staged_parquet",
      }],
      compatibility_preparation: {
        collisions: [{ key: parentKey, collision_decision: "source_derived_owner_won" }],
      },
    },
  };
  const runState = {
    objects: {
      [childKey]: {
        proposed: true,
        structurally_validated: true,
        sha256: childSha256,
        bytes: 25,
      },
    },
  };
  assert.throws(
    () => validateFinalPlannerProposalGraph(structuredClone(output), { runState }),
    /JavaScript final planner proposal validation failed:.*staged_dependency_identity_mismatch.*"actual_source":"overlay".*"expected_source":"planned_overlay".*source_derived_owner_won/,
  );
  output.planning.proposals[0].dependency_identities[childKey].source = "planned_overlay";
  const audit = validateFinalPlannerProposalGraph(output, { runState });
  assert.equal(audit.status, "succeeded");
  assert.equal(audit.staged_dependency_edge_count, 1);
  delete runState.objects[childKey];
  assert.throws(
    () => validateFinalPlannerProposalGraph(structuredClone(output), { runState }),
    /planned_overlay_dependency_missing_from_changed_write_set/,
  );
});

test("mixed changed and unchanged index proposals retain exact staged and baseline provenance", async () => {
  const prefix = "history/_index_v2/observations_timeseries/";
  const changedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=pm25/manifest.json`;
  const unchangedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json`;
  const latestKey = "history/_index_v2/observations_timeseries_latest.json";
  const changedBaseline = localObject(changedKey, JSON.stringify({ version: "old" }));
  const unchangedBaseline = localObject(unchangedKey, JSON.stringify({ version: "same" }));
  const latestBaseline = localObject(latestKey, JSON.stringify({ version: "old-latest" }));
  const store = localStore(new Map([
    [changedKey, changedBaseline],
    [unchangedKey, unchangedBaseline],
    [latestKey, latestBaseline],
  ]));
  const staged = createStagedObjectMap({ r2: {}, store });
  const changed = await staged.stage({
    key: changedKey,
    body: JSON.stringify({ version: "new" }),
    kind: "pollutant_timeseries_index",
  });
  const unchanged = await staged.stage({
    key: unchangedKey,
    body: unchangedBaseline.body,
    kind: "pollutant_timeseries_index",
  });
  const latest = await staged.stage({
    key: latestKey,
    body: JSON.stringify({ version: "new-latest" }),
    kind: "latest_timeseries_index",
    dependencies: [changedKey, unchangedKey],
  });

  assert.equal(changed.changed, true);
  assert.equal(unchanged.changed, false);
  assert.equal(latest.changed, true);
  assert.deepEqual(latest.dependency_identities[changedKey], {
    source: "planned_overlay",
    sha256: changed.new_sha256,
    bytes: changed.bytes,
  });
  assert.deepEqual(latest.dependency_identities[unchangedKey], {
    source: "dropbox",
    sha256: unchangedBaseline.content_sha256,
    bytes: unchangedBaseline.bytes,
  });

  const changedGet = await staged.stagedR2.adapter.getObject({ key: changedKey });
  const unchangedGet = await staged.stagedR2.adapter.getObject({ key: unchangedKey });
  assert.equal(changedGet.source, "planned_overlay");
  assert.equal(changedGet.content_sha256, changed.new_sha256);
  assert.equal(unchangedGet.source, "dropbox");
  assert.equal(unchangedGet.content_sha256, unchangedBaseline.content_sha256);
  assert.equal(unchangedGet.bytes, unchangedBaseline.bytes);

  const changedHead = await staged.stagedR2.adapter.headObject({ key: changedKey });
  const unchangedHead = await staged.stagedR2.adapter.headObject({ key: unchangedKey });
  assert.equal(changedHead.source, "planned_overlay");
  assert.equal(changedHead.content_sha256, changed.new_sha256);
  assert.equal(unchangedHead.source, "dropbox");
  assert.equal(unchangedHead.content_sha256, unchangedBaseline.content_sha256);
  assert.equal(unchangedHead.bytes, unchangedBaseline.bytes);

  const listing = await staged.stagedR2.adapter.listAllObjects({ prefix });
  assert.equal(new Set(listing.map((entry) => entry.key)).size, listing.length);
  assert.equal(listing.find((entry) => entry.key === changedKey).source, "planned_overlay");
  assert.equal(listing.find((entry) => entry.key === changedKey).content_sha256, changed.new_sha256);
  assert.equal(listing.find((entry) => entry.key === unchangedKey).source, "dropbox");
  assert.equal(listing.find((entry) => entry.key === unchangedKey).content_sha256,
    unchangedBaseline.content_sha256);

  const snapshot = localDependencySnapshot({
    child: {
      children: [{ manifest_key: changedKey }, { manifest_key: unchangedKey }],
      identities: new Map([
        [changedKey, {
          content_sha256: changedGet.content_sha256,
          bytes: changedGet.bytes,
          source: changedGet.source,
        }],
        [unchangedKey, {
          content_sha256: unchangedGet.content_sha256,
          bytes: unchangedGet.bytes,
          source: unchangedGet.source,
        }],
      ]),
    },
    proposals: staged.proposals,
    prefix,
    dayUtc: "2026-07-07",
    connectorId: 1,
    kind: "index",
  });
  assert.deepEqual(snapshot.expected_children, [
    {
      key: unchangedKey,
      content_sha256: unchangedBaseline.content_sha256,
      bytes: unchangedBaseline.bytes,
      source: "dropbox",
      staged: false,
    },
    {
      key: changedKey,
      content_sha256: changed.new_sha256,
      bytes: changed.bytes,
      source: "planned_overlay",
      staged: true,
    },
  ]);

  const writeSet = [...staged.proposals.values()]
    .filter((proposal) => proposal.changed === true)
    .map((proposal) => proposal.key)
    .sort();
  assert.deepEqual(writeSet, [changedKey, latestKey].sort());
  assert.deepEqual(
    [proposalView(changed), proposalView(unchanged), proposalView(latest)]
      .map(({ key, status, included_in_write_set: included }) => ({ key, status, included })),
    [
      { key: changedKey, status: "planned", included: true },
      { key: unchangedKey, status: "skipped_unchanged", included: false },
      { key: latestKey, status: "planned", included: true },
    ],
  );
  assert.deepEqual(proposalGraphAudit(staged.proposals), {
    changed_proposal_count: 2,
    skipped_unchanged_proposal_count: 1,
    changed_dependency_count: 1,
    unchanged_baseline_dependency_count: 1,
    mutation_write_count: 2,
    planning_post_put_verification_count: 0,
    expected_post_put_verification_count: 2,
    dependency_count_semantics: "proposal_dependency_edges",
  });

  const overlayKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=o3/manifest.json`;
  const overlayBaseline = localObject(overlayKey, JSON.stringify({ version: "overlay-same" }), "overlay");
  const overlayStaged = createStagedObjectMap({
    r2: {},
    store: localStore(new Map([[overlayKey, overlayBaseline]])),
  });
  await overlayStaged.stage({
    key: overlayKey,
    body: overlayBaseline.body,
    kind: "pollutant_timeseries_index",
  });
  assert.deepEqual(overlayStaged.resolveDependencyIdentities([overlayKey])[overlayKey], {
    source: "overlay",
    sha256: overlayBaseline.content_sha256,
    bytes: overlayBaseline.bytes,
  });
});

test("connector child discovery retains a valid unchanged O3 manifest", async () => {
  const prefix = "history/v2/observations/day_utc=2026-05-17/connector_id=1/pollutant_code=";
  const keys = [
    `${prefix}no2/manifest.json`,
    `${prefix}o3/manifest.json`,
    `${prefix}pm10/manifest.json`,
    `${prefix}pm25/manifest.json`,
  ];
  const dayUtc = "2026-05-17";
  const connectorId = 1;
  const manifests = new Map(keys.map((key) => {
    const pollutantCode = key.match(/pollutant_code=([^/]+)/)?.[1];
    const partKey = key.replace("manifest.json", "part-00001.parquet");
    const { canonical_rows: _canonicalRows, ...observationContentHash } =
      computeObservationContentHash([{
        connector_id: connectorId,
        station_id: 1,
        timeseries_id: 1,
        pollutant_code: pollutantCode,
        observed_at_utc: "2026-05-17T00:00:00.000Z",
        value: 1,
        verification_status: null,
      }]);
    const payload = buildHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      manifestKey: key,
      sourceRowCount: 1,
      fileEntries: [{
        key: partKey,
        bytes: 1,
        row_count: 1,
        min_timeseries_id: 1,
        max_timeseries_id: 1,
        min_observed_at_utc: "2026-05-17T00:00:00.000Z",
        max_observed_at_utc: "2026-05-17T00:00:00.000Z",
        timeseries_row_counts: { "1": 1 },
      }],
      writerGitSha: "test",
      backedUpAtUtc: "2026-05-18T00:00:00.000Z",
      observationContentHash,
    });
    return [key, payload];
  }));
  const store = {
    listAllObjects: ({ prefix: requestedPrefix }) => keys
      .filter((key) => key.startsWith(requestedPrefix))
      .map((key) => ({ key, bytes: 1, source: "dropbox", content_sha256: "a".repeat(64) })),
    getObjectIfExists: (key) => {
      const payload = manifests.get(key);
      return payload
        ? { key, body: Buffer.from(JSON.stringify(payload)), source: "dropbox" }
        : null;
    },
  };
  const { stagedR2 } = createStagedObjectMap({
    r2: {},
    store,
    dropboxSourceKeys: [`${prefix}o3/manifest.json`],
  });
  const children = await stagedR2.adapter.listAllObjects({ prefix });

  assert.deepEqual(children.map((entry) => entry.key), keys);

  const discovered = await readChildren({
    store: stagedR2.adapter,
    prefix,
    dayUtc,
    connectorId,
    kind: "pollutant",
  });
  assert.deepEqual(discovered.children.map((payload) => payload.pollutant_code), ["no2", "o3", "pm10", "pm25"]);

  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    manifestKey: "history/v2/observations/day_utc=2026-05-17/connector_id=1/manifest.json",
    pollutantManifests: discovered.children,
    writerGitSha: "test",
    backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  assert.deepEqual(connector.pollutant_codes, ["no2", "o3", "pm10", "pm25"]);
  assert.deepEqual(connector.pollutant_manifests.map((child) => child.pollutant_code), ["no2", "o3", "pm10", "pm25"]);
});
