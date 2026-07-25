import fs from "node:fs";
import path from "node:path";

import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  compressors,
} from "../../../scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2PollutantManifest,
} from "../../uk_aq_prune_daily/phase_b_history_r2.mjs";
import { sha256Hex } from "../../shared/r2_sigv4.mjs";
import {
  validateV2ObservationsChildManifest,
} from "../../../scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs";

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const CANONICAL_CODE = /^[a-z][a-z0-9_]*$/;
const REPAIRABLE_CANONICAL_CHILD_FAILURES = new Set([
  "grain_not_explicit_null",
  "profile_not_explicit_null",
  "timeseries_row_counts_not_object_or_null",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validIso(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function safeKey(value) {
  const key = String(value || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe local object key: ${value}`);
  }
  return key;
}

function localPathForKey(root, key) {
  return path.join(root, ...safeKey(key).split("/"));
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(filePath, body, "utf8");
  return body;
}

function directRepairPlan(input) {
  if (input?.history_version === "v2" && input?.domain === "observations"
    && Array.isArray(input.repair_plan)) return input.repair_plan;
  const observations = input?.history_version_results?.v2?.observations;
  return Array.isArray(observations?.repair_plan) ? observations.repair_plan : [];
}

function targetedDays(input) {
  return [...new Set(directRepairPlan(input)
    .map((action) => String(action?.day_utc || ""))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) files.push(next);
    }
  };
  visit(root);
  return files.sort();
}

function parquetIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function parquetFileEntry({ dropboxRoot, key, pollutantCode }) {
  const filePath = localPathForKey(dropboxRoot, key);
  const body = fs.readFileSync(filePath);
  const file = new Uint8Array(body).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) throw new Error(`Canonical Parquet has zero rows: ${key}`);
  const columns = new Set(
    parquetSchema(metadata).children.map((column) => String(column.element.name)),
  );
  const timestampColumn = ["observed_at_utc", "observed_at"]
    .find((column) => columns.has(column));
  if (!timestampColumn) {
    throw new Error(`Canonical Parquet timestamp column missing: ${key}`);
  }
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns: ["timeseries_id", timestampColumn],
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (value) => { rows = Array.isArray(value) ? value : []; },
  });
  const counts = {};
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minObservedAtUtc = null;
  let maxObservedAtUtc = null;
  for (const row of rows) {
    const timeseriesId = Number(Array.isArray(row) ? row[0] : null);
    const observedAtUtc = parquetIso(Array.isArray(row) ? row[1] : null);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !observedAtUtc) {
      throw new Error(`Canonical Parquet required metadata invalid: ${key}`);
    }
    const id = Math.trunc(timeseriesId);
    counts[String(id)] = (counts[String(id)] || 0) + 1;
    minTimeseriesId = minTimeseriesId === null ? id : Math.min(minTimeseriesId, id);
    maxTimeseriesId = maxTimeseriesId === null ? id : Math.max(maxTimeseriesId, id);
    minObservedAtUtc = minObservedAtUtc === null || observedAtUtc < minObservedAtUtc
      ? observedAtUtc : minObservedAtUtc;
    maxObservedAtUtc = maxObservedAtUtc === null || observedAtUtc > maxObservedAtUtc
      ? observedAtUtc : maxObservedAtUtc;
  }
  if (Object.values(counts).reduce((total, count) => total + count, 0) !== rowCount) {
    throw new Error(`Canonical Parquet row metadata mismatch: ${key}`);
  }
  return {
    key,
    row_count: rowCount,
    bytes: body.byteLength,
    etag_or_hash: sha256Hex(body),
    pollutant_codes: [pollutantCode],
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at_utc: minObservedAtUtc,
    max_observed_at_utc: maxObservedAtUtc,
    timeseries_row_counts: counts,
  };
}

function metadataFromExisting(payload, parent, dayUtc) {
  return {
    run_id: typeof payload?.run_id === "string" || payload?.run_id === null
      ? payload.run_id
      : typeof parent?.run_id === "string" || parent?.run_id === null
      ? parent.run_id
      : null,
    writer_git_sha: typeof payload?.writer_git_sha === "string" || payload?.writer_git_sha === null
      ? payload.writer_git_sha
      : typeof parent?.writer_git_sha === "string" || parent?.writer_git_sha === null
      ? parent.writer_git_sha
      : null,
    backed_up_at_utc: validIso(payload?.backed_up_at_utc)
      ? payload.backed_up_at_utc
      : validIso(payload?.created_at_utc)
      ? payload.created_at_utc
      : validIso(parent?.backed_up_at_utc)
      ? parent.backed_up_at_utc
      : validIso(parent?.created_at_utc)
      ? parent.created_at_utc
      : `${dayUtc}T00:00:00.000Z`,
  };
}

function stateObject(localPath, body, extra = {}) {
  const bytes = Buffer.byteLength(body, "utf8");
  const hash = sha256Hex(body);
  return {
    local_path: localPath,
    structurally_validated: true,
    proposed: true,
    content_type: "application/json",
    bytes,
    sha256: hash,
    content_sha256: hash,
    ...extra,
  };
}

function saveRunState(runStatePath, state) {
  const temporary = `${runStatePath}.canonical-manifest-compatibility.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, runStatePath);
}

function exactConnectorIdentity(parent, { connectorKey, connectorPrefix, dayUtc, connectorId }) {
  return parent?.history_version === "v2"
    && parent?.domain === "observations"
    && parent?.manifest_kind === "connector"
    && parent?.day_utc === dayUtc
    && Number.isInteger(parent?.connector_id)
    && parent.connector_id === connectorId
    && (
      parent.manifest_key === connectorKey
      || (parent.manifest_key === undefined && parent.current_prefix === connectorPrefix)
    );
}

function exactPollutantIdentity(payload, { childKey, dayUtc, connectorId, pollutantCode }) {
  return payload?.history_version === "v2"
    && payload?.domain === "observations"
    && payload?.manifest_kind === "pollutant"
    && payload?.manifest_key === childKey
    && payload?.day_utc === dayUtc
    && payload?.connector_id === connectorId
    && payload?.pollutant_code === pollutantCode;
}

export async function prepareCanonicalObservationManifestCompatibility({
  env = process.env,
  repairPlan,
} = {}) {
  const days = targetedDays(repairPlan);
  const dropboxRoot = String(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim();
  const overlayRoot = String(env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT || "").trim();
  const runStatePath = String(env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON || "").trim();
  if (!days.length || !dropboxRoot || !overlayRoot || !runStatePath) {
    return { prepared: [], run_state_path: runStatePath || null };
  }
  const prefix = String(
    env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || DEFAULT_OBSERVATIONS_PREFIX,
  ).replace(/^\/+|\/+$/g, "");
  const state = fs.existsSync(runStatePath)
    ? readJsonFile(runStatePath, runStatePath)
    : { objects: {}, tombstones: {} };
  state.objects = isPlainObject(state.objects) ? state.objects : {};
  const prepared = [];

  for (const dayUtc of days) {
    const dayKeyPrefix = `${prefix}/day_utc=${dayUtc}`;
    const dayDirectory = localPathForKey(dropboxRoot, dayKeyPrefix);
    if (!fs.existsSync(dayDirectory)) continue;
    for (const entry of fs.readdirSync(dayDirectory, { withFileTypes: true })) {
      const match = entry.isDirectory() ? entry.name.match(/^connector_id=(\d+)$/) : null;
      if (!match) continue;
      const connectorId = Number(match[1]);
      const connectorPrefix = `${dayKeyPrefix}/${entry.name}/`;
      const connectorKey = `${connectorPrefix}manifest.json`;
      const connectorPath = localPathForKey(dropboxRoot, connectorKey);
      if (!fs.existsSync(connectorPath)) continue;
      const parent = readJsonFile(connectorPath, connectorKey);
      const childEntries = [
        ...(Array.isArray(parent?.pollutant_manifests) ? parent.pollutant_manifests : []),
        ...(Array.isArray(parent?.child_manifests) ? parent.child_manifests : []),
      ];
      const legacyDeclarations = childEntries.filter((child) =>
        /\/pollutant=[^/]+\/manifest\.json$/.test(String(child?.manifest_key || "")));
      const escapedPrefix = connectorPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const canonicalPattern = new RegExp(
        `^${escapedPrefix}pollutant_code=([a-z][a-z0-9_]*)/manifest\\.json$`,
      );
      const canonicalDeclarations = childEntries.filter((child) =>
        canonicalPattern.test(String(child?.manifest_key || "")));
      if (!canonicalDeclarations.length) continue;
      if (legacyDeclarations.length) {
        throw new Error(`Blocked dependency: mixed legacy and canonical pollutant declarations in ${connectorKey}`);
      }
      if (!exactConnectorIdentity(parent, { connectorKey, connectorPrefix, dayUtc, connectorId })) {
        throw new Error(`Blocked dependency: canonical connector identity mismatch in ${connectorKey}`);
      }

      const finalPayloads = [];
      const pollutantProposals = [];
      const seenCodes = new Set();
      for (const child of canonicalDeclarations) {
        const childKey = String(child?.manifest_key || "").trim();
        const childMatch = childKey.match(canonicalPattern);
        const pathCode = String(childMatch?.[1] || "");
        const declaredCode = String(child?.pollutant_code || "").trim().toLowerCase();
        if (!childMatch || !CANONICAL_CODE.test(declaredCode) || pathCode !== declaredCode) {
          throw new Error(`Blocked dependency: invalid canonical pollutant declaration in ${connectorKey}`);
        }
        if (seenCodes.has(declaredCode)) {
          throw new Error(`Blocked dependency: duplicate canonical pollutant ${declaredCode} in ${connectorKey}`);
        }
        seenCodes.add(declaredCode);
        const childPath = localPathForKey(dropboxRoot, childKey);
        if (!fs.existsSync(childPath)) {
          throw new Error(`Blocked dependency: canonical pollutant manifest unavailable: ${childKey}`);
        }
        const childPayload = readJsonFile(childPath, childKey);
        if (!exactPollutantIdentity(childPayload, {
          childKey,
          dayUtc,
          connectorId,
          pollutantCode: declaredCode,
        })) {
          throw new Error(`Blocked dependency: canonical pollutant identity mismatch: ${childKey}`);
        }
        const validation = validateV2ObservationsChildManifest(childPayload, {
          key: childKey,
          kind: "pollutant",
          dayUtc,
          connectorId,
        });
        if (validation.ok) {
          finalPayloads.push(childPayload);
          continue;
        }
        const unsupportedFailures = validation.failures
          .filter((failure) => !REPAIRABLE_CANONICAL_CHILD_FAILURES.has(failure));
        if (unsupportedFailures.length) {
          throw new Error(
            `Blocked dependency: canonical pollutant manifest has non-compatible failures ${childKey}; `
            + `failures=${validation.failures.join(",")}`,
          );
        }

        const sourcePrefix = childKey.slice(0, -"/manifest.json".length);
        const sourceDirectory = localPathForKey(dropboxRoot, sourcePrefix);
        const partKeys = walkFiles(sourceDirectory)
          .filter((filePath) => /\/part-[^/]+\.parquet$/.test(filePath.replaceAll("\\", "/")))
          .map((filePath) => path.relative(dropboxRoot, filePath).split(path.sep).join("/"))
          .sort();
        if (!partKeys.length) {
          throw new Error(`Blocked dependency: no immutable Parquet objects under ${sourcePrefix}`);
        }
        const fileEntries = [];
        for (const key of partKeys) {
          fileEntries.push(await parquetFileEntry({
            dropboxRoot,
            key,
            pollutantCode: declaredCode,
          }));
        }
        const metadata = metadataFromExisting(childPayload, parent, dayUtc);
        const rebuilt = buildHistoryV2PollutantManifest({
          domain: "observations",
          grain: null,
          profile: null,
          dayUtc,
          connectorId,
          pollutantCode: declaredCode,
          runId: metadata.run_id,
          manifestKey: childKey,
          sourceRowCount: fileEntries.reduce(
            (total, fileEntry) => total + Number(fileEntry.row_count || 0),
            0,
          ),
          fileEntries,
          writerGitSha: metadata.writer_git_sha,
          backedUpAtUtc: metadata.backed_up_at_utc,
        });
        const overlayPath = localPathForKey(overlayRoot, childKey);
        const body = writeJsonFile(overlayPath, rebuilt);
        state.objects[childKey] = stateObject(overlayPath, body, {
          source: "canonical_pollutant_manifest_compatibility",
          validation_failures: validation.failures,
        });
        finalPayloads.push(rebuilt);
        pollutantProposals.push({
          key: childKey,
          body,
          file_entries: fileEntries,
          source_manifest_key: childKey,
          raw_pollutant_code: declaredCode,
          pollutant_code: declaredCode,
          overlay_path: overlayPath,
          validation_failures: validation.failures,
        });
      }
      if (!pollutantProposals.length) continue;

      const parentMetadata = metadataFromExisting(parent, parent, dayUtc);
      const compatibilityParent = buildHistoryV2ConnectorManifest({
        domain: "observations",
        grain: null,
        profile: null,
        dayUtc,
        connectorId,
        runId: parentMetadata.run_id,
        manifestKey: connectorKey,
        pollutantManifests: finalPayloads,
        writerGitSha: parentMetadata.writer_git_sha,
        backedUpAtUtc: parentMetadata.backed_up_at_utc,
      });
      compatibilityParent.manifest_hash = "canonical-compatibility-placeholder";
      const connectorOverlayPath = localPathForKey(overlayRoot, connectorKey);
      const connectorBody = writeJsonFile(connectorOverlayPath, compatibilityParent);
      state.objects[connectorKey] = stateObject(connectorOverlayPath, connectorBody, {
        source: "canonical_connector_manifest_compatibility",
        source_manifest_key: connectorKey,
      });
      prepared.push({
        day_utc: dayUtc,
        connector_id: connectorId,
        connector_key: connectorKey,
        connector_overlay_path: connectorOverlayPath,
        pollutant_proposals: pollutantProposals,
      });
    }
  }

  if (prepared.length) saveRunState(runStatePath, state);
  return { prepared, run_state_path: runStatePath };
}
