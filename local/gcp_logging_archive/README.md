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
  bounded `run-report.json`, including invocations rejected because the lock is
  held. Active phases emit a 15-second heartbeat. Log timestamps bearing `Z`
  are generated in UTC.
- Checkpoints carry a deterministic source fingerprint derived only from the
  TEST project ID and exact Cloud Logging filter. A missing or different
  fingerprint stops the run before retrieval instead of applying a cursor from
  different source coverage. Operational locations such as the run-evidence
  path do not affect the fingerprint.
- Checkpoints separately bind the stable `archive_id`, resolved raw archive
  destination, and exact redaction policy. This prevents a cursor from skipping
  history in a new/empty destination and prevents a changed sanitisation policy
  from merging incompatible fallback identities or leaving older sensitive
  values untouched.
- A separate `<archive_root>/GCP Logs/TEST/archive-identity.json` manifest binds
  the same source, archive destination and redaction identities to the archive
  itself. All three modes validate it before constructing the Cloud Logging
  client or changing daily files. The collector creates it with exclusive file
  creation only when the raw archive is genuinely empty; a non-empty archive
  without a manifest is rejected even when the state directory is new.

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

Edit every `REPLACE_WITH_...` value. `archive_id` is a stable, TEST-only
identity for this archive generation; do not reuse it for a separate rebuild.
`archive_root` is the explicitly selected
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

After changing `project_id` or `log_filter`, the old incremental and backfill
checkpoints intentionally fail source validation. Review the newly covered
history, stop the launchd job, and preserve the old evidence before restarting:

```bash
mkdir -p "$HOME/.local/state/uk-aq/gcp-logging-archive/test/retired"
mv "$HOME/.local/state/uk-aq/gcp-logging-archive/test/incremental.json" \
  "$HOME/.local/state/uk-aq/gcp-logging-archive/test/retired/incremental-before-filter-change.json"
mv "$HOME/.local/state/uk-aq/gcp-logging-archive/test/backfill.json" \
  "$HOME/.local/state/uk-aq/gcp-logging-archive/test/retired/backfill-before-filter-change.json"
local/scripts/run_gcp_logging_archive_test.sh backfill \
  --start SAFE_UTC_BOUNDARY --end FIXED_UTC_UPPER_BOUNDARY
```

Choose `SAFE_UTC_BOUNDARY` at or before the earliest time the added source may
contain retained logs. Omitting `--start` discovers the current retained
boundary instead. After the backfill succeeds, run incremental once and then
re-enable launchd. Moving checkpoints aside is deliberate; editing their
fingerprints to bypass validation is unsafe. To rewind without changing source
coverage, preserve a copy and move the relevant `*_through` timestamp backward
without changing the stored `source` object.

### Moving or re-sanitising an archive

For a path-only move with unchanged contents and redaction policy, stop
launchd, wait for Dropbox to finish, copy/move the complete `GCP Logs/TEST`
tree, verify daily file counts and hashes at the destination, change
`archive_root`, and preserve the manifest and checkpoints before updating only
their `archive.archive_path` values to the resolved new `GCP Logs/TEST/raw`
path. Keep the same `archive_id`, source and redaction identities in every
file. Run one overlapping incremental collection manually and
verify it before re-enabling launchd. Never point an existing checkpoint at an
empty or partial destination, and never delete the manifest to make a moved or
incompatible archive appear new.

A `redact_paths` change is intentionally incompatible, including a change that
only adds a sensitive path: fallback identities are calculated from the
redacted entry, and merging the new representation into old daily files could
retain the old sensitive representation as a second record. Perform a clean
historical re-sanitisation instead:

1. Stop launchd and leave the existing archive and state untouched as rollback
   evidence with access restricted.
2. Select a new empty Dropbox staging root, a new `archive_id`, and a new empty
   `state_dir`; retain the same TEST project/filter and configure the complete
   new `redact_paths` set.
3. Run a bounded historical backfill with a fixed end. Omit `--start` to record
   the actual retained boundary, or choose an earlier known-safe retained UTC
   boundary. This rebuild deduplicates fallback identities only after applying
   the new policy.
4. Validate gzip/JSONL integrity, entry/date coverage, the run report, and that
   prohibited fields are absent. Run one manual incremental collection.
5. Atomically rename the verified staging `GCP Logs/TEST` directory into its
   final Dropbox location on the same filesystem, update `archive_root` if
   needed, and apply the verified path-only manifest/checkpoint move procedure
   above.
6. Re-enable launchd, then securely delete the superseded archive only after
   the retention/rollback decision is approved.

Cloud Logging entries older than its retained boundary cannot be reconstructed
by that rebuild. If those old entries must be retained, do not weaken or bypass
the policy check: keep the old archive quarantined and use separately reviewed
offline re-sanitisation tooling before promotion. The collector deliberately
does not claim that removing a checkpoint fingerprint sanitises existing data.

Run one incremental collection with:

```bash
local/scripts/run_gcp_logging_archive_test.sh incremental
```

## Enable the hourly launchd job

The template does not contain a user name or machine path and does not alter
the existing dashboard or cloudflared jobs. Render and load it after the manual
incremental run succeeds. The renderer uses `plistlib`, rather than raw XML
text replacement, so repository paths containing `&` or other XML-sensitive
characters remain valid:

```bash
cd "/path/to/TEST-uk-aq-ops"
mkdir -p logs "$HOME/Library/LaunchAgents"
python3 local/scripts/render_gcp_logging_archive_launchd.py \
  local/launchd/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist.example \
  "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
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

If manifest creation is interrupted while initialising an empty archive, rerun
the same command: exclusive creation and directory syncing ensure the next run
either validates a complete manifest or safely creates it again. If manifest
validation fails, no retrieval or daily-file mutation has occurred. Restore the
matching configuration/manifest or follow the deliberate move/rebuild process;
do not remove the manifest or change identity fields merely to bypass the
failure.

`run-report.json` records the TEST project, source/filter fingerprint, archive
identity/destination, redaction paths/fingerprint,
source timestamp field and bounded query-window evidence, incremental overlap,
source/unique/new/duplicate counts, affected dates and files, bytes written,
resulting watermark, final status and exit code, and bounded error details. A
long backfill retains at most 100 detailed windows (and 100 files per window),
with aggregate totals, the omitted count, and the last omitted window retained
so the report cannot grow without bound. SIGTERM and keyboard interruption are
reported explicitly and retain their conventional exit codes; neither advances
a checkpoint for a window whose publication did not finish.

Uninstall only this TEST job:

```bash
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
rm "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.gcp-logging-archive.test.plist"
```

This stops future runs; it intentionally leaves archives, checkpoints, run
evidence, configuration, credentials, and the Python environment untouched.
