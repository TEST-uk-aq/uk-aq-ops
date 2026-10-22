# Daily Task Health integration and release guide

Implementation evidence for [Ops PR #119](https://github.com/TEST-uk-aq/uk-aq-ops/pull/119)
and [TEST Schema PR #15](https://github.com/TEST-uk-aq/uk-aq-schema/pull/15).
Authoritative system documentation remains separate and read-only to coding agents.
A source merge never applies SQL. Real TEST application and acceptance are pending.

## Separate optional MBPro task

The local supervisor uses `ops.r2_history_dropbox_backup_mbpro`, named
**R2 history Dropbox backup (MacBook Pro)**, group `ops`, platform `MBPro`.
It is active and dashboard-visible. Daily-check and email inclusion are false;
scheduled/due times are NULL because each one-off is optional and explicitly
initiated. It must not become a missing scheduled task or satisfy the GitHub
backup's daily expectation. The existing GitHub task
`ops.r2_history_dropbox_backup`, platform, schedule, history and reporting are
unchanged. Existing local Integrity retains `ops.history_integrity` and its
one-argument Started contract. No GitHub execution metadata is fabricated.

The package reuses `workers/shared/daily_task_health.mjs`, existing lifecycle RPCs
and `buildHistoryBackupTaskSummary`. The GitHub-specific reporter and workflow,
canonical v3/pack/full backup, checkpoint recovery and global lock are unchanged.

## Caller UUID instead of another identity column

Canonical owner:
`TEST-uk-aq/uk-aq-schema:schemas/obs_aqi_db/uk_aq_daily_task_health_schema.sql`.
The existing unapplied PR migration is rewritten in place:
`schemas/migrations/20261021_003_obs_aqidb_daily_task_started_execution_identity.sql`.
Previously applied migrations, including GitHub idempotency, are untouched.

```text
uk_aq_public.uk_aq_rpc_daily_task_started(p jsonb, p_run_id uuid DEFAULT NULL)
RETURNS uuid
```

One durable operation UUID becomes the existing `daily_task_runs.id` and remains
`platform_run_id`. The supervisor saves it, the configuration fingerprint and
exact Started payload before requesting Started. The shared client forwards its
optional `run_id` input as top-level `p_run_id`; old callers omit it. An unmigrated
PostgREST server rejects this argument before mutation. Never fall back by dropping
it or by synthesising GitHub fields.

The primary key supplies uniqueness and a global UUID transaction lock serialises
creation/lookup across even conflicting task/repository claims. Matching replay
returns the same UUID after a committed-but-lost response, concurrent Started,
Finished or Failed. It never updates/reopens the factual row. Replay checks task,
source repo/worker, platform run ID, scheduled date, original Started timestamp and
any explicitly supplied attempt against existing columns. Explicit source/date/
start values are required; combining UUID and GitHub attempt identity is refused.
Task/date allocation is serialised for new runs. Terminal summary replacement
cannot erase the source/time/attempt columns used for identity.

This removes the proposed execution_identity JSONB column, constraint and unique
index from desired state and the unapplied migration. No new table or index is
needed. The configuration fingerprint still protects local source/target identity;
credentials may rotate without changing it, while target changes fail closed.

Without the optional UUID, the existing GitHub task/repo/platform-run/attempt
contract, distinct GitHub attempts and incomplete-identity insert semantics remain.
Local Integrity is unchanged. The new task registration follows existing manual
IFW conventions and does not rewrite the GitHub definition or health history.

## Durable local obligations and existing recomputation fix

The health record is version 2. It pins the operation UUID, configuration identity,
original UTC date/start time, MBPro provenance and exact input before Started.
Only a response equal to the operation UUID confirms Started; response/local-save
loss replays that UUID. Request budgets are saved before each request and retain
bounded retries/backoff across restart. Successful phases reset only their budget.
Automatic backup retries retain the same health run. An explicit `new` creates a
fresh operation UUID; a terminal Failed run cannot be reopened by `retry`.

Old unreleased version-1 health records are refused for review. Retain their
accepted-backup and reporting evidence; reconcile any prior task/server revision
rather than silently reassigning an existing factual run or deleting completion.

`successful_completion`/accepted reports and health delivery remain separate durable
facts. A zero locked exit and validated reports become durable before Finished is
queued. The exact terminal input keeps original timestamps, provenance, scheduled
date and report identity. A crash between accepted.json and active.json is recovered
by revalidating that invocation's reports/hashes/lock receipt. Reporting outage
cannot clear successful backup evidence or invoke the accepted backup again.

The existing **acbe964** recomputation fix is preserved. The client suppresses only
automatic terminal recomputation; its explicit recompute remains enabled. Terminal
confirmation is saved before the real `uk_aq_rpc_recompute_daily_task_status` call
for the original scheduled-for UTC date. Recompute becomes confirmed only after a
successful RPC response. Failed/lost responses retain that separate obligation;
recovery retries only outstanding health, never the accepted backup or an already
confirmed terminal update. Full operational confirmation still requires both.
Shared-client defaults and the pre-existing global recompute-disable switch retain
their behaviour. Normal local health traffic remains three RPCs per operation plus
bounded recovery requests, without polling or extra automatic recomputation.

Backup failure/exhaustion/cancellation queues factual Failed. A recoverable backup
interruption leaves Started. Reporting outage alone never replaces backup success
with Failed. Stop/uninstall retain unresolved health, which blocks discarding the
operation. Reconcile through the agent after review/reinstallation where necessary.

## TEST release order and manual apply

1. Review both PRs and merge TEST Schema source first through a separately
   authorised action. Confirm the earlier unmerged JSONB migration was not applied.
2. Apply the rewritten migration to **TEST ObsAQIDB** via its approved protected
   administrative connection, never the IngestDB/global-lock URL:

   ```bash
   PGSERVICE=REPLACE_WITH_APPROVED_TEST_OBSAQIDB_SERVICE psql -X -v ON_ERROR_STOP=1 \
     -f schemas/migrations/20261021_003_obs_aqidb_daily_task_started_execution_identity.sql
   ```

   Verify one defaulted `(jsonb, uuid)` Started signature, service-role-only execute,
   existing UUID primary key, no additional identity column/index and the MBPro
   definition flags above. Verify the GitHub definition is unchanged. The Schema
   [review/apply guide](https://github.com/TEST-uk-aq/uk-aq-schema/blob/codex/local-daily-task-started-identity/schemas/obs_aqi_db/README.daily_task_execution_identity.md)
   supplies exact read-only catalogue queries. The transaction notifies PostgREST
   to reload its schema; stale/unmigrated REST must reject safely. If an earlier
   PR revision was applied, stop for a separately reviewed transition.
3. Merge Ops and install dependencies plus the idle agent from a stable merged
   checkout using the exact Mac installation/status commands in README.md.
   Configure protected TEST-only R2/Dropbox, lock and independently pinned ObsAQIDB
   credentials. Configure the required protected `postgres_ca_file` and use
   `sslmode=verify-full` in the approved lock URL. Follow README's idle CA-update
   procedure for an existing installation; reinstalling does not start a backup
   or reset its operation/health. launchd supplies the validated CA path before
   Node starts, and backup children pin the same path. The REST settings are never
   inherited or inferred from the lock
   database, and health credentials never enter backup children. No new shared
   environment variable or env-sync target is introduced. LIVE remains inactive.
4. Through normal operator controls pause competing schedules, then initiate only
   authorised real TEST work. Verify the REST cache by the successful new argument,
   one UUID across restart/response loss, immutable dates/times, MBPro dashboard
   visibility and daily/email exclusion. Complete README acceptance, including
   accepted-backup/report-only recovery and actual recompute confirmation. Restore
   paused schedules after accepted completion. No merge, apply, installation or
   execution is performed as part of these source changes.

## Focused validation

Schema check (disposable PostgreSQL 16.2, isolated Unix socket, no TCP or remote
connection/credentials; stopped and removed afterwards):

```bash
python3 tests/check_daily_task_started_execution_identity.py --pg-bin /absolute/local/postgresql/bin
```

It checks canonical SQL, upgrade from the applied GitHub function, reapplication,
concurrent identical/conflicting UUID claims, discarded committed response,
Finished/Failed replay, every identity field, legacy GitHub/Integrity callers and
MBPro flags/daily-check exclusion. Only the optional pgcrypto packaging declaration
is skipped in the isolated bootstrap; the actual function/migration runs unchanged.
Directly relevant GitHub structural checks compare canonical/new migration SQL.

Ops `tests/local_history_backup_health.test.mjs` retains the accepted-backup/terminal
response-loss check and acbe964 real-client recompute check. The latter sends a
real shared-client request through injected fetch, persists HTTP 503 and lost
response failures, then confirms only on success, with zero backup calls and no
repeated Finished. Identity fixtures now use operation UUID = run UUID. A focused
real-client Started check rehydrates state after response loss and proves exact
UUID/date/time replay. Optional-argument/timestamp and legacy-argument forwarding
remain checked. Existing Daily Task Health checks plus syntax/whitespace checks
complete bounded pre-deployment validation. Real REST/launchd acceptance is pending.

## Rollback, future LIVE scope and system-doc handover

Stop the agent on runtime rollback and retain all accepted-backup and pending-health
records. Leave the backward-compatible UUID SQL and MBPro definition in place;
never delete factual runs/checkpoints or remap a pending MBPro run to GitHub. SQL
signature downgrade or older local-state rollback needs reviewed reconciliation.

After real TEST acceptance and separate explicit LIVE authorisation, promote the
complete identical application/dependency list in README.md, this canonical schema
owner and rewritten migration. Include validation sources for review; exclude TEST
archives and runtime/credential files. Independently apply/verify LIVE ObsAQIDB and
REST cache before runtime, review protected LIVE health/lock/R2/Dropbox identities,
use LIVE/config and explicitly authorise activation. Source promotion does not
apply SQL or activate an agent. No LIVE repository was inspected or changed.

Authoritative system-doc handover for Chat mode: record the optional MBPro task,
dashboard/daily/email flags, UUID-primary-key Started argument/replay/conflict rules,
unchanged GitHub/Integrity semantics, original dates/timestamps and durable terminal/
recompute obligations independent of backup acceptance. Include the acbe964
confirmation guarantees, version-1 review boundary, release/cache prerequisites and
real TEST evidence when available. Preserve global-lock/checkpoint, dashboard-status
and low-log authority. The owning backup contract is
`system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md`; add the
optional local lifecycle there and route it from that area's README as needed.
No authoritative system_docs files were edited.
