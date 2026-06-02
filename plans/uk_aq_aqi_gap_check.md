Yes. Use the exact same period profiles as uk-aq-history-integrity so you do not have to remember two systems. Based on the current script, those are daily, weekly, and monthly, with start windows of 21, 120, and 730 days respectively. Add only one extra profile: obsaqidb.

Here is the Codex prompt with everything folded in.

In the uk-aq-ops repo, add a new local AQI gap-check tool.

This tool must be separate from the existing uk-aq-history-integrity.py executable, but it must live alongside it and reuse the same local history-integrity conventions where appropriate.

Create:

scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py

Also create/update documentation:

system_docs/uk-aq-aqi-gap-check.md

Do not change deployed workers.
Do not change live schema.
Do not mutate R2, Dropbox, Supabase, db dumps, or source data.
This is a local reporting/checking tool only.

Existing project context to inspect first

Before implementing, inspect and compare against the existing R2 history integrity tool:

scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
system_docs/uk-aq-r2-history-integrity.md
plans/archive/uk-aq-history-integrity-plan.md
scripts/uk-aq-history-integrity/env/LIVE.env.example
scripts/uk-aq-history-integrity/env/CIC-Test.env.example

Reuse its local conventions where possible, especially:

* env loading style
* path guardrails
* lock/log/report directory conventions
* SQLite state DB usage
* period profile naming
* run metadata style
* daily/weekly/monthly profile behaviour
* Dropbox R2 history path handling
* core snapshot lookup tables already present in the integrity SQLite DB

The existing history integrity script defines period profile windows like:

PROFILE_START_WINDOWS_DAYS = {
    "daily": 21,
    "weekly": 120,
    "monthly": 730,
}

Use the exact same profile names and day-window meanings for this new AQI gap checker, so the operational model is consistent.

Add one extra profile:

obsaqidb

Details for obsaqidb are below.

Purpose

The new tool must examine local backed-up observations and AQI-level data and report where AQI-level rows are missing.

It must only detect absent AQI rows where observations imply AQI rows should exist.

It must not try to validate whether stored AQI values are correct.

It must not try to repair or backfill anything.

Local-only requirement

This tool is intended to run on my local MBPro because that machine has:

* the local Dropbox R2 history backup
* the local Supabase db dump backups
* the local history-integrity SQLite DB

It must not call live Supabase, R2, or external services by default.

The default operation must be local file / local DB only.

Location and structure

Create a new executable script:

scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py

It should be separate from uk-aq-history-integrity.py, because it needs to be run independently for cron and also manually over large backfill ranges.

However, it should still use the same history-integrity environment and state framework where practical.

Use Python unless there is a very strong repo-specific reason not to. The existing history-integrity tool is Python and already uses sqlite3.

Use DuckDB for local analytical SQL processing where practical. It is fine for Python to orchestrate and for DuckDB to do the heavy scanning, grouping, joining and report generation.

CLI

Support:

python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --profile daily
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --profile weekly
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --profile monthly
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --profile obsaqidb

Also support explicit ranges:

python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --from-day 2026-05-01 \
  --to-day 2026-05-07 \
  --source r2-dropbox
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --from-day 2026-05-01 \
  --to-day 2026-05-07 \
  --source db-dump

Day ranges are UTC and inclusive.

Precedence:

1. If --from-day and --to-day are provided, use those explicit days.
2. Otherwise use --profile.
3. If neither explicit days nor --profile is supplied, fail with a clear error.

Sources:

--source r2-dropbox
--source db-dump

Defaults:

* daily, weekly, monthly default to --source r2-dropbox
* obsaqidb defaults to --source db-dump

Do not add DAQI/EAQI flags. The checker must always check both DAQI and EAQI.

Do not add hourly|rolling-24h|both metric mode flags. The checker must automatically use the correct metric basis for each AQI standard/pollutant.

Add:

--verbose
--limit-missing N
--output-dir DIR

--limit-missing is only for console preview. The JSON report must still include all missing rows.

Period profiles

Use the exact same profile names and day windows as uk-aq-history-integrity.py:

daily
weekly
monthly

Use the same windows as the existing PROFILE_START_WINDOWS_DAYS values in the script. Do not invent different definitions.

The new obsaqidb profile must work like this:

1. Read available AQI days from the local Obs AQI DB dump backup.
2. Read available AQI days from local R2 Dropbox AQI history.
3. Select completed UTC days that:
    * exist in the Obs AQI DB dump
    * do not exist in R2 AQI history
    * are not today
4. Run the gap check only for those selected days.

Reason: the website line charts prioritise R2 where R2 exists, so obsaqidb should focus on the days not yet in R2.

Add an optional override:

--include-r2-days

For --profile obsaqidb, default behaviour is to skip days already present in R2. With --include-r2-days, include those days too.

Store in run metadata how many candidate Obs AQI DB days were found, how many were excluded because already present in R2, and how many were selected.


AQI rules

The source of truth for AQI rules is in uk-aq-schema, not in this repo.

Inspect and mirror the current rules from:

uk-aq-schema/schemas/ingest_db/uk_aq_aqilevels_schema.sql
uk-aq-schema/system_docs/table_info/uk_aq_aqi_breakpoints.md

The schema defines:

uk_aq_aqilevels.aqi_standard_versions
uk_aq_aqilevels.aqi_breakpoints
uk_aq_aqilevels.uk_aq_aqi_index_lookup(...)

For the local checker, create equivalent SQLite tables inside the existing history-integrity SQLite DB. Use namespaced table names so they do not clash with anything else:

CREATE TABLE IF NOT EXISTS aqi_gap_check_standard_versions (
  standard_code TEXT NOT NULL,
  version_code TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  notes TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (standard_code, version_code)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_breakpoints (
  standard_code TEXT NOT NULL,
  version_code TEXT NOT NULL,
  pollutant_code TEXT NOT NULL,
  averaging_code TEXT NOT NULL,
  index_level INTEGER NOT NULL,
  index_label TEXT,
  index_band TEXT NOT NULL,
  color_hex TEXT,
  range_low REAL NOT NULL,
  range_high REAL,
  uom TEXT NOT NULL DEFAULT 'ug/m3',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (
    standard_code,
    version_code,
    pollutant_code,
    averaging_code,
    index_level
  ),
  FOREIGN KEY (standard_code, version_code)
    REFERENCES aqi_gap_check_standard_versions(standard_code, version_code)
);

Seed these tables from the current values in uk-aq-schema/schemas/ingest_db/uk_aq_aqilevels_schema.sql.

Use idempotent upserts, so rerunning the checker safely refreshes the local AQI rules if the seed data changes.

Add a small metadata table or row so the checker records where the mirrored rules came from:

CREATE TABLE IF NOT EXISTS aqi_gap_check_rule_mirror_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_repo TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_commit_or_version TEXT,
  mirrored_at_utc TEXT NOT NULL,
  notes TEXT
);

The checker should use these local SQLite rule tables for lookups, rather than hardcoding threshold ranges throughout procedural code.

The local SQLite lookup must match the behaviour of uk_aq_aqilevels.uk_aq_aqi_index_lookup(...):

* values below the first range_low return null
* first row means x <= range_high
* later rows mean x > previous range_high and x <= current range_high
* final open-ended row means x > previous range_high
* range_high is inclusive
* values must be non-null and non-negative
* units are ug/m3
* only active/valid rules should be used for the relevant effective date

The checker must always check these expected AQI rows:

DAQI NO2        hourly mean
DAQI PM2.5      rolling 24-hour mean
DAQI PM10       rolling 24-hour mean
EAQI NO2        hourly mean
EAQI PM2.5      hourly mean
EAQI PM10       hourly mean

Do not add DAQI/EAQI selection flags.
Do not add hourly/rolling-24h metric mode flags.
The metric basis must be selected automatically from the mirrored AQI breakpoint rows.


Observation aggregation logic

For each timeseries_id, pollutant, and UTC hour:

* build hourly means from observations
* only include observations with:
    * non-null value
    * value >= 0
    * pollutant code in pm25, pm10, no2

For DAQI PM2.5 and PM10 rolling 24-hour means:

* use 24 hourly means ending at the target hour
* match the existing schema logic:
    * rolling window is rows between 23 preceding and current row
    * rolling value is valid only when there are at least 18 valid hourly means in that rolling 24-hour window
* because rolling 24h needs previous hours, when checking a from-day, load at least 23 hours of observations before the requested start day
* only report expected rows for target hours inside the requested day range, not warm-up hours

Expected rows:

For each target timeseries_id and UTC hour:

* if NO2 hourly mean exists and maps to DAQI, expect a DAQI NO2 row
* if NO2 hourly mean exists and maps to EAQI, expect an EAQI NO2 row
* if PM2.5 hourly mean exists and maps to EAQI, expect an EAQI PM2.5 row
* if PM10 hourly mean exists and maps to EAQI, expect an EAQI PM10 row
* if PM2.5 rolling 24h mean exists and maps to DAQI, expect a DAQI PM2.5 row
* if PM10 rolling 24h mean exists and maps to DAQI, expect a DAQI PM10 row

Do not expect AQI rows when the required observation-derived metric is null.

Do not expect DAQI PM rows if there are fewer than 18 valid hourly means in the rolling 24-hour window.

Source adapters

Implement one shared checker with separate source adapters:

r2-dropbox adapter
db-dump adapter

Do not create two independent implementations of the AQI expected-row logic.

r2-dropbox source

Use local Dropbox R2 backup files for observations and aqilevels.

Inspect and reuse current backup layout and naming conventions from:

scripts/backup_r2/uk_aq_validate_aqi_from_dropbox_observs.mjs
scripts/backup_r2/uk_aq_history_counts_compare.mjs
workers/uk_aq_aqi_history_r2_api_worker/README.md
system_docs/uk-aq-r2-history-layout.md
plans/AQI_R2-History-integrity.md

db-dump source

Use local Supabase database dump backup files, not live Supabase.

Inspect the current dump backup service and backup format from:

workers/uk_aq_supabase_db_dump_backup_service/README.md
workers/uk_aq_supabase_db_dump_backup_service/core.mjs
tests/uk_aq_supabase_db_dump_backup_service.test.mjs

Support the current dump format. If multiple historic formats exist, support the current one first and document limitations.

SQLite state

Use the existing history-integrity SQLite DB:

$UK_AQ_HISTORY_INTEGRITY_DB_PATH

Do not create a separate SQLite DB unless absolutely necessary.

Add separate namespaced tables for the AQI gap checker.

Do not store every missing row in SQLite by default. Store full missing-row detail in JSON report files.

Store run metrics and summaries in SQLite.

Required tables:

CREATE TABLE IF NOT EXISTS aqi_gap_check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  env_name TEXT NOT NULL,
  profile TEXT,
  source_mode TEXT NOT NULL,
  from_day_utc TEXT NOT NULL,
  to_day_utc TEXT NOT NULL,
  selected_day_count INTEGER DEFAULT 0,
  obs_aqidb_candidate_day_count INTEGER DEFAULT 0,
  r2_excluded_day_count INTEGER DEFAULT 0,
  include_r2_days INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  report_json_path TEXT,
  error_message TEXT
);

Add day-only summary:

CREATE TABLE IF NOT EXISTS aqi_gap_check_day_summary (
  run_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  missing_daqi_count INTEGER DEFAULT 0,
  missing_eaqi_count INTEGER DEFAULT 0,
  missing_no2_count INTEGER DEFAULT 0,
  missing_pm25_count INTEGER DEFAULT 0,
  missing_pm10_count INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, day_utc),
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);

Add day/connector summary:

CREATE TABLE IF NOT EXISTS aqi_gap_check_day_connector_summary (
  run_id INTEGER NOT NULL,
  day_utc TEXT NOT NULL,
  connector_id INTEGER NOT NULL,
  expected_row_count INTEGER DEFAULT 0,
  actual_row_count INTEGER DEFAULT 0,
  missing_row_count INTEGER DEFAULT 0,
  missing_daqi_count INTEGER DEFAULT 0,
  missing_eaqi_count INTEGER DEFAULT 0,
  missing_no2_count INTEGER DEFAULT 0,
  missing_pm25_count INTEGER DEFAULT 0,
  missing_pm10_count INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, day_utc, connector_id),
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);

Do not store connector_code in the AQI summary tables. Use connector_id only.

Reason: core_connectors_snapshot already exists in the history-integrity SQLite DB, so reports can join to that table when display names or connector codes are needed.

Example reporting join:

SELECT
  s.day_utc,
  c.connector_code,
  c.display_name,
  s.missing_row_count
FROM aqi_gap_check_day_connector_summary s
LEFT JOIN core_connectors_snapshot c
  ON c.id = s.connector_id
WHERE s.run_id = ?
ORDER BY s.day_utc, s.missing_row_count DESC;

Add source/report file tables if useful:

CREATE TABLE IF NOT EXISTS aqi_gap_check_source_files (
  run_id INTEGER NOT NULL,
  source_mode TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  source_file_role TEXT,
  day_utc TEXT,
  bytes_read INTEGER DEFAULT 0,
  row_count INTEGER DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);
CREATE TABLE IF NOT EXISTS aqi_gap_check_report_files (
  run_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes_written INTEGER DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES aqi_gap_check_runs(id)
);

JSON report

Write a full JSON report under:

$UK_AQ_HISTORY_INTEGRITY_REPORT_DIR/aqi_gap_check/

If the report dir env var is not available, follow the existing history-integrity fallback/error style.

Filename should include:

* source
* profile if used
* from day
* to day
* timestamp

Example:

aqi_gap_check_r2-dropbox_daily_2026-05-01_2026-05-07_20260602T101500Z.json

The JSON report must include:

source_mode
profile
from_day
to_day
selected_days
generated_at
expected_row_count
actual_row_count
missing_row_count
missing_by_day
missing_by_day_connector
missing_by_standard
missing_by_pollutant
warnings
source_files_inspected
rules_version_or_source
missing_rows

Each missing row should include at least:

day_utc
timestamp_hour_utc
timeseries_id
station_id
connector_id
pollutant_code
standard_code
averaging_code
expected_metric_value
expected_index_level
expected_index_band
reason

Use reason = "missing_aqilevel_row".

Console output should show a concise summary and, if --limit-missing is supplied, a preview of the first N missing rows.

Matching actual AQI rows

Inspect the current aqilevels schemas before implementing the match key.

Likely relevant schema files:

uk-aq-schema/schemas/ingest_db/uk_aq_aqilevels_schema.sql
uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql
uk-aq-schema/system_docs/table_info/uk_aq_timeseries_aqi_hourly.md
uk-aq-schema/system_docs/table_info/uk_aq_timeseries_aqi_daily.md

The match key should be based on the actual stored AQI schema. It will probably include:

timeseries_id
timestamp hour
standard_code
pollutant_code
averaging_code

Do not guess the final key without inspecting the schema.

Cron use case

This will probably run from local cron on the MBPro.

Add documentation examples for:

python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --profile daily

and:

python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --profile obsaqidb

Daily/weekly/monthly should behave consistently with the existing R2 history integrity profiles.

The obsaqidb cron/profile should check only local db dump days that are not already present in local R2 AQI history, because the website prioritises R2 where available.

Validation

Add either lightweight tests or a documented manual test section.

Cover:

* no observations means no expected AQI rows
* NO2 creates DAQI and EAQI hourly expected rows
* PM2.5 and PM10 create EAQI hourly expected rows
* PM2.5 and PM10 create DAQI rolling 24h expected rows only when at least 18 valid hourly means exist
* rolling 24h warm-up hours are loaded but not reported outside the selected day range
* missing AQI rows are counted by run, day, connector, standard and pollutant
* obsaqidb excludes days already present in R2 by default
* --include-r2-days changes obsaqidb day selection
* explicit --from-day/--to-day overrides profiles

Documentation

system_docs/uk-aq-aqi-gap-check.md must explain:

* what the tool checks
* what it does not check
* that it finds missing AQI rows only
* that it does not check whether AQI values are correct
* that it does not repair anything
* that it always checks both DAQI and EAQI
* that metric basis is automatic:
    * DAQI NO2 hourly
    * DAQI PM2.5/PM10 rolling 24h
    * EAQI NO2/PM2.5/PM10 hourly
* source modes
* profiles:
    * daily
    * weekly
    * monthly
    * obsaqidb
* JSON report location
* SQLite summary tables
* local MBPro cron examples
* how to query latest run summaries using SQLite
* how to join connector IDs to core_connectors_snapshot

Do not make unrelated changes.

I’d use that as the final prompt. The key bit is: same profile names as uk-aq-history-integrity, no optional DAQI/EAQI selection, no optional metric mode, and obsaqidb only checks the non-R2 days by default.