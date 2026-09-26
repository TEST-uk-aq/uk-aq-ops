#!/usr/bin/env node
// Proposal-only fixed-v3 observation metadata and exact-leaf index planner.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import {
  assertObservationHistoryGenerationKey,
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  buildObservationHistoryExactLeafIndexV3Latest,
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  buildObservationHistoryIndexV3PublicationPlan,
  OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
} from "../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  inspectCanonicalObservationTimeseriesAlignedFiles,
} from "../../workers/shared/uk_aq_observation_history_target_writer.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import {
  readCanonicalObservationRows,
} from "./uk_aq_apply_integrity_proposal.mjs";
import {
  buildHistoryV2DayManifestKey,
  buildHistoryV2PartKey,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  createCombinedLocalStore,
  isChangedCurrentRunObject,
  resolveCurrentRunProposalOwner,
  runV2ObservationsRepair as runGenerationNeutralObservationMetadataRepair,
  SOURCE_DERIVED_OWNER,
} from "./uk_aq_execute_v2_observations_repair_impl.mjs";
import {
  validateFinalPlannerProposalGraph,
} from "./uk_aq_execute_v2_observations_repair.mjs";
import {
  validateIntegrityCoreSnapshotIdentity,
} from "./lib/uk_aq_integrity_core_snapshot_identity.mjs";

const GENERATION = getObservationHistoryGeneration("v3");
const FULL_LOWER_GIT_SHA = /^[0-9a-f]{40}$/;

export function resolveIntegrityTargetWriterGitSha(env) {
  const value = String(env?.UK_AQ_INTEGRITY_TARGET_WRITER_GIT_SHA || "").trim();
  if (!FULL_LOWER_GIT_SHA.test(value)) {
    throw new Error(
      "UK_AQ_INTEGRITY_TARGET_WRITER_GIT_SHA must be a full lower-case Git SHA",
    );
  }
  return value;
}

export function assertCurrentRunManifestWriterGitSha(manifest, targetWriterGitSha, key) {
  const staged = manifest?.writer_git_sha;
  if (!FULL_LOWER_GIT_SHA.test(String(staged ?? ""))) {
    throw new Error(`Fixed-v3 staged manifest writer_git_sha is invalid: ${key}`);
  }
  if (staged !== targetWriterGitSha) {
    throw new Error(`Fixed-v3 staged manifest writer_git_sha contradicts pinned run: ${key}`);
  }
  return targetWriterGitSha;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileRange(file, field, operation) {
  return file.row_groups.reduce((value, group) => {
    const candidate = group[field];
    return value === null ? candidate : operation(value, candidate);
  }, null);
}

function metadataRange(metadata, field, operation) {
  return metadata.files.reduce((value, file) => {
    const candidate = fileRange(file, field, operation);
    return value === null ? candidate : operation(value, candidate);
  }, null);
}

function assertFixedV3ManifestPhysicalSchema(manifest, manifestKey) {
  if (
    manifest.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    manifest.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    !sameJson(manifest.columns, OBSERVATION_HISTORY_COLUMNS_V3)
  ) {
    throw new Error(`Fixed-v3 manifest physical schema is unsupported: ${manifestKey}`);
  }
}

function assertFixedV3ManifestMetadata(manifest, metadata, manifestKey) {
  const expectedContentMetadata = {
    observation_content_hash: metadata.observation_content_hash,
    observation_content_hash_algorithm: metadata.observation_content_hash_algorithm,
    observation_content_hash_contract_version:
      metadata.observation_content_hash_contract_version,
    observation_content_hash_row_count:
      metadata.observation_content_hash_row_count,
    observation_content_hash_columns: metadata.observation_content_hash_columns,
    verification_status_counts: metadata.verification_status_counts,
  };
  for (const [field, expected] of Object.entries(expectedContentMetadata)) {
    if (!sameJson(manifest[field], expected)) {
      throw new Error(`Fixed-v3 manifest ${field} disagrees: ${manifestKey}`);
    }
  }
  if (
    Number(manifest.row_count) !== metadata.row_count ||
    Number(manifest.source_row_count) !== metadata.row_count ||
    Number(manifest.file_count) !== metadata.file_count ||
    Number(manifest.total_bytes) !== metadata.files.reduce(
      (sum, file) => sum + file.byte_size,
      0,
    )
  ) {
    throw new Error(`Fixed-v3 manifest partition totals disagree: ${manifestKey}`);
  }
  const aggregateTimeseriesCounts = {};
  for (const file of metadata.files) {
    for (const [timeseriesId, count] of Object.entries(file.timeseries_row_counts)) {
      aggregateTimeseriesCounts[timeseriesId] =
        (aggregateTimeseriesCounts[timeseriesId] || 0) + count;
    }
  }
  const aggregateMetadata = {
    min_timeseries_id: metadataRange(metadata, "min_timeseries_id", Math.min),
    max_timeseries_id: metadataRange(metadata, "max_timeseries_id", Math.max),
    min_observed_at_utc: metadataRange(
      metadata,
      "min_observed_at_utc",
      (left, right) => left < right ? left : right,
    ),
    max_observed_at_utc: metadataRange(
      metadata,
      "max_observed_at_utc",
      (left, right) => left > right ? left : right,
    ),
    timeseries_row_counts: aggregateTimeseriesCounts,
  };
  if (Object.entries(aggregateMetadata).some(
    ([field, value]) => !sameJson(manifest[field], value),
  )) {
    throw new Error(`Fixed-v3 manifest aggregate metadata disagrees: ${manifestKey}`);
  }
  const manifestFiles = new Map((manifest.files || []).map((file) => [String(file?.key), file]));
  if (manifestFiles.size !== metadata.files.length) {
    throw new Error(`Fixed-v3 manifest file identities disagree: ${manifestKey}`);
  }
  for (const file of metadata.files) {
    const expected = manifestFiles.get(file.key);
    const actual = {
      row_count: file.row_count,
      bytes: file.byte_size,
      etag_or_hash: file.sha256,
      min_timeseries_id: fileRange(file, "min_timeseries_id", Math.min),
      max_timeseries_id: fileRange(file, "max_timeseries_id", Math.max),
      min_observed_at_utc: fileRange(
        file,
        "min_observed_at_utc",
        (left, right) => left < right ? left : right,
      ),
      max_observed_at_utc: fileRange(
        file,
        "max_observed_at_utc",
        (left, right) => left > right ? left : right,
      ),
      timeseries_row_counts: file.timeseries_row_counts,
    };
    if (!expected || Object.entries(actual).some(
      ([field, value]) => !sameJson(expected[field], value),
    )) {
      throw new Error(`Fixed-v3 manifest file metadata disagrees: ${file.key}`);
    }
  }
}

export async function inspectPinnedBaselinePollutantPartition({
  manifest,
  manifestKey,
  manifestObject,
  scope,
  getPinnedObject,
}) {
  validateCanonicalHistoryV2Manifest(manifest, {
    manifest_kind: "pollutant",
    domain: "observations",
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    manifest_key: manifestKey,
  });
  assertFixedV3ManifestPhysicalSchema(manifest, manifestKey);
  const manifestFileKeys = (manifest.files || []).map((file) => String(file?.key || ""));
  const parquetKeys = (manifest.parquet_object_keys || []).map(String);
  if (
    new Set(manifestFileKeys).size !== manifestFileKeys.length ||
    !sameJson(manifestFileKeys, parquetKeys)
  ) {
    throw new Error(`Fixed-v3 pinned manifest Parquet membership disagrees: ${manifestKey}`);
  }
  const files = [];
  for (const [ordinal, parquetKey] of parquetKeys.entries()) {
    assertObservationHistoryGenerationKey(GENERATION, parquetKey, "observations");
    const object = getPinnedObject(parquetKey);
    if (!object) {
      throw new Error(`Fixed-v3 pinned canonical Parquet is unavailable: ${parquetKey}`);
    }
    const body = Buffer.from(object.body);
    const entry = manifest.files[ordinal];
    if (
      body.byteLength !== Number(entry.bytes) ||
      sha256Hex(body) !== String(entry.etag_or_hash)
    ) {
      throw new Error(`Fixed-v3 pinned canonical Parquet identity disagrees: ${parquetKey}`);
    }
    files.push({
      key: parquetKey,
      body,
      rows: await readCanonicalObservationRows({
        body,
        connectorId: scope.connector_id,
      }),
    });
  }
  const inspected = inspectCanonicalObservationTimeseriesAlignedFiles(files, {
    limits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
    partition: scope,
    fileKeyForOrdinal: (ordinal) => buildHistoryV2PartKey(
      GENERATION.observations_prefix,
      scope.day_utc,
      scope.connector_id,
      scope.pollutant_code,
      ordinal,
    ),
  });
  assertFixedV3ManifestMetadata(manifest, inspected.metadata, manifestKey);
  const manifestBody = Buffer.from(manifestObject.body);
  return {
    target_metadata: inspected.metadata,
    canonical_manifest: {
      key: manifestKey,
      byte_size: manifestBody.byteLength,
      sha256: sha256Hex(manifestBody),
      manifest_hash: String(manifest.manifest_hash),
      row_count: Number(manifest.row_count),
      observation_content_hash: String(manifest.observation_content_hash),
    },
  };
}

export function assertCurrentRunParquetIdentities(fileIntents, getObject) {
  for (const intent of fileIntents || []) {
    const actual = getObject(intent.key);
    if (!actual || exactIdentity(actual, actual.source).sha256 !== intent.sha256
      || exactIdentity(actual, actual.source).bytes !== intent.byte_size) {
      throw new Error(`Fixed-v3 staged Parquet identity disagrees: ${intent.key}`);
    }
  }
}

const POLLUTANT_MANIFEST = new RegExp(
  `^${GENERATION.observations_prefix}/day_utc=(\\d{4}-\\d{2}-\\d{2})/` +
  "connector_id=([1-9]\\d*)/pollutant_code=([a-z0-9_]+)/manifest\\.json$",
);

function argvValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function resolvedEnvironment(env, argv) {
  return {
    ...env,
    UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT:
      argvValue(argv, "--overlay-root") || env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT,
    UK_AQ_R2_HISTORY_DROPBOX_ROOT:
      argvValue(argv, "--dropbox-root") || env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
    UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON:
      argvValue(argv, "--run-state-json") || env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON,
  };
}

function resolveRepairPlan({ argv, repairPlan }) {
  if (repairPlan) return repairPlan;
  if (argv.includes("--repair-plan-stdin")) return JSON.parse(fs.readFileSync(0, "utf8"));
  const path = argvValue(argv, "--repair-plan-json");
  if (!path) throw new Error("--repair-plan-json or --repair-plan-stdin is required");
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function exactIdentity(object, source) {
  return {
    sha256: String(object.content_sha256 || object.sha256 || sha256Hex(object.body)),
    bytes: Number(object.bytes ?? object.byte_size ?? Buffer.byteLength(object.body)),
    source,
  };
}

function currentRunCanonicalIdentity({ key, runState, store, reference = null }) {
  const staged = runState?.objects?.[key];
  if (!isChangedCurrentRunObject(staged) || staged?.built !== true
      || resolveCurrentRunProposalOwner(staged) !== SOURCE_DERIVED_OWNER) {
    return null;
  }
  const frozen = {
    sha256: String(staged.sha256 || staged.content_sha256 || ""),
    bytes: Number(staged.bytes),
    source: "planned_overlay",
  };
  if (!/^[a-f0-9]{64}$/.test(frozen.sha256)
      || !Number.isSafeInteger(frozen.bytes) || frozen.bytes < 0) {
    throw new Error(`Fixed-v3 current-run canonical dependency identity is invalid: ${key}`);
  }
  const overlay = store.getObjectFromSourceIfExists(key, "overlay");
  if (!overlay || overlay.source !== "planned_overlay") {
    throw new Error(`Fixed-v3 current-run canonical dependency is unavailable: ${key}`);
  }
  const actual = exactIdentity(overlay, overlay.source);
  if (actual.sha256 !== frozen.sha256 || actual.bytes !== frozen.bytes
      || (reference && (actual.sha256 !== String(reference.sha256)
        || actual.bytes !== Number(reference.byte_size)))) {
    throw new Error(`Fixed-v3 current-run canonical dependency identity disagrees: ${key}`);
  }
  return frozen;
}

function proposalObject(proposal) {
  const body = Buffer.from(String(proposal.proposed_body ?? proposal.body ?? ""), "utf8");
  return {
    key: String(proposal.key), body, bytes: body.byteLength,
    content_sha256: String(proposal.new_sha256 || sha256Hex(body)),
    source: "planned_overlay",
  };
}

function artifactFromStoredObject(object, kind, stage) {
  const body = Buffer.from(object.body);
  return {
    kind, key: object.key, body: body.toString("utf8"),
    payload: JSON.parse(body.toString("utf8")),
    byte_size: body.byteLength, sha256: sha256Hex(body),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage, dependencies: [], publication_prerequisites: [],
  };
}

function scopeIdentity(value) {
  return `${value?.day_utc}\u0000${value?.connector_id}\u0000${value?.pollutant_code}`;
}

function rootDescriptor(artifact) {
  return {
    day_utc: artifact.payload.day_utc,
    connector_id: artifact.payload.connector_id,
    pollutant_code: artifact.payload.pollutant_code,
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
  };
}

function sameRootIdentity(left, right) {
  return left?.key === right?.key
    && Number(left?.byte_size) === Number(right?.byte_size)
    && String(left?.sha256 || "") === String(right?.sha256 || "");
}

function proposalBody(proposal, key) {
  const value = proposal?.proposed_body ?? proposal?.body;
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    throw new Error(`Fixed-v3 proposed canonical body is unavailable: ${key}`);
  }
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
}

function parseJsonBody(body, key) {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new Error(`Fixed-v3 pinned canonical JSON is invalid: ${key}`);
  }
}

function readPinnedAggregate({ store, key, level }) {
  const object = store.getObjectFromSourceIfExists(key, "dropbox");
  if (!object) {
    throw new Error(`Fixed-v3 pinned observation ${level} aggregate is unavailable: ${key}`);
  }
  const parsed = parseJsonBody(object.body, key);
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(parsed, {
    basePrefix: GENERATION.observations_prefix,
  });
  const canonicalBody = serializeR2HistoryV2ObservationsAggregateManifest(canonical, {
    basePrefix: GENERATION.observations_prefix,
  });
  if (!Buffer.from(object.body).equals(canonicalBody)) {
    throw new Error(`Fixed-v3 pinned observation ${level} aggregate bytes are noncanonical: ${key}`);
  }
  return { object, payload: canonical, body: canonicalBody };
}

function validatePinnedDayManifest({ store, reference }) {
  const key = String(reference?.manifest_key || "");
  const object = store.getObjectFromSourceIfExists(key, "dropbox");
  if (!object) {
    throw new Error(`Fixed-v3 pinned observation day manifest is unavailable: ${key}`);
  }
  const payload = parseJsonBody(object.body, key);
  validateCanonicalHistoryV2Manifest(payload, {
    manifest_kind: "day",
    domain: "observations",
    day_utc: reference.day_utc,
    manifest_key: key,
  });
  if (payload.manifest_hash !== reference.manifest_hash) {
    throw new Error(`Fixed-v3 pinned observation day identity disagrees: ${key}`);
  }
  return payload;
}

function validateProposedDayManifest({ proposal, dayUtc }) {
  const key = buildHistoryV2DayManifestKey(GENERATION.observations_prefix, dayUtc);
  if (!proposal || String(proposal.key) !== key) {
    throw new Error(`Fixed-v3 selected day proposal is unavailable: ${key}`);
  }
  const body = proposalBody(proposal, key);
  const payload = parseJsonBody(body, key);
  validateCanonicalHistoryV2Manifest(payload, {
    manifest_kind: "day",
    domain: "observations",
    day_utc: dayUtc,
    manifest_key: key,
  });
  if (sha256Hex(body) !== String(proposal.new_sha256)
      || body.byteLength !== Number(proposal.bytes)) {
    throw new Error(`Fixed-v3 selected day proposal identity disagrees: ${key}`);
  }
  return payload;
}

function aggregateProposal({ key, kind, stage, body, existing, dependencies, proposalsByKey }) {
  const dependencyIdentities = Object.fromEntries(dependencies.map((dependencyKey) => {
    const dependency = proposalsByKey.get(dependencyKey);
    if (!dependency?.changed) {
      throw new Error(`Fixed-v3 aggregate dependency is not staged: ${dependencyKey}`);
    }
    return [dependencyKey, {
      sha256: String(dependency.new_sha256),
      bytes: Number(dependency.bytes),
      source: "planned_overlay",
    }];
  }));
  return {
    key,
    kind,
    publication_stage: stage,
    day_utc: null,
    bytes: body.byteLength,
    old_sha256: existing ? sha256Hex(existing.body) : null,
    new_sha256: sha256Hex(body),
    changed: true,
    included_in_write_set: true,
    status: "planned",
    dependencies,
    dependency_identities: dependencyIdentities,
    baseline_source: existing ? "dropbox" : null,
    provenance: "pinned_dropbox_aggregate_hierarchy_plus_selected_day_overlay",
    proposed_body: body.toString("utf8"),
  };
}

export function reconstructCanonicalObservationAggregateHierarchy({
  proposals,
  proposalsByKey,
  selectedDays,
  store,
}) {
  const basePrefix = GENERATION.observations_prefix;
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(basePrefix);
  const pinnedRoot = readPinnedAggregate({ store, key: rootKey, level: "root" });
  const selectedByMonth = new Map();
  for (const dayUtc of [...new Set(selectedDays)].sort()) {
    const monthIdentity = dayUtc.slice(0, 7);
    if (!selectedByMonth.has(monthIdentity)) selectedByMonth.set(monthIdentity, []);
    selectedByMonth.get(monthIdentity).push(dayUtc);
  }
  const selectedYears = new Set([...selectedByMonth.keys()].map((value) => value.slice(0, 4)));
  const rebuiltMonths = new Map();
  const pinnedYears = new Map();
  const pinnedMonths = new Map();
  const stagedAggregateKeys = new Set();

  for (const rootChild of pinnedRoot.payload.children) {
    const year = String(rootChild.year);
    const yearKey = buildR2HistoryV2ObservationsYearManifestKey(basePrefix, year);
    if (rootChild.manifest_key !== yearKey) {
      throw new Error(`Fixed-v3 pinned observation root child identity disagrees: ${yearKey}`);
    }
    const pinnedYear = readPinnedAggregate({ store, key: yearKey, level: "year" });
    if (String(pinnedYear.payload.year) !== year
        || pinnedYear.payload.content_hash !== rootChild.content_hash) {
      throw new Error(`Fixed-v3 pinned observation year identity disagrees: ${yearKey}`);
    }
    pinnedYears.set(year, pinnedYear);
    if (!selectedYears.has(year)) continue;
    for (const monthChild of pinnedYear.payload.children) {
      const month = String(monthChild.month);
      const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, year, month);
      if (monthChild.manifest_key !== monthKey) {
        throw new Error(`Fixed-v3 pinned observation year child identity disagrees: ${monthKey}`);
      }
      const pinnedMonth = readPinnedAggregate({ store, key: monthKey, level: "month" });
      if (String(pinnedMonth.payload.year) !== year || pinnedMonth.payload.month !== month
          || pinnedMonth.payload.content_hash !== monthChild.content_hash) {
        throw new Error(`Fixed-v3 pinned observation month identity disagrees: ${monthKey}`);
      }
      pinnedMonths.set(`${year}-${month}`, pinnedMonth);
    }
  }

  for (const [monthIdentity, selectedMonthDays] of selectedByMonth) {
    const [year, month] = monthIdentity.split("-");
    const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, year, month);
    const pinnedMonth = pinnedMonths.get(monthIdentity) || null;
    const existingDays = new Map();
    if (pinnedMonth) {
      for (const dayChild of pinnedMonth.payload.children) {
        validatePinnedDayManifest({ store, reference: dayChild });
        existingDays.set(dayChild.day_utc, dayChild);
      }
    }
    for (const dayUtc of selectedMonthDays) {
      const dayKey = buildHistoryV2DayManifestKey(basePrefix, dayUtc);
      const payload = validateProposedDayManifest({
        proposal: proposalsByKey.get(dayKey),
        dayUtc,
      });
      existingDays.set(dayUtc, {
        day_utc: dayUtc,
        manifest_key: dayKey,
        manifest_hash: payload.manifest_hash,
      });
    }
    const payload = buildR2HistoryV2ObservationsMonthManifest({
      basePrefix,
      year,
      month,
      dayManifests: [...existingDays.values()],
    });
    const body = serializeR2HistoryV2ObservationsAggregateManifest(payload, { basePrefix });
    rebuiltMonths.set(monthIdentity, payload);
    if (!pinnedMonth || !body.equals(pinnedMonth.body)) {
      const dependencies = selectedMonthDays
        .map((dayUtc) => buildHistoryV2DayManifestKey(basePrefix, dayUtc))
        .filter((key) => proposalsByKey.get(key)?.changed === true)
        .sort();
      const proposal = aggregateProposal({
        key: monthKey,
        kind: "observation_month_manifest",
        stage: "observation_month_manifest",
        body,
        existing: pinnedMonth?.object || null,
        dependencies,
        proposalsByKey,
      });
      proposals.push(proposal);
      proposalsByKey.set(monthKey, proposal);
      stagedAggregateKeys.add(monthKey);
    }
  }

  const rebuiltYears = new Map();
  for (const year of [...selectedYears].sort()) {
    const yearKey = buildR2HistoryV2ObservationsYearManifestKey(basePrefix, year);
    const pinnedYear = pinnedYears.get(year) || null;
    const monthManifests = new Map();
    for (const child of pinnedYear?.payload.children || []) {
      monthManifests.set(String(child.month), {
        year,
        month: child.month,
        manifest_key: child.manifest_key,
        content_hash: child.content_hash,
      });
    }
    for (const [monthIdentity, payload] of rebuiltMonths) {
      if (monthIdentity.slice(0, 4) === year) {
        monthManifests.set(payload.month, payload);
      }
    }
    const payload = buildR2HistoryV2ObservationsYearManifest({
      basePrefix,
      year,
      monthManifests: [...monthManifests.values()],
    });
    const body = serializeR2HistoryV2ObservationsAggregateManifest(payload, { basePrefix });
    rebuiltYears.set(year, payload);
    if (!pinnedYear || !body.equals(pinnedYear.body)) {
      const dependencies = [...monthManifests.values()]
        .map((child) => child.manifest_key
          || buildR2HistoryV2ObservationsMonthManifestKey(
            basePrefix, year, child.month,
          ))
        .filter((key) => stagedAggregateKeys.has(key))
        .sort();
      const proposal = aggregateProposal({
        key: yearKey,
        kind: "observation_year_manifest",
        stage: "observation_year_manifest",
        body,
        existing: pinnedYear?.object || null,
        dependencies,
        proposalsByKey,
      });
      proposals.push(proposal);
      proposalsByKey.set(yearKey, proposal);
      stagedAggregateKeys.add(yearKey);
    }
  }
  const rootYears = new Map(pinnedRoot.payload.children.map((child) => [
    String(child.year), child,
  ]));
  for (const [year, payload] of rebuiltYears) rootYears.set(year, payload);
  const rootPayload = buildR2HistoryV2ObservationsRootManifest({
    basePrefix,
    yearManifests: [...rootYears.values()],
  });
  const rootBody = serializeR2HistoryV2ObservationsAggregateManifest(rootPayload, { basePrefix });
  if (!rootBody.equals(pinnedRoot.body)) {
    const dependencies = [...rootYears.values()]
      .map((child) => child.manifest_key
        || buildR2HistoryV2ObservationsYearManifestKey(basePrefix, child.year))
      .filter((key) => stagedAggregateKeys.has(key))
      .sort();
    const proposal = aggregateProposal({
      key: rootKey,
      kind: "observation_root_manifest",
      stage: "observation_root_manifest",
      body: rootBody,
      existing: pinnedRoot.object,
      dependencies,
      proposalsByKey,
    });
    proposals.push(proposal);
    proposalsByKey.set(rootKey, proposal);
    stagedAggregateKeys.add(rootKey);
  }
  return {
    root: {
      key: rootKey,
      byte_size: rootBody.byteLength,
      sha256: sha256Hex(rootBody),
    },
    staged_keys: [...stagedAggregateKeys].sort(),
  };
}

export function reconcileReconstructedExactV3Hierarchies({
  existingLatest,
  hierarchies,
}) {
  const oldRoots = (Array.isArray(existingLatest?.payload?.day_summaries)
    ? existingLatest.payload.day_summaries : []).flatMap((summary) =>
    Array.isArray(summary?.scoped_roots) ? summary.scoped_roots : []);
  const oldByScope = new Map();
  for (const root of oldRoots) {
    const identity = scopeIdentity(root);
    if (oldByScope.has(identity)) {
      throw new Error(`Pinned v3 latest has duplicate scoped root: ${root?.key || identity}`);
    }
    oldByScope.set(identity, root);
  }
  const changedHierarchies = [];
  const unchangedRoots = [];
  const reconstructedScopes = new Set();
  for (const hierarchy of hierarchies) {
    const reconstructed = rootDescriptor(hierarchy.scoped_manifest);
    reconstructedScopes.add(scopeIdentity(reconstructed));
    const previous = oldByScope.get(scopeIdentity(reconstructed));
    if (sameRootIdentity(previous, reconstructed)) unchangedRoots.push(reconstructed);
    else changedHierarchies.push(hierarchy);
  }
  const latest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: hierarchies,
    indexRoot: GENERATION.observations_timeseries_index_prefix,
    latestKey: GENERATION.observations_timeseries_latest_key,
  });
  const removedScopes = oldRoots
    .filter((root) => !reconstructedScopes.has(scopeIdentity(root)))
    .map((root) => ({
      day_utc: root.day_utc,
      connector_id: root.connector_id,
      pollutant_code: root.pollutant_code,
      exact_prefix: `${GENERATION.observations_timeseries_index_prefix}/day_utc=${root.day_utc}` +
        `/connector_id=${root.connector_id}/pollutant_code=${root.pollutant_code}`,
      aligned_prefix: `${GENERATION.observations_timeseries_index_prefix}/_aligned/day_utc=${root.day_utc}` +
        `/connector_id=${root.connector_id}/pollutant_code=${root.pollutant_code}`,
    }));
  return { latest, changedHierarchies, unchangedRoots, removedScopes };
}

function scopeFromPollutantManifestKey(manifestKey) {
  const match = String(manifestKey).match(POLLUTANT_MANIFEST);
  if (!match) throw new Error(`Fixed-v3 pollutant manifest key is invalid: ${manifestKey}`);
  return Object.freeze({
    day_utc: match[1],
    connector_id: Number(match[2]),
    pollutant_code: match[3],
  });
}

function removedScopeDescriptor(scope) {
  return Object.freeze({
    ...scope,
    exact_prefix: `${GENERATION.observations_timeseries_index_prefix}/day_utc=${scope.day_utc}` +
      `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`,
    aligned_prefix: `${GENERATION.observations_timeseries_index_prefix}/_aligned/day_utc=${scope.day_utc}` +
      `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`,
  });
}

function canonicalIsoTimestamp(value, label) {
  const text = String(value || "");
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${label} is not a canonical ISO timestamp`);
  }
  return text;
}

export function inspectExactV3PollutantManifestCatalogueEntry({
  manifestKey,
  manifestObject,
}) {
  const scope = scopeFromPollutantManifestKey(manifestKey);
  const body = Buffer.from(manifestObject?.body || []);
  const manifest = parseJsonBody(body, manifestKey);
  validateCanonicalHistoryV2Manifest(manifest, {
    manifest_kind: "pollutant",
    domain: "observations",
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    manifest_key: manifestKey,
  });
  assertFixedV3ManifestPhysicalSchema(manifest, manifestKey);
  const fileKeys = (manifest.files || []).map((file) => String(file?.key || ""));
  const parquetKeys = (manifest.parquet_object_keys || []).map(String);
  const timeseriesCounts = Object.entries(manifest.timeseries_row_counts || {});
  const rowCount = Number(manifest.row_count);
  const timeseriesCount = timeseriesCounts.length;
  const minObservedAtUtc = canonicalIsoTimestamp(
    manifest.min_observed_at_utc,
    `${manifestKey}.min_observed_at_utc`,
  );
  const maxObservedAtUtc = canonicalIsoTimestamp(
    manifest.max_observed_at_utc,
    `${manifestKey}.max_observed_at_utc`,
  );
  if (
    !Number.isSafeInteger(rowCount) || rowCount <= 0 ||
    !Number.isSafeInteger(Number(manifest.file_count)) || Number(manifest.file_count) <= 0 ||
    Number(manifest.file_count) !== fileKeys.length ||
    fileKeys.length !== new Set(fileKeys).size ||
    !sameJson(fileKeys, parquetKeys) ||
    timeseriesCount <= 0 ||
    timeseriesCounts.some(([timeseriesId, count]) =>
      !Number.isSafeInteger(Number(timeseriesId)) || Number(timeseriesId) <= 0 ||
      !Number.isSafeInteger(Number(count)) || Number(count) <= 0
    ) ||
    timeseriesCounts.reduce((sum, [, count]) => sum + Number(count), 0) !== rowCount ||
    minObservedAtUtc > maxObservedAtUtc
  ) {
    throw new Error(`Fixed-v3 manifest catalogue summary is contradictory: ${manifestKey}`);
  }
  return Object.freeze({
    key: manifestKey,
    scope,
    scope_id: scopeIdentity(scope),
    manifest,
    manifest_object: manifestObject,
    identity: Object.freeze({
      key: manifestKey,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
    }),
    summary: Object.freeze({
      row_count: rowCount,
      timeseries_count: timeseriesCount,
      child_shard_count: timeseriesCount,
      physical_leaf_count: timeseriesCount,
      physical_file_count: fileKeys.length,
      min_observed_at_utc: minObservedAtUtc,
      max_observed_at_utc: maxObservedAtUtc,
    }),
  });
}

export function buildExactV3ManifestCatalogue({ manifestKeys, getObject }) {
  const entries = [];
  const byScope = new Map();
  for (const manifestKey of [...manifestKeys].sort()) {
    const manifestObject = getObject(manifestKey);
    if (!manifestObject) {
      throw new Error(`Fixed-v3 pollutant manifest is unavailable: ${manifestKey}`);
    }
    const entry = inspectExactV3PollutantManifestCatalogueEntry({
      manifestKey,
      manifestObject,
    });
    if (byScope.has(entry.scope_id)) {
      throw new Error(`Fixed-v3 manifest catalogue has duplicate scope: ${manifestKey}`);
    }
    byScope.set(entry.scope_id, entry);
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error("Fixed-v3 manifest catalogue has no scopes");
  return Object.freeze({ entries: Object.freeze(entries), by_scope: byScope });
}

export function deriveExactV3ManifestDelta({ finalCatalogue, baselineObjects }) {
  const baselineByKey = new Map((baselineObjects || []).map((entry) => [entry.key, entry]));
  const finalKeys = new Set(finalCatalogue.entries.map(({ key }) => key));
  const affectedEntries = finalCatalogue.entries.filter((entry) => {
    const baseline = baselineByKey.get(entry.key);
    return !baseline || Number(baseline.size) !== entry.identity.byte_size ||
      String(baseline.content_sha256 || "") !== entry.identity.sha256;
  });
  const removedScopes = [...baselineByKey.keys()]
    .filter((key) => POLLUTANT_MANIFEST.test(key) && !finalKeys.has(key))
    .sort()
    .map((key) => removedScopeDescriptor(scopeFromPollutantManifestKey(key)));
  return Object.freeze({
    affected_entries: Object.freeze(affectedEntries),
    affected_scope_ids: new Set(affectedEntries.map(({ scope_id }) => scope_id)),
    new_scope_count: affectedEntries.filter(({ key }) => !baselineByKey.has(key)).length,
    changed_scope_count: affectedEntries.filter(({ key }) => baselineByKey.has(key)).length,
    removed_scopes: Object.freeze(removedScopes),
    removed_scope_ids: new Set(removedScopes.map((scope) => scopeIdentity(scope))),
  });
}

export function crossCheckExactV3RegistryCatalogue({ registryRoots, finalCatalogue, delta }) {
  const registryByScope = new Map();
  for (const root of registryRoots) {
    const identity = scopeIdentity(root);
    if (registryByScope.has(identity)) {
      throw new Error(`Compact latest registry has duplicate scope: ${root.key}`);
    }
    registryByScope.set(identity, root);
  }
  for (const entry of finalCatalogue.entries) {
    const root = registryByScope.get(entry.scope_id);
    if (!root) {
      if (!delta.affected_scope_ids.has(entry.scope_id)) {
        throw new Error(`Compact latest registry is missing unchanged scope: ${entry.key}`);
      }
      continue;
    }
    if (delta.affected_scope_ids.has(entry.scope_id)) continue;
    for (const [field, expected] of Object.entries(entry.summary)) {
      if (root[field] !== expected) {
        throw new Error(`Compact latest registry contradicts unchanged scope ${field}: ${root.key}`);
      }
    }
  }
  for (const root of registryRoots) {
    const identity = scopeIdentity(root);
    if (!finalCatalogue.by_scope.has(identity) && !delta.removed_scope_ids.has(identity)) {
      throw new Error(`Compact latest registry has an unexplained extra scope: ${root.key}`);
    }
  }
  return true;
}

export function authenticateExactV3CompactLatest({ runState, store }) {
  const checkpoint = runState?.dropbox_currentness?.checkpoint;
  const expected = checkpoint?.observations_timeseries_latest;
  if (runState?.dropbox_currentness?.allowed !== true || !expected) {
    throw new Error("Accepted checkpoint has no authenticated compact latest identity");
  }
  const key = GENERATION.observations_timeseries_latest_key;
  if (expected.key !== key) {
    throw new Error(`Checkpoint compact latest key disagrees: ${expected.key || "unset"}`);
  }
  const object = store.getObjectFromSourceIfExists(key, "dropbox");
  if (!object) throw new Error("Checkpoint compact latest body is unavailable from Dropbox");
  const actual = exactIdentity(object, "dropbox");
  if (actual.bytes !== Number(expected.byte_size) || actual.sha256 !== expected.sha256) {
    throw new Error("Checkpoint compact latest body identity disagrees");
  }
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({
    artifact: artifactFromStoredObject(
      object,
      "observation_history_index_v3_latest_global",
      "latest_global",
    ),
    indexRoot: GENERATION.observations_timeseries_index_prefix,
    latestKey: key,
  });
}

export function resolveExactV3PlanningAuthority({
  runState,
  store,
  finalCatalogue,
  delta,
}) {
  let compactLatest = null;
  try {
    compactLatest = authenticateExactV3CompactLatest({ runState, store });
    crossCheckExactV3RegistryCatalogue({
      registryRoots: compactLatest.roots,
      finalCatalogue,
      delta,
    });
    return Object.freeze({
      mode: "exact_index_fast_path",
      compact_latest: compactLatest,
      fallback_reason: null,
    });
  } catch (error) {
    return Object.freeze({
      mode: "full_canonical_reconstruction_fallback",
      compact_latest: compactLatest,
      fallback_reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveExactV3LocalReferences({
  artifacts,
  changedKeys,
  proposalsByKey,
  plannedCanonicalKeys = new Set(),
  runState = null,
  store,
  unchangedRoots,
}) {
  const resolved = new Map(unchangedRoots.map((root) => [root.key, {
    key: root.key,
    byte_size: root.byte_size,
    sha256: root.sha256,
    verified: true,
    durable: true,
  }]));
  for (const artifact of artifacts) {
    for (const reference of [
      ...(artifact.dependencies || []),
      ...(artifact.publication_prerequisites || []),
    ]) {
      if (changedKeys.has(reference.key)) continue;
      const plannedCanonical = proposalsByKey.get(reference.key);
      if (plannedCanonical?.changed === true
          || (plannedCanonical && plannedCanonicalKeys.has(reference.key))) {
        resolved.set(reference.key, {
          key: reference.key,
          byte_size: Number(plannedCanonical.bytes),
          sha256: String(plannedCanonical.new_sha256),
          verified: true,
          durable: true,
        });
        continue;
      }
      const currentRunIdentity = currentRunCanonicalIdentity({
        key: reference.key,
        runState,
        store,
        reference,
      });
      if (currentRunIdentity) {
        resolved.set(reference.key, {
          key: reference.key,
          byte_size: currentRunIdentity.bytes,
          sha256: currentRunIdentity.sha256,
          verified: true,
          durable: true,
        });
        continue;
      }
      const local = store.getObjectFromSourceIfExists(reference.key, "dropbox");
      if (!local) {
        if (resolved.has(reference.key)) continue;
        throw new Error(`Fixed-v3 pinned canonical baseline dependency is unavailable: ${reference.key}`);
      }
      const identity = exactIdentity(local, "dropbox");
      if (identity.bytes !== Number(reference.byte_size) || identity.sha256 !== reference.sha256) {
        throw new Error(`Fixed-v3 pinned canonical baseline dependency identity disagrees: ${reference.key}`);
      }
      resolved.set(reference.key, {
        key: reference.key,
        byte_size: identity.bytes,
        sha256: identity.sha256,
        verified: true,
        durable: true,
      });
    }
  }
  return resolved;
}

export function buildExactV3ProposalDependencyFields({
  entry,
  changedExactKeys,
  exactByKey,
  proposalsByKey,
  canonicalFinalizationPrerequisiteKeys,
  runState,
  store,
  resolvedLocalReferences,
  registryRootKeys = new Set(),
}) {
  const currentIdentities = new Map();
  const currentIdentityFor = (key) => {
    if (currentIdentities.has(key)) return currentIdentities.get(key);
    const artifact = exactByKey.get(key);
    let identity = null;
    if (artifact && changedExactKeys.has(key)) {
      identity = {
        sha256: artifact.sha256,
        bytes: artifact.byte_size,
        source: "planned_overlay",
      };
    } else {
      const proposed = proposalsByKey.get(key);
      if (proposed?.changed === true
          || (proposed && canonicalFinalizationPrerequisiteKeys.has(key))) {
        identity = {
          sha256: proposed.new_sha256,
          bytes: proposed.bytes,
          source: "planned_overlay",
        };
      } else {
        identity = currentRunCanonicalIdentity({ key, runState, store });
      }
    }
    currentIdentities.set(key, identity);
    return identity;
  };
  const referencedKeys = [...new Set([
    ...entry.dependencies.map(({ key }) => key),
    ...entry.publication_prerequisites.map(({ key }) => key),
  ])];
  const dependencies = referencedKeys
    .filter((key) => currentIdentityFor(key) !== null)
    .sort();
  const pinnedBaselineKeys = [...new Set([
    ...entry.external_dependencies,
    ...entry.external_publication_prerequisites,
  ])].filter((key) => currentIdentityFor(key) === null).sort();
  return {
    dependencies,
    dependency_identities: Object.fromEntries(
      dependencies.map((key) => [key, currentIdentityFor(key)]),
    ),
    pinned_baseline_references: Object.fromEntries(pinnedBaselineKeys.map((key) => {
      const reference = resolvedLocalReferences.get(key);
      if (!reference) {
        throw new Error(`Fixed-v3 pinned canonical baseline identity is unavailable: ${key}`);
      }
      return [key, {
        source: registryRootKeys.has(key)
          ? "pinned_checkpoint_compact_latest_registry"
          : "pinned_dropbox_canonical_baseline",
        sha256: reference.sha256,
        bytes: reference.byte_size,
      }];
    })),
  };
}

function assertAllowedKey(key) {
  if (key.startsWith(`${GENERATION.observations_prefix}/`)) {
    return assertObservationHistoryGenerationKey(GENERATION, key, "observations");
  }
  if (key === GENERATION.observations_timeseries_latest_key) return key;
  return assertObservationHistoryGenerationKey(GENERATION, key, "observation_index");
}

export function assertFixedV3Proposal(output) {
  for (const proposal of output?.planning?.proposals || []) {
    const key = assertAllowedKey(String(proposal?.key || ""));
    const dependencies = Array.isArray(proposal.dependencies)
      ? proposal.dependencies.map((value) => assertAllowedKey(String(value || "")))
      : [];
    const identities = proposal?.dependency_identities;
    if (!identities || typeof identities !== "object" || Array.isArray(identities)
      || JSON.stringify(Object.keys(identities).sort()) !== JSON.stringify([...dependencies].sort())) {
      throw new Error(`Fixed-v3 dependency identities are not exact: ${key}`);
    }
    const pinned = proposal?.pinned_baseline_references || {};
    if (typeof pinned !== "object" || Array.isArray(pinned)) {
      throw new Error(`Fixed-v3 pinned baseline references are invalid: ${key}`);
    }
    for (const [referenceKey, identity] of Object.entries(pinned)) {
      assertAllowedKey(referenceKey);
      if (
        dependencies.includes(referenceKey) ||
        !["pinned_dropbox_canonical_baseline",
          "pinned_checkpoint_compact_latest_registry"].includes(identity?.source) ||
        !/^[a-f0-9]{64}$/.test(String(identity?.sha256 || "")) ||
        !Number.isSafeInteger(Number(identity?.bytes)) || Number(identity?.bytes) <= 0
      ) {
        throw new Error(`Fixed-v3 pinned baseline reference identity is invalid: ${referenceKey}`);
      }
    }
  }
  return output;
}

async function buildExactV3HierarchyForCatalogueEntry({
  entry,
  proposalsByKey,
  runState,
  store,
  combinedObject,
  targetWriterGitSha,
}) {
  const { key: manifestKey, scope } = entry;
  const currentRunManifest = proposalsByKey.has(manifestKey) ||
    (runState.objects?.[manifestKey]?.proposed === true &&
      entry.manifest_object.source === "overlay");
  let targetMetadata;
  let canonicalManifest;
  if (currentRunManifest) {
    const manifest = entry.manifest;
    const writerGitSha = assertCurrentRunManifestWriterGitSha(
      manifest,
      targetWriterGitSha,
      manifestKey,
    );
    const rows = [];
    for (const parquetKey of (manifest.parquet_object_keys || []).map(String)) {
      assertObservationHistoryGenerationKey(GENERATION, parquetKey, "observations");
      const parquet = combinedObject(parquetKey);
      if (!parquet) throw new Error(`Fixed-v3 canonical Parquet is unavailable: ${parquetKey}`);
      rows.push(...await readCanonicalObservationRows({
        body: parquet.body,
        connectorId: scope.connector_id,
      }));
    }
    const built = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
      rows,
      scope,
      targetWriterGitSha: writerGitSha,
      backedUpAtUtc: manifest.backed_up_at_utc ?? null,
      observationsPrefix: GENERATION.observations_prefix,
      indexRoot: GENERATION.observations_timeseries_index_prefix,
    });
    assertCurrentRunParquetIdentities(built.file_intents, combinedObject);
    assertFixedV3ManifestMetadata(manifest, built.target_metadata, manifestKey);
    targetMetadata = built.target_metadata;
    canonicalManifest = {
      key: manifestKey,
      byte_size: entry.identity.byte_size,
      sha256: entry.identity.sha256,
      manifest_hash: String(manifest.manifest_hash),
      row_count: Number(manifest.row_count),
      observation_content_hash: String(manifest.observation_content_hash),
    };
  } else {
    const manifestObject = store.getObjectFromSourceIfExists(manifestKey, "dropbox");
    if (!manifestObject) {
      throw new Error(`Fixed-v3 pinned pollutant manifest is unavailable: ${manifestKey}`);
    }
    const manifest = parseJsonBody(manifestObject.body, manifestKey);
    const inspected = await inspectPinnedBaselinePollutantPartition({
      manifest,
      manifestKey,
      manifestObject,
      scope,
      getPinnedObject: (key) => store.getObjectFromSourceIfExists(key, "dropbox"),
    });
    targetMetadata = inspected.target_metadata;
    canonicalManifest = inspected.canonical_manifest;
  }
  return buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: targetMetadata,
    canonicalManifest,
    indexRoot: GENERATION.observations_timeseries_index_prefix,
  });
}

async function addExactV3Indexes({
  output,
  runState,
  env,
  repairPlan,
  targetWriterGitSha,
  reportProgress = () => {},
}) {
  const selectedDays = [...new Set((repairPlan.repair_plan || [])
    .map((action) => String(action?.day_utc || "")).filter(Boolean))].sort();
  reportProgress({
    phase: "exact_v3_planning_started",
    completed_objects: 0,
    total_objects: selectedDays.length,
  });
  const selectedDayPrefixes = selectedDays
    .map((day) => `${GENERATION.observations_prefix}/day_utc=${day}/`);
  const proposals = (output.planning.proposals || [])
    .filter((proposal) => !String(proposal.key || "").startsWith(`${GENERATION.index_root_prefix}/`))
    .map((proposal) => selectedDayPrefixes.some((prefix) => String(proposal.key).startsWith(prefix))
      ? { ...proposal, changed: true, included_in_write_set: true, status: "planned" }
      : proposal);
  const proposalsByKey = new Map(proposals.map((proposal) => [String(proposal.key), proposal]));
  const prefixes = [GENERATION.observations_prefix];
  const store = createCombinedLocalStore({
    overlayRoot: env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT,
    dropboxRoot: env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
    runStateJson: env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON,
    prefixes,
    exactKeys: [GENERATION.observations_timeseries_latest_key],
  });
  const canonicalAggregateHierarchy = reconstructCanonicalObservationAggregateHierarchy({
    proposals,
    proposalsByKey,
    selectedDays,
    store,
  });
  reportProgress({
    phase: "aggregate_hierarchy_reconstruction_complete",
    completed_objects: canonicalAggregateHierarchy.staged_keys.length,
    total_objects: canonicalAggregateHierarchy.staged_keys.length,
  });
  const combinedObject = (key) => proposalsByKey.has(key)
    ? proposalObject(proposalsByKey.get(key))
    : store.getObjectIfExists(key);
  const manifestKeys = new Set(store.listAllObjects({
    prefix: `${GENERATION.observations_prefix}/day_utc=`,
    keyFilter: (key) => POLLUTANT_MANIFEST.test(key),
  }).map(({ key }) => key));
  for (const key of proposalsByKey.keys()) if (POLLUTANT_MANIFEST.test(key)) manifestKeys.add(key);
  reportProgress({
    phase: "canonical_scope_catalogue_started",
    completed_objects: 0,
    total_objects: manifestKeys.size,
  });
  const finalCatalogue = buildExactV3ManifestCatalogue({
    manifestKeys,
    getObject: combinedObject,
  });
  reportProgress({
    phase: "canonical_scope_catalogue_complete",
    completed_objects: finalCatalogue.entries.length,
    total_objects: finalCatalogue.entries.length,
  });
  const baselineManifestObjects = store.listObjectsFromSource({
    prefix: `${GENERATION.observations_prefix}/day_utc=`,
    source: "dropbox",
    keyFilter: (key) => POLLUTANT_MANIFEST.test(key),
  });
  const manifestDelta = deriveExactV3ManifestDelta({
    finalCatalogue,
    baselineObjects: baselineManifestObjects,
  });
  reportProgress({
    phase: "affected_exact_v3_scopes_identified",
    completed_objects: 0,
    total_objects: manifestDelta.affected_entries.length,
    canonical_scope_count: finalCatalogue.entries.length,
    affected_scope_count: manifestDelta.affected_entries.length,
    removed_scope_count: manifestDelta.removed_scopes.length,
    new_scope_count: manifestDelta.new_scope_count,
    changed_scope_count: manifestDelta.changed_scope_count,
  });
  reportProgress({
    phase: "compact_latest_registry_validation_started",
    completed_objects: 0,
    total_objects: 1,
  });
  const authority = resolveExactV3PlanningAuthority({
    runState,
    store,
    finalCatalogue,
    delta: manifestDelta,
  });
  const compactLatest = authority.compact_latest;
  const optimizationMode = authority.mode;
  const fallbackReason = authority.fallback_reason;
  if (optimizationMode === "full_canonical_reconstruction_fallback") {
    reportProgress({
      phase: "exact_v3_fast_path_abandoned",
      failures: 0,
      fallback_reason: fallbackReason,
      canonical_scope_count: finalCatalogue.entries.length,
    });
  } else {
    reportProgress({
      phase: "compact_latest_registry_validation_complete",
      completed_objects: 1,
      total_objects: 1,
      retained_root_count: compactLatest.roots.length,
    });
  }

  const rebuildEntries = optimizationMode === "exact_index_fast_path"
    ? manifestDelta.affected_entries
    : finalCatalogue.entries;
  const hierarchies = [];
  let completedManifestCount = 0;
  let lastManifestProgressAt = Date.now();
  for (const entry of rebuildEntries) {
    hierarchies.push(await buildExactV3HierarchyForCatalogueEntry({
      entry,
      proposalsByKey,
      runState,
      store,
      combinedObject,
      targetWriterGitSha,
    }));
    completedManifestCount += 1;
    const now = Date.now();
    if (completedManifestCount === rebuildEntries.length || completedManifestCount % 25 === 0 ||
        now - lastManifestProgressAt >= 15_000) {
      reportProgress({
        phase: optimizationMode === "exact_index_fast_path"
          ? "affected_scoped_hierarchy_rebuild_progress"
          : "fallback_canonical_scoped_hierarchy_scan_progress",
        completed_objects: completedManifestCount,
        total_objects: rebuildEntries.length,
        current_key: entry.key,
      });
      lastManifestProgressAt = now;
    }
  }
  reportProgress({
    phase: optimizationMode === "exact_index_fast_path"
      ? "affected_scope_reconstruction_complete"
      : "fallback_canonical_scoped_hierarchy_scan_complete",
    completed_objects: hierarchies.length,
    total_objects: rebuildEntries.length,
  });

  let rebuilt;
  let latestNeedsPublication;
  if (optimizationMode === "exact_index_fast_path") {
    const oldByScope = new Map(compactLatest.roots.map((root) => [scopeIdentity(root), root]));
    const changedHierarchies = hierarchies.filter((hierarchy) => {
      const descriptor = rootDescriptor(hierarchy.scoped_manifest);
      return !sameRootIdentity(oldByScope.get(scopeIdentity(descriptor)), descriptor);
    });
    const replacementScopedManifests = changedHierarchies
      .map((hierarchy) => hierarchy.scoped_manifest);
    const latest = updateObservationHistoryExactLeafIndexV3Latest({
      existingLatest: compactLatest.artifact,
      replacementScopedManifests,
      removedScopes: manifestDelta.removed_scopes,
      indexRoot: GENERATION.observations_timeseries_index_prefix,
      latestKey: GENERATION.observations_timeseries_latest_key,
    });
    const changedScopeIds = new Set(changedHierarchies
      .map((hierarchy) => scopeIdentity(hierarchy.scoped_manifest.payload)));
    const unchangedRoots = compactLatest.roots.filter((root) =>
      !changedScopeIds.has(scopeIdentity(root)) &&
      !manifestDelta.removed_scope_ids.has(scopeIdentity(root))
    );
    latestNeedsPublication = latest.sha256 !== compactLatest.artifact.sha256;
    rebuilt = {
      latest,
      changedHierarchies,
      unchangedRoots,
      removedScopes: manifestDelta.removed_scopes,
    };
  } else {
    if (hierarchies.length === 0) {
      throw new Error("Fixed-v3 fallback reconstruction has no exact-leaf scopes");
    }
    if (compactLatest) {
      rebuilt = reconcileReconstructedExactV3Hierarchies({
        existingLatest: compactLatest.artifact,
        hierarchies,
      });
      latestNeedsPublication = rebuilt.latest.sha256 !== compactLatest.artifact.sha256;
    } else {
      rebuilt = {
        latest: buildObservationHistoryExactLeafIndexV3Latest({
          scopedHierarchies: hierarchies,
          indexRoot: GENERATION.observations_timeseries_index_prefix,
          latestKey: GENERATION.observations_timeseries_latest_key,
        }),
        changedHierarchies: hierarchies,
        unchangedRoots: [],
        removedScopes: manifestDelta.removed_scopes,
      };
      latestNeedsPublication = true;
    }
  }
  const exactObjects = rebuilt.changedHierarchies
    .flatMap((hierarchy) => hierarchy.publication_objects);
  const canonicalFinalizationPrerequisites = proposals
    .filter((proposal) => (proposal.changed === true
        || selectedDayPrefixes.some((prefix) => String(proposal.key).startsWith(prefix)))
      && String(proposal.key).startsWith(`${GENERATION.observations_prefix}/`)
      && String(proposal.key).endsWith("/manifest.json"))
    .map((proposal) => ({
      key: String(proposal.key),
      byte_size: Number(proposal.bytes),
      sha256: String(proposal.new_sha256),
    }));
  if (!canonicalFinalizationPrerequisites.some(
    ({ key }) => key === canonicalAggregateHierarchy.root.key,
  )) {
    canonicalFinalizationPrerequisites.push(canonicalAggregateHierarchy.root);
  }
  canonicalFinalizationPrerequisites.sort((left, right) => left.key.localeCompare(right.key));
  const canonicalFinalizationPrerequisiteKeys = new Set(
    canonicalFinalizationPrerequisites.map(({ key }) => key),
  );
  const latest = {
    ...rebuilt.latest,
    publication_prerequisites: canonicalFinalizationPrerequisites,
  };
  if (latestNeedsPublication) exactObjects.push(latest);
  reportProgress({
    phase: optimizationMode === "exact_index_fast_path"
      ? "exact_v3_incremental_latest_complete"
      : "exact_v3_full_latest_reconstruction_complete",
    completed_objects: exactObjects.length,
    total_objects: exactObjects.length,
    changed_scopes: rebuilt.changedHierarchies.length,
    unchanged_scopes: rebuilt.unchangedRoots.length,
    removed_scopes: rebuilt.removedScopes.length,
  });
  const exactByKey = new Map(exactObjects.map((artifact) => [artifact.key, artifact]));
  const changedExactObjects = exactObjects;
  const changedExactKeys = new Set(changedExactObjects.map(({ key }) => key));
  const localReferenceKeys = new Set(changedExactObjects.flatMap((artifact) => [
    ...(artifact.dependencies || []),
    ...(artifact.publication_prerequisites || []),
  ]).map(({ key }) => key).filter((key) => !changedExactKeys.has(key)));
  reportProgress({
    phase: "local_dependency_reference_resolution_started",
    completed_objects: 0,
    total_objects: localReferenceKeys.size,
  });
  const resolvedLocalReferences = resolveExactV3LocalReferences({
    artifacts: changedExactObjects,
    changedKeys: changedExactKeys,
    proposalsByKey,
    plannedCanonicalKeys: canonicalFinalizationPrerequisiteKeys,
    runState,
    store,
    unchangedRoots: rebuilt.unchangedRoots,
  });
  reportProgress({
    phase: "local_dependency_reference_resolution_complete",
    completed_objects: localReferenceKeys.size,
    total_objects: localReferenceKeys.size,
    resolved_references: resolvedLocalReferences.size,
  });
  const publicationPlan = changedExactObjects.length > 0
    ? buildObservationHistoryIndexV3PublicationPlan({
      objects: changedExactObjects,
      // These resolve either to frozen canonical writes, checkpoint-authenticated
      // compact-latest roots, or exact identities read from pinned Dropbox.
      externalReferences: [...resolvedLocalReferences.values()],
    })
    : {
      contract_version: OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
      schedule_sha256: null,
      entries: [],
    };
  const registryRootKeys = new Set(rebuilt.unchangedRoots.map(({ key }) => key));
  for (const entry of publicationPlan.entries) {
    const dependencyFields = buildExactV3ProposalDependencyFields({
      entry,
      changedExactKeys,
      exactByKey,
      proposalsByKey,
      canonicalFinalizationPrerequisiteKeys,
      runState,
      store,
      resolvedLocalReferences,
      registryRootKeys,
    });
    const existing = store.getObjectIfExists(entry.key);
    proposals.push({
      key: entry.key,
      kind: exactByKey.get(entry.key).kind,
      publication_stage: entry.publication_stage,
      proposed_body: entry.body,
      bytes: entry.byte_size,
      old_sha256: existing ? exactIdentity(existing, existing.source).sha256 : null,
      new_sha256: entry.sha256,
      changed: !existing || exactIdentity(existing, existing.source).sha256 !== entry.sha256,
      included_in_write_set: true,
      status: "planned",
      ...dependencyFields,
      provenance: "fixed_v3_exact_leaf_operational_primitives",
    });
  }
  output.planning.proposals = proposals.sort((left, right) => left.key.localeCompare(right.key));
  output.index_status = "planned";
  output.planning.v3_exact_leaf_publication_plan = {
    contract_version: publicationPlan.contract_version,
    schedule_sha256: publicationPlan.schedule_sha256,
    object_count: publicationPlan.entries.length,
    status: publicationPlan.entries.length === 0 ? "noop" : "planned",
  };
  output.planning.removed_exact_v3_scopes = rebuilt.removedScopes;
  output.planning.v3_exact_leaf_optimization = {
    mode: optimizationMode,
    fallback_reason: fallbackReason,
    canonical_scope_count: finalCatalogue.entries.length,
    affected_scope_count: manifestDelta.affected_entries.length,
    rebuilt_scope_count: rebuildEntries.length,
    changed_root_count: rebuilt.changedHierarchies.length,
    unchanged_registry_root_count: rebuilt.unchangedRoots.length,
    byte_identical_rebuilt_scope_count:
      Math.max(0, hierarchies.length - rebuilt.changedHierarchies.length),
    new_scope_count: manifestDelta.new_scope_count,
    changed_canonical_scope_count: manifestDelta.changed_scope_count,
    removed_scope_count: rebuilt.removedScopes.length,
  };
  reportProgress({
    phase: "exact_v3_planning_complete",
    completed_objects: publicationPlan.entries.length,
    total_objects: publicationPlan.entries.length,
  });
  return output;
}

export async function planSosLightV3ObservationMetadata(options = {}) {
  const startedAtMs = Date.now();
  const reportProgress = ({
    phase,
    completed_objects = 0,
    total_objects = 0,
    failures = 0,
    ...details
  }) => {
    process.stderr.write(`UK_AQ_INTEGRITY_PROGRESS ${JSON.stringify({
      phase,
      completed_objects,
      total_objects,
      failures,
      elapsed_seconds: Math.round((Date.now() - startedAtMs) / 1000),
      ...details,
    })}\n`);
  };
  const argv = options.argv || process.argv.slice(2);
  const env = resolvedEnvironment(options.env || process.env, argv);
  const repairPlan = resolveRepairPlan({ argv, repairPlan: options.repairPlan });
  const targetWriterGitSha = resolveIntegrityTargetWriterGitSha(env);
  if (repairPlan?.domain !== "observations") throw new Error("Fixed-v3 planner is observation-only");
  reportProgress({
    phase: "v3_metadata_planner_started",
    total_objects: Array.isArray(repairPlan.repair_plan) ? repairPlan.repair_plan.length : 0,
  });
  try {
    const runStatePath = String(env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON || "");
    const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    const coreAudit = validateIntegrityCoreSnapshotIdentity({
      env, runState, dropboxRoot: env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
      stage: "fixed_v3_metadata_proposal_child",
    });
    const output = await runGenerationNeutralObservationMetadataRepair({
      argv, env, repairPlan, storageGeneration: "v3", planIndexes: false,
    });
    reportProgress({
      phase: "generation_neutral_observation_metadata_repair_complete",
      completed_objects: output?.planning?.proposals?.length || 0,
      total_objects: output?.planning?.proposals?.length || 0,
      failures: output.ok === true ? 0 : 1,
    });
    output.planning.core_snapshot_identity_validation = coreAudit;
    if (output.ok === true) {
      await addExactV3Indexes({
        output, runState, env, repairPlan, targetWriterGitSha, reportProgress,
      });
      reportProgress({
        phase: "final_proposal_graph_validation_started",
        total_objects: output.planning.proposals.length,
      });
      assertFixedV3Proposal(output);
      validateFinalPlannerProposalGraph(output, { runState });
      reportProgress({
        phase: "final_proposal_graph_validation_complete",
        completed_objects: output.planning.proposals.length,
        total_objects: output.planning.proposals.length,
      });
    }
    reportProgress({
      phase: "v3_metadata_planner_completed",
      completed_objects: output?.planning?.proposals?.length || 0,
      total_objects: output?.planning?.proposals?.length || 0,
      failures: output.ok === true ? 0 : 1,
    });
    return output;
  } catch (error) {
    reportProgress({
      phase: "v3_metadata_planner_failed",
      failures: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) planSosLightV3ObservationMetadata().then((output) => {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
