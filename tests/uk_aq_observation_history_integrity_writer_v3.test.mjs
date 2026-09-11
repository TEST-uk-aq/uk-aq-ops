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
  const store = new Map([[oldKey, Buffer.from("obsolete", "utf8")]]);
  const tombstone = { proposed: true, prefix: dayPrefix };
  const runState = {
    run_id: "sos-light-v3-persistence-test",
    run_root: root,
    execution_path: "sos_light",
    sos_light: { days: [{ day_utc: DAY_UTC }] },
    tombstone_prefixes: [tombstone],
  };
  const proposal = {
    objects: [{ key: publishedKey }],
    prefixes: [{ prefix: dayPrefix, entry: tombstone }],
  };
  const adapters = {
    getObject: async ({ key }) => store.has(key)
      ? { exists: true, body: Buffer.from(store.get(key)) }
      : { exists: false, body: Buffer.alloc(0) },
    putObject: async ({ key, body }) => {
      store.set(key, Buffer.from(body));
      return { status: "succeeded" };
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
      executeWriter: async ({
        getObject,
        putIfChanged,
        recordDurableEvidence,
        prepareCompleteDayReplacement,
      }) => {
        const replacement = await prepareCompleteDayReplacement({ day_utc: DAY_UTC });
        const publication = await putIfChanged({
          key: publishedKey,
          body: publishedBody,
          content_type: "application/json",
          publication_stage: "observation_connector_manifest",
        });
        await getObject({ key: publishedKey });
        await recordDurableEvidence({
          key: publishedKey,
          byte_size: publishedBody.byteLength,
          sha256: sha256(publishedBody),
        });
        return {
          ok: true,
          status: "succeeded",
          complete_day_replacement_results: [replacement],
          publication,
        };
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(store.has(oldKey), false);
    assert.deepEqual(store.get(publishedKey), publishedBody);

    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    assert.equal(persisted.apply.status, "succeeded");
    assert.equal(persisted.apply.v3_publication_evidence.length, 1);
    assert.equal(persisted.apply.v3_publication_evidence[0].sha256, sha256(publishedBody));
    assert.equal(persisted.tombstone_prefixes[0].deletion_verified, true);

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
    assert.equal(verified.persistence.verified_publication_object_count, 1);
    assert.equal(verified.summary.status, "ok");
    assert.equal(verified.summary.r2_objects_written, 1);
    assert.equal(verified.summary.r2_objects_deleted, 1);
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
  const tombstone = { proposed: true, prefix: dayPrefix };
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
          objects: [],
          prefixes: [{ prefix: dayPrefix, entry: tombstone }],
        },
        r2: {},
        adapters: {
          getObject: async () => ({ exists: false, body: Buffer.alloc(0) }),
          putObject: async () => ({ status: "succeeded" }),
          putIfChanged: async () => ({ status: "succeeded" }),
          listAllObjects: async ({ prefix }) => [...store.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key })),
          deleteObjects: async ({ keys }) => {
            for (const key of keys) store.delete(key);
          },
        },
        executeWriter: async ({ prepareCompleteDayReplacement }) => {
          await prepareCompleteDayReplacement({ day_utc: DAY_UTC });
          throw new Error("simulated publication failure");
        },
      }),
      /simulated publication failure/,
    );
    const persisted = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    assert.equal(persisted.apply.status, "failed");
    assert.equal(persisted.apply.canonical_v3_writer_result, null);
    assert.equal(persisted.apply.failure_checkpoint.succeeded, true);
    assert.equal(persisted.tombstone_prefixes[0].deletion_verified, true);
    assert.equal(store.has(oldKey), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
