// Private PostgreSQL reader. No RPC, gate lookup, mutation, or timestamp checkpoint.
import { PRUNE_GATE_ACCEPTANCE_RELATION, preparePrunePostCommitHandover } from './prune-outbox.mjs';
import { canonicalJson } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { evidence, freeze } from './limits.mjs';
import { isEnvironmentName, configuredEnvironment } from './environment.mjs';
import { assertOpsEnvironment } from './admission.mjs';

export const OUTBOX_PAGE_LIMIT = 16;
const originals = new WeakMap();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PK = ['environment', 'writer_identity', 'run_id', 'attempt_id', 'day_utc', 'connector_id'];
const projection = `event_schema_version, environment, writer_identity, writer_git_sha,
  run_id::text, attempt_id::text, day_utc::text, connector_id,
  to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at,
  source_content_hash, source_content_hash_contract_version, source_content_hash_row_count,
  history_manifest_key, history_manifest_hash, history_row_count, history_file_count,
  history_total_bytes, gate_history_completed_at, gate_completion_source, candidate_ready_marker,
  connector_manifest_byte_sha256, connector_manifest_byte_size, pending_disposition,
  pending_intent_id, pending_bucket, pending_object_key, pending_compressed_sha256,
  pending_compressed_byte_size, pending_ndjson_sha256, pending_ndjson_byte_size,
  original_source_status_provenance, final_evidence_state, final_evidence_sha256,
  octet_length(final_evidence_bytes) as final_evidence_byte_size`;

export function assertPruneAcceptanceKey(key) {
  evidence(key && Object.keys(key).length === PK.length && PK.every(k => Object.hasOwn(key, k))
    && isEnvironmentName(key.environment) && key.writer_identity === 'prune_daily_v3'
    && UUID.test(key.run_id) && key.attempt_id === key.run_id && key.connector_id === 1
    && /^\d{4}-\d{2}-\d{2}$/.test(key.day_utc)
    && new Date(`${key.day_utc}T00:00:00.000Z`).toISOString().slice(0, 10) === key.day_utc,
  'invalid_acceptance_key', 'Complete original AURN acceptance primary key required');
  return key;
}
export const pruneAcceptanceKey = row => assertPruneAcceptanceKey(Object.fromEntries(PK.map(k => [k, row[k]])));
export const pruneAcceptanceId = key => sha256Hex(canonicalJson(assertPruneAcceptanceKey(key)));
function timestamp(value) {
  evidence(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.(?:\d{3}|\d{6})Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'invalid_discovery_window', 'UTC discovery timestamp required');
  return value;
}

// Only tokens created by an actual reader SELECT can reach the authentication
// adapter. Neither a notification nor caller-provided row/ok flag is a token.
export function originalPruneAcceptance(token) {
  const value = originals.get(token);
  evidence(value, 'unauthenticated_original_outbox', 'Original event must be retrieved through the private outbox reader');
  return { row: structuredClone(value.row), bytes: value.bytes && Buffer.from(value.bytes),
    executionEnvironment: value.environment };
}

export async function connectPruneOutboxReader({ env = process.env, Client = null } = {}) {
  assertOpsEnvironment(env);
  const environment = configuredEnvironment(env);
  evidence(env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL
    && env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL !== env.SUPABASE_DB_URL
    && env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL !== env.UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN,
  'reader_configuration_required', 'Dedicated private read-only PostgreSQL URL required');
  let url; let target;
  try { url = new URL(env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL); target = new URL(env.SUPABASE_URL); } catch {
    evidence(false, 'reader_configuration_required', 'Invalid private PostgreSQL URL');
  }
  evidence(['postgres:', 'postgresql:'].includes(url.protocol) && url.username && url.password
    && url.hostname && !url.hash && [...url.searchParams.keys()].every(k => k === 'sslmode')
    && (!url.searchParams.has('sslmode') || ['require', 'verify-full'].includes(url.searchParams.get('sslmode'))),
  'reader_configuration_required', 'Authenticated TLS PostgreSQL URL required');
  evidence(target.protocol === 'https:' && /^[a-z0-9]{20}\.supabase\.co$/.test(target.hostname)
    && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
  'reader_configuration_required', 'Existing configured SUPABASE_URL project identity required');
  const project = target.hostname.split('.')[0];
  evidence(url.hostname === `db.${project}.supabase.co`
    || (/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname)
      && decodeURIComponent(url.username).endsWith(`.${project}`)),
  'reader_configuration_required', 'Reader must target the configured IngestDB project');
  url.search = ''; // Explicit verified TLS below; URL options cannot weaken it.
  Client ??= (await import('pg')).default.Client;
  const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true },
    application_name: 'uk_aq_jsongen_prune_consumer', connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 6000,
    options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=10000' });
  let busy = false;
  const transaction = async operation => {
    evidence(!busy, 'reader_busy', 'Concurrent operations on the private reader are prohibited');
    busy = true;
    try {
      await client.query('BEGIN READ ONLY');
      const result = await operation();
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      // Database errors can contain connection strings, SQL values or bytea.
      // Do not propagate their text into machine-readable consumer results.
      if (cause?.name === 'JSONgenEvidenceError') throw cause;
      evidence(false, 'outbox_read_unavailable', 'Private read-only outbox operation failed; replay required');
    } finally { busy = false; }
  };
  try {
    await client.connect();
    await transaction(async () => {
      const result = await client.query(`SELECT current_setting('transaction_read_only') = 'on' as read_only,
        NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication as restricted_role,
        pg_has_role(current_user, 'uk_aq_jsongen_prune_reader', 'USAGE') as reader_membership,
        current_setting('default_transaction_read_only') = 'on' as default_read_only,
        EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
          WHERE p.polrelid = '${PRUNE_GATE_ACCEPTANCE_RELATION}'::regclass
            AND p.polname = 'prune_jsongen_private_aurn_reader' AND p.polcmd = 'r') as reader_policy,
        has_table_privilege(current_user, '${PRUNE_GATE_ACCEPTANCE_RELATION}', 'SELECT') as can_read,
        has_table_privilege(current_user, '${PRUNE_GATE_ACCEPTANCE_RELATION}', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') as can_mutate,
        has_function_privilege(current_user,
          'uk_aq_ops.insert_prune_jsongen_gate_acceptance(date,integer,uuid,text,jsonb,bytea)', 'EXECUTE') as can_accept
        FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
      const r = result.rows[0];
      evidence(result.rows.length === 1 && r.read_only && r.default_read_only && r.restricted_role
        && r.reader_membership && r.reader_policy && r.can_read
        && !r.can_mutate && !r.can_accept, 'reader_privilege_rejected',
      'Reader requires SELECT with no elevated role, outbox mutation or acceptance-function privilege');
    });
  } catch (error) {
    await client.end().catch(() => {});
    if (error?.name === 'JSONgenEvidenceError') throw error;
    evidence(false, 'outbox_connection_unavailable', 'Private read-only outbox connection unavailable');
  }
  return Object.freeze({
    async read(key) {
      key = structuredClone(assertPruneAcceptanceKey(key));
      evidence(key.environment === environment, 'cross_environment_evidence', 'Acceptance key differs from configured reader environment');
      return transaction(async () => {
        const result = await client.query(`SELECT ${projection}, final_evidence_bytes
          FROM ${PRUNE_GATE_ACCEPTANCE_RELATION}
          WHERE environment=$1 AND writer_identity=$2 AND run_id=$3::uuid
            AND attempt_id=$4::uuid AND day_utc=$5::date AND connector_id=$6`, PK.map(k => key[k]));
        if (!result.rows.length) return null;
        evidence(result.rows.length === 1, 'conflicting_original_event', 'Original primary key returned conflicting events');
        const { final_evidence_bytes: bytes, ...row } = result.rows[0];
        evidence(!bytes || (bytes instanceof Uint8Array && bytes.length <= 1024 ** 2),
          'invalid_original_evidence', 'Original evidence exceeds retained bytea limit');
        const reference = preparePrunePostCommitHandover(row);
        evidence(canonicalJson(pruneAcceptanceKey(row)).equals(canonicalJson(key)),
          'conflicting_original_event', 'Retrieved event differs from requested original primary key');
        const token = freeze({ key, event_id: pruneAcceptanceId(key), post_commit_reference: reference });
        originals.set(token, { environment, row: structuredClone(row), bytes: bytes && Buffer.from(bytes) });
        return token;
      });
    },
    async discover({ from, to, after = null, limit = 4, mode = 'recent' }) {
      timestamp(from); timestamp(to);
      evidence(['recent', 'resweep'].includes(mode) && Number.isSafeInteger(limit)
        && limit > 0 && limit <= OUTBOX_PAGE_LIMIT && Date.parse(to) >= Date.parse(from)
        && Date.parse(to) - Date.parse(from) <= 7 * 86400000,
      'invalid_discovery_window', 'Discovery requires at most seven days and sixteen events per page');
      if (after) {
        assertPruneAcceptanceKey(after.key); timestamp(after.accepted_at);
        evidence(after.key.environment === environment, 'cross_environment_evidence', 'Discovery cursor differs from configured reader environment');
        evidence(after.from === from && after.to === to && after.mode === mode
          && Date.parse(after.accepted_at) >= Date.parse(from) && Date.parse(after.accepted_at) <= Date.parse(to),
        'invalid_discovery_window', 'Cursor belongs to a different bounded discovery pass');
      }
      return transaction(async () => {
        const parameters = [environment, from, to, limit + 1];
        let resume = '';
        if (after) {
          parameters.push(after.accepted_at, after.key.run_id, after.key.attempt_id, after.key.day_utc, after.key.connector_id);
          resume = 'AND (accepted_at,run_id,attempt_id,day_utc,connector_id) > ($5::timestamptz,$6::uuid,$7::uuid,$8::date,$9::integer)';
        }
        const result = await client.query(`SELECT ${projection}
          FROM ${PRUNE_GATE_ACCEPTANCE_RELATION}
          WHERE environment=$1 AND writer_identity='prune_daily_v3' AND connector_id=1
            AND accepted_at >= $2::timestamptz AND accepted_at <= $3::timestamptz ${resume}
          ORDER BY accepted_at,run_id,attempt_id,day_utc,connector_id LIMIT $4`, parameters);
        const rows = result.rows.slice(0, limit);
        evidence(result.rows.every(row => row.environment === environment), 'cross_environment_evidence', 'Discovery result differs from configured reader environment');
        const events = rows.map(row => ({ key: pruneAcceptanceKey(row), event_id: pruneAcceptanceId(pruneAcceptanceKey(row)),
          reference_sha256: preparePrunePostCommitHandover(row).sha256 }));
        const last = rows.at(-1);
        return freeze({ mode, from, to, events, state: 'replay_required',
          next: result.rows.length > limit ? { from, to, mode, accepted_at: last.accepted_at, key: pruneAcceptanceKey(last) } : null,
          window_pass_finished: result.rows.length <= limit,
          coverage_complete: false, replay: 'restart_overlapping_windows_and_periodic_historical_resweeps',
          canonical_precedence: 'not_established_by_discovery' });
      });
    },
    close: () => client.end(),
  });
}
