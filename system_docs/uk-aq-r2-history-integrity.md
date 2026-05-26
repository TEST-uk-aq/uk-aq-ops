# UK-AQ History Integrity

## Purpose

The History Integrity system checks whether upstream historical source data has
changed after it was first processed. When changed source data is detected, it
records the change in a per-environment SQLite DB and can trigger narrow
backfills using the existing UK-AQ backfill tooling.

First source adapters:

- OpenAQ AWS archive
- Sensor.Community archive

Planned later source adapters:

- UK-AIR-SOS API/history checks
- Breathe London API/history checks

The system supports both UK-AQ environments:

- `CIC-Test`
- `LIVE`

Each environment has its own configuration, state, SQLite DB, source cache,
logs, and Dropbox copy. The script code is shared.

---

## In-repo location vs deploy location

In-repo (this repository):

```text
uk-aq-ops/scripts/uk-aq-history-integrity/
  bin/
    uk-aq-history-integrity.sh
    uk-aq-history-integrity.py
  env/
    CIC-Test.env.example
    LIVE.env.example
```

Deployed root on the MacBook Pro:

```text
/Users/mikehinford/uk-aq-history-integrity/
  bin/
    uk-aq-history-integrity.sh
    uk-aq-history-integrity.py
  env/
    CIC-Test.env
    LIVE.env
  state/
    CIC-Test/
      uk_aq_history_integrity.sqlite
      source-cache/...
      tmp/
      logs/
      reports/
      locks/
    LIVE/
      uk_aq_history_integrity.sqlite
      source-cache/...
      tmp/
      logs/
      reports/
      locks/
```

Deployment is a plain copy of the `bin/` and `env/` trees from the repo to the
deployed root. The `*.env.example` files in the repo are templates; on the host
they are renamed to `<ENV>.env` and edited to point at the local backfill
wrapper and env file.

The live SQLite DBs stay outside Dropbox during writes. After a successful run,
the closed DB is copied to the relevant Dropbox destination.

By convention `UK_AQ_HISTORY_INTEGRITY_LOG_DIR` and
`UK_AQ_HISTORY_INTEGRITY_REPORT_DIR` point at the Dropbox
`<ENV>/uk-aq-history-integrity/{logs,reports}/` paths (append-only text, safe on
Dropbox). This lets logs be tailed remotely without logging into the host.
The SQLite DB, source-cache, tmp downloads, and the per-env lock dir must
stay local — they contain binary state and sidecar files that conflict
with Dropbox sync.

---

## External source facts behind the design

### OpenAQ

OpenAQ AWS archive files are not guaranteed to be final immediately. OpenAQ
states files are written 72 hours after the end of the day, and may be
retroactively patched when data was missing due to fetch errors or historical
scrapes.

Reference:

```text
https://docs.openaq.org/aws/about
```

This is why the integrity checker avoids today/yesterday/recent incomplete days
by default, but still periodically rescans older days.

### S3 metadata

AWS S3 `HeadObject` returns object metadata without returning the object body,
making it a cheap pre-check before downloading a whole source file.

Reference:

```text
https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
```

For OpenAQ, the metadata of interest is:

```text
ETag
ContentLength
LastModified
```

ETag is stored but is **not** treated as a definitive content hash — only as a
change signal.

### Sensor.Community

Sensor.Community has daily CSV archive data and monthly CSV/Parquet archive
options.

References:

```text
https://archive.sensor.community/
https://forum.sensor.community/t/past-data-for-specific-sites/1589
```

Sensor.Community uses the same overall integrity model, but with an HTTP
archive adapter rather than an S3 adapter.

---

## Top-level design

- One shared codebase
- Two env profiles
- Two separate SQLite DBs
- Two separate state / cache / log trees
- Two separate Dropbox copies

There are **no** separate script forks for `CIC-Test` and `LIVE`. The launcher
selects the environment at runtime:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile daily
```

The Python implementation receives the selected env config via environment
variables exported by the shell launcher.

---

## Environment profiles

### CIC-Test env file

Deployed path:

```text
/Users/mikehinford/uk-aq-history-integrity/env/CIC-Test.env
```

Example contents:

```bash
UK_AQ_ENV_NAME="CIC-Test"

UK_AQ_HISTORY_INTEGRITY_ROOT="/Users/mikehinford/uk-aq-history-integrity"
UK_AQ_HISTORY_INTEGRITY_STATE_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test"
UK_AQ_HISTORY_INTEGRITY_DB_PATH="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/uk_aq_history_integrity.sqlite"
UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/source-cache"
UK_AQ_HISTORY_INTEGRITY_TMP_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/tmp"
UK_AQ_HISTORY_INTEGRITY_LOG_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs"
UK_AQ_HISTORY_INTEGRITY_REPORT_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/reports"
UK_AQ_HISTORY_INTEGRITY_LOCK_DIR="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/locks"

UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-history-integrity/uk_aq_history_integrity.sqlite"

UK_AQ_R2_HISTORY_DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/r2-history"
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/r2-history/history/v1/core"

UK_AQ_BACKFILL_WRAPPER="/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops/scripts/uk_aq_backfill_local.sh"
UK_AQ_BACKFILL_ENV_FILE="/PATH/TO/CIC-Test/backfill.env"
```

### LIVE env file

Deployed path:

```text
/Users/mikehinford/uk-aq-history-integrity/env/LIVE.env
```

Same layout, with `LIVE` substituted in `UK_AQ_ENV_NAME` and every path.

### Required env vars

The shell launcher refuses to start if any of these are unset:

```text
UK_AQ_ENV_NAME
UK_AQ_HISTORY_INTEGRITY_ROOT
UK_AQ_HISTORY_INTEGRITY_STATE_DIR
UK_AQ_HISTORY_INTEGRITY_DB_PATH
UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR
UK_AQ_HISTORY_INTEGRITY_TMP_DIR
UK_AQ_HISTORY_INTEGRITY_LOG_DIR
UK_AQ_HISTORY_INTEGRITY_REPORT_DIR
UK_AQ_HISTORY_INTEGRITY_LOCK_DIR
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
```

Additional vars are required conditionally by preflight, for example:

- `UK_AQ_R2_HISTORY_DROPBOX_ROOT` when cross-check is enabled (default).
- `UK_AQ_BACKFILL_WRAPPER` + `UK_AQ_BACKFILL_ENV_FILE` when `--run-backfill` is set.
- `UK_AQ_BACKFILL_ENV_FILE` + `OBS_AQIDB_SUPABASE_URL` + `OBS_AQIDB_SECRET_KEY`
  (loaded from that file) when daily task health reporting is enabled.
- `UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED` (default `true`) and
  `UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_STRICT` (default `false`) control
  daily task health reporting behavior.

### Daily task health reporting

When enabled, each integrity run reports to Obs AQI DB daily task health:

- `task_key`: `ops.history_integrity`
- `task_name`: `R2 History integrity`
- `platform`: `MBPro`
- `source_repo`: `uk-aq-ops`

Run lifecycle:

1. Start: call `uk_aq_rpc_daily_task_started` for seeded task key
   `ops.history_integrity`.
2. Finish success: call `uk_aq_rpc_daily_task_finished`.
3. Finish error: call `uk_aq_rpc_daily_task_failed`.
4. Recompute status: call `uk_aq_rpc_recompute_daily_task_status` for the run date.

Note: runtime does not write `daily_task_definitions`. If the task definition
is missing, start reporting fails and reporting is skipped (or fails the run in
strict mode).

Default mode is best-effort: reporting failures are logged and the integrity
run still proceeds. With strict mode enabled, reporting failures stop the run.

---

## Why separate DBs for CIC-Test and LIVE?

Per-environment DBs:

```text
state/CIC-Test/uk_aq_history_integrity.sqlite
state/LIVE/uk_aq_history_integrity.sqlite
```

Not one combined DB with an `environment` column. Reasons:

- CIC-Test and LIVE have different R2 history storage.
- CIC-Test and LIVE have different Dropbox backup paths.
- Connector IDs, station IDs, and timeseries IDs may differ.
- Backfill credentials and env files differ.
- Separate DBs reduce the risk of cross-environment repairs.

The launcher and Python script also include explicit environment guardrails.

---

## Environment safety guardrails

The launcher (`.sh`) runs the first pass; the Python entrypoint re-checks the
same conditions (defense in depth).

Hard-fail conditions:

```text
--env LIVE     but UK_AQ_ENV_NAME=CIC-Test
--env CIC-Test but UK_AQ_ENV_NAME=LIVE

--env LIVE     but any configured path contains /CIC-Test/
--env CIC-Test but any configured path contains /LIVE/

UK_AQ_HISTORY_INTEGRITY_DB_PATH not inside UK_AQ_HISTORY_INTEGRITY_STATE_DIR
```

Path vars checked for cross-env contamination:

```text
UK_AQ_HISTORY_INTEGRITY_STATE_DIR
UK_AQ_HISTORY_INTEGRITY_DB_PATH
UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR
UK_AQ_HISTORY_INTEGRITY_TMP_DIR
UK_AQ_HISTORY_INTEGRITY_LOG_DIR
UK_AQ_HISTORY_INTEGRITY_REPORT_DIR
UK_AQ_HISTORY_INTEGRITY_LOCK_DIR
UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH
UK_AQ_R2_HISTORY_DROPBOX_ROOT
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
UK_AQ_BACKFILL_WRAPPER
UK_AQ_BACKFILL_ENV_FILE
```

Example error:

```text
ERROR: --env=LIVE but UK_AQ_HISTORY_INTEGRITY_DB_PATH=/.../state/CIC-Test/... contains '/CIC-Test/'. Refusing to run.
```

### Launcher exit codes

```text
0  success
2  bad/missing CLI arg (e.g. --env)
3  env file missing or required env var unset
4  guardrail failure (name mismatch / cross-env path / DB outside state dir)
5  lock held (live or stale)
6  python entrypoint missing
7  python preflight failed
```

---

## Script interface

Launcher:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
```

Python entrypoint:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

The launcher is a thin shell wrapper that:

1. Parses `--env`.
2. Loads `<UK_AQ_HISTORY_INTEGRITY_ROOT>/env/<ENV>.env`. The root defaults to
   the parent of `bin/`; override with `UK_AQ_HISTORY_INTEGRITY_ROOT`.
3. Validates required env vars and environment/path guardrails.
4. Runs structural preflight checks (writable paths, DB parent, optional backfill
   wrapper/env checks when `--run-backfill` is selected).
5. Creates required directories.
6. Acquires a per-environment PID lock.
7. Invokes the Python entrypoint, then cleans up the lock on EXIT/INT/TERM.

Python then runs a stricter preflight phase (before any SQLite writes, source
checks/downloads, cross-checks, or backfill calls).

Python interpreter defaults to `python3`; override with
`UK_AQ_HISTORY_INTEGRITY_PYTHON`.

### CLI options

```text
--env CIC-Test|LIVE                     (required)
--profile daily|weekly|monthly|manual   (default: manual)
--source openaq|sensorcommunity|uk_air_sos|all  (default: all)
--from-day YYYY-MM-DD                   (manual profile or override)
--to-day YYYY-MM-DD                     (manual profile or override)
--dry-run                               No DB writes / no remote calls; logs the snapshot and OpenAQ plan.
--check-only                            (Phase 5 wires Sensor.Community; OpenAQ already check-only by default)
--run-backfill                          Invoke UK_AQ_BACKFILL_WRAPPER for eligible changed-day and cross-check batches (union timeseries IDs per day); no-op under --dry-run.
--max-download-mb N                     Soft cap on per-run downloaded MB (cooperative; checked before each request).
--max-runtime-minutes N                 Soft cap on per-run runtime minutes (cooperative; checked before each request).
--concurrency N                         Worker count for the per-file thread pool (default 8; UK_AQ_HISTORY_INTEGRITY_CONCURRENCY overrides). 1 = strict sequential.
--force-snapshot-import                 Re-import the core snapshot even if its manifest hash is unchanged.
--skip-snapshot-import                  Debug/recovery: skip the Phase 2 import for this run.
--verbose
```

### Flag behavior matrix

Current runtime behavior for OpenAQ integrity runs:

| Flags | Remote HEAD/download checks | Change detection + DB writes | Backfill wrapper execution | Planned backfill commands logged |
|---|---|---|---|---|
| none | Yes | Yes | No | No |
| `--run-backfill` | Yes | Yes | Yes (for changed files and cross-check `mismatch`/`source_only`/`r2_manifest_missing`; excludes `r2_timeseries_counts_missing`) | Yes |
| `--dry-run` | No | No | No | No |
| `--dry-run --run-backfill` | No | No | No | Yes (cross-check candidates only) |
| `--check-only` | Same as corresponding row above | Same as corresponding row above | Same as corresponding row above | Same as corresponding row above |

Notes:

- `--dry-run` exits the OpenAQ adapter before per-file checks, so there is no
  changed-file set to plan/execute backfills from.
- `--check-only` is currently recorded in run metadata/report output, but it
  does not change control flow beyond the `--run-backfill` gate.

Example commands:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile weekly
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --source openaq --from-day 2026-04-01 --to-day 2026-04-30 --dry-run
```

### UK-AIR SOS model and run examples

Naming rules used by the active runtime:

```text
sensorcommunity
uk_air_sos
```

SOS integrity model units:

```text
source check unit: station_ref + day_utc
evidence/count unit: timeseries_id + day_utc
observation repair unit: affected timeseries_ids + day_utc
AQI rebuild unit: connector_id + day_utc
```

SOS canonical snapshot cache path:

```text
<source-cache>/uk_air_sos/station_ref=<station_ref>/day_utc=<YYYY-MM-DD>/snapshot.ndjson
```

Relevant SOS snapshot retention and 404 suppression settings:

```text
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=none|changed|all
UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES=<int, 0 disables>
```

First-seen and error handling rules:

- `first_seen` is baseline-only and does not directly trigger backfill.
- Cross-check can still trigger repair if R2 is missing/mismatched.
- `no_data` is a successful zero-row snapshot and can baseline zero counts.
- `not_found` is recorded clearly and does not create repair candidates by itself.
- `temporary_error` and `permanent_error` do not overwrite prior good baseline hashes/counts and do not create repair candidates.

Repair flow for eligible SOS discrepancies/changes:

```text
source_to_r2 + observations_only
-> queue AQI rebuild (connector_id + day_utc)
-> r2_history_obs_to_aqilevels + aqilevels_only
```

SOS-focused operational examples:

```bash
# Check-only SOS run (manual day window)
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-03 \
  --check-only

# Dry-run planning with backfill enabled (no source writes, no wrapper execution)
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-03 \
  --dry-run \
  --run-backfill

# Narrow real SOS run with backfill enabled
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-01 \
  --run-backfill \
  --max-runtime-minutes 30
```

---

## Scheduling profiles

Default date windows (UTC dates):

```text
daily:
  from = today - 21 days
  to   = today - (INGESTDB_RETENTION_DAYS + 1)

weekly:
  from = today - 120 days
  to   = today - (INGESTDB_RETENTION_DAYS + 1)

monthly:
  from = today - 730 days
  to   = today - (INGESTDB_RETENTION_DAYS + 1)
```

`INGESTDB_RETENTION_DAYS` is resolved in this order:

1. `INGESTDB_RETENTION_DAYS` from the current process environment.
2. If unset, `INGESTDB_RETENTION_DAYS` loaded from `UK_AQ_BACKFILL_ENV_FILE`.
3. If still unset/invalid/non-positive, default `5`.

So the default upper bound is `today - 6 days` for **all** scheduled profiles.
`today` is computed in UTC.

`--from-day` / `--to-day` always override the profile defaults if supplied.

Manual profile requires both `--from-day` and `--to-day`; preflight hard-fails
if either is missing.

---

## Cron examples

Stagger CIC-Test and LIVE so they do not overlap.

```cron
# CIC-Test daily check
30 4 * * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily >> /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/cron.log 2>&1

If you want it to auto-backfill, use:

30 4 * * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily --run-backfill  >> /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/cron.log 2>&1

# LIVE daily check
30 5 * * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile daily >> /Users/mikehinford/uk-aq-history-integrity/state/LIVE/logs/cron.log 2>&1

# CIC-Test weekly check
30 3 * * 0 /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile weekly >> /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/cron.log 2>&1

# LIVE weekly check
30 4 * * 0 /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile weekly >> /Users/mikehinford/uk-aq-history-integrity/state/LIVE/logs/cron.log 2>&1

# CIC-Test monthly check
30 2 1 * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile monthly >> /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/cron.log 2>&1

# LIVE monthly check
30 3 1 * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile monthly >> /Users/mikehinford/uk-aq-history-integrity/state/LIVE/logs/cron.log 2>&1
```

---

## SQLite design

Each environment has its own SQLite DB at:

```text
state/<ENV>/uk_aq_history_integrity.sqlite
```

WAL mode is enabled (`PRAGMA journal_mode=WAL`). Foreign keys are enabled.

### Core snapshot import tables

The script imports core data from the local Dropbox R2 history backup at
`UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT`, not from Supabase or live R2. Goals:

- Avoid Supabase egress
- Avoid live R2 reads
- Allow local station/timeseries lookup

Tables created by Phase 2:

```text
core_snapshot_imports        (audit trail; Phase 1 also created this)
core_connectors_snapshot
core_stations_snapshot
core_timeseries_snapshot
core_phenomena_snapshot      (named "phenomena" in the core schema; pollutant_label lives here)
source_station_timeseries_lookup
```

Only the columns the integrity tooling needs are imported (PK + the fields
used for lookup, filtering, or reporting). Other manifest tables
(`categories`, `observed_properties`, `offerings`, `features`, `procedures`,
`uk_aq_networks`, `uk_air_sos_*`, `station_metadata`,
`station_network_memberships`) are accepted in the manifest but not loaded.

The lookup table allows:

```text
source_key + source_location_id (= stations.station_ref)
  -> station_id
  -> connector_id
  -> timeseries_id(s)  (one row per timeseries)
  -> is_active         (1 if timeseries.ended_at is NULL)
```

`source_key` is the canonical adapter name used by `source_file_state` /
`source_file_events`. The mapping from core `connector_code` is:

```text
openaq
sensorcommunity
```

OpenAQ `location_id` = `stations.station_ref` (confirmed in
`uk-aq-ingest/scripts/openaq/openaq_list_stations.py`). Sensor.Community
sensor IDs are stored as `stations.station_ref` (confirmed in
`uk-aq-ingest/scripts/sensorcommunity/sensorcommunity_list_stations.py`).

Stations with `removed_at` set are excluded from the lookup. Timeseries
keep their row regardless of `ended_at`, but `is_active` reflects it so
adapters can choose whether to check ended timeseries.

### Source file state

```sql
CREATE TABLE IF NOT EXISTS source_file_state (
  source_file_key TEXT PRIMARY KEY,

  env_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  remote_scheme TEXT NOT NULL,
  remote_url_or_key TEXT NOT NULL,

  station_ref TEXT,
  source_location_id TEXT,
  day_utc TEXT,
  date_range_start_utc TEXT,
  date_range_end_utc TEXT,

  exists_remote INTEGER NOT NULL,
  content_length INTEGER,
  etag TEXT,
  last_modified_utc TEXT,

  sha256_downloaded TEXT,
  sha256_uncompressed TEXT,

  local_cached_path TEXT,

  first_seen_at_utc TEXT NOT NULL,
  last_checked_at_utc TEXT NOT NULL,
  last_changed_at_utc TEXT,

  last_status TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_file_state_source_day
  ON source_file_state(source_key, day_utc);
```

### Source file event ledger

Append-only audit ledger:

```sql
CREATE TABLE IF NOT EXISTS source_file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  event_at_utc TEXT NOT NULL,
  env_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  event_type TEXT NOT NULL,

  source_file_key TEXT NOT NULL,
  remote_url_or_key TEXT NOT NULL,

  station_ref TEXT,
  source_location_id TEXT,
  day_utc TEXT,

  old_content_length INTEGER,
  new_content_length INTEGER,

  old_etag TEXT,
  new_etag TEXT,

  old_last_modified_utc TEXT,
  new_last_modified_utc TEXT,

  old_sha256_downloaded TEXT,
  new_sha256_downloaded TEXT,

  old_sha256_uncompressed TEXT,
  new_sha256_uncompressed TEXT,

  downloaded_bytes INTEGER DEFAULT 0,
  hash_runtime_ms INTEGER DEFAULT 0,

  backfill_triggered INTEGER NOT NULL DEFAULT 0,
  backfill_timeseries_ids TEXT,
  backfill_status TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_file_events_key
  ON source_file_events(source_file_key, event_at_utc);
```

### Run metrics table

```sql
CREATE TABLE IF NOT EXISTS integrity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  env_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  source_filter TEXT,
  from_day TEXT,
  to_day TEXT,

  status TEXT NOT NULL,

  files_head_checked INTEGER DEFAULT 0,
  files_downloaded INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  files_unchanged_after_download INTEGER DEFAULT 0,
  files_missing INTEGER DEFAULT 0,

  downloaded_bytes INTEGER DEFAULT 0,
  downloaded_mb REAL DEFAULT 0,
  runtime_seconds REAL DEFAULT 0,

  backfills_triggered INTEGER DEFAULT 0,

  warnings_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,

  notes TEXT
);
```

Possible `status` values: `running`, `noop`, `ok`, `stopped_limit`, `error`.

### Core snapshot imports

```sql
CREATE TABLE IF NOT EXISTS core_snapshot_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at_utc TEXT NOT NULL,
  env_name TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  snapshot_manifest_hash TEXT,
  rows_connectors INTEGER DEFAULT 0,
  rows_stations INTEGER DEFAULT 0,
  rows_timeseries INTEGER DEFAULT 0,
  rows_pollutants INTEGER DEFAULT 0,
  rows_lookup INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  notes TEXT
);
```

---

## Source-cache behaviour

When a file needs to be downloaded for hashing:

1. Download to a temp path under the environment tmp dir.
2. Compute compressed/downloaded hash.
3. If applicable, compute uncompressed/canonical hash.
4. Compare to SQLite state.
5. If the canonical hash is unchanged, delete the temp file.
6. If the canonical hash changed, move the file into source-cache and keep it
   for repair/debugging.

Example OpenAQ cache path:

```text
state/CIC-Test/source-cache/openaq/locationid=12345/year=2026/month=05/location-12345-20260507.csv.gz
```

Example Sensor.Community cache path:

```text
state/CIC-Test/source-cache/sensorcommunity/2026-05-07/<filename>.csv
```

Do not cache unchanged downloads permanently unless explicitly configured.

---

## OpenAQ adapter

### Remote source

OpenAQ S3 archive. Object pattern:

```text
records/csv.gz/locationid=<LOCATION_ID>/year=<YYYY>/month=<MM>/location-<LOCATION_ID>-<YYYYMMDD>.csv.gz
```

### Metadata check

For each expected file:

1. HEAD via `urllib.request` (`https://openaq-data-archive.s3.amazonaws.com`
   by default; overridable via `UK_AQ_HISTORY_INTEGRITY_OPENAQ_BASE_URL`
   for tests).
2. Capture ETag, Content-Length, Last-Modified.
3. Compare with `source_file_state` row keyed by `openaq:<location_id>:<YYYY-MM-DD>`.
4. Download only when new, previously-missing, or any of those three
   fields differ.
5. Compute:
   - `sha256_downloaded` over the gzipped bytes
   - `sha256_uncompressed` by streaming through `gzip.open()`
6. `sha256_uncompressed` is the decisive change detector. ETag is a
   change-signal only.
7. Move files into source-cache only on state-changing transitions
   (first_seen / reappeared / changed). Plain unchanged-content downloads
   are deleted.

### Event types emitted

```text
first_seen           — file existed at HEAD and we had no prior state row
first_seen_missing   — HEAD returned 404 and we had no prior state row
disappeared          — HEAD returned 404; prior state showed the file present
reappeared           — HEAD returned 200; prior state showed exists_remote=0
changed              — sha256_uncompressed differs from the prior recorded value
```

Pure metadata-change-but-content-same downloads update state silently
(no event). HEAD requests where every metadata field matches stored
values just bump `last_checked_at_utc`.

### Backfill impact

When an OpenAQ file changes:

```text
location_id -> source_station_timeseries_lookup -> timeseries_id list
```

Then call the existing backfill wrapper with:

```bash
UK_AQ_BACKFILL_RUN_MODE=source_to_r2
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_TIMESERIES_IDS=<comma separated ids>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

Support both:

```bash
UK_AQ_BACKFILL_TIMESERIES_ID=12345
UK_AQ_BACKFILL_TIMESERIES_IDS=12345,12346
```

internally normalising to a list.

### Recoverable no-data scenarios

Three no-data cases that integrity used to surface as backfill failures now succeed by writing the manifest the integrity check would otherwise re-discover as missing:

1. **OpenAQ S3 has no records for the requested day/connector.** Backfill writes an empty connector + day manifest; subsequent integrity cross-checks for that day stop flagging `r2_manifest_missing`.
2. **Targeted-merge run for a day that has no existing local Dropbox baseline** (e.g., a day the original ingest never touched). Backfill writes a fresh connector + day manifest containing just the replacement rows for the targeted timeseries IDs (no preservation needed because there's nothing to preserve).
3. **Sensor.Community daily archive has no day source files** (including missing day index at `https://archive.sensor.community/YYYY-MM-DD/`). Backfill writes an empty connector + day manifest instead of skipping.

See [uk-aq-backfill-local.md → No-data tolerance](uk-aq-backfill-local.md#no-data-tolerance) for the runner-side mechanics, log event names, and ledger fields.

If a chunk fails with `source_to_r2 encountered N connector-day errors` and the per-chunk Deno log includes `source_to_r2 targeted merge requires local Dropbox history manifests`, the running `run_job.ts` predates that fix — check the file at `UK_AQ_BACKFILL_RUN_JOB_PATH`.

---

## Sensor.Community adapter

### Remote source

Sensor.Community daily archive:

```text
https://archive.sensor.community/YYYY-MM-DD/
```

Monthly archive options also exist:

```text
https://archive.sensor.community/csv_per_month/
https://archive.sensor.community/parquet/
```

The first implementation targets the daily archive.

### Metadata check

For each relevant archive file:

1. Use HTTP HEAD where supported.
2. Store/compare ETag, Content-Length, Last-Modified if present.
3. If new or metadata changed, download the file.
4. Compute canonical content hash.
5. Record state/event rows in SQLite.
6. Resolve affected station/timeseries IDs using local core lookup.
7. Trigger narrow backfills where possible.

### Difference from OpenAQ

The daily archive is plain CSV (not gzipped) so the adapter writes the
canonical SHA-256 to both `sha256_downloaded` and `sha256_uncompressed`.

Filenames embed `sensor_type` (e.g. `2026-05-03_sds011_sensor_55555.csv`),
which we don't carry in the core snapshot. Rather than extending the
import, the adapter fetches the day's directory listing once per day and
maps `sensor_id -> filename` from the parsed HTML. Sensors absent from
the index are recorded as missing without a per-file HEAD.

The generic DB model still stores `date_range_start_utc` /
`date_range_end_utc` for future monthly-archive support, but the daily
adapter only sets `day_utc`.

---

## API-based future adapters

UK-AIR-SOS and Breathe London may require API snapshot checking rather than
archive-file checking. Same SQLite DB per environment; source-specific
adapters.

Generic model:

```text
source history unit
  -> canonical bytes
  -> sha256
  -> compare
  -> changed?
  -> resolve timeseries IDs
  -> trigger narrow backfill
```

For APIs:

1. Fetch source API response for connector/station/day.
2. Canonicalise response:
   - stable sort rows
   - stable JSON/NDJSON
   - remove volatile request metadata
   - normalise timestamps/numbers
3. Hash canonical bytes.
4. Compare with SQLite.
5. Trigger repair only when canonical hash changes.

---

## Core snapshot import workflow

The R2 history backup writes snapshots in this layout (see
[`uk-aq-r2-core-snapshot.md`](uk-aq-r2-core-snapshot.md)):

```text
<UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT>/
  day_utc=YYYY-MM-DD/
    manifest.json
    checksums.sha256
    table=<name>/rows.ndjson.gz
```

`manifest.json` carries `manifest_hash`, `day_utc`, and a `tables[]` array
where each entry has `relative_path`, `row_count`, and `sha256` (over the
compressed bytes).

At the start of each run the script:

1. Lists `day_utc=YYYY-MM-DD` directories under
   `UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT`, picks the newest with a valid
   `manifest.json`.
2. Compares the manifest's `manifest_hash` against the most recent
   `core_snapshot_imports` row for this env where `status='ok'`.
3. If the hash matches **and** the snapshot tables still have rows,
   reuse — no work.
4. Otherwise:
   a. Insert a `core_snapshot_imports` row with `status='running'`.
   b. For each of `connectors`, `stations`, `timeseries`, `phenomena`:
      verify the file's SHA-256 against the manifest, then `DELETE FROM
      core_<table>_snapshot` and bulk-insert from the gzipped NDJSON.
   c. Rebuild `source_station_timeseries_lookup`.
   d. Update the `core_snapshot_imports` row with row counts,
      `bytes_read`, and `status='ok'`. The whole import runs in a single
      transaction; on failure the row is updated to `status='error'` and
      previous snapshot data is preserved (rollback).

This happens once per environment DB, not once per source adapter.

Skip / override flags:

- `--force-snapshot-import` re-imports even if the manifest hash is
  unchanged. Useful when only the snapshot tables need rebuilding.
- `--skip-snapshot-import` skips the import entirely (debug/recovery).
  Source adapters in later phases will fail without a populated lookup.
- `--dry-run` reports the snapshot that would be imported and what each
  table would contribute, but performs no DB writes.

If `UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT` is unset or the directory is
missing, the run logs a warning and continues with `status=noop`.
Source adapters in later phases will refuse to run if the lookup is
empty.

---

## Backfill workflow

Changed source files trigger only narrow repairs.

Avoid broad connector/day force-replace unless no narrower mapping exists.

Preferred OpenAQ repair:

```text
source_key=openaq
location_id=12345
day_utc=2026-04-02
  -> timeseries IDs [9001, 9002, 9003]
  -> source_to_r2 only for those timeseries IDs/day
```

Modes:

```text
check-only:
  detect changes and write ledger, but do not run backfill

dry-run:
  show what would be checked/downloaded/repaired, do not mutate remote outputs

run-backfill:
  call existing backfill wrapper
```

### Exact meaning of "changed files" / "source-change events"

The checker evaluates each candidate source file and assigns an outcome.
For backfill triggering, only these outcomes are treated as
source-change events (and written as `source_file_events.event_type`):

```text
first_seen
reappeared
changed
```

These outcomes do **not** trigger backfill:

```text
first_seen_missing
disappeared
still_missing
unchanged_metadata
unchanged_content
```

Notes:

- `changed` means canonical content hash changed (OpenAQ uses
  `sha256_uncompressed` as the decisive signal), not just metadata.
- A metadata-only change that downloads but hashes to the same content is
  `unchanged_content` and does not trigger backfill.
- `disappeared`/`still_missing` are recorded for visibility but do not
  trigger backfill because there is no source file to rebuild from.

### Exact `--run-backfill` trigger rule

Backfill is attempted only when all conditions are true:

1. `--run-backfill` is set.
2. `--dry-run` is **not** set.
3. At least one source-change event exists (`first_seen`/`reappeared`/`changed`)
   **or** at least one cross-check discrepancy exists with status
   `mismatch`, `source_only`, or `r2_manifest_missing`.

Execution shape:

- The run first completes source checks/downloads.
- It then runs integrity backfill orchestration phases:
  - source-change batches from adapter events (`first_seen`/`reappeared`/`changed`)
  - cross-check observation-repair batches from `cross_checks` statuses
    `mismatch`/`source_only`/`r2_manifest_missing` (grouped by day+connector)
  - AQI-only health checks that queue connector/day AQI rebuild work
- Source-change phases call the wrapper once per day with the union of affected
  `timeseries_ids` for that day.
- Cross-check observation-repair calls are one per day+connector with
  observations-only scope.
- AQI-only issues are queued for `r2_history_obs_to_aqilevels` (not
  `source_to_r2`).

`r2_only` does **not** trigger observation repair.
`r2_timeseries_counts_missing` does **not** trigger observation repair; it means
the index metadata needs timeseries-count enrichment first.

So if a run ends with `backfills_attempted=0`, it means no eligible
source-change and no eligible cross-check discrepancy was found in the
scanned window (even if `--run-backfill` was set).

---

## Dropbox copy of SQLite DB

The live DB is written here:

```text
/Users/mikehinford/uk-aq-history-integrity/state/<ENV>/uk_aq_history_integrity.sqlite
```

After a successful run, copy the closed DB to:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/<ENV>/uk-aq-history-integrity/uk_aq_history_integrity.sqlite
```

Do not run SQLite directly from Dropbox. SQLite may use sidecar files during
writes (`.sqlite-wal`, `.sqlite-shm`); Dropbox can sync those while SQLite is
writing, which risks conflicted copies.

---

## R2 Dropbox backup interaction

The existing R2 history Dropbox backup uses manifest hashes.

Expected chain:

```text
OpenAQ/Sensor.Community retroactively changes source data
  -> integrity checker detects changed source hash
  -> narrow backfill rebuilds affected R2 history day
  -> R2 history day manifest changes
  -> existing R2 Dropbox backup sees changed manifest hash
  -> old day is backed up again
```

Therefore, the integrity checker does not need to separately back up R2
history output. It only needs to:

1. Detect upstream source changes.
2. Trigger appropriate repair.
3. Record what happened.

---

## Download and runtime monitoring

Track per run:

```text
files HEAD checked
files downloaded
files changed
files unchanged after download
files missing
downloaded bytes
downloaded MB
runtime seconds
hashing runtime
backfills triggered
warnings
errors
```

Soft limits:

```text
--max-download-mb N
--max-runtime-minutes N
```

If a limit is exceeded:

1. Stop scheduling new downloads.
2. Finish current file safely.
3. Write run status as `stopped_limit`.
4. Write a report explaining what was skipped.
5. Do not mark skipped files as checked.

Per-run reports:

```text
state/<ENV>/reports/YYYY-MM-DDTHHMMSSZ-summary.json
state/<ENV>/reports/YYYY-MM-DDTHHMMSSZ-summary.md
```

The report includes env, profile, source, date range, downloaded MB, runtime,
changed files, backfills triggered, errors/warnings, and (Phase 6) top
largest downloads.

---

## Locking

Per-environment PID lock:

```text
state/<ENV>/locks/uk-aq-history-integrity.lock
```

The launcher writes its own PID into the lock file and removes it on
EXIT/INT/TERM. The script refuses to run if:

- A live lock exists (PID currently running).
- A stale lock exists (PID not running). Manual cleanup is required; a
  `--force-unlock-stale` flag may be added later.

CIC-Test and LIVE have separate locks.

---

## Logging

Per-environment logs:

```text
state/<ENV>/logs/run-YYYY-MM-DDTHHMMSSZ.log
state/<ENV>/logs/cron.log
```

Timestamps in logs are UTC. Logs include env, profile, source, date window,
core snapshot used, files checked/downloaded/changed, downloaded MB, runtime,
backfill calls, warnings, and errors.

---

## Operational notes

- **`--verbose`** bumps the Python log level from INFO to DEBUG. The source
  adapters currently emit no DEBUG-level lines, so the flag has no visible
  effect today. Keep it on if you want future DEBUG output for free; drop it
  if you want shorter logs.
- **Crash-safe per-file commit.** The OpenAQ and Sensor.Community loops
  `conn.commit()` after each file's state/event upsert (and after each
  batched backfill call). If a run is interrupted (Ctrl-C, laptop sleep,
  network drop) the SQLite DB stays consistent: every file that completed
  is recorded; in-flight downloads in `state/<ENV>/tmp/` are abandoned.
  The next run picks up cleanly.
- **Concurrent HEAD/GET (default 8 workers).** Both adapters submit
  per-file work to a `ThreadPoolExecutor`; SQLite writes stay on the
  main thread. Tune with `--concurrency N` or
  `UK_AQ_HISTORY_INTEGRITY_CONCURRENCY`. `--concurrency 1` reproduces
  strict-sequential behaviour for debugging. A cold daily window
  (~14 K HEADs) typically completes in a few minutes at the default.
- **Resume cost.** Re-running over the same window still issues every
  HEAD, but only downloads files whose ETag, Content-Length, or
  Last-Modified changed. On stable archives this means thousands of
  HEADs and almost no GETs — the run completes much faster than the
  cold one. `--force-snapshot-import` does not affect this; it only
  re-imports the core snapshot.

---

## Failure behaviour

Fail safe:

```text
Do not delete source-cache files unless they are confirmed unchanged temp downloads.
Do not mark files as successfully checked if download/hash failed.
Do not trigger backfill unless source change is confirmed.
Do not copy DB to Dropbox if the run fails before DB close.
Do not proceed if env/path guardrails fail.
Do not use broad connector/day force-replace unless explicitly configured.
```

---

## Implementation status

### Phase 1 — Environment-profile launcher and SQLite skeleton (DONE)

Delivered:

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh` — thin
  shell launcher; argument parsing, env loading, guardrails, dir creation,
  PID locking.
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` —
  Python entrypoint; defense-in-depth guardrails, SQLite schema creation,
  CLI argument handling, run row, JSON+MD summary report.
- `scripts/uk-aq-history-integrity/env/CIC-Test.env.example`
- `scripts/uk-aq-history-integrity/env/LIVE.env.example`
- SQLite tables created: `core_snapshot_imports`, `source_file_state`,
  `source_file_events`, `integrity_runs` (+ two indexes).
- `--source`, `--max-download-mb`, `--max-runtime-minutes` are accepted
  and recorded but not enforced (later phases).

### Phase 2 — Core snapshot import from Dropbox R2 backup (DONE)

Delivered:

- Snapshot discovery under `UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT` (newest
  valid `day_utc=YYYY-MM-DD/manifest.json`).
- Per-file SHA-256 verification against `manifest.tables[].sha256`.
- Streaming gzipped-NDJSON import for `connectors`, `stations`,
  `timeseries`, `phenomena` into `core_*_snapshot` tables.
- Derived `source_station_timeseries_lookup` for `openaq`,
  `sensorcommunity`, and `uk_air_sos`, filtered to non-removed stations.
- Phase 7.1 adds `--source uk_air_sos` for lookup/cross-check plumbing only
  (no SOS API fetch adapter yet).
- Phase 7.2 adds a canonical SOS station/day snapshot helper in the integrity
  runtime: deterministic NDJSON rows sorted by `(timeseries_id, observed_at_utc)`
  with status outcomes `ok|no_data|not_found|temporary_error|permanent_error`.
  This phase does not write R2, does not write Supabase, and does not trigger
  backfills.
- Phase 7.3 adds the `uk_air_sos` station/day source adapter flow:
  source state/events, per-timeseries source counts, and source-cache retention
  policy via `UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=none|changed|all`
  (default `changed`). First-seen snapshots are baselined only (no direct
  backfill trigger); temporary/permanent fetch errors do not overwrite the prior
  baseline hashes/counts.
- Phase 7.4 plugs `uk_air_sos` into the observation-repair path:
  cross-check discrepancies plus SOS `changed`/`reappeared` source-change
  targets are merged and deduped at `(connector_id, day_utc, timeseries_id)`.
  Observation repair runs with `source_to_r2 + observations_only`, and successful
  repair queues one AQI rebuild per `(connector_id, day_utc)`.
- Phase 7.5 adds SOS error-handling/reporting polish:
  explicit `no_data` vs `not_found` vs `temporary_error` vs `permanent_error`
  counters, optional not-found retry suppression via
  `UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES`,
  and report visibility for SOS cross-check/repair/AQI outcomes.
- Phase 7.6 documentation pass is complete in this document and in
  `system_docs/uk_aq_scripts.md`, including SOS model units, cache-path
  contract, naming rules, and operational command examples.
- Reuse decision based on `manifest_hash` plus a
  snapshot-tables-have-rows safety check; `core_snapshot_imports` row
  written for every attempt (`running`/`ok`/`error`).
- New CLI: `--force-snapshot-import`, `--skip-snapshot-import`. `--dry-run`
  is now meaningful (reports the snapshot that would be imported, no DB
  writes). Run summary JSON+MD includes a `snapshot` block.

### Phase 3 — OpenAQ source adapter (DONE)

Delivered:

- HTTP HEAD/GET via stdlib `urllib.request`; no AWS credentials required
  (OpenAQ archive is public anonymous HTTPS at
  `https://openaq-data-archive.s3.amazonaws.com`). Base URL is
  overridable via `UK_AQ_HISTORY_INTEGRITY_OPENAQ_BASE_URL`.
- For every distinct `(source_key='openaq', source_location_id)` in the
  Phase 2 lookup, iterate the `from_day..to_day` window and HEAD each
  object key. Compare ETag / Content-Length / Last-Modified against
  `source_file_state`.
- Download only when new, previously-missing, or metadata changed. Stream
  to env tmp dir; compute `sha256_downloaded` over the gzipped bytes and
  `sha256_uncompressed` by streaming through `gzip.open()`. Decisive
  change detector is `sha256_uncompressed` (ETag is signal only).
- State transitions emit events:
  `first_seen`, `first_seen_missing`, `disappeared`, `reappeared`,
  `changed`. Unchanged-content downloads (metadata moved but bytes same)
  delete the temp and emit no event. Pure metadata-unchanged HEADs just
  bump `last_checked_at_utc`.
- Changed/reappeared/first-seen files are moved into
  `source-cache/openaq/locationid=<L>/year=<Y>/month=<MM>/...`. Cache
  files for prior changes are never auto-deleted.
- `LimitTracker` enforces `--max-download-mb` and
  `--max-runtime-minutes` cooperatively: the loop checks before each
  request and exits cleanly, marking the run `status=stopped_limit`.
- When `--run-backfill` is set (and `--dry-run` is not), backfill
  executes in a later batched phase (one call per day using unioned
  timeseries IDs).
- Run report includes an OpenAQ section with per-changed-file event IDs,
  timeseries IDs, and (where applicable) the planned commands.

### Phase 4 — Narrow backfill runner (DONE)

Pass 1 (subprocess invocation + per-event recording):

- When the OpenAQ adapter emits a `changed` / `first_seen` / `reappeared`
  event and `--run-backfill` is set (and `--dry-run` is not), the
  integrity runner invokes `UK_AQ_BACKFILL_WRAPPER` via `bash`
  with a fresh subprocess env:
  - vars sourced from `UK_AQ_BACKFILL_ENV_FILE` (bash-ish parser: handles
    `export`, quoted values, `#` comments)
  - `UK_AQ_BACKFILL_RUN_MODE=source_to_r2`
  - `UK_AQ_BACKFILL_DRY_RUN=false`
  - `UK_AQ_BACKFILL_FORCE_REPLACE=true`
  - `UK_AQ_BACKFILL_FROM_DAY_UTC=<day>` / `UK_AQ_BACKFILL_TO_DAY_UTC=<day>` (same day)
  - `UK_AQ_BACKFILL_TIMESERIES_IDS=<csv>`
  - `UK_AQ_BACKFILL_TRIGGER_MODE=manual`
  - if `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT` is unset, integrity auto-sets
    it to `<UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR>/openaq` for that call
  - if `UK_AQ_BACKFILL_SOS_INTEGRITY_SNAPSHOT_ROOT` is unset, integrity
    auto-sets it to `<UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR>/uk_air_sos`
    so `source_to_r2` can reuse same-run SOS snapshot files before calling
    the SOS API
- Per-backfill result recorded on the `source_file_events` row:
  `backfill_triggered`, `backfill_timeseries_ids`,
  `backfill_status ∈ {ok, error, timeout, no_wrapper, no_env_file,
  no_timeseries_ids, spawn_error}`, plus exit code, log path, and
  stdout/stderr tail (4 KB each) in `notes`.
- Hard guardrails enforced by construction:
  - No invocation in `--dry-run` (only the planned command is logged).
  - No invocation without `--run-backfill`.
  - Connector-wide force-replace is never used.
- 1800 s per-call safety timeout (`subprocess.TimeoutExpired` →
  `status=timeout`).

Pass 2 (batching, logs, monitoring):

- **Batched by day.** The OpenAQ HEAD/download loop now finishes first;
  the backfill phase runs afterward, grouping changed files by
  `day_utc`. Each day fires **one** wrapper call with the **union** of
  the affected timeseries IDs from all locations that changed that day.
  Per-event `backfill_timeseries_ids` stays the per-location subset;
  `backfill_status` is shared across the batch and the event's `notes`
  records `batch: files=<N> total_timeseries_ids=<U>`.
- **Per-call log files** written to
  `state/<ENV>/logs/backfill/<run_compact>/day_<YYYY-MM-DD>.log` with
  header (wrapper, env file, day, timeseries IDs, exit code, status)
  followed by full stdout/stderr. Path is also stored in the event's
  `notes`.
- **Chunk-safe observation repair.** When observation-repair chunking is
  active, integrity injects targeted-stage env vars so non-final chunks stage
  merged rows locally and the final chunk performs one commit:
  - `UK_AQ_BACKFILL_TARGETED_STAGE_ENABLED=true`
  - `UK_AQ_BACKFILL_TARGETED_STAGE_ROOT=state/<ENV>/logs/backfill/<run_compact>/_targeted_stage/run_<run_id>/day_<YYYY-MM-DD>/connector_<id>`
  - `UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE=false|true` (final chunk only true)
  - `UK_AQ_BACKFILL_TARGETED_STAGE_CLEANUP=false|true` (final chunk only true)
- **Adaptive chunking first-pass.** If chunking is configured and a batch
  exceeds the chunk limit, integrity first tries one unchunked call
  (`UK_AQ_HISTORY_INTEGRITY_BACKFILL_TRY_UNCHUNKED_FIRST=true`, default). If
  that call fails/timeouts, integrity falls back to chunked calls.
- **First-class run-row columns.** `integrity_runs` now carries
  `backfills_triggered` (attempted batches), `backfills_ok`, and
  `backfills_failed`. Backfill failures continue to bump `errors_count`.
- **Limit-aware.** The backfill phase re-checks
  `LimitTracker.should_stop()` before each batch and exits cleanly when
  a soft cap trips; remaining days are skipped (their events stay with
  `backfill_status` unset).
- **Real-wrapper integration verified.** Smoke test invokes the actual
  `scripts/uk_aq_backfill_local.sh` via the integrity runner —
  the wrapper passes its `require_env` checks (proving env injection
  matches the wrapper's contract) and we capture the downstream
  exit/stderr in the per-call log file.

### Phase 5 — Sensor.Community adapter (DONE)

Delivered:

- HTTP fetch of the daily directory listing
  `https://archive.sensor.community/<YYYY-MM-DD>/` (overridable via
  `UK_AQ_HISTORY_INTEGRITY_SENSOR_COMMUNITY_BASE_URL`). One index fetch
  per day; the HTML is parsed with a single regex over
  `<a href="<YYYY-MM-DD>_<sensor_type>_sensor_<sensor_id>.csv">`.
  The fetch now uses the shared HTTP retry/backoff policy (3 attempts),
  including retries for transient partial-read/connection-close failures
  (for example `IncompleteRead` / `RemoteDisconnected`).
- Per-sensor workflow mirrors the OpenAQ adapter:
  - sensors absent from the day's index are recorded as missing
    (no per-file HEAD; saves round trips)
  - sensors present trigger `HEAD <file>` against the archive,
    then `GET` only when ETag/Content-Length/Last-Modified differ
    from the prior `source_file_state` row
  - SHA-256 over the CSV bytes (no gzip; both
    `sha256_downloaded` and `sha256_uncompressed` carry the canonical
    value for cross-source consistency)
- State / event semantics identical to OpenAQ
  (`first_seen / first_seen_missing / disappeared / reappeared / changed`);
  rows in `source_file_state` and `source_file_events` are stamped with
  `source_key='sensorcommunity'`.
- Source-cache layout: `state/<ENV>/source-cache/sensorcommunity/<YYYY-MM-DD>/<filename>.csv`.
- Backfill batching (Phase 4 Pass 2 logic) runs at the end of the SC
  scan: changed files grouped by `day_utc`, single wrapper call per day
  with the union of timeseries IDs, per-call log file under
  `state/<ENV>/logs/backfill/<run_compact>/sc_day_<YYYY-MM-DD>.log`.
- Run row aggregates counters across both adapters: `files_head_checked`,
  `files_downloaded`, `files_changed`, `files_missing`,
  `downloaded_bytes`, `backfills_triggered / ok / failed`, etc.
- Soft `--max-download-mb` and `--max-runtime-minutes` apply across both
  adapters via a single shared `LimitTracker`.

### Phase 5.5 — Adapter concurrency (DONE — see implementation notes below)

Reason: a cold CIC-Test daily run is ~14k OpenAQ HEADs; sequential
takes hours, parallel takes minutes. Most of the time per request is
network round-trip, not CPU.

Delivered:

- Per-day inner loop in both `check_openaq` and
  `check_sensor_community` runs through a bounded
  `concurrent.futures.ThreadPoolExecutor`. Workers issue HEAD/GET and
  hash; SQLite writes (`source_file_state` upsert + `source_file_events`
  insert) happen on the main thread to keep one writer and preserve the
  per-file `commit()` invariant.
- New CLI flag `--concurrency N` (default 8). Default overridable via
  env var `UK_AQ_HISTORY_INTEGRITY_CONCURRENCY`. `--concurrency 1`
  reproduces the old strict-sequential behaviour for debugging.
- `LimitTracker` is now thread-safe (an internal `threading.Lock`). It
  is checked both before submitting each task and inside each worker
  before issuing the request, so an in-flight worker's bytes are
  accounted for and no new tasks are scheduled once a limit trips.
- Completion order is non-deterministic; the run report sorts
  `changed_files` deterministically before writing.
- Phase 4 Pass 2 batched backfill phase is unaffected (still runs
  serially after the parallel scan completes).

### Phase 6.5 — R2 cross-check (DONE)

Goal: detect missing or partial observations in R2 history by
comparing per-(timeseries, day) row counts between the upstream archive
file (counted at ingest time) and the R2 history index manifest.

Closes the gap Phases 3 / 5 leave open: those detect when *upstream*
changes; this detects when *R2* is missing or short of rows the
upstream archive contains.

**Pass A — Foundation (DONE):**

- The connector-day R2 manifest writer in
  `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` now computes
  per-timeseries row counts at the parquet write site and stores them as
  a single top-level map on connector/day manifests:
  `timeseries_row_counts: { "<ts_id>": <count> }`.
  Per-file `files[].timeseries_row_counts` is no longer written to keep
  manifest size lower.
- The index builder in `workers/shared/uk_aq_r2_history_index.mjs`
  reads the top-level field from source connector manifests, surfacing it
  on the per-day-per-connector index manifest
  (`history/_index/observations_timeseries/day_utc=Y/connector_id=X/manifest.json`).
  For backward compatibility with older manifests, it can still fall back
  to per-file aggregation if legacy `files[].timeseries_row_counts` is
  present.
- **Historical backfill.** The index-rebuild CLI gained
  `--compute-missing-timeseries-counts`: when set, for any connector
  manifest lacking `timeseries_row_counts`, the rebuild reads each
  parquet file referenced by the manifest, computes per-timeseries
  counts, patches the manifest in place (new `manifest_hash`), and
  re-uploads. This makes the new field retroactively available for
  every day with parquets in R2, independent of ingest retention.
  Standalone run:
  ```bash
  node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
    --domain observations --compute-missing-timeseries-counts
  ```
  Targeted mode is also supported for low-cost repair runs:
  ```bash
  # 1) Build a local report from the Dropbox R2 mirror
  node scripts/backup_r2/uk_aq_report_missing_timeseries_counts_local.mjs \
    --format csv \
    --targets-only \
    --out ./tmp/missing_timeseries_counts_targets.csv

  # 2) Rebuild only those observation day/connector units in R2
  node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
    --domain observations \
    --targets-csv ./tmp/missing_timeseries_counts_targets.csv \
    --compute-missing-timeseries-counts
  ```
  Equivalent direct targeting (no CSV) is available with repeated
  `--target YYYY-MM-DD:connector_id`.
  Reads `parquet-wasm` (already a dep). Idempotent — re-runs on a
  patched day skip the parquet reads.
- A new normalised SQLite table records source-side counts:
  ```sql
  CREATE TABLE source_file_timeseries_counts (
    source_file_key TEXT NOT NULL,
    timeseries_id   INTEGER NOT NULL,
    row_count       INTEGER NOT NULL,
    counted_at_utc  TEXT NOT NULL,
    PRIMARY KEY (source_file_key, timeseries_id)
  );
  ```
- On every source download (`first_seen` / `changed` / `reappeared`),
  the adapter parses the CSV once and bulk-replaces the rows for that
  `source_file_key`. Counts persist across runs; unchanged-metadata
  HEADs reuse the prior recording (source bytes haven't changed → counts
  are still authoritative).
- No CLI changes, no comparison logic yet.

**Pass B — Cross-check pass (DONE):**

- After the OpenAQ + Sensor.Community scans, a new pass walks every
  `(connector_id, day_utc, timeseries_id)` with source-side rows from
  `source_file_timeseries_counts`, reads local Dropbox-backed
  `history/_index/observations_timeseries/.../manifest.json`, and compares
  `timeseries_row_counts`.
- Outcomes recorded in a new `cross_checks` table with status
  `ok | source_only | r2_only | mismatch | r2_manifest_missing | r2_timeseries_counts_missing`.
- Run row and report grow `cross_checks_total / ok / mismatch /
  source_only / r2_only / r2_manifest_missing` counters, plus report-level
  `cross_checks_r2_timeseries_counts_missing`.
- New CLI flag `--skip-cross-check` for debug/recovery; pass runs by
  default.

**Pass C / Phase 6.6 — Observation repair + AQI queue (DONE):**

- When `--run-backfill` is set, the integrity runner derives observation
  repair candidates directly from `cross_checks` rows for the current
  `run_id` where
  `status IN ('mismatch', 'source_only', 'r2_manifest_missing')`.
- Candidates are grouped by `(day_utc, connector_id)`; each group runs
  one targeted `source_to_r2` repair call with explicit
  `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only`.
- After each successful observation repair, the runner queues AQI
  rebuild work into SQLite table `aqi_rebuild_queue`, deduplicated by
  `(run_id, connector_id, day_utc)`:
  - `reason = obs_repaired`
  - `source_mode = live_r2`
  - `status = queued`
  - duplicate queue attempts merge `requested_timeseries_ids` + notes.
- Observation repair status is tracked separately from AQI rebuild
  status via run/report counters:
  - `observation_backfills_attempted`
  - `observation_backfills_ok`
  - `observation_backfills_failed`
  - `aqi_rebuilds_queued_from_obs_repair`
- Dry-run safety:
  - under `--dry-run`, planned observation repair commands and planned
    AQI queue entries are reported
  - remote backfill outputs are not mutated.
- `r2_only` remains excluded from auto observation repair.

**Phase 6.7 — AQI-only health check + queueing (DONE):**

- After Phase 6.6 observation repair queueing, integrity now runs an AQI
  health pass for connector/days in the current run window where source
  observations exist.
- Connector/days already queued with `obs_repaired` in the current run
  are skipped from AQI-only queueing to avoid duplicate rebuild work.
- AQI health checks are connector/day-oriented and inspect local Dropbox
  R2 AQI connector manifests under `history/v1/aqilevels/...`:
  - manifest missing
  - manifest stale (schema/writer metadata mismatch or invalid manifest)
  - manifest empty (`source_row_count`/`total_rows` zero while source
    observations exist for that connector/day)
  - previous AQI rebuild queue status indicates failed/pending from a
    prior run
- AQI-only candidates are queued into `aqi_rebuild_queue` with:
  - `reason = aqi_health_check` (merged with existing reasons on dedupe)
  - `source_mode = live_r2`
  - `status = queued`
- Queueing is deduplicated by `(run_id, connector_id, day_utc)` with
  merged reason/note fields.
- Reports now include Phase 6.7 counters and a deterministic list of
  queued AQI-only connector/days.
- AQI-only health issues queue AQI rebuild work for
  `r2_history_obs_to_aqilevels`; they do not trigger `source_to_r2`.

**Phase 6.8 — Deduplicated AQI rebuild execution (DONE):**

- The runner now executes queued AQI rebuild work once per
  `(connector_id, day_utc)` from `aqi_rebuild_queue` for the current run.
- Phase 6.8 execution uses:
  - `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels`
  - `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`
  - `UK_AQ_BACKFILL_FORCE_REPLACE=true`
  - `UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>`
  - `UK_AQ_BACKFILL_FROM_DAY_UTC=<day>`
  - `UK_AQ_BACKFILL_TO_DAY_UTC=<day>`
- Queue row lifecycle:
  - `queued -> running -> complete`
  - `queued -> running -> failed`
  - duplicate queue rows for the same connector/day are marked `skipped`.
- Observation repair status is not changed by AQI rebuild failures; AQI
  failures remain separate repair debt.
- Dry-run emits planned AQI rebuild commands and deterministic planned
  result rows without mutating queue statuses or R2.
- Reports include:
  - `aqi_rebuilds_queued_total`
  - `aqi_rebuilds_attempted`
  - `aqi_rebuilds_complete`
  - `aqi_rebuilds_failed`
  - `aqi_rebuilds_skipped`
  - per-connector/day result rows with reasons and log paths.
- Future Phase 6.8 v2 remains open: AQI-only jobs may later use Dropbox
  backup input when safe; v1 always uses live R2.

### Phase 7 — Monitoring, limits, and reports polish (PLANNED)

Goal: enforce `--max-download-mb` and `--max-runtime-minutes` cleanly,
record top largest downloads, surface repeated-limit recommendations in
reports.

### Phase 8 — API-based source adapters (PLANNED)

Goal: UK-AIR-SOS and Breathe London canonicalisation and hashing.

---

## Open questions

These should be checked against the actual repos before implementing the
relevant phase:

1. Exact local Dropbox paths for CIC-Test and LIVE R2 history backups.
2. Exact local paths to each environment's existing backfill wrapper and env file.
3. Exact column names in the current core schema for connectors, stations,
   timeseries, pollutants/species.
   _Phase 2 note: confirmed via_
   `uk-aq-schema/schemas/ingest_db/uk_aq_core_schema.sql`. The Phase 2 import
   uses `connectors(id, connector_code, label, display_name, service_url)`,
   `stations(id, connector_id, station_ref, service_ref, label, station_name,
   station_type, la_code, pcon_code, removed_at)`,
   `timeseries(id, station_id, connector_id, timeseries_ref, label,
   phenomenon_id, ended_at)`, and `phenomena(id, label, source_label,
   pollutant_label, observed_property_id, connector_id)`.
4. Whether `stations.station_ref` is always the correct OpenAQ location ID field.
   _Phase 2 note: confirmed_ — `openaq_list_stations.py` writes
   `station_ref = str(location.id)` from the OpenAQ v3 API.
5. Whether Sensor.Community station refs are already normalised in the core tables.
   _Phase 2 note: confirmed normalised as `stations.station_ref`_ in
   `sensorcommunity_list_stations.py`. The exact format of the archive
   filename → station_ref mapping for the daily archive still needs to be
   confirmed in Phase 5.
6. Whether the existing backfill wrapper already supports
   `UK_AQ_BACKFILL_TIMESERIES_IDS` (see `scripts/uk_aq_backfill_local.sh`
   — it documents `UK_AQ_BACKFILL_TIMESERIES_IDS` and `UK_AQ_BACKFILL_TIMESERIES_ID`
   in its usage, but actual filter behaviour should be verified before Phase 4).
7. Whether source-to-R2 can consume a local cached source file directly, or
   whether cached files are initially only kept for evidence/debugging.
