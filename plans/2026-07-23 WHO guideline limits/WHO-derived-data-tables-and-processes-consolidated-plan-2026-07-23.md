# UK AQ WHO guideline derived data implementation plan

Date: 2026-07-07  
Amended and consolidated: 2026-07-23  
Scope: private Obs AQI DB calculation/state tables, GitHub Actions processing, Cloudflare Scheduler dispatch, R2 v2 derived parquet archive, R2 public JSON outputs, Dropbox operational reports, and later website wiring for WHO guideline information.

This is the single authoritative implementation plan. It incorporates the previous daily-workflow recalculation and Dropbox-report amendment directly into the main plan. The separate amendment is no longer required for implementation.

This plan is for VS Code Codex. Recommended model: **GPT-5.6 Codex with High reasoning**. It is separate from the static homepage card implementation plan. The homepage card can initially use hard-coded figures. This plan creates the data layer that will later feed that card, the WHO guideline page, league tables and sensor detail pages.

The daily calculation and publication task is built directly for GitHub Actions and the existing Cloudflare Scheduler. Cloudflare Scheduler is the sole schedule authority and dispatches the GitHub workflow through `workflow_dispatch`.

Codex can work directly from the early implementation phases in this plan. The later phases are reserved for the user/operator and ChatGPT after the repository implementation is complete.

## 1. Goal

Create a derived WHO guideline data layer for UK AQ that calculates and stores:

1. Daily mean status for each AURN pollutant timeseries.
2. Rolling 365-day WHO summary status for each AURN pollutant timeseries.
3. Complete calendar-year WHO summary status for each AURN pollutant timeseries, with optional later year-to-date period summaries.
4. Small public R2 JSON outputs that the website can read cheaply.
5. R2 v2 parquet archives of the same derived outputs for rebuild/debug/history use.
6. A bounded operational JSON report for every workflow attempt, uploaded to Dropbox and retained as a GitHub Actions artefact.

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

The daily execution path is:

```text
Cloudflare Scheduler
  -> GitHub workflow_dispatch
  -> GitHub Actions workflow
  -> direct WHO Deno batch job
  -> private Obs AQI DB RPCs
  -> R2 v2 parquet and public JSON
  -> Dropbox operational report upload
```

Do not add a GitHub Actions `schedule:` trigger. The workflow must run the batch entry point directly rather than starting or calling an HTTP service.

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

Use:

```text
workers/uk_aq_who_2021_daily/
.github/workflows/uk_aq_who_2021_daily.yml
```

The worker directory must use neutral task naming. Keep calculation, readiness, summary, parquet, R2 publication and report modules together under this directory, with a direct batch entry point and no HTTP server.

The workflow must use `workflow_dispatch` only. Cloudflare Scheduler remains the sole schedule authority and dispatches this workflow. Do not add a GitHub `schedule:` block.

Required workflow characteristics:

- `permissions: contents: read`
- Deno version pinned consistently with the repository
- stable concurrency group such as `uk-aq-who-2021-daily`
- `cancel-in-progress: false`
- workflow timeout with a small margin above the 15-minute task deadline
- direct execution of the WHO batch entry point
- GitHub repository variables for non-secret configuration
- GitHub repository secrets for `OBS_AQIDB_SECRET_KEY`, R2 credentials and the repository-consistent Dropbox credential
- `UK_AQ_DROPBOX_ROOT` mapped from non-secret GitHub repository configuration
- a bounded JSON run report uploaded to Dropbox and retained as a GitHub Actions artefact, both with `if: always()`
- non-zero exit on a genuine calculation, database, R2 publication or Dropbox report-upload failure
- successful exit for clean `deferred` and `unchanged` outcomes

Write the runner-local report to:

```text
tmp/uk_aq_who_2021_daily_report.json
```

Then upload it to Dropbox through the repository's existing Dropbox helper if one exists. If none exists, add the smallest repository-consistent Dropbox API uploader.

`${UK_AQ_DROPBOX_ROOT}` is the remote Dropbox root path. It is not a local GitHub runner or Mac filesystem path.

Upload reports under:

```text
${UK_AQ_DROPBOX_ROOT}/who_2021/
```

Use a unique timestamped filename that includes the GitHub run ID, for example:

```text
uk_aq_who_2021_daily_report_2026-07-23T090000Z_123456789.json
```

Keep the GitHub Actions artefact as a secondary copy for workflow inspection.

The normal scheduler-dispatched workflow must use daily mode and publication settings from repository configuration. Manual `workflow_dispatch` must support the existing daily, backfill and dry-run modes without changing normal defaults.

The implementation must preserve:

- `who_2021_processing_runs` logging
- the 18-valid-hour individual daily rule
- readiness/deferred semantics for the latest complete day
- recalculation of the latest two complete sample days on every scheduled run
- idempotent daily, rolling and calendar upserts
- content-aware R2 writes that skip unchanged objects
- R2 parquet-before-JSON publication ordering
- dated JSON before `latest_who_2021.json`
- Dropbox report upload after the local report is written
- the current retry and warning/failure behaviour
- the existing source network, connector, pollutant and completeness defaults

Use the diagnostic egress caller label:

```text
uk_aq_who_2021_daily_github_actions
```

Confirm that the label is accepted by any relevant egress allow-list or monitoring rule.

### 8.1 Normal scheduled-day selection

Every normal scheduler-dispatched workflow run must calculate:

```text
latest_complete_day_utc = yesterday
correction_day_utc = latest_complete_day_utc - 1 day
```

Every run at 04:00, 05:00, 06:00, 07:00, 08:00 and 09:00 UTC must recalculate both complete sample days.

Do not recalculate a wider normal correction window. Corrections older than the day before yesterday remain a manual backfill concern.

A successful earlier run must not prevent a later hourly run from recalculating the same two days. Idempotency must prevent duplicate logical rows and objects, not prevent recalculation.

### 8.2 Readiness and publication date

The latest-day readiness check is a network-level ingest-readiness signal. It is not a requirement that every individual timeseries contains the final `00:00` hour-ending observation.

An individual timeseries daily mean remains valid when it has at least 18 valid distinct hourly observations in the sample-day window, even when its final midnight observation is absent.

The readiness result controls which day becomes the current published summary date:

```text
if latest_complete_day_utc is ready:
    publication_as_of_day_utc = latest_complete_day_utc
else:
    publication_as_of_day_utc = correction_day_utc
```

Both target days must still be recalculated in either case.

When the latest day is deferred:

- record the latest day as deferred;
- keep the current public summary as of `correction_day_utc`;
- regenerate the correction-day rolling and current summary outputs;
- update their R2 objects only if their content changed.

When readiness passes, advance the current rolling and summary outputs to `latest_complete_day_utc`.

Readiness checks should include:

1. Final-hour presence for eligible GOV.UK AURN pollutant timeseries at `observed_at = next_day_utc 00:00:00Z`.
2. Final-hour coverage per pollutant, using a configurable threshold such as 90-95% rather than requiring 100%.
3. Optional daily-validity preview when needed to prevent publishing clearly incomplete public summaries.
4. Clear readiness evidence in the bounded report.

The readiness result must not create an `already_completed` skip that suppresses later hourly recalculation.

### 8.3 Hourly recalculation window

The Cloudflare Scheduler entry should use the existing GitHub-workflow target pattern:

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

Confirm the final job key and current authoritative scheduler conventions before editing `cloudflare/scheduler/jobs.toml`.

Each hourly slot is an intentional recalculation opportunity for late or amended observations. It is not merely a failure retry.

Cloudflare D1 claim protection remains responsible for preventing duplicate dispatch of the same due slot. GitHub workflow concurrency prevents overlap between separate hourly slots.

Expected normal outcomes are:

- `deferred`: the latest complete day is not ready, but both daily target days and the correction-day current summary are still recalculated;
- `updated`: one or more derived rows or published objects changed;
- `unchanged`: recalculation completed and the logical result matches the existing state;
- `failed`: calculation, database, R2 publication or Dropbox report upload failed.

The existing processing-run schema may retain its current status vocabulary where required. The bounded report must expose the operational outcome above clearly and consistently.

### 8.4 Daily workflow sequence

The normal daily workflow must:

1. Determine `latest_complete_day_utc` and `correction_day_utc`.
2. Run the latest-day readiness check.
3. Recalculate daily status for both target days using the hour-ending window `(day_utc 00:00, next_day_utc 00:00]`.
4. Apply the existing 18-valid-hour rule independently to each timeseries and day.
5. Idempotently upsert changed, valid, invalid or newly missing daily states according to the existing RPC contract.
6. Select `publication_as_of_day_utc` from the readiness result.
7. Recalculate the current rolling 365-day and other enabled current summaries as of `publication_as_of_day_utc`.
8. Generate affected R2 parquet and JSON payloads using stable serialisation or a stable logical-content hash.
9. Compare every generated R2 payload with the existing R2 object.
10. Upload only changed R2 objects.
11. Preserve parquet-before-JSON ordering and dated JSON before `latest_who_2021.json`.
12. Write the bounded JSON run report.
13. Upload the report to Dropbox and retain the same report as a GitHub Actions artefact.

### 8.5 R2 comparison state

Do not use GitHub workflow artefacts or caches as cross-run application state.

Use:

- Obs AQI DB as the source for derived database state;
- the existing R2 object as the comparison source for each published object.

Before an R2 write, compare the new canonical payload or stable logical-content hash with the existing object. Skip the write when unchanged. Replace the same stable object key when changed.

The comparison must ignore volatile fields that would make identical logical content appear changed, such as a newly generated timestamp, unless that field is intentionally part of the published product.

The report must list changed and unchanged R2 objects so the hourly behaviour is auditable.

### 8.6 Report contents

Keep the report bounded and free of secrets.

Include at least:

- workflow run ID and attempt;
- run mode;
- start and finish timestamps;
- `latest_complete_day_utc`;
- `correction_day_utc`;
- `publication_as_of_day_utc`;
- readiness result and coverage evidence;
- daily, rolling and calendar row counts;
- R2 objects checked;
- R2 objects updated;
- R2 objects unchanged;
- Dropbox destination path and upload result;
- warnings;
- final operational outcome.

Write the report on successful, deferred, unchanged and failure paths wherever technically possible.

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
6. Write the same bounded report as the normal daily task, upload it to `${UK_AQ_DROPBOX_ROOT}/who_2021/`, and retain it as a GitHub Actions artefact.

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

## 12. Existing implementation baseline

The following work already exists and must be reused rather than rewritten without a clear reason.

### 12.1 Schema and reference values

Status: implemented.

Existing implementation includes:

- private Obs AQI DB WHO tables;
- WHO 2021 PM2.5, PM10 and NO2 guideline values;
- the 4-day daily allowance;
- service-role-only RLS policies and grants;
- database comments and `updated_at` triggers;
- explicit hour-ending daily-window metadata.

### 12.2 Daily status calculation

Status: calculation code and schema implemented. The active worker still needs to be organised under the neutral direct-batch path.

Reusable implementation includes:

- `uk_aq_public.uk_aq_rpc_who_2021_daily_status_refresh`;
- `uk_aq_public.uk_aq_rpc_who_2021_processing_run_log`;
- the current WHO daily job, core and parquet modules;
- existing focused tests and README material;
- daily, backfill and dry-run modes.

### 12.3 Rolling and calendar summaries

Status: implemented in code and schema.

Reusable implementation includes:

- `uk_aq_public.uk_aq_rpc_who_2021_readiness_check`;
- `uk_aq_public.uk_aq_rpc_who_2021_summary_refresh`;
- daily, rolling and calendar upsert counts in processing-run logging;
- readiness and deferred behaviour;
- 9-row homepage summary generation;
- 274-valid-day threshold for rolling and complete-year periods.

Any existing successful-run or `already_completed` skip must be amended so it does not suppress the required hourly recalculation.

### 12.4 R2 publication

Status: implemented in the shared batch code. Apply and operational validation steps may still be required in TEST.

Reusable implementation includes:

- opt-in summary and parquet publication controls;
- SigV4 R2 PUT support;
- parquet-before-JSON ordering;
- stable JSON serialisation;
- row-batch RPC `uk_aq_public.uk_aq_rpc_who_2021_r2_parquet_rows`;
- Arrow and `parquet-wasm` generation;
- nullable boolean handling;
- agreed R2 v2 object paths.

The implementation must add or confirm R2 read/metadata support for change-aware comparison before writing.

### 12.5 Website wiring

Status: implemented.

Existing implementation includes:

- homepage fetch of `history/v2/who_2021/latest_who_2021.json?as_of=YYYY-MM-DD`;
- static fallback and localStorage reuse;
- non-blocking status message;
- preserved public wording and layout.

### 12.6 Later website work

Status: not part of the active execution-host implementation.

Later work may include:

- `/who-guidelines/`;
- rolling-year league tables;
- complete-year selectors;
- optional year-to-date period selectors;
- daily square-calendar JSON;
- station detail links;
- expanded WHO guideline explanations.

## 13. Phased implementation and ownership

All repository implementation phases come first and are owned by Codex. Real TEST operation follows after the Codex phases are committed. Authoritative documentation is the final ChatGPT phase.

For Codex, use **GPT-5.6 Codex with High reasoning**.

### Phase 1: Codex focused inspection

**Owner:** Codex  
**Testing:** structural viability inspection only

Before editing, Codex must read:

- `AGENTS.md`;
- `system_docs/README.md`;
- `system_docs/documentation_contract.md`;
- authoritative WHO, scheduler, R2, Dropbox and task-health documents;
- current WHO calculation, readiness and publication modules;
- existing direct GitHub batch workflow patterns;
- `cloudflare/scheduler/jobs.toml`;
- scheduler config-sync code;
- relevant environment, variable and secret catalogues.

Confirm:

- the direct Deno command for the WHO batch job;
- repository Deno version and dependency-cache pattern;
- all runtime variables and actual GitHub secret names;
- active R2 publication settings;
- scheduler GitHub-workflow target schema;
- whether the diagnostic egress caller label is accepted;
- where a successful-run or `already_completed` skip currently occurs;
- the smallest focused change that permits later hourly recalculation;
- the existing R2 read or metadata mechanism suitable for change comparison;
- any existing Dropbox API/helper pattern;
- if no Dropbox helper exists, the smallest repository-consistent uploader;
- the Dropbox secret name and remote-path conventions;
- how `UK_AQ_DROPBOX_ROOT` is supplied to GitHub Actions;
- the smallest safe way to write a bounded JSON report;
- whether any targeted structural check is genuinely required.

Do not call external services during inspection.

### Phase 2: Codex neutral direct worker

**Owner:** Codex

Create or organise the active implementation under:

```text
workers/uk_aq_who_2021_daily/
```

Requirements:

- reuse the existing calculation, readiness, RPC and R2 publication logic;
- do not duplicate calculation logic;
- do not start an HTTP server;
- use neutral task names in paths, scripts, log metadata and documentation;
- keep direct entry point, core calculation, readiness, parquet, R2 comparison and report modules together;
- preserve daily, backfill and dry-run modes;
- write `tmp/uk_aq_who_2021_daily_report.json` on all normal outcomes and failure paths wherever possible;
- use `uk_aq_who_2021_daily_github_actions` as the diagnostic egress caller label;
- update relevant package scripts and environment catalogues;
- remove unused alternate execution-path files rather than retaining two active implementations;
- follow the repository archive policy only for active non-test code that is actually changed.

### Phase 3: Codex hourly recalculation and readiness behaviour

**Owner:** Codex

Implement the consolidated behaviour in section 8:

- recalculate yesterday and the day before yesterday on every scheduled run;
- do not use a prior successful run to suppress later recalculation;
- apply readiness only to the current publication date;
- retain the individual 18-valid-hour daily rule;
- keep the current public summary on the correction day while the latest day is deferred;
- advance publication to yesterday when readiness passes;
- preserve idempotent upserts;
- expose `deferred`, `updated`, `unchanged` and `failed` outcomes clearly in the report.

### Phase 4: Codex R2 comparison and Dropbox reporting

**Owner:** Codex

Implement:

- stable serialisation or stable logical-content hashing;
- comparison against the existing R2 object;
- no R2 write when logical content is unchanged;
- overwrite of the same stable key when content changed;
- preservation of parquet-before-JSON ordering;
- preservation of dated JSON before `latest_who_2021.json`;
- changed and unchanged object lists in the report;
- remote Dropbox upload to `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- timestamped report filenames including the GitHub run ID;
- GitHub Actions artefact retention as a secondary report copy;
- visible failure when Dropbox upload fails;
- no direct filesystem write to `${UK_AQ_DROPBOX_ROOT}`.

### Phase 5: Codex GitHub Actions workflow

**Owner:** Codex

Add or update:

```text
.github/workflows/uk_aq_who_2021_daily.yml
```

Required behaviour:

- `workflow_dispatch` only;
- no GitHub `schedule:`;
- direct Deno batch execution;
- `permissions: contents: read`;
- stable concurrency group with `cancel-in-progress: false`;
- workflow timeout with a small margin over the 15-minute task deadline;
- normal daily defaults for scheduler dispatch;
- manual daily, backfill and dry-run inputs;
- direct mapping of existing non-secret repository variables;
- direct mapping of Obs AQI DB, R2 and Dropbox credentials from GitHub secrets;
- `UK_AQ_DROPBOX_ROOT` mapped from non-secret configuration;
- Dropbox report upload and GitHub artefact retention with `if: always()` after report creation;
- clean `deferred` and `unchanged` outcomes remain successful;
- genuine calculation, database, R2 publication or Dropbox upload failures remain non-zero.

Do not duplicate runtime configuration or calculation logic in workflow YAML. Inputs should translate into the existing environment-variable interface.

### Phase 6: Codex Cloudflare Scheduler configuration

**Owner:** Codex

Add or update the WHO entry in:

```text
cloudflare/scheduler/jobs.toml
```

Requirements:

- retain `cron_expr = "0 4-9 * * *"` unless authoritative scheduler configuration requires a syntax-only adjustment;
- document the schedule as an hourly recalculation and readiness window;
- use `target_type = "github_workflow"`;
- target `TEST-uk-aq/uk-aq-ops`;
- target `uk_aq_who_2021_daily.yml` on `main`;
- use normal daily mode;
- do not add a GitHub cron;
- preserve Cloudflare D1 due-slot and duplicate-claim protection.

Codex must not sync D1 or dispatch the workflow during implementation.

### Phase 7: Codex minimal structural validation and repository completion

**Owner:** Codex

Before handing over to the user, run only:

- `deno check` on changed TypeScript entry points;
- the repository's existing fast YAML/workflow parse check;
- scheduler TOML parse or payload-generation check;
- one narrow report JSON check only if genuinely needed;
- one narrow Dropbox path-construction or uploader invocation check only if existing structural coverage is absent.

Do not create a broad new test suite, mock Obs AQI DB/R2/Dropbox system, shadow comparison or soak test.

Codex must then provide:

- files changed;
- structural checks run and their results;
- exact GitHub variables and secrets required;
- any configuration the user must add;
- exact manual workflow inputs for the first TEST run;
- any unresolved risk that requires real TEST evidence.

Codex must not deploy, sync the scheduler, dispatch the workflow, run a large backfill or edit authoritative `system_docs/` during Phases 1-7.

### Phase 8: User/operator real TEST operation

**Owner:** User/operator

After Codex Phases 1-7 are on `main`:

1. Add or confirm the required GitHub variables and secrets.
2. Manually dispatch one normal daily workflow run.
3. Inspect the workflow log, bounded artefact, processing-run row, R2 objects and Dropbox report.
4. Run the existing Cloudflare Scheduler configuration sync.
5. Accept one scheduler-dispatched workflow run.
6. Allow a later hourly slot to run so the recalculation behaviour can be observed after an earlier success.

Confirm through real TEST operation:

- checkout and Deno setup succeed;
- the direct batch job runs without starting an HTTP server;
- yesterday and the day before yesterday are recalculated;
- a prior successful hourly run does not suppress a later run;
- readiness deferral keeps the public summary on the correction day;
- correction-day output can still change while the latest day is deferred;
- the individual 18-valid-hour rule remains correct;
- changed database rows are idempotently upserted;
- unchanged R2 objects are not rewritten;
- changed R2 objects are replaced in the required publication order;
- dated JSON is written before `latest_who_2021.json`;
- the Dropbox report appears under `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- the same report is retained as a GitHub Actions artefact;
- no secrets appear in logs, reports or artefacts;
- the workflow stays within the operational deadline;
- the scheduler produces one D1 claim and one workflow dispatch for each due slot.

A dry run is optional. Use it only for a specific unresolved configuration risk.

Do not include a large historical backfill in the first execution-host validation. Run any required backfill separately after the normal workflow is accepted.

### Phase 9: ChatGPT authoritative documentation and close-out

**Owner:** ChatGPT in Chat mode using Thinking

After the user accepts the real TEST results, update the relevant authoritative `system_docs/` files.

Document:

- Cloudflare Scheduler and D1 as schedule and dispatch authority;
- GitHub Actions as execution host;
- workflow and direct entry-point names;
- 04:00-09:00 UTC hourly recalculation and readiness window;
- recalculation of yesterday and the day before yesterday;
- readiness and publication-date selection;
- `deferred`, `updated`, `unchanged` and `failed` operational outcomes;
- individual 18-valid-hour semantics;
- processing-run logging;
- change-aware R2 publication;
- R2 publication order and paths;
- Dropbox report upload to `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- GitHub Actions artefact retention as a secondary report copy;
- manual backfill operation;
- monitoring and failure handling;
- actual TEST evidence and any accepted limitations.

Do not create duplicate authority across multiple system documents.

ChatGPT should also mark this plan with the accepted implementation status and record any deferred later website work.

## 14. Validation checks

### 14.1 Pre-operation structural validation

This is the TEST system. Before real operation, validation must be minimal and structural.

Use only:

- `deno check` for changed TypeScript;
- existing fast GitHub workflow YAML validation;
- existing scheduler TOML parsing or payload generation;
- one narrow report JSON check only if genuinely needed;
- one narrow Dropbox uploader/path check only if genuinely needed.

Do not build a speculative test suite. Functional validation happens through real operation on TEST.

### 14.2 Real TEST evidence

Use:

1. one manually dispatched normal workflow run;
2. one scheduler-dispatched workflow run;
3. one later hourly run after an earlier successful run.

Use the workflow logs, bounded report, `who_2021_processing_runs`, representative Obs AQI DB counts, R2 object metadata/content and Dropbox report as the operational evidence.

### 14.3 Calculation regression reference

Use local DuckDB outputs and private Obs AQI DB query outputs only when a calculation-specific change or real TEST discrepancy requires it.

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

These are not permanent hard-coded expectations. They are a regression reference against the first implementation using the same backup data. Do not require this broad comparison unless a real TEST result suggests the calculation changed.

## 15. Important non-goals

Do not include UK legal-limit calculations in this WHO phase.

Do not call the result UK legal compliance.

Do not mix Breathe London into the headline AURN WHO summary.

Do not make the browser calculate percentages from raw daily/rolling rows for the homepage card.

Do not use “safe limits” wording.

Do not add a GitHub Actions `schedule:` trigger.

Do not create an HTTP service or alternate execution host for the daily WHO task.

Do not duplicate the Cloudflare schedule in GitHub.

Do not rewrite the existing WHO calculation, readiness, RPC or R2 publication logic merely to package the direct worker.

Do not run a large historical backfill as part of the first GitHub workflow validation.


Do not use GitHub Actions artefacts or caches as authoritative cross-run application state.

Do not suppress later hourly recalculation merely because an earlier run succeeded.

Do not write directly to `${UK_AQ_DROPBOX_ROOT}` as a local filesystem path.

Do not recalculate more than yesterday and the day before yesterday during normal scheduled operation. Older corrections use manual backfill.

## 16. Done criteria

The implementation is done when:

1. The private WHO calculation/state schema exists in Obs AQI DB.
2. WHO guideline values are seeded.
3. Daily status rows can be generated and upserted for `source_network_code = 'gov_uk_aurn'` and pollutants `pm25`, `pm10`, and `no2`.
4. Rolling-year rows can be generated and upserted.
5. Last complete calendar-year rows can be generated and upserted.
6. Every normal hourly run recalculates yesterday and the day before yesterday.
7. A prior successful run does not suppress later recalculation.
8. Readiness controls the current published `as_of_day_utc`, not whether the two private daily dates can be recalculated.
9. Individual daily validity remains based on at least 18 valid distinct hours and does not require an individual timeseries to contain the final midnight observation.
10. R2 v2 parquet archives are written to the agreed paths.
11. Dated summary JSON is written before `history/v2/who_2021/latest_who_2021.json`.
12. The latest JSON returns the 9 homepage card rows for the current published day.
13. Re-running the job is idempotent and does not create duplicate logical data.
14. Unchanged R2 JSON and parquet objects are not rewritten.
15. Changed R2 objects replace the same stable keys in the required publication order.
16. The active direct worker is under `workers/uk_aq_who_2021_daily/` and does not start an HTTP server.
17. `.github/workflows/uk_aq_who_2021_daily.yml` runs the WHO batch logic directly through `workflow_dispatch`.
18. Cloudflare Scheduler is the sole schedule authority and dispatches the workflow during the 04:00-09:00 UTC window.
19. The workflow has stable non-cancelling concurrency and a bounded timeout.
20. Every workflow attempt writes a bounded report wherever technically possible.
21. Every report is uploaded through Dropbox to `${UK_AQ_DROPBOX_ROOT}/who_2021/` and retained as a GitHub Actions artefact.
22. One manual normal TEST run, one scheduler-dispatched TEST run and one later hourly recalculation run have been accepted.
23. The scheduler uses the repository's normal D1 due-slot and duplicate-claim protection.
24. No secrets appear in logs, reports or artefacts.
25. The website can consume the public R2 JSON without changing the private calculation data model.
26. Authoritative `system_docs/` describe the accepted Cloudflare Scheduler -> GitHub Actions -> Obs AQI DB/R2/Dropbox execution path.
