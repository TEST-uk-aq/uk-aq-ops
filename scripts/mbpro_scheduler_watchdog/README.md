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

Cloudflare Cron remains the normal primary trigger. The MacBook Pro watchdog
provides scheduling continuity when Cron does not claim a minute first.

The preserved request contract is:

- `X-UK-AQ-Scheduler-Trigger` authentication;
- `Accept: application/json`;
- the UK AQ browser-style watchdog user-agent;
- HTTPS Worker URLs with automatic `/run-if-due` suffix handling;
- a 900-second request timeout by default;
- at most four in-flight calls per Worker by default;
- a Cron-outage alert after ten consecutive takeover minutes by default;
- rotating local JSONL logging and controlled `SIGTERM`/`SIGINT` shutdown.

The default operational offset is 30 seconds after each UTC minute.

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

No file in this package contains a TEST or LIVE scheduler URL, trigger secret or
Dropbox OAuth secret.

## Configuration boundary

Keep the watchdog env file outside the repository with mode `600`. It should
contain only:

```dotenv
UKAQ_ENV_NAME=TEST

UK_AQ_SCHEDULER_TRIGGER_SECRET=replace-with-dedicated-trigger-secret
UK_AQ_INGEST_SCHEDULER_URL=https://replace-with-ingest-scheduler-worker
UK_AQ_OPS_SCHEDULER_URL=https://replace-with-ops-scheduler-worker

DROPBOX_APP_KEY=replace-with-dropbox-app-key
DROPBOX_APP_SECRET=replace-with-dropbox-app-secret
DROPBOX_REFRESH_TOKEN=replace-with-dropbox-refresh-token
UK_AQ_DROPBOX_ROOT=/TEST

UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS=30
UK_AQ_SCHEDULER_WATCHDOG_CRON_OUTAGE_THRESHOLD_MINUTES=10
UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS=900
UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER=4
```

The four watchdog limit settings are optional. Their defaults are a 30-second
offset, a 10-minute Cron-outage threshold, a 900-second request timeout and four
in-flight calls per Worker. The outage threshold must be a positive integer
number of minutes; because evidence uses one-minute slots, the same value is the
required number of consecutive watchdog takeovers.

In addition to the environment, scheduler trigger secret, Worker URLs and
watchdog limits, the watchdog needs the established Dropbox app key, app secret,
refresh token and environment-specific `UK_AQ_DROPBOX_ROOT`. Those four values
are used only to upload sustained Cron-outage errors through the central UK AQ
Dropbox error-log convention. Keep them in this dedicated protected file.

The four Dropbox settings are validated as one group: configure all four for
central outage reporting, or none. A partial group is rejected. If the group is
absent, scheduler continuity still runs and a detected outage produces a local
`scheduler_watchdog_dropbox_error_not_configured` event instead of stopping the
watchdog.

Do not use or copy a broad `.env`. Cloudflare API credentials, D1 credentials,
GitHub PATs, downstream dispatch secrets and unrelated service secrets do not
belong in the watchdog configuration.

The shell scripts do not source or evaluate this file. They parse only the
single `UKAQ_ENV_NAME` assignment needed to derive installation identity. The
Python watchdog validates the complete file before installation without making
a network request.

## Cloudflare Cron health detection

For ingest and ops independently, the watchdog reads the structured scheduler
response for each canonical `minute_slot`:

- `status: triggered` is definitive evidence that the watchdog supplied
  scheduling continuity for that minute;
- `claimed_trigger_source: cloudflare_cron` is definitive evidence that the
  normal Cloudflare Cron source claimed that minute;
- authentication, HTTP and network failures, malformed responses, and missing
  or unknown trigger-source information are not treated as evidence of a Cron
  outage. Missing minute slots remain unknown.

The retained 120-minute observation window is recomputed in chronological
minute-slot order whenever definitive evidence arrives. The configured number
of contiguous watchdog-claimed minute slots (ten by default) produces one
`scheduler_watchdog_cloudflare_cron_outage_detected` event in the local JSONL
and one remote Dropbox error record under:

```text
<UK_AQ_DROPBOX_ROOT>/error_log/YYYY-MM-DD/
```

The remote filename and JSON payload follow the existing UK AQ central
error-log convention. Each chronological outage interval has a stable identity,
so late observations can complete and report a historical interval without
creating duplicate reports. A later chronological minute definitively claimed
by `cloudflare_cron` means that interval is recovered, including when the
recovery response completed before a delayed takeover response. If qualifying
takeover runs are provisionally grouped across unresolved internal minute gaps,
recovery is withheld until later evidence establishes the chronological outage
boundaries. Recovery writes one `scheduler_watchdog_cloudflare_cron_recovered`
event to the local JSONL. The central error-log contract has no established
recovery record, so no Dropbox recovery file is created.

Responses are ordered by `minute_slot`, not completion time, so overlapping
requests that finish out of order cannot extend or reset the wrong sequence.
Dropbox reporting runs on its dedicated executor, separately from scheduler
requests. A failed upload is eligible for four bounded, progressively delayed
retries (after 2, 5, 15 and 30 minutes) as later scheduler observations arrive.
Every attempt reuses the original error UUID, creation time, payload and
overwrite path, so a retry is idempotent and does not create another logical
central error. A recovered historical outage remains eligible for its pending
report. Token or upload failure is logged locally and never stops or delays
future scheduling.

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

Edit that file as data, retain `UKAQ_ENV_NAME=TEST`, set the TEST Worker URLs,
dedicated scheduler trigger secret, established Dropbox OAuth values and TEST
`UK_AQ_DROPBOX_ROOT`, plus any non-default watchdog limits. Then install and
inspect:

```bash
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
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
environment-specific paths. To apply a later configuration change, edit the
protected source `.env` and rerun the same installer command. It validates and
copies that file, then restarts only the LaunchAgent selected by its
`UKAQ_ENV_NAME`.

## Install LIVE later without affecting TEST

Use the same package with a separate protected env file:

```bash
LIVE_WATCHDOG_CONFIG="$WATCHDOG_CONFIG_DIR/live.env"
cp scripts/mbpro_scheduler_watchdog/watchdog.env.example "$LIVE_WATCHDOG_CONFIG"
chmod 600 "$LIVE_WATCHDOG_CONFIG"
```

Set `UKAQ_ENV_NAME=LIVE`, the LIVE-specific scheduler secret, URLs and
`UK_AQ_DROPBOX_ROOT`, plus the appropriate established Dropbox OAuth values.
Then:

```bash
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
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

After rollback/incident review is complete and the copied secrets may be removed:

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
   PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
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
