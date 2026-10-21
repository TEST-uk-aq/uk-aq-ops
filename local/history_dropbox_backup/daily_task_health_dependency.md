# Daily Task Health integration and release guide

This is implementation evidence for Ops PR #119 and its linked TEST Schema PR,
not a replacement for authoritative system documentation. The earlier Started
idempotency blocker has been addressed in source; real database application and
TEST operational acceptance remain separate prerequisites.

Ops PR: https://github.com/TEST-uk-aq/uk-aq-ops/pull/119

Schema PR: https://github.com/TEST-uk-aq/uk-aq-schema/pull/15

No code may assume a source merge applied SQL.

## Existing implementation and contract

`workers/shared/daily_task_health.mjs` supplies the lifecycle client. Its new
optional explicit identity, immutable event timestamps, injected transport and
per-request timeout are used by the local supervisor. Existing callers retain
their defaults. The GitHub-specific `scripts/report_daily_task_health.mjs` and
workflow are unchanged. `buildHistoryBackupTaskSummary` is reused for timings and
observation-copy details; authoritative backup acceptance remains in reports.mjs.

Local Integrity already uses the same `uk_aq_public` Started/Finished/Failed and
recompute RPCs, with `OBS_AQIDB_SUPABASE_URL`/`OBS_AQIDB_SECRET_KEY`, genuine
local source/run identity and optional launchd metadata. Its non-restarting
one-off wrapper and process-local returned UUID did not provide the stronger
lost-start-response/reboot recovery required by this backup. Its insert-style
`report_final` fallback is not used here.

## Canonical non-GitHub Started identity

Canonical owner:
`TEST-uk-aq/uk-aq-schema:schemas/obs_aqi_db/uk_aq_daily_task_health_schema.sql`.
Existing-database transition:
`schemas/migrations/20261021_003_obs_aqidb_daily_task_started_execution_identity.sql`.
The previously applied GitHub-idempotency migration is unchanged.

The existing function now has signature:

```text
uk_aq_public.uk_aq_rpc_daily_task_started(
  p jsonb,
  p_execution_identity jsonb DEFAULT NULL
) RETURNS uuid
```

Existing one-argument callers use the NULL default and retain the exact GitHub
`(task_key, source_repo, platform_run_id, summary.github_run_attempt)` contract,
including the legacy insert behaviour for incomplete identities. No GitHub fields
are manufactured for local runs. A local request sends a separate top-level
`p_execution_identity` argument, so an old server cannot silently ignore a nested
field and insert an unprotected row: it rejects the unmatched RPC signature first.

The optional identity is exactly `{key, fingerprint}`: a nonempty bounded string
key and a 64-character lowercase SHA-256 configuration fingerprint. The local key
is `launchd:<environment>:<operation UUID>`. Source repo, source worker, platform
run ID, original scheduled-for date and start timestamp must all be supplied.
Mixing this identity with a GitHub attempt is rejected. The JSON is stored in one
nullable column on the existing `daily_task_runs` table, with a partial unique
index on `(source_repo, execution_identity->>'key')`. No alternative table, service,
RPC family or task definition is introduced.

A transaction advisory lock serialises each repo/key. Replay returns its existing
UUID, including after Finished/Failed, without replacing the row or summary.
Changed identity JSON, task, worker, platform run, date/start time or explicitly
conflicting attempt fails. Terminal RPCs replace summaries as before, but do not
replace the durable identity column. A task/date allocation lock also prevents
concurrent new executions from selecting the same date-level attempt number.
Different source repos have independent key namespaces.

## Durable local obligations

The operation's `health` record pins the exact source/identity/Started input before
sending it and saves the returned UUID. A committed-but-lost response is recovered
by replaying that identity. Health stages consume a durable bounded request budget
before the request, so crashes cannot reset the breaker. Successful stage progress
resets only that phase's budget. Automatic backup retries keep the same health run.

`successful_completion` and accepted reports describe the actual backup. The
separate health terminal payload/confirmation describes reporting. Accepted JSON
can recover a crash before active.json publication, after the exact reports and
locked receipt are revalidated. Terminal payloads pin factual timestamps, the
original UTC date, source metadata and accepted report identity. Repeated Finished,
Failed or recompute only repairs that obligation; it never enters the backup
boundary after acceptance. No stale operation may supply another one's terminal
identity or report identity. Credential rotation does not change the fingerprint;
source/health-target changes fail closed for the current operation.

Permanent backup failure, exhausted backup budget and deliberate cancellation
produce terminal Failed. Reporting outage alone does not replace backup success
with failure. A recoverable automatic interruption leaves the health run Started.
After terminal Failed confirmation, `new --operation <previous UUID>` explicitly
creates a different one-off; `retry` cannot reopen the factual failed run. New
operations cannot discard unresolved reporting obligations. Stop/uninstall retain
them; reconcile through the agent after review/reinstallation where necessary.

## Required release order and manual TEST apply

1. Review both PRs and merge the TEST Schema source first (separate human action).
2. Apply the new migration to **TEST ObsAQIDB**, using its approved service-role
   administrative connection, then verify the schema and PostgREST cache. Example
   from the merged Schema checkout, using an already protected libpq service:

   ```bash
   PGSERVICE=REPLACE_WITH_APPROVED_TEST_OBSAQIDB_SERVICE psql -X -v ON_ERROR_STOP=1 \
     -f schemas/migrations/20261021_003_obs_aqidb_daily_task_started_execution_identity.sql
   ```

   Never use the IngestDB/global-lock URL for this apply. The transaction includes
   a PostgREST schema reload notification. Read-only verification should confirm
   the two-argument Started signature with its NULL default, the nullable
   `execution_identity` JSONB column, its validation constraint and partial unique
   index, and service-role-only execute privileges. Inspect these exact catalog
   objects rather than inferring application from a Git merge. No SQL was executed
   against TEST/LIVE during implementation.
3. Merge Ops PR #119, install dependencies and the idle agent from its stable
   merged checkout, and fill both independently reviewed lock/ObsAQIDB pins and
   protected credentials. Do not start with an old one-argument server; rejection
   must be treated as an unapplied prerequisite, never a reason to drop identity.
4. Pause schedules through normal operator controls, initiate actual authorised
   TEST work and perform the acceptance steps in README.md. Verify a single health
   UUID after restart/ambiguous response, immutable dates/times and report-only
   recovery after accepted backup completion. Restoring schedules, migration
   application, installation and real execution are not performed by these PRs.

## Focused verification evidence

The isolated PostgreSQL check runs the canonical owner and new migration using a
local Unix socket only. It exercises concurrent independent sessions, a discarded
committed Started response, Finished/Failed replay, conflicting identity reuse,
legacy one-argument GitHub calls and legacy incomplete-identity insert semantics.
It accepts a local binary directory, never a remote database URL or TEST secrets:

```bash
python3 tests/check_daily_task_started_execution_identity.py --pg-bin /absolute/local/postgresql/bin
```

The binary used for implementation verification was disposable PostgreSQL 16.2.
Its built-in gen_random_uuid supplies UUIDs; only the unavailable optional pgcrypto
extension packaging declaration is skipped in that isolated clean bootstrap.
The actual canonical function/migration SQL is executed unchanged. The server is
stopped and its temporary database removed after the check.

Ops `tests/local_history_backup_health.test.mjs` exercises the same supervisor
backup/report boundary with a previously accepted backup. A terminal response loss
and then recompute outage are persisted/reloaded; backup calls remain zero, event
payload/date/time stay identical, and stale identity is rejected. It also checks
shared-client optional-argument and timestamp forwarding. Existing Daily Task
Health deterministic checks remain applicable. These are targeted boundary checks,
not a speculative functional suite. Real TEST/launchd/REST acceptance is pending.

## Rollback, LIVE and Chat-mode handover

Runtime rollback stops this agent and retains evidence, including pending health.
The additive database identity support is backward compatible with old callers;
leave it in place when rolling back the local runtime. Do not delete health rows,
identity evidence or remote backup checkpoints. A SQL signature downgrade would
prevent pending local identity replays and requires a separately reviewed plan.

Future LIVE promotion requires the complete identical Ops file list in README.md,
this canonical owner and the new migration, accepted matching canonical backup
code and separate LIVE configuration. Promote validation sources where required
for review; exclude TEST archives and runtime/credential files. Apply/verify the
LIVE ObsAQIDB contract separately before runtime activation, under future explicit
authorisation. No LIVE repository was inspected or modified.

Authoritative system-doc handover for Chat mode: add optional non-GitHub Started
identity/replay semantics, key scope/conflict rules, optional RPC argument and
release/database-cache prerequisites to the task-health contract; document this
backup's durable Started/Finished/Failed lifecycle, separate accepted-backup and
reporting obligations, strict status meanings and explicit new-operation recovery
after Failed. Preserve GitHub identity/timeout behaviour, existing dashboard
statuses, canonical backup/global-lock/checkpoint authority and low-log bounds.
No authoritative system_docs files were changed.
