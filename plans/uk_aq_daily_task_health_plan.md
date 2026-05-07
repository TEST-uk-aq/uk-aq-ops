# UK-AQ Daily Task Health Plan

## Purpose

Create a simple daily scheduled task health system for UK-AQ.

The system records whether selected daily scheduled jobs have run correctly, computes an overall daily health status, supports dashboard calendar indicators, and eventually sends a daily email report.

This is intentionally not a full observability platform. It is a small operational health layer for daily scheduled tasks only.

## Core principles

- Store daily task status metadata in Supabase.
- Do not use R2 for v1 task status storage.
- R2 can remain the storage layer for backup files, manifests, and other large artifacts, but it is not part of this first version.
- Track scheduled daily tasks only.
- Ignore manual backfill runs.
- Ignore existing ingest run telemetry, because that is already visible elsewhere in the dashboard.
- Keep run statuses simple: `Started`, `Finished`, `Failed`.
- Keep daily calendar status separate from factual task runs.
- Allow manual day-level overrides without editing individual task run records.

## V1 daily tasks

The first checked daily tasks are:

| Task key | Display name | Platform | Repo / Area | Status |
|---|---|---:|---|---|
| `ops.prune_daily` | Prune daily | GCP | `uk-aq-ops` | Phase 2 completed |
| `ops.observs_partition_maintenance` | Observations partition maintenance | GCP | `uk-aq-ops` | Phase 2 completed |
| `ops.supabase_db_dump_backup` | Supabase DB dump backup | GCP | `uk-aq-ops` | Phase 2 completed |
| `ingest.stations_daily` | Stations daily | GitHub Actions | `uk-aq-ingest` | Phase 3 completed |
| `ops.r2_history_dropbox_backup` | R2 history Dropbox backup | GitHub Actions | `uk-aq-ops` | Phase 3 completed |

Additional daily tasks can be added later by inserting rows into `uk_aq_ops.daily_task_definitions`.

## Main data model

### `uk_aq_ops.daily_task_definitions`

Defines which daily tasks are expected and whether they count toward the daily health check.

Important fields:

- `task_key`
- `task_name`
- `platform`
- `is_active`
- `include_in_daily_check`
- `include_in_email`
- `include_in_dashboard`
- `scheduled_time_utc`
- `due_time_utc`
- `source_repo`
- `source_workflow`
- `source_service`

`scheduled_time_utc` is the configured scheduler or cron time.

`due_time_utc` is when the task should have reported by. This is especially important for GitHub Actions, because scheduled workflows do not always start exactly at the configured cron time.

### `uk_aq_ops.daily_task_runs`

Stores factual reports from each scheduled task invocation.

Run statuses:

- `Started`
- `Finished`
- `Failed`

Important fields:

- `task_key`
- `scheduled_for_date`
- `attempt`
- `status`
- `started_at`
- `finished_at`
- `failed_at`
- `duration_seconds`
- `summary`
- `error_message`
- `error`
- `source_repo`
- `source_worker`
- `platform_run_id`
- `log_url`

Retries are represented as additional attempts for the same `task_key` and `scheduled_for_date`.

The dashboard/reporting layer generally uses the latest attempt for each task/date.

### `uk_aq_ops.daily_task_status`

Stores the computed and optionally manually overridden status for each UTC calendar day.

Computed/final day statuses:

- `Unknown`
- `Pending`
- `Finished`
- `Failed`

Important fields:

- `date_utc`
- `computed_status`
- `final_status`
- `checked_task_count`
- `finished_task_count`
- `failed_task_count`
- `started_task_count`
- `not_due_task_count`
- `missing_task_count`
- `computed_summary`
- `override_status`
- `override_reason`
- `override_by`
- `override_at`

Rule:

```text
final_status = override_status if override_status is set
otherwise final_status = computed_status
```

Individual task runs remain factual. Manual overrides apply only to the day-level calendar/report status.

## Daily status computation

For a UTC day:

1. Load active task definitions where `include_in_daily_check = true`.
2. For each task, find the latest attempt for that day.
3. Classify the task:
   - no run and not yet due: not due
   - no run and due time passed: missing
   - latest run `Started`: started
   - latest run `Finished`: finished
   - latest run `Failed`: failed
4. Compute the day:
   - no checked tasks: `Unknown`
   - any failed or missing tasks: `Failed`
   - any started or not-due tasks: `Pending`
   - all checked tasks finished: `Finished`
   - otherwise: `Pending`
5. Apply override if set.

## Dashboard calendar behaviour

The dashboard calendar should read from `daily_task_status`, not from raw task runs.

### Month view

Top-right indicator in each day box:

- green tick if `final_status = Finished`
- red cross if `final_status = Failed`
- amber dot/spinner if `final_status = Pending`
- no marker if `final_status = Unknown`

### Year view

For today’s day box:

- show the same tick/cross/amber marker inside the box.

For other day boxes:

- green border if `final_status = Finished`
- red border if `final_status = Failed`
- amber border if `final_status = Pending`
- normal border if `final_status = Unknown`

### Day detail drawer/modal

When a calendar day is clicked, show:

- date
- computed status
- final status
- override status/reason if present
- task list with latest run per checked task
- started/finished/failed timestamps
- duration
- error message if present
- compact task summary JSON
- actions:
  - mark day as OK
  - mark day as failed
  - clear override

The UI should clearly show when a green status is manual rather than computed.

## Manual override behaviour

Manual override is for the overall day, not for individual runs.

Supported actions:

- set day to `Finished`
- set day to `Failed`
- clear override

A reason should be required when setting an override.

Example reasons:

- “Checked manually. Failure was from an obsolete task.”
- “GitHub Actions reported late but completed successfully.”
- “Known false alarm. Backup completed outside tracked workflow.”

## Email report plan

A daily email can be added after the dashboard/calendar layer.

Recommended v1 email behaviour:

- send once per day at around 10:00 UTC
- recompute today’s `daily_task_status` first
- use the same status logic as the dashboard
- include failed/missing tasks prominently
- include compact summaries for finished tasks

Example subjects:

- `✅ UK-AQ daily tasks OK — 2026-05-06`
- `❌ UK-AQ daily tasks failed — 2026-05-06`
- `⏳ UK-AQ daily tasks pending — 2026-05-06`

A later improvement could send the email as soon as all expected morning tasks have either finished or failed.

## Phase status

### Phase 1 — Schema, RPCs, definitions, documentation

**Status: Completed**

Scope:

- Add `daily_task_definitions`.
- Add `daily_task_runs`.
- Add `daily_task_status`.
- Add RPCs for started, finished, failed, final report, recompute, override, and range recompute.
- Seed initial task definitions.
- Add documentation.

Completed task keys prepared:

- `ops.prune_daily`
- `ops.observs_partition_maintenance`
- `ops.supabase_db_dump_backup`
- `ingest.stations_daily`
- `ops.r2_history_dropbox_backup`

### Phase 2 — Instrument GCP/ops workers

**Status: Completed**

Scope:

- Add shared daily task health helper in `uk-aq-ops`.
- Instrument:
  - `ops.prune_daily`
  - `ops.observs_partition_maintenance`
  - `ops.supabase_db_dump_backup`
- Report `Started`, `Finished`, and `Failed`.
- Recompute daily status after finish/fail.
- Keep reporting best-effort so health logging does not break the actual worker unless strict mode is enabled.

### Phase 3 — Instrument GitHub Actions scheduled tasks

**Status: Completed**

Scope:

- Instrument GitHub Actions workflows using final-only reporting.
- Report via `uk_aq_rpc_daily_task_report_final`.
- Recompute daily status after reporting.
- Instrument:
  - `ingest.stations_daily`
  - `ops.r2_history_dropbox_backup`

Relevant workflows already have `workflow_dispatch`:

- `uk-aq-ingest/.github/workflows/uk_aq_stations_daily.yml`
- `uk-aq-ops/.github/workflows/uk_aq_r2_history_dropbox_backup.yml`

Every `.yml` workflow in `uk-aq-ingest` and `uk-aq-ops` currently includes `workflow_dispatch`.

### Phase 4 — Dashboard calendar overlay and manual override UI

**Status: Planned**

Scope:

- Add daily task health markers to dashboard month/year calendar views.
- Add day detail drawer/modal.
- Add manual day-level override controls.
- Add API/RPC calls for date range, day detail, set override, clear override.
- Do not edit individual task runs from the dashboard.

### Phase 5 — Daily email report

**Status: Planned**

Scope:

- Add daily 10:00 UTC report sender.
- Recompute daily status before sending.
- Send email based on `final_status` and `computed_summary`.
- Add duplicate-send guard.
- Include failed/missing tasks and compact finished summaries.

### Phase 6 — Optional hardening and expansion

**Status: Planned / optional**

Possible future work:

- Add more daily scheduled tasks to `daily_task_definitions`.
- Add alerting if a task is missing after its due time.
- Add “send report early when all tasks are complete”.
- Add historical trend views.
- Add direct links from dashboard day detail to GitHub Actions logs and GCP logs.
- Add stricter validation of task definitions and due times.

---

# Codex prompt — Phase 4: Dashboard calendar overlay and manual override UI

```text
You are working on the UK-AQ dashboard/app repo.

Goal:
Implement Phase 4 of the daily scheduled task health system: dashboard calendar indicators, day detail view, and manual day-level overrides.

Phases 1, 2, and 3 are already completed.

Existing backend/database objects:
- uk_aq_ops.daily_task_definitions
- uk_aq_ops.daily_task_runs
- uk_aq_ops.daily_task_status
- RPCs for recompute and manual override
- views such as daily_task_status_calendar and daily_task_latest_runs, if present from Phase 1

Important scope:
Do NOT modify worker instrumentation.
Do NOT modify GitHub Actions reporting.
Do NOT add email reporting in this phase.
Do NOT use R2 for this feature.
Do NOT edit individual daily_task_runs from the UI.
Manual override is only for the day-level daily_task_status.

Feature requirements:

1. Calendar overlay

Add daily task health indicators to the existing dashboard calendar.

Month view:
- show a green tick in the top-right of the day box when final_status = Finished
- show a red cross in the top-right of the day box when final_status = Failed
- show an amber pending marker when final_status = Pending
- show no marker when final_status = Unknown or no record exists

Year view:
- for today’s day box, show the tick/cross/pending marker inside the empty day box
- for other days, use border colour:
  - green border for Finished
  - red border for Failed
  - amber border for Pending
  - normal border for Unknown/no record

Keep the UI subtle and consistent with the existing dashboard styling.

2. Data loading

Add an API/data access layer to fetch daily task status for a date range.

The dashboard should request the visible calendar range, for example:
- current month range for month view
- current year range for year view

Prefer using existing project API patterns.

The data should include at least:
- date_utc
- computed_status
- final_status
- checked_task_count
- finished_task_count
- failed_task_count
- started_task_count
- not_due_task_count
- missing_task_count
- override_status
- override_reason
- override_at
- computed_at

If a date has no row/status, treat it as Unknown.

3. Recompute before display where appropriate

For today’s date, call the recompute RPC before or during loading so the dashboard reflects missing/pending tasks accurately.

If there is already a range recompute RPC, consider using it only for the visible range when needed, but do not make the calendar slow.

A simple v1 is acceptable:
- recompute today on page load
- load statuses for visible range

4. Day detail drawer/modal

When a user clicks a calendar day, open a detail drawer or modal.

The detail view should show:
- date
- computed_status
- final_status
- whether the final status is manually overridden
- checked_task_count
- finished_task_count
- failed_task_count
- started_task_count
- not_due_task_count
- missing_task_count
- override_reason, override_by, override_at if present

Also show the task-level details for that day:
- task name
- task key
- platform
- due_time_utc
- latest attempt
- latest status
- started_at
- finished_at or failed_at
- duration
- error_message
- log_url if present
- compact summary if present

Use daily_task_status.computed_summary.tasks if that is available and sufficient.
Otherwise join/fetch from the latest-runs view/API created in Phase 1.

5. Manual override controls

Add admin-only controls in the day detail drawer/modal:

- Mark day as OK
- Mark day as failed
- Clear override

Rules:
- Mark day as OK should set override_status = Finished.
- Mark day as failed should set override_status = Failed.
- Clear override should remove override_status and return final_status to computed_status.
- A non-empty reason is required when setting an override.
- Show the reason and override timestamp once set.
- Do not hide computed failures when a day is manually marked OK. The UI should show both computed and final status.

Use existing auth/admin patterns in the dashboard.
Do not expose unsafe anonymous write access.

6. API/RPC integration

Use the existing Phase 1 RPCs:
- uk_aq_rpc_recompute_daily_task_status(p_date date)
- uk_aq_rpc_set_daily_task_status_override(p_date date, p_status text, p_reason text, p_override_by text)
- uk_aq_rpc_clear_daily_task_status_override(p_date date)

If the dashboard currently uses a backend API instead of direct Supabase RPCs, add server-side routes/endpoints that call these RPCs safely.

Suggested endpoints if needed:
- GET /api/admin/daily-task-status?from=YYYY-MM-DD&to=YYYY-MM-DD
- GET /api/admin/daily-task-status/YYYY-MM-DD
- POST /api/admin/daily-task-status/YYYY-MM-DD/override
- DELETE /api/admin/daily-task-status/YYYY-MM-DD/override

7. Visual status mapping

Use this mapping:

- Finished: green tick / green border
- Failed: red cross / red border
- Pending: amber dot or amber border
- Unknown: no marker / normal border

If the app has an existing icon set, use it.
If not, use simple accessible text/icons.
Include accessible labels such as:
- “Daily tasks finished”
- “Daily tasks failed”
- “Daily tasks pending”
- “Daily task status unknown”

8. Validation

Add or update tests if the repo has a test setup.
At minimum, document manual validation:

- Run GitHub workflows using workflow_dispatch:
  - uk_aq_stations_daily.yml
  - uk_aq_r2_history_dropbox_backup.yml
- Trigger/deploy/run the GCP workers as appropriate:
  - prune daily
  - observations partition maintenance
  - Supabase DB dump backup
- Query Supabase:
  select * from uk_aq_ops.daily_task_status where date_utc = current_date;
- Open dashboard calendar.
- Confirm today’s marker reflects final_status.
- Click the day.
- Confirm task details display.
- Mark day as OK with a reason.
- Confirm marker turns green and computed failure is still visible.
- Clear override.
- Confirm marker returns to computed status.

Expected deliverables:
1. Calendar overlay implementation.
2. Day detail drawer/modal.
3. Manual override controls.
4. API/data access updates.
5. Documentation update.
6. Final summary of files changed, assumptions, and validation steps.
```

---

# Codex prompt — Phase 5: Daily email report

```text
You are working on the UK-AQ ops/dashboard/backend repo, depending on where scheduled reporting jobs live in this project.

Goal:
Implement Phase 5 of the daily scheduled task health system: a daily email report around 10:00 UTC.

Phases 1, 2, 3, and ideally Phase 4 are already completed.

Existing database objects:
- uk_aq_ops.daily_task_definitions
- uk_aq_ops.daily_task_runs
- uk_aq_ops.daily_task_status
- daily status recompute RPC
- manual override RPCs

Important scope:
Do NOT change worker instrumentation.
Do NOT change GitHub Actions reporting.
Do NOT use R2 for this feature.
Do NOT create a complex alerting system yet.
This phase is only a simple daily report email.

Feature requirements:

1. Daily email timing

Send a report once per day at about 10:00 UTC.

Before sending:
- recompute daily task status for the current UTC date
- read daily_task_status for the current UTC date
- use final_status for the email subject/status
- include computed_status and override info if the day is manually overridden

2. Duplicate-send guard

Add a simple report-send ledger table if one does not already exist.

Suggested table:

uk_aq_ops.daily_task_email_reports

Columns:
- id uuid primary key default gen_random_uuid()
- date_utc date not null
- report_kind text not null default 'daily_task_health'
- recipient text not null
- status text not null
  Allowed values: Started, Sent, Failed
- started_at timestamptz not null default now()
- sent_at timestamptz
- failed_at timestamptz
- error_message text
- email_subject text
- email_provider_message_id text
- summary jsonb not null default '{}'::jsonb
- created_at timestamptz not null default now()
- updated_at timestamptz not null default now()

Add uniqueness to avoid duplicates:
- unique(date_utc, report_kind, recipient)

If this project already has a better email/report ledger pattern, follow that instead.

3. Email recipients/config

Use environment variables or existing project config.

Suggested env vars:
- DAILY_TASK_EMAIL_ENABLED=true
- DAILY_TASK_EMAIL_RECIPIENTS=comma,separated,list@example.com
- DAILY_TASK_EMAIL_FROM=optional@example.com
- DAILY_TASK_EMAIL_STRICT=false

Use the existing email provider/pattern in the project if one exists.
If no email provider is wired yet, implement the smallest project-consistent option and document required secrets.

4. Email content

Subject examples:

- ✅ UK-AQ daily tasks OK — YYYY-MM-DD
- ❌ UK-AQ daily tasks failed — YYYY-MM-DD
- ⏳ UK-AQ daily tasks pending — YYYY-MM-DD
- ❔ UK-AQ daily tasks unknown — YYYY-MM-DD

Body should include:

- date
- final status
- computed status if different
- override reason if present
- counts:
  - checked tasks
  - finished
  - failed
  - missing
  - started
  - not due
- failed tasks section
- missing tasks section
- pending/started tasks section
- finished tasks section with compact summaries

For each task include:
- task name
- task key
- platform
- latest status
- due time UTC
- started_at
- finished_at/failed_at
- duration
- error_message if present
- log_url if present
- a small summary of useful fields

Keep the email readable. Do not dump huge JSON.

5. Source data

Prefer using daily_task_status.computed_summary.tasks if it contains enough task detail.
Otherwise query the latest task runs view/API from Phase 1.

The email should use the same logic as the dashboard calendar so email and UI agree.

6. Scheduler

Implement this as the project’s preferred scheduled job mechanism.

Possible options:
- GCP Cloud Scheduler -> Cloud Run endpoint
- GitHub Actions scheduled workflow
- Supabase cron if already used for similar reports

Prefer the mechanism that is already used for ops scheduled workers.

The task key for this reporter, if it is itself tracked later, can be:
- ops.daily_task_email_report

However, do not include the email reporter in the checked daily task list unless explicitly configured later. Avoid circular reporting where the report task failing changes the report it is trying to send.

7. Failure behaviour

If email sending fails:
- record failure in the email report ledger
- log clearly
- do not alter the daily_task_status final_status

If DAILY_TASK_EMAIL_STRICT=true, allow the scheduled job to fail.
Otherwise, report/log the failure according to project conventions.

8. Manual/test mode

Add a safe way to test manually:

- date override, for example REPORT_DATE_UTC=YYYY-MM-DD
- dry-run mode, for example DAILY_TASK_EMAIL_DRY_RUN=true

Dry run should:
- recompute/load data
- render subject/body
- log or return the email content
- not send the email
- not mark report as Sent

9. Documentation

Update the daily task health doc.

Add:
- schedule time: 10:00 UTC
- config/env vars
- recipient setup
- how duplicate-send guard works
- how to dry-run
- how to manually resend if needed
- how the email relates to dashboard final_status

10. Validation

Manual validation:

- ensure today has daily_task_status data
- run in dry-run mode for today
- inspect rendered subject/body
- set a manual override for today and dry-run again
- confirm override is shown
- test a day with failed/missing tasks
- send to a test recipient
- confirm email report ledger records Sent
- rerun and confirm duplicate guard prevents accidental duplicate sends unless explicitly overridden

Expected deliverables:
1. Scheduled email report implementation.
2. Optional email report ledger migration if needed.
3. Email rendering logic.
4. Dry-run/manual test path.
5. Documentation update.
6. Final summary of files changed, env vars, scheduling mechanism, and validation steps.
```

---

# Useful validation queries

## Today’s task runs

```sql
select *
from uk_aq_ops.daily_task_runs
where scheduled_for_date = current_date
order by created_at desc;
```

## Today’s daily status

```sql
select *
from uk_aq_ops.daily_task_status
where date_utc = current_date;
```

## Latest runs for checked tasks

```sql
select *
from uk_aq_ops.daily_task_latest_runs
where scheduled_for_date = current_date
order by task_key;
```

## Calendar range

```sql
select *
from uk_aq_ops.daily_task_status_calendar
where date_utc between date '2026-05-01' and date '2026-05-31'
order by date_utc;
```

## Manually recompute today

```sql
select uk_aq_rpc_recompute_daily_task_status(current_date);
```

## Mark today as OK manually

```sql
select uk_aq_rpc_set_daily_task_status_override(
  current_date,
  'Finished',
  'Checked manually; day is OK.',
  'admin'
);
```

## Clear today’s override

```sql
select uk_aq_rpc_clear_daily_task_status_override(current_date);
```
