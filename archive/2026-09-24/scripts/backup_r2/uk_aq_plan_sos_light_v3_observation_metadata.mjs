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
} from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  buildObservationHistoryIndexV3PublicationPlan,
} from "../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  readCanonicalObservationRows,
} from "./uk_aq_apply_integrity_proposal.mjs";
import {
  buildHistoryV2DayManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
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
  runV2ObservationsRepair as runGenerationNeutralObservationMetadataRepair,
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

export function resolveExactV3LocalReferences({
  artifacts,
  changedKeys,
  proposalsByKey,
  plannedCanonicalKeys = new Set(),
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
  }
  return output;
}

async function addExactV3Indexes({ output, runState, env, repairPlan, targetWriterGitSha }) {
  const selectedDays = [...new Set((repairPlan.repair_plan || [])
    .map((action) => String(action?.day_utc || "")).filter(Boolean))].sort();
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
  const combinedObject = (key) => proposalsByKey.has(key)
    ? proposalObject(proposalsByKey.get(key))
    : store.getObjectIfExists(key);
  const manifestKeys = new Set(store.listAllObjects({
    prefix: `${GENERATION.observations_prefix}/day_utc=`,
  }).map(({ key }) => key).filter((key) => POLLUTANT_MANIFEST.test(key)));
  for (const key of proposalsByKey.keys()) if (POLLUTANT_MANIFEST.test(key)) manifestKeys.add(key);

  const hierarchies = [];
  for (const manifestKey of [...manifestKeys].sort()) {
    const match = manifestKey.match(POLLUTANT_MANIFEST);
    const manifestObject = combinedObject(manifestKey);
    if (!manifestObject) throw new Error(`Fixed-v3 pollutant manifest is unavailable: ${manifestKey}`);
    const manifest = JSON.parse(Buffer.from(manifestObject.body).toString("utf8"));
    const currentRunManifest = proposalsByKey.has(manifestKey) ||
      (runState.objects?.[manifestKey]?.proposed === true && manifestObject.source === "overlay");
    const writerGitSha = currentRunManifest
      ? assertCurrentRunManifestWriterGitSha(manifest, targetWriterGitSha, manifestKey)
      : manifest.writer_git_sha;
    const rows = [];
    for (const parquetKey of (manifest.parquet_object_keys || []).map(String)) {
      assertObservationHistoryGenerationKey(GENERATION, parquetKey, "observations");
      const parquet = combinedObject(parquetKey);
      if (!parquet) throw new Error(`Fixed-v3 canonical Parquet is unavailable: ${parquetKey}`);
      rows.push(...await readCanonicalObservationRows({ body: parquet.body, connectorId: Number(match[2]) }));
    }
    const built = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
      rows,
      scope: { day_utc: match[1], connector_id: Number(match[2]), pollutant_code: match[3] },
      targetWriterGitSha: writerGitSha,
      backedUpAtUtc: manifest.backed_up_at_utc ?? null,
      observationsPrefix: GENERATION.observations_prefix,
      indexRoot: GENERATION.observations_timeseries_index_prefix,
    });
    for (const intent of built.file_intents) {
      const actual = combinedObject(intent.key);
      if (!actual || exactIdentity(actual, actual.source).sha256 !== intent.sha256
        || exactIdentity(actual, actual.source).bytes !== intent.byte_size) {
        throw new Error(`Fixed-v3 staged/baseline Parquet identity disagrees: ${intent.key}`);
      }
    }
    hierarchies.push(buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
      metadata: built.target_metadata,
      canonicalManifest: {
        key: manifestKey,
        byte_size: Number(manifestObject.bytes),
        sha256: String(manifestObject.content_sha256),
        manifest_hash: String(manifest.manifest_hash),
        row_count: Number(manifest.row_count),
        observation_content_hash: String(manifest.observation_content_hash),
      },
      indexRoot: GENERATION.observations_timeseries_index_prefix,
    }));
  }
  if (!hierarchies.length) throw new Error("Fixed-v3 metadata proposal has no exact-leaf scopes");
  const existingLatestObject = store.getObjectIfExists(GENERATION.observations_timeseries_latest_key);
  if (!existingLatestObject) throw new Error("Pinned v3 exact-leaf latest baseline is unavailable");
  const existingLatest = artifactFromStoredObject(
    existingLatestObject, "observation_history_index_v3_latest_global", "latest_global",
  );
  const rebuilt = reconcileReconstructedExactV3Hierarchies({
    existingLatest,
    hierarchies,
  });
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
  exactObjects.push(latest);
  const exactByKey = new Map(exactObjects.map((artifact) => [artifact.key, artifact]));
  const changedExactObjects = exactObjects.filter((artifact) => {
    const existing = store.getObjectIfExists(artifact.key);
    return !existing || exactIdentity(existing, existing.source).sha256 !== artifact.sha256;
  });
  const changedExactKeys = new Set(changedExactObjects.map(({ key }) => key));
  if (!changedExactObjects.length) {
    throw new Error("Fixed-v3 metadata proposal unexpectedly produced no changed exact-v3 indexes");
  }
  const resolvedLocalReferences = resolveExactV3LocalReferences({
    artifacts: changedExactObjects,
    changedKeys: changedExactKeys,
    proposalsByKey,
    plannedCanonicalKeys: canonicalFinalizationPrerequisiteKeys,
    store,
    unchangedRoots: rebuilt.unchangedRoots,
  });
  const publicationPlan = buildObservationHistoryIndexV3PublicationPlan({
    objects: changedExactObjects,
    // These resolve either to frozen canonical writes or exact identities read
    // from the pinned local Dropbox baseline, never retained live-R2 objects.
    externalReferences: [...resolvedLocalReferences.values()],
  });
  const identityFor = (key) => {
    const artifact = exactByKey.get(key);
    if (artifact && changedExactKeys.has(key)) {
      return { sha256: artifact.sha256, bytes: artifact.byte_size, source: "planned_overlay" };
    }
    const proposed = proposalsByKey.get(key);
    if (proposed?.changed === true || canonicalFinalizationPrerequisiteKeys.has(key)) return {
      sha256: proposed.new_sha256, bytes: proposed.bytes, source: "planned_overlay",
    };
    const staged = runState.objects?.[key];
    if (staged?.proposed === true && staged?.structurally_validated === true
      && staged?.changed !== false && staged?.included_in_write_set !== false) {
      return { sha256: staged.sha256, bytes: staged.bytes, source: "planned_overlay" };
    }
    const object = store.getObjectIfExists(key);
    if (!object || !["dropbox", "overlay"].includes(object.source)) {
      throw new Error(`Fixed-v3 local proposal input is unavailable: ${key}`);
    }
    return exactIdentity(object, object.source);
  };
  for (const entry of publicationPlan.entries) {
    const dependencies = [...new Set([
      ...entry.dependencies.map(({ key }) => key),
      ...entry.publication_prerequisites.map(({ key }) => key),
    ])].filter((key) => changedExactKeys.has(key) || proposalsByKey.has(key)).sort();
    const pinnedBaselineReferences = [...new Set([
      ...entry.external_dependencies,
      ...entry.external_publication_prerequisites,
    ])].filter((key) => !proposalsByKey.has(key)).sort();
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
      dependencies,
      dependency_identities: Object.fromEntries(dependencies.map((key) => [key, identityFor(key)])),
      pinned_baseline_references: Object.fromEntries(pinnedBaselineReferences.map((key) => {
        const reference = resolvedLocalReferences.get(key);
        return [key, {
          source: "pinned_dropbox_canonical_baseline",
          sha256: reference.sha256,
          bytes: reference.byte_size,
        }];
      })),
      provenance: "fixed_v3_exact_leaf_operational_primitives",
    });
  }
  output.planning.proposals = proposals.sort((left, right) => left.key.localeCompare(right.key));
  output.index_status = "planned";
  output.planning.v3_exact_leaf_publication_plan = {
    contract_version: publicationPlan.contract_version,
    schedule_sha256: publicationPlan.schedule_sha256,
    object_count: publicationPlan.entries.length,
  };
  output.planning.removed_exact_v3_scopes = rebuilt.removedScopes;
  return output;
}

export async function planSosLightV3ObservationMetadata(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = resolvedEnvironment(options.env || process.env, argv);
  const repairPlan = resolveRepairPlan({ argv, repairPlan: options.repairPlan });
  const targetWriterGitSha = resolveIntegrityTargetWriterGitSha(env);
  if (repairPlan?.domain !== "observations") throw new Error("Fixed-v3 planner is observation-only");
  const runStatePath = String(env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON || "");
  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  const coreAudit = validateIntegrityCoreSnapshotIdentity({
    env, runState, dropboxRoot: env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
    stage: "fixed_v3_metadata_proposal_child",
  });
  const output = await runGenerationNeutralObservationMetadataRepair({
    argv, env, repairPlan, storageGeneration: "v3", planIndexes: false,
  });
  output.planning.core_snapshot_identity_validation = coreAudit;
  if (output.ok === true) {
    await addExactV3Indexes({
      output, runState, env, repairPlan, targetWriterGitSha,
    });
    assertFixedV3Proposal(output);
    validateFinalPlannerProposalGraph(output, { runState });
  }
  return output;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) planSosLightV3ObservationMetadata().then((output) => {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
