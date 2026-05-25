# UK-AQ History Integrity System

## Purpose

This document describes the planned local history-integrity workflow for UK-AQ.

The system runs on the old MacBook Pro from:

```text
/Users/mikehinford/uk-aq-history-integrity/
```

It checks whether upstream historical source data has changed after it was first processed. When changed source data is detected, it records the change in SQLite and can trigger narrow backfills using the existing UK-AQ backfill tooling.

The first source adapters are:

- OpenAQ AWS archive
- Sensor.Community archive

Later source adapters may include:

- UK-AIR-SOS API/history checks
- Breathe London API/history checks

The system should support both UK-AQ environments:

- `CIC-Test`
- `LIVE`

Each environment has its own configuration, state, SQLite DB, source cache, logs, and Dropbox copy. The script code is shared.

---

## External source facts behind the design

### OpenAQ

OpenAQ AWS archive files are not guaranteed to be final immediately. OpenAQ says files are written 72 hours after the end of the day, and may be retroactively patched when data was missing due to fetch errors or historical scrapes.

Reference:

```text
https://docs.openaq.org/aws/about
```

This is why the integrity checker should avoid today/yesterday/recent incomplete days by default, but still periodically rescan older days.

### S3 metadata

AWS S3 `HeadObject` returns object metadata without returning the object body. This makes it useful as a cheap pre-check before downloading a whole source file.

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

The system should store ETag, but should not rely on ETag as a definitive content hash. ETag is useful as a change signal only.

### Sensor.Community

Sensor.Community has daily CSV archive data and monthly CSV/Parquet archive options.

References:

```text
https://archive.sensor.community/
https://forum.sensor.community/t/past-data-for-specific-sites/1589
```

Sensor.Community should use the same overall integrity model, but with an HTTP archive adapter rather than an S3 adapter.

---

## Top-level design

Use:

```text
One shared codebase
Two env profiles
Two separate SQLite DBs
Two separate state/cache/log trees
Two separate Dropbox copies
```

Do **not** create separate script forks for `CIC-Test` and `LIVE`.

The launcher should support:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile daily
```

The Python implementation should receive the selected env config from the shell launcher.

---

## Required local directory layout

The root directory must be:

```text
/Users/mikehinford/uk-aq-history-integrity/
```

Recommended layout:

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
      source-cache/
        openaq/
        sensor-community/
      tmp/
      logs/
      reports/
      locks/

    LIVE/
      uk_aq_history_integrity.sqlite
      source-cache/
        openaq/
        sensor-community/
      tmp/
      logs/
      reports/
      locks/
```

The live SQLite DBs should stay outside Dropbox during writes.

After a successful run, copy the closed SQLite DB into the relevant Dropbox destination.

---

## Environment profiles

### CIC-Test env file

Path:

```text
/Users/mikehinford/uk-aq-history-integrity/env/CIC-Test.env
```

Example:

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

UK_AQ_BACKFILL_WRAPPER="/PATH/TO/CIC-Test/uk_aq_backfill_local.sh"
UK_AQ_BACKFILL_ENV_FILE="/PATH/TO/CIC-Test/backfill.env"
```

### LIVE env file

Path:

```text
/Users/mikehinford/uk-aq-history-integrity/env/LIVE.env
```

Example:

```bash
UK_AQ_ENV_NAME="LIVE"

UK_AQ_HISTORY_INTEGRITY_ROOT="/Users/mikehinford/uk-aq-history-integrity"
UK_AQ_HISTORY_INTEGRITY_STATE_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE"
UK_AQ_HISTORY_INTEGRITY_DB_PATH="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/uk_aq_history_integrity.sqlite"
UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/source-cache"
UK_AQ_HISTORY_INTEGRITY_TMP_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/tmp"
UK_AQ_HISTORY_INTEGRITY_LOG_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/logs"
UK_AQ_HISTORY_INTEGRITY_REPORT_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/reports"
UK_AQ_HISTORY_INTEGRITY_LOCK_DIR="/Users/mikehinford/uk-aq-history-integrity/state/LIVE/locks"

UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/uk-aq-history-integrity/uk_aq_history_integrity.sqlite"

UK_AQ_R2_HISTORY_DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/r2-history"
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT="/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/r2-history/history/v1/core"

UK_AQ_BACKFILL_WRAPPER="/PATH/TO/LIVE/uk_aq_backfill_local.sh"
UK_AQ_BACKFILL_ENV_FILE="/PATH/TO/LIVE/backfill.env"
```

---

## Why use separate DBs for CIC-Test and LIVE?

Use one DB per environment:

```text
state/CIC-Test/uk_aq_history_integrity.sqlite
state/LIVE/uk_aq_history_integrity.sqlite
```

Do not use one combined DB with an `environment` column.

Reasons:

- CIC-Test and LIVE have different R2 history storage.
- CIC-Test and LIVE have different Dropbox backup paths.
- Connector IDs, station IDs, and timeseries IDs may differ.
- Backfill credentials and env files differ.
- Separate DBs reduce the risk of cross-environment repairs.

The script must still include environment guardrails.

---

## Environment safety guardrails

The launcher and Python script must refuse to run if config appears crossed.

Hard-fail examples:

```text
--env LIVE but UK_AQ_ENV_NAME=CIC-Test
--env CIC-Test but UK_AQ_ENV_NAME=LIVE

--env LIVE but any configured path contains /CIC-Test/
--env CIC-Test but any configured path contains /LIVE/

LIVE DB path points under state/CIC-Test/
CIC-Test DB path points under state/LIVE/

LIVE Dropbox copy path contains /CIC-Test/
CIC-Test Dropbox copy path contains /LIVE/

LIVE core snapshot Dropbox root contains /CIC-Test/
CIC-Test core snapshot Dropbox root contains /LIVE/

LIVE run uses CIC-Test backfill env file
CIC-Test run uses LIVE backfill env file
```

The error should be clear, for example:

```text
ERROR: UK_AQ_ENV_NAME=LIVE but UK_AQ_HISTORY_INTEGRITY_DB_PATH contains /CIC-Test/. Refusing to run.
```

---

## Script interface

The main script should be:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
```

The shell script should be a thin launcher that:

1. Parses `--env`.
2. Loads the matching env file.
3. Validates environment/path guardrails.
4. Creates required directories.
5. Sets a lock to prevent overlapping runs for that environment.
6. Calls the Python implementation.

The Python script should be:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

Example commands:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --profile weekly
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env LIVE --source openaq --from-day 2026-04-01 --to-day 2026-04-30 --dry-run
```

Required options:

```text
--env CIC-Test|LIVE
--profile daily|weekly|monthly|manual
```

Useful optional options:

```text
--source openaq|sensor-community|all
--from-day YYYY-MM-DD
--to-day YYYY-MM-DD
--dry-run
--check-only
--run-backfill
--max-download-mb N
--max-runtime-minutes N
--verbose
```

---

## Scheduling profiles

Default date windows:

```text
daily:
  from = today - 21 days
  to   = today - 4 days

weekly:
  from = today - 120 days
  to   = today - 4 days

monthly:
  from = today - 730 days
  to   = today - 4 days
```

The `today - 4 days` upper bound gives a buffer beyond OpenAQ's 72-hour publication delay.

Manual runs may specify exact `--from-day` and `--to-day`.

---

## Cron examples

Stagger CIC-Test and LIVE so they do not overlap.

```cron
# CIC-Test daily check
30 4 * * * /Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile daily >> /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/logs/cron.log 2>&1

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

Each environment has its own SQLite DB.

### Core snapshot import tables

The script should import core data from the local Dropbox R2 history backup, not from Supabase or live R2.

Source:

```text
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
```

Purpose:

```text
Avoid Supabase egress
Avoid live R2 reads
Allow local station/timeseries lookup
```

Tables to import or derive:

```text
core_snapshot_imports
core_connectors_snapshot
core_stations_snapshot
core_timeseries_snapshot
core_pollutants_snapshot
source_station_timeseries_lookup
```

The exact imported columns should follow the current core schema.

The lookup table should allow:

```text
source_key + station_ref/location_id/sensor_ref
  -> connector_id
  -> station_id
  -> timeseries_id(s)
```

For OpenAQ:

```text
OpenAQ location_id = stations.station_ref
```

For Sensor.Community:

```text
Sensor.Community sensor ID / station ref = stations.station_ref or source-specific ref
```

depending on the existing UK-AQ schema.

### Source file state

Generic source file state table:

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
```

### Run metrics table

Track cost/time:

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

---

## Source-cache behaviour

When a file needs to be downloaded for hashing:

1. Download to a temp path under the environment tmp dir.
2. Compute compressed/downloaded hash.
3. If applicable, compute uncompressed/canonical hash.
4. Compare to SQLite state.
5. If the canonical hash is unchanged, delete the temp file.
6. If the canonical hash changed, move the file into source-cache and keep it for repair/debugging.

Example OpenAQ cache path:

```text
/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/source-cache/openaq/locationid=12345/year=2026/month=05/location-12345-20260507.csv.gz
```

Example Sensor.Community cache path:

```text
/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/source-cache/sensor-community/2026-05-07/<filename>.csv
```

Do not cache unchanged downloads permanently unless explicitly configured.

---

## OpenAQ adapter

### Remote source

OpenAQ S3 archive.

Object pattern:

```text
records/csv.gz/locationid=<LOCATION_ID>/year=<YYYY>/month=<MM>/location-<LOCATION_ID>-<YYYYMMDD>.csv.gz
```

### Metadata check

For each expected file:

1. Run S3 HEAD metadata check.
2. Store/compare:
   - ETag
   - ContentLength
   - LastModified
3. If new file or metadata changed, download the file.
4. Compute:
   - `sha256_downloaded` for `.csv.gz`
   - `sha256_uncompressed` for decompressed CSV bytes
5. Use `sha256_uncompressed` as the real change detector.
6. Keep changed files in source-cache.
7. Delete unchanged temp downloads.

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

---

## Sensor.Community adapter

### Remote source

Sensor.Community archive:

```text
https://archive.sensor.community/YYYY-MM-DD/
```

Monthly archive options also exist:

```text
https://archive.sensor.community/csv_per_month/
https://archive.sensor.community/parquet/
```

The first implementation can target the daily archive.

### Metadata check

For each relevant Sensor.Community archive file:

1. Use HTTP HEAD where supported.
2. Store/compare:
   - ETag if present
   - Content-Length if present
   - Last-Modified if present
3. If new or metadata changed, download the file.
4. Compute canonical content hash.
5. Record state/event rows in SQLite.
6. Resolve affected station/timeseries IDs using local core lookup.
7. Trigger narrow backfills where possible.

### Difference from OpenAQ

Sensor.Community may not map one remote file to exactly one station/day in the same way OpenAQ does. The adapter should support:

```text
one file -> one station/day
one file -> many stations/day
one file -> one date range
```

The generic DB model should therefore store both:

```text
day_utc
date_range_start_utc
date_range_end_utc
```

---

## API-based future adapters

UK-AIR-SOS and Breathe London may require API snapshot checking rather than archive-file checking.

The same SQLite DB should be used per environment, but with source-specific adapters.

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

At the start of each run:

1. Locate the latest core snapshot manifest in the configured Dropbox R2 history backup.
2. Compare its path/hash with the latest `core_snapshot_imports` row.
3. If unchanged, reuse existing SQLite core lookup.
4. If changed, import required core tables.
5. Rebuild `source_station_timeseries_lookup`.
6. Record an import event.

This should happen once per environment DB, not once per source adapter.

---

## Backfill workflow

Changed source files should trigger only narrow repairs.

Avoid broad connector/day force-replace unless no narrower mapping exists.

Preferred OpenAQ repair:

```text
source_key=openaq
location_id=12345
day_utc=2026-04-02
  -> timeseries IDs [9001, 9002, 9003]
  -> source_to_r2 only for those timeseries IDs/day
```

The script should support:

```text
check-only mode:
  detect changes and write ledger, but do not run backfill

dry-run mode:
  show what would be checked/downloaded/repaired, do not mutate remote outputs

run-backfill mode:
  call existing backfill wrapper
```

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

Do not run SQLite directly from Dropbox.

Reason:

SQLite may use sidecar files during writes:

```text
.sqlite-wal
.sqlite-shm
```

Dropbox can sync those while SQLite is writing, which risks conflicted copies.

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

Therefore, the integrity checker does not need to separately back up R2 history output.

It only needs to:

1. Detect upstream source changes.
2. Trigger appropriate repair.
3. Record what happened.

---

## Download and runtime monitoring

This is important enough to include from the first implementation.

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

Add soft limits:

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

Write per-run reports:

```text
/Users/mikehinford/uk-aq-history-integrity/state/<ENV>/reports/YYYY-MM-DDTHHMMSSZ-summary.json
/Users/mikehinford/uk-aq-history-integrity/state/<ENV>/reports/YYYY-MM-DDTHHMMSSZ-summary.md
```

The report should include:

```text
env
profile
source
date range
downloaded MB
runtime
changed files
backfills triggered
errors/warnings
top largest downloads
```

---

## Locking

Prevent overlapping runs per environment.

Lock path:

```text
/Users/mikehinford/uk-aq-history-integrity/state/<ENV>/locks/uk-aq-history-integrity.lock
```

The script should refuse to run if a live lock exists.

If a stale lock exists, the script should report it clearly and require manual cleanup unless a `--force-unlock-stale` option is added later.

CIC-Test and LIVE should have separate locks.

---

## Logging

Write logs per environment:

```text
/Users/mikehinford/uk-aq-history-integrity/state/<ENV>/logs/
```

Suggested log files:

```text
run-YYYY-MM-DDTHHMMSSZ.log
cron.log
```

Logs should include:

```text
env
profile
source
date window
core snapshot used
files checked
files downloaded
files changed
downloaded MB
runtime
backfill calls
warnings
errors
```

---

## Failure behaviour

Fail safe.

Rules:

```text
Do not delete source-cache files unless they are confirmed unchanged temp downloads.
Do not mark files as successfully checked if download/hash failed.
Do not trigger backfill unless source change is confirmed.
Do not copy DB to Dropbox if the run fails before DB close.
Do not proceed if env/path guardrails fail.
Do not use broad connector/day force-replace unless explicitly configured.
```

---

## Phased Claude Code implementation plan

### Phase 1 — Environment-profile launcher and SQLite skeleton

Goal:

Create the shared launcher and environment-profile structure.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 1 of the UK-AQ History Integrity system using the system doc:

docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- Add scripts/uk-aq-history-integrity.sh as a thin shell launcher.
- Add scripts/uk-aq-history-integrity.py as the Python implementation entrypoint.
- The intended deployed root on the MacBook Pro is /Users/mikehinford/uk-aq-history-integrity/.
- Support --env CIC-Test|LIVE.
- Load env files from /Users/mikehinford/uk-aq-history-integrity/env/<ENV>.env when deployed.
- Add example env files or templates for CIC-Test and LIVE.
- Create/use separate state dirs:
  /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/
  /Users/mikehinford/uk-aq-history-integrity/state/LIVE/
- Create/use separate SQLite DBs:
  state/CIC-Test/uk_aq_history_integrity.sqlite
  state/LIVE/uk_aq_history_integrity.sqlite
- Add environment guardrails to prevent LIVE/CIC-Test paths being crossed.
- Create required directories: source-cache, tmp, logs, reports, locks.
- Add basic SQLite schema creation for integrity_runs, source_file_state, source_file_events, core_snapshot_imports.
- Add --dry-run and --profile daily|weekly|monthly|manual argument handling.
- No OpenAQ or Sensor.Community downloading yet.
- Add clear logging and a run summary.
- Keep code simple, testable, and fail-safe.
```

### Phase 2 — Core snapshot import from Dropbox R2 backup

Goal:

Import core tables from local Dropbox R2 history backup into the environment SQLite DB.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 2 of the UK-AQ History Integrity system.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phase 1.

Requirements:
- At run start, locate the latest core snapshot under UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT.
- Do not query Supabase.
- Do not read live R2.
- Import the required core tables from the Dropbox R2 history backup into SQLite.
- Use the attached/current UK-AQ core schema to identify the relevant columns for connectors, stations, timeseries, pollutants/species if needed.
- Build a derived lookup table that maps source_key + station_ref/source_location_id to connector_id, station_id, and timeseries_id(s).
- For OpenAQ, location_id should map through stations.station_ref.
- Record imports in core_snapshot_imports.
- If the core snapshot manifest/path/hash is unchanged, reuse existing imported lookup.
- Add a check-only CLI mode that imports/rebuilds lookup and exits.
- Add tests or dry-run output showing which snapshot was selected and how many rows were imported.
```

### Phase 3 — OpenAQ source adapter

Goal:

Check OpenAQ AWS archive metadata/hash and record source-file changes.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 3 of the UK-AQ History Integrity system: the OpenAQ adapter.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- Add --source openaq.
- Use OpenAQ S3 archive object pattern:
  records/csv.gz/locationid=<LOCATION_ID>/year=<YYYY>/month=<MM>/location-<LOCATION_ID>-<YYYYMMDD>.csv.gz
- For each relevant OpenAQ location/day from the local core lookup, perform S3 HeadObject metadata check.
- Store and compare ETag, ContentLength, and LastModified in source_file_state.
- Treat ETag as a change signal only, not as proof of content identity.
- If the file is new or metadata changed, download to the env tmp dir.
- Compute sha256_downloaded for the .csv.gz bytes.
- Decompress and compute sha256_uncompressed for the CSV bytes.
- If sha256_uncompressed is unchanged, delete the temp download.
- If sha256_uncompressed changed, move the downloaded file into the env source-cache/openaq/ path and record a source_file_events row.
- Do not run backfill yet unless explicitly passed --run-backfill, and even then initially just print the planned backfill command.
- Track downloaded bytes and runtime in integrity_runs.
- Respect --max-download-mb and --max-runtime-minutes.
- Produce a JSON and Markdown run report.
```

### Phase 4 — Narrow backfill runner

Goal:

Use changed source files to trigger existing backfill wrapper with timeseries filters.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 4 of the UK-AQ History Integrity system: narrow backfill runner.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- For changed OpenAQ files, resolve location_id/station_ref to timeseries IDs using the local SQLite lookup.
- Call the existing local backfill wrapper configured by UK_AQ_BACKFILL_WRAPPER and UK_AQ_BACKFILL_ENV_FILE.
- Pass:
  UK_AQ_BACKFILL_RUN_MODE=source_to_r2
  UK_AQ_BACKFILL_FORCE_REPLACE=true
  UK_AQ_BACKFILL_TIMESERIES_IDS=<comma-separated IDs>
  UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
  UK_AQ_BACKFILL_TO_DAY_UTC=<day>
- Support UK_AQ_BACKFILL_TIMESERIES_ID and UK_AQ_BACKFILL_TIMESERIES_IDS in the wrapper if not already supported.
- Record backfill_triggered, backfill_timeseries_ids, and backfill_status in SQLite.
- Keep --dry-run safe: print commands, do not execute.
- Do not use broad connector/day force-replace unless a specific explicit option is added.
```

### Phase 5 — Sensor.Community adapter

Goal:

Add Sensor.Community archive checking using the same DB and reporting.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 5 of the UK-AQ History Integrity system: Sensor.Community adapter.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- Add --source sensor-community.
- Use the Sensor.Community daily archive at https://archive.sensor.community/YYYY-MM-DD/.
- Use HTTP HEAD where possible to collect ETag, Content-Length, and Last-Modified.
- Download and hash files only when new or metadata changed.
- Compute a canonical content hash.
- Store state and events in the same generic source_file_state/source_file_events tables.
- Support one remote file affecting one or many station/timeseries/day records.
- Use local core lookup from SQLite, not Supabase or live R2.
- Track downloaded bytes/runtime and include in reports.
- Do not run broad repairs by default.
```

### Phase 5.5 — Adapter concurrency

Goal:

Speed up cold runs by issuing parallel HEAD/GET requests instead of strict
sequential. A typical CIC-Test daily window is ~14k OpenAQ HEADs;
sequential takes hours, parallel should take minutes.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 5.5 of the UK-AQ History Integrity system: adapter
concurrency.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phase 5.

Requirements:
- Replace the strict sequential per-file loop in check_openaq and
  check_sensor_community with a bounded thread pool
  (concurrent.futures.ThreadPoolExecutor).
- Worker count is configurable via --concurrency N (default 8); env var
  UK_AQ_HISTORY_INTEGRITY_CONCURRENCY may set the default.
- Workers do HEAD/GET/hash work. SQLite writes (state upsert + event
  insert) happen on the main thread to keep one writer and preserve the
  per-file commit invariant.
- LimitTracker becomes thread-safe. should_stop() is called at submit
  time AND inside each worker before issuing the request; once tripped,
  no new tasks are scheduled and in-flight tasks finish cleanly.
- Order of completion is non-deterministic; the report should not assume
  any ordering. Sort the changed_files list before emitting the report.
- Backfill batching (Phase 4 Pass 2) is unaffected: the batched phase
  runs after the parallel scan completes.
- Polite default: small per-request timeout already present; no need to
  add jitter unless the archive proves rate-limited.
- Update docs and the operational notes.
```

### Phase 6.5 — R2 cross-check (per-timeseries row counts)

Goal:

Detect missing or partial observations in R2 history by comparing
per-(timeseries, day) row counts between two cheap-to-read sources of
truth: the R2 history index manifest, and a count derived from the
upstream archive file at ingest time. No parquet reads required.

Motivation:

Phases 3 / 5 detect when an upstream source changes after we last
processed it. They do not detect cases where R2 history has fewer rows
than the upstream archive provides (silent ingest drops, partial
backfills, deleted parquet files, etc.). Phase 6.5 closes that gap.

Done in two passes so the foundation lands before the verification
pass needs it.

#### Pass A — Foundation

Prompt:

```text
Repo: uk-aq-ops (R2 builder) + uk-aq-ops (integrity adapters).

Please implement Phase 6.5 Pass A of the UK-AQ History Integrity system.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:

1. R2 history index builder change
   - In scripts/backup_r2/uk_aq_build_r2_history_index.mjs (or wherever
     the observations_timeseries/day_utc=Y/connector_id=X/manifest.json
     is generated), aggregate per-timeseries row counts across the
     connector/day's parquet files and add them to the manifest:
       timeseries_row_counts: { "<ts_id>": <count>, ... }
   - Keep schema_version bumped or add a feature flag so older
     consumers don't break.
   - Backfill old day manifests opportunistically (optional flag), so
     historical days gain counts on next index rebuild.

2. History integrity adapters source-side row counts
   - New normalised SQLite table:
       source_file_timeseries_counts (
         source_file_key TEXT NOT NULL,
         timeseries_id   INTEGER NOT NULL,
         row_count       INTEGER NOT NULL,
         counted_at_utc  TEXT NOT NULL,
         PRIMARY KEY (source_file_key, timeseries_id)
       )
   - On every source download (first_seen / changed / reappeared), parse
     the CSV/csv.gz once and compute per-timeseries row counts. For
     OpenAQ each row maps to a single parameter -> timeseries; for
     Sensor.Community each row contributes to N timeseries (one per
     non-null measurement column).
   - Delete + re-insert rows for the affected source_file_key in one
     transaction so partial state is impossible.
   - Counts persist across runs; unchanged-metadata HEADs reuse them.
   - No automatic deletion of cached source files beyond current rules.

3. Tests / verification
   - Synthetic OpenAQ CSV with 24 PM2.5 rows + 12 NO2 rows -> table has
     two entries with correct counts.
   - Synthetic SC CSV with 144 rows × 2 measurement columns -> two
     timeseries entries each with row_count=144.

4. Docs
   - Update system doc with the new table + R2 manifest field.
   - No CLI flag changes in Pass A.

Pass A leaves the comparison/alerting to Pass B; this pass just records
the data.
```

#### Pass B — Cross-check pass

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 6.5 Pass B of the UK-AQ History Integrity system.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phase 6.5 Pass A (source_file_timeseries_counts populated;
R2 manifests carry timeseries_row_counts).

Requirements:

1. After the OpenAQ and Sensor.Community scans complete, run a
   cross-check pass:
   - For each (connector_id, day) in the window, read the R2 manifest
     from UK_AQ_R2_HISTORY_DROPBOX_ROOT (no live R2; respect the
     local-Dropbox-backup-only rule).
   - For each (timeseries_id, day) that has rows in
     source_file_timeseries_counts, look up the R2 count from the
     manifest's timeseries_row_counts.
   - Record the comparison in a new SQLite table:
       cross_checks (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id INTEGER NOT NULL,
         env_name TEXT NOT NULL,
         connector_id INTEGER NOT NULL,
         day_utc TEXT NOT NULL,
         timeseries_id INTEGER NOT NULL,
         source_row_count INTEGER,
         r2_row_count INTEGER,
         delta INTEGER,
         status TEXT NOT NULL,
         checked_at_utc TEXT NOT NULL,
         notes TEXT
       )
   - status values:
       ok               — counts match
       source_only      — source has rows, R2 has none / no manifest
       r2_only          — R2 has rows, source has none
       mismatch         — both have rows, counts differ
       r2_manifest_missing — manifest not found for the (connector, day)
   - Include cross_checks counters in the run row and the report:
       cross_checks_total, cross_checks_ok, cross_checks_mismatch,
       cross_checks_source_only, cross_checks_r2_only,
       cross_checks_r2_manifest_missing.
   - Sort the report's per-discrepancy list deterministically.

2. CLI
   - Add --skip-cross-check to disable the pass (debug/recovery).
   - Cross-check runs by default; no opt-in required.

3. Tests
   - Synthetic manifest with matching/mismatched counts; verify each
     status path.

4. Docs
   - Update system doc Implementation Status; mark Phase 6.5 DONE when
     both passes land.
```


---

## Additional Phase — Integrity-specific backfill wrapper and worker output scopes

### Goal

Add an integrity-specific backfill wrapper so the history-integrity system can safely orchestrate observation repairs and AQI rebuilds without changing the normal/manual backfill workflow.

The key design rule is:

```text
source_to_r2 repairs observations.
r2_history_obs_to_aqilevels rebuilds AQI levels.
```

The existing general/manual launcher should remain available:

```text
scripts/uk_aq_backfill_local.sh
```

A new integrity-specific launcher should be added under the history-integrity script area:

```text
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

This wrapper should call the same worker implementation as `uk_aq_backfill_local.sh`, but it should use safer integrity defaults and explicit output scopes.

---

### Why this phase is needed

The current `source_to_r2` worker path can rebuild/write AQI levels as part of an observations backfill. That causes two problems for the integrity workflow:

1. Observation repair can be blocked if AQI rows are empty.
2. AQI may be rebuilt multiple times for the same connector/day if several targeted observation backfills happen in one integrity run.

The new integrity workflow separates these concerns:

```text
Phase 6.6:
  repair observations only
  record affected connector-days in an AQI rebuild queue

Phase 6.7:
  inspect AQI-only health issues
  add extra connector-days to the same AQI rebuild queue

Phase 6.8:
  rebuild AQI once per queued connector/day
```

To make that safe, the worker needs an explicit way to run `source_to_r2` as observations-only.

---

### Required worker-level change

Add worker-level support for an output scope setting, for example:

```bash
UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
UK_AQ_BACKFILL_OUTPUT_SCOPE=default
```

Recommended behaviour:

```text
default:
  Existing/manual behaviour, for backwards compatibility.

observations_only:
  source_to_r2 writes observations only.
  It must not build, merge, export, or manifest-write AQI levels.
  The skip guard must only depend on obsHistoryRows.length.

aqilevels_only:
  Only valid with r2_history_obs_to_aqilevels.
  Rebuilds AQI levels from existing R2 observations.
```

For Phase 6.6, the integrity wrapper should call:

```bash
UK_AQ_BACKFILL_RUN_MODE=source_to_r2
UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_TIMESERIES_IDS=<affected-timeseries-ids>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

For Phase 6.8, the integrity wrapper should call:

```bash
UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_CONNECTOR_IDS=<connector-id>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

---

### Required integrity wrapper behaviour

Create:

```text
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

The script should be a near-copy of `scripts/uk_aq_backfill_local.sh`, but with integrity-specific safety defaults.

It should support two explicit operations:

```bash
uk_aq_integrity_backfill.sh observs-only
uk_aq_integrity_backfill.sh aqi-only
```

or equivalent flags:

```bash
uk_aq_integrity_backfill.sh --observs-only
uk_aq_integrity_backfill.sh --aqi-only
```

Recommended interface:

```bash
uk_aq_integrity_backfill.sh \
  --env CIC-Test \
  --observs-only \
  --connector-id 6 \
  --timeseries-ids 3742,3811 \
  --from-day 2026-05-08 \
  --to-day 2026-05-08
```

```bash
uk_aq_integrity_backfill.sh \
  --env CIC-Test \
  --aqi-only \
  --connector-id 6 \
  --from-day 2026-05-08 \
  --to-day 2026-05-08
```

The wrapper should:

1. Load the correct environment/backfill env file.
2. Enforce CIC-Test/LIVE path guardrails.
3. Refuse to run if both `--observs-only` and `--aqi-only` are passed.
4. Refuse `--observs-only` without `--timeseries-ids`.
5. Refuse `--aqi-only` without `--connector-id`.
6. Pass `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only` for observs-only mode.
7. Pass `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only` for AQI-only mode.
8. Preserve clear logs and exit codes so history-integrity can record success/failure.

---

### Why keep `uk_aq_backfill_local.sh`?

Keep the existing script for manual/operator runs.

Manual runs may still want broad connector/day behaviour, diagnostics, or existing compatibility. The new wrapper is for the stricter integrity workflow only.

This avoids making the general backfill entrypoint more confusing while giving history-integrity a safer, narrower contract.

---

### Phase relationship

This phase should be implemented before or as part of Phase 6.6.

Recommended placement in the plan:

```text
Phase 6.5 — R2 cross-check
Additional Phase — Integrity-specific backfill wrapper and worker output scopes
Phase 6.6 — Observation repair queue and execution
Phase 6.7 — AQI-only health check and queueing
Phase 6.8 — Deduplicated AQI rebuild execution
Phase 7 — Monitoring, limits, and reports polish
```

---

### Codex prompt

```text
Repo: uk-aq-ops.

Please implement an additional setup phase for the UK-AQ History Integrity backfill orchestration.

Context:
- The history-integrity workflow now separates observation repair from AQI rebuild.
- `source_to_r2` should be able to run as observations-only for integrity repairs.
- `r2_history_obs_to_aqilevels` should remain the owner of AQI rebuilds.
- The existing manual/general script `scripts/uk_aq_backfill_local.sh` should remain available for manual runs.
- Add an integrity-specific wrapper under:
  `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`

Requirements:

1. Worker output-scope support
   - Add support for an env var such as:
       `UK_AQ_BACKFILL_OUTPUT_SCOPE`
   - Supported values:
       `default`
       `observations_only`
       `aqilevels_only`
   - Default should preserve the current/manual behaviour unless explicitly overridden.

2. source_to_r2 observations-only mode
   - When:
       `UK_AQ_BACKFILL_RUN_MODE=source_to_r2`
       and `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only`
     the worker must write observations only.
   - It must not build, preserve, merge, export, or manifest-write AQI levels.
   - The skip guard must only skip when `obsHistoryRows.length === 0`.
   - Empty AQI rows must never block observation repair in observations-only mode.
   - Structured logs should clearly include:
       `output_scope: "observations_only"`
       rows written
       affected connector/day
       requested timeseries IDs

3. r2_history_obs_to_aqilevels AQI-only mode
   - When:
       `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels`
       and `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`
     the worker should rebuild AQI from R2 observations using the existing logic.
   - This should be compatible with connector/day rebuilds.
   - Structured logs should include:
       `output_scope: "aqilevels_only"`
       connector/day
       rows read/written
       manifest status

4. Invalid combinations
   - Refuse invalid combinations clearly:
       `observations_only` with `r2_history_obs_to_aqilevels` unless deliberately supported later.
       `aqilevels_only` with `source_to_r2`.
       unknown output scope values.
   - Error messages should be explicit and should fail before mutating R2.

5. Add integrity wrapper
   - Add:
       `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
   - It should be a thin launcher around the existing local backfill worker, not a fork of the worker logic.
   - It should support:
       `--env CIC-Test|LIVE`
       `--observs-only`
       `--aqi-only`
       `--connector-id N`
       `--timeseries-ids A,B,C`
       `--from-day YYYY-MM-DD`
       `--to-day YYYY-MM-DD`
       `--dry-run` where supported
   - It should load the correct environment/backfill env file and enforce CIC-Test/LIVE guardrails.
   - It should refuse:
       both `--observs-only` and `--aqi-only`
       neither `--observs-only` nor `--aqi-only`
       `--observs-only` without `--timeseries-ids`
       `--aqi-only` without `--connector-id`
   - For observs-only mode it should export:
       `UK_AQ_BACKFILL_RUN_MODE=source_to_r2`
       `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only`
       `UK_AQ_BACKFILL_FORCE_REPLACE=true`
       `UK_AQ_BACKFILL_TIMESERIES_IDS=<ids>`
       `UK_AQ_BACKFILL_FROM_DAY_UTC=<from>`
       `UK_AQ_BACKFILL_TO_DAY_UTC=<to>`
   - For AQI-only mode it should export:
       `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels`
       `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`
       `UK_AQ_BACKFILL_FORCE_REPLACE=true`
       `UK_AQ_BACKFILL_CONNECTOR_IDS=<connector>`
       `UK_AQ_BACKFILL_FROM_DAY_UTC=<from>`
       `UK_AQ_BACKFILL_TO_DAY_UTC=<to>`

6. Tests / verification
   - Add a dry-run or test path showing that observs-only mode does not call AQI export/manifest writing.
   - Add a dry-run or test path showing that AQI-only mode calls `r2_history_obs_to_aqilevels` and does not run source acquisition.
   - Run the relevant type checks.
   - Update docs or operational notes so Phase 6.6/6.8 know to call the new integrity wrapper.

Important:
- Do not duplicate the worker implementation.
- Keep one worker implementation and two shell entrypoints:
    manual/general: `scripts/uk_aq_backfill_local.sh`
    integrity-specific: `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
- Keep the new wrapper conservative and fail-safe.
```


---

### Phase 6.6 — Observation repair queue and execution

Goal:

Repair observation history discrepancies found by Phase 6.5, but do **not** rebuild AQI immediately after each individual backfill. Instead, record the affected connector/day pairs into a deduplicated AQI rebuild queue for Phase 6.8.

Motivation:

Phase 6.5 detects observation mismatches by comparing source-side per-timeseries row counts with the R2 observations history index manifest from the local Dropbox R2 history backup. When a source file has changed, or when the cross-check finds `mismatch` / `source_only` / `r2_manifest_missing`, the correct repair is a targeted `source_to_r2` observation backfill.

However, AQI should not be rebuilt inline after each individual targeted backfill. A single connector/day may have several affected timeseries batches in the same integrity run. Rebuilding AQI after each batch could rebuild the same connector/day multiple times.

Design:

1. Run the existing observation repair logic from Phase 6.5 outputs.
2. For each affected source/day/timeseries set, call the existing backfill wrapper with:

```bash
UK_AQ_BACKFILL_RUN_MODE=source_to_r2
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_TIMESERIES_IDS=<comma-separated affected timeseries IDs>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

3. `source_to_r2` should be treated as the observation repair path. It should not block observation writes just because AQI rows are empty.
4. After each successful observation repair, add the affected `(connector_id, day_utc)` to an AQI rebuild queue.
5. Deduplicate the queue by `(connector_id, day_utc)`.
6. For Phase 6.6 queued jobs, set:

```text
reason = obs_repaired
source_mode = live_r2
```

7. Use `live_r2` because these observations have just been repaired and the Dropbox R2 history backup may not have caught up yet.
8. Record observation backfill status separately from AQI rebuild status. An observation repair can succeed even if the later AQI rebuild fails.
9. Persist the AQI rebuild queue to SQLite before Phase 6.8 runs, so a later run can recover pending AQI rebuilds if the process stops after observation repair.

Suggested SQLite table:

```sql
CREATE TABLE IF NOT EXISTS aqi_rebuild_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,

  reason TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  status TEXT NOT NULL,

  requested_timeseries_ids TEXT,
  notes TEXT,

  created_at_utc TEXT NOT NULL,
  started_at_utc TEXT,
  finished_at_utc TEXT,

  UNIQUE(run_id, connector_id, day_utc)
);
```

Initial status values:

```text
queued
running
complete
failed
skipped
```

If the same `(run_id, connector_id, day_utc)` is queued more than once, keep one row and append/merge the affected timeseries IDs and notes. Even though Phase 6.7 should skip Phase 6.6 queued connector-days, keep this deduplication as a safety check.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 6.6 of the UK-AQ History Integrity system: observation repair queue and execution.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phase 6.5 Pass B.

Context:
Phase 6.5 now detects observation discrepancies by comparing source-side per-timeseries row counts with the R2 observations history index manifest from the local Dropbox R2 history backup. Observation discrepancies are statuses such as mismatch, source_only, and r2_manifest_missing.

Requirements:

1. Observation repair execution
   - For observation discrepancies that require repair, run the existing local backfill wrapper in targeted observation mode:
       UK_AQ_BACKFILL_RUN_MODE=source_to_r2
       UK_AQ_BACKFILL_FORCE_REPLACE=true
       UK_AQ_BACKFILL_TIMESERIES_IDS=<comma-separated affected timeseries IDs>
       UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
       UK_AQ_BACKFILL_TO_DAY_UTC=<day>
   - Group compatible repairs where safe, but do not broaden to whole connector/day observation replacement unless explicitly configured.
   - Preserve dry-run behaviour: print planned commands but do not execute.

2. AQI rebuild queue
   - Add a SQLite table aqi_rebuild_queue if it does not already exist:
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id INTEGER NOT NULL,
       env_name TEXT NOT NULL,
       connector_id INTEGER NOT NULL,
       day_utc TEXT NOT NULL,
       reason TEXT NOT NULL,
       source_mode TEXT NOT NULL,
       status TEXT NOT NULL,
       requested_timeseries_ids TEXT,
       notes TEXT,
       created_at_utc TEXT NOT NULL,
       started_at_utc TEXT,
       finished_at_utc TEXT,
       UNIQUE(run_id, connector_id, day_utc)
   - After a successful source_to_r2 observation repair, queue the affected connector/day for AQI rebuild.
   - For these rows use:
       reason = obs_repaired
       source_mode = live_r2
       status = queued
   - Deduplicate by (run_id, connector_id, day_utc). If a duplicate is queued, merge affected timeseries IDs and append a note rather than inserting a second row.
   - Persist the queue before Phase 6.8 runs so pending AQI rebuilds survive a later failure.

3. Status separation
   - Record observation backfill status separately from AQI rebuild status.
   - Do not mark an observation repair as failed just because the later AQI rebuild fails.
   - Reports should distinguish:
       observation_backfills_attempted
       observation_backfills_ok
       observation_backfills_failed
       aqi_rebuilds_queued_from_obs_repair

4. Backfill-side expectation
   - source_to_r2 is the observation repair path.
   - It must not skip writing observations simply because generated AQI rows are empty.
   - If needed, update the backfill worker so source_to_r2 targeted repair writes observations only, and leaves AQI rebuild responsibility to r2_history_obs_to_aqilevels.

5. Tests / verification
   - Synthetic cross-check rows for two timeseries on the same connector/day should produce targeted source_to_r2 repairs but only one aqi_rebuild_queue row.
   - Dry-run should show planned source_to_r2 commands and planned AQI queue entries without mutating remote outputs.
   - A failed source_to_r2 repair must not queue an AQI rebuild for that connector/day.

6. Docs
   - Update the system doc to describe Phase 6.6.
   - Explain that AQI rebuilds are queued and deduplicated, not run immediately after every observation backfill.
```

---

### Phase 6.7 — AQI-only health check and queueing

Goal:

Find AQI history problems that are **not** caused by observation mismatches already repaired in Phase 6.6, and add those connector/day pairs to the same AQI rebuild queue.

Motivation:

Some days may have correct observations but stale, missing, incomplete, or failed AQI output. These should not trigger `source_to_r2`, because the observations do not need source repair. Instead, they should trigger `r2_history_obs_to_aqilevels`.

This pass should avoid duplicating work already queued by Phase 6.6.

Design:

1. Build a set of connector/days already queued by Phase 6.6 in the current run.
2. Inspect AQI history health for connector/days in the checked window.
3. Skip connector/days already queued from Phase 6.6.
4. Detect AQI-only rebuild candidates, for example:

```text
AQI manifest missing
AQI manifest stale writer/schema/algorithm version
AQI manifest empty when observations exist
previous AQI rebuild failed or pending
```

5. Do **not** compare observation row counts directly to AQI row counts as if they should be equal. They are different datasets.
6. Record AQI-only candidates into `aqi_rebuild_queue` with:

```text
reason = aqi_health_check
source_mode = live_r2
status = queued
```

7. For the first implementation, use `live_r2` for all queued AQI rebuilds. Dropbox-backed AQI rebuilds can be added later as an optimisation.
8. Keep a defensive duplicate check: if a connector/day is already in the queue, do not insert another row. Merge the reason/note if needed.

Possible later optimisation:

A future Phase 6.8 v2 may allow AQI-only jobs to use the Dropbox R2 history backup as the observation source when it is safe. For PM rolling 24-hour AQI, this is only safe when neither the target connector/day nor the previous connector/day was observation-repaired in the same run.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 6.7 of the UK-AQ History Integrity system: AQI-only health check and queueing.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phase 6.6.

Context:
Phase 6.6 repairs observation discrepancies with targeted source_to_r2 backfills and queues affected connector/days for AQI rebuild. Phase 6.7 should find AQI-only problems for connector/days that were not already queued by Phase 6.6.

Requirements:

1. Skip Phase 6.6 connector/days
   - At the start of Phase 6.7, load the current run's queued connector/days from aqi_rebuild_queue where reason includes obs_repaired.
   - Do not inspect or queue those connector/days again in the AQI-only pass.
   - Keep a defensive duplicate check anyway: if a connector/day is already queued, do not insert a duplicate row; merge notes/reasons if needed.

2. AQI health checks
   - Inspect AQI history manifests from the configured local Dropbox R2 history backup where available.
   - Identify AQI-only rebuild candidates such as:
       AQI manifest missing
       AQI manifest stale writer/schema/algorithm version
       AQI manifest empty when observations exist
       previous AQI rebuild failed or remains pending
   - Do not treat observation row count and AQI row count as equivalent. Do not require them to match.
   - The AQI health check should be connector/day oriented for rebuild purposes, even if diagnostics identify individual affected timeseries.

3. Queue AQI-only rebuilds
   - Insert AQI-only candidates into aqi_rebuild_queue with:
       reason = aqi_health_check
       source_mode = live_r2
       status = queued
   - For the first implementation, use live_r2 for all AQI rebuilds. Do not implement Dropbox-backed AQI rebuild input yet.
   - Deduplicate by (run_id, connector_id, day_utc).

4. Reporting
   - Add report counters:
       aqi_health_connector_days_checked
       aqi_health_rebuilds_queued
       aqi_health_skipped_already_obs_repaired
       aqi_health_manifest_missing
       aqi_health_manifest_stale
       aqi_health_manifest_empty
       aqi_health_previous_rebuild_failed
   - Include a deterministic list of queued AQI-only connector/days in the Markdown and JSON reports.

5. Tests / verification
   - A connector/day already queued by Phase 6.6 must be skipped by Phase 6.7.
   - A missing AQI manifest for a connector/day not queued by Phase 6.6 should queue one AQI rebuild row.
   - Duplicate queue attempts must not create duplicate rows.
   - Dry-run should report candidates without mutating remote outputs.

6. Docs
   - Update the system doc to describe Phase 6.7.
   - Explain that AQI-only issues trigger r2_history_obs_to_aqilevels, not source_to_r2.
```

---

### Phase 6.8 — Deduplicated AQI rebuild execution

Goal:

Execute AQI rebuilds once per queued connector/day using `r2_history_obs_to_aqilevels`, after Phase 6.6 and Phase 6.7 have finished queueing all required work.

Motivation:

AQI rebuilds should be deduplicated across all reasons in the run. If several timeseries were observation-repaired for the same connector/day, or if both observation repair and AQI health checks identify the same connector/day, the system should run one AQI rebuild for that connector/day.

For the first implementation, all AQI rebuilds should read observations from live R2. This avoids stale Dropbox reads immediately after observation repair.

Design:

1. Load queued rows from `aqi_rebuild_queue` for the current run where `status = queued`.
2. Deduplicate by `(connector_id, day_utc)`.
3. For each queued connector/day, run the existing backfill wrapper with:

```bash
UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

4. Use live R2 as the observation input source for all Phase 6.8 v1 rebuilds.
5. Update queue row status:

```text
queued -> running -> complete
queued -> running -> failed
```

6. Record start/end timestamps and failure notes.
7. Do not fail or reverse the observation repair status if AQI rebuild fails. AQI failure should be visible as a separate repair debt.
8. Include AQI rebuild results in the run report.

Future Phase 6.8 v2:

Later, AQI-only jobs may be allowed to read observations from the Dropbox R2 history backup when safe. Safety rule for PM rolling 24-hour AQI:

```text
For AQI rebuild of connector/day D, Dropbox input is safe only if:
  connector/day D was not observation-repaired in this run
  and connector/day D-1 was not observation-repaired in this run
```

If either day was observation-repaired in the same run, use live R2 because Dropbox may not have caught up.

No implementation prompt is required for Phase 6.8 v2 yet.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 6.8 of the UK-AQ History Integrity system: deduplicated AQI rebuild execution.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Build on Phases 6.6 and 6.7.

Context:
Phase 6.6 queues AQI rebuilds after successful observation repairs. Phase 6.7 queues AQI-only rebuilds after AQI health checks. Phase 6.8 should execute the queued rebuilds once per connector/day using the existing r2_history_obs_to_aqilevels mode.

Requirements:

1. Queue loading and deduplication
   - Load aqi_rebuild_queue rows for the current run where status = queued.
   - Deduplicate by (connector_id, day_utc).
   - If duplicate rows somehow exist, execute only one rebuild and mark/merge the duplicates safely.

2. AQI rebuild execution
   - For each queued connector/day, call the existing local backfill wrapper with:
       UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
       UK_AQ_BACKFILL_FORCE_REPLACE=true
       UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
       UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
       UK_AQ_BACKFILL_TO_DAY_UTC=<day>
   - For the first implementation, all AQI rebuilds should use live R2 as the observation input source.
   - Do not implement Dropbox-backed AQI rebuild input yet.

3. Queue status updates
   - Before running a rebuild, update the row to:
       status = running
       started_at_utc = now
   - On success:
       status = complete
       finished_at_utc = now
   - On failure:
       status = failed
       finished_at_utc = now
       notes = error summary
   - A failed AQI rebuild should not rewrite the observation backfill status. Observation repair and AQI rebuild statuses must remain separate.

4. Dry-run behaviour
   - In dry-run mode, print planned r2_history_obs_to_aqilevels commands.
   - Do not mutate R2 or AQI output.
   - Either do not insert queue status changes, or clearly mark dry-run queue/report entries as planned only.

5. Reporting
   - Add counters:
       aqi_rebuilds_queued_total
       aqi_rebuilds_attempted
       aqi_rebuilds_complete
       aqi_rebuilds_failed
       aqi_rebuilds_skipped
   - Include one deterministic report row per connector/day rebuild.
   - Include the reasons that caused the rebuild, such as obs_repaired and/or aqi_health_check.

6. Recovery behaviour
   - If a previous run left failed or pending AQI rebuilds, make it possible for a later run to report them and optionally retry them.
   - Do not automatically retry old failed rebuilds unless an explicit option is added or the current run re-queues the same connector/day.

7. Tests / verification
   - Multiple queued reasons for the same connector/day should result in one r2_history_obs_to_aqilevels command.
   - A failed AQI rebuild should leave observation repair status unchanged.
   - Dry-run should print planned rebuilds without remote mutation.

8. Docs
   - Update the system doc to describe Phase 6.8.
   - Add a note for future Phase 6.8 v2: AQI-only jobs may later read from Dropbox R2 history backup when safe, but v1 always uses live R2.
```


### Phase 7 — Monitoring, limits, and reports polish

Goal:

Harden runtime/download monitoring.

Prompt:

```text
Repo: uk-aq-ops.

Please implement Phase 7 of the UK-AQ History Integrity system: monitoring and limits.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- Ensure every run records:
  files HEAD checked
  files downloaded
  files changed
  files unchanged after download
  files missing
  downloaded bytes
  downloaded MB
  runtime seconds
  hash runtime
  backfills triggered
  warnings
  errors
- Enforce --max-download-mb and --max-runtime-minutes safely.
- If a limit is hit, stop scheduling new downloads, finish the current file safely, and write status stopped_limit.
- Write summary JSON and Markdown reports to state/<ENV>/reports/.
- Include top largest downloads and changed files in the report.
- Include recommendations in the report when limits are repeatedly hit.
```

### Phase 8 — API-based source adapters

Goal:

Add UK-AIR-SOS and Breathe London source-history checks later.

Prompt:

```text
Repo: uk-aq-ops.

Please design and implement Phase 8 of the UK-AQ History Integrity system for API-based sources.

Use:
docs/uk-aq-history-integrity-system-doc-v2.md

Requirements:
- Add adapter structure for API sources such as UK-AIR-SOS and Breathe London.
- Fetch source API response for connector/station/day.
- Canonicalise response into stable bytes:
  stable row ordering
  stable JSON/NDJSON
  remove volatile metadata
  normalise timestamps and numbers
- Hash canonical bytes.
- Store state/events in the same SQLite DB.
- Use local core lookup for station/timeseries mapping.
- Trigger narrow backfill only when canonical hash changes.
- Include download/runtime/API call counts in integrity_runs and reports.
```



---

## Open questions for implementation

These should be checked against the actual repos before coding:

1. Exact local Dropbox paths for CIC-Test and LIVE R2 history backups.
2. Exact local paths to each environment's existing backfill wrapper and env file.
3. Exact column names in the current core schema for:
   - connectors
   - stations
   - timeseries
   - pollutants/species
4. Whether `stations.station_ref` is always the correct OpenAQ location ID field.
5. Whether Sensor.Community station refs are already normalised in the core tables.
6. Whether the existing backfill wrapper already supports `UK_AQ_BACKFILL_TIMESERIES_IDS`.
7. Whether source-to-R2 can consume a local cached source file directly, or whether cached files are initially only kept for evidence/debugging.
