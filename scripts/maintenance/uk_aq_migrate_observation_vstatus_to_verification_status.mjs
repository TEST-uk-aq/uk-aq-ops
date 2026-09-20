#!/usr/bin/env node
// Temporary TEST-only physical-schema migration. Archive after R2 and normal Dropbox backup acceptance.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import { computeObservationContentHash, normalizeCanonicalObservationRow } from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import { OBSERVATION_HISTORY_COLUMNS_V3, observationHistoryPhysicalSchemaForColumns } from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import { OBSERVATION_HISTORY_ALIGNED_ROW_CAP, OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION, OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION } from "../../workers/shared/uk_aq_observation_history_target_writer.mjs";
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 } from "../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import { getObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { buildObservationHistoryV3SteadyStatePartition, OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES } from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { updateObservationHistoryExactLeafIndexV3Latest, encodeObservationHistoryIndexV3Json } from "../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { buildHistoryV2ConnectorManifest, buildHistoryV2ConnectorManifestKey, buildHistoryV2DayManifest, buildHistoryV2DayManifestKey, buildHistoryV2PollutantManifestKey } from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { OBSERVATIONS_AGGREGATE_MANIFEST_KINDS, buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsYearManifest, buildR2HistoryV2ObservationsRootManifest, serializeR2HistoryV2ObservationsAggregateManifest, validateR2HistoryV2ObservationsAggregateManifest } from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { hasRequiredR2Config, r2GetObject, r2HeadObject, r2ListAllObjects, r2DeleteObjects, sha256Hex } from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { buildR2ChecksumAwarePutIntent, putAndVerifyR2ObjectWithSha256 } from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import { requireObservationsGlobalOperationLockContext } from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import { runCommandWithObservationsGlobalOperationLock } from "../operations/uk_aq_with_observations_global_operation_lock.mjs";
import { checkIntegrityDropboxCurrentness } from "../backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs";

const GENERATION = getObservationHistoryGeneration("v3");
const TEST_BUCKET = "uk-aq-history-cic-test";
const OLD_COLUMNS = Object.freeze([...OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6), "vstatus"]);
const PLAN_SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INTEGRITY_PYTHON = path.join(REPO_ROOT, "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py");

function sameColumns(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function classifyMigrationPhysicalColumns(columns) {
  if (sameColumns(columns, OLD_COLUMNS)) return "erroneous";
  if (sameColumns(columns, OBSERVATION_HISTORY_COLUMNS_V3)) return "canonical";
  observationHistoryPhysicalSchemaForColumns(columns);
  return "historical";
}

function exactStatus(value) {
  if (value === null || value === "P" || value === "R") return value;
  throw new Error("Migration physical status must be exactly P, R or null");
}

export function decodeMigrationPhysicalRow(values, columns) {
  const kind = classifyMigrationPhysicalColumns(columns);
  if (kind !== "erroneous" && kind !== "canonical") {
    throw new Error("Migration row decoder requires an exact seven-column schema");
  }
  if (!Array.isArray(values) || values.length !== 7) throw new Error("Migration Parquet row width is invalid");
  if (values[4] == null || typeof values[5] !== "number" || !Number.isFinite(values[5])) {
    throw new Error("Migration Parquet timestamp/value is invalid");
  }
  const timestamp = values[4] instanceof Date ? values[4] : new Date(values[4]);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Migration Parquet timestamp is invalid");
  // Only the migration-local physical decoder knows the old name. Shared code sees canonical rows.
  const physical = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return normalizeCanonicalObservationRow({
    connector_id: Number(physical.connector_id),
    station_id: physical.station_id == null ? null : Number(physical.station_id),
    timeseries_id: Number(physical.timeseries_id),
    pollutant_code: physical.pollutant_code,
    observed_at_utc: timestamp.toISOString(),
    value: physical.value,
    verification_status: exactStatus(kind === "erroneous" ? physical.vstatus : physical.verification_status),
  });
}

export async function decodeParquet(body, expectedKind = null) {
  const file = Uint8Array.from(body).buffer;
  const metadata = await parquetMetadataAsync(file);
  const columns = parquetSchema(metadata).children.map((column) => String(column.element.name));
  const kind = classifyMigrationPhysicalColumns(columns);
  if (expectedKind && kind !== expectedKind) throw new Error("Manifest/Parquet physical schema mismatch");
  const rowCount = Number(metadata.num_rows);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) throw new Error("Migration Parquet row count is invalid");
  if (kind === "historical") return { kind, columns, rowCount, rows: null };
  let decoded = null;
  await parquetRead({ file, metadata, columns, rowStart: 0, rowEnd: rowCount, compressors,
    onComplete: (rows) => { decoded = rows; } });
  if (!Array.isArray(decoded) || decoded.length !== rowCount) throw new Error("Migration Parquet decode row count mismatch");
  return { kind, columns, rowCount, rows: decoded.map((row) => decodeMigrationPhysicalRow(row, columns)) };
}

function exactIdentity(key, body) {
  return { key, byte_size: body.byteLength, sha256: sha256Hex(body) };
}

function r2IdentityKind(key) {
  if (typeof key === "string" && key.endsWith(".parquet")) return "parquet";
  if (typeof key === "string" && key.endsWith(".json")) return "json";
  throw new Error(`Unsupported migration R2 object type: ${String(key)}`);
}

async function readExactFromHead(r2, key, kind, head, expected = null) {
  const storedSha256 = head?.sha256;
  if (!head?.exists || !Number.isSafeInteger(head.bytes) || head.bytes < 0 ||
      (storedSha256 != null && !SHA256.test(storedSha256)) ||
      (kind === "parquet" && storedSha256 == null)) {
    throw new Error(`Strong stored R2 identity unavailable: ${key}`);
  }
  const object = await r2GetObject({ r2, key });
  const body = Buffer.from(object.body);
  const identity = exactIdentity(key, body);
  if (identity.byte_size !== head.bytes ||
      (storedSha256 != null && identity.sha256 !== storedSha256)) {
    throw new Error(`R2 HEAD/GET identity mismatch: ${key}`);
  }
  if (expected && (identity.key !== expected.key || identity.byte_size !== expected.byte_size ||
      identity.sha256 !== expected.sha256)) {
    throw new Error(`Pinned R2 identity mismatch: ${key}`);
  }
  return { ...identity, body };
}

export async function readExact(r2, key, expected = null) {
  const kind = r2IdentityKind(key);
  const head = await r2HeadObject({ r2, key });
  return readExactFromHead(r2, key, kind, head, expected);
}

function parseJson(object) {
  let payload;
  try { payload = JSON.parse(object.body.toString("utf8")); }
  catch { throw new Error(`Invalid canonical JSON: ${object.key}`); }
  return { ...object, payload };
}

function validateManifestHash(payload, key, kind) {
  if (payload?.manifest_key !== key || payload?.manifest_kind !== kind || payload?.domain !== "observations" ||
      payload?.history_version !== "v2" || !SHA256.test(String(payload?.manifest_hash || ""))) {
    throw new Error(`Invalid ${kind} manifest authority: ${key}`);
  }
  const { manifest_hash: manifestHash, ...unhashed } = payload;
  if (sha256Hex(JSON.stringify(unhashed)) !== manifestHash) throw new Error(`Manifest hash mismatch: ${key}`);
  return payload;
}

function pinnedManifestReference(parent, child, fields) {
  if (!child || !Array.isArray(parent.child_manifests)) throw new Error("Canonical parent child set is missing");
  const reference = parent.child_manifests.find((entry) => entry.manifest_key === child.manifest_key);
  if (!reference || parent.child_manifests.filter((entry) => entry.manifest_key === child.manifest_key).length !== 1 ||
      fields.some((field) => JSON.stringify(reference[field] ?? null) !== JSON.stringify(child[field] ?? null))) {
    throw new Error(`Canonical parent/child descriptor mismatch: ${child.manifest_key}`);
  }
}

function assertScope(payload, scope, kind) {
  if (payload.day_utc !== scope.day_utc ||
      (kind !== "day" && payload.connector_id !== scope.connector_id) ||
      (kind === "pollutant" && payload.pollutant_code !== scope.pollutant_code)) {
    throw new Error(`Canonical ${kind} scope mismatch: ${payload.manifest_key}`);
  }
}

function canonicalJsonPut(key, payload, stage, old = null, serializer = (value) => Buffer.from(JSON.stringify(value, null, 2), "utf8")) {
  const body = Buffer.from(serializer(payload));
  return { stage, key, old, target: exactIdentity(key, body), body_base64: body.toString("base64") };
}

function stageRank(stage) {
  return ["parquet", "pollutant", "connector", "index_child", "index_aligned_manifest", "index_scoped_manifest", "day", "month", "year", "root", "latest"].indexOf(stage);
}

export function sealMigrationPlan(core) {
  const body = JSON.stringify(core);
  return { ...core, plan_sha256: sha256Hex(Buffer.from(body, "utf8")) };
}

export function assertApplyArguments(args) {
  if (args.mode !== "apply" || args.apply !== true || !SHA256.test(String(args.expectedPlanSha256 || "")) || !args.planPath) {
    throw new Error("APPLY requires apply mode, --apply, --plan-path and --expected-plan-sha256");
  }
}

export function parseArgs(argv) {
  const args = { mode: null, planPath: null, expectedPlanSha256: null, expectedTestBucket: null,
    targetWriterGitSha: null, dropboxRoot: null, bindingBackupMode: "pack", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { args.apply = true; continue; }
    if (!Object.hasOwn({ "--mode": 1, "--plan-path": 1, "--expected-plan-sha256": 1,
      "--expected-test-bucket": 1, "--target-writer-git-sha": 1, "--dropbox-root": 1,
      "--binding-backup-mode": 1 }, flag)) throw new Error(`Unknown migration argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const property = { "--mode": "mode", "--plan-path": "planPath", "--expected-plan-sha256": "expectedPlanSha256",
      "--expected-test-bucket": "expectedTestBucket", "--target-writer-git-sha": "targetWriterGitSha",
      "--dropbox-root": "dropboxRoot", "--binding-backup-mode": "bindingBackupMode" }[flag];
    if (args[property] && property !== "bindingBackupMode") throw new Error(`Duplicate ${flag}`);
    args[property] = value;
  }
  if (!["plan", "apply", "verify"].includes(args.mode)) throw new Error("--mode must be plan, apply or verify");
  if (!args.planPath || !args.expectedTestBucket || !args.targetWriterGitSha || !args.dropboxRoot) {
    throw new Error("--plan-path, --expected-test-bucket, --target-writer-git-sha and --dropbox-root are required");
  }
  if (!/^[0-9a-f]{40}$/.test(args.targetWriterGitSha)) throw new Error("Target writer Git SHA must be a full lower-case SHA");
  if (!["pack", "individual"].includes(args.bindingBackupMode)) throw new Error("Unsupported binding backup mode");
  if (args.mode === "apply") assertApplyArguments(args);
  else if (args.apply || args.expectedPlanSha256) throw new Error("--apply and --expected-plan-sha256 are APPLY-only");
  return Object.freeze(args);
}

export function requireTestGuard(args, env = process.env) {
  if (!["TEST", "CIC-Test"].includes(String(env.UK_AQ_ENV_NAME || ""))) throw new Error("Migration requires explicit TEST environment");
  const r2 = resolveR2HistoryIndexConfig(env).r2;
  if (args.expectedTestBucket !== TEST_BUCKET || r2.bucket !== TEST_BUCKET || r2.bucket !== args.expectedTestBucket) {
    throw new Error("Migration requires the exact expected TEST R2 bucket");
  }
  if (env.UK_AQ_R2_HISTORY_VERSION !== "v3") throw new Error("Migration requires selected v3 observation generation");
  if (!hasRequiredR2Config(r2)) throw new Error("Migration requires complete TEST R2 configuration");
  return r2;
}

function readPlan(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const { plan_sha256: hash, ...core } = plan;
  if (!SHA256.test(String(hash || "")) || sealMigrationPlan(core).plan_sha256 !== hash ||
      plan.plan_schema_version !== PLAN_SCHEMA_VERSION || plan.purpose !== "physical-vstatus-to-verification_status") {
    throw new Error("Migration plan identity is invalid");
  }
  return plan;
}

function writePrivateFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    if (!fs.readFileSync(filePath).equals(body)) throw new Error(`Existing migration file differs: ${filePath}`);
    return;
  }
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temp, filePath);
  const directory = fs.openSync(path.dirname(filePath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function stagedParquetPath(planPath, sha256) {
  return path.join(`${path.resolve(planPath)}.payloads`, `${sha256}.parquet`);
}

function storedBody(planPath, put) {
  const body = put.stage === "parquet"
    ? fs.readFileSync(stagedParquetPath(planPath, put.target.sha256))
    : Buffer.from(put.body_base64, "base64");
  if (body.byteLength !== put.target.byte_size || sha256Hex(body) !== put.target.sha256) {
    throw new Error(`Prepared migration body identity mismatch: ${put.key}`);
  }
  return body;
}

function assertAggregateReference(reference, child, hashField) {
  if (reference.manifest_key !== child.key || reference[hashField] !== child.payload[hashField]) {
    throw new Error(`Canonical aggregate child identity mismatch: ${child.key}`);
  }
}

async function readAggregate(r2, reference, kind) {
  const object = parseJson(await readExact(r2, reference.manifest_key));
  const payload = validateR2HistoryV2ObservationsAggregateManifest(object.payload, {
    basePrefix: GENERATION.observations_prefix,
  });
  if (payload.kind !== kind) throw new Error(`Unexpected aggregate kind: ${object.key}`);
  assertAggregateReference(reference, object, "content_hash");
  return object;
}

function requireChildSet(manifest, kind) {
  const children = manifest.child_manifests;
  if (!Array.isArray(children) || !children.length) throw new Error(`Missing ${kind} child set: ${manifest.manifest_key}`);
  const keys = children.map((child) => String(child?.manifest_key || ""));
  if (keys.some((key) => !key || !key.startsWith(`${GENERATION.observations_prefix}/`)) || new Set(keys).size !== keys.length) {
    throw new Error(`Invalid ${kind} child membership: ${manifest.manifest_key}`);
  }
  return children;
}

function assertPartitionHash(manifest, rows) {
  const result = computeObservationContentHash(rows);
  const pairs = [
    ["row_count", result.observation_content_hash_row_count],
    ["source_row_count", result.observation_content_hash_row_count],
    ["observation_content_hash_row_count", result.observation_content_hash_row_count],
    ["observation_content_hash", result.observation_content_hash],
    ["verification_status_counts", result.verification_status_counts],
    ["observation_content_hash_columns", result.observation_content_hash_columns],
  ];
  for (const [field, value] of pairs) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(value)) {
      throw new Error(`Pre-migration logical invariant mismatch: ${manifest.manifest_key}: ${field}`);
    }
  }
  return {
    row_count: result.observation_content_hash_row_count,
    observation_content_hash: result.observation_content_hash,
    verification_status_counts: result.verification_status_counts,
  };
}

async function inspectPollutant(r2, manifestObject, scope, referencedKeys, allObjects) {
  const manifest = validateManifestHash(manifestObject.payload, manifestObject.key, "pollutant");
  assertScope(manifest, scope, "pollutant");
  const manifestKind = classifyMigrationPhysicalColumns(manifest.columns);
  if (manifestKind === "erroneous" && (manifest.history_schema_version !== 3 ||
      manifest.writer_version !== "parquet-wasm-zstd-v3" || manifest.manifest_schema_version !== 3)) {
    throw new Error(`Erroneous physical manifest has unsupported writer identity: ${manifestObject.key}`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.file_count !== manifest.files.length) {
    throw new Error(`Invalid pollutant file set: ${manifestObject.key}`);
  }
  const rows = [];
  const files = [];
  const seen = new Set();
  for (const file of manifest.files) {
    const key = String(file?.key || "");
    const partitionPrefix = manifestObject.key.replace(/manifest\.json$/, "");
    if (!key.startsWith(partitionPrefix) || !/\/part-\d{5}\.parquet$/.test(key) || seen.has(key)) {
      throw new Error(`Invalid authoritative Parquet key: ${key}`);
    }
    seen.add(key);
    referencedKeys.add(key);
    const object = await readExact(r2, key);
    allObjects.set(key, { key, byte_size: object.byte_size, sha256: object.sha256 });
    if (file.bytes !== object.byte_size || file.etag_or_hash !== object.sha256) {
      throw new Error(`Manifest/Parquet strong identity mismatch: ${key}`);
    }
    const decoded = await decodeParquet(object.body);
    if (decoded.kind !== manifestKind || !sameColumns(decoded.columns, manifest.columns) || decoded.rowCount !== file.row_count) {
      throw new Error(`Manifest/Parquet footer mismatch: ${key}`);
    }
    if (manifestKind === "erroneous" || manifestKind === "canonical") {
      for (const row of decoded.rows) {
        if (row.connector_id !== scope.connector_id || row.pollutant_code !== scope.pollutant_code ||
            row.observed_at_utc.slice(0, 10) !== scope.day_utc) {
          throw new Error(`Migration Parquet row escaped partition: ${key}`);
        }
      }
      rows.push(...decoded.rows);
    }
    files.push({ key, byte_size: object.byte_size, sha256: object.sha256 });
  }
  if (!Array.isArray(manifest.parquet_object_keys) ||
      manifest.total_bytes !== files.reduce((sum, file) => sum + file.byte_size, 0) ||
      JSON.stringify([...manifest.parquet_object_keys].sort()) !== JSON.stringify(files.map((file) => file.key).sort())) {
    throw new Error(`Pollutant manifest file set/size mismatch: ${manifestObject.key}`);
  }
  const logical = manifestKind === "erroneous" || manifestKind === "canonical"
    ? assertPartitionHash(manifest, rows) : null;
  if (logical) {
    const actualCounts = {};
    for (const row of rows) actualCounts[String(row.timeseries_id)] = (actualCounts[String(row.timeseries_id)] || 0) + 1;
    if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.timeseries_row_counts)) {
      throw new Error(`Pollutant timeseries row counts mismatch: ${manifestObject.key}`);
    }
  }
  return { scope, manifest: manifestObject, files, kind: manifestKind, rows, logical };
}

function scopeKey(scope) { return `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`; }
function connectorKey(scope) { return `${scope.day_utc}\u0000${scope.connector_id}`; }
function monthKey(dayUtc) { return dayUtc.slice(0, 7); }

async function inventoryAuthoritative(r2, { onAffected = null } = {}) {
  const referencedKeys = new Set();
  const allObjects = new Map();
  const root = parseJson(await readExact(r2, GENERATION.observations_root_key));
  const rootPayload = validateR2HistoryV2ObservationsAggregateManifest(root.payload, {
    basePrefix: GENERATION.observations_prefix,
  });
  if (rootPayload.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root) throw new Error("Canonical observations root kind is invalid");
  referencedKeys.add(root.key);
  allObjects.set(root.key, exactIdentity(root.key, root.body));
  const years = new Map(), months = new Map(), days = new Map(), connectors = new Map(), pollutants = new Map();
  const affected = [];
  for (const yearReference of rootPayload.children) {
    const year = await readAggregate(r2, yearReference, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year);
    referencedKeys.add(year.key); allObjects.set(year.key, exactIdentity(year.key, year.body));
    years.set(String(year.payload.year), year);
    for (const monthReference of year.payload.children) {
      const month = await readAggregate(r2, monthReference, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month);
      referencedKeys.add(month.key); allObjects.set(month.key, exactIdentity(month.key, month.body));
      const ym = `${year.payload.year}-${month.payload.month}`;
      months.set(ym, month);
      for (const dayReference of month.payload.children) {
        const dayUtc = String(dayReference.day_utc);
        const dayKey = buildHistoryV2DayManifestKey(GENERATION.observations_prefix, dayUtc);
        if (dayReference.manifest_key !== dayKey) throw new Error(`Invalid canonical day key: ${dayUtc}`);
        const day = parseJson(await readExact(r2, dayKey));
        validateManifestHash(day.payload, day.key, "day");
        assertScope(day.payload, { day_utc: dayUtc }, "day");
        assertAggregateReference(dayReference, day, "manifest_hash");
        referencedKeys.add(day.key); allObjects.set(day.key, exactIdentity(day.key, day.body));
        days.set(dayUtc, day);
        for (const connectorReference of requireChildSet(day.payload, "day")) {
          const connectorId = Number(connectorReference.connector_id);
          const ckey = buildHistoryV2ConnectorManifestKey(GENERATION.observations_prefix, dayUtc, connectorId);
          if (connectorReference.manifest_key !== ckey) throw new Error(`Invalid canonical connector key: ${ckey}`);
          const connector = parseJson(await readExact(r2, ckey));
          validateManifestHash(connector.payload, connector.key, "connector");
          assertScope(connector.payload, { day_utc: dayUtc, connector_id: connectorId }, "connector");
          pinnedManifestReference(day.payload, connector.payload, ["manifest_hash", "row_count", "file_count", "total_bytes"]);
          referencedKeys.add(ckey); allObjects.set(ckey, exactIdentity(ckey, connector.body));
          connectors.set(`${dayUtc}\u0000${connectorId}`, connector);
          for (const pollutantReference of requireChildSet(connector.payload, "connector")) {
            const pollutantCode = String(pollutantReference.pollutant_code || "");
            const pkey = buildHistoryV2PollutantManifestKey(GENERATION.observations_prefix, dayUtc, connectorId, pollutantCode);
            if (pollutantReference.manifest_key !== pkey) throw new Error(`Invalid canonical pollutant key: ${pkey}`);
            const pollutant = parseJson(await readExact(r2, pkey));
            pinnedManifestReference(connector.payload, pollutant.payload, ["manifest_hash", "row_count", "file_count", "total_bytes"]);
            referencedKeys.add(pkey); allObjects.set(pkey, exactIdentity(pkey, pollutant.body));
            const scope = { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode };
            const inspected = await inspectPollutant(r2, pollutant, scope, referencedKeys, allObjects);
            pollutants.set(scopeKey(scope), inspected);
            if (inspected.kind === "erroneous") {
              if (onAffected) await onAffected(inspected);
              affected.push(inspected);
            }
            inspected.rows = [];
          }
        }
      }
    }
  }
  affected.sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
  return { root, years, months, days, connectors, pollutants, affected, referencedKeys, allObjects };
}

async function inventoryResiduals(r2, referencedKeys) {
  const objects = await r2ListAllObjects({ r2, prefix: `${GENERATION.observations_prefix}/` });
  const residuals = [];
  for (const entry of objects) {
    const key = String(entry?.key || "");
    if (referencedKeys.has(key) || !(key.endsWith(".parquet") || key.endsWith("/manifest.json"))) continue;
    const object = await readExact(r2, key);
    if (key.endsWith(".parquet")) {
      const decoded = await decodeParquet(object.body);
      if (decoded.kind === "erroneous") residuals.push({ ...exactIdentity(key, object.body), kind: "parquet" });
    } else {
      const manifest = parseJson(object).payload;
      if (JSON.stringify(manifest).includes('"vstatus"')) {
        residuals.push({ ...exactIdentity(key, object.body), kind: "manifest" });
      }
    }
  }
  return residuals.sort((left, right) => left.key.localeCompare(right.key));
}

async function inspectOldIndex(r2, inspected, latest) {
  const scope = inspected.scope;
  const roots = (latest.payload.day_summaries || []).flatMap((day) => day.scoped_roots || []);
  const references = roots.filter((entry) => entry.day_utc === scope.day_utc &&
    entry.connector_id === scope.connector_id && entry.pollutant_code === scope.pollutant_code);
  if (references.length !== 1) throw new Error(`Exact-v3 latest scope membership mismatch: ${scopeKey(scope)}`);
  const root = references[0];
  const scoped = parseJson(await readExact(r2, root.key, root));
  const expectedFiles = new Map(inspected.files.map((file) => [file.key, file]));
  if (scoped.payload.day_utc !== scope.day_utc || scoped.payload.connector_id !== scope.connector_id ||
      scoped.payload.pollutant_code !== scope.pollutant_code || scoped.payload.coverage?.row_count !== inspected.logical.row_count) {
    throw new Error(`Exact-v3 scoped scope/content mismatch: ${scoped.key}`);
  }
  const alignedRef = scoped.payload.source_aligned_scoped_manifest;
  const aligned = parseJson(await readExact(r2, alignedRef.key, alignedRef));
  const oldManifest = inspected.manifest;
  const source = aligned.payload.canonical_source_manifest;
  if (!source || !sameIdentity(source, oldManifest) ||
      source.manifest_hash !== oldManifest.payload.manifest_hash ||
      source.observation_content_hash !== inspected.logical.observation_content_hash) {
    throw new Error(`Exact-v3 aligned source authority mismatch: ${aligned.key}`);
  }
  const referencesToRead = [
    ...Object.values(scoped.payload.leaves_by_timeseries_id || {}).map(([key, byte_size, sha256]) => ({ key, byte_size, sha256 })),
    ...(aligned.payload.children || []),
  ];
  const actualTimeseries = Object.keys(inspected.manifest.payload.timeseries_row_counts || {}).sort((a, b) => Number(a) - Number(b));
  const indexedTimeseries = Object.keys(scoped.payload.leaves_by_timeseries_id || {}).sort((a, b) => Number(a) - Number(b));
  if (JSON.stringify(actualTimeseries) !== JSON.stringify(indexedTimeseries)) {
    throw new Error(`Exact-v3 leaf membership mismatch: ${scoped.key}`);
  }
  const objects = [scoped, aligned];
  for (const reference of referencesToRead) {
    const object = parseJson(await readExact(r2, reference.key, reference));
    for (const file of object.payload.files || []) {
      const expected = expectedFiles.get(file.key);
      if (!expected || expected.byte_size !== file.byte_size || expected.sha256 !== file.sha256) {
        throw new Error(`Exact-v3 child/file identity mismatch: ${object.key}`);
      }
    }
    if (object.payload.kind === "observation_timeseries_physical_leaf") {
      const count = Number(inspected.manifest.payload.timeseries_row_counts[String(object.payload.timeseries_id)] || 0);
      if (object.payload.row_count !== count) throw new Error(`Exact-v3 leaf row count mismatch: ${object.key}`);
    }
    if (object.payload.kind === "observation_timeseries_aligned_source_shard" &&
        (!sameIdentity(object.payload.canonical_source_manifest, oldManifest) ||
          object.payload.canonical_source_manifest.manifest_hash !== oldManifest.payload.manifest_hash)) {
      throw new Error(`Exact-v3 aligned shard source mismatch: ${object.key}`);
    }
    objects.push(object);
  }
  return objects.map((object) => ({ key: object.key, byte_size: object.byte_size, sha256: object.sha256 }));
}

function artifactPut(artifact, stage, old = null) {
  const body = Buffer.from(artifact.body);
  if (artifact.byte_size !== body.byteLength || artifact.sha256 !== sha256Hex(body)) {
    throw new Error(`Target builder artifact identity mismatch: ${artifact.key}`);
  }
  return { stage, key: artifact.key, old, target: exactIdentity(artifact.key, body), body_base64: body.toString("base64") };
}

function oldIdentity(object) {
  return object ? { key: object.key, byte_size: object.byte_size, sha256: object.sha256 } : null;
}

function parentJsonPut(payload, old, stage) {
  const key = payload.manifest_key;
  const put = canonicalJsonPut(key, payload, stage, oldIdentity(old));
  validateManifestHash(payload, key, stage);
  return put;
}

function assertTargetLogicalInvariants(inspected, prepared) {
  const target = prepared.target_metadata;
  const old = inspected.logical;
  if (old.row_count !== target.row_count || old.observation_content_hash !== target.observation_content_hash ||
      JSON.stringify(old.verification_status_counts) !== JSON.stringify(target.verification_status_counts)) {
    throw new Error(`Physical rename changed canonical logical content: ${scopeKey(inspected.scope)}`);
  }
  for (const field of ["min_timeseries_id", "max_timeseries_id", "min_observed_at_utc", "max_observed_at_utc", "timeseries_row_counts"]) {
    if (JSON.stringify(inspected.manifest.payload[field] ?? null) !==
        JSON.stringify(prepared.canonical_pollutant_manifest.payload[field] ?? null)) {
      throw new Error(`Physical rename changed ${field}: ${scopeKey(inspected.scope)}`);
    }
  }
}

function readinessFromIntegrityPython(startedAt) {
  const script = [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('uk_aq_integrity_gate',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name]=module",
    "spec.loader.exec_module(module)",
    "url,key=module.resolve_backup_gate_credentials()",
    "result=module.check_dropbox_backup_ready(supabase_url=url,service_role_key=key,integrity_started_at_utc=sys.argv[2],allow_stale_dropbox=False)",
    "print(json.dumps(result,separators=(',',':')))",
  ].join("\n");
  const raw = execFileSync("python3", ["-c", script, INTEGRITY_PYTHON, startedAt], {
    cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(raw);
  if (result.backup_ready !== true || result.allow_stale_dropbox !== false || !result.backup_run_id) {
    throw new Error(`Existing Integrity latest-writer backup gate blocked migration: ${result.blocked_reason || "unknown"}`);
  }
  return {
    backup_run_id: result.backup_run_id,
    backup_started_at: result.backup_started_at,
    backup_finished_at: result.backup_finished_at,
    latest_writer_finished_at: result.latest_writer_finished_at,
  };
}

async function backupGate(args, env, r2, lockContext) {
  const currentness = await checkIntegrityDropboxCurrentness({
    dropboxRoot: args.dropboxRoot,
    observationGeneration: "v3",
    timeseriesBindingBackupMode: args.bindingBackupMode,
    env,
    lockContext,
    getLiveRoot: async ({ key }) => readExact(r2, key),
  });
  if (!currentness.allowed || !currentness.checkpoint_live_root_match) {
    throw new Error("Existing Dropbox checkpoint/R2 currentness gate blocked migration");
  }
  const readiness = readinessFromIntegrityPython(new Date().toISOString());
  return {
    checkpoint: currentness.checkpoint,
    live_observations_root: currentness.live_observations_root,
    readiness,
  };
}

async function makePlan(args, env, r2, lockContext) {
  const gate = await backupGate(args, env, r2, lockContext);
  const latest = parseJson(await readExact(r2, GENERATION.observations_timeseries_latest_key));
  if (latest.body.toString("utf8") !== encodeObservationHistoryIndexV3Json(latest.payload)) {
    throw new Error("Existing exact-v3 latest JSON bytes are not canonical");
  }
  const puts = [], deletions = [], affectedScopes = [], changedConnectors = new Map(), changedDays = new Map();
  const oldIndexByKey = new Map();
  const onAffected = async (inspected) => {
    const oldIndex = await inspectOldIndex(r2, inspected, latest);
    for (const entry of oldIndex) oldIndexByKey.set(entry.key, entry);
    const prepared = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
      rows: inspected.rows,
      scope: inspected.scope,
      targetWriterGitSha: args.targetWriterGitSha,
      backedUpAtUtc: inspected.manifest.payload.backed_up_at_utc,
    });
    assertTargetLogicalInvariants(inspected, prepared);
    const oldFiles = new Map(inspected.files.map((entry) => [entry.key, entry]));
    const targetFileKeys = new Set();
    for (const intent of prepared.file_intents) {
      const body = Buffer.from(intent.body);
      const target = exactIdentity(intent.key, body);
      if (intent.sha256 !== target.sha256 || intent.byte_size !== target.byte_size) throw new Error("Writer Parquet intent changed");
      writePrivateFile(stagedParquetPath(args.planPath, target.sha256), body);
      puts.push({ stage: "parquet", key: intent.key, old: oldFiles.get(intent.key) || null, target });
      targetFileKeys.add(intent.key);
    }
    for (const file of inspected.files) if (!targetFileKeys.has(file.key)) deletions.push(file);
    puts.push(artifactPut(prepared.canonical_pollutant_manifest, "pollutant", oldIdentity(inspected.manifest)));
    for (const artifact of prepared.v3_hierarchy.publication_objects) {
      const stage = artifact.kind === "observation_history_index_v3_exact_leaf_scoped_manifest"
        ? "index_scoped_manifest"
        : artifact.kind === "observation_history_index_v3_aligned_source_manifest"
        ? "index_aligned_manifest" : "index_child";
      puts.push(artifactPut(artifact, stage, oldIndexByKey.get(artifact.key) || null));
    }
    affectedScopes.push({
      scope: inspected.scope,
      old_pollutant_manifest: oldIdentity(inspected.manifest),
      old_parquet_files: inspected.files,
      old_index_objects: oldIndex,
      target_pollutant_manifest: oldIdentity(prepared.canonical_pollutant_manifest),
      target_parquet_files: prepared.file_intents.map((entry, index) => ({ key: entry.key, byte_size: entry.byte_size,
        sha256: entry.sha256, row_count: prepared.target_metadata.files[index].row_count })),
      target_index_objects: prepared.v3_hierarchy.publication_objects.map(oldIdentity),
      logical_invariants: inspected.logical,
      min_observed_at_utc: inspected.manifest.payload.min_observed_at_utc,
      max_observed_at_utc: inspected.manifest.payload.max_observed_at_utc,
      timeseries_row_counts: inspected.manifest.payload.timeseries_row_counts,
    });
    const ckey = connectorKey(inspected.scope);
    if (!changedConnectors.has(ckey)) changedConnectors.set(ckey, new Map());
    changedConnectors.get(ckey).set(inspected.scope.pollutant_code, prepared.canonical_pollutant_manifest.payload);
    affectedScopes.at(-1)._scoped_manifest = prepared.v3_hierarchy.scoped_manifest;
  };
  const inventory = await inventoryAuthoritative(r2, { onAffected });
  affectedScopes.sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
  if (inventory.root.payload.content_hash !== gate.live_observations_root.content_hash) {
    throw new Error("Locked inventory root changed after backup/currentness gate");
  }
  const residuals = await inventoryResiduals(r2, inventory.referencedKeys);
  for (const [ckey, replacements] of [...changedConnectors].sort(([a], [b]) => a.localeCompare(b))) {
    const original = inventory.connectors.get(ckey);
    const children = requireChildSet(original.payload, "connector").map((entry) =>
      replacements.get(entry.pollutant_code) || inventory.pollutants.get(`${ckey}\u0000${entry.pollutant_code}`).manifest.payload);
    const payload = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: original.payload.day_utc,
      connectorId: original.payload.connector_id, runId: original.payload.run_id, manifestKey: original.key,
      pollutantManifests: children, writerGitSha: args.targetWriterGitSha,
      backedUpAtUtc: original.payload.backed_up_at_utc });
    puts.push(parentJsonPut(payload, original, "connector"));
    changedDays.set(payload.day_utc, changedDays.get(payload.day_utc) || new Map());
    changedDays.get(payload.day_utc).set(payload.connector_id, payload);
  }
  const rebuiltDays = new Map();
  for (const [dayUtc, replacements] of [...changedDays].sort(([a], [b]) => a.localeCompare(b))) {
    const original = inventory.days.get(dayUtc);
    const children = requireChildSet(original.payload, "day").map((entry) =>
      replacements.get(Number(entry.connector_id)) || inventory.connectors.get(`${dayUtc}\u0000${entry.connector_id}`).payload);
    const payload = buildHistoryV2DayManifest({ domain: "observations", dayUtc, runId: original.payload.run_id,
      manifestKey: original.key, connectorManifests: children, writerGitSha: args.targetWriterGitSha,
      backedUpAtUtc: original.payload.backed_up_at_utc });
    puts.push(parentJsonPut(payload, original, "day"));
    rebuiltDays.set(dayUtc, payload);
  }
  const rebuiltMonths = new Map();
  for (const ym of [...new Set([...rebuiltDays.keys()].map(monthKey))].sort()) {
    const original = inventory.months.get(ym);
    const payload = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: GENERATION.observations_prefix,
      year: Number(ym.slice(0, 4)), month: ym.slice(5, 7), dayManifests: original.payload.children.map((entry) =>
        rebuiltDays.get(entry.day_utc) || entry) });
    puts.push(canonicalJsonPut(original.key, payload, "month", oldIdentity(original),
      (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix })));
    rebuiltMonths.set(ym, payload);
  }
  const rebuiltYears = new Map();
  for (const year of [...new Set([...rebuiltMonths.keys()].map((value) => value.slice(0, 4)))].sort()) {
    const original = inventory.years.get(year);
    const payload = buildR2HistoryV2ObservationsYearManifest({ basePrefix: GENERATION.observations_prefix,
      year: Number(year), monthManifests: original.payload.children.map((entry) =>
        rebuiltMonths.get(`${year}-${entry.month}`) || { year: Number(year), ...entry }) });
    puts.push(canonicalJsonPut(original.key, payload, "year", oldIdentity(original),
      (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix })));
    rebuiltYears.set(year, payload);
  }
  let finalRoot = inventory.root.payload;
  if (rebuiltYears.size) {
    finalRoot = buildR2HistoryV2ObservationsRootManifest({ basePrefix: GENERATION.observations_prefix,
      yearManifests: inventory.root.payload.children.map((entry) =>
        rebuiltYears.get(String(entry.year)) || entry) });
    puts.push(canonicalJsonPut(inventory.root.key, finalRoot, "root", oldIdentity(inventory.root),
      (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix })));
    const oldLatestArtifact = { kind: "observation_history_index_v3_latest_global", publication_stage: "latest_global",
      key: latest.key, body: latest.body.toString("utf8"), payload: latest.payload,
      byte_size: latest.byte_size, sha256: latest.sha256 };
    const targetLatest = updateObservationHistoryExactLeafIndexV3Latest({ existingLatest: oldLatestArtifact,
      replacementScopedManifests: affectedScopes.map((entry) => entry._scoped_manifest) });
    puts.push(artifactPut(targetLatest, "latest", oldIdentity(latest)));
  }
  for (const entry of affectedScopes) delete entry._scoped_manifest;
  puts.sort((left, right) => stageRank(left.stage) - stageRank(right.stage) || left.key.localeCompare(right.key));
  if (puts.some((entry) => stageRank(entry.stage) < 0) || new Set(puts.map((entry) => entry.key)).size !== puts.length) {
    throw new Error("Migration publication graph has duplicate or unknown keys");
  }
  const core = {
    plan_schema_version: PLAN_SCHEMA_VERSION,
    purpose: "physical-vstatus-to-verification_status",
    environment: "TEST",
    bucket: r2.bucket,
    repository_head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    target_writer_git_sha: args.targetWriterGitSha,
    generation: "v3",
    target_physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    target_aligned_row_cap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
    target_exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
    target_decode_profile: OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE,
    target_writer_limits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
    pre_migration_observations_root: { ...oldIdentity(inventory.root), content_hash: inventory.root.payload.content_hash },
    backup_evidence: gate,
    old_latest_index: oldIdentity(latest),
    pinned_authoritative_objects: [...inventory.allObjects.values()].sort((a, b) => a.key.localeCompare(b.key)),
    affected_scopes: affectedScopes,
    planned_puts: puts,
    planned_deletions: deletions.sort((a, b) => a.key.localeCompare(b.key)),
    unreferenced_bad_schema_residuals: residuals,
    final_observations_root: puts.find((entry) => entry.stage === "root")?.target || oldIdentity(inventory.root),
    final_observations_root_content_hash: finalRoot.content_hash,
  };
  const plan = sealMigrationPlan(core);
  writePrivateFile(args.planPath, Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8"));
  return plan;
}

function assertPlanMatchesInvocation(plan, args, r2) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  if (plan.environment !== "TEST" || plan.bucket !== TEST_BUCKET || r2.bucket !== plan.bucket ||
      plan.generation !== "v3" || plan.target_writer_git_sha !== args.targetWriterGitSha ||
      plan.repository_head !== head ||
      plan.target_physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
      plan.target_aligned_row_cap !== OBSERVATION_HISTORY_ALIGNED_ROW_CAP ||
      plan.target_exact_leaf_index_version !== OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION ||
      JSON.stringify(plan.target_decode_profile) !== JSON.stringify(OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE) ||
      JSON.stringify(plan.target_writer_limits) !== JSON.stringify(ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3)) {
    throw new Error("Migration plan does not match TEST bucket, repository or target writer");
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.key === right.key &&
    left.byte_size === right.byte_size && left.sha256 === right.sha256);
}

export async function currentIdentity(r2, key) {
  const kind = r2IdentityKind(key);
  const head = await r2HeadObject({ r2, key });
  if (head?.exists === false) return null;
  const object = await readExactFromHead(r2, key, kind, head);
  return { key, byte_size: object.byte_size, sha256: object.sha256 };
}

async function assertPinnedPrestate(r2, plan, { rootAlreadyTarget = false } = {}) {
  const puts = new Map(plan.planned_puts.map((put) => [put.key, put]));
  const deletions = new Set(plan.planned_deletions.map((entry) => entry.key));
  const pins = new Map(plan.pinned_authoritative_objects.map((entry) => [entry.key, entry]));
  for (const scope of plan.affected_scopes) {
    for (const entry of scope.old_index_objects) pins.set(entry.key, entry);
  }
  pins.set(plan.old_latest_index.key, plan.old_latest_index);
  for (const put of plan.planned_puts) if (!pins.has(put.key)) pins.set(put.key, null);
  for (const [key, old] of [...pins].sort(([a], [b]) => a.localeCompare(b))) {
    const current = await currentIdentity(r2, key);
    const target = puts.get(key)?.target || null;
    if (sameIdentity(current, old) || sameIdentity(current, target) ||
        (current === null && old === null) ||
        (current === null && rootAlreadyTarget && deletions.has(key))) continue;
    throw new Error(`Pinned migration prestate has a third identity: ${key}`);
  }
  const root = await readExact(r2, plan.pre_migration_observations_root.key);
  if (rootAlreadyTarget) {
    if (!sameIdentity(root, plan.final_observations_root)) throw new Error("Resume root target identity changed");
  } else if (!sameIdentity(root, plan.pre_migration_observations_root)) {
    throw new Error("Pre-migration observations root changed before APPLY");
  }
}

function journalPath(planPath) { return `${path.resolve(planPath)}.progress.json`; }

function loadJournal(planPath, plan) {
  const location = journalPath(planPath);
  if (!fs.existsSync(location)) return null;
  const journal = JSON.parse(fs.readFileSync(location, "utf8"));
  if (journal.plan_sha256 !== plan.plan_sha256 || journal.checkpoint_sha256 !== plan.backup_evidence.checkpoint.sha256 ||
      journal.backup_run_id !== plan.backup_evidence.readiness.backup_run_id) {
    throw new Error("Migration progress journal does not match pinned plan/backup");
  }
  return journal;
}

function assertPinnedCheckpointExists(plan) {
  const checkpoint = plan.backup_evidence.checkpoint;
  const body = fs.readFileSync(checkpoint.path);
  if (body.byteLength !== checkpoint.byte_size || sha256Hex(body) !== checkpoint.sha256) {
    throw new Error("Pinned Dropbox checkpoint changed after migration PLAN");
  }
}

function recordJournal(planPath, plan) {
  const journal = {
    plan_sha256: plan.plan_sha256,
    checkpoint_sha256: plan.backup_evidence.checkpoint.sha256,
    backup_run_id: plan.backup_evidence.readiness.backup_run_id,
    initial_gate_verified: true,
  };
  writePrivateFile(journalPath(planPath), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"));
}

async function verifyPublishedObject(r2, put, body, plan) {
  const published = await readExact(r2, put.key, put.target);
  if (!published.body.equals(body)) throw new Error(`Published object bytes changed: ${put.key}`);
  if (put.stage === "parquet") {
    const scope = plan.affected_scopes.find((entry) => entry.target_parquet_files.some((file) => file.key === put.key));
    const expectedFile = scope?.target_parquet_files.find((file) => file.key === put.key);
    const decoded = await decodeParquet(published.body, "canonical");
    if (!expectedFile || decoded.rowCount !== expectedFile.row_count ||
        decoded.rows.some((row) => row.connector_id !== scope.scope.connector_id ||
          row.pollutant_code !== scope.scope.pollutant_code || row.observed_at_utc.slice(0, 10) !== scope.scope.day_utc)) {
      throw new Error(`Published canonical Parquet semantic mismatch: ${put.key}`);
    }
  } else {
    const parsed = parseJson(published);
    if (put.stage === "pollutant" || put.stage === "connector" || put.stage === "day") {
      validateManifestHash(parsed.payload, put.key, put.stage);
      if (put.stage === "pollutant" && !sameColumns(parsed.payload.columns, OBSERVATION_HISTORY_COLUMNS_V3)) {
        throw new Error(`Published pollutant schema is not canonical: ${put.key}`);
      }
    }
    if (["month", "year", "root"].includes(put.stage)) {
      validateR2HistoryV2ObservationsAggregateManifest(parsed.payload, { basePrefix: GENERATION.observations_prefix });
    }
  }
}

async function verifyPartitionBeforeManifest(r2, plan, scope) {
  const rows = [];
  for (const file of scope.target_parquet_files) {
    const object = await readExact(r2, file.key, file);
    const decoded = await decodeParquet(object.body, "canonical");
    if (decoded.rowCount !== file.row_count) throw new Error(`Replacement Parquet row count mismatch: ${file.key}`);
    rows.push(...decoded.rows);
  }
  const result = computeObservationContentHash(rows);
  if (result.observation_content_hash_row_count !== scope.logical_invariants.row_count ||
      result.observation_content_hash !== scope.logical_invariants.observation_content_hash ||
      JSON.stringify(result.verification_status_counts) !== JSON.stringify(scope.logical_invariants.verification_status_counts)) {
    throw new Error(`Replacement partition changed logical content: ${scopeKey(scope.scope)}`);
  }
}

async function applyPlan(args, env, r2, lockContext) {
  assertApplyArguments(args);
  const plan = readPlan(args.planPath);
  if (plan.plan_sha256 !== args.expectedPlanSha256) throw new Error("Expected migration plan SHA-256 disagrees");
  assertPlanMatchesInvocation(plan, args, r2);
  if (!plan.affected_scopes.length) throw new Error("APPLY has no affected authoritative partitions");
  for (const put of plan.planned_puts) storedBody(args.planPath, put);
  assertPinnedCheckpointExists(plan);
  const rootNow = await currentIdentity(r2, plan.pre_migration_observations_root.key);
  const rootAlreadyTarget = sameIdentity(rootNow, plan.final_observations_root);
  if (rootAlreadyTarget) {
    if (!loadJournal(args.planPath, plan)) throw new Error("Completed-root resume requires pinned initial gate journal");
  } else {
    const gate = await backupGate(args, env, r2, lockContext);
    if (gate.checkpoint.sha256 !== plan.backup_evidence.checkpoint.sha256 ||
        gate.live_observations_root.content_hash !== plan.pre_migration_observations_root.content_hash ||
        gate.readiness.backup_run_id !== plan.backup_evidence.readiness.backup_run_id) {
      throw new Error("Current backup evidence differs from pinned PLAN");
    }
  }
  await assertPinnedPrestate(r2, plan, { rootAlreadyTarget });
  if (rootAlreadyTarget) {
    for (const put of plan.planned_puts.filter((entry) => entry.stage !== "latest")) {
      if (!sameIdentity(await currentIdentity(r2, put.key), put.target)) {
        throw new Error(`Completed-root resume has an unfinished child: ${put.key}`);
      }
    }
  } else if (!loadJournal(args.planPath, plan)) recordJournal(args.planPath, plan);
  for (const put of plan.planned_puts) {
    requireObservationsGlobalOperationLockContext({ env, expectedOwner: "migration" });
    const body = storedBody(args.planPath, put);
    const current = await currentIdentity(r2, put.key);
    if (!sameIdentity(current, put.target)) {
      if (!(sameIdentity(current, put.old) || (current === null && put.old === null))) {
        throw new Error(`Migration PUT key has a third identity: ${put.key}`);
      }
      if (put.stage === "pollutant") {
        const scope = plan.affected_scopes.find((entry) => entry.target_pollutant_manifest.key === put.key);
        if (!scope) throw new Error(`Pollutant publication scope missing: ${put.key}`);
        await verifyPartitionBeforeManifest(r2, plan, scope);
      }
      const intent = buildR2ChecksumAwarePutIntent({ key: put.key, body,
        contentType: put.stage === "parquet" ? "application/octet-stream" : "application/json; charset=utf-8" });
      await putAndVerifyR2ObjectWithSha256({ r2, intent });
    }
    await verifyPublishedObject(r2, put, body, plan);
  }
  for (const obsolete of plan.planned_deletions) {
    requireObservationsGlobalOperationLockContext({ env, expectedOwner: "migration" });
    const current = await currentIdentity(r2, obsolete.key);
    if (current === null) continue;
    if (!sameIdentity(current, obsolete)) throw new Error(`Obsolete part changed before deletion: ${obsolete.key}`);
    const deletion = await r2DeleteObjects({ r2, keys: [obsolete.key] });
    if (deletion.errors?.length || !deletion.deleted_keys?.includes(obsolete.key)) {
      throw new Error(`Obsolete part deletion was not accepted by R2: ${obsolete.key}`);
    }
    if (await currentIdentity(r2, obsolete.key)) throw new Error(`Obsolete part deletion not verified: ${obsolete.key}`);
  }
  return { status: "applied", plan_sha256: plan.plan_sha256,
    affected_partition_count: plan.affected_scopes.length, residual_candidate_count: plan.unreferenced_bad_schema_residuals.length };
}

async function verifyPlan(args, r2) {
  const plan = readPlan(args.planPath);
  assertPlanMatchesInvocation(plan, args, r2);
  const inventory = await inventoryAuthoritative(r2);
  const residuals = await inventoryResiduals(r2, inventory.referencedKeys);
  const latest = parseJson(await readExact(r2, GENERATION.observations_timeseries_latest_key));
  if (!sameIdentity(inventory.root, plan.final_observations_root) ||
      inventory.root.payload.content_hash !== plan.final_observations_root_content_hash) {
    throw new Error("Verified canonical observations root differs from planned target");
  }
  for (const put of plan.planned_puts) {
    const body = storedBody(args.planPath, put);
    await verifyPublishedObject(r2, put, body, plan);
  }
  for (const scope of plan.affected_scopes) {
    const current = inventory.pollutants.get(scopeKey(scope.scope));
    if (!current || current.kind !== "canonical" ||
        current.logical.row_count !== scope.logical_invariants.row_count ||
        current.logical.observation_content_hash !== scope.logical_invariants.observation_content_hash ||
        JSON.stringify(current.logical.verification_status_counts) !== JSON.stringify(scope.logical_invariants.verification_status_counts) ||
        !sameColumns(current.manifest.payload.columns, OBSERVATION_HISTORY_COLUMNS_V3) ||
        !sameIdentity(current.manifest, scope.target_pollutant_manifest)) {
      throw new Error(`Migrated authoritative partition verification failed: ${scopeKey(scope.scope)}`);
    }
    await inspectOldIndex(r2, current, latest);
  }
  for (const deleted of plan.planned_deletions) {
    if (await currentIdentity(r2, deleted.key)) throw new Error(`Obsolete referenced part remains: ${deleted.key}`);
  }
  return {
    status: inventory.affected.length ? "bad_schema_remains" : "verified",
    plan_sha256: plan.plan_sha256,
    migrated_partition_count: plan.affected_scopes.length,
    authoritative_bad_schema_partition_count: inventory.affected.length,
    unreferenced_bad_schema_residuals: residuals,
  };
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const r2 = requireTestGuard(args, env);
  const lockContext = requireObservationsGlobalOperationLockContext({ env, expectedOwner: "migration" });
  const result = args.mode === "plan" ? await makePlan(args, env, r2, lockContext)
    : args.mode === "apply" ? await applyPlan(args, env, r2, lockContext)
    : await verifyPlan(args, r2);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "bad_schema_remains" ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
    requireTestGuard(args, process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  if (args) {
    const existing = process.env.UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_HELD === "true";
    const operation = existing
      ? main({ argv, env: process.env })
      : runCommandWithObservationsGlobalOperationLock({
        databaseUrl: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
        owner: "migration", runId: randomUUID(), command: process.execPath,
        commandArgs: [fileURLToPath(import.meta.url), ...argv], env: process.env,
      });
    operation.then((code) => { process.exitCode = typeof code === "number" ? code : 0; })
      .catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
  }
}
