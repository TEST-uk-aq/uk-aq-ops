import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildValidatedIntegrityObservationHistoryV3Partitions,
} from "../scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  computeObservationContentHash,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";

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
