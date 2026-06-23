# Hex Map API Checker & Metrics

## Purpose

Create a lightweight observability pipeline for the public UK AQ hex map API so that valid-but-suspicious API responses are detected, logged, and visible over time.

The immediate problem this is designed to catch is not just an API failure such as `500`, `502`, `CORS blocked`, or JSON parse failure. It is also designed to catch cases where the API returns `200 OK` with valid JSON, but the contents look wrong, for example Breathe London or GOV.UK AURN disappearing from the hex map snapshot and then returning later after cache behaviour changes.

The checker should run every 10 minutes and store network totals in Supabase under the existing `uk_aq_ops` schema. A new dashboard page can then show website/API health metrics, including line graphs of network totals over time.

## High-level design

```text
Cloudflare Cron Worker or small scheduled service
  Every 10 minutes
    Fetch the same latest-snapshot API used by hex_map.html
    Fetch cache-busted version of the same URL
    Optionally fetch direct latest-snapshot R2 API worker URL
    Summarise totals by pollutant, window, network
    Detect suspicious responses
    Write check run + network totals to Supabase uk_aq_ops tables
    Log warnings/errors only when suspicious
Dashboard Website Metrics page
  Reads Supabase uk_aq_ops metrics
  Shows status cards, suspicious events, and one network-total line graph per pollutant
```

## Existing snapshot contract

The latest snapshot system already publishes a deterministic matrix:

```text
pollutants: pm25, pm10, no2
windows: 3h, 6h, 1d, 7d, all
network_group: all
```

Public/cache-proxy route:

```text
/api/aq/latest-snapshot?pollutant=pm25&window=all&network_group=all
```

Expected R2 object pattern:

```text
latest_snapshots/v1/network_group=all/pollutant=pm25/window=3h.json
latest_snapshots/v1/network_group=all/pollutant=pm10/window=6h.json
latest_snapshots/v1/network_group=all/pollutant=no2/window=1d.json
latest_snapshots/v1/manifest.json
```

This makes the checker straightforward because it can poll the same matrix the hex map relies on.

## What the checker should test

For each configured environment, usually `cic-test`, `beta`, and later `prod`, fetch:

```text
/api/aq/latest-snapshot?pollutant=pm25&window=3h&network_group=all
/api/aq/latest-snapshot?pollutant=pm25&window=6h&network_group=all
/api/aq/latest-snapshot?pollutant=pm25&window=1d&network_group=all
/api/aq/latest-snapshot?pollutant=pm25&window=7d&network_group=all
/api/aq/latest-snapshot?pollutant=pm25&window=all&network_group=all

Repeat for pm10 and no2.
```

For each matrix item, fetch at least:

```text
normal public URL
cache-busted public URL with &_checker_ts=<timestamp>
```

Later add:

```text
direct latest-snapshot R2 API worker URL, using upstream auth
```

This gives a clean diagnosis split:

```text
direct R2 worker good + public normal bad = cache/proxy issue
direct R2 worker bad + public bad = latest snapshot builder/R2 issue
both good but browser bad = browser/local/frontend issue
normal public differs from cache-busted public = Cloudflare cache inconsistency
```

## Supabase schema

Use the existing `uk_aq_ops` schema.

Do not create a new `uk_aq_observability` schema.

### Table 1: checker runs

One row per checker run.

```sql
create table if not exists uk_aq_ops.hex_map_api_check_runs (
  id uuid primary key default gen_random_uuid(),

  checked_at timestamptz not null default now(),
  environment text not null,
  checker_version text not null default 'v1',

  ok boolean not null,
  suspicious boolean not null default false,
  reason_codes text[] not null default '{}',

  normal_status integer,
  cache_busted_status integer,
  direct_r2_status integer,

  normal_cf_cache_status text,
  normal_age_seconds integer,
  normal_etag text,

  cache_busted_cf_cache_status text,
  cache_busted_age_seconds integer,
  cache_busted_etag text,

  direct_r2_etag text,

  response_ms integer,
  notes text,

  created_at timestamptz not null default now()
);

create index if not exists hex_map_api_check_runs_checked_at_idx
  on uk_aq_ops.hex_map_api_check_runs (checked_at desc);

create index if not exists hex_map_api_check_runs_env_time_idx
  on uk_aq_ops.hex_map_api_check_runs (environment, checked_at desc);

create index if not exists hex_map_api_check_runs_suspicious_idx
  on uk_aq_ops.hex_map_api_check_runs (suspicious, checked_at desc);
```

### Table 2: network totals

Long-format table for charting.

One row per:

```text
run_id
environment
fetch_variant
pollutant
window_label
network
```

```sql
create table if not exists uk_aq_ops.hex_map_api_network_totals (
  id bigserial primary key,

  run_id uuid not null references uk_aq_ops.hex_map_api_check_runs(id) on delete cascade,

  checked_at timestamptz not null,
  environment text not null,

  fetch_variant text not null,
  pollutant text not null,
  window_label text not null,

  network_key text not null,
  network_label text not null,

  row_count integer not null default 0,
  station_count integer,

  min_observed_at timestamptz,
  max_observed_at timestamptz,

  payload_count integer,
  payload_data_length integer,

  created_at timestamptz not null default now(),

  constraint hex_map_api_network_totals_fetch_variant_check
    check (fetch_variant in ('normal', 'cache_busted', 'direct_r2')),

  constraint hex_map_api_network_totals_pollutant_check
    check (pollutant in ('pm25', 'pm10', 'no2')),

  constraint hex_map_api_network_totals_window_check
    check (window_label in ('3h', '6h', '1d', '7d', 'all'))
);

create index if not exists hex_map_api_network_totals_chart_idx
  on uk_aq_ops.hex_map_api_network_totals
  (environment, pollutant, window_label, network_key, checked_at);

create index if not exists hex_map_api_network_totals_run_idx
  on uk_aq_ops.hex_map_api_network_totals (run_id);

create index if not exists hex_map_api_network_totals_variant_time_idx
  on uk_aq_ops.hex_map_api_network_totals
  (environment, fetch_variant, checked_at desc);
```

### Optional table 3: anomaly events

This can wait until after the basic checker is working. In v1, `reason_codes` in `hex_map_api_check_runs` is enough.

If anomalies need a separate detail table later:

```sql
create table if not exists uk_aq_ops.hex_map_api_check_events (
  id bigserial primary key,

  run_id uuid not null references uk_aq_ops.hex_map_api_check_runs(id) on delete cascade,

  checked_at timestamptz not null,
  environment text not null,

  severity text not null default 'warning',
  reason_code text not null,
  pollutant text,
  window_label text,
  network_key text,
  network_label text,

  expected_value numeric,
  actual_value numeric,
  previous_value numeric,
  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint hex_map_api_check_events_severity_check
    check (severity in ('info', 'warning', 'error'))
);

create index if not exists hex_map_api_check_events_time_idx
  on uk_aq_ops.hex_map_api_check_events (checked_at desc);

create index if not exists hex_map_api_check_events_reason_idx
  on uk_aq_ops.hex_map_api_check_events (reason_code, checked_at desc);
```

## Network total logic

For each API payload row, derive one or more network labels from:

```text
station_network_memberships[].network_label
station_network_memberships[].network_code
network_name, if present
connector_label
connector_code
```

Normalise network labels for stable grouping.

Suggested important network keys:

```text
all
gov_uk_aurn
breathe_london
openaq
sensor_community
purpleair
unknown
```

The checker should also write a synthetic row:

```text
network_key = all
network_label = All networks
```

This makes the total line simple to chart.

### AURN matching

Treat these as AURN matches:

```text
GOV.UK AURN
AURN
network labels/codes containing AURN
connector labels/codes containing AURN
```

### Breathe London matching

Treat these as Breathe London matches:

```text
Breathe London
network labels/codes containing breathe london
connector labels/codes containing breathe london
```

## Suspicious response rules

Start conservatively to avoid false positives.

### Hard failures

Mark the run suspicious if any of these happen:

```text
HTTP status is not 200
JSON parse fails
payload.data is not an array
payload.count does not match payload.data.length
```

Reason codes:

```text
http_status_not_200
json_parse_failed
missing_data_array
payload_count_mismatch
```

### Important network missing

For `pm25` and `window=all`, mark suspicious if:

```text
GOV.UK AURN count = 0
Breathe London count = 0
```

Reason codes:

```text
aurn_missing
breathe_london_missing
```

Later extend this to `1d` or `7d` if useful.

### Normal vs cache-busted difference

Compare normal public URL with cache-busted public URL.

Mark suspicious if:

```text
normal total count differs from cache-busted count by more than 5%
important network count differs by more than 20%
normal has AURN/Breathe London = 0 but cache-busted has > 0
```

Reason codes:

```text
normal_cache_busted_total_diff
normal_cache_busted_network_diff
normal_cache_busted_network_missing
```

### Drop versus recent baseline

After there is enough data in Supabase, compare against a recent rolling baseline.

Suggested baseline:

```text
median row_count over last 24 hours
same environment
same fetch_variant
same pollutant
same window_label
same network_key
```

Mark suspicious if:

```text
current row_count is more than 50% below baseline
baseline has at least 6 samples
baseline is not already near zero
```

Reason code:

```text
network_total_drop
```

### Staleness

For live-ish windows, mark suspicious if the newest observation is too old.

Initial thresholds:

```text
3h window: max_observed_at older than 3h plus 30 mins
6h window: max_observed_at older than 6h plus 30 mins
1d window: max_observed_at older than 26h
7d and all: do not use strict freshness at first
```

Reason code:

```text
snapshot_stale
```

### Cache age

If `CF-Cache-Status` is `HIT` and `Age` is unexpectedly high, mark warning.

Initial threshold:

```text
Age > 600 seconds for latest snapshot public API
```

Reason code:

```text
cf_cache_age_high
```

## Dashboard page

Add a new page to the ops dashboard:

```text
Website Metrics
```

Possible file/name:

```text
website_metrics.html
```

or within the existing dashboard app as:

```text
Website Metrics
Hex Map API
Latest Snapshot API
```

### Top cards

Show:

```text
Last check time
Current status
Suspicious checks in last 24h
Most recent reason code
Normal vs cache-busted mismatch count in last 24h
Latest PM2.5 all total
Latest AURN PM2.5 all total
Latest Breathe London PM2.5 all total
```

### Controls

```text
Environment: cic-test / beta / prod
Fetch variant: normal / cache_busted / direct_r2
Window: 3h / 6h / 1d / 7d / all
Time range: 24h / 7d / 30d
Networks: All / key networks / custom selected
```

Default controls:

```text
environment = beta or cic-test, depending deployment
fetch_variant = normal
window = all
time range = 24h
networks = All networks, GOV.UK AURN, Breathe London, OpenAQ, Sensor.Community
```

### Graphs

Use one graph per pollutant:

```text
PM2.5 network totals
PM10 network totals
NO2 network totals
```

Each graph:

```text
x-axis: checked_at
y-axis: row_count
line series: selected network labels
```

This makes sudden drops visually obvious.

### Suspicious checks table

Below the graphs, show recent suspicious checks:

```text
checked_at
environment
reason_codes
normal_status
normal_cf_cache_status
normal_age_seconds
normal_etag
notes
```

Add a link/button to expand a run and show the per-network totals for that run.

## Retention and rollups

10-minute checks can grow quickly.

Example volume:

```text
144 checks per day
3 pollutants
5 windows
8 network rows including All networks
2 fetch variants
= 34,560 network total rows per day
```

That is acceptable initially, but should have retention.

Suggested policy:

```text
Keep raw 10-minute rows for 60 days
Keep hourly rollups for longer
Keep suspicious check runs and events longer than ordinary rows
```

### Hourly rollup materialized view

```sql
create materialized view if not exists uk_aq_ops.hex_map_api_network_totals_hourly as
select
  date_trunc('hour', checked_at) as hour_utc,
  environment,
  fetch_variant,
  pollutant,
  window_label,
  network_key,
  network_label,
  avg(row_count)::numeric(12,2) as avg_row_count,
  min(row_count) as min_row_count,
  max(row_count) as max_row_count,
  max(max_observed_at) as max_observed_at,
  count(*) as sample_count
from uk_aq_ops.hex_map_api_network_totals
group by
  date_trunc('hour', checked_at),
  environment,
  fetch_variant,
  pollutant,
  window_label,
  network_key,
  network_label;
```

Refresh strategy can be decided later.

## Worker/service implementation options

### Preferred option: Cloudflare Worker Cron

Pros:

```text
Close to the public website/API layer being tested
Cheap
Easy 10-minute schedule
Can test public Cloudflare cache behaviour directly
Can write to Supabase REST API
```

Cons:

```text
Direct R2 worker auth and Supabase secrets need careful handling
Less convenient than Node scripts for local debugging
```

### Alternative: GCP Cloud Run job

Pros:

```text
Familiar from existing ingest/snapshot jobs
Good logs
Easier Node/Deno environment
```

Cons:

```text
Adds another GCP scheduled service
The issue may be Cloudflare-specific, so running inside Cloudflare gives a more relevant vantage point
```

### Recommendation

Use **Cloudflare Worker Cron** for the scheduled checker.

Also provide a local CLI checker script for manual diagnosis:

```text
scripts/backup_r2/uk_aq_audit_latest_snapshot_r2.mjs
```

The local script should be able to compare:

```text
R2 object contents
public cache proxy
cache-busted proxy
direct worker, if auth is available
```

## Environment variables and secrets

Suggested Worker variables:

```text
UK_AQ_HEX_API_CHECKER_ENVIRONMENT=beta
UK_AQ_HEX_API_CHECKER_PUBLIC_BASE_URL=https://uk-aq-beta.chronicillnesschannel.co.uk/api/aq/latest-snapshot
UK_AQ_HEX_API_CHECKER_DIRECT_R2_API_URL=https://uk-aq-latest-snapshot-r2-api.<subdomain>.workers.dev/v1/latest-snapshot
UK_AQ_HEX_API_CHECKER_ENABLE_DIRECT_R2=0
UK_AQ_HEX_API_CHECKER_POLLUTANTS=pm25,pm10,no2
UK_AQ_HEX_API_CHECKER_WINDOWS=3h,6h,1d,7d,all
UK_AQ_HEX_API_CHECKER_NETWORK_GROUP=all
UK_AQ_HEX_API_CHECKER_VERSION=v1
SUPABASE_URL=<project URL>
SUPABASE_SERVICE_ROLE_KEY=<secret>
UK_AQ_EDGE_UPSTREAM_SECRET=<secret, only if direct R2 worker is enabled>
```

Use service role key only in server-side Worker environment, never in browser code.

## Supabase write strategy

The checker should write:

1. Insert one `hex_map_api_check_runs` row.
2. Insert many `hex_map_api_network_totals` rows with that `run_id`.
3. If an insert fails, log the full error and mark Worker run as failed.

Prefer one bulk insert for network totals rather than one request per row.

## Dashboard read strategy

Dashboard can read via an existing dashboard API/RPC rather than direct browser access to tables.

Suggested latest-status view:

```sql
create or replace view uk_aq_ops.hex_map_api_latest_status as
select distinct on (environment)
  *
from uk_aq_ops.hex_map_api_check_runs
order by environment, checked_at desc;
```

For chart data, a simple read query is enough:

```sql
select
  checked_at,
  network_label,
  row_count
from uk_aq_ops.hex_map_api_network_totals
where environment = 'beta'
  and fetch_variant = 'normal'
  and pollutant = 'pm25'
  and window_label = 'all'
  and checked_at >= now() - interval '7 days'
  and network_key in ('all', 'gov_uk_aurn', 'breathe_london', 'openaq', 'sensor_community')
order by checked_at, network_label;
```

## Implementation phases

### Phase 1: Schema

Create SQL migration in the ops repo.

Suggested file:

```text
supabase/sql/20260623_hex_map_api_checker_metrics.sql
```

Tasks:

```text
Create uk_aq_ops.hex_map_api_check_runs
Create uk_aq_ops.hex_map_api_network_totals
Add indexes
Add latest status view
Do not create anomaly event table yet unless needed
```

### Phase 2: Checker Worker v1

Create a Cloudflare Worker.

Suggested location:

```text
workers/uk_aq_hex_map_api_checker/
```

Tasks:

```text
Cron schedule every 10 minutes
Fetch public latest-snapshot matrix
Fetch cache-busted matrix
Calculate network totals
Detect basic suspicious states
Write run row and network totals to Supabase
Log structured info/error
```

### Phase 3: Manual checker script

Add a local CLI checker for diagnosis.

Suggested location:

```text
scripts/backup_r2/uk_aq_audit_latest_snapshot_r2.mjs
```

Tasks:

```text
Read latest_snapshots/v1/manifest.json from R2 using rclone
Read matrix files directly from R2
Summarise counts by network
Optionally compare public proxy and cache-busted proxy
Write JSON report to tmp/
```

### Phase 4: Dashboard page

Add a Website Metrics dashboard page.

Tasks:

```text
Top status cards
Three line graphs, one per pollutant
Network selector
Window selector
Environment selector
Suspicious checks table
```

### Phase 5: Better anomaly detection

Add rolling baseline comparisons from Supabase.

Tasks:

```text
Compare against last 24h median
Detect sudden network count drops
Add clearer reason codes
Consider anomaly events table if needed
```

### Phase 6: Direct R2 worker comparison

Add optional direct latest-snapshot R2 API worker fetch.

Tasks:

```text
Use upstream auth secret
Compare direct R2 worker response with public cache proxy
Classify failure as R2/snapshot issue vs public cache/proxy issue
```

### Phase 7: Retention and rollups

Tasks:

```text
Add retention cleanup for raw 10-minute rows
Add hourly rollup materialized view or table
Use rollups for dashboard ranges longer than 7 days
```

## Suggested Codex prompt

```text
We need to add a Hex Map API Checker & Metrics pipeline to the UK AQ ops repo.

Context:
- The hex map recently appeared to lose Breathe London and GOV.UK AURN stations even though ingestion/dashboard showed recent readings.
- There were no browser console errors and the data later returned after Cloudflare cache purge/refresh behaviour.
- We need to detect valid but suspicious API responses, not just HTTP failures.
- Metrics must be written to the existing Supabase schema uk_aq_ops, not a new schema.

Please implement Phase 1 and Phase 2 only.

Requirements:
1. Add a SQL migration:
   supabase/sql/20260623_hex_map_api_checker_metrics.sql

2. The SQL migration must create:
   - uk_aq_ops.hex_map_api_check_runs
   - uk_aq_ops.hex_map_api_network_totals
   - useful indexes for time-series dashboard queries
   - a simple latest-status view if appropriate

3. Add a Cloudflare Worker:
   workers/uk_aq_hex_map_api_checker/

4. The Worker must:
   - run from cron every 10 minutes
   - fetch /api/aq/latest-snapshot for pollutants pm25, pm10, no2
   - fetch windows 3h, 6h, 1d, 7d, all
   - fetch both normal and cache-busted variants
   - summarise totals by network
   - always add a synthetic All networks row
   - specifically identify GOV.UK AURN/AURN and Breathe London
   - insert one check run row into uk_aq_ops.hex_map_api_check_runs
   - bulk insert network totals into uk_aq_ops.hex_map_api_network_totals
   - mark runs suspicious for HTTP failures, JSON parse failures, payload count mismatches, AURN missing, Breathe London missing, and major normal-vs-cache-busted differences
   - log structured JSON to console

5. Use environment variables/secrets:
   - UK_AQ_HEX_API_CHECKER_ENVIRONMENT
   - UK_AQ_HEX_API_CHECKER_PUBLIC_BASE_URL
   - UK_AQ_HEX_API_CHECKER_POLLUTANTS
   - UK_AQ_HEX_API_CHECKER_WINDOWS
   - UK_AQ_HEX_API_CHECKER_NETWORK_GROUP
   - UK_AQ_HEX_API_CHECKER_VERSION
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY

6. Do not add alerting yet.
7. Do not add direct R2 worker comparison yet.
8. Do not add dashboard UI yet.
9. Include README documentation for the Worker.
10. Archive any existing files before changing them, following the repo's existing archive convention.

Keep the implementation simple and robust. This is an observability checker, not part of the public website request path.
```

## Open decisions

Before implementation, decide:

```text
Which environments to check first: cic-test only, beta only, or both?
Whether to store only key networks or every network seen in payload
Whether to include all five windows from day one or start with all + 1d
Whether the checker runs in Cloudflare only, or also has a local CLI script in the same phase
Dashboard file/page location
Retention period for raw rows
```

Recommended defaults:

```text
Check cic-test and beta first
Store every network seen, plus synthetic All networks
Use all five windows from day one
Use Cloudflare Worker Cron first
Add local CLI script in Phase 3
Keep raw rows for 60 days
```
