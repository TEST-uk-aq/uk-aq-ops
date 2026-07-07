# UK AQ WHO guideline derived data implementation plan

Date: 2026-07-07  
Scope: Supabase tables, public views, daily processing, R2 v2 derived parquet archive, and later website wiring for WHO guideline information.

This plan is for VS Code Codex. It is separate from the static homepage card implementation plan. The homepage card can initially use hard-coded figures. This plan creates the data layer that will later feed that card, the WHO guideline page, league tables and sensor detail pages.

## 1. Goal

Create a derived WHO guideline data layer for UK AQ that calculates and stores:

1. Daily mean status for each AURN pollutant timeseries.
2. Rolling 365-day WHO summary status for each AURN pollutant timeseries.
3. Calendar-year and year-to-date WHO summary status for each AURN pollutant timeseries.
4. Public summary views that the website can query cheaply.
5. R2 v2 parquet archives of the same derived outputs.

The first production phase is GOV.UK AURN only, for:

- PM2.5
- PM10
- NO2

Do not mix Breathe London or other networks into the headline WHO summaries in this phase.

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

The database should store UTC dates and UTC-derived day fields.

## 3. Guideline values

Store these in code/config, or preferably in a small reference table so the values are not duplicated in multiple jobs.

| pollutant_code | who_daily_guideline_ugm3 | who_yearly_guideline_ugm3 | daily_allowance_days |
|---|---:|---:|---:|
| PM2.5 | 15 | 5 | 4 |
| PM10 | 45 | 15 | 4 |
| NO2 | 25 | 10 | 4 |

Notes:

- WHO daily values are interpreted as the 99th percentile benchmark, implemented here as no more than 4 days above the daily guideline in a year/rolling year.
- UK AQ will store 4 as an absolute daily allowance for the public dashboard calculation.
- WHO does not appear to define a single operational hourly completeness rule for this website use case. UK AQ will define its own transparent completeness rule.

## 4. Completeness rules

Use these production defaults:

- Valid daily mean: at least 18 valid hourly readings for that UTC/GMT day.
- Valid rolling 365-day period: at least 274 valid daily means.
- Valid complete calendar year: at least 274 valid daily means.
- Valid year-to-date period: use a proportional 75% threshold based on elapsed days, with a minimum of 1 valid day.

Suggested year-to-date threshold:

```sql
GREATEST(1, CEIL(period_day_count * 0.75))
```

Store the thresholds used on each derived row so future changes are auditable.

## 5. Internal naming decision

Use `who_2021_*` internally, even though public UI says only “WHO”. This protects against future WHO guideline revisions.

Create these core tables in `uk_aq_core`:

- `uk_aq_core.who_2021_guideline_values`
- `uk_aq_core.who_2021_daily_status`
- `uk_aq_core.who_2021_rolling_year_status`
- `uk_aq_core.who_2021_calendar_year_status`
- optional run log table: `uk_aq_core.who_2021_processing_runs`

Create public views in `uk_aq_public`:

- `uk_aq_public.who_2021_homepage_summary`
- `uk_aq_public.who_2021_rolling_year_status`
- `uk_aq_public.who_2021_calendar_year_status`
- `uk_aq_public.who_2021_daily_status`

The public UI should not display “2021” unless it is in an explanatory source note.

## 6. Table design

### 6.1 `uk_aq_core.who_2021_guideline_values`

Purpose: store WHO guideline values and threshold rules in one place.

Suggested columns:

```sql
pollutant_code text primary key,
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
('PM2.5', 15, 5, 4, 'µg/m³', 'WHO 2021')
('PM10', 45, 15, 4, 'µg/m³', 'WHO 2021')
('NO2', 25, 10, 4, 'µg/m³', 'WHO 2021')
```

### 6.2 `uk_aq_core.who_2021_daily_status`

Purpose: one row per pollutant timeseries per UTC day.

Suggested columns:

```sql
day_utc date not null,
connector_id bigint not null,
station_id bigint not null,
timeseries_id bigint not null,
pollutant_code text not null,
daily_mean numeric not null,
valid_hour_count integer not null,
min_valid_hours_per_day integer not null default 18,
data_completeness_pct numeric,
who_daily_guideline numeric not null,
above_who_daily_guideline boolean not null,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
primary key (day_utc, connector_id, timeseries_id)
```

Indexes:

```sql
create index on uk_aq_core.who_2021_daily_status (connector_id, pollutant_code, day_utc);
create index on uk_aq_core.who_2021_daily_status (connector_id, station_id, pollutant_code, day_utc);
create index on uk_aq_core.who_2021_daily_status (connector_id, timeseries_id, day_utc);
```

Notes:

- Store `daily_mean`, not only the boolean. This supports debugging, league tables, future reprocessing and station detail pages.
- Use `above_who_daily_guideline` rather than `exceeded_*` in newly written code where possible. If existing naming conventions prefer `exceeded_*`, add a public alias with friendlier naming later.

### 6.3 `uk_aq_core.who_2021_rolling_year_status`

Purpose: one row per pollutant timeseries per as-of day. This is the fast source for the homepage rolling-year card and rolling-year league tables.

Suggested columns:

```sql
as_of_day_utc date not null,
window_start_day_utc date not null,
window_end_day_utc date not null,
connector_id bigint not null,
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
create index on uk_aq_core.who_2021_rolling_year_status (connector_id, pollutant_code, as_of_day_utc);
create index on uk_aq_core.who_2021_rolling_year_status (connector_id, station_id, pollutant_code, as_of_day_utc);
create index on uk_aq_core.who_2021_rolling_year_status (connector_id, pollutant_code, above_who_yearly_guideline, as_of_day_utc);
create index on uk_aq_core.who_2021_rolling_year_status (connector_id, pollutant_code, above_who_daily_guideline_approach, as_of_day_utc);
```

Rules:

- `above_who_yearly_guideline` is true when `rolling_year_mean > who_yearly_guideline` and `has_enough_data` is true.
- `above_who_daily_guideline_approach` is true when `daily_above_guideline_days > daily_allowance_days` and `has_enough_data` is true.
- If `has_enough_data` is false, the above flags should be false or null consistently. Recommended: store them as null and let public views classify as `Not enough data`.

### 6.4 `uk_aq_core.who_2021_calendar_year_status`

Purpose: complete calendar years and current year-to-date summaries.

Suggested columns:

```sql
calendar_year integer not null,
period_type text not null check (period_type in ('complete_year', 'year_to_date')),
period_start_day_utc date not null,
period_end_day_utc date not null,
connector_id bigint not null,
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
create index on uk_aq_core.who_2021_calendar_year_status (calendar_year, period_type, connector_id, pollutant_code);
create index on uk_aq_core.who_2021_calendar_year_status (connector_id, station_id, pollutant_code, calendar_year);
```

Rules:

- `complete_year` rows use 01 January to 31 December and are final once the year is complete and data has been backfilled.
- `year_to_date` rows use 01 January to the latest complete UTC/GMT day.
- Current-year `period_mean` must be labelled publicly as “year to date mean”, not “yearly mean”.

## 7. Public views

### 7.1 Homepage summary view

Create `uk_aq_public.who_2021_homepage_summary`.

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

Suggested output columns:

```sql
card_key text,
card_group text,
card_section text,
range_start_day_utc date,
range_end_day_utc date,
range_label text,
connector_id bigint,
source_label text,
pollutant_code text,
who_daily_guideline numeric,
who_yearly_guideline numeric,
sensors_available integer,
sensors_with_enough_data integer,
sensors_not_enough_data integer,
sensors_above_guideline integer,
sensors_within_guideline integer,
percent_above_guideline numeric,
card_count_label text,
latest_processed_day_utc date,
updated_at timestamptz
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

### 7.2 Status detail public views

Expose public views for the WHO guideline page and future league tables:

- `uk_aq_public.who_2021_rolling_year_status`
- `uk_aq_public.who_2021_calendar_year_status`
- `uk_aq_public.who_2021_daily_status`

These views should join station metadata so the website gets station names and public IDs without querying core station tables separately.

Include, where available:

```sql
station_id,
timeseries_id,
station_name,
station_ref,
local_authority_code,
parliamentary_constituency_code,
pollutant_code,
period/range fields,
mean values,
guideline values,
status flags,
valid counts,
not enough data flags
```

## 8. Daily process

Implement a daily WHO derived-data process. It can be in the ingest or ops repo, whichever currently owns daily derived data jobs.

Pseudo workflow:

1. Determine latest complete UTC/GMT day.
2. Determine missing days in `who_2021_daily_status` for GOV.UK AURN PM2.5, PM10 and NO2.
3. For each missing day from the first missing day to latest complete day:
   - read hourly observations for that day and connector/pollutant set
   - calculate daily means
   - require at least 18 valid hourly readings
   - upsert into `who_2021_daily_status`
4. Recalculate rolling 365-day status for affected timeseries as of latest complete day.
5. Upsert `who_2021_rolling_year_status`.
6. Recalculate current year-to-date rows.
7. If a previous calendar year is not final, calculate/finalise complete-year rows.
8. Export newly created/updated derived rows to R2 v2 parquet.
9. Log run status, counts, date range, warnings and failures.

The process should be idempotent. Re-running the same date should update the same primary keys, not create duplicates.

## 9. Backfill process

Add a backfill mode for historical calculation.

Backfill parameters:

```text
--start-day YYYY-MM-DD
--end-day YYYY-MM-DD
--connector-id 1
--pollutants PM2.5,PM10,NO2
--rebuild-daily
--rebuild-rolling
--rebuild-calendar
--dry-run
```

Backfill should:

1. Calculate daily rows for the requested range.
2. Recalculate rolling rows for every as-of day in the range, or at least for requested checkpoint days depending on performance.
3. Recalculate complete calendar years and year-to-date rows.
4. Export derived parquet outputs to R2 v2.

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

Recommended parquet columns should match the Supabase tables closely. Keep column names stable so DuckDB can query the R2 archive later.

## 11. Website wiring phase

Do not wire the homepage WHO card to Supabase until the data tables and public views are deployed and populated.

When ready, update the homepage card to read from:

```text
uk_aq_public.who_2021_homepage_summary
```

Expected frontend behaviour:

- If the summary view loads, render live rows.
- If it fails, keep the card visible with either static fallback values or an unobtrusive unavailable state.
- Do not block the existing Highest sensor readings card if WHO summary loading fails.
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

- SQL migrations for the four core WHO tables.
- Seed data for guideline values.
- Public read views, initially even if empty.
- RLS/grants consistent with existing `uk_aq_public` patterns.
- Basic database comments explaining these are WHO health-based guideline comparisons, not UK legal-limit checks.

Do not implement processing yet.

### Phase 2: Daily daily-status calculation

Deliver:

- A job/script that calculates `who_2021_daily_status` for GOV.UK AURN PM2.5, PM10 and NO2.
- 18-hour valid-day rule.
- Idempotent upserts.
- Backfill support for daily rows.
- Tests or a local DuckDB/Supabase comparison using known sample outputs.

### Phase 3: Rolling and calendar summary calculation

Deliver:

- Rolling 365-day summary calculation.
- Calendar-year and year-to-date summary calculation.
- 274 valid-day threshold for full-year/rolling periods.
- Proportional 75% threshold for year-to-date rows.
- Public homepage summary view returning the 9 card rows.

### Phase 4: R2 v2 export/archive

Deliver:

- Parquet export for daily, rolling and calendar derived outputs.
- R2 v2 paths with connector and pollutant partitions.
- Manifest/update logic if the repo already uses manifests for R2 v2.
- Re-run-safe overwrite or replace behaviour for each partition.

### Phase 5: Website data wiring

Deliver:

- Update homepage WHO card to read `uk_aq_public.who_2021_homepage_summary`.
- Keep static/fallback behaviour if the view is unavailable.
- Add small loading/error behaviour that does not block the rest of the homepage dashboard.
- Keep current public wording and layout.

### Phase 6: WHO guideline page and league tables

Deliver later:

- WHO guideline page at `/who-guidelines/`.
- Rolling-year league tables.
- Calendar-year and year-to-date selectors.
- Show `sensors_not_enough_data` on the main WHO page, not on the homepage card.
- Station detail links.
- Clear explanation of WHO guidelines vs UK legal limits.

## 13. Validation checks

Use local DuckDB outputs and Supabase query outputs to compare:

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

1. The schema exists in Supabase.
2. WHO guideline values are seeded.
3. Daily status rows can be generated and upserted for AURN PM2.5, PM10 and NO2.
4. Rolling-year rows can be generated and upserted.
5. Calendar-year and year-to-date rows can be generated and upserted.
6. Public views return the expected columns.
7. Homepage summary view returns 9 rows for the latest processed day.
8. R2 v2 parquet archives are written to the agreed paths.
9. Re-running the job for the same date is idempotent.
10. The website can later consume the public summary view without changing the data model.
