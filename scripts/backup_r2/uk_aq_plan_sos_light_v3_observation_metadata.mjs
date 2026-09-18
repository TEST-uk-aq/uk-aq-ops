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
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  updateObservationHistoryExactLeafIndexV3Latest,
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
  const proposals = (output.planning.proposals || [])
    .filter((proposal) => !String(proposal.key || "").startsWith(`${GENERATION.index_root_prefix}/`));
  const proposalsByKey = new Map(proposals.map((proposal) => [String(proposal.key), proposal]));
  const days = [...new Set((repairPlan.repair_plan || [])
    .map((action) => String(action?.day_utc || "")).filter(Boolean))].sort();
  const prefixes = [GENERATION.observations_prefix];
  const store = createCombinedLocalStore({
    overlayRoot: env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT,
    dropboxRoot: env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
    runStateJson: env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON,
    prefixes,
    exactKeys: [GENERATION.observations_timeseries_latest_key],
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
  const affectedHierarchies = hierarchies.filter((hierarchy) =>
    days.includes(String(hierarchy.scoped_manifest.payload.day_utc)));
  const exactObjects = affectedHierarchies.flatMap((hierarchy) => hierarchy.publication_objects);
  const latest = updateObservationHistoryExactLeafIndexV3Latest({
    existingLatest,
    // Replacing every scope is deliberate: the compact global object is rebuilt
    // from canonical Dropbox data plus the current repair overlay, never from
    // retained live/scoped index objects.
    replacementScopedManifests: hierarchies.map((hierarchy) => hierarchy.scoped_manifest),
    indexRoot: GENERATION.observations_timeseries_index_prefix,
    latestKey: GENERATION.observations_timeseries_latest_key,
  });
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
  const publicationPlan = buildObservationHistoryIndexV3PublicationPlan({
    objects: changedExactObjects,
    // Unchanged roots in the rebuilt latest are canonical reconstruction
    // results, not live/external proposal dependencies.
    externalReferences: hierarchies
      .map((hierarchy) => hierarchy.scoped_manifest)
      .filter((artifact) => !changedExactKeys.has(artifact.key))
      .map((artifact) => ({
        key: artifact.key,
        byte_size: artifact.byte_size,
        sha256: artifact.sha256,
        verified: true,
        durable: true,
      })),
  });
  const identityFor = (key) => {
    const artifact = exactByKey.get(key);
    if (artifact && changedExactKeys.has(key)) {
      return { sha256: artifact.sha256, bytes: artifact.byte_size, source: "planned_overlay" };
    }
    const proposed = proposalsByKey.get(key);
    if (proposed?.changed === true) return {
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
