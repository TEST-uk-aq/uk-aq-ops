#!/usr/bin/env node

import process from "node:process";
import { Client } from "pg";

const SCRIPT_NAME = "uk_aq_restore_missing_ingest_observations_from_obsaqidb";

const KNOWN_LIVE_PRUNE_MISMATCHES = Object.freeze([
  { connectorId: 3, dayUtc: "2026-07-26" },
  { connectorId: 3, dayUtc: "2026-07-27" },
  { connectorId: 3, dayUtc: "2026-07-28" },
  { connectorId: 3, dayUtc: "2026-07-29" },
]);

const DEFAULT_MAX_MISSING = 100;
const DEFAULT_INSERT_BATCH_SIZE = 100;
const RESTORED_INGEST_STATUS = "P";

function usage() {
  console.log(`
Restore observations that exist in ObsAQIDB but are missing from IngestDB.

The script is dry-run only unless --apply is supplied.

Usage:
  node ${SCRIPT_NAME}.mjs \\
    --known-live-prune-mismatches

  node ${SCRIPT_NAME}.mjs \\
    --known-live-prune-mismatches \\
    --apply

  node ${SCRIPT_NAME}.mjs \\
    --connector-id 3 \\
    --from-day 2026-07-26 \\
    --to-day 2026-07-29

  node ${SCRIPT_NAME}.mjs \\
    --connector-id 3 \\
    --day 2026-07-26 \\
    --day 2026-07-27 \\
    --apply

Options:
  --known-live-prune-mismatches
      Use the known LIVE connector/day targets:
        connector 3: 2026-07-26 through 2026-07-29

  --connector-id ID
      Connector ID. May be supplied more than once.

  --day YYYY-MM-DD
      UTC day. May be supplied more than once.

  --from-day YYYY-MM-DD
  --to-day YYYY-MM-DD
      Inclusive UTC date range. Must be used together.

  --apply
      Insert missing rows into IngestDB. Without this flag, no writes occur.

  --max-missing N
      Abort if more than N missing rows are found across all targets.
      Default: ${DEFAULT_MAX_MISSING}

  --batch-size N
      Maximum rows per INSERT statement.
      Default: ${DEFAULT_INSERT_BATCH_SIZE}

  --help
      Show this help.

Required database environment variables:

  IngestDB, first non-empty value:
    UK_AQ_INGEST_DB_URL
    UK_AQ_INGEST_DATABASE_URL
    INGESTDB_DATABASE_URL
    SUPABASE_DB_URL

  ObsAQIDB, first non-empty value:
    UK_AQ_OBSAQIDB_DB_URL
    UK_AQ_OBSAQIDB_DATABASE_URL
    OBS_AQIDB_DATABASE_URL
    OBS_AQI_DB_URL

Safety behaviour:
  - Exact key is (connector_id, timeseries_id, observed_at).
  - ObsAQIDB is read using connector_id, timeseries_id, observed_at and value.
  - Existing IngestDB rows are never updated.
  - Conflicting values for an existing key abort the run.
  - Newly restored IngestDB rows use status "P".
  - Missing IngestDB timeseries metadata aborts the affected target.
  - PostgreSQL float8 text is preserved for exact round-trip insertion.
  - Non-finite values abort the run.
  - Each connector/day is applied in its own transaction.
`);
}

function parsePositiveInteger(raw, name, { min = 1, max = 1_000_000 } = {}) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}: ${raw}`);
  }
  return value;
}

function validateIsoDay(raw, name = "day") {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD: ${raw}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid calendar date: ${raw}`);
  }
  return value;
}

function daysInclusive(fromDay, toDay) {
  const start = new Date(`${validateIsoDay(fromDay, "--from-day")}T00:00:00.000Z`);
  const end = new Date(`${validateIsoDay(toDay, "--to-day")}T00:00:00.000Z`);
  if (end < start) {
    throw new Error("--to-day must not be earlier than --from-day");
  }

  const days = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    useKnownTargets: false,
    connectorIds: [],
    explicitDays: [],
    fromDay: "",
    toDay: "",
    maxMissing: DEFAULT_MAX_MISSING,
    batchSize: DEFAULT_INSERT_BATCH_SIZE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--known-live-prune-mismatches") {
      args.useKnownTargets = true;
    } else if (arg === "--connector-id") {
      args.connectorIds.push(parsePositiveInteger(argv[++index], "--connector-id"));
    } else if (arg === "--day") {
      args.explicitDays.push(validateIsoDay(argv[++index], "--day"));
    } else if (arg === "--from-day") {
      args.fromDay = validateIsoDay(argv[++index], "--from-day");
    } else if (arg === "--to-day") {
      args.toDay = validateIsoDay(argv[++index], "--to-day");
    } else if (arg === "--max-missing") {
      args.maxMissing = parsePositiveInteger(argv[++index], "--max-missing", { max: 10_000 });
    } else if (arg === "--batch-size") {
      args.batchSize = parsePositiveInteger(argv[++index], "--batch-size", { max: 1_000 });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (Boolean(args.fromDay) !== Boolean(args.toDay)) {
    throw new Error("--from-day and --to-day must be supplied together");
  }

  const targets = [];

  if (args.useKnownTargets) {
    targets.push(...KNOWN_LIVE_PRUNE_MISMATCHES);
  }

  const requestedDays = [
    ...args.explicitDays,
    ...(args.fromDay ? daysInclusive(args.fromDay, args.toDay) : []),
  ];

  if (args.connectorIds.length > 0 || requestedDays.length > 0) {
    if (args.connectorIds.length === 0) {
      throw new Error("At least one --connector-id is required with explicit days");
    }
    if (requestedDays.length === 0) {
      throw new Error("At least one --day or a --from-day/--to-day range is required");
    }

    for (const connectorId of args.connectorIds) {
      for (const dayUtc of requestedDays) {
        targets.push({ connectorId, dayUtc });
      }
    }
  }

  const uniqueTargets = new Map();
  for (const target of targets) {
    uniqueTargets.set(`${target.connectorId}:${target.dayUtc}`, target);
  }

  args.targets = [...uniqueTargets.values()].sort(
    (left, right) => left.dayUtc.localeCompare(right.dayUtc) || left.connectorId - right.connectorId,
  );

  if (args.targets.length === 0) {
    throw new Error(
      "No targets supplied. Use --known-live-prune-mismatches or explicit connector/day arguments.",
    );
  }

  return args;
}

function resolveEnvironmentValue(names, label) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return { name, value };
    }
  }
  throw new Error(`${label} is missing. Set one of: ${names.join(", ")}`);
}

function sanitisedDatabaseIdentity(connectionString) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || "5432",
      database: url.pathname.replace(/^\/+/, "") || "(unspecified)",
      user: decodeURIComponent(url.username || "(unspecified)"),
    };
  } catch {
    return {
      host: "(unparseable connection string)",
      port: "",
      database: "",
      user: "",
    };
  }
}

function dayBounds(dayUtc) {
  const start = `${dayUtc}T00:00:00.000Z`;
  const endDate = new Date(start);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  return { start, end: endDate.toISOString() };
}

function keyForRow(row) {
  return `${row.timeseries_id}|${new Date(row.observed_at).toISOString()}`;
}

function normaliseStatus(value) {
  return value === null || value === undefined ? null : String(value);
}

function normaliseSourceRow(row) {
  const valueText = row.value_text === null || row.value_text === undefined
    ? null
    : String(row.value_text);
  if (
    valueText !== null
    && ["nan", "infinity", "-infinity"].includes(valueText.toLowerCase())
  ) {
    throw new Error(
      `Non-finite value for connector=${row.connector_id} timeseries=${row.timeseries_id} `
      + `observed_at=${new Date(row.observed_at).toISOString()}: ${valueText}`,
    );
  }

  return {
    connector_id: Number(row.connector_id),
    timeseries_id: String(row.timeseries_id),
    observed_at: new Date(row.observed_at).toISOString(),
    value_text: valueText,
    value_float8_hex: row.value_float8_hex === null ? null : String(row.value_float8_hex),
    status: normaliseStatus(row.status),
  };
}

function rowMaps(rows, label) {
  const map = new Map();
  for (const rawRow of rows) {
    const row = normaliseSourceRow(rawRow);
    const key = keyForRow(row);
    const previous = map.get(key);
    if (previous) {
      if (previous.value_float8_hex !== row.value_float8_hex) {
        throw new Error(`${label} contains conflicting duplicate observation key: ${key}`);
      }
      continue;
    }
    map.set(key, row);
  }
  return map;
}

function compareRows(obsRows, ingestRows) {
  const obsMap = rowMaps(obsRows, "ObsAQIDB");
  const ingestMap = rowMaps(ingestRows, "IngestDB");
  const missing = [];
  const conflicts = [];

  for (const [key, obsRow] of obsMap.entries()) {
    const ingestRow = ingestMap.get(key);
    if (!ingestRow) {
      missing.push({
        ...obsRow,
        status: RESTORED_INGEST_STATUS,
      });
      continue;
    }

    if (ingestRow.value_float8_hex !== obsRow.value_float8_hex) {
      conflicts.push({
        key,
        obs: obsRow,
        ingest: ingestRow,
      });
    }
  }

  missing.sort(
    (left, right) =>
      left.observed_at.localeCompare(right.observed_at)
      || Number(left.timeseries_id) - Number(right.timeseries_id),
  );

  return {
    obsCount: obsMap.size,
    ingestCount: ingestMap.size,
    missing,
    conflicts,
  };
}

async function fetchObservationRows(
  client,
  tableName,
  connectorId,
  dayUtc,
  { hasStatus },
) {
  const { start, end } = dayBounds(dayUtc);
  const statusProjection = hasStatus
    ? "o.status::text as status"
    : "null::text as status";

  const sql = `
    select
      o.connector_id::integer as connector_id,
      o.timeseries_id::bigint::text as timeseries_id,
      o.observed_at,
      o.value::double precision::text as value_text,
      case
        when o.value is null then null
        else encode(float8send(o.value::double precision), 'hex')
      end as value_float8_hex,
      ${statusProjection}
    from ${tableName} o
    where o.connector_id = $1
      and o.observed_at >= $2::timestamptz
      and o.observed_at < $3::timestamptz
    order by o.observed_at, o.timeseries_id
  `;
  const result = await client.query(sql, [connectorId, start, end]);
  return result.rows;
}

async function verifyTimeseriesMetadata(ingestClient, connectorId, missingRows) {
  const ids = [...new Set(missingRows.map((row) => row.timeseries_id))];
  if (ids.length === 0) {
    return;
  }

  const result = await ingestClient.query(
    `
      select ts.id::bigint::text as timeseries_id
      from uk_aq_core.timeseries ts
      where ts.connector_id = $1
        and ts.id = any($2::bigint[])
    `,
    [connectorId, ids],
  );

  const found = new Set(result.rows.map((row) => String(row.timeseries_id)));
  const absent = ids.filter((id) => !found.has(id));
  if (absent.length > 0) {
    throw new Error(
      `IngestDB is missing timeseries metadata for connector ${connectorId}: ${absent.join(", ")}`,
    );
  }
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function insertMissingRows(ingestClient, rows, batchSize) {
  let insertedCount = 0;

  for (const batch of chunks(rows, batchSize)) {
    const parameters = [];
    const tuples = [];

    for (const row of batch) {
      const base = parameters.length;
      parameters.push(
        row.connector_id,
        row.timeseries_id,
        row.observed_at,
        row.value_text,
        RESTORED_INGEST_STATUS,
      );
      tuples.push(
        `($${base + 1}::integer, $${base + 2}::bigint, $${base + 3}::timestamptz, `
        + `$${base + 4}::double precision, $${base + 5}::text)`,
      );
    }

    const result = await ingestClient.query(
      `
        insert into uk_aq_core.observations (
          connector_id,
          timeseries_id,
          observed_at,
          value,
          status
        )
        values ${tuples.join(",\n")}
        on conflict do nothing
        returning timeseries_id, observed_at
      `,
      parameters,
    );

    insertedCount += result.rowCount;
  }

  return insertedCount;
}

function printMissingRows(rows, limit = 25) {
  for (const row of rows.slice(0, limit)) {
    console.log(
      `  missing: connector=${row.connector_id}`
      + ` timeseries=${row.timeseries_id}`
      + ` observed_at=${row.observed_at}`
      + ` value=${row.value_text === null ? "NULL" : row.value_text}`
      + ` status=${row.status === null ? "NULL" : row.status}`,
    );
  }
  if (rows.length > limit) {
    console.log(`  ... ${rows.length - limit} more missing rows`);
  }
}

function printConflicts(conflicts, limit = 10) {
  for (const conflict of conflicts.slice(0, limit)) {
    console.error(`  conflict: ${conflict.key}`);
    console.error(
      `    ObsAQIDB value=${conflict.obs.value_text}`
      + ` value_hex=${conflict.obs.value_float8_hex}`,
    );
    console.error(
      `    IngestDB value=${conflict.ingest.value_text}`
      + ` value_hex=${conflict.ingest.value_float8_hex}`
      + ` status=${conflict.ingest.status}`,
    );
  }
  if (conflicts.length > limit) {
    console.error(`  ... ${conflicts.length - limit} more conflicts`);
  }
}

async function inspectTarget(obsClient, ingestClient, target) {
  const [obsRows, ingestRows] = await Promise.all([
    fetchObservationRows(
      obsClient,
      "uk_aq_observs.observations",
      target.connectorId,
      target.dayUtc,
      { hasStatus: false },
    ),
    fetchObservationRows(
      ingestClient,
      "uk_aq_core.observations",
      target.connectorId,
      target.dayUtc,
      { hasStatus: true },
    ),
  ]);

  return compareRows(obsRows, ingestRows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const ingestDb = resolveEnvironmentValue(
    [
      "UK_AQ_INGEST_DB_URL",
      "UK_AQ_INGEST_DATABASE_URL",
      "INGESTDB_DATABASE_URL",
      "SUPABASE_DB_URL",
    ],
    "IngestDB database URL",
  );
  const obsDb = resolveEnvironmentValue(
    [
      "UK_AQ_OBSAQIDB_DB_URL",
      "UK_AQ_OBSAQIDB_DATABASE_URL",
      "OBS_AQIDB_SUPABASE_DB_URL",
      "OBS_AQIDB_DATABASE_URL",
      "OBS_AQI_DB_URL",
    ],
    "ObsAQIDB database URL",
  );

  if (ingestDb.value === obsDb.value) {
    throw new Error("IngestDB and ObsAQIDB connection strings are identical");
  }

  const ingestIdentity = sanitisedDatabaseIdentity(ingestDb.value);
  const obsIdentity = sanitisedDatabaseIdentity(obsDb.value);

  console.log(`Mode: ${args.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`IngestDB env: ${ingestDb.name}`);
  console.log(
    `IngestDB: ${ingestIdentity.user}@${ingestIdentity.host}:${ingestIdentity.port}/`
    + `${ingestIdentity.database}`,
  );
  console.log(`ObsAQIDB env: ${obsDb.name}`);
  console.log(
    `ObsAQIDB: ${obsIdentity.user}@${obsIdentity.host}:${obsIdentity.port}/`
    + `${obsIdentity.database}`,
  );
  console.log(`Maximum permitted missing rows: ${args.maxMissing}`);
  console.log("Targets:");
  for (const target of args.targets) {
    console.log(`  connector=${target.connectorId} day=${target.dayUtc}`);
  }

  const ingestClient = new Client({
    connectionString: ingestDb.value,
    application_name: SCRIPT_NAME,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  });
  const obsClient = new Client({
    connectionString: obsDb.value,
    application_name: SCRIPT_NAME,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  });

  await Promise.all([ingestClient.connect(), obsClient.connect()]);
  await Promise.all([
    ingestClient.query("set extra_float_digits = 3"),
    obsClient.query("set extra_float_digits = 3"),
  ]);

  try {
    const preflight = [];
    let totalMissing = 0;
    let totalConflicts = 0;

    console.log("\nPreflight comparison:");

    for (const target of args.targets) {
      const comparison = await inspectTarget(obsClient, ingestClient, target);
      totalMissing += comparison.missing.length;
      totalConflicts += comparison.conflicts.length;
      preflight.push({ target, comparison });

      console.log(
        `connector=${target.connectorId} day=${target.dayUtc}`
        + ` ObsAQIDB=${comparison.obsCount}`
        + ` IngestDB=${comparison.ingestCount}`
        + ` missing=${comparison.missing.length}`
        + ` conflicts=${comparison.conflicts.length}`,
      );
      printMissingRows(comparison.missing);
      printConflicts(comparison.conflicts);
    }

    console.log(
      `\nPreflight totals: missing=${totalMissing} conflicts=${totalConflicts}`,
    );

    if (totalConflicts > 0) {
      throw new Error(
        "Existing IngestDB rows differ from ObsAQIDB. No rows were inserted.",
      );
    }

    if (totalMissing > args.maxMissing) {
      throw new Error(
        `Missing row count ${totalMissing} exceeds --max-missing ${args.maxMissing}`,
      );
    }

    if (!args.apply) {
      console.log("\nDry run complete. No rows were inserted.");
      console.log("Repeat the same command with --apply to insert only the missing rows.");
      return;
    }

    if (totalMissing === 0) {
      console.log("\nNothing to insert.");
      return;
    }

    let totalInserted = 0;

    console.log("\nApplying connector/day repairs:");

    for (const { target } of preflight) {
      await ingestClient.query("begin");
      try {
        await ingestClient.query("set local lock_timeout = '10s'");
        await ingestClient.query("set local statement_timeout = '120s'");

        const comparison = await inspectTarget(obsClient, ingestClient, target);

        if (comparison.conflicts.length > 0) {
          printConflicts(comparison.conflicts);
          throw new Error(
            `Conflicts appeared during apply for connector=${target.connectorId} `
            + `day=${target.dayUtc}`,
          );
        }

        if (totalInserted + comparison.missing.length > args.maxMissing) {
          throw new Error(
            `Apply would exceed --max-missing ${args.maxMissing}`,
          );
        }

        await verifyTimeseriesMetadata(
          ingestClient,
          target.connectorId,
          comparison.missing,
        );

        const inserted = await insertMissingRows(
          ingestClient,
          comparison.missing,
          args.batchSize,
        );

        const verification = await inspectTarget(obsClient, ingestClient, target);
        if (verification.conflicts.length > 0 || verification.missing.length > 0) {
          printConflicts(verification.conflicts);
          printMissingRows(verification.missing);
          throw new Error(
            `Post-insert verification failed for connector=${target.connectorId} `
            + `day=${target.dayUtc}: missing=${verification.missing.length} `
            + `conflicts=${verification.conflicts.length}`,
          );
        }

        await ingestClient.query("commit");
        totalInserted += inserted;

        console.log(
          `connector=${target.connectorId} day=${target.dayUtc}`
          + ` inserted=${inserted} verified_missing=0 verified_conflicts=0`,
        );
      } catch (error) {
        await ingestClient.query("rollback");
        throw error;
      }
    }

    console.log(`\nApply complete. Inserted ${totalInserted} rows.`);
  } finally {
    await Promise.allSettled([ingestClient.end(), obsClient.end()]);
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
