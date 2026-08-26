#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    inventoryReport: null,
    backupReport: null,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = requireValue(argv, index, flag);
    index += 1;
    if (flag === "--inventory-report") args.inventoryReport = value;
    else if (flag === "--backup-report") args.backupReport = value;
    else if (flag === "--output") args.output = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  for (const [flag, value] of [
    ["--inventory-report", args.inventoryReport],
    ["--backup-report", args.backupReport],
    ["--output", args.output],
  ]) {
    if (!value) throw new Error(`${flag} is required`);
  }
  return Object.freeze(args);
}

function validUtcTimestamp(raw, fieldName, warn) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || !raw.endsWith("Z")) {
    warn(`${fieldName} must be a UTC ISO timestamp ending in Z`);
    return null;
  }
  const epochMs = Date.parse(raw);
  if (!Number.isFinite(epochMs)) {
    warn(`${fieldName} is not a valid timestamp`);
    return null;
  }
  return { value: raw, epochMs };
}

function buildStageTiming(report, stageName, warn) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }

  const started = validUtcTimestamp(
    report.started_at,
    `${stageName}.started_at`,
    warn,
  );
  const completed = validUtcTimestamp(
    report.completed_at,
    `${stageName}.completed_at`,
    warn,
  );
  if (!started && !completed) {
    return null;
  }

  const timing = {};
  if (started) timing.started_at_utc = started.value;
  if (completed) timing.finished_at_utc = completed.value;
  if (started && completed) {
    if (completed.epochMs >= started.epochMs) {
      timing.duration_seconds = Math.round(
        completed.epochMs - started.epochMs,
      ) / 1000;
    } else {
      warn(`${stageName}.completed_at precedes ${stageName}.started_at; duration omitted`);
    }
  }
  return timing;
}

export function buildHistoryBackupTaskSummary({
  inventoryReport = null,
  backupReport = null,
  warn = () => {},
} = {}) {
  const stageTimings = {};
  const inventory = buildStageTiming(inventoryReport, "inventory", warn);
  const backup = buildStageTiming(backupReport, "backup", warn);
  if (inventory) stageTimings.inventory = inventory;
  if (backup) stageTimings.backup = backup;
  return Object.keys(stageTimings).length > 0
    ? { stage_timings: stageTimings }
    : {};
}

function readOptionalReport(filename, stageName, warn) {
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(`${stageName} report ignored: top-level JSON value must be an object`);
      return null;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`${stageName} report unavailable or malformed (${filename}): ${message}`);
    return null;
  }
}

export function main({ argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);
  const warn = (message) => process.stderr.write(`Task summary warning: ${message}\n`);
  const summary = buildHistoryBackupTaskSummary({
    inventoryReport: readOptionalReport(args.inventoryReport, "inventory", warn),
    backupReport: readOptionalReport(args.backupReport, "backup", warn),
    warn,
  });

  const output = path.resolve(args.output);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote daily task supplemental summary: ${output}\n`);
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
