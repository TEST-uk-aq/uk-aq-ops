Yes, that is broadly the right direction, but I’d make one important adjustment:

Do not only store a boolean. Store the daily mean value as well as the boolean.

A boolean is fine for fast counting, but the daily mean is useful for debugging, displaying league tables, recalculating if thresholds change, and checking edge cases.

Best structure

I’d add a derived table that stores one row per timeseries per UTC day per WHO guideline pollutant.

Something like:

who_2021_daily_status

Columns:

day_utc
connector_id
station_id
timeseries_id
pollutant_code
daily_mean
valid_hour_count
data_completeness_pct
who_daily_guideline
exceeded_who_daily_guideline
created_at
updated_at

Example row:

2026-07-01
GOV.UK AURN
Ealing Horn Lane
ts 95
PM10
daily_mean 51.2
valid_hour_count 24
who_daily_guideline 45
exceeded_who_daily_guideline true

Then the website can do this very cheaply:

SELECT
  station_id,
  timeseries_id,
  pollutant_code,
  COUNT(*) FILTER (WHERE exceeded_who_daily_guideline) AS exceedance_days
FROM who_2021_daily_status
WHERE day_utc > CURRENT_DATE - INTERVAL '365 days'
GROUP BY station_id, timeseries_id, pollutant_code;

That works well for:

Top 10 AURN sites by daily exceedance days
Station detail pages
Homepage summary cards
Rolling 365-day WHO daily status

What about the yearly guidelines?

For the yearly-mean guideline, I would not store only a daily boolean. I’d store a rolling-year summary table as a separate derived table.

Something like:

who_2021_rolling_year_status

Columns:

as_of_day_utc
window_start_day_utc
window_end_day_utc
connector_id
station_id
timeseries_id
pollutant_code
rolling_year_mean
valid_day_count
valid_hour_count
data_completeness_pct
who_yearly_guideline
exceeded_who_yearly_guideline
who_daily_guideline
daily_exceedance_days
daily_allowance_days
daily_exceedance_days_beyond_allowance
exceeded_who_daily_guideline_approach
created_at
updated_at

Example:

as_of_day_utc: 2026-07-01
window: 2025-07-02 to 2026-07-01
Ealing Horn Lane PM10
rolling_year_mean: 24.552
WHO yearly guideline: 15
exceeded yearly guideline: true
daily exceedance days: 44
daily allowance: 4
days beyond allowance: 40
exceeded daily approach: true

This gives the website one simple row to read for each site/pollutant.

Why have both tables?

Use the daily table as the source of truth for daily exceedance days.

Use the rolling-year table as the fast summary for the website.

hourly observations
    ↓
daily means + daily WHO exceedance boolean
    ↓
rolling 365-day WHO summary
    ↓
website dashboard / league tables

That is much better than making the website calculate from hourly observations every time.

Should this live in Supabase and R2?

Yes, but with different roles.

Supabase

Supabase should hold the current/queryable derived tables:

who_2021_daily_status
who_2021_rolling_year_status

The website reads these directly.

R2 history

R2 should archive the same derived outputs, probably partitioned by date:

history/v1/who_2021_daily_status/day_utc=YYYY-MM-DD/connector_id=1/part-00000.parquet
history/v1/who_2021_rolling_year_status/as_of_day_utc=YYYY-MM-DD/connector_id=1/part-00000.parquet

That means you can rebuild the dashboard tables later without recomputing from the raw hourly history.

Daily workflow

A daily job should do roughly this:

1. Find yesterday’s completed UTC day.
2. Calculate daily means for PM2.5, PM10 and NO2 AURN timeseries.
3. Upsert rows into who_2021_daily_status.
4. For each affected timeseries, recalculate the latest rolling 365-day summary.
5. Upsert rows into who_2021_rolling_year_status.
6. Export/archive those derived rows to R2.

I’d calculate for yesterday, not today, because today is incomplete.

You could also let it backfill missing days if R2/Supabase is behind:

Find latest day in who_2021_daily_status
Calculate from next missing day up to yesterday

Calendar years

For calendar-year views, add another summary table:

who_2021_calendar_year_status

Columns:

calendar_year
connector_id
station_id
timeseries_id
pollutant_code
year_start_day_utc
year_end_day_utc
calendar_year_mean
valid_day_count
valid_hour_count
data_completeness_pct
who_yearly_guideline
exceeded_who_yearly_guideline
who_daily_guideline
daily_exceedance_days
daily_allowance_days
daily_exceedance_days_beyond_allowance
exceeded_who_daily_guideline_approach
created_at
updated_at

This should be recalculated daily for the current year, and finalised for past years.

So:

Homepage:
read who_2021_rolling_year_status
League table:
read who_2021_rolling_year_status by default
optional year toggle reads who_2021_calendar_year_status
Station detail:
daily rows from who_2021_daily_status
summary rows from rolling/calendar tables

My recommendation

Build three derived tables:

who_2021_daily_status
who_2021_rolling_year_status
who_2021_calendar_year_status

For the first phase, only implement:

AURN only
PM2.5, PM10, NO2
daily UTC means
rolling 365-day summaries
calendar-year summaries

Then later add Breathe London as a separate labelled context layer.

The key thing: daily exceedances and yearly guideline status should be separate calculations, but they can be stored together in the rolling/calendar summary tables for fast website display.



Yes, using UTC days is fine for this project, and I’d recommend it.

Strictly, WHO defines the guideline as a 24-hour average concentration, but it does not force your website to use UK civil days or BST-adjusted local days for this kind of public dashboard. The WHO wording is about the averaging period and the 99th percentile, not whether the day boundary is midnight UTC or midnight local time. WHO describes the 24-hour values as the 99th percentile, equivalent to about 3 to 4 exceedance days per year.  

For UK AURN data, UTC is especially sensible because the source data is hourly and UK-wide. DEFRA describes AURN as high-resolution hourly monitoring data, and using UTC avoids introducing BST edge cases into your derived tables.  

I’d put a note on the site like:

Daily means use UTC days, 00:00 to 23:59 UTC. This avoids daylight-saving changes and keeps all monitoring sites on the same time basis.

I would say UTC days, not GMT days, even though GMT and UTC are effectively the same offset for this purpose. UTC is the cleaner technical term, and it avoids people thinking you mean UK local clock time in winter only.

For current year so far

Yes, you can show previous full calendar years and the current year so far, but be careful with the wording.

For daily exceedance days, the current-year total will usually only stay the same or go up, because you are counting days above the daily guideline.

So this works:

2026 so far: 19 daily exceedance days

For yearly mean, it can go up or down during the year, because it is the mean of the year-to-date data so far.

So I’d label it as:

2026 year to date mean

not:

2026 yearly mean

until the year is complete.

Best dashboard period labels

Use these three modes:

Rolling 365 days
Calendar year
Year to date

For completed years:

Calendar year 2025
01/01/2025 to 31/12/2025 UTC

For the current year:

2026 year to date
01/01/2026 to latest complete UTC day

For homepage:

Rolling 365 days
Latest complete 365 UTC days

What to store

For daily rows, UTC is ideal:

day_utc
daily_mean_utc
exceeded_who_daily_guideline

For rolling summaries:

as_of_day_utc
window_start_day_utc
window_end_day_utc
rolling_365_day_mean
daily_exceedance_days

For calendar/year-to-date summaries:

calendar_year
period_type: complete_year | year_to_date
period_start_day_utc
period_end_day_utc
period_mean
daily_exceedance_days

So yes: UTC days are fine, add a clear note, and avoid BST entirely.

Yes, for a public website I think GMT is fine, as long as the wording is clear.

I’d phrase it like this:

Daily averages are calculated using GMT days, from midnight to midnight. This keeps the data consistent all year and avoids daylight-saving changes.

Technically the data is probably UTC, but for a UK public audience, “GMT days” is more understandable. Academics will understand what you mean if the note says midnight to midnight and no daylight-saving adjustment.

Better wording than “exceedance”

Yes. “Exceedance” is technically correct, but it is not very friendly.

I would avoid “within limits” and “above limits” unless you are very clear these are WHO health guidelines, not legal limits. “Limits” can sound like UK law.

Better public wording:

Technical wording	Friendlier website wording
Exceedance	Day above guideline
Exceedance days	Days above WHO guideline
Exceeded annual guideline	Above WHO yearly guideline
Did not exceed annual guideline	Within WHO yearly guideline
Exceeded daily guideline	Above WHO daily guideline
Within daily guideline	Within WHO daily guideline

My preferred wording

For simple status chips:

Above WHO guideline
Within WHO guideline
Not enough data

For daily counts:

44 days above WHO daily guideline

For yearly mean:

Above WHO yearly guideline

For the 99th percentile explanation:

WHO benchmark: no more than about 4 days above the daily guideline each year.

Avoid these

I’d avoid:

Breached WHO limit
Illegal
Failed legal limit
Within safe limits

“Within safe limits” is especially risky because WHO does not really say there is a safe level of air pollution.

Good dashboard wording

Something like this would work well:

WHO 2021 guideline check
Health-based guidelines, not UK legal limits.
PM10 at Ealing Horn Lane
Above WHO yearly guideline
Yearly average: 24.6 µg/m³, WHO guideline: 15
44 days above WHO daily guideline
WHO benchmark: about 4 days per year

For a league table title:

AURN sites with the most days above WHO daily guidelines

Or slightly shorter:

Most days above WHO daily guideline

For the main homepage card:

WHO guideline status
Based on GOV.UK AURN monitoring sites
PM2.5: 7 of 10 sites above WHO yearly guideline
PM10: 3 of 8 sites above WHO yearly guideline
NO2: 9 of 12 sites above WHO yearly guideline

My recommendation: use “Above WHO guideline” and “Within WHO guideline” as the main labels, and use “days above WHO daily guideline” instead of “exceedance days”.