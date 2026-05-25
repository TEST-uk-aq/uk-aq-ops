# UK-AIR SOS TEST 404 Cooldown and Retirement Plan

## Purpose

This plan documents the current UK-AIR SOS Cloud Run behaviour, the repeated HTTP 404 problem, and recommended ways to recover and then fix the scheduler/selection logic.

It is based on the uploaded current files:

- `uk_aq_uk_air_sos_cloud_run/run_job.ts`
- `ingest_db/uk_aq_uk_air_sos_select_station_refs.sql`
- `ingest_db/uk_aq_core_schema.sql`
- `ingest_db/uk_aq_raw_schema.sql`
- `ingest_db/uk_aq_rpc.sql`

## Current findings from the uploaded code/schema

### 1. `next_due_at` is station-level and is used for station selection

The current station selector is the SQL RPC:

```sql
uk_aq_core.uk_air_sos_select_station_refs(batch_limit integer, stale_limit integer)
```

It reads from:

```sql
uk_aq_raw.uk_air_sos_station_checkpoints.next_due_at
uk_aq_raw.uk_air_sos_station_checkpoints.last_polled_at
uk_aq_raw.uk_air_sos_station_checkpoints.last_observed_at
```

The selector builds:

```sql
coalesce(sc.next_due_at, now()) as due_at
```

Then it selects stations in tiers:

```sql
-- Tier 1
where due_at <= now()
  and due_at >= now() - interval '6 hours'
  and (last_polled_at is null or last_polled_at <= now() - interval '5 minutes')

-- Tier 2
where due_at < now() - interval '6 hours'
  and due_at >= now() - interval '24 hours'
  and (last_polled_at is null or last_polled_at <= now() - interval '1 hour')

-- Stale fallback
where (last_observed_at is null or last_observed_at <= now() - interval '24 hours')
  and (last_polled_at is null or last_polled_at <= now() - interval '12 hours')
```

It also excludes removed stations:

```sql
stn.removed_at is null
```

So yes: setting `uk_aq_raw.uk_air_sos_station_checkpoints.next_due_at` into the future suppresses that **station** from the normal SOS station selector until due again.

### 2. SOS timeseries selection is separate and currently has no 404 cooldown

After station refs are selected, `run_job.ts` loads station rows, then loads timeseries rows using `loadTimeseriesRows()`.

The current timeseries query is effectively:

```ts
select: "id,station_id,last_value_at",
connector_id: eq connector,
station_id: in selected station_ids,
ended_at: is.null,
order: "last_value_at.asc.nullsfirst,id.asc",
limit: timeseriesLimit
```

This means:

- `next_due_at` does not exist at timeseries level in the current path.
- SOS 404s are not filtered from timeseries selection.
- If a bad timeseries has an old/null `last_value_at`, it can be selected repeatedly.
- `timeseries.ended_at` is already available and is used to exclude inactive series.

### 3. Station checkpoints are updated from max station `timeseries.last_value_at`, not true per-pollutant observation freshness

`run_job.ts` has `loadStationLatestObserved()` which reads:

```ts
select: "station_id,last_value_at",
connector_id: eq connector,
station_id: in selected station_ids,
ended_at: is.null,
last_value_at: not.is.null
```

It then keeps the maximum `last_value_at` for each station.

This is station-level and pollutant-agnostic. For UK-AIR SOS, that is too broad because a station can have many pollutant streams. Fresh NO, NOx, SO2, or VOC data can make a station look fresh while PM2.5, PM10, or NO2 remains stale.

### 4. Station `removed_at` and timeseries `ended_at` already exist and fit retirement workflows

Relevant schema fields:

```sql
uk_aq_core.stations.removed_at timestamptz
uk_aq_core.timeseries.ended_at timestamptz
```

The current SOS station selector already excludes:

```sql
stn.removed_at is null
```

The current timeseries loader already excludes:

```ts
ended_at: "is.null"
```

Therefore:

- `timeseries.ended_at` is the cleanest way to permanently stop polling a specific bad SOS timeseries.
- `stations.removed_at` is the cleanest existing way to stop polling an entire station.
- Both are reversible manually by setting them back to `null`, if that is acceptable operationally.

### 5. `error_logs` supports the proposed no-new-table cooldown approach

The raw schema has:

```sql
uk_aq_raw.error_logs (
  id uuid,
  created_at timestamptz,
  source text,
  severity text,
  message text,
  stack text,
  context jsonb,
  connector_id integer,
  station_id bigint,
  timeseries_id integer,
  dropbox_path text
)
```

There are indexes on:

```sql
created_at
source
connector_id
```

There is not currently an index specifically on `(connector_id, timeseries_id, created_at)`.

If the shared SOS ingest function logs per-timeseries 404 failures with `connector_id`, `timeseries_id`, and a stack/message/context containing `HTTP 404`, then `error_logs` can be used to build a recent-404 suppression list without adding new state tables.

The Cloud Run wrapper itself only inserts wrapper-level errors with `timeseries_id: null`, but your exported error JSONs show per-timeseries failures, so the inner ingest path probably already creates per-timeseries error rows or equivalent Dropbox error files. Claude Code should confirm this in the full repo.

## Current issue in detail

The TEST SOS system has been getting repeated per-timeseries HTTP 404 errors. The problem is likely not a general gateway outage now; it is likely a set of SOS timeseries refs that are invalid, retired, not exposed by the gateway, or incompatible with the current endpoint/window.

The current scheduler can repeatedly select those bad timeseries because:

1. Station selection is station-level.
2. Timeseries selection orders stale/null `last_value_at` first.
3. There is no timeseries-level cooldown for repeated 404s.
4. Station checkpoints can be refreshed by any pollutant at the station.
5. A single station can contain a mix of valid and invalid pollutant streams.

This makes station-level suppression too blunt. Setting station `next_due_at` 24 hours forward after one timeseries 404 would stop repeated errors, but it could also block valid PM2.5, PM10, NO2, NO, SO2, or VOC timeseries at the same station.

The better fix is to treat 404s at the timeseries level first.

## Recovery options

### Option A: Error-log based recent 404 cooldown at timeseries selection level

Use `uk_aq_raw.error_logs` to find recent 404s per timeseries and exclude those timeseries from the SOS timeseries selection query for a cooldown window.

Example logic:

```sql
with recent_404 as (
  select
    el.timeseries_id,
    max(el.created_at) as last_404_at
  from uk_aq_raw.error_logs el
  where el.connector_id = v_connector_id
    and el.timeseries_id is not null
    and el.created_at >= now() - interval '6 hours'
    and (
      el.stack ilike '%HTTP 404%'
      or el.message ilike '%HTTP 404%'
      or el.context::text ilike '%HTTP 404%'
    )
  group by el.timeseries_id
)
select ts.id
from uk_aq_core.timeseries ts
left join recent_404 r404
  on r404.timeseries_id = ts.id
where ts.connector_id = v_connector_id
  and ts.station_id = any(v_station_ids)
  and ts.ended_at is null
  and r404.timeseries_id is null
order by ts.last_value_at asc nulls first, ts.id
limit v_limit;
```

Recommended cooldown: start with **6 hours** in TEST. If 404 volume remains high, increase to **24 hours**.

Pros:

- No new state table.
- Avoids fake poll timestamps.
- Does not suppress a whole station because one timeseries 404s.
- Separates structural 404s from transient 502/503/504 gateway failures.
- Easy to roll back by removing the filter.

Cons:

- Relies on `error_logs` content being complete and structured enough.
- Text search on `stack/message/context` is not ideal.
- Existing indexes may not be optimal if `error_logs` grows large.
- Suppressed 404 series will be retried after cooldown, so permanent dead series still need retirement logic.

Recommendation:

**Do this first.** It is the safest immediate fix and fits the current schema.

### Option B: New SQL RPC for SOS timeseries selection

Create a new RPC, for example:

```sql
uk_aq_core.uk_air_sos_select_timeseries_ids(
  station_ids bigint[],
  batch_limit integer,
  recent_404_cooldown interval default interval '6 hours'
)
returns integer[]
```

Move the current `loadTimeseriesRows()` selection into SQL and include the recent 404 filter there.

Pros:

- Keeps scheduler logic close to the station selector.
- Easier to test/debug in SQL.
- Better than doing multi-query filtering in TypeScript.
- Can return useful diagnostics later, e.g. selected count, skipped recent 404 count.

Cons:

- Requires a schema migration/RPC deployment.
- More work than a quick TypeScript-side filter.

Recommendation:

**Best implementation shape for the first fix.** The current station selection is already an RPC, so a timeseries selection RPC is consistent.

### Option C: Add a real SOS timeseries checkpoint table

Add a table like:

```sql
uk_aq_raw.uk_air_sos_timeseries_checkpoints (
  timeseries_id integer primary key references uk_aq_core.timeseries(id) on delete cascade,
  next_due_at timestamptz,
  last_polled_at timestamptz,
  last_observed_at timestamptz,
  last_error_at timestamptz,
  last_error_status integer,
  consecutive_404_count integer not null default 0,
  updated_at timestamptz not null default now()
)
```

Pros:

- Correct model for a multi-pollutant SOS source.
- Supports real per-timeseries scheduling.
- Makes permanent retirement decisions cleaner.
- Avoids expensive/textual error log searches.

Cons:

- New table and migration.
- More code changes.
- Need backfill/initialization logic.
- More moving parts to maintain.

Recommendation:

**Good long-term design**, but not necessary for the first recovery fix.

### Option D: Set station `next_due_at` 24 hours ahead when any selected timeseries 404s

On a timeseries 404, update `uk_air_sos_station_checkpoints.next_due_at` for the station.

Pros:

- Uses existing table.
- Simple to reason about at station level.
- Quickly reduces repeated errors.

Cons:

- Too blunt for SOS.
- Can suppress valid timeseries at the same station.
- Can worsen pollutant-specific freshness gaps.
- Does not distinguish one bad VOC stream from a dead station.

Recommendation:

**Do not use this as the default per-404 behaviour.** Use station suppression only as a second-stage rule when most/all active timeseries for a station are repeatedly 404ing.

### Option E: End-date bad timeseries using `timeseries.ended_at`

After repeated 404s, mark individual timeseries as ended:

```sql
update uk_aq_core.timeseries
set ended_at = now(), updated_at = now()
where id = :timeseries_id
  and connector_id = :uk_air_sos_connector_id
  and ended_at is null;
```

Pros:

- Current code already excludes `ended_at is not null` timeseries.
- Precise: removes only the bad series.
- Reversible manually by setting `ended_at = null`.
- Cleaner than repeatedly cooling down known-dead series.

Cons:

- Requires confidence that the series is truly dead.
- A temporary UK-AIR metadata/gateway issue could cause premature ending if thresholds are too aggressive.
- Needs audit logging.

Recommendation:

**Use this for repeated 404s over several days**, not for the first or second 404.

### Option F: End-date stations using `stations.removed_at`

After repeated 404s across most/all active timeseries for a station, mark the station removed:

```sql
update uk_aq_core.stations
set removed_at = now()
where id = :station_id
  and connector_id = :uk_air_sos_connector_id
  and removed_at is null;
```

Pros:

- Current station selector already excludes removed stations.
- Good fit when the entire station/site is gone from SOS.
- Reversible manually by setting `removed_at = null`.

Cons:

- Too blunt for partial pollutant failures.
- Could remove a station that still has valid streams.
- Needs a strict threshold and review query.

Recommendation:

**Use only for station-level death evidence**, for example:

- station has no successful observations in 7-14 days; and
- most/all active timeseries have repeated 404s; and
- the station is absent from the current SOS register/catalog, if available.

## Recommended phased plan

### Phase 0: Confirm error log structure

Before code changes, confirm that recent 404 rows are available in `uk_aq_raw.error_logs` with populated `timeseries_id`.

```sql
select
  el.timeseries_id,
  count(*) as error_count,
  max(el.created_at) as latest_404_at,
  min(el.created_at) as first_404_at,
  max(el.message) as sample_message
from uk_aq_raw.error_logs el
join uk_aq_core.connectors c
  on c.id = el.connector_id
where c.connector_code = 'uk_air_sos'
  and el.timeseries_id is not null
  and el.created_at >= now() - interval '24 hours'
  and (
    el.stack ilike '%HTTP 404%'
    or el.message ilike '%HTTP 404%'
    or el.context::text ilike '%HTTP 404%'
  )
group by el.timeseries_id
order by error_count desc, latest_404_at desc
limit 100;
```

If this returns nothing, inspect where the per-timeseries 404 JSON files are written and ensure the DB error log insert includes `timeseries_id` and status details.

### Phase 1: Add recent 404 cooldown to timeseries selection

Preferred implementation:

1. Add a new SQL RPC `uk_aq_core.uk_air_sos_select_timeseries_ids`.
2. It should accept selected `station_ids`, `batch_limit`, and `recent_404_cooldown_hours`.
3. It should exclude:
   - `ts.ended_at is not null`
   - any `timeseries_id` with a recent 404 in `error_logs` inside the cooldown window.
4. Update `run_job.ts` to call the RPC instead of querying `timeseries` directly.
5. Add dispatch logs:
   - station refs selected
   - station rows selected
   - timeseries selected
   - recent 404 skipped count if returned by RPC or logged separately.

Use a configurable env var:

```text
UK_AIR_SOS_404_COOLDOWN_HOURS=6
```

Start with 6 hours in TEST.

### Phase 2: Improve diagnostics

Add structured Cloud Run summary fields:

```json
{
  "message": "dispatching",
  "connector_code": "uk_air_sos",
  "stations_selected": 25,
  "timeseries_selected": 100,
  "timeseries_skipped_recent_404": 37,
  "window_hours": 12,
  "recent_404_cooldown_hours": 6
}
```

If practical, add summary fields from the inner ingest response:

```json
{
  "observations_by_pollutant": {
    "pm25": 0,
    "pm10": 0,
    "no2": 0,
    "no": 242
  },
  "errors_by_status": {
    "404": 37,
    "503": 0
  }
}
```

### Phase 3: Add repeated-404 retirement analysis queries

Do not auto-end anything immediately. First produce review lists.

Timeseries candidates for `ended_at`:

```sql
with sos_connector as (
  select id from uk_aq_core.connectors where connector_code = 'uk_air_sos' limit 1
),
series_404 as (
  select
    el.timeseries_id,
    count(*) as count_404,
    min(el.created_at) as first_404_at,
    max(el.created_at) as latest_404_at
  from uk_aq_raw.error_logs el
  where el.connector_id = (select id from sos_connector)
    and el.timeseries_id is not null
    and el.created_at >= now() - interval '7 days'
    and (
      el.stack ilike '%HTTP 404%'
      or el.message ilike '%HTTP 404%'
      or el.context::text ilike '%HTTP 404%'
    )
  group by el.timeseries_id
),
latest_success as (
  select
    o.timeseries_id,
    max(o.observed_at) as latest_observed_at
  from uk_aq_core.observations o
  join uk_aq_core.timeseries ts
    on ts.id = o.timeseries_id
  where ts.connector_id = (select id from sos_connector)
    and o.value is not null
  group by o.timeseries_id
)
select
  ts.id as timeseries_id,
  ts.station_id,
  stn.station_ref,
  p.notation,
  p.pollutant_label,
  ts.label,
  ts.last_value_at,
  ls.latest_observed_at,
  s404.count_404,
  s404.first_404_at,
  s404.latest_404_at
from series_404 s404
join uk_aq_core.timeseries ts
  on ts.id = s404.timeseries_id
left join uk_aq_core.stations stn
  on stn.id = ts.station_id
left join uk_aq_core.phenomena p
  on p.id = ts.phenomenon_id
left join latest_success ls
  on ls.timeseries_id = ts.id
where ts.ended_at is null
  and s404.count_404 >= 3
  and coalesce(ls.latest_observed_at, '-infinity'::timestamptz) < now() - interval '7 days'
order by s404.count_404 desc, s404.latest_404_at desc;
```

Station candidates for `removed_at`:

```sql
with sos_connector as (
  select id from uk_aq_core.connectors where connector_code = 'uk_air_sos' limit 1
),
active_series as (
  select id, station_id
  from uk_aq_core.timeseries
  where connector_id = (select id from sos_connector)
    and station_id is not null
    and ended_at is null
),
series_404 as (
  select
    el.timeseries_id,
    count(*) as count_404,
    max(el.created_at) as latest_404_at
  from uk_aq_raw.error_logs el
  where el.connector_id = (select id from sos_connector)
    and el.timeseries_id is not null
    and el.created_at >= now() - interval '7 days'
    and (
      el.stack ilike '%HTTP 404%'
      or el.message ilike '%HTTP 404%'
      or el.context::text ilike '%HTTP 404%'
    )
  group by el.timeseries_id
),
latest_success as (
  select
    ts.station_id,
    max(o.observed_at) as latest_observed_at
  from uk_aq_core.timeseries ts
  join uk_aq_core.observations o
    on o.timeseries_id = ts.id
  where ts.connector_id = (select id from sos_connector)
    and o.value is not null
  group by ts.station_id
)
select
  stn.id as station_id,
  stn.station_ref,
  count(a.id) as active_series_count,
  count(s404.timeseries_id) filter (where s404.count_404 >= 3) as repeated_404_series_count,
  max(s404.latest_404_at) as latest_404_at,
  ls.latest_observed_at
from uk_aq_core.stations stn
join active_series a
  on a.station_id = stn.id
left join series_404 s404
  on s404.timeseries_id = a.id
left join latest_success ls
  on ls.station_id = stn.id
where stn.connector_id = (select id from sos_connector)
  and stn.removed_at is null
group by stn.id, stn.station_ref, ls.latest_observed_at
having count(a.id) > 0
   and count(s404.timeseries_id) filter (where s404.count_404 >= 3) >= greatest(1, ceil(count(a.id) * 0.8))
   and coalesce(ls.latest_observed_at, '-infinity'::timestamptz) < now() - interval '7 days'
order by repeated_404_series_count desc, latest_404_at desc;
```

### Phase 4: Manual or semi-automated retirement

For confirmed dead timeseries:

```sql
update uk_aq_core.timeseries
set
  ended_at = now(),
  updated_at = now()
where connector_id = (select id from uk_aq_core.connectors where connector_code = 'uk_air_sos' limit 1)
  and id = any(:timeseries_ids)
  and ended_at is null;
```

For confirmed dead stations:

```sql
update uk_aq_core.stations
set removed_at = now()
where connector_id = (select id from uk_aq_core.connectors where connector_code = 'uk_air_sos' limit 1)
  and id = any(:station_ids)
  and removed_at is null;
```

Keep this as a reviewed operation at first. Do not auto-remove stations until the review queries have been validated.

## Recommended first implementation

1. Keep `poll_window_hours = 12` and moderate `poll_timeseries_batch_size` during TEST recovery.
2. Add a recent-404 cooldown at **timeseries selection** level, not station level.
3. Implement it via a new SQL RPC, unless Claude Code finds a strong reason to keep it in TypeScript.
4. Use `error_logs` as the source of 404 evidence.
5. Add `UK_AIR_SOS_404_COOLDOWN_HOURS`, default 6.
6. Add better dispatch logging.
7. Add review SQL for eventual `timeseries.ended_at` and `stations.removed_at` use.
8. Only use `stations.removed_at` when a whole station is repeatedly failing and has no recent successful observations.

## Rollback plan

If the cooldown causes unexpected under-selection:

1. Set `UK_AIR_SOS_404_COOLDOWN_HOURS=0` or deploy a rollback that bypasses the filter.
2. Revert `run_job.ts` to use direct `timeseries` loading.
3. Drop the new RPC only after no deployed code uses it.
4. To reactivate manually ended series/stations:

```sql
update uk_aq_core.timeseries
set ended_at = null, updated_at = now()
where id = any(:timeseries_ids);

update uk_aq_core.stations
set removed_at = null
where id = any(:station_ids);
```

## Claude Code prompt

```text
Repo: /workspaces/uk-aq-ingest

We need a careful analysis and implementation proposal for repeated UK-AIR SOS HTTP 404 errors in the Cloud Run SOS ingest path.

Uploaded/current context:
- SOS Cloud Run wrapper: workers/uk_aq_uk_air_sos_cloud_run/run_job.ts
- DB schema/migrations include:
  - uk_aq_core.stations.removed_at
  - uk_aq_core.timeseries.ended_at
  - uk_aq_raw.uk_air_sos_station_checkpoints
  - uk_aq_raw.error_logs
  - uk_aq_core.uk_air_sos_select_station_refs(batch_limit, stale_limit)

Observed behaviour:
- TEST has repeated per-timeseries SOS HTTP 404 errors.
- Live recovered, TEST did not recover headline pollutant freshness quickly.
- Recent TEST observations were often for NO, NOx as NO2, SO2, and VOC-style pollutants, while PM2.5/PM10/NO2 observed_at stayed stale.
- Station-level latest freshness can be misleading because UK-AIR SOS stations have many pollutant streams.
- The current station selector uses uk_air_sos_station_checkpoints.next_due_at.
- The current timeseries selector in run_job.ts uses uk_aq_core.timeseries rows for selected stations, filters ended_at is null, orders by last_value_at asc nulls first, and has no 404 cooldown.

Please analyse the repo and confirm or correct the above.

Tasks:

1. Inspect the full SOS Cloud Run wrapper and inner SOS ingest function.
2. Confirm exactly where per-timeseries HTTP 404 errors are caught/logged.
3. Confirm whether DB `uk_aq_raw.error_logs` rows are inserted for individual 404s with:
   - connector_id
   - station_id if available
   - timeseries_id
   - status/message/stack/context containing HTTP 404
   - created_at
4. Confirm whether Dropbox error JSONs are written from the same error path, and whether DB error rows are also written.
5. Confirm that `uk_air_sos_station_checkpoints.next_due_at` is only station-level scheduling.
6. Confirm that `timeseries.ended_at` is already enough to stop a series being selected.
7. Confirm that `stations.removed_at` is already enough to stop a station being selected.
8. Analyse whether station-level checkpoint freshness is currently based on max `timeseries.last_value_at` across all pollutants, and whether this can cause PM2.5/PM10/NO2 recovery to be hidden by fresh NO/NOx/SO2/VOC observations.

We are considering these fix options:

A. Add error-log based recent 404 cooldown at timeseries selection level inside run_job.ts.
B. Add a SQL RPC such as uk_aq_core.uk_air_sos_select_timeseries_ids(station_ids, batch_limit, recent_404_cooldown_hours) and call it from run_job.ts.
C. Add a real uk_air_sos_timeseries_checkpoints table with next_due_at/error counters.
D. On a 404, set station checkpoint next_due_at 24 hours ahead.
E. After repeated 404s, set timeseries.ended_at.
F. After repeated station-wide 404s and no successful observations, set stations.removed_at.

For each option, provide:
- pros
- cons
- failure modes
- implementation difficulty
- rollback approach
- whether it should be used immediately, later, or avoided

Preferred direction to validate:
- Do NOT set station next_due_at for a single timeseries 404.
- Do add a timeseries-level recent 404 cooldown using error_logs.
- Treat 404 differently from 502/503/504 gateway failures.
- Use timeseries.ended_at for repeated/dead timeseries after review.
- Use stations.removed_at only when most/all active series at a station are repeatedly 404ing and the station has no recent successful observations.
- Avoid fake poll timestamps.
- Avoid adding new tables for the first fix if error_logs is sufficient.

Please produce:
1. Written analysis of current code behaviour.
2. Recommended option with justification.
3. Any SQL migration/RPC code needed.
4. Any TypeScript code changes needed.
5. Verification queries.
6. Tests to add or run.
7. Rollback plan.
8. Additional options you think are better, with pros/cons/recommendation.

Implementation detail to consider:
- Add env var UK_AIR_SOS_404_COOLDOWN_HOURS, default 6.
- If 0, disable 404 cooldown.
- Filter only 404s, not 502/503/504.
- Include `timeseries_skipped_recent_404` in dispatch logs.
- Optionally include observed/error counts by pollutant/status in run summaries if feasible.
```
