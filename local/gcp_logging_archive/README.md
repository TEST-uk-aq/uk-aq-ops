# GCP Cloud Logging archive (TEST and LIVE)

One collector and runner serve either environment. The runner reads exactly one
`UK_AQ_ENV_NAME` assignment from an explicitly supplied ingest-repository
`.env`; only the exact values `TEST` and `LIVE` are accepted. It does not source
the file, infer an environment, or fall back between environments. It then uses
only that environment's runtime tree, config, lock, state, evidence and Google
credential file.

LIVE support here is structural only. Deploy and accept TEST first; do not load
the LIVE launchd job until the LIVE acceptance steps below are complete.

## Layout and invariants

The deployed runtime parent is `/Users/mikehinford/uk-aq-gcp-logging-archive`:

```text
/Users/mikehinford/uk-aq-gcp-logging-archive/
  TEST/
    config.json
    credentials/google-application-credentials.json
    state/{collector.lock,incremental.json,backfill.json}
    runs/<UTC timestamp>_<mode>_<unique suffix>/{run.log,run-report.json}
    logs/launchd.log
  LIVE/                         # separate files with the same shape
```

The runtime trees never share mutable files. The runner exports only the
selected tree's credential path as `GOOGLE_APPLICATION_CREDENTIALS`; it does
not use a switched global Application Default Credentials login. Provision each
read-only Google credential out of band, store it at the path above, and use
restrictive directory/file permissions. Never commit credentials or put them
in Dropbox.

Raw archives stay at these existing/declared destinations:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/GCP Logs/
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/GCP Logs/
```

Each contains `archive-identity.json` and
`raw/YYYY/MM/YYYY-MM-DD.jsonl.gz`. The collector's data, deduplication,
redaction, pagination, pacing/backoff, atomic publication, watermark and
failure semantics are unchanged. The manifest binds environment, source,
archive and redaction identity. Checkpoints also require their environment and
all identity fields to match before a Cloud Logging client is created.

`config.json` owns the environment-specific `environment`, `project_id`, exact
`log_filter`, stable `archive_id`, absolute `archive_path`, read/retry controls,
overlap/settling controls and exact redaction paths. Copy
`config.example.json` separately into each runtime tree and replace every
placeholder. Do not derive LIVE values from TEST. State and run paths are not
configurable: the runner/collector derive them from the selected runtime tree.

## Python installation

From the appropriate local ops checkout:

```bash
python3 -m venv .venv-gcp-logging
.venv-gcp-logging/bin/python3 -m pip install -r local/gcp_logging_archive/requirements.txt
```

## Migrate the deployed TEST runtime

The existing TEST generation is authoritative and must not be reinitialised.
Keep the old runtime material until the migrated TEST run is accepted.
Substitute the actual old paths below if they differ, and inspect before every
copy:

1. Stop the old job and verify it is not running:

   ```bash
   launchctl bootout "gui/$(id -u)" \
     "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist"
   launchctl print "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.test" || true
   ```

2. Create the isolated tree without deleting old evidence:

   ```bash
   install -d -m 700 /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/{state,runs,logs,credentials}
   install -m 600 "$HOME/.config/uk-aq/gcp-logging-archive-test.json" \
     /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/config.json
   cp -a "$HOME/.local/state/uk-aq/gcp-logging-archive/test/." \
     /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/state/
   cp -a "$HOME/Library/Logs/UK-AQ/gcp-logging-archive/test/runs/." \
     /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/runs/
   cp -p /path/to/old/launchd.log \
     /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/logs/launchd.pre-migration.log
   ```

3. Edit only the configuration shape: add `"environment": "TEST"`; replace
   `archive_root` with the already-effective absolute
   `archive_path` `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/GCP Logs/raw`;
   remove old `state_dir` and `run_evidence_root`. Preserve the exact existing
   project, filter, `archive_id`, pacing, overlap/settling and redaction values.

4. Review each copied `incremental.json` and `backfill.json`. Add the top-level
   `"environment": "TEST"` explicitly if absent, without changing its source,
   archive, redaction, `receive_through`/`event_through`, timestamps or run ID.
   This reviewed additive migration binds old state to TEST; the collector will
   not silently repair a missing/mismatched environment. Confirm the checkpoint
   `archive.archive_path` and existing Dropbox `archive-identity.json` already
   identify the same TEST raw path. If not, stop and follow the contract's
   separately verified path-relocation procedure—never edit identity merely to
   pass validation.

5. Provision the TEST read-only Google credential as
   `TEST/credentials/google-application-credentials.json` (mode 600), validate
   JSON/config locally, then run one real TEST incremental manually. Do not
   move or recreate the Dropbox archive.

After TEST acceptance, retain the old files as rollback/history evidence until
the operator approves retirement. They are no longer active and the new code
writes nothing beneath `~/Library/Logs/UK-AQ`, `~/Library/Logs/UK AQ`,
`~/.config/uk-aq`, or `~/.local/state/uk-aq/gcp-logging-archive`.

## Manual operation

Every command explicitly supplies the corresponding ingest `.env` and common
runtime parent. Examples for TEST:

```bash
RUNNER=local/scripts/run_gcp_logging_archive.sh
COMMON=(--env-file /absolute/path/to/TEST-uk-aq-ingest/.env \
        --runtime-root /Users/mikehinford/uk-aq-gcp-logging-archive)
"$RUNNER" "${COMMON[@]}" incremental
"$RUNNER" "${COMMON[@]}" range \
  --start 2026-09-21T00:00:00Z --end 2026-09-22T00:00:00Z
"$RUNNER" "${COMMON[@]}" backfill --end 2026-09-22T00:00:00Z
```

Backfill without `--start` discovers the earliest retained matching entry.
Reuse the same fixed end after interruption. Range remains manifest-protected
and does not advance a checkpoint. A held environment lock exits immediately
with bounded evidence; TEST and LIVE locks are independent.

Inspect status without exposing credentials:

```bash
launchctl print "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.test"
tail -n 100 /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/logs/launchd.log
find /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/runs \
  -name run-report.json -print | tail
python3 -m json.tool /Users/mikehinford/uk-aq-gcp-logging-archive/TEST/state/incremental.json
```

Each run report records the selected environment, project/filter fingerprint,
archive/redaction identity, bounded window/count/file evidence, watermark,
status and exit code. Logs/reports are diagnostic, not checkpoint authority.

## Render and install the TEST launchd job

Both environment labels ultimately use the same template and generic runner,
with `RunAtLoad=true` and `StartInterval=86400`. During TEST deployment, create
only TEST runtime directories and render only the TEST plist from the TEST ops
checkout. Do not create a LIVE runtime tree or render a LIVE plist at this
stage:

```bash
TEMPLATE=local/launchd/uk.co.ukaq.gcp-logging-archive.plist.template
RUNTIME=/Users/mikehinford/uk-aq-gcp-logging-archive
mkdir -p "$HOME/Library/LaunchAgents" "$RUNTIME/TEST/logs"
python3 local/scripts/render_gcp_logging_archive_launchd.py "$TEMPLATE" \
  "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist" \
  --environment TEST --ingest-env-file /absolute/path/to/TEST-uk-aq-ingest/.env \
  --runtime-root "$RUNTIME"
plutil -lint "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist"
```

After the manual TEST run succeeds, explicitly enable the TEST label in case a
persistent launchctl disabled override exists, then bootstrap it:

```bash
launchctl enable "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.test"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist"
```

Observe the invocation started by `RunAtLoad`; do not immediately use
`kickstart -k`, because that can kill and restart the incremental collection
which bootstrap just started. To deliberately force an already-loaded TEST job
to run immediately at some later time, use this separate operator command:

```bash
launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.test"
```

To stop/uninstall TEST without affecting LIVE, boot it out and remove its
installed plist:

```bash
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist"
rm "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.test.plist"
```

This ordinary stop/reinstall flow leaves the label enabled and leaves runtime
state, evidence, credentials and Dropbox data intact. Only when the operator
intends TEST to remain persistently disabled should they additionally run:

```bash
launchctl disable "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.test"
```

## TEST acceptance and later LIVE promotion

On the MacBook Pro, confirm the real TEST incremental run selects TEST only,
merges expected structured/request logs, advances its checkpoint only after
publication, produces valid deterministic gzip JSONL, excludes configured
sensitive fields and is idempotent across an overlapping bounded replay.
Confirm a deliberate manifest/checkpoint mismatch fails before source access.
Rollback is: stop the new job, preserve its tree, reinstall the old plist/code,
and point only the old runner at the untouched old runtime; never roll back a
watermark by inventing identity values.

Only after real TEST acceptance, copy this bounded implementation set to the
local LIVE ops repository:

```text
local/gcp_logging_archive/collector.py
local/gcp_logging_archive/config.example.json
local/gcp_logging_archive/requirements.txt
local/gcp_logging_archive/README.md
local/scripts/run_gcp_logging_archive.sh
local/scripts/render_gcp_logging_archive_launchd.py
local/launchd/uk.co.ukaq.gcp-logging-archive.plist.template
```

Do not copy system documentation. From the local LIVE ops checkout, create only
the LIVE runtime directories and give LIVE its own config, new/stated archive
identity, empty appropriate state and read-only credential. Render the LIVE
plist there, explicitly using the LIVE ops checkout as `--repo-root` and the
LIVE ingest repository `.env` as its environment source:

```bash
cd /absolute/path/to/LIVE-uk-aq-ops
TEMPLATE=local/launchd/uk.co.ukaq.gcp-logging-archive.plist.template
RUNTIME=/Users/mikehinford/uk-aq-gcp-logging-archive
install -d -m 700 "$RUNTIME/LIVE"/{state,runs,logs,credentials}
# Provision LIVE/config.json and the mode-600 LIVE credential before collection.
python3 local/scripts/render_gcp_logging_archive_launchd.py "$TEMPLATE" \
  "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.live.plist" \
  --environment LIVE --ingest-env-file /absolute/path/to/LIVE-uk-aq-ingest/.env \
  --runtime-root "$RUNTIME" --repo-root /absolute/path/to/LIVE-uk-aq-ops
plutil -lint "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.live.plist"
```

Before loading the job, use the generic runner from the LIVE ops checkout for
one deliberately bounded LIVE range and verify the LIVE Google account,
project and filter. Then complete LIVE backfill and incremental operational
acceptance. Only after those checks should the operator explicitly enable and
bootstrap normal LIVE scheduling:

```bash
local/scripts/run_gcp_logging_archive.sh \
  --env-file /absolute/path/to/LIVE-uk-aq-ingest/.env \
  --runtime-root /Users/mikehinford/uk-aq-gcp-logging-archive \
  range --start BOUNDED_UTC_START --end BOUNDED_UTC_END
# Verify the run report, selected account/project/filter and bounded output,
# then complete the reviewed LIVE backfill and manual incremental acceptance.
launchctl enable "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.live"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/uk.co.ukaq.gcp-logging-archive.live.plist"
```

Observe the LIVE `RunAtLoad` invocation; do not immediately kickstart it. A
later deliberate immediate run may use
`launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.live"`.
Bootout/removal stops an installed LIVE job without creating a persistent
disabled override. Use
`launchctl disable "gui/$(id -u)/uk.co.ukaq.gcp-logging-archive.live"` only
when LIVE is intentionally meant to stay disabled.

The bounded LIVE check specifically prevents a TEST/LIVE identity or account
mix-up. Normal daily LIVE scheduling is not accepted until its separate
backfill and incremental acceptance has completed.
