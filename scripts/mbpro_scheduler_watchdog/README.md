# MacBook Pro TEST scheduler watchdog

This package is a TEST-only trigger-source fallback for the two D1-backed
Cloudflare scheduler Workers. It does not contain scheduler jobs, downstream
target URLs, D1 credentials, GitHub dispatch credentials, or Cloudflare API
credentials.

The persistent process calls each Worker’s authenticated `POST /run-if-due`
endpoint at UTC minute plus 10 seconds. It allows up to four in-flight requests
per Worker, with a 900-second request timeout. A capped local attempt is logged
and skipped; the next successfully claimed Worker run recovers from its last
finished scheduler evaluation window.

Each request explicitly sends `Accept: application/json` and the documented
UK AQ Scheduler Watchdog browser-style user-agent so Cloudflare Browser
Integrity Check does not reject Python urllib with error 1010.

## Local configuration

Create a file outside the repository, for example:

```bash
mkdir -p "$HOME/Library/Application Support/UK AQ/scheduler-watchdog"
chmod 700 "$HOME/Library/Application Support/UK AQ/scheduler-watchdog"
cp scripts/mbpro_scheduler_watchdog/watchdog.env.example \
  "$HOME/Library/Application Support/UK AQ/scheduler-watchdog/source-watchdog.env"
chmod 600 "$HOME/Library/Application Support/UK AQ/scheduler-watchdog/source-watchdog.env"
```

Set only the dedicated trigger secret and the two Worker URLs in that file. Do
not put a broad TEST `.env`, Cloudflare API token, D1 credential, GitHub PAT, or
downstream target secret in the file.

## Install and inspect

```bash
scripts/mbpro_scheduler_watchdog/install_launchagent.sh \
  --config "$HOME/Library/Application Support/UK AQ/scheduler-watchdog/source-watchdog.env"
scripts/mbpro_scheduler_watchdog/status_launchagent.sh
tail -f "$HOME/Library/Logs/UK AQ/scheduler-watchdog/watchdog.jsonl"
```

The installer copies only this package’s Python file and the supplied local
configuration, renders a plist without a secret, validates it with `plutil`, and
uses `launchctl bootstrap` plus `kickstart` for the current GUI user.

## Rollback

```bash
scripts/mbpro_scheduler_watchdog/uninstall_launchagent.sh
```

This retains configuration and logs for incident review. After rollback is
complete and the dedicated secret can be removed, use:

```bash
scripts/mbpro_scheduler_watchdog/uninstall_launchagent.sh --purge
```
