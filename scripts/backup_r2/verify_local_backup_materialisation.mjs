#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  assertSha256,
  normalizeRelativePath,
  sha256Hex,
  validateHierarchicalStateRoot,
  validateObservationMonthState,
} from "./lib/hierarchical_backup_v2.mjs";
import { validateCoreState } from "./lib/hierarchical_core_backup_v2.mjs";
import { normalizeTimeseriesBindingRootState, validateTimeseriesBindingRangeState } from "./lib/hierarchical_timeseries_binding_sync_v2.mjs";
import {
  normalizeTimeseriesBindingPackRootState,
  validateTimeseriesBindingPackRangeState,
} from "./lib/hierarchical_timeseries_binding_pack_sync_v1.mjs";
import { validateCanonicalHistoryV2Manifest } from "../../workers/shared/uk_aq_r2_history_manifest_validation.mjs";
import { classifyManifestFileIdentity } from "../../workers/shared/uk_aq_r2_file_identity.mjs";
import { validateR2HistoryV2ObservationsAggregateManifest } from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { resolveObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    args[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  for (const key of ["backup_root", "backup_report", "expected_observations_root", "generation", "output"]) {
    if (!args[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  if (!["v2", "v3"].includes(args.generation)) throw new Error("--generation must be v2 or v3");
  args.expected_observations_root = assertSha256(args.expected_observations_root, "expected observations root");
  return args;
}

function parseTimestamp(value, label) {
  const text = String(value || "").trim();
  const millis = Date.parse(text);
  if (!text || !Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return millis;
}

function localPath(root, relativePath) {
  const relative = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relative.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Local backup path escaped root: ${relative}`);
  }
  return resolved;
}

function readBytes(root, key) {
  return fs.readFileSync(localPath(root, key));
}

function readJson(root, key) {
  const bytes = readBytes(root, key);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function authenticateShard(root, key, expectedHash, validate) {
  const object = readJson(root, key);
  const actual = sha256Hex(object.bytes);
  if (actual !== assertSha256(expectedHash, `${key} state_shard_hash`)) {
    throw new Error(`State shard SHA-256 mismatch: ${key}`);
  }
  return validate(object.value);
}

function inRunInterval(value, startedAt, completedAt) {
  const timestamp = parseTimestamp(value, "copied_at");
  return timestamp >= startedAt && timestamp <= completedAt;
}

function descriptorList(manifest, primary, fallback) {
  const entries = Array.isArray(manifest?.[primary])
    ? manifest[primary]
    : Array.isArray(manifest?.[fallback]) ? manifest[fallback] : [];
  return entries;
}

function validateManifestReference(reference, manifest, label) {
  const expected = assertSha256(reference?.manifest_hash, `${label} reference manifest_hash`);
  if (manifest.manifest_hash !== expected) throw new Error(`${label} manifest reference mismatch`);
  if (String(reference?.manifest_key || "") !== manifest.manifest_key) throw new Error(`${label} manifest key mismatch`);
}

function authenticateObservationDay(root, generation, dayUtc, expectedManifestHash) {
  const dayKey = `${generation.observations_prefix}/day_utc=${dayUtc}/manifest.json`;
  const dayObject = readJson(root, dayKey);
  const day = dayObject.value;
  validateCanonicalHistoryV2Manifest(day, { domain: "observations", manifest_kind: "day", day_utc: dayUtc, manifest_key: dayKey });
  if (day.manifest_hash !== expectedManifestHash) throw new Error(`Observation day state identity mismatch: ${dayUtc}`);
  let objectCount = 1;
  const parquetKeys = new Set();
  for (const connectorReference of descriptorList(day, "connector_manifests", "child_manifests")) {
    const connectorKey = normalizeRelativePath(connectorReference.manifest_key);
    const connector = readJson(root, connectorKey).value;
    validateCanonicalHistoryV2Manifest(connector, {
      domain: "observations", manifest_kind: "connector", day_utc: dayUtc,
      connector_id: connectorReference.connector_id, manifest_key: connectorKey,
    });
    validateManifestReference(connectorReference, connector, `Observation connector ${connectorKey}`);
    objectCount += 1;
    for (const pollutantReference of descriptorList(connector, "pollutant_manifests", "child_manifests")) {
      const pollutantKey = normalizeRelativePath(pollutantReference.manifest_key);
      const pollutant = readJson(root, pollutantKey).value;
      validateCanonicalHistoryV2Manifest(pollutant, {
        domain: "observations", manifest_kind: "pollutant", day_utc: dayUtc,
        connector_id: connector.connector_id, pollutant_code: pollutantReference.pollutant_code,
        manifest_key: pollutantKey,
      });
      validateManifestReference(pollutantReference, pollutant, `Observation pollutant ${pollutantKey}`);
      objectCount += 1;
      for (const file of pollutant.files || []) {
        const fileKey = normalizeRelativePath(file.key);
        const bytes = readBytes(root, fileKey);
        const expectedSize = Number(file.bytes);
        const identity = classifyManifestFileIdentity(file.etag_or_hash, { objectKey: fileKey });
        if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || bytes.byteLength !== expectedSize) {
          throw new Error(`Observation Parquet byte-size mismatch: ${fileKey}`);
        }
        const actualHash = identity.type === "sha256"
          ? sha256Hex(bytes)
          : crypto.createHash("md5").update(bytes).digest("hex");
        if (identity.type === "etag" && !/^[0-9a-f]{32}$/.test(identity.value)) {
          throw new Error(`Observation Parquet ETag cannot be authenticated from local bytes: ${fileKey}`);
        }
        if (actualHash !== identity.value) throw new Error(`Observation Parquet content identity mismatch: ${fileKey}`);
        parquetKeys.add(fileKey);
      }
    }
  }
  return { objectCount: objectCount + parquetKeys.size };
}

function authenticateObservationHierarchy(root, generation, report, stateRoot, expectedRoot) {
  let count = 0;
  for (const keyRaw of report.observations.hierarchy_files_copied || []) {
    const key = normalizeRelativePath(keyRaw);
    const manifest = validateR2HistoryV2ObservationsAggregateManifest(readJson(root, key).value, {
      basePrefix: generation.observations_prefix,
    });
    let expected;
    if (key === generation.observations_root_key) expected = expectedRoot;
    else {
      const monthMatch = /\/year=(\d{4})\/month=(\d{2})\/manifest\.json$/.exec(key);
      const yearMatch = /\/year=(\d{4})\/manifest\.json$/.exec(key);
      if (monthMatch) {
        expected = stateRoot.observations.years.find((entry) => entry.year === monthMatch[1])
          ?.months.find((entry) => entry.month === monthMatch[2])?.processed_source_month_hash;
      } else if (yearMatch) {
        expected = stateRoot.observations.years.find((entry) => entry.year === yearMatch[1])?.processed_source_year_hash;
      }
    }
    if (!expected || manifest.content_hash !== expected) throw new Error(`Observation hierarchy identity mismatch: ${key}`);
    count += 1;
  }
  return count;
}

function coreManifestHash(manifest) {
  const { manifest_hash: ignored, ...payload } = manifest;
  return sha256Hex(Buffer.from(JSON.stringify(payload), "utf8"));
}

function authenticateCoreDay(root, generation, entry) {
  const dayRoot = `${generation.core_prefix}/day_utc=${entry.day_utc}`;
  const manifestKey = `${dayRoot}/manifest.json`;
  const manifestObject = readJson(root, manifestKey);
  if (sha256Hex(manifestObject.bytes) !== entry.manifest_hash) throw new Error(`Core manifest checkpoint identity mismatch: ${manifestKey}`);
  const manifest = manifestObject.value;
  if (!Array.isArray(manifest.tables) || manifest.tables.length === 0
    || new Set(manifest.tables.map((table) => String(table?.table || ""))).size !== manifest.tables.length) {
    throw new Error(`Core manifest table evidence is invalid: ${manifestKey}`);
  }
  if (manifest.day_utc !== entry.day_utc || assertSha256(manifest.manifest_hash, "core manifest_hash") !== coreManifestHash(manifest)) {
    throw new Error(`Core manifest identity mismatch: ${manifestKey}`);
  }
  const checksumLines = [];
  let objects = 1;
  for (const table of manifest.tables || []) {
    const relative = normalizeRelativePath(table.relative_path);
    const bytes = readBytes(root, `${dayRoot}/${relative}`);
    if (bytes.byteLength !== Number(table.compressed_bytes) || sha256Hex(bytes) !== assertSha256(table.sha256, `${relative} SHA-256`)) {
      throw new Error(`Core compressed payload identity mismatch: ${relative}`);
    }
    const uncompressed = zlib.gunzipSync(bytes);
    if (uncompressed.byteLength !== Number(table.uncompressed_bytes)
      || sha256Hex(uncompressed) !== assertSha256(table.sha256_uncompressed, `${relative} uncompressed SHA-256`)) {
      throw new Error(`Core uncompressed payload identity mismatch: ${relative}`);
    }
    checksumLines.push(`${sha256Hex(bytes)}  ${relative}`);
    objects += 1;
  }
  const checksums = manifest.checksums;
  const checksumKey = normalizeRelativePath(checksums?.key);
  const checksumBytes = readBytes(root, checksumKey);
  if (sha256Hex(checksumBytes) !== assertSha256(checksums?.sha256, "core checksums SHA-256")
    || checksumBytes.toString("utf8") !== `${checksumLines.join("\n")}\n`) {
    throw new Error(`Core checksums identity mismatch: ${checksumKey}`);
  }
  return objects + 1;
}

export function verifyLocalBackupMaterialisation(args) {
  const root = path.resolve(args.backup_root);
  const report = JSON.parse(fs.readFileSync(args.backup_report, "utf8"));
  const startedAt = parseTimestamp(report.started_at, "backup report started_at");
  const completedAt = parseTimestamp(report.completed_at, "backup report completed_at");
  if (completedAt < startedAt) throw new Error("Backup report interval is reversed");
  const generation = resolveObservationHistoryGeneration({ UK_AQ_R2_HISTORY_VERSION: args.generation });
  const stateKey = normalizeRelativePath(report.state_root_key);
  if (stateKey !== `${generation.backup_state_prefix}/root.json`) throw new Error("Backup report state_root_key contradicts generation");
  const stateObject = readJson(root, stateKey);
  const stateRoot = validateHierarchicalStateRoot(stateObject.value, generation.backup_state_prefix, generation);
  if (stateRoot.observations.processed_source_root_hash !== args.expected_observations_root) {
    throw new Error("Local checkpoint observations root does not match exact backup report");
  }

  let observationObjects = 0;
  const observationDays = Array.isArray(report.observations?.day_list) ? report.observations.day_list : [];
  if (observationDays.length !== Number(report.observations?.days_copied || 0)) {
    throw new Error("Observation changed-day count disagrees with exact backup report");
  }
  const monthShards = new Map();
  for (const dayUtc of observationDays) {
    const [year, month] = String(dayUtc).split("-");
    const summary = stateRoot.observations.years.find((entry) => entry.year === year)
      ?.months.find((entry) => entry.month === month);
    if (!summary?.state_shard_hash) throw new Error(`Observation state summary missing: ${year}-${month}`);
    const cacheKey = `${year}-${month}`;
    let shard = monthShards.get(cacheKey);
    if (!shard) {
      shard = authenticateShard(root, summary.state_shard_key, summary.state_shard_hash,
        (value) => validateObservationMonthState(value, year, month));
      monthShards.set(cacheKey, shard);
    }
    const stateDay = shard.days.find((entry) => entry.day_utc === dayUtc);
    if (!stateDay) throw new Error(`Observation day absent from authenticated state: ${dayUtc}`);
    observationObjects += authenticateObservationDay(root, generation, dayUtc, stateDay.manifest_hash).objectCount;
  }
  const hierarchyCount = authenticateObservationHierarchy(root, generation, report, stateRoot, args.expected_observations_root);
  observationObjects += hierarchyCount;

  let coreUnits = 0;
  let coreObjects = 0;
  if (Number(report.core?.copied || 0) > 0) {
    const reference = stateRoot.core;
    const coreState = authenticateShard(root, reference.state_shard_key, reference.state_shard_hash, validateCoreState);
    const changed = coreState.days.filter((entry) => entry.copied_at && inRunInterval(entry.copied_at, startedAt, completedAt));
    if (changed.length !== Number(report.core.copied)) throw new Error("Core changed-unit count disagrees with exact backup report");
    for (const entry of changed) coreObjects += authenticateCoreDay(root, generation, entry);
    coreUnits = changed.length;
  }

  let bindingUnits = 0;
  if (report.timeseries_binding_backup_mode === "pack") {
    const packRoot = normalizeTimeseriesBindingPackRootState(stateRoot);
    if (Number(report.timeseries_binding_packs?.packs_copied || 0) > 0) {
      for (const range of packRoot.ranges) {
        const shard = authenticateShard(root, range.state_shard_key, range.state_shard_hash,
          (value) => validateTimeseriesBindingPackRangeState(value, range.range_start, range.range_end));
        if (!shard.copied_at || !inRunInterval(shard.copied_at, startedAt, completedAt)) continue;
        const bytes = readBytes(root, shard.pack_relative_path);
        if (bytes.byteLength !== shard.pack_size || sha256Hex(bytes) !== shard.pack_sha256) {
          throw new Error(`Binding pack identity mismatch: ${shard.pack_relative_path}`);
        }
        bindingUnits += 1;
      }
      if (bindingUnits !== Number(report.timeseries_binding_packs.packs_copied)) throw new Error("Binding pack changed-unit count disagrees with exact backup report");
    }
    if (report.timeseries_binding_packs?.pack_root?.copied === true) {
      const bytes = readBytes(root, packRoot.pack_root_relative_path);
      if (bytes.byteLength !== packRoot.pack_root_size || sha256Hex(bytes) !== packRoot.processed_pack_root_sha256) {
        throw new Error("Binding pack root identity mismatch");
      }
      bindingUnits += 1;
    }
  } else if (report.timeseries_binding_backup_mode === "individual" && Number(report.timeseries_binding?.files_copied || 0) > 0) {
    const bindingRoot = normalizeTimeseriesBindingRootState(stateRoot);
    for (const range of bindingRoot.ranges) {
      const shard = authenticateShard(root, range.state_shard_key, range.state_shard_hash,
        (value) => validateTimeseriesBindingRangeState(value, range.range_start, range.range_end));
      for (const unit of shard.units) {
        if (!unit.copied_at || !inRunInterval(unit.copied_at, startedAt, completedAt)) continue;
        const key = `${generation.timeseries_binding_index_prefix}/timeseries_id=${unit.timeseries_id}.json`;
        const bytes = readBytes(root, key);
        JSON.parse(bytes.toString("utf8"));
        if (sha256Hex(bytes) !== unit.hash) throw new Error(`Individual binding identity mismatch: ${key}`);
        bindingUnits += 1;
      }
    }
    if (bindingUnits !== Number(report.timeseries_binding.files_copied)) throw new Error("Individual binding changed-unit count disagrees with exact backup report");
  }

  return {
    ok: true,
    phase: "local_materialisation_verified",
    completed_at: new Date().toISOString(),
    generation: args.generation,
    state_root_key: stateKey,
    expected_observations_root_hash: args.expected_observations_root,
    verified_observation_day_count: observationDays.length,
    verified_observation_object_count: observationObjects,
    verified_core_unit_count: coreUnits,
    verified_core_object_count: coreObjects,
    verified_binding_unit_count: bindingUnits,
    authenticated_state_shard_count: monthShards.size + (coreUnits > 0 ? 1 : 0) + bindingUnits,
  };
}

function writeResult(output, result) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv);
    writeResult(args.output, verifyLocalBackupMaterialisation(args));
    process.exitCode = 0;
  } catch (error) {
    const result = {
      ok: false,
      phase: "local_materialisation_pending",
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    if (args?.output) writeResult(args.output, result);
    console.error(result.error);
    process.exitCode = 2;
  }
}
