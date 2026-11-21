// Preloaded only in the Actions child running the existing repair CLI. The
// real driver and fetch still execute each permitted operation.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { isStrongR2Etag, sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { observationsGlobalOperationLockIdentity } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";

const env = process.env;
const latest = getObservationHistoryGeneration("v3").observations_timeseries_latest_key;
const identity = observationsGlobalOperationLockIdentity();
const lockArgs = [identity.class_id, identity.object_id];
const ownerArgs = lockArgs.map(value => value >>> 0);
const acquire = "select pg_try_advisory_lock($1::integer, $2::integer) as acquired";
const release = "select pg_advisory_unlock($1::integer, $2::integer) as released";
const heartbeat = "select 1 as observations_global_operation_lock_heartbeat";
const ownership = "select pg_backend_pid() as session_pid, " +
  "exists (select 1 from pg_locks where locktype = 'advisory' " +
  "and pid = pg_backend_pid() and classid = $1::oid and objid = $2::oid " +
  "and objsubid = 2 and mode = 'ExclusiveLock' and granted) as held";
const write = event => appendFileSync(env.RECOVERY_AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

const connectionErrorCodes = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function recordPostgresFailure(event, error) {
  const { code, message } = error;
  // Keep protocol error codes and fixed messages. Driver error text can contain credentials or provider data.
  if (connectionErrorCodes.has(code) || (error instanceof pg.DatabaseError && /^[0-9A-Z]{5}$/.test(code))) {
    write({ event, code });
    return;
  }
  const summary = event === "db_session_setup_failed" ? "PostgreSQL read-only session setup failed"
    : message === "timeout expired" || message === "Connection terminated due to connection timeout" ? "PostgreSQL connection timed out"
      : "PostgreSQL connection failed";
  write({ event, message: summary });
}

const originalConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = async function (...args) {
  try {
    return await originalConnect.apply(this, args);
  } catch (error) {
    recordPostgresFailure("db_connection_failed", error);
    throw error;
  }
};

const originalQuery = pg.Client.prototype.query;
let client, held = false, pid, attempts = 0;
pg.Client.prototype.query = async function (sql, parameters) {
  const query = typeof sql === "string" ? sql.trim().replace(/\s+/g, " ") : "";
  const args = query === ownership ? ownerArgs : lockArgs;
  const allowed = query === heartbeat ? parameters === undefined
    : [acquire, release, ownership].includes(query) && JSON.stringify(parameters) === JSON.stringify(args);
  if (!allowed) {
    write({ event: "db_query_blocked" });
    throw new Error("Recovery SQL outside the advisory-lock allowlist");
  }
  if (query === acquire && client !== this) {
    assert(!held, "New database session while the original lock is held");
    client = this;
    pid = undefined;
    attempts = 0;
    try {
      await originalQuery.call(this, "SET default_transaction_read_only = on");
      const result = await originalQuery.call(this, "SHOW transaction_read_only");
      assert.equal(result.rows[0]?.transaction_read_only, "on");
    } catch (error) {
      recordPostgresFailure("db_session_setup_failed", error);
      throw error;
    }
    write({ event: "db_session_read_only", ...identity });
  }
  assert(client === this && (query === acquire || held), "Query outside the original database session");
  if (query === acquire) attempts++;
  const result = await originalQuery.call(this, sql, parameters);
  const row = result.rows[0];
  if (query === acquire && row?.acquired === true) {
    held = true;
    write({ event: "lock_acquired", ...identity, attempts });
  }
  if (query === ownership) {
    assert(row?.held === true && Number.isSafeInteger(row.session_pid) && (pid === undefined || pid === row.session_pid));
    pid = row.session_pid;
    write({ event: "lock_asserted", backend_pid: pid });
  }
  if (query === release && row?.released === true) {
    held = false;
    write({ event: "lock_released", backend_pid: pid });
  }
  return result;
};

const fetchR2 = globalThis.fetch;
const bucketPrefix = `/${env.CFLARE_R2_BUCKET}/`;
const origin = new URL(env.CFLARE_R2_ENDPOINT).origin;
let putAttempts = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const method = init.method;
  const key = decodeURIComponent(url.pathname.slice(bucketPrefix.length));
  if (url.origin !== origin || !url.pathname.startsWith(bucketPrefix) || url.search || !held || !pid) {
    write({ event: "r2_request_blocked", method });
    throw new Error("Recovery R2 request outside its isolated bucket or original lock");
  }
  const headers = new Headers(init.headers);
  const ifMatch = headers.get("if-match");
  const digest = method === "PUT" && init.body ? sha256Hex(init.body) : null;
  if (method !== "GET" && (method !== "PUT" || !env.RECOVERY_EXPECTED_ETAG ||
      key !== latest || ++putAttempts !== 1 || !isStrongR2Etag(ifMatch) ||
      ifMatch !== env.RECOVERY_EXPECTED_ETAG || digest !== env.RECOVERY_EXPECTED_SHA256 ||
      !headers.get("authorization")?.match(/SignedHeaders=([^,]+)/)?.[1].split(";").includes("if-match"))) {
    write({ event: "r2_request_blocked", method, key });
    throw new Error("Recovery R2 mutation outside the approved single conditional PUT");
  }
  const receipt = { method, key, backend_pid: pid, ...(method === "PUT" ? { if_match: ifMatch, sha256: digest } : {}) };
  write({ event: "r2_request", ...receipt });
  const response = await fetchR2(input, { ...init, redirect: "error" });
  write({ event: "r2_response", ...receipt, status: response.status, etag: response.headers.get("etag") });
  return response;
};
