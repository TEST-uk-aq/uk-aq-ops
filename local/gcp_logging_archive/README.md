# TEST GCP Cloud Logging archive

This local-only collector reads retained TEST Cloud Logging entries and merges
them into Dropbox-synchronised, UTC event-date files:

```text
<archive_root>/GCP Logs/TEST/raw/YYYY/MM/YYYY-MM-DD.jsonl.gz
```

It does not change a Cloud Run service, scheduler, log sink, or retention
setting. The Google identity needs only `logging.logEntries.list` (normally the
`roles/logging.viewer` role) in the TEST project.

## Safety and data model

- Incremental reads use `receiveTimestamp`, a two-hour overlap by default, and
  a settling delay. Entries are still filed by their original `timestamp`, so a
  late entry is merged into its older event-day file.
- Backfill and manual ranges use bounded, half-open event-time windows. The
  client library consumes every API page. Backfill discovers the earliest
  matching retained entry when no start is supplied and records that real
  boundary in its report; it does not imply that expired history exists.
- An entry with `insertId` is identified by the hash of log name, resource, and
  insert ID. Otherwise a stable hash of the complete entry except
  `receiveTimestamp` is used. Existing and new records are merged by identity.
- Daily content is sorted by identity and gzip's variable timestamp is set to
  zero. Each replacement is written and synced beside its destination, then
  atomically renamed. A checkpoint advances only after every daily replacement
  for its window succeeds. Repeating a partially published window is safe.
- A non-blocking process lock separates concurrent invocations. Incremental
  and backfill checkpoints are also separate.
- Every invocation creates a unique run directory containing `run.log` and a
  bounded `run-report.json`. Active phases emit a 15-second heartbeat.

Cloud Logging fields are otherwise preserved, including structured payloads,
resource labels, severity, event/receive timestamps, trace/span data, and HTTP
metadata. The example configuration removes request URLs and common
application-level authorization, token, and password paths because URLs may
contain query secrets. Adapt `redact_paths` after inspecting the TEST logging
schema: paths are exact, case-sensitive dotted object paths. Redaction never
prints the removed value. Cloud Logging can contain application-specific
sensitive fields unknown to this repository; those must be added explicitly
before collection. Google credentials and the process environment are never
written to the archive or run evidence.

## Configuration and installation on the MacBook Pro

The repository establishes the Latest Snapshot default service name as
`uk-aq-latest-snapshot-builder`. It does not establish the TEST project ID or a
TEST ingestion Cloud Run service name. Obtain those values from the TEST GCP
configuration; do not copy LIVE values. Then:

```bash
cd "/path/to/TEST-uk-aq-ops"
python3 -m venv .venv-gcp-logging
.venv-gcp-logging/bin/python3 -m pip install -r local/gcp_logging_archive/requirements.txt
mkdir -p "$HOME/.config/uk-aq"
cp local/gcp_logging_archive/config.test.example.json \
  "$HOME/.config/uk-aq/gcp-logging-archive-test.json"
chmod 600 "$HOME/.config/uk-aq/gcp-logging-archive-test.json"
```

Edit every `REPLACE_WITH_...` value. `archive_root` is the explicitly selected
Dropbox root; the collector appends `GCP Logs/TEST/raw`. Keep `state_dir`
outside Dropbox so sync conflicts cannot become checkpoint authority. Keep
`run_evidence_root` separate from both the raw archive and checkpoints.

The filter is ordinary Cloud Logging filter syntax. Use parentheses when
adding services. A `cloud_run_revision` service filter includes application
stdout/stderr and Cloud Run request logs for those revisions, across all
severities. Only add operational services whose TEST identities have been
verified. The filter, paths, and credentials are TEST-specific and must never
be shared with LIVE.

Use Application Default Credentials without placing a key in the repository:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project TEST_PROJECT_ID
```

Grant the selected local identity read-only access out of band if it does not
already have it. Confirm the config without reading logs:

```bash
.venv-gcp-logging/bin/python3 -m json.tool \
  "$HOME/.config/uk-aq/gcp-logging-archive-test.json" >/dev/null
```

## Manual operation

Collect an explicitly bounded half-open UTC event-time range:

```bash
local/scripts/run_gcp_logging_archive_test.sh range \
  --start 2026-09-21T00:00:00Z --end 2026-09-22T00:00:00Z
```

Run the initial resumable historical backfill. Omitting `--start` discovers the
earliest matching retained entry and reports it; `--end` freezes the upper
boundary so a repeat has the same scope:

```bash
local/scripts/run_gcp_logging_archive_test.sh backfill \
  --end 2026-09-22T00:00:00Z
```

If interrupted, run the same command again. The cursor in
`<state_dir>/backfill.json` resumes at the first unpublished window. Never move
that cursor forward manually. It is safe to move it backward to deliberately
replay a window because publication deduplicates.

Run one incremental collection with:

```bash
local/scripts/run_gcp_logging_archive_test.sh incremental
```

## Enable the hourly launchd job

The template does not contain a user name or machine path and does not alter
the existing dashboard or cloudflared jobs. Render and load it after the manual
incremental run succeeds:

```bash
cd "/path/to/TEST-uk-aq-ops"
mkdir -p logs "$HOME/Library/LaunchAgents"
python3 -c 'import pathlib,sys; root=str(pathlib.Path.cwd()); print(pathlib.Path(sys.argv[1]).read_text().replace("__REPO_ROOT__", root))' \
  local/launchd/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist.example \
  > "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
plutil -lint "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
launchctl kickstart -k \
  "gui/$(id -u)/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test"
```

Check status and evidence:

```bash
launchctl print "gui/$(id -u)/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test"
tail -n 100 logs/gcp_logging_archive_test_launchd.log
find "$HOME/Library/Logs/UK-AQ/gcp-logging-archive/test/runs" -name run-report.json -print | tail
gzip -cd "DROPBOX_ROOT/GCP Logs/TEST/raw/YYYY/MM/YYYY-MM-DD.jsonl.gz" | head
```

After installation, confirm that a successful run advances
`incremental.json`, produces valid gzip JSONL under the expected UTC dates,
contains both `run.googleapis.com/requests` and structured application entries
where the filter matches them, and does not contain known secrets. Compare a
small bounded interval's count and timestamps with the Cloud Logging console.
Confirm an overlapping second run adds no duplicates.

For a failed/interrupted run, inspect its report and log, correct the cause
(credentials, filter, disk space, Dropbox availability), and rerun. The old
checkpoint causes the entire incomplete interval to be safely replayed. A
stale `collector.lock` file is harmless; the operating-system lock ends with
the process. Do not delete or advance checkpoints merely because a daily file
was already replaced.

Uninstall only this TEST job:

```bash
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
rm "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
```

This stops future runs; it intentionally leaves archives, checkpoints, run
evidence, configuration, credentials, and the Python environment untouched.
