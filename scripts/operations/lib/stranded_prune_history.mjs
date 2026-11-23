import { isDeepStrictEqual } from "node:util";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { scopedRootDescriptor, validateObservationHistoryExactLeafIndexV3LatestRegistry } from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { verifyObservationHistoryV3UnlistedScope } from "../../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifestKey, buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest, validateR2HistoryV2ObservationsAggregateManifest,
} from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  buildHistoryV2ConnectorManifestKey, buildHistoryV2DayManifestKey, buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { OBSERVATION_HISTORY_COLUMNS_V3 } from "../../../workers/shared/uk_aq_observation_history_schema.mjs";
import { r2GetObjectBounded, sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { digest, encodeMultiset, requireFact } from "./stranded_prune_source.mjs";

const generation = getObservationHistoryGeneration("v3");
const observationsPrefix = generation.observations_prefix;
const indexRoot = generation.observations_timeseries_index_prefix;
const latestKey = generation.observations_timeseries_latest_key;
const maxObjectBytes = 128 * 1024 * 1024;

export function connectorManifestKey(day, connector) {
  return buildHistoryV2ConnectorManifestKey(observationsPrefix, day, connector);
}

function child(parent, list, field, value, key) {
  const matches = parent[list]?.filter((entry) => entry[field] === value);
  requireFact(matches?.length === 1 && matches[0].manifest_key === key, `Missing or contradictory hierarchy reference for ${key}`);
  return matches[0];
}

function children(manifest, field) {
  const refs = manifest[field];
  requireFact(Array.isArray(refs) && isDeepStrictEqual(refs, manifest.child_manifests),
    "Observation manifest child aliases disagree");
  return refs;
}

export async function readSelectedHistory({ r2, baseline, lock, getObject = r2GetObjectBounded }) {
  const identities = new Map();
  const get = async ({ key }) => {
    lock.assertHeld();
    const object = await getObject({ r2, key, max_bytes: maxObjectBytes, timeout_ms: 30_000,
      signal: lock.signal, accept_encoding_identity: true });
    lock.assertHeld();
    const identity = { key, sha256: sha256Hex(object.body), bytes: object.body.byteLength };
    requireFact(!identities.has(key) || isDeepStrictEqual(identities.get(key), identity), `R2 object changed during verification: ${key}`);
    identities.set(key, identity);
    return object;
  };
  const readAggregate = async (key, kind) => {
    const { body } = await get({ key });
    const manifest = validateR2HistoryV2ObservationsAggregateManifest(JSON.parse(body), { basePrefix: observationsPrefix });
    requireFact(manifest.kind === kind && body.equals(serializeR2HistoryV2ObservationsAggregateManifest(manifest,
      { basePrefix: observationsPrefix })), `Invalid canonical aggregate ${key}`);
    return manifest;
  };
  const readManifest = async (key, expected, hash) => {
    const { body } = await get({ key });
    const manifest = JSON.parse(body);
    validateCanonicalHistoryV2Manifest(manifest, { history_version: "v2", domain: "observations", manifest_key: key, ...expected });
    requireFact(manifest.manifest_hash === hash, `Manifest identity differs for ${key}`);
    return manifest;
  };

  const { day_utc: day, connector_id: connector } = baseline;
  const year = Number(day.slice(0, 4));
  const month = day.slice(5, 7);
  const root = await readAggregate(generation.observations_root_key, "uk_aq_observations_root_manifest");
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(observationsPrefix, year);
  const yearRef = child(root, "children", "year", year, yearKey);
  const yearManifest = await readAggregate(yearKey, "uk_aq_observations_year_manifest");
  requireFact(yearManifest.year === year && yearManifest.content_hash === yearRef.content_hash, "Year authority differs");
  const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(observationsPrefix, year, month);
  const monthRef = child(yearManifest, "children", "month", month, monthKey);
  const monthManifest = await readAggregate(monthKey, "uk_aq_observations_month_manifest");
  requireFact(monthManifest.year === year && monthManifest.month === month &&
    monthManifest.content_hash === monthRef.content_hash, "Month authority differs");
  const dayKey = buildHistoryV2DayManifestKey(observationsPrefix, day);
  const dayRef = child(monthManifest, "children", "day_utc", day, dayKey);
  const dayManifest = await readManifest(dayKey, { manifest_kind: "day", day_utc: day }, dayRef.manifest_hash);
  children(dayManifest, "connector_manifests");
  const connectorRef = child(dayManifest, "connector_manifests", "connector_id", connector, baseline.manifest_key);
  requireFact(connectorRef.manifest_hash === baseline.manifest_hash && connectorRef.row_count === baseline.row_count,
    "Committed connector reference differs from the pinned publication");
  const connectorManifest = await readManifest(baseline.manifest_key,
    { manifest_kind: "connector", day_utc: day, connector_id: connector, writer_git_sha: baseline.writer_git_sha }, baseline.manifest_hash);
  const descriptors = children(connectorManifest, "pollutant_manifests");
  requireFact(connectorManifest.row_count === baseline.row_count &&
    isDeepStrictEqual(descriptors.map((descriptor) => descriptor.pollutant_code).sort(), baseline.pollutants),
    "Committed connector scope is incomplete");

  const { body: latestBody } = await get({ key: latestKey });
  const { roots } = validateObservationHistoryExactLeafIndexV3LatestRegistry({
    artifact: { key: latestKey, kind: "observation_history_index_v3_latest_global", publication_stage: "latest_global",
      body: latestBody.toString("utf8"), payload: JSON.parse(latestBody), byte_size: latestBody.length, sha256: sha256Hex(latestBody) },
  });
  const selected = roots.filter((entry) => entry.day_utc === day && entry.connector_id === connector);
  const byPollutant = new Map(selected.map((entry) => [entry.pollutant_code, entry]));
  requireFact(selected.length === baseline.pollutants.length && byPollutant.size === selected.length,
    "Current v3 latest registry differs from connector scope");

  const physicalRows = [];
  const fileKeys = new Set();
  const selectedFiles = [];
  for (const descriptor of descriptors) {
    const code = descriptor.pollutant_code;
    const reference = byPollutant.get(code);
    requireFact(reference && reference.row_count === descriptor.row_count &&
      descriptor.manifest_key === buildHistoryV2PollutantManifestKey(observationsPrefix, day, connector, code),
    "Current v3 pollutant authority differs from the committed connector");
    byPollutant.delete(code);
    // The existing schema-1 verifier rebuilds the graph from independently GET-read
    // canonical Parquet and checks the bytes of every exact index dependency.
    const verified = await verifyObservationHistoryV3UnlistedScope({
      getObject: get, observationsPrefix, indexRoot, descriptor,
      scope: { day_utc: day, connector_id: connector, pollutant_code: code },
    });
    requireFact(verified.canonical_manifest.writer_git_sha === baseline.writer_git_sha &&
      isDeepStrictEqual(scopedRootDescriptor(verified.artifact), reference),
      "Selected v3 scope differs from rebuilt physical authority");
    let partitionRows = 0;
    for (const file of verified.canonical_manifest.files) {
      requireFact(!fileKeys.has(file.key), "Duplicate canonical Parquet file key");
      fileKeys.add(file.key);
      selectedFiles.push(file);
      const { body } = await get({ key: file.key });
      const rows = await parquetReadObjects({
        file: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        columns: [...OBSERVATION_HISTORY_COLUMNS_V3], compressors,
      });
      requireFact(rows.length === file.row_count && rows.every((row) =>
        Number(row.connector_id) === connector && row.pollutant_code === code &&
        row.value !== null && Number.isFinite(Number(row.value)) &&
        new Date(row.observed_at_utc).toISOString().slice(0, 10) === day &&
        (row.verification_status === null || typeof row.verification_status === "string")),
      "Physical Parquet contains an invalid, missing or out-of-scope row");
      partitionRows += rows.length;
      requireFact(physicalRows.length + rows.length <= baseline.row_count, "Parquet exceeds the authorized row count");
      physicalRows.push(...rows);
    }
    requireFact(partitionRows === descriptor.row_count, "Physical pollutant row count disagrees with selected authority");
  }
  requireFact(byPollutant.size === 0 && physicalRows.length === baseline.row_count &&
    isDeepStrictEqual(selectedFiles, connectorManifest.files), "Physical connector multiset or file inventory is incomplete");
  // Recheck the two roots after the physical scan; mutating participants are
  // excluded throughout by the continuous observations operation lock.
  await get({ key: generation.observations_root_key });
  await get({ key: latestKey });
  await lock.assertOwned();
  const encoded = encodeMultiset(physicalRows);
  return { encoded, proof: {
    canonical_multiset_sha256: digest(encoded), row_count: physicalRows.length, file_count: fileKeys.size,
    objects: [...identities.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  } };
}
