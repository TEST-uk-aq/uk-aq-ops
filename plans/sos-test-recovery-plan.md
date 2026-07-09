# UK-AQ SOS Test Freshness Recovery Plan

## 1. Summary

The **LIVE** SOS system recovered quickly after the SOS gateway outage, but the **TEST** system has not recovered headline freshness for PM2.5, PM10, and NO2.

The confusing part is that TEST Cloud Run / dispatcher logs show successful SOS runs and recent `last observed` timestamps, but the dashboard freshness SQL still shows SOS PM2.5 as stale.

The current evidence points to a **mixed-pollutant station-level scheduling issue**:

- SOS station checkpoints appear to be updated at station level.
- A station can have fresh observations for pollutants such as `NO`, `NOx as NO2`, `SO2`, or VOC-style species.
- That station then appears fresh at station/checkpoint level.
- But its PM2.5 / PM10 / NO2 observations can still be stale.
- The scheduler may then defer that station, even though the headline pollutants are still not recovered.

In short:

> TEST is recovering “some SOS data”, but not necessarily the pollutants that the freshness dashboard cares about.

## 2. Symptoms Seen

### 2.1 Freshness SQL result for TEST

For SOS PM2.5:

```json
{
  "connector_code": "sos",
  "source": "last_value_at",
  "stations_with_pm25": 148,
  "stations_0_3_hours": 0,
  "stations_3_6_hours": 0,
  "stations_6_24_hours": 148,
  "stations_1_7_days": 0,
  "stations_older_than_7_days": 0
}
```

But the same SQL using real observations showed:

```json
{
  "connector_code": "sos",
  "source": "observed_at",
  "stations_with_pm25": 148,
  "stations_0_3_hours": 0,
  "stations_3_6_hours": 0,
  "stations_6_24_hours": 0,
  "stations_1_7_days": 125,
  "stations_older_than_7_days": 23
}
```

That means PM2.5 has **no real observations within 24 hours** in TEST, even though `timeseries.last_value_at` appears more recent.

### 2.2 Pollutant breakdown of recent TEST observations

Recent SOS observations in the last 24 hours were found for pollutants like:

```text
ch2chch3
h3cch2ch3
hcch
no
noxasno2
so2
```

But not for:

```text
pm25
pm10
no2
```

This strongly suggests that TEST is polling or inserting recent SOS data, but not the headline pollutants expected by the dashboard.

### 2.3 `last_value_at` does not match latest real observation

Example PM2.5 rows showed:

```text
last_value_at      = 2026-05-16 00:00:00+00
latest_observed_at = 2026-05-11 18:00:00+00
```

So `timeseries.last_value_at` is ahead of the latest actual observation row for those PM2.5 timeseries.

That means `last_value_at` should not currently be trusted as the source of truth for TEST SOS freshness.

### 2.4 Station checkpoint query shows mixed results

Some stations genuinely have:

```text
checkpoint_last_observed_at = 2026-05-16 06:00:00+00
max_timeseries_last_value_at = 2026-05-16 06:00:00+00
max_real_observed_at = 2026-05-16 06:00:00+00
```

But this is calculated across **all pollutants** for the station. It does not prove PM2.5 / PM10 / NO2 are fresh.

Other stations showed:

```text
checkpoint_last_observed_at = 2026-05-11 18:00:00+00
next_due_at = 2026-05-11 19:00:00+00
max_timeseries_last_value_at = 2026-05-16 00:00:00+00
max_real_observed_at = 2026-05-11 18:00:00+00
```

This is another sign that summary fields and station-level freshness are not safe enough for pollutant-specific recovery decisions.

## 3. Likely Root Cause

The likely root cause is that SOS scheduling/checkpointing is **station-level**, while SOS data freshness is effectively **timeseries/pollutant-level**.

A station can provide many pollutants. If one pollutant updates, the station checkpoint may be advanced. That can incorrectly make the scheduler believe the station has recovered, even if PM2.5, PM10, or NO2 remain stale.

This is especially visible in TEST because the recent successful runs appear to have recovered non-headline pollutants first.

## 4. Why LIVE Recovered Faster

LIVE may have recovered faster because:

1. Its scheduler selected stations/timeseries with PM2.5 / PM10 / NO2 earlier.
2. Its checkpoints were not contaminated or delayed in the same way.
3. The LIVE data distribution may differ from TEST.
4. LIVE may have had fewer stale stations or fewer stale target pollutants.
5. TEST may have had an interrupted large recovery run that left scheduling/checkpoint state less useful.

The key point is that LIVE recovery does not prove the TEST logic is safe. TEST exposed a weakness in station-level recovery behaviour.

## 5. Immediate Recovery Options

### Option A — Let TEST drain naturally

Leave the current 12-hour window and batch size alone and allow scheduled runs to continue.

**Pros**

- Lowest operational risk.
- No manual DB changes beyond what has already been done.
- Avoids another Cloud Run memory spike.

**Cons**

- May take a long time.
- May continue polling fresh non-target pollutants while PM2.5 / PM10 / NO2 remain stale.
- Does not fix the underlying mixed-pollutant scheduling issue.

**Recommendation**

Not recommended as the only recovery approach. It is safe but may not recover the dashboard pollutants quickly.

---

### Option B — Force all SOS stations due again

Set all SOS station checkpoint `next_due_at` values to now/staggered times.

**Pros**

- Simple.
- Forces broad coverage.
- Useful if the problem is simply that the scheduler is not revisiting stations.

**Cons**

- Expensive: there are around 3,013 SOS station candidates in TEST.
- Can waste runs on stations/pollutants that are not relevant to the dashboard.
- Could cause memory/runtime pressure if batch/window are too high.
- Still does not guarantee PM2.5 / PM10 / NO2 are prioritised.

**Recommendation**

Use only with a small batch size and staggered `next_due_at` values. Do not set everything to due at the same instant.

---

### Option C — Force only stations with stale PM2.5 / PM10 / NO2

Use real `observations.observed_at` values to find stations where PM2.5 / PM10 / NO2 are stale, then stagger those stations’ checkpoints.

**Pros**

- Targets the pollutants the dashboard cares about.
- Avoids wasting recovery capacity on stations that are only stale for irrelevant pollutants.
- Safer than forcing all SOS stations.
- Best operational recovery option without a code change.

**Cons**

- Still station-level, so it cannot force only one pollutant at a station.
- If the SOS endpoint returns all pollutants for a station, this may still fetch non-target data.
- If some stations do not actually publish PM/NO2 anymore, they may keep being retried.

**Recommendation**

Recommended immediate recovery approach.

Example SQL:

```sql
with connector as (
  select id as connector_id
  from uk_aq_core.connectors
  where connector_code = 'sos'
  limit 1
),
target_station_freshness as (
  select
    ts.station_id,
    max(o.observed_at) filter (
      where regexp_replace(
        lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) = 'pm25'
    ) as pm25_latest,
    max(o.observed_at) filter (
      where regexp_replace(
        lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) = 'pm10'
    ) as pm10_latest,
    max(o.observed_at) filter (
      where regexp_replace(
        lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
        '[^a-z0-9]+',
        '',
        'g'
      ) = 'no2'
    ) as no2_latest
  from uk_aq_core.timeseries ts
  left join uk_aq_core.phenomena p
    on p.id = ts.phenomenon_id
  left join uk_aq_core.observations o
    on o.timeseries_id = ts.id
   and o.value is not null
  where ts.connector_id = (select connector_id from connector)
    and ts.station_id is not null
  group by ts.station_id
),
target_stations as (
  select station_id
  from target_station_freshness
  where coalesce(pm25_latest, '-infinity'::timestamptz) < now() - interval '24 hours'
     or coalesce(pm10_latest, '-infinity'::timestamptz) < now() - interval '24 hours'
     or coalesce(no2_latest, '-infinity'::timestamptz) < now() - interval '24 hours'
),
numbered as (
  select
    sc.station_id,
    row_number() over (order by sc.station_id) as rn
  from uk_aq_raw.sos_station_checkpoints sc
  join target_stations t
    on t.station_id = sc.station_id
)
update uk_aq_raw.sos_station_checkpoints sc
set
  next_due_at = now() + ((numbered.rn - 1) / 25) * interval '5 minutes',
  last_polled_at = null,
  updated_at = now()
from numbered
where numbered.station_id = sc.station_id;
```

Keep the recovery settings conservative:

```text
window = 12 hours
batch size = 25, or similarly small
```

---

### Option D — Temporarily lower batch size and repeat targeted recovery

Set a small batch size and repeat targeted recovery until `observations.observed_at` freshness improves for PM2.5 / PM10 / NO2.

**Pros**

- Reduces Cloud Run memory risk.
- Lets you observe recovery step-by-step.
- Easier to stop if wrong pollutants continue being selected.

**Cons**

- Slower.
- Requires monitoring.

**Recommendation**

Recommended alongside Option C.

Example:

```sql
update uk_aq_core.connectors
set
  poll_enabled = true,
  poll_timeseries_batch_size = 25,
  updated_at = now()
where connector_code = 'sos';
```

---

### Option E — Reset `timeseries.last_value_at` from real observations

Repair `uk_aq_core.timeseries.last_value` and `last_value_at` for SOS by recalculating from `uk_aq_core.observations`.

**Pros**

- Makes dashboard summary fields honest again.
- Removes false freshness from PM2.5 / PM10 / NO2 rows.
- Helps avoid misleading dashboard status.

**Cons**

- Does not by itself fetch missing observations.
- Needs careful SQL to avoid setting values incorrectly.
- Could affect other dashboard behaviour if not tested.

**Recommendation**

Recommended after confirming the update logic in the schema/repo. Do not do this blindly until the exact intended behaviour of `last_value` / `last_value_at` is confirmed.

Potential repair pattern:

```sql
with latest as (
  select distinct on (o.timeseries_id)
    o.timeseries_id,
    o.observed_at,
    o.value
  from uk_aq_core.observations o
  join uk_aq_core.timeseries ts
    on ts.id = o.timeseries_id
  join uk_aq_core.connectors c
    on c.id = ts.connector_id
  where c.connector_code = 'sos'
    and o.value is not null
  order by o.timeseries_id, o.observed_at desc
)
update uk_aq_core.timeseries ts
set
  last_value_at = latest.observed_at,
  last_value = latest.value,
  updated_at = now()
from latest
where latest.timeseries_id = ts.id
  and ts.connector_id = (
    select id from uk_aq_core.connectors where connector_code = 'sos' limit 1
  );
```

This should be reviewed against schema constraints, triggers, and app assumptions before use.

## 6. Longer-Term Fix Options

### Fix Option 1 — Keep station checkpoints, but make selection/freshness pollutant-aware

The scheduler can still use station checkpoints, but station freshness calculations should consider target pollutants separately.

For example, for recovery and priority ordering:

- `pm25_latest_observed_at`
- `pm10_latest_observed_at`
- `no2_latest_observed_at`
- `station_any_pollutant_latest_observed_at`

The scheduler should not mark a station as healthy for all purposes just because one pollutant is fresh.

**Pros**

- Smaller change than full timeseries checkpointing.
- Keeps existing station checkpoint model.
- Good enough for dashboard recovery.

**Cons**

- Still imperfect if different pollutants have very different update patterns.
- Adds complexity to station selection logic.
- May still over-fetch pollutants that are already fresh.

**Recommendation**

Good medium-term fix if timeseries-level checkpointing is too big a change.

---

### Fix Option 2 — Move SOS scheduling to timeseries-level checkpoints

Each SOS timeseries gets its own checkpoint / next due state.

**Pros**

- Most correct model.
- Prevents fresh NO from hiding stale PM2.5.
- Enables targeted recovery by pollutant.
- Better diagnostics and dashboards.

**Cons**

- Larger schema and code change.
- More checkpoint rows.
- Requires careful migration from station-level state.
- May need batching by station to avoid inefficient SOS requests.

**Recommendation**

Best long-term correctness fix, but not necessarily the fastest.

---

### Fix Option 3 — Add station + pollutant-group checkpoints

Instead of every timeseries, maintain checkpoint rows for groups such as:

```text
station_id + pollutant_key
```

or:

```text
station_id + pollutant_group
```

Where pollutant group could be:

- `headline`: PM2.5, PM10, NO2, O3, SO2
- `nitrogen`: NO, NO2, NOx as NO2
- `voc`
- `other`

**Pros**

- More accurate than station-only.
- Less granular than full timeseries checkpointing.
- Helps dashboard/headline freshness without exploding complexity too much.

**Cons**

- Needs careful definition of groups.
- Still less precise than timeseries-level.
- Possible confusion if pollutant keys change.

**Recommendation**

Good compromise if the service naturally fetches all pollutants for a station but reporting needs pollutant-aware freshness.

---

### Fix Option 4 — Improve summary-field integrity

Ensure `timeseries.last_value` and `timeseries.last_value_at` are only updated from actual inserted or existing observation rows, never merely from parsed external timestamps or station/checkpoint timestamps.

**Pros**

- Fixes misleading dashboards.
- Prevents false freshness.
- Helps all connectors, not just SOS.

**Cons**

- Needs repo/schema review to find all update paths.
- May require trigger/RPC changes.
- Could expose stale data more clearly, which is correct but may look worse initially.

**Recommendation**

Highly recommended. This should be treated as an integrity fix.

---

### Fix Option 5 — Add pollutant counts to dispatcher/run logs

Every SOS run log should include counts by pollutant key, for example:

```json
{
  "observations_by_pollutant": {
    "pm25": 0,
    "pm10": 0,
    "no2": 0,
    "no": 242,
    "noxasno2": 242,
    "so2": 44
  }
}
```

**Pros**

- Makes the current issue obvious in logs.
- Helps distinguish “SOS is working” from “headline pollutants recovered”.
- Low risk.

**Cons**

- Observability only; does not fix scheduling.

**Recommendation**

Strongly recommended as a quick code improvement.

## 7. Recommended Path

### Immediate

1. Keep SOS TEST recovery window at 12 hours.
2. Keep batch size conservative, for example 25.
3. Do not trust `timeseries.last_value_at` for TEST SOS recovery decisions.
4. Use real `observations.observed_at` to identify stale PM2.5 / PM10 / NO2 stations.
5. Stagger only those stations’ `next_due_at` values.
6. Monitor PM2.5 / PM10 / NO2 `observed_at` freshness, not just dispatcher `last observed`.

### Near-term code fix

1. Add pollutant breakdown to SOS dispatcher logs.
2. Audit all places that update `timeseries.last_value` and `last_value_at`.
3. Ensure summary fields are derived only from actual observations.
4. Make SOS station selection pollutant-aware.

### Longer-term

Choose between:

- station + pollutant-group checkpointing, or
- full timeseries-level checkpointing.

For correctness, full timeseries-level checkpointing is best. For a practical medium-term improvement, station + pollutant-group checkpointing may be enough.

## 8. Monitoring Queries

### 8.1 Pollutant-specific latest observed_at

```sql
with sos as (
  select
    ts.id as timeseries_id,
    ts.station_id,
    regexp_replace(
      lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
      '[^a-z0-9]+',
      '',
      'g'
    ) as pollutant_key
  from uk_aq_core.timeseries ts
  join uk_aq_core.connectors c
    on c.id = ts.connector_id
  left join uk_aq_core.phenomena p
    on p.id = ts.phenomenon_id
  where c.connector_code = 'sos'
    and ts.station_id is not null
),
latest_obs as (
  select
    s.station_id,
    s.pollutant_key,
    max(o.observed_at) as latest_observed_at
  from sos s
  left join uk_aq_core.observations o
    on o.timeseries_id = s.timeseries_id
   and o.value is not null
  group by s.station_id, s.pollutant_key
)
select
  pollutant_key,
  count(*) as station_pollutant_count,
  count(*) filter (where latest_observed_at >= now() - interval '3 hours') as latest_0_3h,
  count(*) filter (where latest_observed_at >= now() - interval '6 hours') as latest_0_6h,
  count(*) filter (where latest_observed_at >= now() - interval '24 hours') as latest_0_24h,
  count(*) filter (where latest_observed_at >= now() - interval '7 days') as latest_0_7d,
  max(latest_observed_at) as newest_observed_at
from latest_obs
where pollutant_key in ('pm25', 'pm10', 'no2', 'no', 'noxasno2', 'so2', 'o3')
group by pollutant_key
order by pollutant_key;
```

### 8.2 Stations where any pollutant is fresh but headline pollutants are stale

```sql
with sos as (
  select
    ts.id as timeseries_id,
    ts.station_id,
    regexp_replace(
      lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
      '[^a-z0-9]+',
      '',
      'g'
    ) as pollutant_key
  from uk_aq_core.timeseries ts
  join uk_aq_core.connectors c
    on c.id = ts.connector_id
  left join uk_aq_core.phenomena p
    on p.id = ts.phenomenon_id
  where c.connector_code = 'sos'
    and ts.station_id is not null
),
latest_obs as (
  select
    s.station_id,
    s.pollutant_key,
    max(o.observed_at) as latest_observed_at
  from sos s
  left join uk_aq_core.observations o
    on o.timeseries_id = s.timeseries_id
   and o.value is not null
  group by s.station_id, s.pollutant_key
)
select
  station_id,
  max(latest_observed_at) as station_any_pollutant_latest,
  max(latest_observed_at) filter (where pollutant_key = 'pm25') as pm25_latest,
  max(latest_observed_at) filter (where pollutant_key = 'pm10') as pm10_latest,
  max(latest_observed_at) filter (where pollutant_key = 'no2') as no2_latest,
  max(latest_observed_at) filter (where pollutant_key = 'no') as no_latest,
  max(latest_observed_at) filter (where pollutant_key = 'noxasno2') as nox_latest,
  max(latest_observed_at) filter (where pollutant_key = 'so2') as so2_latest
from latest_obs
group by station_id
having max(latest_observed_at) >= now() - interval '24 hours'
   and (
     coalesce(max(latest_observed_at) filter (where pollutant_key = 'pm25'), '-infinity'::timestamptz) < now() - interval '24 hours'
     or coalesce(max(latest_observed_at) filter (where pollutant_key = 'pm10'), '-infinity'::timestamptz) < now() - interval '24 hours'
     or coalesce(max(latest_observed_at) filter (where pollutant_key = 'no2'), '-infinity'::timestamptz) < now() - interval '24 hours'
   )
order by station_any_pollutant_latest desc
limit 100;
```

## 9. Claude Code Prompt

Use this prompt in Claude Code with the ingest repo mounted at `/workspaces/uk-aq-ingest`.

```text
You are working in the UK-AQ ingest repo at:

/workspaces/uk-aq-ingest

Context:

We have a SOS connector that runs in Google Cloud Run and uses station-level checkpoints, likely in a table named something like:

uk_aq_raw.sos_station_checkpoints

A recent SOS gateway outage happened. LIVE recovered quickly, but TEST did not recover PM2.5 / PM10 / NO2 freshness.

Important observed behaviour from TEST:

1. Dispatcher/Cloud Run logs show successful SOS runs and recent `last observed` timestamps.
2. But dashboard freshness for SOS PM2.5 remains stale.
3. SQL using real observations shows:
   - PM2.5 observed_24h = 0
   - PM10 observed_24h = 0
   - NO2 observed_24h = 0
4. Recent observations do exist for SOS, but for other pollutants:
   - NO
   - NOx as NO2
   - SO2
   - VOC-style pollutant keys
5. Some `timeseries.last_value_at` values for PM2.5 / PM10 / NO2 are newer than the actual latest row in `uk_aq_core.observations`.
6. Station checkpoint freshness appears to be based on station-level latest observation across all pollutants. This means a station can look fresh because NO/NOx/SO2 updated, while PM2.5 / PM10 / NO2 are still stale.

Tasks:

1. Analyse the SOS connector code path end-to-end.
   - Find where station candidates are selected.
   - Find where due/eligible stations are chosen.
   - Find where `next_due_at`, `last_polled_at`, and `last_observed_at` are updated.
   - Find where `timeseries.last_value` and `timeseries.last_value_at` are updated.
   - Find where dispatcher/run logs are produced.

2. Confirm whether the current logic is station-level and mixed-pollutant.
   - Does a fresh observation for any pollutant advance station checkpoint freshness?
   - Can fresh NO/NOx/SO2/VOC data make a station look recovered while PM2.5 / PM10 / NO2 remain stale?
   - Is `timeseries.last_value_at` ever updated from parsed rows or checkpoint state rather than from actual inserted/existing observation rows?

3. Produce a detailed analysis report in markdown.
   Include:
   - The exact files/functions involved.
   - The current scheduling/checkpoint algorithm.
   - Whether the suspected mixed-pollutant issue is real.
   - Why LIVE may recover while TEST gets stuck.
   - Any other plausible causes found in code.

4. Suggest fix options with pros, cons, and recommendation.
   Please include at least these options:
   - Keep station checkpoints but make selection/freshness pollutant-aware.
   - Add station + pollutant-group checkpoints.
   - Move to full timeseries-level checkpoints.
   - Repair `timeseries.last_value_at` update integrity so it is only derived from actual observation rows.
   - Add pollutant-level counts to dispatcher logs.

5. Recommend the safest immediate code change.
   The preferred shape is likely:
   - Do not treat station-level latest observed_at across all pollutants as proof that headline pollutants are fresh.
   - Add pollutant-aware diagnostics/logging.
   - Make recovery prioritisation consider stale PM2.5 / PM10 / NO2 using actual observations.
   - Ensure summary fields are updated only from inserted/existing observations.

6. Do not make code changes yet unless the repo already has an obvious small bug and the fix is low-risk.
   First produce the analysis and recommended implementation plan.

Output:

Create or update a markdown file, for example:

docs/sos-pollutant-freshness-analysis.md

The report should be clear enough that I can review it before asking you to implement anything.
```

## 10. Final Recommendation

The safest recovery path is:

1. Treat `observations.observed_at` as the source of truth.
2. Target PM2.5 / PM10 / NO2 stations specifically for recovery.
3. Keep batch/window conservative to avoid Cloud Run memory kills.
4. Add pollutant-level diagnostics before making larger scheduler changes.
5. Plan a code fix so SOS freshness is not only station-level.

The most likely durable fix is either:

- **station + pollutant-group checkpoints**, if you want a pragmatic solution, or
- **timeseries-level checkpoints**, if you want the most correct model.

The current station-level checkpoint model is too blunt for SOS because one fresh pollutant can hide other stale pollutants at the same station.
