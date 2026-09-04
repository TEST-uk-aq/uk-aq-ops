#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateHierarchicalStateRoot,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  normalizeTimeseriesBindingPackRootState,
} from "./lib/hierarchical_timeseries_binding_pack_sync_v1.mjs";
import {
  normalizeTimeseriesBindingBackupMode,
} from "./lib/timeseries_binding_pack_inventory_v1.mjs";
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

const DEFAULT_STATE_PREFIX = "_ops/checkpoints/r2_history_backup_state_v2";
const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizeRelativePath(value, label) {
  const normalized = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function resolveBelow(root, relativePath) {
  const base = path.resolve(String(root || ""));
  if (!String(root || "").trim()) throw new Error("--dropbox-root is required");
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error("Dropbox checkpoint path escapes --dropbox-root");
  }
  return target;
}

function parseArgs(argv) {
  const args = {
    dropboxRoot: null,
    statePrefix: DEFAULT_STATE_PREFIX,
    observationsPrefix: DEFAULT_OBSERVATIONS_PREFIX,
    timeseriesBindingBackupMode: "individual",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--dropbox-root") args.dropboxRoot = value();
    else if (flag === "--state-prefix") args.statePrefix = value();
    else if (flag === "--observations-prefix") args.observationsPrefix = value();
    else if (flag === "--timeseries-binding-backup-mode") {
      args.timeseriesBindingBackupMode = value();
    }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.dropboxRoot) throw new Error("--dropbox-root is required");
  args.statePrefix = normalizeRelativePath(args.statePrefix, "state prefix");
  args.observationsPrefix = normalizeRelativePath(args.observationsPrefix, "observations prefix");
  args.timeseriesBindingBackupMode = normalizeTimeseriesBindingBackupMode(
    args.timeseriesBindingBackupMode,
  );
  if (!["individual", "pack"].includes(args.timeseriesBindingBackupMode)) {
    throw new Error(
      "Integrity timeseries binding backup mode must be individual or pack",
    );
  }
  return Object.freeze(args);
}

function requireCompleteCheckpoint(state, timeseriesBindingBackupMode) {
  const blockers = [];
  if (!state.observations.processed_source_root_hash) blockers.push("observations_root_not_processed");
  if (!state.observations.years.length) blockers.push("observations_years_missing");
  for (const year of state.observations.years) {
    if (!year.processed_source_year_hash) blockers.push(`observations_year_incomplete:${year.year}`);
    if (!year.months.length) blockers.push(`observations_months_missing:${year.year}`);
    for (const month of year.months) {
      if (!month.processed_source_month_hash || !month.state_shard_hash) {
        blockers.push(`observations_month_incomplete:${year.year}-${month.month}`);
      }
    }
  }
  const runManifests = state.global_units.observation_run_manifests;
  if (!runManifests.processed_source_hash || !runManifests.state_shard_hash) {
    blockers.push("observation_run_manifests_incomplete");
  }
  const latest = state.global_units.observations_timeseries_latest;
  if (!latest.verified || !latest.processed_source_sha256 || latest.byte_size === null || !latest.copied_at) {
    blockers.push("observations_timeseries_latest_incomplete");
  }
  const core = state.core;
  if (
    !core || typeof core !== "object" || Array.isArray(core) ||
    !String(core.state_shard_key || "").trim() ||
    !SHA256_PATTERN.test(String(core.processed_source_hash || "")) ||
    !SHA256_PATTERN.test(String(core.state_shard_hash || ""))
  ) blockers.push("core_incomplete");
  let binding = null;
  let bindingPacks = null;
  if (timeseriesBindingBackupMode === "individual") {
    binding = state.timeseries_binding;
    if (!binding || !SHA256_PATTERN.test(String(binding.processed_source_root_hash || ""))) {
      blockers.push("timeseries_binding_incomplete");
    }
    for (const range of Array.isArray(binding?.ranges) ? binding.ranges : []) {
      if (
        !SHA256_PATTERN.test(String(range.processed_source_range_hash || "")) ||
        !SHA256_PATTERN.test(String(range.state_shard_hash || ""))
      ) blockers.push(`timeseries_binding_range_incomplete:${String(range.range_start)}`);
    }
  } else {
    bindingPacks = normalizeTimeseriesBindingPackRootState(state);
    if (!bindingPacks.verified || bindingPacks.ranges.length === 0) {
      blockers.push("timeseries_binding_packs_incomplete");
    }
  }
  if (blockers.length) {
    const error = new Error(`Dropbox hierarchical checkpoint is incomplete: ${blockers.join(",")}`);
    error.blockers = blockers;
    throw error;
  }
  return { core, binding, bindingPacks };
}

export async function checkIntegrityDropboxCurrentness({
  dropboxRoot,
  statePrefix = DEFAULT_STATE_PREFIX,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  timeseriesBindingBackupMode = "individual",
  env = process.env,
  getLiveRoot,
  lockContext,
} = {}) {
  const lock = lockContext || requireObservationsGlobalOperationLockContext({
    env,
    expectedOwner: "integrity",
  });
  if (!lock.valid) throw new Error("Integrity Dropbox currentness gate requires the held global lock");
  const normalizedStatePrefix = normalizeRelativePath(statePrefix, "state prefix");
  const normalizedObservationsPrefix = normalizeRelativePath(observationsPrefix, "observations prefix");
  const normalizedBindingBackupMode = normalizeTimeseriesBindingBackupMode(
    timeseriesBindingBackupMode,
  );
  if (!["individual", "pack"].includes(normalizedBindingBackupMode)) {
    throw new Error(
      "Integrity timeseries binding backup mode must be individual or pack",
    );
  }
  const checkpointPath = resolveBelow(dropboxRoot, `${normalizedStatePrefix}/root.json`);
  const checkpointBody = fs.readFileSync(checkpointPath);
  let checkpointRaw;
  try {
    checkpointRaw = JSON.parse(checkpointBody.toString("utf8"));
  } catch (error) {
    throw new Error(`Dropbox checkpoint root is invalid JSON: ${checkpointPath}`, { cause: error });
  }
  const checkpoint = validateHierarchicalStateRoot(checkpointRaw, normalizedStatePrefix);
  requireCompleteCheckpoint(checkpoint, normalizedBindingBackupMode);

  const liveRootKey = `${normalizedObservationsPrefix}/_manifests/manifest.json`;
  let liveObject;
  if (getLiveRoot) {
    liveObject = await getLiveRoot({ key: liveRootKey });
  } else {
    const config = resolveR2HistoryIndexConfig(env);
    if (!hasRequiredR2Config(config.r2)) {
      throw new Error("Complete R2 configuration is required for the Integrity Dropbox currentness gate");
    }
    liveObject = await r2GetObject({ r2: config.r2, key: liveRootKey });
  }
  let liveRaw;
  try {
    liveRaw = JSON.parse(Buffer.from(liveObject.body).toString("utf8"));
  } catch (error) {
    throw new Error(`Live R2 observations root is invalid JSON: ${liveRootKey}`, { cause: error });
  }
  const liveRoot = validateR2HistoryV2ObservationsAggregateManifest(liveRaw, {
    basePrefix: normalizedObservationsPrefix,
  });
  if (liveRoot.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root) {
    throw new Error(`Live R2 observations manifest is not the root: ${liveRootKey}`);
  }
  const checkpointHash = checkpoint.observations.processed_source_root_hash;
  const match = checkpointHash === liveRoot.content_hash;
  const result = {
    allowed: match,
    status: match ? "current" : "blocked_stale_dropbox_checkpoint",
    lock_owner: lock.owner,
    lock_run_id: lock.run_id,
    checkpoint: {
      path: checkpointPath,
      relative_key: `${normalizedStatePrefix}/root.json`,
      byte_size: checkpointBody.length,
      sha256: sha256Hex(checkpointBody),
      observations_processed_source_root_hash: checkpointHash,
    },
    live_observations_root: {
      key: liveRootKey,
      content_hash: liveRoot.content_hash,
      byte_size: Number(liveObject.bytes ?? Buffer.from(liveObject.body).length),
    },
    checkpoint_live_root_match: match,
  };
  if (!match) {
    const error = new Error("Dropbox checkpoint observations root does not match the locked live R2 root");
    error.code = "UK_AQ_INTEGRITY_DROPBOX_CHECKPOINT_STALE";
    error.result = result;
    throw error;
  }
  return result;
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  try {
    const result = await checkIntegrityDropboxCurrentness({ ...args, env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const result = error?.result || {
      allowed: false,
      status: "blocked_invalid_or_incomplete_checkpoint",
      error: error instanceof Error ? error.message : String(error),
      blockers: error?.blockers || [],
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
