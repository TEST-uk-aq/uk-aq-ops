# Daily Task Health UTC email (TEST, code-only staging)

## Reporting contract

- Run at 10:00 UTC daily, year-round. All dates and times in the email are labelled UTC.
- Main section: today's recorded runs with start time from 00:00 inclusive to 10:00 exclusive.
- Secondary section: yesterday's recorded runs from 10:00 inclusive to 24:00 exclusive, primarily later manual operations.
- Each section has Failed (red), Warnings (orange), Finished (green), in that order. Empty groups say None.
- Include all attempts within each window. A later successful attempt must not conceal an earlier failed attempt. Two WHO runs on the same day can both appear.
- Failed runs are red; Finished with a non-empty structured summary.warnings array, History Integrity failed-operation counters, and non-terminal statuses are orange; successful runs with no warnings are green.
- Today's section includes orange Missing alerts for active email-included scheduled tasks due by 10:00 with no qualifying recorded run. Manual-only tasks with no due threshold are not considered missing. Yesterday's later section includes actual runs only.
- This read-only digest does not alter Daily Task Health run or warning status semantics.

## Source and workflow

- Report generator: scripts/daily_task_health_email.py.
- Manually triggered GitHub Actions workflow: .github/workflows/uk_aq_daily_task_health_email.yml.
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

## Scheduler and acceptance (not activated)

Desired daily central Cloudflare scheduler dispatch: 10:00 UTC, with workflow inputs send_email=true and trigger_mode=scheduler. The current canonical scheduler manifest uses environment-specific repository names. Resolve that pre-existing configuration mechanism by injecting the execution environment's repository target rather than committing another hard-coded TEST/LIVE name.

Do not modify cloudflare/scheduler/jobs.toml without separate authorisation for the resulting automatic remote D1 sync. No cloud scheduler, GitHub secrets/variables or SMTP settings were changed by code-only staging.

After normal structural checks, execute a real TEST preview, inspect the generated artefacts against actual daily runs and check the warning/original status distinction. After TEST OAuth credentials and sender settings are provisioned and separately approved, carry out a genuine TEST send and inspect its arrival. Only then activate the 10:00 UTC schedule. Promotion is complete approved TEST files only; the user commits and deploys LIVE. No LIVE archive files.

Structural check: python3 -m py_compile scripts/daily_task_health_email.py.
Rollback: revert TEST code commits before activation; after activation disable the scheduler and/or set UK_AQ_HEALTH_EMAIL_SEND_ENABLED=false. Do not automatically resend if SMTP acceptance is ambiguous.
