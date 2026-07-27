#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  evaluateIntegrityIngestBoundary,
  readIntegrityIngestBoundaries,
  withHistoryWriterClient,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

function parseArgs(argv) {
  const args = { environment: "", source: "", fromDay: "", toDay: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--environment") args.environment = String(argv[++index] || "").trim();
    else if (arg === "--source") args.source = String(argv[++index] || "").trim().toLowerCase();
    else if (arg === "--from-day") args.fromDay = String(argv[++index] || "").trim();
    else if (arg === "--to-day") args.toDay = String(argv[++index] || "").trim();
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.environment) throw new Error("--environment is required");
  if (!args.source) throw new Error("--source is required");
  if (!args.fromDay) throw new Error("--from-day is required");
  if (!args.toDay) throw new Error("--to-day is required");
  return args;
}

export function requestedBoundarySources(source) {
  if (source === "all") return ["openaq", "sensorcommunity", "sos"];
  if (["openaq", "sensorcommunity", "sos"].includes(source)) return [source];
  throw new Error(`Unsupported Integrity boundary source: ${source}`);
}

export async function checkIntegrityIngestBoundary({ client, environment, source, fromDay, toDay }) {
  const boundaries = await readIntegrityIngestBoundaries(client, requestedBoundarySources(source));
  const evaluated = evaluateIntegrityIngestBoundary({ requestedToDayUtc: toDay, boundaries });
  return {
    environment,
    source,
    requested_start_day: fromDay,
    requested_end_day: toDay,
    blocked_reason: evaluated.allowed ? null : "integrity_range_overlaps_ingestdb_boundary",
    checked_at_utc: new Date().toISOString(),
    ...evaluated,
    blockers: evaluated.blockers.map((blocker) => ({
      ...blocker,
      requested_start_day: fromDay,
      requested_end_day: toDay,
      blocked_reason: "integrity_range_overlaps_ingestdb_boundary",
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  return await withHistoryWriterClient(
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    async (client) => await checkIntegrityIngestBoundary({ client, ...args }),
    { applicationName: "uk-aq-integrity-ingest-boundary" },
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.allowed) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
