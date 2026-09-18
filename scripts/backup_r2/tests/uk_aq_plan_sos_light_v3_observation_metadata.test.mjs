import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCurrentRunManifestWriterGitSha,
  assertFixedV3Proposal,
  retainedExactV3ScopedRoots,
  resolveIntegrityTargetWriterGitSha,
  verifyRetainedExactV3ScopedRoots,
} from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  readCanonicalObservationRows,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  inspectObservationParquetFile,
} from "../lib/uk_aq_observation_parquet_content_hash.mjs";
import {
  computeObservationContentHash,
  selectObservationVerificationStatusColumn,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

function proposalWithDependency(dependency) {
  return {
    planning: {
      proposals: [{
        key: "history/_index_v3/observations_timeseries_latest.json",
        dependencies: [dependency],
        dependency_identities: {
          [dependency]: { source: "dropbox", sha256: "a".repeat(64), bytes: 1 },
        },
      }],
    },
  };
}

test("fixed-v3 namespace guard accepts only generation-v3 observation authorities", () => {
  assert.doesNotThrow(() => assertFixedV3Proposal(proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/connector_id=1/manifest.json",
  )));
});

test("fixed-v3 namespace guard rejects v2 and unrelated dependency namespaces", () => {
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency(
      "history/v2/observations/day_utc=2026-06-01/manifest.json",
    )),
    /outside v3/,
  );
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency("history/unrelated/object.json")),
    /outside v3 observation_index/,
  );
});

test("fixed-v3 namespace guard requires an exact dependency identity map", () => {
  const output = proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/manifest.json",
  );
  output.planning.proposals[0].dependency_identities = {};
  assert.throws(() => assertFixedV3Proposal(output), /identities are not exact/);
});

test("canonical v3 vstatus survives Parquet decoding", async () => {
  const rows = ["P", "R"].map((verificationStatus, index) => ({
    connector_id: 1,
    station_id: 10,
    timeseries_id: 100,
    pollutant_code: "pm25",
    observed_at_utc: `2026-06-01T0${index}:00:00.000Z`,
    value: 12.5 + index,
    verification_status: verificationStatus,
  }));
  const v3 = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows,
    scope: { day_utc: "2026-06-01", connector_id: 1, pollutant_code: "pm25" },
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
  });
  const decodedV3 = (await Promise.all(v3.file_intents.map(({ body }) =>
    readCanonicalObservationRows({ body, connectorId: 1 })
  ))).flat();
  assert.deepEqual(decodedV3.map(({ verification_status }) => verification_status), ["P", "R"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-vstatus-decoders-"));
  try {
    const inspectedRows = [];
    for (const [index, intent] of v3.file_intents.entries()) {
      const filePath = path.join(root, `part-${index}.parquet`);
      fs.writeFileSync(filePath, intent.body);
      const inspected = await inspectObservationParquetFile({ filePath, connectorId: 1 });
      inspectedRows.push(...inspected.canonicalRows);
    }
    assert.deepEqual(
      inspectedRows.map(({ verification_status }) => verification_status),
      ["P", "R"],
    );
    assert.equal(
      computeObservationContentHash(inspectedRows).observation_content_hash,
      computeObservationContentHash(decodedV3).observation_content_hash,
    );
    assert.deepEqual(
      computeObservationContentHash(inspectedRows).verification_status_counts,
      computeObservationContentHash(decodedV3).verification_status_counts,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status-column selection prefers vstatus and retains legacy names", () => {
  assert.equal(selectObservationVerificationStatusColumn(
    new Set(["status", "verification_status", "vstatus"]),
  ), "vstatus");
  assert.equal(selectObservationVerificationStatusColumn(
    new Set(["status", "verification_status"]),
  ), "verification_status");
  assert.equal(selectObservationVerificationStatusColumn(new Set(["status"])), "status");
  assert.equal(selectObservationVerificationStatusColumn(new Set()), null);
});


test("fixed-v3 staged manifests must match pinned writer provenance", () => {
  const pinned = "c".repeat(40);
  assert.equal(
    resolveIntegrityTargetWriterGitSha({
      UK_AQ_INTEGRITY_TARGET_WRITER_GIT_SHA: pinned,
    }),
    pinned,
  );
  assert.equal(
    assertCurrentRunManifestWriterGitSha({ writer_git_sha: pinned }, pinned, "manifest.json"),
    pinned,
  );
  for (const writer_git_sha of [null, "C".repeat(40), "c".repeat(39)]) {
    assert.throws(
      () => assertCurrentRunManifestWriterGitSha(
        { writer_git_sha }, pinned, "manifest.json",
      ),
      /writer_git_sha is invalid/,
    );
  }
  assert.throws(
    () => assertCurrentRunManifestWriterGitSha(
      { writer_git_sha: "d".repeat(40) }, pinned, "manifest.json",
    ),
    /contradicts pinned run/,
  );
});

function scopedManifest(dayUtc) {
  const key = `history/_index_v3/observations_timeseries/day_utc=${dayUtc}` +
    "/connector_id=1/pollutant_code=no2/manifest.json";
  const body = Buffer.from(JSON.stringify({
    day_utc: dayUtc, connector_id: 1, pollutant_code: "no2",
  }));
  return {
    root: {
      day_utc: dayUtc, connector_id: 1, pollutant_code: "no2", key,
      byte_size: body.byteLength, sha256: sha256Hex(body),
    },
    object: { key, body, bytes: body.byteLength, content_sha256: sha256Hex(body), source: "dropbox" },
  };
}

test("partial fixed-v3 repair verifies only retained roots from pinned Dropbox", () => {
  const repaired = scopedManifest("2026-06-01");
  const unchanged = scopedManifest("2026-06-04");
  const existingLatest = { payload: { day_summaries: [
    { scoped_roots: [repaired.root] }, { scoped_roots: [unchanged.root] },
  ] } };
  const retained = retainedExactV3ScopedRoots(existingLatest, [{ payload: repaired.root }]);
  assert.deepEqual(retained, [unchanged.root]);
  const requested = [];
  const store = { getObjectFromSourceIfExists(key, source) {
    requested.push([key, source]);
    return key === unchanged.root.key ? unchanged.object : null;
  } };
  assert.deepEqual(verifyRetainedExactV3ScopedRoots(retained, store), retained);
  assert.deepEqual(requested, [[unchanged.root.key, "dropbox"]]);
  assert.ok(!retained.some(({ key }) => key === repaired.root.key),
    "the repaired scope cannot be satisfied by its old baseline object");
});

test("partial fixed-v3 repair fails closed for missing or mismatched retained roots", () => {
  const unchanged = scopedManifest("2026-06-04");
  assert.throws(() => verifyRetainedExactV3ScopedRoots([unchanged.root], {
    getObjectFromSourceIfExists: () => null,
  }), /external dependency is unavailable/);
  assert.throws(() => verifyRetainedExactV3ScopedRoots([
    { ...unchanged.root, sha256: "f".repeat(64) },
  ], { getObjectFromSourceIfExists: () => unchanged.object }), /SHA-256 disagrees/);
  assert.throws(() => verifyRetainedExactV3ScopedRoots([
    { ...unchanged.root, byte_size: unchanged.root.byte_size + 1 },
  ], { getObjectFromSourceIfExists: () => unchanged.object }), /byte size disagrees/);
});

test("pinned latest rejects duplicate and scope-contradictory roots", () => {
  const unchanged = scopedManifest("2026-06-04");
  assert.throws(() => retainedExactV3ScopedRoots({ payload: { day_summaries: [{
    scoped_roots: [unchanged.root, unchanged.root],
  }] } }, []), /duplicate scoped root/);
  assert.throws(() => retainedExactV3ScopedRoots({ payload: { day_summaries: [{
    scoped_roots: [{ ...unchanged.root, day_utc: "2026-06-05" }],
  }] } }, []), /key contradicts scope/);
});
