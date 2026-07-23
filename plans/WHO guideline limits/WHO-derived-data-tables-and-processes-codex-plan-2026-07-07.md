# UK AQ WHO guideline derived data implementation plan

Date: 2026-07-07  
Amended: 2026-07-23  
Scope: private Obs AQI DB calculation/state tables, GitHub Actions daily processing, R2 v2 derived parquet archive, R2 public JSON outputs, and later website wiring for WHO guideline information.

This plan is for VS Code Codex. Recommended model: **GPT-5.6 Codex with High reasoning**. It is separate from the static homepage card implementation plan. The homepage card can initially use hard-coded figures. This plan creates the data layer that will later feed that card, the WHO guideline page, league tables and sensor detail pages.

Execution-host amendment: the daily WHO calculation and R2 publication task must run directly in GitHub Actions and be triggered by the existing Cloudflare cron scheduler. GCP Cloud Run and GCP Cloud Scheduler are not part of the final daily-task architecture.

## 1. Goal

Create a derived WHO guideline data layer for UK AQ that calculates and stores:

1. Daily mean status for each AURN pollutant timeseries.
2. Rolling 365-day WHO summary status for each AURN pollutant timeseries.
3. Complete calendar-year WHO summary status for each AURN pollutant timeseries, with optional later year-to-date period summaries.
4. Small public R2 JSON outputs that the website can read cheaply.
5. R2 v2 parquet archives of the same derived outputs for rebuild/debug/history use.

The first production phase is GOV.UK AURN only, for:

- PM2.5
- PM10
- NO2

Do not mix Breathe London or other networks into the headline WHO summaries in this phase.

## 1.1 Architecture decision

Use Option B:

- Private calculation/state tables live in Obs AQI DB, not as public website query tables.
- R2 parquet stores durable derived history/debug/rebuild outputs.
- R2 JSON stores website-ready public products.
- GitHub Actions is the execution host for the daily WHO calculation and publication task.
- Cloudflare Scheduler is the sole schedule authority and dispatches the GitHub workflow through `workflow_dispatch`.

The final daily execution path is:

```text
Cloudflare Scheduler
  -> GitHub workflow_dispatch
  -> GitHub Actions workflow
  -> direct WHO Deno batch job
  -> private Obs AQI DB RPCs
  -> R2 v2 parquet and public JSON
```

Do not add a GitHub Actions `schedule:` trigger. Do not use GCP Cloud Run, GCP Cloud Scheduler, Artifact Registry or GCP Secret Manager for this daily task after cutover.

Do not expose public Supabase WHO views in phase 1. The homepage card should read a small R2 JSON file, not query Supabase.

This keeps the public website cheap and cacheable, avoids expanding the public database API surface before it is needed, and keeps WHO calculations inside the ops/derived-data pipeline.

Public website data products should be split by purpose rather than packed into one large file:

- homepage summary JSON
- later league-table JSON
- later per-timeseries or per-station daily calendar JSON
- metadata/guideline JSON if the combined files become too large

## 2. Public wording decisions

Use public wording that avoids implying UK legal compliance.

Use:

- WHO guideline summary
- Above WHO guideline
- Within WHO guideline
- Not enough data
- Days above WHO daily guideline
- Sensors with more than 4 days above the WHO daily guideline
- WHO health-based guidelines, not UK legal limits

Avoid:

- breach
- breached WHO limit
- illegal
- failed legal limit
- within safe limits

The public website should say:

> Daily averages use GMT days from midnight to midnight. “Above guideline” means above WHO health-based guidelines, not UK legal limits.

The database should store UTC dates and UTC-derived day fields. For hourly source observations where the timestamp represents the end of the averaging hour, the implementation must assign each hourly value to its sample day by subtracting one hour from the timestamp before taking the date.

## 3. Guideline values

Store these in code/config, or preferably in a small reference table so the values are not duplicated in multiple jobs.

Use lowercase canonical pollutant codes internally and in R2 paths. Public JSON may also include display labels.

| pollutant_code | pollutant_label | who_daily_guideline_ugm3 | who_yearly_guideline_ugm3 | daily_allowance_days |
|---|---|---:|---:|---:|
| pm25 | PM2.5 | 15 | 5 | 4 |
| pm10 | PM10 | 45 | 15 | 4 |
| no2 | NO2 | 25 | 10 | 4 |

Notes:

- WHO daily values are interpreted as the 99th percentile benchmark, implemented here as no more than 4 days above the daily guideline in a year/rolling year.
- UK AQ will store 4 as an absolute daily allowance for the public dashboard calculation.
- WHO does not appear to define a single operational hourly completeness rule for this website use case. UK AQ will define its own transparent completeness rule.

## 4. Completeness rules

Use these production defaults:

- Valid daily mean: at least 18 valid distinct hourly readings assigned to that UTC/GMT sample day.
- Valid rolling 365-day period: at least 274 valid daily means.
- Valid complete calendar year: at least 274 valid daily means.
- Valid year-to-date period summary: optional/deferred. Do not use the fixed 274-day threshold and do not use a minimum of 1 valid day for public above/within classification.

If a year-to-date period summary is implemented later, always store `valid_day_count` and `period_day_count`, but only set `has_enough_data = true` when the period has enough valid daily means. Use a proportional threshold with a sensible minimum, for example:

```sql
LEAST(period_day_count, GREATEST(14, CEIL(period_day_count * 0.75)))
```

If this adds complexity, defer year-to-date period summaries to the later WHO page/league-table phase. Year-to-date daily square calendars do not use this period threshold because they are day-by-day displays, not period-level classifications.

Store the thresholds used on each derived row so future changes are auditable.

### 4.1 Daily averaging window for hour-ending data

For GOV.UK AURN and Breathe London hourly observations, treat the stored hourly timestamp as an hour-ending timestamp unless source-specific validation proves otherwise.

The WHO daily sample day is therefore:

```sql
(observed_at - interval '1 hour')::date
```

Equivalently, a daily mean for `day_utc = 2026-07-02` uses hourly rows where:

```sql
observed_at >  '2026-07-02 00:00:00+00'::timestamptz
and observed_at <= '2026-07-03 00:00:00+00'::timestamptz
```

For hourly timestamp values this is effectively:

```text
2026-07-02 01:00 through 2026-07-03 00:00
```

Do not calculate WHO daily means as `2026-07-02 00:00` through `2026-07-02 23:00` for these hour-ending sources.

Before first production deployment, verify this convention once against an official/source daily average for at least one GOV.UK AURN station/day. If the source or ingest layer is later proven to store hour-starting timestamps for a network, add a network-specific timestamp convention rather than double-shifting all sources.

## 5. Internal naming decision

Use `who_2021_*` internally, even though public UI says only “WHO”. This protects against future WHO guideline revisions.

Create private calculation/state tables in Obs AQI DB. The preferred phase-1 placement is `uk_aq_ops` because these rows are generated by an ops/derived-data process and are not public query tables:

- `uk_aq_ops.who_2021_guideline_values`
- `uk_aq_ops.who_2021_daily_status`
- `uk_aq_ops.who_2021_rolling_year_status`
- `uk_aq_ops.who_2021_calendar_year_status`
- `uk_aq_ops.who_2021_processing_runs`

If these rows later become long-lived analytical data rather than private processing state, reconsider moving the durable fact tables into a dedicated `uk_aq_who` schema or `uk_aq_aqilevels`. Keep `uk_aq_ops` for runs, checkpoints, and current publication state either way.

Do not create phase-1 public views in `uk_aq_public`. Publish website-facing outputs to R2 JSON instead.

The public UI should not display “2021” unless it is in an explanatory source note.

## 6. Table design

### 6.1 `uk_aq_ops.who_2021_guideline_values`

Purpose: store WHO guideline values and threshold rules in one place.

Suggested columns:

```sql
pollutant_code text primary key,
pollutant_label text not null,
who_daily_guideline numeric not null,
who_yearly_guideline numeric not null,
daily_allowance_days integer not null default 4,
unit text not null default 'µg/m³',
guideline_version text not null default 'WHO 2021',
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

Seed rows:

```sql
('pm25', 'PM2.5', 15, 5, 4, 'µg/m³', 'WHO 2021')
('pm10', 'PM10', 45, 15, 4, 'µg/m³', 'WHO 2021')
('no2', 'NO2', 25, 10, 4, 'µg/m³', 'WHO 2021')
```

### 6.2 `uk_aq_ops.who_2021_daily_status`

Purpose: one row per pollutant timeseries per UTC day.

Suggested columns:

```sql
day_utc date not null,
day_window_start_exclusive_utc timestamptz not null,
day_window_end_inclusive_utc timestamptz not null,
connector_id bigint not null,
source_network_code text not null,
station_id bigint not null,
timeseries_id bigint not null,
pollutant_code text not null,
daily_mean numeric not null,
valid_hour_count integer not null,
min_valid_hours_per_day integer not null default 18,
timestamp_convention text not null default 'hour_ending',
data_completeness_pct numeric,
who_daily_guideline numeric not null,
above_who_daily_guideline boolean not null,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
primary key (day_utc, connector_id, timeseries_id)
```

Indexes:

```sql
create index on uk_aq_ops.who_2021_daily_status (source_network_code, pollutant_code, day_utc);
create index on uk_aq_ops.who_2021_daily_status (connector_id, pollutant_code, day_utc);
create index on uk_aq_ops.who_2021_daily_status (source_network_code, station_id, pollutant_code, day_utc);
create index on uk_aq_ops.who_2021_daily_status (connector_id, timeseries_id, day_utc);
```

Notes:

- Store `daily_mean`, not only the boolean. This supports debugging, league tables, future reprocessing and station detail pages.
- Use `above_who_daily_guideline` rather than `exceeded_*` in newly written code where possible. If existing naming conventions prefer `exceeded_*`, add a public alias with friendlier naming later.

### 6.3 `uk_aq_ops.who_2021_rolling_year_status`

Purpose: one row per pollutant timeseries per as-of day. This is the fast source for the homepage rolling-year card and rolling-year league tables.

Suggested columns:

```sql
as_of_day_utc date not null,
window_start_day_utc date not null,
window_end_day_utc date not null,
connector_id bigint not null,
source_network_code text not null,
station_id bigint not null,
timeseries_id bigint not null,
pollutant_code text not null,
rolling_year_mean numeric,
valid_day_count integer not null,
valid_hour_count integer not null,
min_valid_hours_per_day integer not null default 18,
min_valid_days integer not null default 274,
data_completeness_pct numeric,
has_enough_data boolean not null,
who_yearly_guideline numeric not null,
above_who_yearly_guideline boolean,
who_daily_guideline numeric not null,
daily_above_guideline_days integer not null,
daily_allowance_days integer not null default 4,
daily_above_guideline_days_beyond_allowance integer not null,
above_who_daily_guideline_approach boolean,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
primary key (as_of_day_utc, connector_id, timeseries_id)
```

Indexes:

```sql
create index on uk_aq_ops.who_2021_rolling_year_status (source_network_code, pollutant_code, as_of_day_utc);
create index on uk_aq_ops.who_2021_rolling_year_status (connector_id, pollutant_code, as_of_day_utc);
create index on uk_aq_ops.who_2021_rolling_year_status (source_network_code, station_id, pollutant_code, as_of_day_utc);
create index on uk_aq_ops.who_2021_rolling_year_status (connector_id, pollutant_code, above_who_yearly_guideline, as_of_day_utc);
create index on uk_aq_ops.who_2021_rolling_year_status (connector_id, pollutant_code, above_who_daily_guideline_approach, as_of_day_utc);
```

Rules:

- `above_who_yearly_guideline` is true when `rolling_year_mean > who_yearly_guideline` and `has_enough_data` is true.
- `above_who_daily_guideline_approach` is true when `daily_above_guideline_days > daily_allowance_days` and `has_enough_data` is true.
- If `has_enough_data` is false, the above flags should be false or null consistently. Recommended: store them as null and let public JSON classify as `Not enough data`.

### 6.4 `uk_aq_ops.who_2021_calendar_year_status`

Purpose: complete calendar years, plus optional current year-to-date summaries when enabled.

Suggested columns:

```sql
calendar_year integer not null,
period_type text not null check (period_type in ('complete_year', 'year_to_date')),
period_start_day_utc date not null,
period_end_day_utc date not null,
connector_id bigint not null,
source_network_code text not null,
station_id bigint not null,
timeseries_id bigint not null,
pollutant_code text not null,
period_mean numeric,
valid_day_count integer not null,
valid_hour_count integer not null,
period_day_count integer not null,
min_valid_hours_per_day integer not null default 18,
min_valid_days integer not null,
data_completeness_pct numeric,
has_enough_data boolean not null,
who_yearly_guideline numeric not null,
above_who_yearly_guideline boolean,
who_daily_guideline numeric not null,
daily_above_guideline_days integer not null,
daily_allowance_days integer not null default 4,
daily_above_guideline_days_beyond_allowance integer not null,
above_who_daily_guideline_approach boolean,
is_final boolean not null default false,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
primary key (calendar_year, period_type, connector_id, timeseries_id)
```

Indexes:

```sql
create index on uk_aq_ops.who_2021_calendar_year_status (calendar_year, period_type, source_network_code, pollutant_code);
create index on uk_aq_ops.who_2021_calendar_year_status (calendar_year, period_type, connector_id, pollutant_code);
create index on uk_aq_ops.who_2021_calendar_year_status (source_network_code, station_id, pollutant_code, calendar_year);
```

Rules:

- `complete_year` rows use 01 January to 31 December and are final once the year is complete and data has been backfilled.
- `year_to_date` rows use 01 January to the latest complete UTC/GMT day.
- Current-year `period_mean` must be labelled publicly as “year to date mean”, not “yearly mean”.

## 7. Public R2 JSON outputs

### 7.1 Homepage summary JSON

Publish `history/v2/who_2021/latest_who_2021.json`.

Purpose: return the exact 9 rows needed by the homepage WHO card, with percentages already calculated.

Expected rows:

```text
rolling_daily     PM2.5
rolling_daily     PM10
rolling_daily     NO2
rolling_yearly    PM2.5
rolling_yearly    PM10
rolling_yearly    NO2
last_full_year    PM2.5
last_full_year    PM10
last_full_year    NO2
```

Suggested JSON shape:

```json
{
  "schema_version": 1,
  "data_as_of_day_utc": "2026-07-02",
  "rolling_range_start_day_utc": "2025-07-03",
  "rolling_range_end_day_utc": "2026-07-02",
  "source_network_code": "gov_uk_aurn",
  "source_label": "GOV.UK AURN only",
  "pollutants": [
    { "pollutant_code": "pm25", "pollutant_label": "PM2.5" },
    { "pollutant_code": "pm10", "pollutant_label": "PM10" },
    { "pollutant_code": "no2", "pollutant_label": "NO2" }
  ],
  "valid_day_rule": {
    "minimum_valid_hour_count": 18,
    "timestamp_convention": "hour_ending",
    "sample_day_expression": "date(observed_at - interval '1 hour')",
    "day_window": "(day_utc 00:00, next_day_utc 00:00]"
  },
  "valid_period_rule": {
    "minimum_valid_day_count": 274
  },
  "public_note": "Daily averages use GMT days from midnight to midnight. \"Above guideline\" means above WHO health-based guidelines, not UK legal limits.",
  "guideline_values": {
    "pm25": { "label": "PM2.5", "daily": 15, "yearly": 5, "unit": "ug/m3" },
    "pm10": { "label": "PM10", "daily": 45, "yearly": 15, "unit": "ug/m3" },
    "no2": { "label": "NO2", "daily": 25, "yearly": 10, "unit": "ug/m3" }
  },
  "cards": [
    {
      "card_key": "rolling_daily",
      "card_group": "Rolling year",
      "card_section": "Daily guideline",
      "range_start_day_utc": "2025-07-03",
      "range_end_day_utc": "2026-07-02",
      "range_label": "03/07/2025 to 02/07/2026",
      "connector_id": 1,
      "source_network_code": "gov_uk_aurn",
      "source_label": "GOV.UK AURN only",
      "pollutant_code": "pm25",
      "pollutant_label": "PM2.5",
      "who_daily_guideline": 15,
      "who_yearly_guideline": 5,
      "timeseries_available": 145,
      "timeseries_with_enough_data": 145,
      "timeseries_not_enough_data": 0,
      "timeseries_above_guideline": 140,
      "timeseries_within_guideline": 5,
      "percent_above_guideline": 96.6,
      "card_count_label": "140 of 145 sensors"
    }
  ]
}
```

Card key rules:

- `rolling_daily`: from latest `who_2021_rolling_year_status`, using `above_who_daily_guideline_approach`.
- `rolling_yearly`: from latest `who_2021_rolling_year_status`, using `above_who_yearly_guideline`.
- `last_full_year`: from latest complete calendar year rows in `who_2021_calendar_year_status`, using `above_who_yearly_guideline`.

Public labels:

- `card_group = Rolling year` or `Last full year`
- `card_section = Daily guideline` or `Yearly guideline`
- `source_label = GOV.UK AURN only`

Do not require the website to calculate percentages or classify enough-data rows.

Also publish a dated/versioned copy before replacing the latest pointer:

```text
history/v2/who_2021/summaries/as_of_day_utc=YYYY-MM-DD/who_2021_summary.json
history/v2/who_2021/latest_who_2021.json
```

Write the dated object first. Write `latest_who_2021.json` only after all parquet/archive outputs and the dated summary object are complete.

### 7.2 Daily cache refresh rule

The website may cache the WHO JSON locally and should refresh at most once per UTC/GMT day for normal traffic.

Recommended website rule:

- Compute the expected latest complete day as yesterday in UTC/GMT.
- If cached JSON is missing, fetch from R2.
- If cached JSON `data_as_of_day_utc` is not the expected latest complete day, fetch from R2.
- If R2 still returns an older `data_as_of_day_utc` because the daily job has not completed yet, keep the newest available JSON and retry on the next normal page load or after a short bounded retry interval.
- Do not use per-request random cache busters.
- Use a stable per-day query parameter when needed to avoid stale browser/CDN cache while keeping URLs cacheable for the day:

```text
history/v2/who_2021/latest_who_2021.json?as_of=YYYY-MM-DD
```

The `as_of` parameter should be the expected latest complete day, not a timestamp. This creates one cacheable URL per day and avoids request-by-request origin misses.

### 7.3 Later public JSON products

Do not put all future WHO data into `latest_who_2021.json`. Add purpose-specific JSON products as the website needs them.

For league tables:

```text
history/v2/who_2021/latest_who_2021_league_tables.json
history/v2/who_2021/league_tables/as_of_day_utc=YYYY-MM-DD/rolling_year.json
history/v2/who_2021/league_tables/calendar_year=YYYY/complete_year.json
```

For later site/timeseries daily calendars:

```text
history/v2/who_2021/site_daily_calendar/connector_id=N/pollutant_code=<pollutant>/timeseries_id=<id>.json
```

### 7.4 Year-to-date daily square calendar

The later WHO page may show a year-to-date daily square calendar for each timeseries/pollutant. This is not the same as a year-to-date mean classification. It should be driven directly from `uk_aq_ops.who_2021_daily_status`, one square per day.

Each day should expose one of these public statuses:

- `above_guideline`
- `within_guideline`
- `not_enough_data`
- `no_data`

Rules:

- `above_guideline`: daily row exists, `valid_hour_count >= min_valid_hours_per_day`, and `above_who_daily_guideline = true`
- `within_guideline`: daily row exists, `valid_hour_count >= min_valid_hours_per_day`, and `above_who_daily_guideline = false`
- `not_enough_data`: hourly data existed for that day/timeseries, but fewer than the required valid hourly readings were available
- `no_data`: no source data exists for that day/timeseries

Do not apply the rolling/calendar 274-day minimum to the daily square calendar. The square calendar is a day-by-day display, not a period-level classification.

The Phase 2 daily table already stores invalid daily rows with `has_enough_data = false`, nullable `daily_mean_ugm3`, nullable `above_who_daily_guideline`, and a `valid_hour_count`. That supports the basic square-calendar output. If later public UI needs to distinguish "no source rows" from "source rows existed but were filtered/invalid", add an explicit source-row count to the daily calculation or a separate availability output before publishing that distinction.

Daily calendar JSON should contain compact per-day status rows for one timeseries or station/pollutant combination, for example:

```json
{
  "schema_version": 1,
  "timeseries_id": 12345,
  "station_id": 678,
  "station_name": "Example AURN Site",
  "source_network_code": "gov_uk_aurn",
  "pollutant_code": "pm25",
  "pollutant_label": "PM2.5",
  "days": [
    {
      "day_utc": "2026-07-02",
      "daily_mean_ugm3": 12.4,
      "valid_hour_count": 22,
      "status": "within_guideline"
    }
  ]
}
```

This supports later calendar-square views by month/year without requiring public Supabase queries.

## 8. Daily process

Implement the daily WHO derived-data process in the ops repo as a directly executed GitHub Actions batch workflow.

The workflow should be:

```text
.github/workflows/uk_aq_who_2021_daily.yml
```

The workflow must use `workflow_dispatch` only. The existing Cloudflare Scheduler remains the sole schedule authority and dispatches this workflow. Do not add a GitHub `schedule:` block.

Run the existing WHO batch implementation directly. Do not start an HTTP server and do not call an authenticated `/run` endpoint. The current calculation, readiness, summary and R2 publication logic in `run_job.ts` should be reused with the smallest safe refactor.

Required workflow characteristics:

- `permissions: contents: read`
- Deno version pinned consistently with the repository
- stable concurrency group such as `uk-aq-who-2021-daily`
- `cancel-in-progress: false`
- a workflow timeout with a small margin above the existing 15-minute task deadline
- direct execution of the WHO batch entry point
- no Google authentication, `gcloud`, Docker build, Artifact Registry or Secret Manager steps
- GitHub repository variables for non-secret configuration
- GitHub repository secrets for `OBS_AQIDB_SECRET_KEY`, R2 access key and R2 secret access key
- a bounded JSON run report uploaded as a workflow artefact with `if: always()`
- non-zero exit on a genuine calculation/publication failure
- successful exit for the existing clean deferred/no-op and already-completed outcomes

Suggested report path:

```text
tmp/uk_aq_who_2021_daily_report.json
```

The normal scheduler-dispatched workflow must use daily mode and production publication settings from repository configuration. Manual `workflow_dispatch` should also support the existing backfill and dry-run modes without changing normal defaults.

The workflow must preserve:

- `who_2021_processing_runs` logging
- readiness/deferred semantics
- idempotent daily, rolling and calendar upserts
- R2 parquet-before-JSON publication ordering
- dated JSON before `latest_who_2021.json`
- the current retry and warning/failure behaviour
- the existing source network, connector, pollutant and completeness defaults

Update the diagnostic egress caller label from the Cloud Run-specific value to a GitHub Actions-specific value only after checking whether any allow-list or monitoring rule relies on the old value.

### 8.1 Readiness gate and scheduler retry window

Do not rely on the clock alone to decide that yesterday's source data is complete enough for WHO summary publication.

Recommended scheduler pattern:

- Cloudflare Scheduler dispatches the GitHub workflow hourly during a bounded morning window, for example 04:00-09:00 UTC.
- Each workflow run calculates `latest_complete_day_utc = yesterday`.
- Before calculating or publishing summaries, the batch job checks whether the expected final hour-ending observations have arrived.
- If the day is not ready, the job logs a clean deferred/no-op run and exits successfully.
- If the day is ready, the job runs the daily/rolling/calendar calculations and publishes R2 outputs.
- If the day has already completed successfully, later workflow runs for the same `latest_complete_day_utc` no-op, except that the existing retryable R2 publication path may run where configured.

For `as_of_day_utc = 2026-07-02`, the final required hour-ending timestamp is:

```text
2026-07-03T00:00:00Z
```

Readiness checks should include:

1. Final hour presence: rows exist for eligible GOV.UK AURN pollutant timeseries at `observed_at = next_day_utc 00:00:00Z`.
2. Final hour coverage: per pollutant, enough active eligible timeseries have that final-hour row. Use a configurable threshold such as 90-95% rather than requiring 100%.
3. Daily validity coverage: optionally preview the daily calculation and require enough valid daily rows per pollutant before publishing public summary JSON.
4. Idempotency: check `who_2021_processing_runs` and/or summary rows so a day is not recalculated and republished after a successful run unless explicitly requested.

The Cloudflare scheduler entry should use the existing GitHub-workflow target pattern:

```toml
[jobs.uk_aq_who_2021_daily]
enabled = true
cron_expr = "0 4-9 * * *"
target_type = "github_workflow"
github_repo = "TEST-uk-aq/uk-aq-ops"
github_workflow_file = "uk_aq_who_2021_daily.yml"
github_ref = "main"
dry_run = false
notes = "WHO 2021 daily derived data via GitHub Actions"
```

Confirm the final job key and current authoritative scheduler conventions in the repository before editing `cloudflare/scheduler/jobs.toml`. Cloudflare D1 claim protection remains responsible for preventing duplicate dispatch of the same due slot. GitHub workflow concurrency prevents overlap between separate hourly slots.

Pseudo workflow:

1. Cloudflare Scheduler dispatches the GitHub workflow.
2. The workflow maps repository variables, secrets and manual inputs into the existing WHO runtime environment.
3. Determine latest complete UTC/GMT day.
4. Run the readiness gate for `latest_complete_day_utc` unless the request is an explicit backfill or dry-run that bypasses publication readiness.
5. If the readiness gate is not met, log a deferred/no-op run, write the report artefact and stop successfully.
6. Determine missing days in `who_2021_daily_status` for `source_network_code = 'gov_uk_aurn'` and pollutants `pm25`, `pm10`, and `no2`.
7. For each missing day from the first missing day to latest complete day:
   - read observations for that derived sample day and network/pollutant set using the hour-ending window `(day_utc 00:00, next_day_utc 00:00]`
   - aggregate to distinct UTC/GMT hourly means first
   - assign each hourly row to `sample_day_utc = (observed_at - interval '1 hour')::date`
   - calculate daily means from valid hourly means for that `sample_day_utc`
   - require at least 18 valid distinct hours
   - upsert into `who_2021_daily_status`
8. Recalculate rolling 365-day status for affected timeseries as of latest complete day.
9. Upsert `who_2021_rolling_year_status`.
10. Optionally recalculate current year-to-date rows when that later product is enabled.
11. If a previous calendar year is not final, calculate/finalise complete-year rows.
12. Write newly created/updated derived rows to R2 v2 parquet.
13. Write dated public summary JSON to R2.
14. Replace `history/v2/who_2021/latest_who_2021.json` only after parquet/archive outputs and dated JSON complete.
15. Write the bounded workflow report artefact and log run status, counts, date range, warnings and failures.

The process must remain idempotent. Re-running the same date updates the same primary keys and safely replaces the same R2 objects rather than creating duplicate logical data.

## 9. Backfill process

Keep a backfill mode for historical calculation. Backfills are manually dispatched through the same GitHub Actions workflow or run directly by an operator. Cloudflare Scheduler must dispatch only the normal daily mode.

Manual workflow inputs should map cleanly to the existing runtime settings:

```text
run_mode=daily|backfill|dry_run
start_day_utc=YYYY-MM-DD
end_day_utc=YYYY-MM-DD
publish_json=true|false
write_parquet=true|false
```

Codex should preserve the current environment-variable interface where possible rather than duplicating calculation options in workflow YAML. The workflow inputs should only translate into the existing environment values.

Equivalent batch parameters:

```text
--start-day YYYY-MM-DD
--end-day YYYY-MM-DD
--source-network-code gov_uk_aurn
--pollutants pm25,pm10,no2
--rebuild-daily
--rebuild-rolling
--rebuild-calendar
--publish-json
--dry-run
```

Backfill should:

1. Calculate daily rows for the requested range.
2. Recalculate rolling rows for every as-of day in the range, or at least for requested checkpoint days depending on performance.
3. Recalculate complete calendar years, and optionally year-to-date rows when that later product is enabled.
4. Write derived parquet outputs to R2 v2.
5. Publish dated/latest JSON outputs only when publication is explicitly enabled.
6. Write and upload the same bounded workflow report artefact as the normal daily task.

For the initial deployment, it is acceptable to backfill:

- daily rows from the earliest available AURN hourly observation history
- rolling-year rows from the first day where 365 days of possible history exists
- calendar-year rows from 2025 onwards, because current local backup has data from 2025-01-01

Do not make a large historical backfill part of the first execution-host validation. Validate the GitHub workflow with one normal TEST operation first, then run any required backfill separately.

## 10. R2 v2 archive paths

Use `history/v2/*`, not `history/v1/*`.

The v2 partition order should follow the existing observations pattern, with pollutant split after connector:

```text
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=<pollutant>/part-xxxxx.parquet
```

Use these derived output paths:

```text
history/v2/who_2021/daily_status/day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=<pollutant>/part-xxxxx.parquet
```

```text
history/v2/who_2021/rolling_year_status/as_of_day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=<pollutant>/part-xxxxx.parquet
```

```text
history/v2/who_2021/calendar_year_status/calendar_year=YYYY/period_type=complete_year/connector_id=N/pollutant_code=<pollutant>/part-xxxxx.parquet
```

If optional year-to-date period summaries are enabled later, use the same `calendar_year_status` prefix with `period_type=year_to_date`.

Recommended parquet columns should match the private Obs AQI DB tables closely. Keep column names stable so DuckDB can query the R2 archive later.

Use these public JSON output paths:

```text
history/v2/who_2021/summaries/as_of_day_utc=YYYY-MM-DD/who_2021_summary.json
history/v2/who_2021/latest_who_2021.json
```

Later public JSON products should use separate prefixes:

```text
history/v2/who_2021/league_tables/...
history/v2/who_2021/site_daily_calendar/...
```

## 11. Website wiring phase

Do not wire the homepage WHO card to Supabase for phase 1.

When ready, update the homepage card to read from R2:

```text
history/v2/who_2021/latest_who_2021.json
```

Expected frontend behaviour:

- If the R2 JSON loads, render live rows from the `cards` array.
- If it fails, keep the card visible with either static fallback values or an unobtrusive unavailable state.
- Do not block the existing Highest sensor readings card if WHO summary loading fails.
- Cache locally by `data_as_of_day_utc`.
- Refresh from R2 when the cached `data_as_of_day_utc` does not match the expected latest complete UTC/GMT day.
- Use `latest_who_2021.json?as_of=YYYY-MM-DD` for daily refreshes when needed. Do not use random or timestamp cache busters.
- The WHO card source pill should say `GOV.UK AURN only`.
- The WHO button should link to `/who-guidelines/`.
- The WHO button image should be:

```html
<img src="sidebar-images/UK-AQ-WHO-button-medium.svg" alt="WHO" />
```

## 12. Phasing recommendation

Yes, this needs phases. The calculation and publication logic already exists, but the execution host must now be migrated from GCP to GitHub Actions.

### Phase 1: Schema and reference values

Status: implemented.

Deliver:

- SQL migrations for the private Obs AQI DB WHO tables.
- Seed data for guideline values.
- RLS/grants consistent with private `uk_aq_ops` service-role patterns.
- Database comments explaining these are WHO health-based guideline comparisons, not UK legal-limit checks.

Implemented:

- Added canonical and focused Obs AQI DB schema definitions.
- Added:
  - `who_2021_guideline_values`
  - `who_2021_daily_status`
  - `who_2021_rolling_year_status`
  - `who_2021_calendar_year_status`
  - `who_2021_processing_runs`
- Seeded WHO 2021 PM2.5, PM10 and NO2 guideline values with the 4-day daily allowance.
- Added service-role-only RLS policies, grants, comments and `updated_at` triggers.
- Included explicit hour-ending daily-window metadata.

### Phase 2: Daily status calculation

Status: calculation code and schema implemented. The existing Cloud Run HTTP wrapper is transitional and is not the final execution host.

Final deliver:

- Direct batch calculation of `who_2021_daily_status` for GOV.UK AURN PM2.5, PM10 and NO2.
- 18-hour valid-day rule.
- Idempotent upserts.
- Daily, backfill and dry-run modes.
- One bounded run report for GitHub Actions.

Existing reusable implementation:

- `uk_aq_public.uk_aq_rpc_who_2021_daily_status_refresh`
- `uk_aq_public.uk_aq_rpc_who_2021_processing_run_log`
- `workers/uk_aq_who_2021_daily_cloud_run/run_job.ts`
- `workers/uk_aq_who_2021_daily_cloud_run/who_2021_daily_core.ts`
- existing focused tests and README

Phase 7 below moves the direct batch implementation into the final GitHub Actions execution path.

### Phase 3: Rolling and calendar summary calculation

Status: implemented in code and schema.

Deliver:

- Rolling 365-day summary calculation.
- Last complete calendar-year summary calculation.
- 274 valid-day threshold for full-year/rolling periods.
- Readiness gate with final-hour coverage checks and deferred no-op logging.
- In-memory/public-output builder for the 9 homepage card rows.
- Optional/deferred proportional year-to-date completeness.

Implemented:

- `uk_aq_public.uk_aq_rpc_who_2021_readiness_check`
- `uk_aq_public.uk_aq_rpc_who_2021_summary_refresh`
- daily, rolling and calendar upsert counts in processing-run logging
- readiness, already-completed and deferred behaviour in the shared batch implementation
- 9-row homepage summary generation

The 04:00-09:00 UTC readiness window remains, but Cloudflare Scheduler becomes the schedule authority in Phase 7.

### Phase 4: R2 v2 JSON publication and parquet writes

Status: implemented in the shared batch code. Apply/deploy/operational validation steps may still be required in TEST.

Deliver:

- Parquet R2 writes for daily, rolling and calendar outputs.
- R2 v2 partition paths.
- Re-run-safe replacement behaviour.
- Dated summary JSON and `latest_who_2021.json`.
- Daily cache/version key `?as_of=YYYY-MM-DD`.

Implemented:

- opt-in summary and parquet publication controls
- SigV4 R2 PUT support
- parquet-before-JSON publication ordering
- stable JSON serialisation
- retryable publication after an already-completed database calculation
- row-batch RPC `uk_aq_public.uk_aq_rpc_who_2021_r2_parquet_rows`
- Arrow and `parquet-wasm` generation
- nullable boolean handling
- agreed v2 object paths

Remaining TEST data-layer follow-up:

- apply/confirm the Phase 4 row-batch RPC
- confirm R2 credentials
- enable publication flags
- inspect one real TEST workflow publication

### Phase 5: Website data wiring

Status: implemented.

Implemented:

- homepage fetch of `history/v2/who_2021/latest_who_2021.json?as_of=YYYY-MM-DD`
- static fallback and localStorage reuse
- non-blocking status message
- preserved public wording and layout

### Phase 6: WHO guideline page and league tables

Status: later work.

Deliver later:

- WHO guideline page at `/who-guidelines/`
- rolling-year league tables
- calendar-year selectors
- optional year-to-date period selectors
- daily site/timeseries square-calendar JSON
- not-enough-data counts
- station detail links
- clear WHO guideline versus UK legal-limit explanation

### Phase 7: Migrate the daily execution host to GitHub Actions

Status: required by the 2026-07-23 amendment.

**Owner:** Codex for repository implementation, user/operator for real TEST runs and removal of GCP resources  
**Recommended model:** GPT-5.6 Codex with High reasoning

This is an execution-host migration. Do not rewrite the WHO calculation, readiness, database RPC or R2 publication rules.

#### Phase 7.1 Focused inspection

Before editing, Codex must read:

- `AGENTS.md`
- `system_docs/README.md`
- `system_docs/documentation_contract.md`
- the authoritative WHO, scheduler, R2 and task-health documents
- the current WHO worker and deploy workflow
- existing direct GitHub batch workflow patterns
- `cloudflare/scheduler/jobs.toml`
- scheduler config-sync code
- relevant environment/secret catalogues

Confirm:

- the direct command required to run `run_job.ts`
- the existing Deno version and dependency cache pattern
- the current 15-minute service timeout
- all runtime variables and actual secrets
- the active R2 publication settings
- the current scheduler GitHub-workflow target schema
- whether the egress caller label is allow-listed
- the smallest safe way to write a bounded JSON report

Do not call external services during this inspection.

#### Phase 7.2 Add the direct GitHub workflow

Add:

```text
.github/workflows/uk_aq_who_2021_daily.yml
```

Required behaviour:

- `workflow_dispatch` only
- no GitHub `schedule:`
- direct Deno batch execution
- no HTTP server
- no GCP authentication or deployment steps
- `permissions: contents: read`
- stable concurrency group with `cancel-in-progress: false`
- workflow timeout with a small margin over the current 15-minute task limit
- normal daily defaults for scheduler dispatch
- manual daily, backfill and dry-run inputs
- direct mapping of existing non-secret variables
- direct GitHub secret mapping for Obs AQI DB and R2 credentials
- bounded JSON report uploaded with `if: always()`
- existing deferred/already-completed outcomes remain successful
- genuine calculation, database or publication failures remain non-zero

Use the current `run_job.ts` and core modules with the smallest safe refactor. Do not duplicate calculation logic in workflow YAML.

During initial implementation, retain the existing Cloud Run service and deploy workflow solely as rollback. Do not deploy or delete GCP resources in this Codex phase.

#### Phase 7.3 Minimal structural checks

Before the first real TEST run, run only:

- `deno check` on changed TypeScript entry points
- the repository's existing fast YAML/workflow parse check
- the scheduler TOML parse or payload-generation check only if the scheduler entry is edited in the same phase
- one narrow local report-file check only if needed to prove the direct job writes valid JSON

Do not create a broad new test suite, mock Supabase/R2 system, shadow comparison or soak test. Functional testing happens through real operation on TEST.

#### Phase 7.4 Real TEST workflow validation

After the workflow is on `main`, manually dispatch one normal daily run.

Confirm:

- checkout and Deno setup succeed
- the direct batch job runs without starting an HTTP server
- readiness/deferred/already-completed status is credible
- one processing-run record is written
- the bounded report artefact is uploaded
- when ready, daily/rolling/calendar processing completes
- when publication is enabled, parquet and dated/latest JSON objects are written in the existing order
- no secrets appear in logs or artefacts
- the workflow stays within the current operational deadline

A dry run is optional. Use it only for a specific unresolved configuration risk.

#### Phase 7.5 Cut over Cloudflare Scheduler

After one accepted normal manual workflow run, update `cloudflare/scheduler/jobs.toml` to target the GitHub workflow using the entry in section 8.1.

Codex must:

- retain the 04:00-09:00 UTC hourly readiness window unless current authoritative configuration differs
- use `target_type = "github_workflow"`
- target `TEST-uk-aq/uk-aq-ops`
- target `uk_aq_who_2021_daily.yml` on `main`
- remove Cloud Run-only target fields
- not add a GitHub cron
- run only the existing scheduler config parse/payload check
- not sync D1 or dispatch the workflow

The user/operator runs the existing scheduler config-sync process and confirms one scheduled D1 claim and GitHub workflow dispatch.

#### Phase 7.6 Remove the old GCP execution path

After one accepted scheduler-dispatched TEST run, the user may remove:

- the GCP Cloud Scheduler trigger for the WHO task
- the WHO Cloud Run service
- its Artifact Registry image(s), where no retention reason remains

After the user confirms removal, Codex should make one focused cleanup:

- remove `.github/workflows/uk_aq_who_2021_daily_cloud_run_deploy.yml`
- remove the obsolete HTTP service wrapper and Dockerfile if no rollback use remains
- rename the active worker directory from `uk_aq_who_2021_daily_cloud_run` to a neutral name such as `uk_aq_who_2021_daily` if this can be done as a focused change
- update imports, scripts, READMEs and active runbooks
- change Cloud Run-specific diagnostic labels to GitHub Actions-specific labels
- remove only GCP variables and Secret Manager-name settings proven to be exclusive to this retired task
- retain all direct runtime variables and GitHub secrets
- retain generic GCP support used by other services
- do not edit historical plans or archived evidence

Run only directly relevant Deno, YAML and configuration parsing checks.

#### Phase 7.7 Update authoritative system documentation

**Owner:** ChatGPT in Chat mode using Thinking

After the workflow, scheduler cutover and GCP removal are accepted, update the relevant authoritative `system_docs/` files.

Document:

- Cloudflare Scheduler and D1 as schedule/dispatch authority
- GitHub Actions as execution host
- workflow and direct entry-point names
- 04:00-09:00 UTC readiness window
- concurrency and timeout behaviour
- readiness/deferred/already-completed semantics
- processing-run logging
- R2 publication order and paths
- manual backfill operation
- rollback and monitoring
- removal of the WHO Cloud Run service and deploy workflow

## 13. Validation checks

### 13.1 Execution-host migration validation

This is the TEST system. Pre-deployment validation for the GitHub Actions migration must be minimal and structural.

Before deployment, use only:

- `deno check` for changed TypeScript
- existing fast GitHub workflow YAML validation
- existing scheduler TOML parsing or payload generation where applicable
- one narrow JSON report-file check only if genuinely needed

Do not build a speculative test suite. Functional validation happens through:

1. one manually dispatched normal TEST workflow run;
2. one Cloudflare Scheduler-dispatched TEST workflow run after cutover.

Use the workflow artefact, `who_2021_processing_runs`, representative Obs AQI DB counts and R2 objects as the real operational evidence.

### 13.2 Calculation regression reference

Use local DuckDB outputs and private Obs AQI DB query outputs to compare when a calculation-specific change or real TEST discrepancy requires it.

Expected production-style 18-hour sample for latest day 2026-07-02:

```text
Rolling year range: 03/07/2025 to 02/07/2026

Daily guideline:
PM2.5 96.6%, 140 of 145 sensors
PM10 7.4%, 10 of 135 sensors
NO2 81.5%, 123 of 151 sensors

Yearly guideline, rolling year:
PM2.5 92.4%, 134 of 145 sensors
PM10 17.0%, 23 of 135 sensors
NO2 71.5%, 108 of 151 sensors

Last full year:
PM2.5 96.2%, 127 of 132 sensors
PM10 32.3%, 40 of 124 sensors
NO2 79.6%, 121 of 152 sensors
```

These are not hard-coded production expectations forever. They are a regression reference against the first implementation using the same backup data. Do not require this broad comparison solely for the execution-host migration unless the real TEST result suggests the calculation changed.

## 14. Important non-goals

Do not include UK legal-limit calculations in this WHO phase.

Do not call the result UK legal compliance.

Do not mix Breathe London into the headline AURN WHO summary.

Do not make the browser calculate percentages from raw daily/rolling rows for the homepage card.

Do not use “safe limits” wording.

Do not add a GitHub Actions `schedule:` trigger.

Do not keep GCP Cloud Run or GCP Cloud Scheduler as part of the final daily WHO execution path.

Do not rewrite the existing WHO calculation, readiness, RPC or R2 publication logic merely to change execution host.

Do not run a large historical backfill as part of the first GitHub workflow validation.

## 15. Done criteria

The implementation is done when:

1. The private WHO calculation/state schema exists in Obs AQI DB.
2. WHO guideline values are seeded.
3. Daily status rows can be generated and upserted for `source_network_code = 'gov_uk_aurn'` and pollutants `pm25`, `pm10`, and `no2`.
4. Rolling-year rows can be generated and upserted.
5. Last complete calendar-year rows can be generated and upserted.
6. R2 v2 parquet archives are written to the agreed paths.
7. Dated summary JSON is written for the latest processed day.
8. `history/v2/who_2021/latest_who_2021.json` returns 9 homepage card rows for the latest processed day.
9. Re-running the job for the same date is idempotent and does not create duplicate logical data.
10. `.github/workflows/uk_aq_who_2021_daily.yml` runs the WHO batch logic directly through `workflow_dispatch`.
11. The workflow uses GitHub repository variables and secrets directly and has no GCP authentication, deployment or Secret Manager dependency.
12. Cloudflare Scheduler is the sole schedule authority and dispatches the workflow during the agreed readiness window.
13. The GitHub workflow has stable non-cancelling concurrency and a bounded timeout.
14. A bounded JSON report is uploaded for every workflow attempt.
15. One manual normal TEST workflow run and one scheduler-dispatched TEST run have been accepted.
16. The old WHO GCP Cloud Scheduler trigger and Cloud Run service have been removed after cutover.
17. Obsolete Cloud Run deployment files and task-exclusive GCP configuration have been removed, while shared GCP support remains intact.
18. The website can consume the public R2 JSON without changing the private calculation data model.
19. Authoritative `system_docs/` describe Cloudflare Scheduler -> GitHub Actions -> Obs AQI DB/R2 as the active WHO daily execution path.
