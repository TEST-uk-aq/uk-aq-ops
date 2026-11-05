# Daily Task Health UTC email (TEST, code-only staging)

## Reporting contract

- Prepare two separate daily emails, **07:00 UTC** and **10:00 UTC** year-round (08:00/11:00 respectively during BST). All email dates/times and headings are explicitly UTC.
- **07:00 morning digest**, section 1: today's recorded runs started at 00:00 inclusive to 07:00 exclusive.
- **07:00 morning digest**, section 2 at the bottom: yesterday's actual runs started at 07:00 inclusive to midnight exclusive, including later manual operations.
- **10:00 supplement**: only today's recorded runs started from 07:00 inclusive to 10:00 exclusive. No yesterday section or repetition of today's earlier-window results.
- The 07:00–10:00 window will be present in the following morning's yesterday section too, as explicitly requested.
- Each section has Failed (red), Warnings (orange), Finished (green), in that order. Empty groups say None.
- Include all attempts within each window. A later successful attempt must not conceal an earlier failed attempt. Two WHO runs on the same day can both appear.
- Failed runs are red; Finished with a non-empty structured summary.warnings array, History Integrity failed-operation counters, and non-terminal statuses are orange; successful runs with no warnings are green.
- The first email checks expected morning runs due before 07:00, and the supplement checks expected runs due from 07:00 to before 10:00. Manual-only tasks without a due threshold are not treated as missing. Yesterday's section contains actual runs only.
- The existing task-definition schema holds only one scheduled time per task, so **WHO 2021 requires two independent expectations**. Parse the canonical `cloudflare/scheduler/jobs.toml` UTC WHO job schedule (currently `30 4,9 * * *`) to identify its **04:30** and **09:30** slots. The 07:00 digest must warn if no qualifying early WHO run started by 07:00, even if a second run later occurs. The 10:00 supplement separately warns if no qualifying 09:30 WHO run started before 10:00, even if the 04:30 run succeeded. Fail visibly if the WHO tracking definition or canonical schedule is absent or incompatible; never silently downgrade to one daily expected run.
- A recorded WHO run only satisfies its slot if it started no earlier than that slot and falls within the email's time window. The model cannot distinguish a delayed early dispatch from a later one when they overlap without per-slot producer metadata; keep that limitation explicit until such metadata exists.
- This read-only digest does not alter Daily Task Health run or warning status semantics.

## Source and workflow

- Report generator: scripts/daily_task_health_email.py.
- Manually triggered GitHub Actions workflow: .github/workflows/uk_aq_daily_task_health_email.yml.
- The workflow choice input `report_type` is `morning` (default, 07:00) or `supplement` (10:00). The script accepts `--report-type morning|supplement`. `--send` is additionally guarded against sending before that UTC report's cutoff.
- Authoritative read objects: uk_aq_ops.daily_task_runs_dashboard and uk_aq_ops.daily_task_definitions in the current environment's Obs AQI DB.
- Only active tasks with include_in_email=true are included. Query errors, missing credentials, absent task definitions and truncated results fail the report rather than inventing a green status.
- Manual workflow invocation defaults to preview-only. It saves private text and HTML artefacts for 14 days. No email or daily scheduler is activated by adding these files.
- Sending requires both a send_email=true workflow input and a persistent UK_AQ_HEALTH_EMAIL_SEND_ENABLED=true variable.

## GitHub Actions environment configuration (values never committed)

Existing: OBS_AQIDB_SUPABASE_URL (variable), OBS_AQIDB_SECRET_KEY (secret); optional UK_AQ_OPS_SCHEMA (variable, default uk_aq_ops).

New per-environment variables:
- UK_AQ_HEALTH_EMAIL_TO: the single approved recipient.
- UK_AQ_HEALTH_EMAIL_FROM: authorised Google Workspace sender mailbox.
- UK_AQ_HEALTH_EMAIL_SMTP_HOST: authorised SMTP relay hostname.
- UK_AQ_HEALTH_EMAIL_SMTP_PORT: 587.
- UK_AQ_HEALTH_EMAIL_SEND_ENABLED: false until a real TEST send is approved; true only after provisioning.
- GOOGLE_SMTP_USERNAME: authenticated Google Workspace mailbox.

Per-environment SMTP OAuth secrets, reusing the existing Media transport names where semantics match:
- GOOGLE_OAUTH_CLIENT_ID
- GOOGLE_OAUTH_CLIENT_SECRET
- GOOGLE_OAUTH_REFRESH_TOKEN (Google SMTP mail scope)

No Gmail connector or Gmail API is used. Outbound mail uses Google Workspace SMTP with STARTTLS and XOAUTH2. Maintain complete TEST/LIVE separation and never hard-code environment account, hostname, recipient or credential values in source. Update env-vars-master.csv and the environment-sync target mapping when provisioning these new names.

## Real TEST preview evidence (5 November 2026)

- [GitHub Actions run 42099301240](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/42099301240) completed successfully. The Python syntax and two WHO UTC slot check passed, followed by a real read-only TEST Obs AQI DB preview of both emails. The script was invoked without `--send`; its logs explicitly state that no email was sent.
- 07:00 digest, today 00:00–07:00 UTC: **0 failed, 2 warnings, 6 finished**. The warnings were Prune daily missing and Observations partition maintenance Finished with structured warnings. Yesterday 07:00–24:00 UTC: **0 failed, 0 warnings, 1 finished**.
- 10:00 supplement, today 07:00–10:00 UTC: **0 failed, 0 warnings, 1 finished** (the second WHO 2021 daily run).
- The one-off preview step was subsequently removed from the structural workflow to avoid reading the database on future code pushes. The structural workflow still compiles the Python file and checks both canonical WHO slots; it does not send mail.
- No real TEST SMTP submission, inbox arrival, sender authentication, installed GitHub Action variables, 07:00/10:00 scheduler dispatch, or LIVE promotion has been accepted.

## Scheduler and acceptance (not activated)

Desired **two independent central Cloudflare scheduler dispatches** at `07:00 UTC` (`report_type=morning`) and `10:00 UTC` (`report_type=supplement`), each with `send_email=true` and `trigger_mode=scheduler`. The current canonical scheduler manifest uses environment-specific repository names. Resolve that pre-existing configuration mechanism by injecting the execution environment's repository target rather than committing another hard-coded TEST/LIVE name.

Do not modify cloudflare/scheduler/jobs.toml without separate authorisation for the resulting automatic remote D1 sync. No cloud scheduler, GitHub secrets/variables or SMTP settings were changed by code-only staging.

After normal structural checks, execute a real TEST preview, inspect the generated artefacts against actual daily runs and check the warning/original status distinction. After TEST OAuth credentials and sender settings are provisioned and separately approved, carry out a genuine TEST send and inspect its arrival. Only then activate the 07:00 UTC and 10:00 UTC schedules. Promotion is complete approved TEST files only; the user commits and deploys LIVE. No LIVE archive files.

Structural check: python3 -m py_compile scripts/daily_task_health_email.py.
Rollback: revert TEST code commits before activation; after activation disable the scheduler and/or set UK_AQ_HEALTH_EMAIL_SEND_ENABLED=false. Do not automatically resend if SMTP acceptance is ambiguous.
