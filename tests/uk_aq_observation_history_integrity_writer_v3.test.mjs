import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildValidatedIntegrityObservationHistoryV3Partitions,
} from "../scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  computeObservationContentHash,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  runPersistedSosLightV3Apply,
} from "../scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs";

const DAY_UTC = "2026-08-18";
const CONNECTOR_ID = 1;
const POLLUTANT_CODE = "pm25";
const TARGET_GIT_SHA = "3".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("validated Integrity adapter loads immutable stored rows without a second proposal engine", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-integrity-adapter-"));
  try {
    const storedRows = [{
      timeseries_id: 101,
      station_id: 10,
      pollutant_code: POLLUTANT_CODE,
      observed_at: `${DAY_UTC}T00:00:00.000Z`,
      value: 12.5,
      verification_status: "P",
    }];
    const canonicalRows = storedRows.map((row) => ({
      connector_id: CONNECTOR_ID,
      station_id: row.station_id,
      timeseries_id: row.timeseries_id,
      pollutant_code: row.pollutant_code,
      observed_at_utc: row.observed_at,
      value: row.value,
      verification_status: row.verification_status,
    }));
    const content = computeObservationContentHash(canonicalRows);
    const { canonical_rows: _canonicalRows, ...contentMetadata } = content;
    const rowsBody = Buffer.from(JSON.stringify(storedRows, null, 2), "utf8");
    const directory = path.join(
      root,
      `day_utc=${DAY_UTC}`,
      `connector_id=${CONNECTOR_ID}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "obs_history_rows.json"), rowsBody);
    fs.writeFileSync(path.join(directory, "source-evidence.json"), JSON.stringify({
      schema_version: 1,
      enumeration_complete: true,
      day_utc: DAY_UTC,
      connector_id: CONNECTOR_ID,
      canonical_rows_bytes: rowsBody.byteLength,
      canonical_rows_sha256: sha256(rowsBody),
      total_rows: storedRows.length,
      per_pollutant_counts: { [POLLUTANT_CODE]: storedRows.length },
      observation_content_hashes: {
        [POLLUTANT_CODE]: contentMetadata,
      },
      missing_binding_rows: 0,
    }, null, 2));

    const prepared = buildObservationHistoryV3SteadyStatePartition({
      source: "integrity",
      rows: canonicalRows,
      targetWriterGitSha: TARGET_GIT_SHA,
      backedUpAtUtc: "2026-08-22T00:00:00.000Z",
    });
    const manifestKey = prepared.canonical_pollutant_manifest.key;
    const entry = { final_proposal_graph_validated: true };
    const validatedProposal = {
      objects: [{
        key: manifestKey,
        body: Buffer.from(prepared.canonical_pollutant_manifest.body),
        entry,
      }],
      prefixes: [],
    };
    const runState = {
      overlay_root: root,
      execution_path: "generic",
      final_proposal_graph_validation: {
        status: "succeeded",
        parent_and_index_dependencies_validated: true,
        tombstones_validated: true,
        validated_partition_count: 1,
        partitions: [{
          manifest_key: manifestKey,
          source_content_hash: contentMetadata.observation_content_hash,
          row_count: 1,
          status: "validated",
        }],
      },
    };

    const partitions = buildValidatedIntegrityObservationHistoryV3Partitions({
      runState,
      validatedProposal,
    });
    assert.equal(partitions.length, 1);
    assert.deepEqual(partitions[0].scope, prepared.scope);
    assert.deepEqual(partitions[0].rows, content.canonical_rows);
    assert.equal(
      partitions[0].backed_up_at_utc,
      prepared.canonical_pollutant_manifest.payload.backed_up_at_utc,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fixed-v3 apply persists exact mutation evidence accepted by the Integrity verifier", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-apply-"));
  const runStatePath = path.join(root, "run-state.json");
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const oldKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/obsolete.json`;
  const publishedKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/manifest.json`;
  const publishedBody = Buffer.from('{"schema_version":3}\n', "utf8");
  const dayManifestKey = `${dayPrefix}/manifest.json`;
  const dayManifestBody = Buffer.from('{"schema_version":3,"level":"day"}\n', "utf8");
  const monthManifestKey = "history/v3/observations/_manifests/year=2026/month=08/manifest.json";
  const yearManifestKey = "history/v3/observations/_manifests/year=2026/manifest.json";
  const rootManifestKey = "history/v3/observations/_manifests/manifest.json";
  const latestKey = "history/_index_v3/observations_timeseries_latest.json";
  const latestBody = Buffer.from('{"kind":"observation_timeseries_latest_global"}\n');
  const parquetKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/pollutant_code=no2/part-00000.parquet`;
  const parquetBody = Buffer.from("planned-parquet", "utf8");
  const removedExactPrefix = "history/_index_v3/observations_timeseries/day_utc=2026-05-31/connector_id=1/pollutant_code=no2";
  const removedAlignedPrefix = "history/_index_v3/observations_timeseries/_aligned/day_utc=2026-05-31/connector_id=1/pollutant_code=no2";
  const store = new Map([
    [oldKey, Buffer.from("obsolete", "utf8")],
    [`${removedExactPrefix}/manifest.json`, Buffer.from("old-exact")],
    [`${removedAlignedPrefix}/manifest.json`, Buffer.from("old-aligned")],
  ]);
  const publicationOrder = [];
  const tombstone = { proposed: true, prefix: dayPrefix, stage: "sos_light_complete_day" };
  const exactTombstone = {
    proposed: true, prefix: removedExactPrefix,
    stage: "sos_light_exact_v3_scope_removal",
  };
  const alignedTombstone = {
    proposed: true, prefix: removedAlignedPrefix,
    stage: "sos_light_exact_v3_scope_removal",
  };
  const runState = {
    run_id: "sos-light-v3-persistence-test",
    run_root: root,
    execution_path: "sos_light",
    sos_light: { days: [{ day_utc: DAY_UTC }] },
    tombstone_prefixes: [tombstone, exactTombstone, alignedTombstone],
  };
  const proposal = {
    objects: [{
      key: parquetKey,
      body: parquetBody,
      entry: {
        dependencies: [],
        bytes: parquetBody.byteLength,
        sha256: sha256(parquetBody),
        content_type: "application/vnd.apache.parquet",
        publication_stage: "observation_parquet",
      },
    }, {
      key: publishedKey,
      body: publishedBody,
      entry: {
        dependencies: [parquetKey],
        content_type: "application/json",
        publication_stage: "observation_connector_manifest",
      },
    }, {
      key: dayManifestKey,
      body: dayManifestBody,
      entry: {
        dependencies: [publishedKey],
        content_type: "application/json",
        publication_stage: "observation_day_manifest",
      },
    }, {
      key: monthManifestKey,
      body: Buffer.from('{"level":"month"}\n'),
      entry: {
        dependencies: [dayManifestKey],
        content_type: "application/json",
        publication_stage: "observation_month_manifest",
      },
    }, {
      key: yearManifestKey,
      body: Buffer.from('{"level":"year"}\n'),
      entry: {
        dependencies: [monthManifestKey],
        content_type: "application/json",
        publication_stage: "observation_year_manifest",
      },
    }, {
      key: rootManifestKey,
      body: Buffer.from('{"level":"root"}\n'),
      entry: {
        dependencies: [yearManifestKey],
        content_type: "application/json",
        publication_stage: "observation_root_manifest",
      },
    }, {
      key: latestKey,
      body: latestBody,
      entry: {
        dependencies: [rootManifestKey],
        content_type: "application/json",
        publication_stage: "latest_global",
      },
    }],
    prefixes: [
      { prefix: dayPrefix, entry: tombstone },
      { prefix: removedExactPrefix, entry: exactTombstone },
      { prefix: removedAlignedPrefix, entry: alignedTombstone },
    ],
  };
  const adapters = {
    getObject: async ({ key }) => store.has(key)
      ? { exists: true, body: Buffer.from(store.get(key)) }
      : { exists: false, body: Buffer.alloc(0) },
    putObject: async ({ key, body }) => {
      publicationOrder.push(key);
      store.set(key, Buffer.from(body));
      return { status: "succeeded" };
    },
    putAndVerifyParquet: async ({ intent }) => {
      assert.equal(intent.sha256, sha256(parquetBody));
      assert.equal(intent.byte_size, parquetBody.byteLength);
      publicationOrder.push(intent.key);
      store.set(intent.key, Buffer.from(intent.body));
      return {
        key: intent.key,
        sha256: intent.sha256,
        byte_size: intent.byte_size,
        stored_sha256_verified: true,
        stored_byte_size_verified: true,
        status: "succeeded",
      };
    },
    putIfChanged: async ({ key, body }) => {
      store.set(key, Buffer.from(body));
      return { status: "succeeded", skipped: false };
    },
    listAllObjects: async ({ prefix }) => [...store.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key })),
    deleteObjects: async ({ keys }) => {
      for (const key of keys) store.delete(key);
      return { deleted: keys.length };
    },
  };

  try {
    const result = await runPersistedSosLightV3Apply({
      runStatePath,
      runState,
      proposal,
      r2: {},
      adapters,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(store.has(oldKey), false);
    assert.equal(store.has(`${removedExactPrefix}/manifest.json`), false);
    assert.equal(store.has(`${removedAlignedPrefix}/manifest.json`), false);
    assert.deepEqual(publicationOrder, [
      parquetKey,
      publishedKey,
      dayManifestKey,
      monthManifestKey,
      yearManifestKey,
      rootManifestKey,
      latestKey,
    ]);
    assert.deepEqual(store.get(parquetKey), parquetBody);
    assert.deepEqual(store.get(publishedKey), publishedBody);

    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    assert.equal(persisted.apply.status, "succeeded");
    assert.equal(persisted.apply.v3_publication_evidence.length, 7);
    assert.equal(persisted.apply.v3_publication_evidence[0].sha256, sha256(parquetBody));
    assert.equal(persisted.apply.v3_publication_evidence[0].stored_sha256_verified, true);
    assert.equal(persisted.apply.v3_publication_evidence[0].stored_byte_size_verified, true);
    assert.equal(persisted.tombstone_prefixes[0].deletion_verified, true);
    assert.equal(persisted.tombstone_prefixes[1].deletion_verified, true);
    assert.equal(persisted.tombstone_prefixes[2].deletion_verified, true);

    const verifierPath = fileURLToPath(new URL(
      "../scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py",
      import.meta.url,
    ));
    const verification = spawnSync("python3", [
      "-c",
      [
        "import importlib.util,json,sys",
        "spec=importlib.util.spec_from_file_location('sos_light_v3',sys.argv[1])",
        "module=importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "state=json.load(open(sys.argv[2],encoding='utf-8'))",
        "persistence=module.verify_apply_persistence_artifacts(state)",
        "summary=module.summarize_ordered_apply_verification(run_state=state,apply_result={'status':'succeeded'})",
        "print(json.dumps({'persistence':persistence,'summary':summary}))",
      ].join(";"),
      verifierPath,
      runStatePath,
    ], { encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr);
    const verified = JSON.parse(verification.stdout);
    assert.equal(verified.persistence.status, "verified");
    assert.equal(verified.persistence.verified_publication_object_count, 7);
    assert.equal(verified.summary.status, "ok");
    assert.equal(verified.summary.r2_objects_written, 7);
    assert.equal(verified.summary.r2_objects_deleted, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fixed-v3 apply records failure after deletion instead of false success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-failure-"));
  const runStatePath = path.join(root, "run-state.json");
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const oldKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/obsolete.json`;
  const store = new Map([[oldKey, Buffer.from("obsolete", "utf8")]]);
  const failedParquetKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/pollutant_code=no2/part-00000.parquet`;
  let dependentPutAttempted = false;
  const tombstone = { proposed: true, prefix: dayPrefix, stage: "sos_light_complete_day" };
  const runState = {
    run_id: "sos-light-v3-failure-test",
    run_root: root,
    execution_path: "sos_light",
    sos_light: { days: [{ day_utc: DAY_UTC }] },
    tombstone_prefixes: [tombstone],
  };

  try {
    await assert.rejects(
      runPersistedSosLightV3Apply({
        runStatePath,
        runState,
        proposal: {
          objects: [{
            key: failedParquetKey,
            body: Buffer.from("failed-parquet"),
            entry: {
              dependencies: [],
              content_type: "application/vnd.apache.parquet",
              publication_stage: "observation_parquet",
            },
          }, {
            key: `${dayPrefix}/manifest.json`,
            body: Buffer.from("{}\n"),
            entry: {
              dependencies: [failedParquetKey],
              content_type: "application/json",
              publication_stage: "observation_day_manifest",
            },
          }],
          prefixes: [{ prefix: dayPrefix, entry: tombstone }],
        },
        r2: {},
        adapters: {
          getObject: async () => ({ exists: false, body: Buffer.alloc(0) }),
          putObject: async () => {
            dependentPutAttempted = true;
            return { status: "succeeded" };
          },
          putAndVerifyParquet: async () => {
            throw new Error("simulated checksum storage verification failure");
          },
          putIfChanged: async () => ({ status: "succeeded" }),
          listAllObjects: async ({ prefix }) => [...store.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key })),
          deleteObjects: async ({ keys }) => {
            for (const key of keys) store.delete(key);
          },
        },
      }),
      /simulated checksum storage verification failure/,
    );
    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    assert.equal(persisted.apply.status, "failed");
    assert.equal(persisted.apply.canonical_v3_writer_result, null);
    assert.equal(persisted.apply.failure_checkpoint.succeeded, true);
    assert.equal(persisted.tombstone_prefixes[0].deletion_verified, true);
    assert.equal(store.has(oldKey), false);
    assert.equal(dependentPutAttempted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first selected-day failure leaves the later selected day untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-day-units-"));
  const runStatePath = path.join(root, "run-state.json");
  const firstDay = "2026-08-18";
  const secondDay = "2026-08-19";
  const prefixes = [firstDay, secondDay].map(
    (day) => `history/v3/observations/day_utc=${day}`,
  );
  const oldKeys = prefixes.map((prefix) => `${prefix}/old.json`);
  const store = new Map(oldKeys.map((key) => [key, Buffer.from("old")]));
  const tombstones = prefixes.map((prefix) => ({
    proposed: true, prefix, stage: "sos_light_complete_day",
  }));
  const dayObjects = prefixes.map((prefix) => ({
    key: `${prefix}/manifest.json`,
    body: Buffer.from("{}"),
    entry: {
      dependencies: [],
      content_type: "application/json",
      publication_stage: "observation_day_manifest",
    },
  }));
  const latestKey = "history/_index_v3/observations_timeseries_latest.json";
  try {
    await assert.rejects(runPersistedSosLightV3Apply({
      runStatePath,
      runState: {
        run_id: "sos-light-v3-day-unit-failure",
        run_root: root,
        execution_path: "sos_light",
        sos_light: { days: [{ day_utc: firstDay }, { day_utc: secondDay }] },
        tombstone_prefixes: tombstones,
      },
      proposal: {
        objects: [...dayObjects, {
          key: latestKey,
          body: Buffer.from("{}"),
          entry: {
            dependencies: dayObjects.map(({ key }) => key),
            content_type: "application/json",
            publication_stage: "latest_global",
          },
        }],
        prefixes: tombstones.map((entry) => ({ prefix: entry.prefix, entry })),
      },
      r2: {},
      adapters: {
        getObject: async () => ({ exists: false, body: Buffer.alloc(0) }),
        putObject: async ({ key }) => {
          if (key === dayObjects[0].key) throw new Error("first day publication failed");
          return { status: "succeeded" };
        },
        putAndVerifyParquet: async () => { throw new Error("unexpected Parquet"); },
        listAllObjects: async ({ prefix }) => [...store.keys()]
          .filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        deleteObjects: async ({ keys }) => {
          for (const key of keys) store.delete(key);
        },
      },
    }), /first day publication failed/);
    assert.equal(store.has(oldKeys[0]), false);
    assert.equal(store.has(oldKeys[1]), true);
    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    const status = persisted.apply_progress
      ? JSON.parse(fs.readFileSync(persisted.apply_progress.path, "utf8"))
        .per_day_high_level_publication_status
      : null;
    assert.equal(status[firstDay].status, "failed");
    assert.equal(status[firstDay].deletion_verified, true);
    assert.equal(status[secondDay].status, "not_started");
    assert.equal(persisted.apply.later_selected_days_untouched, true);
    assert.deepEqual(persisted.apply.untouched_later_selected_days, [secondDay]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fixed-v3 semantic mismatch uses the exact GET body and blocks all parent publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-semantic-"));
  const runStatePath = path.join(root, "run-state.json");
  const sourceRows = [{
    station_id: 10,
    timeseries_id: 101,
    pollutant_code: POLLUTANT_CODE,
    observed_at: `${DAY_UTC}T00:00:00.000Z`,
    value: 99,
    verification_status: "P",
  }];
  const sourceMetadata = computeObservationContentHash(sourceRows.map((row) => ({
    connector_id: CONNECTOR_ID,
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    pollutant_code: row.pollutant_code,
    observed_at_utc: row.observed_at,
    value: row.value,
    verification_status: row.verification_status,
  })));
  const { canonical_rows: _ignoredRows, ...sourceHash } = sourceMetadata;
  const rowsBody = Buffer.from(JSON.stringify(sourceRows));
  const evidence = {
    schema_version: 1,
    enumeration_complete: true,
    day_utc: DAY_UTC,
    connector_id: CONNECTOR_ID,
    requested_pollutant_set: [POLLUTANT_CODE],
    canonical_rows_bytes: rowsBody.byteLength,
    canonical_rows_sha256: sha256(rowsBody),
    total_rows: 1,
    per_pollutant_counts: { [POLLUTANT_CODE]: 1 },
    observation_content_hashes: { [POLLUTANT_CODE]: sourceHash },
    missing_binding_rows: 0,
  };
  const evidenceDirectory = path.join(
    root, "source-evidence", `day_utc=${DAY_UTC}`,
    `connector_id=${CONNECTOR_ID}`, `pollutant_code=${POLLUTANT_CODE}`,
  );
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
  const evidencePath = path.join(evidenceDirectory, "source-evidence.json");
  const evidenceBody = Buffer.from(JSON.stringify(evidence));
  fs.writeFileSync(rowsPath, rowsBody);
  fs.writeFileSync(evidencePath, evidenceBody);

  const built = buildObservationHistoryV3SteadyStatePartition({
    source: "sos_historical_replacement",
    rows: [{
      connector_id: CONNECTOR_ID,
      station_id: 10,
      timeseries_id: 101,
      pollutant_code: POLLUTANT_CODE,
      observed_at_utc: `${DAY_UTC}T00:00:00.000Z`,
      value: 12.5,
      verification_status: "P",
    }],
    scope: { day_utc: DAY_UTC, connector_id: CONNECTOR_ID, pollutant_code: POLLUTANT_CODE },
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const parquet = built.file_intents[0];
  const pollutant = built.canonical_pollutant_manifest;
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const connectorKey = `${dayPrefix}/connector_id=${CONNECTOR_ID}/manifest.json`;
  const dayKey = `${dayPrefix}/manifest.json`;
  const entries = {
    [parquet.key]: {
      dependencies: [], bytes: parquet.byte_size, sha256: parquet.sha256,
      content_type: parquet.content_type, publication_stage: "observation_parquet",
    },
    [pollutant.key]: {
      dependencies: [parquet.key], bytes: pollutant.byte_size, sha256: pollutant.sha256,
      content_type: pollutant.content_type, publication_stage: "observation_pollutant_manifest",
    },
    [connectorKey]: {
      dependencies: [pollutant.key], content_type: "application/json",
      publication_stage: "observation_connector_manifest",
    },
    [dayKey]: {
      dependencies: [connectorKey], content_type: "application/json",
      publication_stage: "observation_day_manifest",
    },
  };
  const objects = [{ key: parquet.key, body: parquet.body, entry: entries[parquet.key] }, {
    key: pollutant.key, body: Buffer.from(pollutant.body), entry: entries[pollutant.key],
  }, {
    key: connectorKey, body: Buffer.from("{}"), entry: entries[connectorKey],
  }, {
    key: dayKey, body: Buffer.from("{}"), entry: entries[dayKey],
  }];
  const store = new Map();
  const getCounts = new Map();
  const attemptedPuts = [];
  const tombstone = { proposed: true, prefix: dayPrefix, stage: "sos_light_complete_day" };
  const identity = `day_utc=${DAY_UTC}/connector_id=${CONNECTOR_ID}/pollutant_code=${POLLUTANT_CODE}`;
  try {
    await assert.rejects(runPersistedSosLightV3Apply({
      runStatePath,
      runState: {
        run_id: "sos-light-v3-semantic-mismatch",
        run_root: root,
        overlay_root: root,
        execution_path: "sos_light",
        sos_light: { days: [{ day_utc: DAY_UTC }] },
        tombstone_prefixes: [tombstone],
        objects: entries,
        source_evidence_partitions: {
          [identity]: {
            identity,
            day_utc: DAY_UTC,
            connector_id: CONNECTOR_ID,
            pollutant_code: POLLUTANT_CODE,
            evidence_path: evidencePath,
            evidence_sha256: sha256(evidenceBody),
            rows_path: rowsPath,
            rows_sha256: sha256(rowsBody),
          },
        },
      },
      proposal: {
        objects,
        prefixes: [{ prefix: dayPrefix, entry: tombstone }],
      },
      r2: {},
      adapters: {
        getObject: async ({ key }) => {
          getCounts.set(key, (getCounts.get(key) || 0) + 1);
          return store.has(key)
            ? { exists: true, body: Buffer.from(store.get(key)) }
            : { exists: false, body: Buffer.alloc(0) };
        },
        putObject: async ({ key, body }) => {
          attemptedPuts.push(key);
          store.set(key, Buffer.from(body));
          return { status: "succeeded" };
        },
        putAndVerifyParquet: async ({ intent }) => {
          attemptedPuts.push(intent.key);
          store.set(intent.key, Buffer.from(intent.body));
          return {
            sha256: intent.sha256,
            byte_size: intent.byte_size,
            stored_sha256_verified: true,
            stored_byte_size_verified: true,
            status: "succeeded",
          };
        },
        listAllObjects: async () => [],
        deleteObjects: async () => ({ deleted: 0 }),
      },
    }), /does not match immutable source evidence/);
    assert.equal(getCounts.get(parquet.key), 1, "semantic validation must reuse the exact GET body");
    assert.deepEqual(attemptedPuts, [parquet.key]);
    assert.equal(entries[pollutant.key].live_observation_failure_classification,
      "live_observation_content_mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated complete-day Parquet cannot evict the selected semantic GET body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-cache-scope-"));
  const runStatePath = path.join(root, "run-state.json");
  const canonicalRow = {
    connector_id: CONNECTOR_ID,
    station_id: 10,
    timeseries_id: 101,
    pollutant_code: POLLUTANT_CODE,
    observed_at_utc: `${DAY_UTC}T00:00:00.000Z`,
    value: 12.5,
    verification_status: "P",
  };
  const sourceHashResult = computeObservationContentHash([canonicalRow]);
  const { canonical_rows: _canonicalRows, ...sourceHash } = sourceHashResult;
  const sourceRows = [{
    station_id: canonicalRow.station_id,
    timeseries_id: canonicalRow.timeseries_id,
    pollutant_code: canonicalRow.pollutant_code,
    observed_at: canonicalRow.observed_at_utc,
    value: canonicalRow.value,
    verification_status: canonicalRow.verification_status,
  }];
  const rowsBody = Buffer.from(JSON.stringify(sourceRows));
  const evidence = {
    schema_version: 1,
    enumeration_complete: true,
    day_utc: DAY_UTC,
    connector_id: CONNECTOR_ID,
    requested_pollutant_set: [POLLUTANT_CODE],
    canonical_rows_bytes: rowsBody.byteLength,
    canonical_rows_sha256: sha256(rowsBody),
    total_rows: 1,
    per_pollutant_counts: { [POLLUTANT_CODE]: 1 },
    observation_content_hashes: { [POLLUTANT_CODE]: sourceHash },
    missing_binding_rows: 0,
  };
  const evidenceDirectory = path.join(
    root, "source-evidence", `day_utc=${DAY_UTC}`,
    `connector_id=${CONNECTOR_ID}`, `pollutant_code=${POLLUTANT_CODE}`,
  );
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
  const evidencePath = path.join(evidenceDirectory, "source-evidence.json");
  const evidenceBody = Buffer.from(JSON.stringify(evidence));
  fs.writeFileSync(rowsPath, rowsBody);
  fs.writeFileSync(evidencePath, evidenceBody);

  const built = buildObservationHistoryV3SteadyStatePartition({
    source: "sos_historical_replacement",
    rows: [canonicalRow],
    scope: { day_utc: DAY_UTC, connector_id: CONNECTOR_ID, pollutant_code: POLLUTANT_CODE },
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const selectedPart = built.file_intents[0];
  const selectedManifest = built.canonical_pollutant_manifest;
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const unrelatedPartKeys = Array.from({ length: 33 }, (_, index) =>
    `${dayPrefix}/connector_id=2/pollutant_code=no2/part-${String(index).padStart(5, "0")}.parquet`
  );
  const unrelatedManifestKey =
    `${dayPrefix}/connector_id=2/pollutant_code=no2/manifest.json`;
  const connector1Key = `${dayPrefix}/connector_id=1/manifest.json`;
  const connector2Key = `${dayPrefix}/connector_id=2/manifest.json`;
  const dayKey = `${dayPrefix}/manifest.json`;
  const entries = {};
  const objects = [];
  const addObject = (key, body, dependencies, publicationStage, contentType = "application/json") => {
    entries[key] = {
      dependencies,
      bytes: body.byteLength,
      sha256: sha256(body),
      content_type: contentType,
      publication_stage: publicationStage,
    };
    objects.push({ key, body, entry: entries[key] });
  };
  addObject(
    selectedPart.key,
    selectedPart.body,
    [],
    "observation_parquet",
    selectedPart.content_type,
  );
  for (const [index, key] of unrelatedPartKeys.entries()) {
    addObject(
      key,
      Buffer.from(`preserved-${index}`),
      [],
      "observation_parquet",
      "application/vnd.apache.parquet",
    );
  }
  addObject(
    selectedManifest.key,
    Buffer.from(selectedManifest.body),
    [selectedPart.key],
    "observation_pollutant_manifest",
  );
  addObject(
    unrelatedManifestKey,
    Buffer.from("{}"),
    unrelatedPartKeys,
    "observation_pollutant_manifest",
  );
  addObject(connector1Key, Buffer.from("{}"), [selectedManifest.key], "observation_connector_manifest");
  addObject(connector2Key, Buffer.from("{}"), [unrelatedManifestKey], "observation_connector_manifest");
  addObject(dayKey, Buffer.from("{}"), [connector1Key, connector2Key], "observation_day_manifest");

  const store = new Map();
  const getCounts = new Map();
  let parquetPutCount = 0;
  const tombstone = { proposed: true, prefix: dayPrefix, stage: "sos_light_complete_day" };
  const identity = `day_utc=${DAY_UTC}/connector_id=1/pollutant_code=${POLLUTANT_CODE}`;
  try {
    const result = await runPersistedSosLightV3Apply({
      runStatePath,
      runState: {
        run_id: "sos-light-v3-cache-scope",
        run_root: root,
        overlay_root: root,
        execution_path: "sos_light",
        sos_light: { days: [{ day_utc: DAY_UTC }] },
        tombstone_prefixes: [tombstone],
        objects: entries,
        source_evidence_partitions: {
          [identity]: {
            identity,
            day_utc: DAY_UTC,
            connector_id: CONNECTOR_ID,
            pollutant_code: POLLUTANT_CODE,
            evidence_path: evidencePath,
            evidence_sha256: sha256(evidenceBody),
            rows_path: rowsPath,
            rows_sha256: sha256(rowsBody),
          },
        },
      },
      proposal: { objects, prefixes: [{ prefix: dayPrefix, entry: tombstone }] },
      r2: {},
      adapters: {
        getObject: async ({ key }) => {
          getCounts.set(key, (getCounts.get(key) || 0) + 1);
          return { exists: store.has(key), body: Buffer.from(store.get(key) || "") };
        },
        putObject: async ({ key, body }) => {
          store.set(key, Buffer.from(body));
          return { status: "succeeded" };
        },
        putAndVerifyParquet: async ({ intent }) => {
          parquetPutCount += 1;
          store.set(intent.key, Buffer.from(intent.body));
          return {
            sha256: intent.sha256,
            byte_size: intent.byte_size,
            stored_sha256_verified: true,
            stored_byte_size_verified: true,
            status: "succeeded",
          };
        },
        listAllObjects: async () => [],
        deleteObjects: async () => ({ deleted: 0 }),
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(parquetPutCount, 34);
    for (const key of [selectedPart.key, ...unrelatedPartKeys]) {
      assert.equal(getCounts.get(key), 1, `expected exactly one verification GET for ${key}`);
    }
    assert.deepEqual(entries[selectedManifest.key].live_observation_body_sources, [{
      key: selectedPart.key,
      verified_sha256: selectedPart.sha256,
      source: "verified_get_cache",
    }]);
    assert.equal(entries[selectedPart.key].verified_get_body_cached, true);
    assert(unrelatedPartKeys.every((key) => entries[key].verified_get_body_cached === false));
    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    const parquetEvidence = persisted.apply.v3_publication_evidence.filter(
      ({ key }) => key.endsWith(".parquet"),
    );
    assert.equal(parquetEvidence.length, 34);
    assert(parquetEvidence.every((entry) => entry.r2_verified === true
      && entry.stored_sha256_verified === true
      && entry.stored_byte_size_verified === true));
    assert.equal(persisted.apply.verified_get_body_cache.peak_entries, 1);
    assert.equal(persisted.apply.verified_get_body_cache.current_entries, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selected semantic cache overflow fails before the first mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-cache-capacity-"));
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const partKeys = Array.from({ length: 33 }, (_, index) =>
    `${dayPrefix}/connector_id=1/pollutant_code=${POLLUTANT_CODE}`
      + `/part-${String(index).padStart(5, "0")}.parquet`
  );
  const manifestKey =
    `${dayPrefix}/connector_id=1/pollutant_code=${POLLUTANT_CODE}/manifest.json`;
  const connectorKey = `${dayPrefix}/connector_id=1/manifest.json`;
  const dayKey = `${dayPrefix}/manifest.json`;
  const partObjects = partKeys.map((key, index) => ({
    key,
    body: Buffer.from(`selected-${index}`),
    entry: {
      dependencies: [],
      content_type: "application/vnd.apache.parquet",
      publication_stage: "observation_parquet",
    },
  }));
  const objects = [...partObjects, {
    key: manifestKey,
    body: Buffer.from(JSON.stringify({ parquet_object_keys: partKeys })),
    entry: {
      dependencies: partKeys,
      content_type: "application/json",
      publication_stage: "observation_pollutant_manifest",
    },
  }, {
    key: connectorKey,
    body: Buffer.from("{}"),
    entry: {
      dependencies: [manifestKey],
      content_type: "application/json",
      publication_stage: "observation_connector_manifest",
    },
  }, {
    key: dayKey,
    body: Buffer.from("{}"),
    entry: {
      dependencies: [connectorKey],
      content_type: "application/json",
      publication_stage: "observation_day_manifest",
    },
  }];
  let remoteCallCount = 0;
  const identity = `day_utc=${DAY_UTC}/connector_id=1/pollutant_code=${POLLUTANT_CODE}`;
  try {
    await assert.rejects(runPersistedSosLightV3Apply({
      runStatePath: path.join(root, "run-state.json"),
      runState: {
        run_id: "sos-light-v3-cache-capacity",
        execution_path: "sos_light",
        sos_light: { days: [{ day_utc: DAY_UTC }] },
        source_evidence_partitions: { [identity]: {} },
      },
      proposal: {
        objects,
        prefixes: [{
          prefix: dayPrefix,
          entry: { stage: "sos_light_complete_day" },
        }],
      },
      r2: {},
      adapters: Object.fromEntries([
        "getObject", "putObject", "putAndVerifyParquet", "listAllObjects", "deleteObjects",
      ].map((name) => [name, async () => {
        remoteCallCount += 1;
        throw new Error(`unexpected ${name}`);
      }])),
    }), /selected semantic GET bodies exceed bounded cache.*entries=33\/32/);
    assert.equal(remoteCallCount, 0);
    assert.equal(fs.existsSync(path.join(root, "run-state.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical root failure blocks global latest publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-sos-light-v3-finalisation-"));
  const runStatePath = path.join(root, "run-state.json");
  const dayPrefix = `history/v3/observations/day_utc=${DAY_UTC}`;
  const canonicalKey = `${dayPrefix}/manifest.json`;
  const rootKey = "history/v3/observations/_manifests/manifest.json";
  const latestKey = "history/_index_v3/observations_timeseries_latest.json";
  const tombstone = {
    proposed: true,
    prefix: dayPrefix,
    stage: "sos_light_complete_day",
  };
  const attempted = [];
  const store = new Map();
  try {
    await assert.rejects(runPersistedSosLightV3Apply({
      runStatePath,
      runState: {
        run_id: "sos-light-v3-finalisation-test",
        run_root: root,
        execution_path: "sos_light",
        sos_light: { days: [{ day_utc: DAY_UTC }] },
        tombstone_prefixes: [tombstone],
      },
      proposal: {
        objects: [{
          key: canonicalKey,
          body: Buffer.from("{}\n"),
          entry: {
            dependencies: [],
            content_type: "application/json",
            publication_stage: "observation_day_manifest",
          },
        }, {
          key: rootKey,
          body: Buffer.from("{}\n"),
          entry: {
            dependencies: [canonicalKey],
            content_type: "application/json",
            publication_stage: "observation_root_manifest",
          },
        }, {
          key: latestKey,
          body: Buffer.from("{}\n"),
          entry: {
            dependencies: [rootKey],
            content_type: "application/json",
            publication_stage: "latest_global",
          },
        }],
        prefixes: [{ prefix: dayPrefix, entry: tombstone }],
      },
      r2: {},
      adapters: {
        getObject: async ({ key }) => store.has(key)
          ? { exists: true, body: Buffer.from(store.get(key)) }
          : { exists: false, body: Buffer.alloc(0) },
        putObject: async ({ key, body }) => {
          attempted.push(key);
          if (key === rootKey) throw new Error("simulated canonical root failure");
          store.set(key, Buffer.from(body));
          return { status: "succeeded" };
        },
        putAndVerifyParquet: async () => { throw new Error("unexpected Parquet"); },
        listAllObjects: async () => [],
        deleteObjects: async () => ({ deleted: 0 }),
      },
    }), /simulated canonical root failure/);
    assert.deepEqual(attempted, [canonicalKey, rootKey]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
