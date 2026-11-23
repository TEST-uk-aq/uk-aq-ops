import { isDeepStrictEqual } from "node:util";

import {
  computePruneConnectorSourceIdentity,
  normalizePruneConnectorSourceRow,
} from "../../../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import { encodeCanonicalObservationRow } from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

export const MAX_TRANSACTION_MS = 120_000;
export const MAX_LOCK_MS = 5_000;
export const OBSERVATIONS = "uk_aq_core.observations";
export const RECEIPTS = "uk_aq_ops.prune_stranded_source_reconciliations";
export const PREDICATE = "connector_id = $1::integer and observed_at >= $2::timestamptz and observed_at < $3::timestamptz";
export const LIMITATION = "Canonical equivalence and current physical row identity cannot authenticate original row incarnation.";
export const IMPACT = "All connectors writing to the observations parent or descendants may wait, time out or fail. Reads remain possible.";
const BLOCKED = "PRUNE_HISTORY_AUTHORITY_BLOCKED:";

export function requireFact(ok, message) {
  if (!ok) throw new Error(message);
}

export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export function digest(value) {
  return sha256Hex(canonicalJson(value));
}

export function scopeArgs(baseline) {
  const start = `${baseline.day_utc}T00:00:00.000Z`;
  return [baseline.connector_id, start, new Date(Date.parse(start) + 86_400_000).toISOString()];
}

function rowKey(row, instant) {
  return `${row.connector_id}|${row.timeseries_id}|${instant}`;
}

export function encodeMultiset(rows) {
  return rows.map((row) => encodeCanonicalObservationRow(normalizePruneConnectorSourceRow(row))).sort();
}

function exactEvidence(evidence, baseline) {
  const { candidate, gate } = evidence;
  requireFact(candidate?.status === "failed" && candidate.last_error?.startsWith(BLOCKED) &&
    !candidate.last_error.includes("PRUNE_FIRST_DELETE_READY") &&
    !candidate.last_error.includes("PRUNE_FIRST_DELETE_CONSUMED") &&
    Number(candidate.expected_row_count) === baseline.row_count &&
    !candidate.manifest_key && !candidate.source_content_hash &&
    candidate.source_content_hash_contract_version === null &&
    candidate.source_content_hash_row_count === null &&
    candidate.history_completed_at === null && candidate.history_row_count === null &&
    candidate.history_file_count === null && candidate.history_total_bytes === null,
  "Original candidate differs from the failed, blocked baseline");
  const marker = JSON.parse(candidate.last_error.slice(BLOCKED.length));
  requireFact(marker.connector_id === baseline.connector_id && marker.day_utc === baseline.day_utc &&
    marker.previous_authority === `${baseline.manifest_key}#${baseline.manifest_hash}`,
  "Candidate blocked marker identifies a different publication");
  requireFact(gate?.history_done === false && [
    "history_run_id", "history_manifest_key", "history_manifest_hash", "history_row_count",
    "history_file_count", "history_total_bytes", "history_completed_at", "completion_source",
    "source_content_hash", "source_content_hash_contract_version", "source_content_hash_row_count",
  ].every((field) => gate[field] === null), "Incomplete connector-day gate has conflicting authority");
}

export async function readEvidence(client, baseline, lock = false) {
  const params = [baseline.day_utc, baseline.connector_id];
  const suffix = lock ? " for update nowait" : "";
  const candidate = await client.query(`select to_jsonb(c) as evidence
    from uk_aq_ops.history_candidates c where day_utc = $1::date and connector_id = $2::integer${suffix}`, params);
  const gate = await client.query(`select to_jsonb(g) as evidence
    from uk_aq_ops.prune_connector_day_gates g where day_utc = $1::date and connector_id = $2::integer${suffix}`, params);
  const evidence = { candidate: candidate.rows[0]?.evidence, gate: gate.rows[0]?.evidence };
  exactEvidence(evidence, baseline);
  return evidence;
}

export async function readReceipts(client, plan) {
  const result = await client.query(`select to_jsonb(r) as receipt from ${RECEIPTS} r
    where (day_utc = $1::date and connector_id = $2::integer) or operation_id = $3::uuid`,
  [plan.baseline.day_utc, plan.baseline.connector_id, plan.operation_id ?? null]);
  return result.rows.map(({ receipt }) => receipt);
}

export async function readPartitionLayout(client, requireFence = false) {
  const { rows } = await client.query(`
    select p.relid::oid::text as oid, p.parentrelid::oid::text as parent_oid, p.level,
      p.isleaf, n.nspname as schema, c.relname as relation, c.relkind as kind, c.relpersistence as persistence,
      pg_get_expr(c.relpartbound, c.oid) as bound, pg_get_partkeydef(c.oid) as partition_key,
      exists (select from pg_locks l where l.locktype = 'relation' and l.relation = c.oid
        and l.pid = pg_backend_pid() and l.mode = 'ShareRowExclusiveLock' and l.granted) as fenced,
      exists (select from pg_trigger t where t.tgrelid = c.oid
        and not t.tgisinternal and t.tgenabled <> 'D') as triggers,
      exists (select from pg_rewrite r where r.ev_class = c.oid) as rules,
      exists (select from pg_constraint k where k.contype = 'f' and k.confrelid = c.oid) as referenced
    from pg_partition_tree('${OBSERVATIONS}'::regclass) p
    join pg_class c on c.oid = p.relid
    join pg_namespace n on n.oid = c.relnamespace
    order by p.level, c.oid`);
  requireFact(rows.length > 1 && rows[0].partition_key === "LIST (connector_id)" &&
    rows.every((row) => row.persistence === "p" && row.kind === (row.isleaf ? "r" : "p") &&
      !row.triggers && !row.rules && !row.referenced && (!requireFence || row.fenced)),
  "Partition coverage or observation write/trigger paths are unsupported");
  return rows.map(({ fenced: _fenced, ...row }) => row);
}

export async function readSource(client, baseline) {
  const expectedRows = baseline.row_count;
  const scope = scopeArgs(baseline);
  const rawResult = await client.query(`
    select connector_id, timeseries_id, observed_at::text as instant, tableoid::oid::text as relation_oid,
      ctid::text as tuple_id, xmin::text as row_version,
      created_at is not null and isfinite(created_at) and created_at <= $4::timestamptz as before_cutoff,
      to_jsonb(o) || jsonb_build_object('value_binary', encode(float8send(value), 'hex'),
        'value', value::text, 'observed_at', observed_at::text, 'created_at', created_at::text) as row_data
    from ${OBSERVATIONS} o where ${PREDICATE}
    order by timeseries_id, observed_at limit $5::bigint`, [...scope, baseline.publication_cutoff, expectedRows + 1]);
  const canonicalResult = await client.query(`
    select h.*, observed_at_utc::text as instant from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
      $1::integer, $2::timestamptz, $3::timestamptz, null::integer, null::timestamptz) h
    limit $4::bigint`, [...scope, expectedRows + 1]);
  const raw = rawResult.rows;
  const canonical = canonicalResult.rows;
  requireFact(raw.length === expectedRows && canonical.length === expectedRows && raw.every((row) => row.before_cutoff),
    "Raw/canonical row counts or publication-cutoff evidence disagree");
  const keys = new Set(raw.map((row) => rowKey(row, row.instant)));
  requireFact(keys.size === expectedRows && canonical.every((row) => keys.delete(rowKey(row, row.instant))) &&
    keys.size === 0, "Raw and canonical primary-key scopes differ");
  const hours = Array(24).fill(0);
  const pollutants = new Set();
  for (const row of canonical) {
    const observed = row.observed_at_utc.toISOString();
    requireFact(observed.slice(0, 10) === baseline.day_utc &&
      !/\.\d{4,}/.test(row.instant),
    "Canonical timestamp is outside the day or loses precision in v1 normalisation");
    hours[row.observed_at_utc.getUTCHours()]++;
    pollutants.add(row.pollutant_code);
  }
  const pollutantCodes = [...pollutants].sort();
  requireFact(isDeepStrictEqual(hours, baseline.hourly_counts) && isDeepStrictEqual(pollutantCodes, baseline.pollutants),
    "Source hourly counts or pollutant codes differ from the baseline");
  requireFact(computePruneConnectorSourceIdentity(canonical).source_content_hash === baseline.source_content_hash,
    "Canonical Prune v1 source hash differs from the baseline");
  const rows = raw.map(({ row_data }) => row_data);
  return {
    canonical,
    rows,
    physicalKeys: raw.map((row) => `${row.relation_oid}|${rowKey(row, row.instant)}`),
    summary: { raw_sha256: digest(rows), canonical_multiset_sha256: digest(encodeMultiset(canonical)),
      current_row_witness_sha256: digest(raw.map(({ relation_oid, tuple_id, row_version }) =>
        [relation_oid, tuple_id, row_version])),
      hourly_counts: hours, pollutants: pollutantCodes, row_count: raw.length, after_cutoff_rows: 0 },
  };
}

export async function readCounts(client, baseline) {
  const { rows } = await client.query(`
    select (select count(*) from ${OBSERVATIONS} where ${PREDICATE})::integer as raw,
      (select count(*) from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
        $1::integer, $2::timestamptz, $3::timestamptz, null::integer, null::timestamptz))::integer as canonical`,
  scopeArgs(baseline));
  return rows[0];
}

const LOCK_SQL = `LOCK TABLE ${OBSERVATIONS} IN SHARE ROW EXCLUSIVE MODE`;

export class CommitOutcomeUnknown extends Error {}
export class CommittedNeedsInspection extends Error {}

export async function executeTransaction({ client, lock, plan, planSha, approval, assertWindow }) {
  const budget = assertWindow();
  requireFact(Number.isSafeInteger(budget) && budget > 0 && budget <= MAX_TRANSACTION_MS,
    "Invalid approved transaction duration");
  const wait = Math.min(MAX_LOCK_MS, approval.lock_ms, budget);
  requireFact(Number.isSafeInteger(wait) && wait > 0, "Invalid approved lock deadline");
  // A session timeout set before BEGIN starts counting from transaction start.
  // The local settings below never acquire a REPEATABLE READ snapshot.
  const version = await client.query("show server_version_num");
  requireFact(Number(version.rows[0]?.server_version_num) >= 170000, "PostgreSQL 17+ transaction_timeout is required");
  requireFact(assertWindow() >= budget, "Insufficient remaining approved maintenance time");
  await client.query(`set transaction_timeout = '${budget}ms'`);
  let began = false;
  let committing = false;
  try {
    await client.query("begin isolation level repeatable read");
    began = true;
    await client.query(`set local lock_timeout = '${wait}ms'`);
    // statement_timeout also bounds the total recursive LOCK, not just each relation's wait.
    await client.query(`set local statement_timeout = '${wait}ms'`);
    await client.query("set local time zone 'UTC'");
    await client.query("set local row_security = off");
    lock.assertHeld();
    requireFact(assertWindow() >= budget, "Insufficient remaining approved maintenance time");
    await client.query(LOCK_SQL);
    await client.query(`set local statement_timeout = '${budget}ms'`);
    await lock.assertOwned();
    const layout = await readPartitionLayout(client, true);
    requireFact(isDeepStrictEqual(layout, plan.layout), "Observations partition layout changed");
    requireFact((await readReceipts(client, plan)).length === 0, "Reconciliation was already recorded");
    const evidence = await readEvidence(client, plan.baseline, true);
    requireFact(isDeepStrictEqual(evidence, plan.evidence), "Candidate or gate changed since planning");
    const source = await readSource(client, plan.baseline);
    requireFact(isDeepStrictEqual(source.summary, plan.source), "Source rows or current physical row witness changed since planning");
    assertWindow();

    // Compare DELETE RETURNING to the complete, validated raw key set, including
    // the physical relation. A count alone would not prove the deletion scope.
    const expectedKeys = new Set(source.physicalKeys);
    const deleted = await client.query(`delete from ${OBSERVATIONS} where ${PREDICATE}
      returning connector_id, timeseries_id, observed_at::text as instant, tableoid::oid::text as relation_oid`,
    scopeArgs(plan.baseline));
    const leafOids = new Set(layout.filter((row) => row.isleaf).map((row) => row.oid));
    requireFact(deleted.rowCount === plan.baseline.row_count &&
      deleted.rows.every((row) => leafOids.has(row.relation_oid) && expectedKeys.delete(`${row.relation_oid}|${rowKey(row, row.instant)}`)) &&
      expectedKeys.size === 0, "Deletion returned a different raw key set");
    const counts = await readCounts(client, plan.baseline);
    requireFact(counts.raw === 0 && counts.canonical === 0, "Source was not fully drained inside the transaction");
    const audit = await client.query(`insert into ${RECEIPTS} as r
      (day_utc, connector_id, operation_id, original_run_id, plan_sha256, source_sha256,
       manifest_sha256, deleted_rows, approval_reference, backup, approval_sha256, approval)
      values ($1::date, $2::integer, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb)
      returning to_jsonb(r) as receipt`, [
      plan.baseline.day_utc, plan.baseline.connector_id, plan.operation_id, plan.baseline.original_run_id,
      planSha, plan.baseline.source_content_hash, plan.baseline.manifest_hash, deleted.rowCount,
      approval.reference, JSON.stringify(approval.backup), digest(approval), JSON.stringify(approval),
    ]);
    requireFact(audit.rowCount === 1 && audit.rows[0]?.receipt?.transaction_id,
      "Exceptional receipt was not recorded");
    requireFact(isDeepStrictEqual(await readEvidence(client, plan.baseline, true), plan.evidence),
      "Candidate or gate changed during deletion");
    await lock.assertOwned();
    assertWindow();
    committing = true;
    const result = await client.query("commit");
    requireFact(result.command === "COMMIT", "Server did not acknowledge COMMIT");
    return audit.rows[0].receipt;
  } catch (error) {
    if (committing) throw new CommitOutcomeUnknown("Commit outcome uncertain. Inspect read-only before any further action.", { cause: error });
    if (began) {
      try {
        await client.query("rollback");
      } catch {
        throw new Error("Pre-commit connection or rollback failure. Inspect read-only. Do not retry.", { cause: error });
      }
    }
    throw error;
  }
}
