#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  evaluateIntegrityIngestBoundary,
  readIntegrityIngestBoundaries,
  withHistoryWriterClient,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

const OFFICIAL_CONNECTOR_IDS = Object.freeze({ waqn: 9, saqn: 10 });

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

export function requestedOfficialBoundarySources(source) {
  if (source === "all") return ["waqn", "saqn"];
  if (Object.hasOwn(OFFICIAL_CONNECTOR_IDS, source)) return [source];
  throw new Error(`Unsupported official-network Integrity boundary source: ${source}`);
}

export async function readOfficialNetworkIngestBoundaries(client, requestedSources) {
  const sources = [...new Set(requestedSources.map((value) =>
    String(value || "").trim().toLowerCase()
  ))].sort();
  if (!sources.length || sources.some((source) => !Object.hasOwn(OFFICIAL_CONNECTOR_IDS, source))) {
    throw new Error(`Invalid official-network Integrity source scope: ${sources.join(",") || "(empty)"}`);
  }
  const result = await client.query(
    `
select
  c.id::integer as connector_id,
  lower(btrim(c.connector_code)) as connector_code,
  min((o.observed_at at time zone 'UTC')::date)::text as earliest_ingest_day_utc
from uk_aq_core.connectors c
left join uk_aq_core.observations o on o.connector_id = c.id
where lower(btrim(c.connector_code)) = any($1::text[])
group by c.id, lower(btrim(c.connector_code))
order by lower(btrim(c.connector_code)), c.id
`,
    [sources],
  );
  const rows = result.rows || [];
  for (const source of sources) {
    const matches = rows.filter((row) => row.connector_code === source);
    const expectedConnectorId = OFFICIAL_CONNECTOR_IDS[source];
    if (
      matches.length !== 1 ||
      Number(matches[0]?.connector_id) !== expectedConnectorId
    ) {
      throw new Error(
        `Official-network Integrity boundary requires ${source} connector_id=${expectedConnectorId}; ` +
        `found ${matches.map((row) => row.connector_id).join(",") || "none"}`,
      );
    }
  }
  return rows.map((row) => ({
    source: row.connector_code,
    connector_id: Number(row.connector_id),
    earliest_ingest_day_utc: row.earliest_ingest_day_utc || null,
  }));
}

export async function checkOfficialNetworkIntegrityIngestBoundary({
  client,
  environment,
  source,
  fromDay,
  toDay,
}) {
  const officialBoundaries = await readOfficialNetworkIngestBoundaries(
    client,
    requestedOfficialBoundarySources(source),
  );
  const genericBoundaries = source === "all"
    ? await readIntegrityIngestBoundaries(
      client,
      ["openaq", "sensorcommunity", "sos"],
    )
    : [];
  const evaluated = evaluateIntegrityIngestBoundary({
    requestedToDayUtc: toDay,
    boundaries: [...genericBoundaries, ...officialBoundaries],
  });
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
    async (client) => await checkOfficialNetworkIntegrityIngestBoundary({
      client,
      ...args,
    }),
    { applicationName: "uk_aq_official_network_integrity_ingest_boundary" },
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
