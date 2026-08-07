#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  hasRequiredR2Config,
  r2GetObject,
  r2ListAllCommonPrefixes,
  r2ListAllObjects,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
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

const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
const DAY_MANIFEST_SUFFIX_PATTERN = /^day_utc=(\d{4}-\d{2}-\d{2})\/manifest\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs [options]",
    "",
    "Purpose:",
    "  Build and audit the R2 v2 observations month, year and root manifest",
    "  hierarchy from the existing committed day manifests.",
    "",
    "Default mode:",
    "  Dry-run report only. No R2 objects are written.",
    "",
    "Options:",
    "  --observations-prefix <prefix>  Default: configured v2 observations prefix",
    "  --max-keys <n>                  R2 list page size",
    "  --report-out <file>             Write the JSON report to a local file",
    "  --dry-run                       Explicit no-write mode (default)",
    "  --write-r2                      Write changed aggregate manifests to the configured R2 bucket",
    "  -h, --help",
  ].join("\n"));
}

function parsePositiveInt(raw, flagName) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return value;
}

function normalizePrefix(raw) {
  const prefix = String(raw || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid observations prefix: ${String(raw || "")}`);
  }
  return prefix;
}

function parseArgs(argv) {
  const args = {
    observationsPrefix: "",
    maxKeys: null,
    reportOut: "",
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--observations-prefix") {
      args.observationsPrefix = normalizePrefix(argv[++index]);
    } else if (arg === "--max-keys") {
      args.maxKeys = parsePositiveInt(argv[++index], "--max-keys");
    } else if (arg === "--report-out") {
      args.reportOut = String(argv[++index] || "").trim();
    } else if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
    } else if (arg === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  return args;
}

function parseJsonBody(result, key) {
  try {
    return JSON.parse(Buffer.from(result.body).toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dayManifestReference(payload, key, observationsPrefix) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Day manifest is not a JSON object: ${key}`);
  }
  const suffix = key.slice(`${observationsPrefix}/`.length);
  const match = suffix.match(DAY_MANIFEST_SUFFIX_PATTERN);
  if (!match) {
    throw new Error(`Unexpected observation day manifest key: ${key}`);
  }
  const dayUtc = match[1];
  if (payload.day_utc !== dayUtc) {
    throw new Error(`Day manifest day_utc mismatch for ${key}`);
  }
  if (payload.manifest_key !== key) {
    throw new Error(`Day manifest manifest_key mismatch for ${key}`);
  }
  if (payload.domain !== undefined && payload.domain !== "observations") {
    throw new Error(`Day manifest domain mismatch for ${key}`);
  }
  if (payload.manifest_kind !== undefined && payload.manifest_kind !== "day") {
    throw new Error(`Day manifest kind mismatch for ${key}`);
  }
  const manifestHash = String(payload.manifest_hash || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(manifestHash)) {
    throw new Error(`Day manifest has invalid manifest_hash: ${key}`);
  }
  return {
    day_utc: dayUtc,
    manifest_key: key,
    manifest_hash: manifestHash,
  };
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function buildObservationsManifestHierarchy({
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  dayManifests,
}) {
  const basePrefix = normalizePrefix(observationsPrefix);
  if (!Array.isArray(dayManifests) || dayManifests.length === 0) {
    throw new Error("No committed R2 v2 observation day manifests were found");
  }

  const sortedDays = [...dayManifests].sort((left, right) => left.day_utc.localeCompare(right.day_utc));
  const monthGroups = groupBy(sortedDays, (day) => day.day_utc.slice(0, 7));
  const months = [];
  for (const [yearMonth, days] of [...monthGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [year, month] = yearMonth.split("-");
    months.push(buildR2HistoryV2ObservationsMonthManifest({
      basePrefix,
      year,
      month,
      dayManifests: days,
    }));
  }

  const yearGroups = groupBy(months, (monthManifest) => String(monthManifest.year));
  const years = [];
  for (const [year, monthManifests] of [...yearGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    years.push(buildR2HistoryV2ObservationsYearManifest({
      basePrefix,
      year,
      monthManifests,
    }));
  }

  const root = buildR2HistoryV2ObservationsRootManifest({
    basePrefix,
    yearManifests: years,
  });

  const objects = [
    ...months.map((manifest) => ({
      level: "month",
      key: buildR2HistoryV2ObservationsMonthManifestKey(basePrefix, manifest.year, manifest.month),
      manifest,
    })),
    ...years.map((manifest) => ({
      level: "year",
      key: buildR2HistoryV2ObservationsYearManifestKey(basePrefix, manifest.year),
      manifest,
    })),
    {
      level: "root",
      key: buildR2HistoryV2ObservationsRootManifestKey(basePrefix),
      manifest: root,
    },
  ].map((entry) => ({
    ...entry,
    body: serializeR2HistoryV2ObservationsAggregateManifest(entry.manifest, { basePrefix }),
  }));

  return { days: sortedDays, months, years, root, objects };
}

function aggregateObjectLevel(key, observationsPrefix) {
  const suffix = key.slice(`${observationsPrefix}/`.length);
  if (suffix === "_manifests/manifest.json") return "root";
  if (/^_manifests\/year=\d{4}\/manifest\.json$/.test(suffix)) return "year";
  if (/^_manifests\/year=\d{4}\/month=\d{2}\/manifest\.json$/.test(suffix)) return "month";
  return null;
}

async function readExistingAggregateObject({ r2, key, observationsPrefix }) {
  try {
    const result = await r2GetObject({ r2, key });
    const rawBody = Buffer.from(result.body);
    let payload;
    let canonical = null;
    let validationError = null;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
      canonical = validateR2HistoryV2ObservationsAggregateManifest(payload, {
        basePrefix: observationsPrefix,
      });
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
    return {
      found: true,
      bytes: result.bytes,
      rawBody,
      payload: payload ?? null,
      canonical,
      validationError,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || "");
    if (message.includes("R2 GET failed (404)")) {
      return {
        found: false,
        bytes: 0,
        rawBody: null,
        payload: null,
        canonical: null,
        validationError: null,
      };
    }
    throw error;
  }
}

function writeReport(reportOut, payload) {
  if (!reportOut) return;
  const outputPath = path.resolve(reportOut);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function assertR2WriteTarget(r2, configuredBucket) {
  const bucket = String(r2?.bucket || "").trim();
  const expectedBucket = String(configuredBucket || "").trim();
  if (!expectedBucket) {
    throw new Error("CFLARE_R2_BUCKET is required for --write-r2");
  }
  if (bucket !== expectedBucket) {
    throw new Error(
      `Refusing --write-r2 because resolved R2 bucket ${bucket || "(empty)"} does not match CFLARE_R2_BUCKET ${expectedBucket}`,
    );
  }
}

export async function executeObservationsManifestHierarchy({
  r2,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  maxKeys = 1000,
  mode = "dry-run",
  configuredBucket = "",
}) {
  const basePrefix = normalizePrefix(observationsPrefix);
  const writeR2 = mode === "write-r2";
  if (writeR2) assertR2WriteTarget(r2, configuredBucket);

  const topLevelPrefixes = await r2ListAllCommonPrefixes({
    r2,
    prefix: `${basePrefix}/`,
    delimiter: "/",
    max_keys: maxKeys,
  });
  const dayKeys = topLevelPrefixes
    .map((prefix) => String(prefix || ""))
    .filter((prefix) => prefix.startsWith(`${basePrefix}/day_utc=`))
    .map((prefix) => {
      const suffix = prefix.slice(`${basePrefix}/`.length).replace(/\/$/, "");
      const match = suffix.match(/^day_utc=(\d{4}-\d{2}-\d{2})$/);
      if (!match) {
        throw new Error(`Malformed observations day prefix: ${prefix}`);
      }
      return `${basePrefix}/${suffix}/manifest.json`;
    })
    .sort((left, right) => left.localeCompare(right));

  const dayManifests = [];
  for (const key of dayKeys) {
    const result = await r2GetObject({ r2, key });
    dayManifests.push(dayManifestReference(parseJsonBody(result, key), key, basePrefix));
  }

  const hierarchy = buildObservationsManifestHierarchy({
    observationsPrefix: basePrefix,
    dayManifests,
  });
  const expectedByKey = new Map(hierarchy.objects.map((entry) => [entry.key, entry]));
  const aggregateKeys = (await r2ListAllObjects({
    r2,
    prefix: `${basePrefix}/_manifests/`,
    max_keys: maxKeys,
  }))
    .map((entry) => String(entry.key || ""))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  const plan = [];
  for (const expected of hierarchy.objects) {
    const existing = await readExistingAggregateObject({
      r2,
      key: expected.key,
      observationsPrefix: basePrefix,
    });
    let action;
    if (!existing.found) action = "create";
    else if (existing.validationError) action = "replace_invalid";
    else if (Buffer.compare(existing.rawBody, expected.body) === 0) action = "unchanged";
    else action = "update";
    plan.push({
      level: expected.level,
      key: expected.key,
      action,
      existing_found: existing.found,
      existing_bytes: existing.bytes,
      existing_content_hash: existing.canonical?.content_hash ?? null,
      desired_content_hash: expected.manifest.content_hash,
      validation_error: existing.validationError,
    });
  }

  const unexpected = aggregateKeys
    .filter((key) => !expectedByKey.has(key))
    .map((key) => ({
      level: aggregateObjectLevel(key, basePrefix),
      key,
      action: "unexpected_existing",
    }));

  const writeResults = [];
  if (writeR2) {
    for (const planned of plan) {
      if (planned.action === "unchanged") continue;
      const expected = expectedByKey.get(planned.key);
      const put = await r2PutObject({
        r2,
        key: expected.key,
        body: expected.body,
        content_type: "application/json; charset=utf-8",
      });
      const verification = await r2GetObject({ r2, key: expected.key });
      const verifiedBody = Buffer.from(verification.body);
      if (Buffer.compare(verifiedBody, expected.body) !== 0) {
        throw new Error(`R2 read-back verification failed for ${expected.key}`);
      }
      validateR2HistoryV2ObservationsAggregateManifest(
        JSON.parse(verifiedBody.toString("utf8")),
        { basePrefix },
      );
      writeResults.push({
        level: expected.level,
        key: expected.key,
        action: planned.action,
        bytes: verification.bytes,
        etag: put.etag ?? null,
        verified: true,
      });
    }
  }

  const counts = {
    create: plan.filter((entry) => entry.action === "create").length,
    update: plan.filter((entry) => entry.action === "update").length,
    replace_invalid: plan.filter((entry) => entry.action === "replace_invalid").length,
    unchanged: plan.filter((entry) => entry.action === "unchanged").length,
    unexpected_existing: unexpected.length,
  };
  const changeCount = counts.create + counts.update + counts.replace_invalid;

  return {
    ok: true,
    mode,
    dry_run: !writeR2,
    write_r2: writeR2,
    status: writeR2
      ? (changeCount > 0 ? "written" : "up_to_date")
      : (changeCount > 0 ? "changes_planned" : "up_to_date"),
    bucket: r2.bucket,
    observations_prefix: basePrefix,
    day_manifest_count: hierarchy.days.length,
    month_manifest_count: hierarchy.months.length,
    year_manifest_count: hierarchy.years.length,
    root_content_hash: hierarchy.root.content_hash,
    planning: {
      ...counts,
      change_count: changeCount,
      expected_object_count: plan.length,
      unexpected_objects_are_report_only: true,
    },
    objects: plan,
    unexpected_objects: unexpected,
    execution: {
      wrote_object_count: writeResults.length,
      writes: writeResults,
    },
  };
}

export async function runObservationsManifestHierarchy({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Missing required R2 configuration");
  }
  const observationsPrefix = args.observationsPrefix
    || normalizePrefix(config.observations_prefix_v2 || DEFAULT_OBSERVATIONS_PREFIX);
  const report = await executeObservationsManifestHierarchy({
    r2: config.r2,
    observationsPrefix,
    maxKeys: args.maxKeys || config.max_keys || 1000,
    mode: args.mode,
    configuredBucket: env.CFLARE_R2_BUCKET,
  });
  writeReport(args.reportOut, report);
  return report;
}

async function run() {
  const report = await runObservationsManifestHierarchy();
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
