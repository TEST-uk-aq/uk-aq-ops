#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  classifyManifestFileIdentity,
} from "../../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  validateMigrationSourceObservationPollutantManifest,
} from "../backup_r2/lib/observation_history_migration_v3.mjs";
import {
  buildObservationsManifestHierarchy,
} from "../backup_r2/uk_aq_observations_manifest_hierarchy.mjs";

const SCRIPT_NAME = "uk_aq_build_reduced_v2_observations_source";
const OBSERVATIONS_PREFIX = "history/v2/observations";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  return [
    "Build a reduced canonical v2 observations tree from a local object-tree backup.",
    "",
    "Dry-run is the default. The source and destination roots are local object-store roots",
    `containing ${OBSERVATIONS_PREFIX}/...`,
    "",
    "Usage:",
    `  node scripts/index_v3_migration/${SCRIPT_NAME}.mjs \\`,
    "    --source-root <directory> --destination-root <new-directory> \\",
    "    --from-day YYYY-MM-DD --to-day YYYY-MM-DD \\",
    "    --connector-id <positive-integer> [--connector-id ...] \\",
    "    --pollutant <canonical-code> [--pollutant ...] [--write-output]",
    "",
    "Options:",
    "  --source-root <directory>       Existing extracted genuine-v2 object tree",
    "  --destination-root <directory>  New, absent or empty output object tree",
    "  --from-day YYYY-MM-DD            First UTC day, inclusive",
    "  --to-day YYYY-MM-DD              Last UTC day, inclusive",
    "  --connector-id <id>              Retained connector; repeatable",
    "  --pollutant <code>               Retained pollutant; repeatable",
    "  --dry-run                        Validate and report only (default)",
    "  --write-output                   Write the new local tree",
    "  -h, --help                       Show this help",
    "",
    "The CLI has no R2, Dropbox or network adapter.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeDay(raw, flag) {
  const day = String(raw || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD UTC day`);
  }
  return day;
}

function normalizeConnectorId(raw) {
  const connectorId = Number(raw);
  if (!Number.isSafeInteger(connectorId) || connectorId <= 0) {
    throw new Error(`--connector-id must be a positive integer: ${String(raw || "")}`);
  }
  return connectorId;
}

function normalizePollutant(raw) {
  const pollutant = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(pollutant)) {
    throw new Error(`--pollutant must be a canonical lower-case code: ${String(raw || "")}`);
  }
  return pollutant;
}

function parseArgs(argv) {
  const args = {
    sourceRoot: "",
    destinationRoot: "",
    fromDay: "",
    toDay: "",
    connectorIds: [],
    pollutants: [],
    writeOutput: false,
    sawDryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--source-root") args.sourceRoot = requireValue(argv, index++, flag);
    else if (flag === "--destination-root") args.destinationRoot = requireValue(argv, index++, flag);
    else if (flag === "--from-day") args.fromDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--to-day") args.toDay = normalizeDay(requireValue(argv, index++, flag), flag);
    else if (flag === "--connector-id") args.connectorIds.push(normalizeConnectorId(requireValue(argv, index++, flag)));
    else if (flag === "--pollutant") args.pollutants.push(normalizePollutant(requireValue(argv, index++, flag)));
    else if (flag === "--dry-run") args.sawDryRun = true;
    else if (flag === "--write-output") args.writeOutput = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const [field, flag] of [
    [args.sourceRoot, "--source-root"],
    [args.destinationRoot, "--destination-root"],
    [args.fromDay, "--from-day"],
    [args.toDay, "--to-day"],
  ]) {
    if (!field) throw new Error(`${flag} is required`);
  }
  if (!args.connectorIds.length) throw new Error("At least one --connector-id is required");
  if (!args.pollutants.length) throw new Error("At least one --pollutant is required");
  if (args.fromDay > args.toDay) throw new Error("--to-day must not be earlier than --from-day");
  if (args.sawDryRun && args.writeOutput) {
    throw new Error("Use either --dry-run or --write-output, not both");
  }
  args.connectorIds = [...new Set(args.connectorIds)].sort((left, right) => left - right);
  args.pollutants = [...new Set(args.pollutants)].sort();
  return args;
}

function daysInclusive(fromDay, toDay) {
  const days = [];
  const end = new Date(`${toDay}T00:00:00.000Z`).getTime();
  for (
    let current = new Date(`${fromDay}T00:00:00.000Z`).getTime();
    current <= end;
    current += 86_400_000
  ) {
    days.push(new Date(current).toISOString().slice(0, 10));
  }
  return days;
}

function canonicalPotentialPath(rawPath) {
  const absolute = path.resolve(rawPath);
  let existing = absolute;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = fs.realpathSync(existing);
  return path.join(canonicalExisting, ...suffix);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function resolveRoots(sourceRaw, destinationRaw) {
  const sourceRoot = canonicalPotentialPath(sourceRaw);
  const destinationRoot = canonicalPotentialPath(destinationRaw);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`--source-root is not an existing directory: ${sourceRoot}`);
  }
  if (
    sourceRoot === destinationRoot ||
    isWithin(sourceRoot, destinationRoot) ||
    isWithin(destinationRoot, sourceRoot)
  ) {
    throw new Error("Source and destination roots must be distinct and must not contain one another");
  }
  if (fs.existsSync(destinationRoot)) {
    if (!fs.statSync(destinationRoot).isDirectory()) {
      throw new Error(`--destination-root is not a directory: ${destinationRoot}`);
    }
    if (fs.readdirSync(destinationRoot).length > 0) {
      throw new Error(`Refusing populated destination: ${destinationRoot}`);
    }
  }
  return { sourceRoot, destinationRoot };
}

function localPathForObject(root, key) {
  const normalizedKey = String(key || "").replaceAll("\\", "/");
  if (
    !normalizedKey ||
    normalizedKey.startsWith("/") ||
    normalizedKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe object key: ${String(key || "")}`);
  }
  const target = path.resolve(root, ...normalizedKey.split("/"));
  if (!isWithin(root, target)) throw new Error(`Object key escapes local root: ${normalizedKey}`);
  return target;
}

function sourceFilePath(root, key, { required = true } = {}) {
  const filePath = localPathForObject(root, key);
  if (!fs.existsSync(filePath)) {
    if (!required) return null;
    throw new Error(`Required source object is missing: ${key}`);
  }
  const realPath = fs.realpathSync(filePath);
  if (!isWithin(root, realPath) || !fs.statSync(realPath).isFile()) {
    throw new Error(`Source object is not a regular file within --source-root: ${key}`);
  }
  return realPath;
}

function readRequiredFile(root, key) {
  return fs.readFileSync(sourceFilePath(root, key));
}

function parseJson(bytes, key) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root value is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON object ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyLocalFileIdentity({ bytes, entry }) {
  const key = String(entry?.key || "");
  const expectedBytes = Number(entry?.bytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || bytes.byteLength !== expectedBytes) {
    throw new Error(`Manifest file byte count mismatch: ${key}`);
  }
  const identity = classifyManifestFileIdentity(entry?.etag_or_hash, { objectKey: key });
  const identityHash = createHash(identity.type === "sha256" ? "sha256" : "md5")
    .update(bytes)
    .digest("hex");
  if (identityHash !== identity.value) {
    throw new Error(`Manifest file ${identity.type.toUpperCase()} mismatch: ${key}`);
  }
  return {
    identity_type: identity.type,
    sha256: identity.type === "sha256" ? identityHash : sha256Hex(bytes),
  };
}

function parentBody(payload) {
  return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
}

function addPlannedObject(objects, key, body, kind) {
  if (objects.has(key)) throw new Error(`Duplicate planned output object: ${key}`);
  objects.set(key, { key, body: Buffer.from(body), kind });
}

function addCopiedObject(objects, key, sourcePath, byteSize, sha256, kind) {
  if (objects.has(key)) throw new Error(`Duplicate planned output object: ${key}`);
  objects.set(key, {
    key,
    source_path: sourcePath,
    byte_size: byteSize,
    sha256,
    kind,
  });
}

function buildPlan(args, roots) {
  const objects = new Map();
  const dayManifests = [];
  const scopes = [];
  const missingScopes = [];
  const fileKeys = new Set();
  const sourceDays = new Set();
  const outputConnectors = new Set();
  const outputPollutants = new Set();
  let rows = 0;
  let parquetBytes = 0;

  for (const dayUtc of daysInclusive(args.fromDay, args.toDay)) {
    const connectorManifests = [];
    for (const connectorId of args.connectorIds) {
      const pollutantManifests = [];
      for (const pollutantCode of args.pollutants) {
        const manifestKey = buildHistoryV2PollutantManifestKey(
          OBSERVATIONS_PREFIX,
          dayUtc,
          connectorId,
          pollutantCode,
        );
        const manifestPath = sourceFilePath(roots.sourceRoot, manifestKey, { required: false });
        if (!manifestPath) {
          missingScopes.push({ day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode });
          continue;
        }
        const manifestBody = fs.readFileSync(manifestPath);
        const manifest = parseJson(manifestBody, manifestKey);
        validateMigrationSourceObservationPollutantManifest({
          manifest,
          body: manifestBody,
          expected: {
            domain: "observations",
            manifest_kind: "pollutant",
            day_utc: dayUtc,
            connector_id: connectorId,
            pollutant_code: pollutantCode,
            manifest_key: manifestKey,
          },
        });
        if (Number(manifest.row_count) === 0 && Number(manifest.file_count) === 0) {
          missingScopes.push({
            day_utc: dayUtc,
            connector_id: connectorId,
            pollutant_code: pollutantCode,
            reason: "empty_source_scope",
          });
          continue;
        }
        if (
          !Number.isSafeInteger(Number(manifest.row_count)) ||
          Number(manifest.row_count) <= 0 ||
          !Array.isArray(manifest.files) ||
          manifest.files.length === 0
        ) {
          throw new Error(`Retained source scope is not a non-empty canonical partition: ${manifestKey}`);
        }
        for (const entry of manifest.files) {
          const key = String(entry?.key || "");
          const expectedScopePrefix = manifestKey.replace(/manifest\.json$/, "");
          if (!key.startsWith(expectedScopePrefix) || !key.endsWith(".parquet")) {
            throw new Error(`Pollutant manifest references an out-of-scope object: ${key}`);
          }
          if (fileKeys.has(key)) throw new Error(`Parquet object is referenced more than once: ${key}`);
          const body = readRequiredFile(roots.sourceRoot, key);
          const verified = verifyLocalFileIdentity({ bytes: body, entry });
          fileKeys.add(key);
          parquetBytes += body.byteLength;
          addCopiedObject(
            objects,
            key,
            sourceFilePath(roots.sourceRoot, key),
            body.byteLength,
            verified.sha256,
            "parquet",
          );
        }
        addCopiedObject(
          objects,
          manifestKey,
          manifestPath,
          manifestBody.byteLength,
          sha256Hex(manifestBody),
          "pollutant_manifest",
        );
        pollutantManifests.push(manifest);
        rows += Number(manifest.row_count);
        sourceDays.add(dayUtc);
        outputConnectors.add(connectorId);
        outputPollutants.add(pollutantCode);
        scopes.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          pollutant_code: pollutantCode,
          row_count: Number(manifest.row_count),
          parquet_file_count: manifest.files.length,
          parquet_bytes: Number(manifest.total_bytes),
          manifest_key: manifestKey,
          manifest_hash: manifest.manifest_hash,
          manifest_sha256: sha256Hex(manifestBody),
        });
      }
      if (!pollutantManifests.length) continue;
      const connectorKey = buildHistoryV2ConnectorManifestKey(
        OBSERVATIONS_PREFIX,
        dayUtc,
        connectorId,
      );
      const connectorManifest = buildHistoryV2ConnectorManifest({
        domain: "observations",
        dayUtc,
        connectorId,
        runId: null,
        manifestKey: connectorKey,
        pollutantManifests,
        writerGitSha: null,
        backedUpAtUtc: pollutantManifests
          .map((entry) => entry.backed_up_at_utc)
          .filter(Boolean)
          .sort()
          .at(-1) || null,
      });
      validateCanonicalHistoryV2Manifest(connectorManifest, {
        history_version: "v2",
        domain: "observations",
        manifest_kind: "connector",
        day_utc: dayUtc,
        connector_id: connectorId,
        manifest_key: connectorKey,
      });
      addPlannedObject(objects, connectorKey, parentBody(connectorManifest), "connector_manifest");
      connectorManifests.push(connectorManifest);
    }
    if (!connectorManifests.length) continue;
    const dayKey = buildHistoryV2DayManifestKey(OBSERVATIONS_PREFIX, dayUtc);
    const dayManifest = buildHistoryV2DayManifest({
      domain: "observations",
      dayUtc,
      runId: null,
      manifestKey: dayKey,
      connectorManifests,
      writerGitSha: null,
      backedUpAtUtc: connectorManifests
        .map((entry) => entry.backed_up_at_utc)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    });
    validateCanonicalHistoryV2Manifest(dayManifest, {
      history_version: "v2",
      domain: "observations",
      manifest_kind: "day",
      day_utc: dayUtc,
      manifest_key: dayKey,
    });
    addPlannedObject(objects, dayKey, parentBody(dayManifest), "day_manifest");
    dayManifests.push({
      day_utc: dayUtc,
      manifest_key: dayKey,
      manifest_hash: dayManifest.manifest_hash,
    });
  }

  if (!dayManifests.length) {
    throw new Error("The requested selection contains no non-empty pollutant scopes");
  }
  const hierarchy = buildObservationsManifestHierarchy({
    observationsPrefix: OBSERVATIONS_PREFIX,
    dayManifests,
  });
  for (const entry of hierarchy.objects) {
    validateR2HistoryV2ObservationsAggregateManifest(entry.manifest, {
      basePrefix: OBSERVATIONS_PREFIX,
    });
    addPlannedObject(objects, entry.key, Buffer.from(entry.body, "utf8"), `${entry.level}_manifest`);
  }
  const rootObject = hierarchy.objects.find((entry) => entry.level === "root");
  return {
    objects,
    report: {
      schema_version: 1,
      kind: "uk_aq_reduced_v2_observations_source_report",
      ok: true,
      mode: args.writeOutput ? "write_output" : "dry_run",
      source_root: roots.sourceRoot,
      destination_root: roots.destinationRoot,
      observations_prefix: OBSERVATIONS_PREFIX,
      requested: {
        from_day: args.fromDay,
        to_day: args.toDay,
        connector_ids: args.connectorIds,
        pollutant_codes: args.pollutants,
      },
      source_days_with_retained_data: [...sourceDays].sort(),
      source_day_count: sourceDays.size,
      output_days: dayManifests.map((entry) => entry.day_utc),
      output_day_count: dayManifests.length,
      output_connector_ids: [...outputConnectors].sort((left, right) => left - right),
      output_pollutant_codes: [...outputPollutants].sort(),
      retained_pollutant_scopes: scopes,
      omitted_scopes: missingScopes,
      pollutant_scope_count: scopes.length,
      parquet_file_count: fileKeys.size,
      row_count: rows,
      parquet_bytes: parquetBytes,
      output_object_count: objects.size,
      output_total_bytes: [...objects.values()].reduce(
        (sum, object) => sum + (object.body?.byteLength ?? object.byte_size),
        0,
      ),
      resulting_root_identity: {
        key: rootObject.key,
        content_hash: hierarchy.root.content_hash,
        sha256: sha256Hex(Buffer.from(rootObject.body, "utf8")),
        byte_size: Buffer.byteLength(rootObject.body),
      },
      orphan_detection: {
        status: args.writeOutput ? "pending" : "not_run_dry_run",
        orphan_count: null,
        orphan_keys: [],
      },
    },
  };
}

function listRelativeFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...listRelativeFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Output contains a non-regular filesystem entry: ${absolute}`);
  }
  return files.sort();
}

function writePlan(plan, destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const object of plan.objects.values()) {
    const target = localPathForObject(destinationRoot, object.key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (object.source_path) {
      fs.copyFileSync(object.source_path, target, fs.constants.COPYFILE_EXCL);
    } else {
      fs.writeFileSync(target, object.body, { flag: "wx" });
    }
  }
  const actual = listRelativeFiles(destinationRoot);
  const actualSet = new Set(actual);
  const expected = [...plan.objects.keys()].sort();
  const expectedSet = new Set(expected);
  const orphanKeys = actual.filter((key) => !expectedSet.has(key));
  const missingKeys = expected.filter((key) => !actualSet.has(key));
  const mismatchedKeys = expected.filter((key) => actualSet.has(key)).filter((key) => {
    const object = plan.objects.get(key);
    const written = fs.readFileSync(localPathForObject(destinationRoot, key));
    return object.source_path
      ? written.byteLength !== object.byte_size || sha256Hex(written) !== object.sha256
      : !written.equals(object.body);
  });
  plan.report.orphan_detection = {
    status: orphanKeys.length || missingKeys.length || mismatchedKeys.length ? "failed" : "passed",
    orphan_count: orphanKeys.length,
    orphan_keys: orphanKeys,
    missing_count: missingKeys.length,
    missing_keys: missingKeys,
    byte_mismatch_count: mismatchedKeys.length,
    byte_mismatch_keys: mismatchedKeys,
  };
  if (orphanKeys.length || missingKeys.length || mismatchedKeys.length) {
    throw new Error("Written output contains orphan, missing or byte-mismatched objects");
  }
}

export function runReducedV2ObservationsSourceBuilder(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, text: usage() };
  const roots = resolveRoots(args.sourceRoot, args.destinationRoot);
  const plan = buildPlan(args, roots);
  if (args.writeOutput) writePlan(plan, roots.destinationRoot);
  return { help: false, report: plan.report };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = runReducedV2ObservationsSourceBuilder();
    process.stdout.write(result.help ? `${result.text}\n` : `${JSON.stringify(result.report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema_version: 1,
      kind: "uk_aq_reduced_v2_observations_source_error",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
