# MacBook Pro UK AQ scheduler watchdog

This package provides an environment-neutral trigger-source fallback for the UK
AQ D1-backed Cloudflare scheduler Workers. One installation protects TEST. A
separate installation can later protect LIVE using the exact same package.

`UKAQ_ENV_NAME` in the supplied watchdog env file selects the installation
identity. Supported values are `TEST` and `LIVE`, case-insensitively. TEST and
LIVE use separate LaunchAgent labels, installed code/configuration directories,
JSONL logs, stdout and stderr, so both can run on the same Mac.

The watchdog calls each Worker's authenticated `POST /run-if-due` endpoint once
per UTC minute. Calls to ingest and ops are independent. D1-backed Worker minute
claiming remains the authority for deduplication; this watchdog does not keep or
replace scheduler job state.

The preserved request contract is:

- `X-UK-AQ-Scheduler-Trigger` authentication;
- `Accept: application/json`;
- the UK AQ browser-style watchdog user-agent;
- HTTPS Worker URLs with automatic `/run-if-due` suffix handling;
- a 900-second request timeout;
- at most four in-flight calls per Worker;
- rotating local JSONL logging and controlled `SIGTERM`/`SIGINT` shutdown.

The operational offset is 30 seconds after each UTC minute.

## Package layout

```text
README.md
install_launchagent.sh
status_launchagent.sh
uk.co.ukaq.scheduler-watchdog.plist.template
uk_aq_scheduler_watchdog.py
uninstall_launchagent.sh
watchdog.env.example
watchdog_launchagent_common.sh
```

No file in this package contains a TEST or LIVE scheduler URL or trigger secret.

## Configuration boundary

Keep the watchdog env file outside the repository with mode `600`. It should
contain only:

```dotenv
UKAQ_ENV_NAME=TEST

UK_AQ_SCHEDULER_TRIGGER_SECRET=replace-with-dedicated-trigger-secret
UK_AQ_INGEST_SCHEDULER_URL=https://replace-with-ingest-scheduler-worker
UK_AQ_OPS_SCHEDULER_URL=https://replace-with-ops-scheduler-worker

UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS=30
UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS=900
UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER=4
```

Only the dedicated scheduler trigger secret and the two scheduler Worker URLs
belong in this configuration, in addition to the environment and watchdog
limits. Do not use or copy a broad `.env`, Cloudflare API credentials, D1
credentials, GitHub PATs, downstream dispatch secrets or unrelated service
secrets.

The shell scripts do not source or evaluate this file. They parse only the
single `UKAQ_ENV_NAME` assignment needed to derive installation identity. The
Python watchdog validates the complete file before installation without making
a network request.

## Derived installations

| Environment | LaunchAgent | Support/config/install directory | Log directory |
| --- | --- | --- | --- |
| TEST | `uk.co.ukaq.test-scheduler-watchdog` | `~/Library/Application Support/UK AQ/scheduler-watchdog-test` | `~/Library/Logs/UK AQ/scheduler-watchdog-test` |
| LIVE | `uk.co.ukaq.live-scheduler-watchdog` | `~/Library/Application Support/UK AQ/scheduler-watchdog-live` | `~/Library/Logs/UK AQ/scheduler-watchdog-live` |

Each support directory contains its own installed Python file and copied
`watchdog.env`. Each log directory contains its own `watchdog.jsonl`, launchd
stdout and launchd stderr.

## Prepare and install TEST

Create a protected source configuration outside both runtime installations:

```bash
WATCHDOG_CONFIG_DIR="$HOME/Library/Application Support/UK AQ/watchdog-configs"
TEST_WATCHDOG_CONFIG="$WATCHDOG_CONFIG_DIR/test.env"

mkdir -p "$WATCHDOG_CONFIG_DIR"
chmod 700 "$WATCHDOG_CONFIG_DIR"
cp scripts/mbpro_scheduler_watchdog/watchdog.env.example "$TEST_WATCHDOG_CONFIG"
chmod 600 "$TEST_WATCHDOG_CONFIG"
```

Edit that file as data, retain `UKAQ_ENV_NAME=TEST`, and replace only the secret
and Worker URL placeholders. Then install and inspect:

```bash
scripts/mbpro_scheduler_watchdog/install_launchagent.sh \
  --config "$TEST_WATCHDOG_CONFIG"

scripts/mbpro_scheduler_watchdog/status_launchagent.sh \
  --config "$TEST_WATCHDOG_CONFIG"

tail -f "$HOME/Library/Logs/UK AQ/scheduler-watchdog-test/watchdog.jsonl"
```

The installer validates the configuration and rendered plist before unloading
an existing job with the derived label. It then installs and starts the new
job. For TEST this safely replaces the existing
`uk.co.ukaq.test-scheduler-watchdog` label while pointing it at the new
environment-specific paths.

## Install LIVE later without affecting TEST

Use the same package with a separate protected env file:

```bash
LIVE_WATCHDOG_CONFIG="$WATCHDOG_CONFIG_DIR/live.env"
cp scripts/mbpro_scheduler_watchdog/watchdog.env.example "$LIVE_WATCHDOG_CONFIG"
chmod 600 "$LIVE_WATCHDOG_CONFIG"
```

Set `UKAQ_ENV_NAME=LIVE` and the LIVE-specific scheduler secret and URLs. Then:

```bash
scripts/mbpro_scheduler_watchdog/install_launchagent.sh \
  --config "$LIVE_WATCHDOG_CONFIG"
scripts/mbpro_scheduler_watchdog/status_launchagent.sh \
  --config "$LIVE_WATCHDOG_CONFIG"
```

The LIVE label and paths differ from TEST, so installing, inspecting or
uninstalling LIVE does not target the TEST installation.

## Uninstall one environment

Unload TEST while retaining its copied configuration and logs:

```bash
scripts/mbpro_scheduler_watchdog/uninstall_launchagent.sh \
  --config "$TEST_WATCHDOG_CONFIG"
```

After rollback/incident review is complete and the copied secret may be removed:

```bash
scripts/mbpro_scheduler_watchdog/uninstall_launchagent.sh \
  --config "$TEST_WATCHDOG_CONFIG" \
  --purge
```

`--purge` removes only the derived environment-specific support directory. Logs
remain available for review.

## Transition the currently installed TEST watchdog

The existing TEST installation uses the legacy generic runtime directories:

```text
~/Library/Application Support/UK AQ/scheduler-watchdog
~/Library/Logs/UK AQ/scheduler-watchdog
```

Repository code does not migrate or delete those directories. During TEST
maintenance, transition manually:

1. Prepare and verify the protected TEST env file described above.
2. Unload the old label:

   ```bash
   launchctl bootout \
     "gui/$(id -u)/uk.co.ukaq.test-scheduler-watchdog" 2>/dev/null || true
   ```

3. Install the generic package with `UKAQ_ENV_NAME=TEST`:

   ```bash
   scripts/mbpro_scheduler_watchdog/install_launchagent.sh \
     --config "$TEST_WATCHDOG_CONFIG"
   ```

4. Verify the new job and environment-specific log:

   ```bash
   scripts/mbpro_scheduler_watchdog/status_launchagent.sh \
     --config "$TEST_WATCHDOG_CONFIG"
   tail -f "$HOME/Library/Logs/UK AQ/scheduler-watchdog-test/watchdog.jsonl"
   ```

5. Retain the old generic support and log directories temporarily for incident
   review. Remove or move them to Trash only after the new TEST watchdog has
   demonstrated successful real operation.

The transition does not alter D1, Worker code, scheduler jobs or Cloudflare
configuration.
