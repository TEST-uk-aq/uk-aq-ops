# UK AQ WHO guideline derived data implementation plan

Date: 2026-07-07  
Scope: private Obs AQI DB calculation/state tables, daily processing, R2 v2 derived parquet archive, R2 public JSON outputs, and later website wiring for WHO guideline information.

This plan is for VS Code Codex. It is separate from the static homepage card implementation plan. The homepage card can initially use hard-coded figures. This plan creates the data layer that will later feed that card, the WHO guideline page, league tables and sensor detail pages.

## 1. Goal

Create a derived WHO guideline data layer for UK AQ that calculates and stores:

1. Daily mean status for each AURN pollutant timeseries.
2. Rolling 365-day WHO summary status for each AURN pollutant timeseries.
3. Calendar-year and year-to-date WHO summary status for each AURN pollutant timeseries.
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
- Valid year-to-date period: use a proportional 75% threshold based on elapsed days, with a minimum of 1 valid day.

Suggested year-to-date threshold:

```sql
GREATEST(1, CEIL(period_day_count * 0.75))
```

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

Purpose: complete calendar years and current year-to-date summaries.

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

Implement a daily WHO derived-data process in the ops repo as a scheduled Cloud Run service, following the existing ops service pattern used by workers such as `uk-aq-prune-daily`.

This should be a Cloud Run service, not a Cloud Run Job, so it can use:

- an authenticated `/run` endpoint for Cloud Scheduler;
- a lightweight health endpoint;
- the existing GitHub Actions `gcloud run deploy` service pattern;
- Cloud Scheduler OIDC invocation;
- `concurrency=1`, `max-instances=1`, and a service-level timeout to avoid overlapping runs.

The service should still behave like a batch worker internally: one request performs one bounded calculation/publish run, records a `who_2021_processing_runs` row, and exits cleanly.

Pseudo workflow:

1. Determine latest complete UTC/GMT day.
2. Determine missing days in `who_2021_daily_status` for `source_network_code = 'gov_uk_aurn'` and pollutants `pm25`, `pm10`, and `no2`.
3. For each missing day from the first missing day to latest complete day:
   - read observations for that derived sample day and network/pollutant set using the hour-ending window `(day_utc 00:00, next_day_utc 00:00]`
   - aggregate to distinct UTC/GMT hourly means first
   - assign each hourly row to `sample_day_utc = (observed_at - interval '1 hour')::date`
   - calculate daily means from valid hourly means for that `sample_day_utc`
   - require at least 18 valid distinct hours
   - upsert into `who_2021_daily_status`
4. Recalculate rolling 365-day status for affected timeseries as of latest complete day.
5. Upsert `who_2021_rolling_year_status`.
6. Recalculate current year-to-date rows.
7. If a previous calendar year is not final, calculate/finalise complete-year rows.
8. Export newly created/updated derived rows to R2 v2 parquet.
9. Write dated public summary JSON to R2.
10. Replace `history/v2/who_2021/latest_who_2021.json` only after parquet/archive outputs and dated JSON complete.
11. Log run status, counts, date range, warnings and failures.

Phase 2 implements the daily-status part of this workflow only: steps 1, 3 and 11. Steps 4 through 10 remain Phase 3/4 work.

The process should be idempotent. Re-running the same date should update the same primary keys, not create duplicates.

## 9. Backfill process

Add a backfill mode for historical calculation.

Backfill parameters:

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
3. Recalculate complete calendar years and year-to-date rows.
4. Export derived parquet outputs to R2 v2.
5. Publish dated/latest JSON outputs when `--publish-json` is provided.

For the initial deployment, it is acceptable to backfill:

- daily rows from the earliest available AURN hourly observation history
- rolling-year rows from the first day where 365 days of possible history exists
- calendar-year rows from 2025 onwards, because current local backup has data from 2025-01-01

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
history/v2/who_2021/calendar_year_status/calendar_year=YYYY/period_type=<complete_year|year_to_date>/connector_id=N/pollutant_code=<pollutant>/part-xxxxx.parquet
```

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

Yes, this needs phases.

### Phase 1: Schema and reference values

Deliver:

- SQL migrations for the private Obs AQI DB WHO tables.
- Seed data for guideline values.
- RLS/grants consistent with private `uk_aq_ops` service-role patterns.
- Basic database comments explaining these are WHO health-based guideline comparisons, not UK legal-limit checks.

Implemented in this phase:

- Added the canonical Obs AQI DB schema definitions to `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`.
- Added the focused apply file `schemas/obs_aqi_db/uk_aq_who_2021_ops_schema.sql` for the same Phase 1 DDL.
- Added private `uk_aq_ops` reference/state tables:
  - `who_2021_guideline_values`
  - `who_2021_daily_status`
  - `who_2021_rolling_year_status`
  - `who_2021_calendar_year_status`
  - `who_2021_processing_runs`
- Seeded WHO 2021 PM2.5, PM10 and NO2 guideline values with the 4-day daily allowance.
- Added service-role-only RLS policies, service-role grants, comments and `updated_at` touch triggers.
- Included explicit hour-ending daily-window metadata fields so later processing can represent the `00:01` to `00:00` UTC/GMT day rule for GOV.UK AURN and Breathe London.

Processing, backfills, R2 parquet/JSON publication and website data wiring are intentionally not implemented in Phase 1.

### Phase 2: Daily daily-status calculation

Deliver:

- A scheduled ops Cloud Run service that calculates `who_2021_daily_status` for GOV.UK AURN PM2.5, PM10 and NO2.
- An authenticated `/run` endpoint plus a lightweight health endpoint.
- 18-hour valid-day rule.
- Idempotent upserts.
- Backfill support for daily rows.
- Tests or a local DuckDB/private Obs AQI DB comparison using known sample outputs.

Implemented in this phase:

- Added schema RPCs to the focused apply file and canonical Obs AQI DB schema:
  - `uk_aq_public.uk_aq_rpc_who_2021_daily_status_refresh`
  - `uk_aq_public.uk_aq_rpc_who_2021_processing_run_log`
- Kept `uk_aq_ops` private: the Cloud Run service writes through service-role RPCs rather than directly exposing or writing private tables through PostgREST.
- Added `workers/uk_aq_who_2021_daily_cloud_run/` with:
  - `run_service.ts` for health and authenticated scheduler/manual run requests;
  - `run_job.ts` for the bounded batch worker;
  - `who_2021_daily_core.ts` for date-window/chunk/payload logic;
  - `Dockerfile`, `README.md`, and focused local tests.
- Added `.github/workflows/uk_aq_who_2021_daily_cloud_run_deploy.yml`.
- Added master env-var catalog rows for the new service.
- Added script documentation in `system_docs/uk_aq_scripts.md`.
- Implemented `daily`, `backfill`, and `dry_run` modes.
- Implemented the hour-ending day rule inside the database RPC: daily rows use `observed_at > day_utc 00:00` and `observed_at <= next_day_utc 00:00`, and assign observations by `(observed_at - interval '1 hour')::date`.
- Implemented 18 valid distinct hour-ending values per day as the default validity rule.
- Left rolling-year, calendar-year, R2 parquet/JSON publication, and website data wiring for later phases.

### Phase 3: Rolling and calendar summary calculation

Deliver:

- Rolling 365-day summary calculation.
- Calendar-year and year-to-date summary calculation.
- 274 valid-day threshold for full-year/rolling periods.
- Proportional 75% threshold for year-to-date rows.
- In-memory/public-output builder that can create the 9 homepage card rows.

### Phase 4: R2 v2 export/archive

Deliver:

- Parquet export for daily, rolling and calendar derived outputs.
- R2 v2 paths with connector and pollutant partitions.
- Manifest/update logic if the repo already uses manifests for R2 v2.
- Re-run-safe overwrite or replace behaviour for each partition.
- Dated summary JSON and `latest_who_2021.json` publication.
- Daily cache/version key documented as `?as_of=YYYY-MM-DD`.

### Phase 5: Website data wiring

Deliver:

- Update homepage WHO card to read `history/v2/who_2021/latest_who_2021.json`.
- Keep static/fallback behaviour if the R2 JSON is unavailable.
- Add local/day-based cache refresh using `data_as_of_day_utc`.
- Add small loading/error behaviour that does not block the rest of the homepage dashboard.
- Keep current public wording and layout.

### Phase 6: WHO guideline page and league tables

Deliver later:

- WHO guideline page at `/who-guidelines/`.
- Rolling-year league tables from generated R2 JSON.
- Calendar-year and year-to-date selectors from generated R2 JSON.
- Later daily site/timeseries calendar JSON for month/year square views.
- Show `sensors_not_enough_data` on the main WHO page, not on the homepage card.
- Station detail links.
- Clear explanation of WHO guidelines vs UK legal limits.

## 13. Validation checks

Use local DuckDB outputs and private Obs AQI DB query outputs to compare:

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

These are not hard-coded production expectations forever. They are a useful regression check against the first implementation using the same backup data.

## 14. Important non-goals

Do not include UK legal-limit calculations in this WHO phase.

Do not call the result UK legal compliance.

Do not mix Breathe London into the headline AURN WHO summary.

Do not make the browser calculate percentages from raw daily/rolling rows for the homepage card.

Do not use “safe limits” wording.

## 15. Done criteria

The implementation is done when:

1. The private WHO calculation/state schema exists in Obs AQI DB.
2. WHO guideline values are seeded.
3. Daily status rows can be generated and upserted for `source_network_code = 'gov_uk_aurn'` and pollutants `pm25`, `pm10`, and `no2`.
4. Rolling-year rows can be generated and upserted.
5. Calendar-year and year-to-date rows can be generated and upserted.
6. R2 v2 parquet archives are written to the agreed paths.
7. Dated summary JSON is written for the latest processed day.
8. `history/v2/who_2021/latest_who_2021.json` returns 9 homepage card rows for the latest processed day.
9. Re-running the job for the same date is idempotent and does not churn unchanged parquet/JSON bytes unnecessarily.
10. The website can consume the public R2 JSON without changing the private calculation data model.
