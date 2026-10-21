# Daily Task Health integration investigation

Status: prerequisite identified; integration not implemented. This document is
implementation evidence for PR #119, not a new authoritative RPC contract.

## Existing mechanisms inspected

The local job must keep the existing task key
`ops.r2_history_dropbox_backup`. No new task definition, service, table or dashboard
status is needed. Existing run rows can represent local execution through
`source_repo`, `source_worker`, `platform_run_id` and structured `summary` without
pretending to be a GitHub Actions run. The definition's platform is task-level
metadata; changing it would also affect ordinary GitHub executions of this same
task. Per-run local provenance belongs in the existing fields/summary.

Source inspection covered:

* `workers/shared/daily_task_health.mjs`: existing JavaScript lifecycle client.
  It accepts explicit service configuration, strict delivery, source/worker/run
  identity and a scheduled-for UTC date. It does not provide durable identity
  storage or restart orchestration. It currently does not forward explicit
  Started/Finished/Failed event timestamps through its normal payload builder,
  or provide a per-RPC timeout/retry policy. Its default soft-failure behaviour
  is unsuitable for mandatory reporting; a local integration must opt into
  strict confirmation and bounded delivery.
* `scripts/report_daily_task_health.mjs`: the GitHub-oriented reporter has a
  15-second attempt timeout and bounded transient retries. Its Started retry
  predicate requires task, source repo, platform run and
  `summary.github_run_attempt`. It constructs GitHub metadata; invoking that
  entrypoint with invented GitHub values is not a local integration.
* `scripts/backup_r2/build_history_backup_task_summary.mjs`: the exported
  `buildHistoryBackupTaskSummary` can be reused for stage timings and observation
  Parquet-copy summary. It is supplemental evidence, not completion authority.
* The local v3 Integrity wrapper, repository runner and Python coordinator:
  `scripts/uk-aq-history-integrity/deploy-bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh`,
  `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py`,
  and the corresponding v2 coordinator. Their local health calls use the same
  public-schema Started, Finished, Failed and recompute RPCs, configured through
  `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY`. The v3 coordinator uses a
  genuine environment/timestamp platform identity, holds the returned health UUID
  in its process and adds optional invocation-owned launchd metadata. The wrapper
  is a one-off job with no automatic restart policy. Its health path does not
  establish durable exactly-once Started recovery across a lost response/reboot.
  When no health UUID is available, its terminal fallback uses `report_final`,
  which inserts another factual row; that fallback cannot satisfy this task's
  no-duplicate requirement.

These findings confirm that local reporting already exists. The discrepancy is
the stronger durable automatic-restart guarantee required by the backup, rather
than absence of local Daily Tasks support.

## Exact blocking boundary

The canonical owner is
`TEST-uk-aq/uk-aq-schema:schemas/obs_aqi_db/uk_aq_daily_task_health_schema.sql`.
The current online source was checked as well as the workspace copy; the reviewed
file's Git blob identity is `57e6a6509163f485da5bc6f676485a78d6a7c5ea`.

`uk_aq_public.uk_aq_rpc_daily_task_started(p jsonb)` deduplicates only when all of
the following are nonempty:

```text
task_key
source_repo
platform_run_id
summary.github_run_attempt
```

It serialises that exact tuple and returns its existing UUID. Without the GitHub
attempt member, it allocates another date-level attempt and inserts a row with a
database-generated UUID. A stable local `platform_run_id` alone does not activate
deduplication. The current RPC does not accept a caller-selected health UUID as
its insert/replay identity. Merely saving the returned UUID locally leaves this
unsafe window:

```text
Started commits remotely
  -> response is lost, or process dies before saving its returned UUID
  -> next launch has no confirmed UUID
  -> repeating Started creates another logical run
```

The active backup contract explicitly says callers without complete supported
start identity must retain non-idempotent start semantics and must not acquire
blind retries. Populating `github_run_attempt` for launchd would misrepresent the
execution source and is not an acceptable workaround. The existing
`uk_aq_rpc_daily_task_report_final` also inserts a new row, so it cannot repair
this ambiguity safely.

Finished/Failed target an existing `p_run_id`; repeating the same exact terminal
payload does not create another run. Recompute is also repeatable. Those RPCs
support the intended terminal obligations once the correct health UUID can be
recovered safely. Their summaries replace the existing summary, so correlation
and source metadata must be included in every terminal payload. Explicit fixed
event timestamps must be preserved when replaying to avoid shifting the factual
completion time.

## Required dependency and bounded scope

The next implementation needs a reviewed extension of the **existing** Started
RPC to support a genuine non-GitHub execution/replay identity, returning the same
health UUID after an ambiguous response and after terminal completion without
reopening the run. That extension must reject conflicting identity reuse and
preserve existing GitHub callers and their current deduplication behaviour.
This document does not prescribe an unimplemented wire field as an active
contract or create an ops-local replacement RPC.

Any approved SQL change belongs in the canonical owner above and a matching
dated existing-database migration under `uk-aq-schema/schemas/migrations/`.
Required pre-change archives belong in each owning repository. It must not be
implemented solely in Ops, applied to a database here, or silently added as a
new task-health mechanism. Schema source publication and database application are
separate release steps. No schema source or database was changed in this
investigation.

After that contract is approved, the bounded Ops integration should:

1. Reuse the shared lifecycle client, adding only the explicit payload/timeout
   support it needs. Keep the GitHub workflow/reporter behaviour unchanged.
2. Add the existing `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY` settings to
   the protected local configuration, with an independently reviewed ObsAQIDB
   identity pin and no inherited/cross-environment fallback. The lock's direct
   `SUPABASE_DB_URL` is not the health REST endpoint or credential. Never send
   health credentials to backup children or put them in the plist/logs.
3. Persist operation-correlated health identity, original UTC scheduled-for date
   and event timestamps before sending Started. Confirm Started before entering
   the protected backup; keep temporary failures/restarts within that same run.
4. Continue to accept the full current invocation's canonical reports and locked
   exit first. Persist accepted backup completion and a separate terminal health
   obligation before calling Finished. A health outage must retry only that
   obligation/recompute, never the completed R2/Dropbox work.
5. Persist the exact terminal payload and its confirmation, bound reporting
   retries and expose unresolved obligations through the existing local circuit
   breaker. A launchd zero exit must not imply health confirmation. Preserve
   pending obligations when stopping or initiating a later operation.
6. Distinguish retryable backup interruptions from genuinely terminal failure;
   use only existing Started/Finished/Failed statuses remotely. Local status
   should expose backup running/retrying/blocked and completed-with-health-pending
   versus completed-with-health-confirmed using durable evidence.
7. Reuse the supplemental-summary builder and include safe execution source,
   environment, operation UUID, attempt count, generation/mode, accepted report
   identity, verified source/processed-root results and factual timestamps. Do
   not include credential paths or fabricate GitHub run/workflow/URL metadata.

## Validation and release order

Before runtime changes, the genuinely necessary targeted boundary check is a
deterministic lost-Started-response/restart check: one local identity must resolve
to one health UUID, including concurrent replay, with conflicting/stale identities
rejected. A second focused recovery check must establish that a failed terminal
health update after durable backup completion never invokes the backup again.
Use local mocks or the appropriate existing deterministic checks; do not call
real ObsAQIDB RPCs or run speculative suites during implementation.

Release order is: review canonical RPC/client changes; merge the authorised TEST
source changes; separately apply the canonical TEST ObsAQIDB migration and confirm
the required contract; install the integrated TEST package with protected health
configuration; then perform an otherwise authorised real TEST backup and inspect
Started/Finished/Failed, original scheduled date, source metadata, pending-report
recovery and no extra backup after completion. Interrupted-response/reboot
acceptance must confirm that a second logical health row is not created. The
existing operator README's install/status commands remain valid for the original
backup-only package, but are not proof of this health lifecycle.

The current eleven-file local package promotion list remains the scope of the
original implementation. A complete future LIVE health-enabled promotion list
must additionally enumerate the actual shared-client/integration files and the
canonical schema/migration once approved; that list cannot honestly be finalised
before those dependencies exist. Preserve TEST/LIVE application-code equality,
review separate LIVE ObsAQIDB configuration, and require separate authorisation
for LIVE source promotion, database application, installation and execution.

Rollback of this investigation is documentation-only. No implementation, backup,
lock, checkpoint, restore, workflow, 345-minute GitHub timeout or scheduler setting
was changed. Chat-mode system-doc handover: decide and document the generic
Started identity/replay contract and release dependencies before treating the
local health integration as accepted. Active `system_docs/` remains unchanged.
