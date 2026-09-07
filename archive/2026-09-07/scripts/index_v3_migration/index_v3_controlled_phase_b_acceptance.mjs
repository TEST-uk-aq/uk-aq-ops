#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

import {
  dayWindowFromNow,
  resolvePhaseBRuntimeConfig,
  runPhaseBBackup,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  OBSERVATION_PROPERTY_CODE_SQL_PATTERN,
} from "../../workers/shared/uk_aq_observation_property_code.mjs";
import {
  comparePruneConnectorSourceIdentities,
  computePruneConnectorSourceIdentity,
  normalizePruneConnectorSourceIdentity,
} from "../../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import {
  observationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  r2GetObject,
} from "../../workers/shared/r2_sigv4.mjs";

const ACCEPTED_SNAPSHOT_MAX_ROWS = 250_000;
const ACCEPTED_SNAPSHOT_MAX_BYTES = 268_435_456;
const CONTROLLED_MAX_CANDIDATES = 1;
const CONTROLLED_STAGING_RETENTION_DAYS = 365_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  const error = new Error(message);
  error.code = "UK_AQ_INDEX_V3_CONTROLLED_PHASE_B_ACCEPTANCE_FAILED";
  throw error;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

export function parseControlledPhaseBAcceptanceArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: null,
    environment: null,
    expectedBucket: null,
    expectedGitSha: null,
    expectedDay: null,
    expectedConnector: null,
    expectedRowCount: null,
    expectedSourceContentHash: null,
    expectedSourceContractVersion: null,
    reportOut: null,
    runId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      if (options.mode) fail("Choose exactly one of --dry-run or --apply");
      options.mode = "dry-run";
    } else if (flag === "--apply") {
      if (options.mode) fail("Choose exactly one of --dry-run or --apply");
      options.mode = "apply";
    } else if (flag === "--environment") {
      options.environment = requiredValue(argv, index, flag).toUpperCase();
      index += 1;
    } else if (flag === "--expected-bucket") {
      options.expectedBucket = requiredValue(argv, index, flag);
      index += 1;
    } else if (flag === "--expected-git-sha") {
      options.expectedGitSha = requiredValue(argv, index, flag).toLowerCase();
      index += 1;
    } else if (flag === "--expected-day") {
      options.expectedDay = requiredValue(argv, index, flag);
      index += 1;
    } else if (flag === "--expected-connector") {
      options.expectedConnector = parsePositiveInteger(requiredValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--expected-row-count") {
      options.expectedRowCount = parsePositiveInteger(requiredValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--expected-source-content-hash") {
      options.expectedSourceContentHash = requiredValue(argv, index, flag).toLowerCase();
      index += 1;
    } else if (flag === "--expected-source-contract-version") {
      options.expectedSourceContractVersion = parsePositiveInteger(requiredValue(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--report-out") {
      options.reportOut = requiredValue(argv, index, flag);
      index += 1;
    } else if (flag === "--run-id") {
      options.runId = requiredValue(argv, index, flag);
      index += 1;
    } else {
      fail(`Unknown argument: ${flag}`);
    }
  }

  if (!options.mode) fail("Choose exactly one of --dry-run or --apply");
  if (!["TEST", "LIVE"].includes(options.environment)) {
    fail("--environment must be TEST or LIVE");
  }
  if (!options.expectedBucket) fail("--expected-bucket is required");
  if (!GIT_SHA_PATTERN.test(String(options.expectedGitSha || ""))) {
    fail("--expected-git-sha must be a full lower-case 40-character Git SHA");
  }
  if (options.expectedDay && !DAY_PATTERN.test(options.expectedDay)) {
    fail("--expected-day must be YYYY-MM-DD");
  }
  if (options.expectedSourceContentHash && !SHA256_PATTERN.test(options.expectedSourceContentHash)) {
    fail("--expected-source-content-hash must be a lower-case SHA-256 hex value");
  }

  if (options.mode === "dry-run") {
    if (options.reportOut) {
      fail("--report-out is not allowed with --dry-run; strict dry-run does not write a local evidence file");
    }
  } else {
    const requiredApply = [
      [options.expectedDay, "--expected-day"],
      [options.expectedConnector, "--expected-connector"],
      [options.expectedRowCount, "--expected-row-count"],
      [options.expectedSourceContentHash, "--expected-source-content-hash"],
      [options.expectedSourceContractVersion, "--expected-source-contract-version"],
      [options.reportOut, "--report-out"],
      [options.runId, "--run-id"],
    ];
    for (const [value, flag] of requiredApply) {
      if (!value) fail(`${flag} is required with --apply`);
    }
  }

  return Object.freeze(options);
}

function asIso(value) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function asBigInt(value, fieldName) {
  try {
    return BigInt(String(value));
  } catch {
    fail(`Invalid bigint for ${fieldName}: ${String(value)}`);
  }
}

function normalizeAggregateRow(row) {
  return {
    day_utc: String(row.day_utc || "").slice(0, 10),
    connector_id: Number(row.connector_id),
    source_row_count: asBigInt(row.source_row_count, "source_row_count"),
    source_min_observed_at: asIso(row.source_min_observed_at),
    source_max_observed_at: asIso(row.source_max_observed_at),
    candidate_present: row.candidate_present === true,
    candidate_status: row.candidate_status ? String(row.candidate_status) : null,
    candidate_expected_row_count: row.candidate_expected_row_count === null || row.candidate_expected_row_count === undefined
      ? null
      : asBigInt(row.candidate_expected_row_count, "candidate_expected_row_count"),
    candidate_min_observed_at: asIso(row.candidate_min_observed_at),
    candidate_max_observed_at: asIso(row.candidate_max_observed_at),
    source_content_hash: row.source_content_hash ? String(row.source_content_hash) : null,
    source_content_hash_contract_version: row.source_content_hash_contract_version === null || row.source_content_hash_contract_version === undefined
      ? null
      : Number(row.source_content_hash_contract_version),
    source_content_hash_row_count: row.source_content_hash_row_count === null || row.source_content_hash_row_count === undefined
      ? null
      : Number(row.source_content_hash_row_count),
  };
}

function scalarSourceIdentityMatches(row) {
  return row.candidate_present
    && row.candidate_status === "complete"
    && row.candidate_expected_row_count === row.source_row_count
    && row.candidate_min_observed_at === row.source_min_observed_at
    && row.candidate_max_observed_at === row.source_max_observed_at;
}

async function readCanonicalConnectorDayRows(client, dayUtc, connectorId) {
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  const result = await client.query(
    `
select
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value,
  status
from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  null::integer,
  null::timestamptz
)
`,
    [connectorId, dayStart, dayEnd],
  );
  return result.rows;
}

function summarizeSourceRows(rows) {
  const sourceIdentity = computePruneConnectorSourceIdentity(rows);
  const pollutantCounts = {};
  for (const row of rows) {
    const pollutant = String(row.pollutant_code || "").trim().toLowerCase();
    if (!pollutant) continue;
    pollutantCounts[pollutant] = (pollutantCounts[pollutant] || 0) + 1;
  }
  const sortedCounts = Object.fromEntries(
    Object.entries(pollutantCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    source_identity: sourceIdentity,
    pollutant_counts: sortedCounts,
    pollutant_codes: Object.keys(sortedCounts),
  };
}

async function loadSourceSummary(client, aggregate) {
  const rows = await readCanonicalConnectorDayRows(
    client,
    aggregate.day_utc,
    aggregate.connector_id,
  );
  if (BigInt(rows.length) !== aggregate.source_row_count) {
    fail(
      `Read-only source identity row count differs from aggregate for ${aggregate.day_utc}/${aggregate.connector_id}: aggregate=${aggregate.source_row_count} identity_rows=${rows.length}`,
    );
  }
  return summarizeSourceRows(rows);
}

async function sourceAggregateRows(client, latestEligibleWindowEndUtc) {
  const invalidCodes = await client.query(
    `
select distinct op.code
from uk_aq_core.observations o
join uk_aq_core.timeseries ts
  on ts.id = o.timeseries_id
 and ts.connector_id = o.connector_id
join uk_aq_core.phenomena p on p.id = ts.phenomenon_id
join uk_aq_core.observed_properties op on op.id = p.observed_property_id
where o.observed_at < $1::timestamptz
  and (op.code is null or btrim(op.code) = '' or op.code !~ '${OBSERVATION_PROPERTY_CODE_SQL_PATTERN}')
order by op.code nulls first
limit 25
`,
    [latestEligibleWindowEndUtc],
  );
  if (invalidCodes.rows.length > 0) {
    fail(
      `Invalid observed_properties.code values for v2 history: ${invalidCodes.rows.map((row) => String(row.code)).join(", ")}`,
    );
  }

  const result = await client.query(
    `
with source_aggregates as (
  select
    (o.observed_at at time zone 'UTC')::date as day_utc,
    o.connector_id::integer as connector_id,
    count(*)::bigint as source_row_count,
    min(o.observed_at) as source_min_observed_at,
    max(o.observed_at) as source_max_observed_at
  from uk_aq_core.observations o
  join uk_aq_core.timeseries ts
    on ts.id = o.timeseries_id
   and ts.connector_id = o.connector_id
  join uk_aq_core.phenomena p on p.id = ts.phenomenon_id
  join uk_aq_core.observed_properties op on op.id = p.observed_property_id
  where o.observed_at < $1::timestamptz
    and op.code ~ '${OBSERVATION_PROPERTY_CODE_SQL_PATTERN}'
  group by 1, 2
)
select
  sa.day_utc::text,
  sa.connector_id,
  sa.source_row_count::text,
  sa.source_min_observed_at,
  sa.source_max_observed_at,
  (hc.day_utc is not null) as candidate_present,
  hc.status as candidate_status,
  hc.expected_row_count::text as candidate_expected_row_count,
  hc.min_observed_at as candidate_min_observed_at,
  hc.max_observed_at as candidate_max_observed_at,
  hc.source_content_hash,
  hc.source_content_hash_contract_version,
  hc.source_content_hash_row_count::text
from source_aggregates sa
left join uk_aq_ops.history_candidates hc
  on hc.day_utc = sa.day_utc
 and hc.connector_id = sa.connector_id
order by sa.day_utc, sa.connector_id
`,
    [latestEligibleWindowEndUtc],
  );
  return result.rows.map(normalizeAggregateRow);
}

export async function discoverNextControlledPhaseBCandidateReadOnly({
  phaseB,
  ingestRetentionDays,
  nowUtc = new Date().toISOString(),
  createClient = (config) => new Client(config),
} = {}) {
  const window = dayWindowFromNow(nowUtc, ingestRetentionDays);
  const client = createClient({
    connectionString: phaseB.supabase_db_url,
    application_name: "uk-aq-index-v3-controlled-phase-b-dry-run",
  });
  await client.connect();
  try {
    const aggregates = await sourceAggregateRows(
      client,
      window.latest_eligible_window_end_utc,
    );
    for (const aggregate of aggregates) {
      let selectionReason = null;
      if (!aggregate.candidate_present) {
        selectionReason = "new_candidate";
      } else if (aggregate.candidate_status !== "complete") {
        selectionReason = `existing_${aggregate.candidate_status || "unknown"}_candidate`;
      } else if (!scalarSourceIdentityMatches(aggregate)) {
        selectionReason = "complete_candidate_scalar_source_changed";
      } else {
        const currentSummary = await loadSourceSummary(client, aggregate);
        let sourceIdentityMatches = false;
        try {
          const persisted = normalizePruneConnectorSourceIdentity(aggregate);
          sourceIdentityMatches = comparePruneConnectorSourceIdentities(
            persisted,
            currentSummary.source_identity,
          ).match;
        } catch (_error) {
          sourceIdentityMatches = false;
        }
        if (sourceIdentityMatches) continue;
        selectionReason = "complete_candidate_content_source_changed";
        return {
          window,
          selection_reason: selectionReason,
          candidate: {
            day_utc: aggregate.day_utc,
            connector_id: aggregate.connector_id,
            source_row_count: aggregate.source_row_count.toString(),
            min_observed_at: aggregate.source_min_observed_at,
            max_observed_at: aggregate.source_max_observed_at,
            ...currentSummary,
          },
        };
      }

      const currentSummary = await loadSourceSummary(client, aggregate);
      return {
        window,
        selection_reason: selectionReason,
        candidate: {
          day_utc: aggregate.day_utc,
          connector_id: aggregate.connector_id,
          source_row_count: aggregate.source_row_count.toString(),
          min_observed_at: aggregate.source_min_observed_at,
          max_observed_at: aggregate.source_max_observed_at,
          ...currentSummary,
        },
      };
    }
    return {
      window,
      selection_reason: "no_pending_candidate",
      candidate: null,
    };
  } finally {
    await client.end();
  }
}

function expectedCandidateFromOptions(options) {
  if (!options.expectedDay) return null;
  return {
    day_utc: options.expectedDay,
    connector_id: options.expectedConnector,
    source_row_count: String(options.expectedRowCount),
    source_identity: {
      source_content_hash: options.expectedSourceContentHash,
      source_content_hash_contract_version: options.expectedSourceContractVersion,
      source_content_hash_row_count: options.expectedRowCount,
    },
  };
}

export function assertControlledPlanMatchesExpected(plan, expected) {
  if (!expected) return;
  if (!plan?.candidate) fail("No controlled Phase B candidate exists but an expected candidate was supplied");
  const actual = plan.candidate;
  const comparisons = [
    [actual.day_utc, expected.day_utc, "day_utc"],
    [Number(actual.connector_id), Number(expected.connector_id), "connector_id"],
    [String(actual.source_row_count), String(expected.source_row_count), "source_row_count"],
    [actual.source_identity?.source_content_hash, expected.source_identity?.source_content_hash, "source_content_hash"],
    [Number(actual.source_identity?.source_content_hash_contract_version), Number(expected.source_identity?.source_content_hash_contract_version), "source_content_hash_contract_version"],
    [Number(actual.source_identity?.source_content_hash_row_count), Number(expected.source_identity?.source_content_hash_row_count), "source_content_hash_row_count"],
  ];
  for (const [actualValue, expectedValue, field] of comparisons) {
    if (actualValue !== expectedValue) {
      fail(`Controlled Phase B candidate changed: ${field} expected=${expectedValue} actual=${actualValue}`);
    }
  }
}

export function buildControlledPhaseBConfig(phaseB) {
  if (phaseB.phase_b_observation_snapshot_max_rows !== ACCEPTED_SNAPSHOT_MAX_ROWS) {
    fail(
      `Controlled acceptance requires snapshot row cap ${ACCEPTED_SNAPSHOT_MAX_ROWS}; loaded ${phaseB.phase_b_observation_snapshot_max_rows}`,
    );
  }
  if (phaseB.phase_b_observation_snapshot_max_bytes !== ACCEPTED_SNAPSHOT_MAX_BYTES) {
    fail(
      `Controlled acceptance requires snapshot byte cap ${ACCEPTED_SNAPSHOT_MAX_BYTES}; loaded ${phaseB.phase_b_observation_snapshot_max_bytes}`,
    );
  }
  if (!Array.isArray(phaseB.observations_pollutant_codes) || phaseB.observations_pollutant_codes.length !== 0) {
    fail("Controlled acceptance requires the complete all-property Prune connector-day source, not a pollutant subset");
  }
  return {
    ...phaseB,
    max_candidates_per_run: CONTROLLED_MAX_CANDIDATES,
    staging_retention_days: CONTROLLED_STAGING_RETENTION_DAYS,
    prune_check_dropbox: {
      ...(phaseB.prune_check_dropbox || {}),
      enabled: false,
      required: false,
    },
  };
}

function validateRuntimeAuthority({ options, phaseB, env }) {
  const loadedEnvironment = String(env.UKAQ_ENV_NAME || "").trim().toUpperCase();
  if (loadedEnvironment !== options.environment) {
    fail(`Loaded UKAQ_ENV_NAME=${loadedEnvironment || "<empty>"} differs from requested ${options.environment}`);
  }
  if (String(env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION || "").trim() !== "v2") {
    fail("Loaded UK_AQ_R2_HISTORY_INTEGRITY_VERSION must be exactly v2");
  }
  if (phaseB.history_write_version !== "v2") {
    fail(`Logical history authority must be v2; loaded ${phaseB.history_write_version}`);
  }
  if (phaseB.observation_history_index_version !== "v3") {
    fail(`Observation index authority must be v3; loaded ${phaseB.observation_history_index_version}`);
  }
  if (phaseB.r2?.bucket !== options.expectedBucket) {
    fail(`R2 bucket differs from expected: expected=${options.expectedBucket} actual=${phaseB.r2?.bucket || "<empty>"}`);
  }
  if (String(env.GITHUB_SHA || "").trim().toLowerCase() !== options.expectedGitSha) {
    fail("Loaded GITHUB_SHA differs from --expected-git-sha");
  }
  if (!phaseB.supabase_db_url) fail("SUPABASE_DB_URL is required");
  if (!phaseB.observs_source?.base_url) fail("OBS_AQIDB_SUPABASE_URL is required");
  if (!phaseB.observs_source?.privileged_key) fail("OBS_AQIDB_SECRET_KEY is required");
  if (!(phaseB.r2?.endpoint && phaseB.r2?.access_key_id && phaseB.r2?.secret_access_key)) {
    fail("Complete R2 endpoint/access credentials are required");
  }
}

function assertApplySummary({ summary, expected, events }) {
  if (summary?.enabled !== true) fail("Phase B was not enabled");
  if (summary?.status !== "completed") fail(`Phase B status was ${String(summary?.status)}`);
  if (summary?.stopped_for_budget !== false) fail("Phase B stopped for budget");
  if (Number(summary?.processed_candidates) !== 1) {
    fail(`Expected exactly one processed candidate; got ${String(summary?.processed_candidates)}`);
  }
  if (Number(summary?.completed_candidates) !== 1) {
    fail(`Expected exactly one completed candidate; got ${String(summary?.completed_candidates)}`);
  }
  if (Number(summary?.failed_candidates) !== 0) {
    fail(`Phase B failed_candidates=${String(summary?.failed_candidates)}`);
  }
  if (Array.isArray(summary?.failures) && summary.failures.length > 0) {
    fail("Phase B reported candidate failures");
  }
  if (Array.isArray(summary?.aggregate_day_failures) && summary.aggregate_day_failures.length > 0) {
    fail("Phase B reported aggregate-day failures");
  }
  if (Number(summary?.staging_cleanup?.deleted_count || 0) !== 0) {
    fail(`Controlled acceptance unexpectedly deleted ${summary.staging_cleanup.deleted_count} staging object(s)`);
  }
  if (Number(summary?.prune_check_dropbox_exports || 0) !== 0 || Number(summary?.prune_check_dropbox_failures || 0) !== 0) {
    fail("Controlled acceptance unexpectedly used the optional Phase B Dropbox comparison surface");
  }

  const completions = events.filter((entry) => entry.event === "phase_b_history_candidate_complete");
  if (completions.length !== 1) {
    fail(`Expected exactly one phase_b_history_candidate_complete event; got ${completions.length}`);
  }
  const completed = completions[0];
  const checks = [
    [completed.day_utc, expected.day_utc, "completed day_utc"],
    [Number(completed.connector_id), Number(expected.connector_id), "completed connector_id"],
    [String(completed.expected_row_count), String(expected.source_row_count), "completed expected_row_count"],
    [String(completed.written_row_count), String(expected.source_row_count), "completed written_row_count"],
    [completed.source_content_hash, expected.source_identity.source_content_hash, "completed source_content_hash"],
  ];
  for (const [actual, expectedValue, field] of checks) {
    if (actual !== expectedValue) fail(`${field} expected=${expectedValue} actual=${actual}`);
  }
  return completed;
}

function manifestPollutantCodes(manifest) {
  const children = Array.isArray(manifest?.pollutant_manifests)
    ? manifest.pollutant_manifests
    : Array.isArray(manifest?.child_manifests)
      ? manifest.child_manifests
      : [];
  return Array.from(new Set(
    children
      .map((entry) => String(entry?.pollutant_code || "").trim().toLowerCase())
      .filter(Boolean),
  )).sort();
}

async function defaultPostflight({ phaseB, expected, runId, expectedPollutants }) {
  const client = new Client({
    connectionString: phaseB.supabase_db_url,
    application_name: "uk-aq-index-v3-controlled-phase-b-postflight",
  });
  await client.connect();
  try {
    const sourceRows = await readCanonicalConnectorDayRows(
      client,
      expected.day_utc,
      expected.connector_id,
    );
    const postSource = summarizeSourceRows(sourceRows);
    const sourceComparison = comparePruneConnectorSourceIdentities(
      expected.source_identity,
      postSource.source_identity,
    );
    if (!sourceComparison.match) {
      fail(`Retained IngestDB source identity changed after controlled write: ${sourceComparison.failure_reason}`);
    }

    const candidateResult = await client.query(
      `
select
  day_utc::text,
  connector_id,
  status,
  run_id,
  expected_row_count::text,
  history_row_count::text,
  history_file_count,
  history_total_bytes::text,
  manifest_key,
  source_content_hash,
  source_content_hash_contract_version,
  source_content_hash_row_count::text
from uk_aq_ops.history_candidates
where day_utc = $1::date
  and connector_id = $2::integer
`,
      [expected.day_utc, expected.connector_id],
    );
    if (candidateResult.rows.length !== 1) fail("Controlled history candidate row is missing after apply");
    const candidate = candidateResult.rows[0];
    if (candidate.status !== "complete" || candidate.run_id !== runId) {
      fail("Controlled history candidate is not complete for the accepted run_id");
    }
    if (String(candidate.history_row_count) !== String(expected.source_row_count)) {
      fail("Controlled history candidate history_row_count differs from expected source row count");
    }
    if (candidate.source_content_hash !== expected.source_identity.source_content_hash) {
      fail("Controlled history candidate source_content_hash differs from expected identity");
    }

    const gateResult = await client.query(
      `
select
  day_utc::text,
  connector_id,
  history_done,
  history_run_id,
  history_manifest_key,
  history_manifest_hash,
  history_row_count::text,
  history_file_count,
  history_total_bytes::text,
  source_content_hash,
  source_content_hash_contract_version,
  source_content_hash_row_count::text,
  completion_source
from uk_aq_ops.prune_connector_day_gates
where day_utc = $1::date
  and connector_id = $2::integer
`,
      [expected.day_utc, expected.connector_id],
    );
    if (gateResult.rows.length !== 1) fail("Controlled connector-day gate row is missing after apply");
    const gate = gateResult.rows[0];
    if (gate.history_done !== true || gate.history_run_id !== runId) {
      fail("Controlled connector-day gate is not complete for the accepted run_id");
    }
    if (gate.source_content_hash !== expected.source_identity.source_content_hash) {
      fail("Controlled connector-day gate source_content_hash differs from expected identity");
    }
    if (gate.completion_source !== "prune_daily_phase_b") {
      fail(`Unexpected connector-day gate completion_source=${String(gate.completion_source)}`);
    }

    const runCountResult = await client.query(
      `
select count(*)::integer as completed_count
from uk_aq_ops.history_candidates
where run_id = $1
  and status = 'complete'
`,
      [runId],
    );
    if (Number(runCountResult.rows[0]?.completed_count) !== 1) {
      fail(`Expected exactly one completed candidate for run_id=${runId}`);
    }

    const object = await r2GetObject({ r2: phaseB.r2, key: candidate.manifest_key });
    const manifest = JSON.parse(object.body.toString("utf8"));
    const actualPollutants = manifestPollutantCodes(manifest);
    const expectedSortedPollutants = [...expectedPollutants].sort();
    if (JSON.stringify(actualPollutants) !== JSON.stringify(expectedSortedPollutants)) {
      fail(
        `Complete-snapshot connector pollutant set mismatch: expected=${expectedSortedPollutants.join(",")} actual=${actualPollutants.join(",")}`,
      );
    }

    return {
      source_preservation: {
        source_row_count_after: String(sourceRows.length),
        source_identity_after: postSource.source_identity,
        source_deletion_committed: false,
      },
      candidate,
      connector_day_gate: gate,
      completed_candidates_for_run: 1,
      connector_manifest: {
        manifest_key: candidate.manifest_key,
        final_pollutant_codes: actualPollutants,
        final_pollutant_count: actualPollutants.length,
      },
    };
  } finally {
    await client.end();
  }
}

function compactEvents(events) {
  const keep = new Set([
    "phase_b_history_run_start",
    "phase_b_history_candidate_eligibility_summary",
    "phase_b_history_candidate_start",
    "phase_b_history_connector_publication_complete",
    "phase_b_history_v3_run_finalization_complete",
    "phase_b_history_candidate_complete",
    "phase_b_history_run_summary",
  ]);
  return events.filter((entry) => keep.has(entry.event));
}

function serializable(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => (
    typeof entry === "bigint" ? entry.toString() : entry
  )));
}

export async function executeControlledPhaseBAcceptance(options, {
  env = process.env,
  resolveConfig = resolvePhaseBRuntimeConfig,
  discoverCandidate = discoverNextControlledPhaseBCandidateReadOnly,
  runPhaseB = runPhaseBBackup,
  postflight = defaultPostflight,
  lockContext = observationsGlobalOperationLockContext,
  nowUtc = () => new Date().toISOString(),
} = {}) {
  const phaseBBase = resolveConfig(env);
  validateRuntimeAuthority({ options, phaseB: phaseBBase, env });
  const phaseB = buildControlledPhaseBConfig(phaseBBase);
  const ingestRetentionDays = Number(env.INGESTDB_RETENTION_DAYS || "5");
  if (!Number.isSafeInteger(ingestRetentionDays) || ingestRetentionDays <= 0) {
    fail("INGESTDB_RETENTION_DAYS must resolve to a positive integer");
  }

  const plan = await discoverCandidate({
    phaseB,
    ingestRetentionDays,
    nowUtc: nowUtc(),
  });
  if (!plan.candidate) fail("No pending Phase B connector-day candidate is currently eligible");
  if (Number(plan.candidate.source_row_count) > phaseB.phase_b_observation_snapshot_max_rows) {
    fail(
      `Selected candidate exceeds accepted snapshot row cap: rows=${plan.candidate.source_row_count} cap=${phaseB.phase_b_observation_snapshot_max_rows}`,
    );
  }

  const expected = expectedCandidateFromOptions(options);
  if (expected) assertControlledPlanMatchesExpected(plan, expected);

  if (options.mode === "dry-run") {
    return {
      ok: true,
      mode: "dry-run",
      mutation_performed: false,
      environment: options.environment,
      repository_git_sha: options.expectedGitSha,
      r2_bucket: phaseB.r2.bucket,
      logical_history_version: phaseB.history_write_version,
      observation_history_index_version: phaseB.observation_history_index_version,
      controlled_limits: {
        max_candidates_per_run: phaseB.max_candidates_per_run,
        snapshot_max_rows: phaseB.phase_b_observation_snapshot_max_rows,
        snapshot_max_bytes: phaseB.phase_b_observation_snapshot_max_bytes,
        staging_retention_days: phaseB.staging_retention_days,
        prune_check_dropbox_enabled: phaseB.prune_check_dropbox.enabled,
      },
      plan,
    };
  }

  const heldLock = lockContext({ env, expectedOwner: "prune_daily" });
  if (!heldLock?.valid) {
    fail("--apply must run inside the repository observations global operation lock as owner=prune_daily");
  }

  const events = [];
  const logStructured = (severity, event, details = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      severity,
      event,
      ...details,
    };
    events.push(entry);
    process.stdout.write(`${JSON.stringify(serializable(entry))}\n`);
  };

  const summary = await runPhaseB({
    dryRun: false,
    phaseB,
    ingestRetentionDays,
    logStructured,
    runId: options.runId,
  });
  const completed = assertApplySummary({ summary, expected, events });
  const post = await postflight({
    phaseB,
    expected,
    runId: options.runId,
    expectedPollutants: plan.candidate.pollutant_codes,
  });

  return {
    ok: true,
    mode: "apply",
    environment: options.environment,
    run_id: options.runId,
    repository_git_sha: options.expectedGitSha,
    node_version: process.version,
    r2_bucket: phaseB.r2.bucket,
    logical_history_version: phaseB.history_write_version,
    observation_history_index_version: phaseB.observation_history_index_version,
    rollback_data_preservation_mode: "retain_upstream_source",
    execution_scope: "runPhaseBBackup_only_no_full_prune_job",
    controlled_limits: {
      max_candidates_per_run: phaseB.max_candidates_per_run,
      snapshot_max_rows: phaseB.phase_b_observation_snapshot_max_rows,
      snapshot_max_bytes: phaseB.phase_b_observation_snapshot_max_bytes,
      staging_retention_days: phaseB.staging_retention_days,
      prune_check_dropbox_enabled: phaseB.prune_check_dropbox.enabled,
    },
    plan,
    completed_candidate: completed,
    phase_b_summary: summary,
    postflight: post,
    evidence_events: compactEvents(events),
  };
}

function printDryRun(result) {
  const candidate = result.plan.candidate;
  process.stdout.write("============================================================\n");
  process.stdout.write(`UK AQ INDEX V3 CONTROLLED PHASE B ACCEPTANCE DRY RUN: ${result.environment}\n`);
  process.stdout.write("STRICT READ-ONLY PLANNER: runPhaseBBackup() WAS NOT CALLED\n\n");
  process.stdout.write(`Git SHA: ${result.repository_git_sha}\n`);
  process.stdout.write(`R2 bucket: ${result.r2_bucket}\n`);
  process.stdout.write(`History/index: ${result.logical_history_version}/${result.observation_history_index_version}\n`);
  process.stdout.write(`Latest eligible day: ${result.plan.window.latest_eligible_day_utc}\n`);
  process.stdout.write(`Selection reason: ${result.plan.selection_reason}\n\n`);
  process.stdout.write("Selected candidate:\n");
  process.stdout.write(`  day_utc: ${candidate.day_utc}\n`);
  process.stdout.write(`  connector_id: ${candidate.connector_id}\n`);
  process.stdout.write(`  source_row_count: ${candidate.source_row_count}\n`);
  process.stdout.write(`  source_content_hash: ${candidate.source_identity.source_content_hash}\n`);
  process.stdout.write(`  source_content_hash_contract_version: ${candidate.source_identity.source_content_hash_contract_version}\n`);
  process.stdout.write(`  pollutants (${candidate.pollutant_codes.length}): ${candidate.pollutant_codes.join(",")}\n\n`);
  process.stdout.write("Would execute on --apply:\n");
  process.stdout.write("  real Phase B v3 writer/finaliser: YES\n");
  process.stdout.write("  maximum canonical candidates: 1\n");
  process.stdout.write("  full Prune job: NO\n");
  process.stdout.write("  IngestDB source deletion path: NOT INVOKED\n");
  process.stdout.write("  optional Phase B Dropbox comparison: DISABLED\n");
  process.stdout.write("  rollback data preservation: retain upstream source\n\n");
  process.stdout.write("DRY RUN PASS\n");
  process.stdout.write("NO DATABASE, R2, DROPBOX, GITHUB OR CLOUDFLARE MUTATION WAS PERFORMED BY THE NODE ACCEPTANCE RUNNER\n");
  process.stdout.write(`CONTROLLED_PHASE_B_PLAN_JSON=${JSON.stringify(serializable(result.plan))}\n`);
}

function writeEvidence(reportOut, payload) {
  fs.mkdirSync(path.dirname(path.resolve(reportOut)), { recursive: true });
  fs.writeFileSync(
    reportOut,
    `${JSON.stringify(serializable(payload), null, 2)}\n`,
    "utf8",
  );
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const options = parseControlledPhaseBAcceptanceArgs(argv);
  try {
    const result = await executeControlledPhaseBAcceptance(options, { env });
    if (options.mode === "dry-run") {
      printDryRun(result);
      return 0;
    }
    const evidence = {
      schema_version: 1,
      kind: "index_v3_controlled_phase_b_acceptance",
      status: "PASS",
      created_at_utc: new Date().toISOString(),
      ...result,
    };
    writeEvidence(options.reportOut, evidence);
    process.stdout.write(`${JSON.stringify({
      event: "CONTROLLED_PHASE_B_ACCEPTANCE_PASS",
      run_id: options.runId,
      day_utc: result.plan.candidate.day_utc,
      connector_id: result.plan.candidate.connector_id,
      source_row_count: result.plan.candidate.source_row_count,
      source_content_hash: result.plan.candidate.source_identity.source_content_hash,
      source_deletion_committed: false,
      evidence_report: options.reportOut,
    })}\n`);
    return 0;
  } catch (error) {
    if (options.mode === "apply" && options.reportOut) {
      writeEvidence(options.reportOut, {
        schema_version: 1,
        kind: "index_v3_controlled_phase_b_acceptance",
        status: "FAIL",
        created_at_utc: new Date().toISOString(),
        environment: options.environment,
        run_id: options.runId,
        repository_git_sha: options.expectedGitSha,
        expected_candidate: expectedCandidateFromOptions(options),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
