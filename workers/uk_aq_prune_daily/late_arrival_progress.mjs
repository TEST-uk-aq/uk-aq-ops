import { randomUUID } from "node:crypto";
import pg from "pg";

const LOCK_KEY = "uk_aq:prune_late_arrival_discovery:v1";
const TABLE = "uk_aq_ops.prune_late_arrival_progress";
const COLUMNS = `schema_version, progress_version::text, sweep_cutoff,
  next_day_utc::text, sweep_complete`;

// One retained direct PostgreSQL session, like source_identity_deletion.mjs.
// A session lock is deliberately not a transaction or a time-expiring lease:
// slow day processing cannot outlive its lease and overlap another owner.
export async function openLateArrivalProgress({ databaseUrl, dryRun, createClient = (options) => new pg.Client(options) }) {
  if (!databaseUrl) throw new Error("Late-arrival progress requires SUPABASE_DB_URL");
  const client = createClient({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    query_timeout: 20_000,
    statement_timeout: 15_000,
    application_name: "uk-aq-prune-late-arrival-progress",
  });
  let sessionError = null;
  client.on("error", (error) => { sessionError = error; });
  const owner = randomUUID();
  let version = null;
  let locked = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    // Closing the owning session releases the lock, including after a failed
    // COMMIT. No cleanup UPDATE may overwrite a subsequent owner's progress.
    await client.end();
  }
  try {
    await client.connect();
    if (!dryRun) {
      const result = await client.query(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired", [LOCK_KEY],
      );
      locked = result.rows[0]?.acquired === true;
      if (!locked) throw new Error("Late-arrival discovery is owned by another invocation; retry later");
      await client.query("begin");
      try {
        await client.query(`insert into ${TABLE} (singleton) values (true) on conflict do nothing`);
        const claimed = await client.query(`update ${TABLE}
          set owner_token = $1, progress_version = progress_version + 1, updated_at = clock_timestamp()
          where singleton and schema_version = 1 returning ${COLUMNS}`, [owner]);
        if (claimed.rows.length !== 1) throw new Error("Unsupported late-arrival progress state");
        version = claimed.rows[0].progress_version;
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
    const read = await client.query(`select ${COLUMNS} from ${TABLE} where singleton`);
    if (read.rows.length > 1) throw new Error("Ambiguous late-arrival progress state");
    const state = read.rows[0] || null;
    if (state?.sweep_cutoff instanceof Date) state.sweep_cutoff = state.sweep_cutoff.toISOString();

    async function assertOwned() {
      if (sessionError || closed) throw new Error("Late-arrival progress session lost");
      if (dryRun) return;
      const result = await client.query(`select progress_version::text from ${TABLE}
        where singleton and owner_token = $1 and progress_version = $2::bigint
        and exists (
          select 1 from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid() and granted
            and classid = ((hashtextextended($3, 0) >> 32) & 4294967295)::oid
            and objid = (hashtextextended($3, 0) & 4294967295)::oid and objsubid = 1
        )`, [owner, version, LOCK_KEY]);
      if (result.rows.length !== 1) throw new Error("Late-arrival progress ownership/version lost");
    }

    async function save(next, report) {
      if (dryRun) throw new Error("Dry-run cannot persist late-arrival progress");
      await assertOwned();
      // One atomic statement commits the considered outcomes and cursor together.
      // An ambiguous result is not retried here: the next invocation reads state.
      const result = await client.query(`update ${TABLE}
        set sweep_cutoff = $3::timestamptz, next_day_utc = $4::date,
            sweep_complete = $5, last_report = $6::jsonb,
            progress_version = progress_version + 1, updated_at = clock_timestamp()
        where singleton and schema_version = 1 and owner_token = $1 and progress_version = $2::bigint
        returning progress_version::text`,
      [owner, version, next.sweep_cutoff, next.next_day_utc, next.sweep_complete, JSON.stringify(report)]);
      if (result.rows.length !== 1) throw new Error("Late-arrival progress checkpoint rejected");
      version = result.rows[0].progress_version;
    }
    return { state, assertOwned, save, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
