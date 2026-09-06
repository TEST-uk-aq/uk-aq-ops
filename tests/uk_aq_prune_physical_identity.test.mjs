import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import { verifyManifestFileIdentity } from "../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  validateObservationPollutantManifestForGate,
  resolvePhaseBRuntimeConfig,
  writeFrozenCandidateObservationsToV2ForTest,
  publishObservationV2DayForTest,
  verifyObservationConnectorHistory,
  verifyOpaqueObservationFileForGate,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

test("Prune verifies manifest SHA-256 identity from downloaded bytes rather than R2 ETag", () => {
  const body = Buffer.from("identity-pinned parquet bytes");
  assert.equal(verifyManifestFileIdentity({
    manifestIdentity: sha256Hex(body), expectedBytes: body.byteLength,
    liveObject: { bytes: body.byteLength, body, etag: '"unrelated"' }, objectKey: "example.parquet",
  }).identity_type, "sha256");
  const replacement = Buffer.from(body);
  replacement[0] ^= 0xff;
  assert.throws(() => verifyManifestFileIdentity({
    manifestIdentity: sha256Hex(body), expectedBytes: body.byteLength,
    liveObject: { bytes: replacement.byteLength, body: replacement, etag: '"unrelated"' },
    objectKey: "example.parquet",
  }), /SHA-256 mismatch/);
});

test("Prune verifies opaque quoted ETag identity with HEAD and no body GET", async () => {
  let getCount = 0;
  const result = await verifyOpaqueObservationFileForGate({
    r2: {}, fileKey: "opaque.parquet",
    manifestIdentity: '"0123456789abcdef0123456789abcdef"', expectedBytes: 1234,
    headObject: async () => ({ exists: true, bytes: 1234, etag: '"0123456789ABCDEF0123456789ABCDEF"' }),
    getObject: async () => { getCount += 1; throw new Error("unexpected GET"); },
  });
  assert.equal(result.identity_type, "etag");
  assert.equal(getCount, 0);
});

test("Prune preserves parent-linked opaque children but keeps active hash metadata fail-closed", () => {
  const base = {
    history_version: "v2",
    manifest_schema_version: 2,
    source_row_count: 24,
    row_count: 24,
    file_count: 1,
    total_bytes: 1234,
    files: [{ bytes: 1234 }],
  };
  const opaque = { ...base, manifest_hash: sha256Hex(JSON.stringify(base)) };
  assert.equal(validateObservationPollutantManifestForGate({
    childManifest: opaque,
    childReference: { manifest_hash: opaque.manifest_hash },
    childKey: "opaque/manifest.json",
    requiresActiveValidation: false,
  }).child_hash, opaque.manifest_hash);
  const invalidActiveWithoutHash = { ...base, observation_content_hash: "invalid" };
  const invalidActive = {
    ...invalidActiveWithoutHash,
    manifest_hash: sha256Hex(JSON.stringify(invalidActiveWithoutHash)),
  };
  assert.throws(() => validateObservationPollutantManifestForGate({
    childManifest: invalidActive,
    childReference: { manifest_hash: invalidActive.manifest_hash },
    childKey: "active/manifest.json",
    requiresActiveValidation: true,
  }), /observation_content_hash must be lower-case SHA-256/);
});

test("Prune publishes canonical v2 bytes and complete pollutant children then verifies targeted v2 index evidence", async () => {
  const dayUtc = "2026-08-18", connectorId = 7;
  const objects = new Map();
  let parquetGets = 0, checkpoints = 0;
  const r2 = { adapter: {
    putObject: async ({key, body}) => { objects.set(key, Buffer.from(body)); return {bytes: body.length}; },
    headObject: async ({key}) => ({exists: objects.has(key), bytes: objects.get(key)?.length, sha256: objects.has(key) ? sha256Hex(objects.get(key)) : null}),
    getObject: async ({key}) => {
      if (key.endsWith('.parquet')) parquetGets++;
      if (!objects.has(key)) throw Object.assign(new Error("missing"), {status:404});
      return {body: objects.get(key)};
    },
  }};
  const runtime = {...resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: "v2", GITHUB_SHA: "3".repeat(40), UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS: "1" }), r2, run_id:"fixture"};
  const rows = [0,1].map(i => ({connector_id:connectorId, station_id:70, timeseries_id:701, pollutant_code:"pm25", observed_at_utc:`${dayUtc}T0${i}:00:00.000Z`, value:9.5+i}));
  const connectorKey=buildHistoryV2ConnectorManifestKey(runtime.committed_prefix,dayUtc,connectorId);
  // A disappeared pollutant must not survive the complete source snapshot.
  objects.set(connectorKey,Buffer.from(JSON.stringify({pollutant_codes:["pm25","no2"]})));
  const writerResult=await writeFrozenCandidateObservationsToV2ForTest({
    candidate:{day_utc:dayUtc,connector_id:connectorId,expected_row_count:2n}, runtime,
    streamClient:{query:async()=>{checkpoints++;return {rows:[]};}},
    frozen:{temp:{ndjsonPath:"unused"},counts:{},sourceIdentity:{}},
    readFrozenRows:async function*(){yield* rows;},cleanupFrozenSource:()=>{},
    backedUpAtUtc:"2026-08-19T00:00:00.000Z",
  });
  assert.equal(checkpoints,2);
  assert.equal(writerResult.written_row_count,2n);
  assert.equal(writerResult.file_count,2);
  assert.deepEqual(writerResult.connector_manifest.pollutant_codes,["pm25"]);
  assert.ok([...objects.keys()].every(key=>key.startsWith('history/v2/observations/')));
  const child=JSON.parse(objects.get(writerResult.connector_manifest.pollutant_manifests[0].manifest_key));
  assert.equal(child.observation_content_hash_row_count,2);
  assert.ok(writerResult.files.every(file=>file.etag_or_hash===sha256Hex(objects.get(file.key))));
  let indexCalls=0;
  const options={runtime, dayUtc, connectorId, manifestKey:connectorKey, expectedRowCount:2n, writerResult,
    updateIndexes:async args=>{
      indexCalls++;
      assert.equal(args.historyVersion,'v2');assert.deepEqual(args.domains,['observations']);
      assert.equal(args.updateLatestIndex,false);
      assert.equal(args.env.UK_AQ_R2_HISTORY_INDEX_V2_PREFIX,'history/_index_v2');
      // Use the actual canonical index-key builder through the verifier below.
      const {buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey:buildKey}=await import('../workers/shared/uk_aq_r2_history_index.mjs');
      const indexKey=buildKey('history/_index_v2/observations_timeseries',dayUtc,connectorId,'pm25');
      objects.set(indexKey,Buffer.from(JSON.stringify({history_version:'v2',domain:'observations',day_utc:dayUtc,connector_id:connectorId,pollutant_code:'pm25',pollutant_manifest_key:child.manifest_key,pollutant_manifest_hash:child.manifest_hash,source_row_count:2,file_count:2,indexed_file_count:2,index_coverage:'complete',timeseries_row_counts:{701:2}})));
      return {observations_timeseries:{warning_count:0,rewritten_connector_index_count:1,timeseries_index_prefix:'history/_index_v2/observations_timeseries',affected_pollutant_indexes:[{key:indexKey}]}};
    },
  };
  const evidence=await verifyObservationConnectorHistory(options);
  assert.equal(evidence.observation_index_generation,'v2');assert.equal(evidence.history_row_count,2);
  assert.equal(indexCalls,1);assert.equal(parquetGets,0);
  const file=writerResult.files[0], saved=objects.get(file.key);objects.set(file.key,Buffer.alloc(saved.length));
  await assert.rejects(verifyObservationConnectorHistory(options),/SHA-256 verification failed/);
  assert.equal(indexCalls,1);
  objects.set(file.key,saved);
  const retained=buildHistoryV2ConnectorManifest({domain:'observations',dayUtc,connectorId:8,runId:'fixture',manifestKey:buildHistoryV2ConnectorManifestKey(runtime.committed_prefix,dayUtc,8),pollutantManifests:[],writerGitSha:'3'.repeat(40),backedUpAtUtc:'2026-08-19T00:00:00.000Z'});
  const {buildHistoryV2DayManifest}=await import('../workers/shared/uk_aq_r2_history_canonical.mjs');
  const dayKey=`${runtime.committed_prefix}/day_utc=${dayUtc}/manifest.json`;
  const previousDay=buildHistoryV2DayManifest({domain:'observations',dayUtc,runId:'fixture',manifestKey:dayKey,connectorManifests:[retained],writerGitSha:'3'.repeat(40),backedUpAtUtc:'2026-08-19T00:00:00.000Z'});
  objects.set(retained.manifest_key,Buffer.from(JSON.stringify(retained)));
  objects.set(dayKey,Buffer.from(JSON.stringify(previousDay)));
  const client={query:async(sql)=>({rows:[{acquired:true,released:true}]})};
  await publishObservationV2DayForTest({client,runtime,dayUtc,publishedCandidates:[{candidate:{day_utc:dayUtc,connector_id:connectorId},connectorGateEvidence:evidence}]});
  assert.deepEqual(JSON.parse(objects.get(dayKey)).connector_manifests.map(c=>c.connector_id),[7,8]);
});
