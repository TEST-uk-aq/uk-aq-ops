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

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const CANONICAL_CODE = /^[a-z][a-z0-9_]*$/;
const LEGACY_ALIASES = new Map([
  ["pm2.5", "pm25"],
  ["pm2_5", "pm25"],
  ["pm 2.5", "pm25"],
  ["pm₂.₅", "pm25"],
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

function canonicalPollutantCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (LEGACY_ALIASES.has(normalized)) return LEGACY_ALIASES.get(normalized);
  return CANONICAL_CODE.test(normalized) ? normalized : null;
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
  if (!rowCount) throw new Error(`Legacy parquet has zero rows: ${key}`);
  const columns = new Set(
    parquetSchema(metadata).children.map((column) => String(column.element.name)),
  );
  const timestampColumn = ["observed_at_utc", "observed_at"]
    .find((column) => columns.has(column));
  if (!timestampColumn) {
    throw new Error(`Legacy parquet timestamp column missing: ${key}`);
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
      throw new Error(`Legacy parquet required metadata invalid: ${key}`);
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
    throw new Error(`Legacy parquet row metadata mismatch: ${key}`);
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

function metadataFromLegacy(payload, parent, dayUtc) {
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
  const temporary = `${runStatePath}.manifest-compatibility.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, runStatePath);
}

export async function prepareLegacyObservationManifestCompatibility({
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
      const connectorKey = `${dayKeyPrefix}/${entry.name}/manifest.json`;
      const connectorPath = localPathForKey(dropboxRoot, connectorKey);
      if (!fs.existsSync(connectorPath)) continue;
      const parent = readJsonFile(connectorPath, connectorKey);
      if (parent?.history_version !== "v2" || parent?.domain !== "observations"
        || parent?.manifest_kind !== "connector") continue;
      const childEntries = [
        ...(Array.isArray(parent.pollutant_manifests) ? parent.pollutant_manifests : []),
        ...(Array.isArray(parent.child_manifests) ? parent.child_manifests : []),
      ];
      const legacyChildren = new Map();
      for (const child of childEntries) {
        const sourceManifestKey = String(child?.manifest_key || "").trim();
        const pathMatch = sourceManifestKey.match(/\/pollutant=([^/]+)\/manifest\.json$/);
        if (!pathMatch) continue;
        const rawCode = String(child?.pollutant_code || pathMatch[1] || "").trim();
        const pollutantCode = canonicalPollutantCode(rawCode);
        if (!pollutantCode) {
          throw new Error(
            `Blocked dependency: unknown legacy pollutant alias ${JSON.stringify(rawCode)} in ${connectorKey}`,
          );
        }
        if (legacyChildren.has(pollutantCode)
          && legacyChildren.get(pollutantCode).source_manifest_key !== sourceManifestKey) {
          throw new Error(
            `Blocked dependency: multiple legacy children map to ${pollutantCode} in ${connectorKey}`,
          );
        }
        legacyChildren.set(pollutantCode, {
          pollutant_code: pollutantCode,
          raw_pollutant_code: rawCode,
          source_manifest_key: safeKey(sourceManifestKey),
        });
      }
      if (!legacyChildren.size) continue;

      const pollutantPayloads = [];
      const pollutantProposals = [];
      for (const child of [...legacyChildren.values()]
        .sort((left, right) => left.pollutant_code.localeCompare(right.pollutant_code))) {
        const sourceManifestPath = localPathForKey(dropboxRoot, child.source_manifest_key);
        const sourceManifest = fs.existsSync(sourceManifestPath)
          ? readJsonFile(sourceManifestPath, child.source_manifest_key)
          : {};
        const sourcePrefix = child.source_manifest_key.slice(0, -"/manifest.json".length);
        const sourceDirectory = localPathForKey(dropboxRoot, sourcePrefix);
        const partKeys = walkFiles(sourceDirectory)
          .filter((filePath) => /\/part-[^/]+\.parquet$/.test(filePath.replaceAll("\\", "/")))
          .map((filePath) => path.relative(dropboxRoot, filePath).split(path.sep).join("/"))
          .sort();
        if (!partKeys.length) {
          throw new Error(
            `Blocked dependency: no immutable Parquet objects under ${sourcePrefix}`,
          );
        }
        const fileEntries = [];
        for (const key of partKeys) {
          fileEntries.push(await parquetFileEntry({
            dropboxRoot,
            key,
            pollutantCode: child.pollutant_code,
          }));
        }
        const metadata = metadataFromLegacy(sourceManifest, parent, dayUtc);
        const canonicalKey = `${dayKeyPrefix}/${entry.name}/pollutant_code=${child.pollutant_code}/manifest.json`;
        const payload = buildHistoryV2PollutantManifest({
          domain: "observations",
          grain: null,
          profile: null,
          dayUtc,
          connectorId,
          pollutantCode: child.pollutant_code,
          runId: metadata.run_id,
          manifestKey: canonicalKey,
          sourceRowCount: fileEntries.reduce(
            (total, fileEntry) => total + Number(fileEntry.row_count || 0),
            0,
          ),
          fileEntries,
          writerGitSha: metadata.writer_git_sha,
          backedUpAtUtc: metadata.backed_up_at_utc,
        });
        const overlayPath = localPathForKey(overlayRoot, canonicalKey);
        const body = writeJsonFile(overlayPath, payload);
        state.objects[canonicalKey] = stateObject(overlayPath, body, {
          source: "legacy_pollutant_manifest_compatibility",
          source_manifest_key: child.source_manifest_key,
        });
        pollutantPayloads.push(payload);
        pollutantProposals.push({
          key: canonicalKey,
          body,
          file_entries: fileEntries,
          source_manifest_key: child.source_manifest_key,
          raw_pollutant_code: child.raw_pollutant_code,
          pollutant_code: child.pollutant_code,
          overlay_path: overlayPath,
        });
      }

      const parentMetadata = metadataFromLegacy(parent, parent, dayUtc);
      const compatibilityParent = buildHistoryV2ConnectorManifest({
        domain: "observations",
        grain: null,
        profile: null,
        dayUtc,
        connectorId,
        runId: parentMetadata.run_id,
        manifestKey: connectorKey,
        pollutantManifests: pollutantPayloads,
        writerGitSha: parentMetadata.writer_git_sha,
        backedUpAtUtc: parentMetadata.backed_up_at_utc,
      });
      compatibilityParent.manifest_hash = "legacy-compatibility-placeholder";
      const connectorOverlayPath = localPathForKey(overlayRoot, connectorKey);
      const connectorBody = writeJsonFile(connectorOverlayPath, compatibilityParent);
      state.objects[connectorKey] = stateObject(connectorOverlayPath, connectorBody, {
        source: "legacy_connector_manifest_compatibility",
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

function proposalForPollutant(prepared) {
  const bytes = Buffer.byteLength(prepared.body, "utf8");
  const newSha = sha256Hex(prepared.body);
  const dependencies = prepared.file_entries.map((entry) => entry.key).sort();
  return {
    key: prepared.key,
    kind: "pollutant_manifest",
    day_utc: prepared.key.match(/day_utc=(\d{4}-\d{2}-\d{2})/)?.[1] || null,
    bytes,
    old_sha256: null,
    new_sha256: newSha,
    changed: true,
    status: "planned",
    dependencies,
    dependency_identities: Object.fromEntries(prepared.file_entries.map((entry) => [
      entry.key,
      { sha256: entry.etag_or_hash, bytes: entry.bytes, source: "dropbox" },
    ])),
    provenance: {
      source: "legacy_pollutant_layout_normalisation",
      source_manifest_key: prepared.source_manifest_key,
      raw_pollutant_code: prepared.raw_pollutant_code,
      canonical_pollutant_code: prepared.pollutant_code,
      immutable_parquet_metadata_verified: true,
    },
    baseline_source: null,
    local_dependency_snapshot: null,
    expected_verification: "exact_body_and_bytes",
    proposed_body: prepared.body,
  };
}

export function finaliseLegacyObservationManifestCompatibility({
  output,
  preparation,
} = {}) {
  if (!preparation?.prepared?.length) return output;
  if (!output?.planning || !Array.isArray(output.planning.proposals)) {
    throw new Error("Legacy manifest compatibility requires metadata planning output");
  }
  const state = readJsonFile(preparation.run_state_path, preparation.run_state_path);
  state.objects = isPlainObject(state.objects) ? state.objects : {};
  const proposals = new Map(output.planning.proposals.map((proposal) => [proposal.key, proposal]));
  const byDay = new Map();

  for (const prepared of preparation.prepared) {
    const connectorProposal = proposals.get(prepared.connector_key);
    if (!connectorProposal || connectorProposal.kind !== "connector_manifest") {
      throw new Error(
        `Blocked dependency: canonical connector proposal missing for ${prepared.connector_key}`,
      );
    }
    fs.writeFileSync(
      prepared.connector_overlay_path,
      `${connectorProposal.proposed_body.replace(/\n?$/, "")}\n`,
      "utf8",
    );
    const connectorBody = fs.readFileSync(prepared.connector_overlay_path, "utf8");
    state.objects[prepared.connector_key] = stateObject(
      prepared.connector_overlay_path,
      connectorBody,
      { source: "canonical_connector_manifest_proposal" },
    );
    const dayKeys = byDay.get(prepared.day_utc) || [];
    for (const pollutant of prepared.pollutant_proposals) {
      proposals.set(pollutant.key, proposalForPollutant(pollutant));
      dayKeys.push(pollutant.key);
    }
    byDay.set(prepared.day_utc, dayKeys);
  }

  saveRunState(preparation.run_state_path, state);
  output.planning.proposals = [...proposals.values()]
    .sort((left, right) => left.key.localeCompare(right.key));
  const addDayKeys = (plan) => {
    const extra = byDay.get(plan?.day_utc) || [];
    if (!extra.length) return plan;
    return {
      ...plan,
      proposal_keys: [...new Set([...(plan.proposal_keys || []), ...extra])].sort(),
    };
  };
  output.planning.days = Array.isArray(output.planning.days)
    ? output.planning.days.map(addDayKeys)
    : output.planning.days;
  output.results = Array.isArray(output.results) ? output.results.map(addDayKeys) : output.results;
  output.planning.compatibility_preparation = {
    status: "planned",
    connector_count: preparation.prepared.length,
    pollutant_manifest_count: preparation.prepared.reduce(
      (total, item) => total + item.pollutant_proposals.length,
      0,
    ),
    connectors: preparation.prepared.map((item) => ({
      day_utc: item.day_utc,
      connector_id: item.connector_id,
      connector_key: item.connector_key,
      pollutant_manifest_keys: item.pollutant_proposals.map((value) => value.key).sort(),
    })),
  };
  return output;
}
