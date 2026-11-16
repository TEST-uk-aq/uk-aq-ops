# Black Carbon Daily Task Health: TEST release and acceptance

This is an implementation handover, not an authoritative system contract.
No migration, deployment, reconciliation, publication or email was run during
implementation. All commands below are for the operator after source review.

## Registration and release order

1. Merge the companion TEST Schema PR first. Its canonical owner is
   `schemas/obs_aqi_db/uk_aq_daily_task_health_schema.sql`; the existing-database
   upgrade is `schemas/migrations/20261116_001_obs_aqidb_ukair_bc_daily_task.sql`.
2. In the updated TEST Schema checkout, use the approved **TEST ObsAQIDB**
   administrative connection, never IngestDB or a global-lock connection:

   ```bash
   PGSERVICE=REPLACE_WITH_APPROVED_TEST_OBSAQIDB_SERVICE psql -X -v ON_ERROR_STOP=1 \
     -f schemas/migrations/20261116_001_obs_aqidb_ukair_bc_daily_task.sql
   ```

3. Verify the installed definition and existing GitHub Started deduplication
   before merging Ops. The registration migration does not replace any RPC.
   If the existing Started RPC does not implement task/repository/platform-run/
   GitHub-attempt replay, stop and reconcile the approved schema prerequisites.

   ```sql
   select task_key, task_name, platform, is_active, include_in_daily_check,
          include_in_dashboard, include_in_email, scheduled_time_utc, due_time_utc,
          source_repo, source_workflow
   from uk_aq_ops.daily_task_definitions where task_key = 'ops.ukair_bc_daily';

   select p.oid::regprocedure, pg_get_functiondef(p.oid)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'uk_aq_public' and p.proname = 'uk_aq_rpc_daily_task_started';
   ```

   Expect one task named **UK-AIR Black Carbon daily**, platform `github`, all
   four active/inclusion flags true, schedule **08:00 UTC**, due **08:30 UTC**,
   and the combined workflow as its source. Existing GitHub identity support is
   supplied by the approved 20260929 Started-idempotency migration (and preserved
   by the later optional caller-UUID implementation); do not blindly apply old
   migrations just because source files exist. No REST schema reload is needed
   for a task-definition row.
4. Only then merge the Ops PR to TEST `main`. GitHub uses the merged workflow
   directly. No Worker, dashboard, email or scheduler deployment/config-sync is
   required. The existing enabled 08:00 Cloudflare job and 07:00/10:00 health
   emails stay unchanged. Coordinate the registration and Ops merge so a new
   daily expectation is not left without a reporter across the due time.

## Reporting behaviour and limits

- The start job reports Started with the real attempt's GitHub
  `run_started_at`. Finalisation calls the same idempotent Started RPC to recover
  its UUID, then the existing Finished or Failed RPC and daily recomputation.
  It never uses the insert-only final fallback or a previous job's cached UUID.
- The scheduled UTC date is the **original dispatch creation date**. A rerun
  after midnight keeps that date, while its actual start and activity window use
  the new attempt's timestamp. Fresh manual dispatches use their own creation
  date. The database's task/day attempt counter and `github_run_attempt` are
  separate counters; neither is overwritten or assumed equal.
- Finished requires both reusable jobs' results to be `success`. Failure,
  cancellation or a mandatory skip produces Failed if finalisation can run.
  The final job explicitly fails when either stage did not succeed. Reporting
  errors are strict job failures; a start-reporting outage does not stop the
  existing reconciliation/publication sequence. A successful later final report
  does not erase the earlier reporting job's GitHub failure.
- Failed-job reruns can reuse successful stage jobs and their outputs from a
  preceding attempt. Health records describe GitHub's effective `needs` results;
  they do not claim that every successful stage executed again in that attempt.
- `always()` requests finalisation after normal failures/cancellation. Forced
  cancellation, termination before a runner starts, runner loss, environment
  approval waits, API/credential outages and GitHub service interruption can
  prevent delivery. A delivered Started remains a non-terminal warning; if no
  event can be delivered the task may be Missing. No external reconciler is added.
- Both Cloudflare and operator launches currently use `workflow_dispatch` with
  no origin input. Event, actor, triggering actor, ref, SHA, ID, URL and attempt
  remain factual; timing/actor alone is not reliable manual/scheduler identity.
- Publication diagnostics contain `mode` (`full_bootstrap`, `incremental`,
  `no_op`, or the existing manual `forced_full_rebuild`), rebuild reason, rebuilt/
  reused month counts, `canonical_days`, `published`, result and source-through
  day. `canonical_days` retains the publisher's existing derivation-read metric;
  it is not a new count of every auxiliary R2 read. Rebuilt-month IDs, generation
  key, bytes, elapsed time and detailed failures stay in Actions logs. Failure
  before a publisher summary exists leaves only stage outcomes in health.
- Normal overhead is two GitHub attempt GETs and four small ObsAQIDB RPCs per
  combined run (Started, Started replay, terminal, recompute). Existing bounded
  retries allow at most sixteen RPC HTTP attempts per execution if all calls
  encounter transient errors. No polling or per-observation monitoring is added.

## Real TEST acceptance

Use representative real operations after the release order above. Retain run
URLs and read-only query results as evidence. Do not fabricate health rows or
change canonical data to simulate an outcome.

1. Observe the next **08:00 UTC Cloudflare dispatch**. In Actions, confirm
   health-started precedes reconciliation; reconciliation applies `bc,uv370` over
   14 days; publication starts only after reconciliation succeeds and retains
   `from_day=2024-01-01`. Confirm the repository-configured environment, existing
   concurrency groups, R2 safeguards and locks are unchanged.
2. While that run is genuinely processing, query TEST ObsAQIDB using the real
   run ID (psql `-v run_id=ACTUAL_GITHUB_RUN_ID` supplies the parameter):

   ```sql
   select id, task_key, scheduled_for_date, attempt, status, started_at,
          finished_at, failed_at, source_repo, platform_run_id, log_url, summary
   from uk_aq_ops.daily_task_runs
   where task_key = 'ops.ukair_bc_daily' and platform_run_id = :'run_id'
   order by attempt;

   select source_repo, platform_run_id, summary->>'github_run_attempt' as gh_attempt,
          count(*) as health_records
   from uk_aq_ops.daily_task_runs
   where task_key = 'ops.ukair_bc_daily' and platform_run_id = :'run_id'
   group by source_repo, platform_run_id, summary->>'github_run_attempt';
   ```

   Expect Started while processing, then **the same UUID** becomes Finished
   after both successes. Each GitHub attempt has exactly one row. Compare
   started_at with the GitHub attempt metadata, scheduled date with original
   dispatch creation, and summary/URL with the real workflow and attempt.
   Confirm reconciliation/publication outcomes and compact publisher fields.
3. Open the TEST Operations dashboard's Daily Tasks view for that UTC date and
   inspect **UK-AIR Black Carbon daily** and its summary/log link. Confirm Started
   during execution and Finished afterward. No new dashboard deployment is needed.
4. Observe the normal **10:00 UTC supplement** and have the operator inspect the
   received message. Finished is green, Failed red, and an actual Started run
   orange. A run still working at 10:00 must not be Missing. For a read-only
   report preview after the cutoff:

   ```bash
   gh workflow run uk_aq_daily_task_health_email.yml --repo TEST-uk-aq/uk-aq-ops \
     --ref main -f report_type=supplement -f send_email=false
   ```

   Inspect that run's private report artifact; do not resend SMTP mail. Actual
   activity belongs in [07:00,10:00) according to its start, not its configured
   schedule. Later manual acceptance runs appear in the following morning's
   Yesterday section. A preview generated later uses the then-current terminal
   status and does not reconstruct what a previously sent email saw.
5. Validate a genuine stage failure when one naturally occurs. If controlled
   failure acceptance is necessary, use the **existing pre-write environment
   guard** on a temporary TEST acceptance branch from merged main. No production
   inputs, secrets, canonical objects or public data need changing. For example,
   from a clean Ops checkout, choose `reconcile` or `publish` below:

   ```bash
   git fetch origin main
   git switch -c acceptance/bc-health-guard origin/main
   BC_HEALTH_FAILURE_STAGE=reconcile python3 - <<'PY'
   import os
   from pathlib import Path
   path = Path('.github/workflows/uk_aq_ukair_bc_daily.yml')
   text = path.read_text()
   stage = os.environ['BC_HEALTH_FAILURE_STAGE']
   assert stage in ('reconcile', 'publish')
   prefix, body = text.split('  ' + stage + ':\n', 1)
   old = '      environment: ${{ vars.UK_AQ_ENV_NAME }}'
   assert old in body
   body = body.replace(old, '      environment: HEALTH_ACCEPTANCE_INVALID', 1)
   path.write_text(prefix + '  ' + stage + ':\n' + body)
   PY
   git add .github/workflows/uk_aq_ukair_bc_daily.yml
   git commit -m "Exercise existing BC target guard for TEST health acceptance"
   git push -u origin acceptance/bc-health-guard
   gh workflow run uk_aq_ukair_bc_daily.yml --repo TEST-uk-aq/uk-aq-ops \
     --ref acceptance/bc-health-guard
   ```

   Reconciliation guard failure must precede source acquisition/canonical writes,
   publication must skip, and health must become Failed with those stage outcomes.
   Publication guard failure occurs after ordinary successful reconciliation but
   before publisher reads/writes; health must show reconciliation success and
   publication failure. The overall workflow must be red even when reporting
   succeeds. Never merge this acceptance branch. Return to main and delete the
   temporary remote branch after collecting evidence. Do not cancel a canonical
   writer or break credentials/data to force this check.
6. Check Missing at/after **08:30 UTC** on an actually unreported date, using the
   dashboard's existing daily-check path. Before 08:30 it is Not due. For an email
   check without suppressing a real scheduled job, preview a historical UTC date
   known to have no BC execution with `-f report_day_utc=YYYY-MM-DD` added to the
   preview command above. Expect one red Missing entry, no fabricated execution.
   Observe a genuinely long run across 08:30/10:00 when available; its Started
   record must prevent Missing. Do not manufacture a slow job or disable the
   scheduler. The unchanged email queries accept a qualifying same-scheduled-day
   run started before the **report cutoff**; 08:30 enables Missing expectations,
   it is not a permanent late-start violation. A start at 09:00 can therefore
   satisfy the 10:00 check. Older-scheduled-day recovery activity cannot satisfy
   today's expectation, even though it appears as actual activity.
7. Dispatch a genuine manual run when operationally appropriate:

   ```bash
   gh workflow run uk_aq_ukair_bc_daily.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   Use GitHub's normal rerun controls for an accepted run, including a failed-job
   rerun of a naturally failed **main** execution when available. Repeat the row
   queries: unchanged workflow run ID, distinct GitHub attempt and health UUID,
   no mutation of earlier attempt rows. A new manual dispatch gets a new GitHub
   run ID. Do not rerun the deliberately invalid acceptance branch expecting it
   to recover. Across-midnight reruns retain original scheduled date and appear
   in their actual execution window. Capture this evidence when such recovery is
   naturally needed rather than inventing retrospective records.
8. Inspect the real publisher output: bootstrap if needed, then incremental or
   verified no-op as canonical dependencies permit. Preserve all January 2024
   onwards months, sensor population, source-through date and public BC/UV/UVPM
   charts/API. No monitoring change touches publisher code, canonical writer,
   API or website. Do not force historical data corrections for acceptance.

## Rollback and authoritative documentation handover

Revert the Ops integration commit through a reviewed TEST PR first; the existing
08:00 pipeline continues without health reporting. Retain all factual run rows.
If withdrawing the daily expectation, use a separately reviewed TEST Schema
migration/canonical change setting `is_active=false`, `include_in_daily_check=false`
and `include_in_email=false` for this task. Do not delete a referenced definition
or history. The compatible shared-reporter changes can also be reverted with
the Ops commit. No R2 rollback or scheduler change is required. Archive files are
reference only; do not execute them. Do not blindly reapply the whole canonical
schema to roll back one registration.

Chat-mode handover: update the relevant Black Carbon source/history/derived
product documentation and Daily Task Health email/dashboard routing with the
combined identity, flags, 08:00 schedule/08:30 start threshold, Started/final
recovery and attempt/date rules, stage summary fields, strict reporting failures,
best-effort cancellation and unrecorded dispatch-origin limits. Record Schema
merge/application before Ops merge as separate gates and add real TEST evidence
only after acceptance. Reconcile the existing incremental-publication text that
still calls PR #199 behaviour future with its actual implementation status;
post-#199 latest BC reporting/location-count behaviour was preserved here.
No authoritative system documentation or LIVE repository was modified.
