# UK AQ AQI Aggregation Plan (Stations First)

Date: 2026-03-05

## 1) Scope and Goal

Build an AQI aggregation pipeline that computes and stores hourly DAQI + EAQI for UK AQ stations (first milestone), then extends to PCON / Local Authority / Region.

In scope now:
- Pollutants: `pm25`, `pm10`, `no2`
- Indices: DAQI + EAQI
- Storage: hourly station `index_level`/`index_band` outputs (plus recommended daily rollups)
- Characteristics: idempotent, late-data tolerant, backfillable, low footprint, low egress

Out of scope now:
- PCON/LA/Region implementation (plan only)
- EEA map rendering (UI target is pie + coloured bars)

## 2) Discovery Summary (Cross-Repo)

Key findings from current repos:
- AggDaily DB currently mirrors a subset of `uk_aq_core` tables and has `uk_aq_ops` / `uk_aq_public` patterns already in place (RLS/grants/RPC style).
- Existing Ops operational tasks are already standardized in Cloud Run services + GitHub deploy workflows + optional Scheduler wiring.
- Station geography mapping fields already exist on `uk_aq_core.stations`: `pcon_code`, `la_code`, `region`.
- Existing area PM2.5 outputs are currently latest-value views (`la_latest_pm25`, `pcon_latest_pm25`) and related RPCs; no AQI aggregate tables yet.

Relevant files reviewed:
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/aggdaily_db/uk_aq_aggdaily_schema.sql`
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_core_schema.sql`
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_rpc.sql`
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_dispatcher_ingest_flow.md`
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/workers/uk_aq_db_size_logger_cloud_run/run_service.ts`
- `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/plans/summary_table_who_daqi_eaqi_pm_no2.csv`

## 3) Where This Should Run (Architecture Options)

### Option A: Supabase `pg_cron` + `pg_net` -> Edge Function

Pros:
- Lowest infra surface area (no extra GCP runtime).
- Scheduling close to DB.
- Simple secrets model if single project.

Cons:
- Harder runtime control for heavy recompute/backfill windows.
- Weaker operational observability than Cloud Run (fewer standard run-level metrics/log pipelines).
- Retry logic is less ergonomic for complex partial failures.
- Local dev parity is weaker for scheduled + retry behavior.

Egress impact:
- If Edge Function needs ingest->aggdaily cross-project reads/writes, ingest response bytes are still billable Supabase egress.
- Can be low only if most heavy computation stays in-DB and outputs are tiny.

DB-size impact:
- Same final AggDaily fact-table footprint as other options.
- Risk of extra churn if retries are not tightly idempotent.

### Option B: Google Cloud Scheduler + Cloud Run service in Ops repo (Recommended)

Pros:
- Already aligns with current Ops patterns (deploy workflow, scheduler wiring, structured logging, retries).
- Strong control for idempotent recompute, backfills, and run concurrency.
- Good secrets management through GitHub -> GCP Secret Manager path already used.
- Best observability (Cloud Logging + run summaries + alert hooks).
- Easy to add manual trigger endpoint and backfill mode.

Cons:
- Higher ops surface than pure Supabase scheduling.
- Need to maintain one more worker and workflow.

Egress impact:
- Ingest-to-Cloud Run reads are billable Supabase egress.
- Keep egress low by fetching only needed windows/keys and compact payloads (avoid full raw sweeps where possible).

DB-size impact:
- Same AggDaily storage footprint as Option A/C.
- Better ability to reduce write churn with strict idempotency and targeted recompute.

### Option C: GitHub Actions scheduled workflow

Pros:
- Quick to start.
- No persistent runtime service.

Cons:
- Lower reliability for frequent 5-minute schedules and long-running backfills.
- Weaker retry/backoff semantics than service-based runtime.
- Poor fit for continuous late-data reconciliation.

Egress impact:
- Similar to Option B; often worse latency/throughput from hosted runners.

DB-size impact:
- Same destination table size.
- Potentially higher duplicate-write risk without robust run-state controls.

### Recommendation

Use **Option B (Cloud Run service in Ops repo)**.

Why:
- Best fit with current operational stack and existing Cloud Run deployment standards.
- Best control over idempotency/retries/backfills with minimal risk.
- Egress can be controlled by tight candidate-hour selection and compact query paths.
- DB-size growth is dominated by the chosen fact schema (not by runtime), so runtime should optimize correctness and write efficiency.

## 4) AQI Calculation Spec (Stations)

### 4.1 Pollutant and timeseries selection
- Use canonical observed-property codes via `observed_properties.code` and `phenomena.observed_property_id`.
- In-scope pollutant codes: `pm25`, `pm10`, `no2`.
- Ignore negative values.

### 4.2 Hourly concentration derivation and completeness

For each station/pollutant/hour (`timestamp_hour_utc`):
- Source window: `[hour, hour + 1h)`
- Compute hourly mean from raw observations in that hour.

Completeness rule:
- Require at least 75% of expected samples in the hour.
- `required_count = ceil(0.75 * expected_count)`.

Expected count handling:
- Hourly-native sources: expected `1` (must have 1 value).
- Sub-hourly sources: infer nominal cadence per timeseries (5/10/15/30/60 min), then expected `60 / cadence`.
- Examples:
  - 5-min cadence: expected 12, required 9
  - 10-min cadence: expected 6, required 5
  - 15-min cadence: expected 4, required 3

### 4.3 DAQI (hourly-stored index logic)

Per requested behavior for hourly stored indices:
- `no2`: DAQI from **hourly mean**.
- `pm25`/`pm10`: DAQI from **24h running mean ending at that hour**.

24h PM completeness:
- Compute running mean from last 24 hourly means.
- Require at least 18 valid hourly means (75%).

DAQI storage for the hour:
- Store pollutant-specific DAQI index levels independently (`daqi_no2_index_level`, `daqi_pm25_rolling24h_index_level`, `daqi_pm10_rolling24h_index_level`).
- Do not store DAQI overall/dominant fields in the base fact table.
- Do not compute or expose a combined DAQI+EAQI value.

### 4.4 EAQI

Use EAQI breakpoint rows stored in DB (current scope uses hourly thresholds for `pm25`, `pm10`, `no2` per project planning artifact).

EAQI storage for the hour:
- Store pollutant-specific EAQI index levels independently (`eaqi_no2_index_level`, `eaqi_pm25_index_level`, `eaqi_pm10_index_level`).
- Do not store EAQI overall/dominant fields in the base fact table.
- Do not compute or expose a combined DAQI+EAQI value.

### 4.5 Missing pollutants

For each station-hour:
- Compute with whichever pollutants are valid/present.
- If only a subset is available, persist only that pollutant subset for the hour.
- If none are available: store row with null pollutant index levels for that hour.

### 4.6 Breakpoint storage rule

Breakpoints must be in DB (not hardcoded in worker):
- range lookup with inclusive low and nullable open-ended high
- versioned with `valid_from`/`valid_to`

## 5) Schema Proposal (AggDaily DB)

Placement recommendation:
- Put AQI reference + fact tables in `uk_aq_aggdaily`.
- Keep `uk_aq_core` as mirrored source metadata (stations/timeseries/phenomena/connectors).

Rationale:
- AQI outputs are derived products for AggDaily use-cases.
- Keeps AggDaily self-contained for read APIs and future area-level outputs.

Naming convention (now and future AQI standards):
- Use `index_level` for numeric severity.
- Use `index_band` for grouped labels that can span one or more `index_level` values.
- Do not introduce new `rank`/`category_*` naming in AQI tables/RPCs.

### 5.1 Reference tables

```sql
-- AQI standard/version registry
create table if not exists uk_aq_aggdaily.aqi_standard_versions (
  standard_code text not null check (standard_code in ('daqi','eaqi')),
  version_code text not null,
  source_name text not null,
  source_url text,
  notes text,
  valid_from date not null,
  valid_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (standard_code, version_code)
);

-- Pollutant breakpoints (range lookup)
create table if not exists uk_aq_aggdaily.aqi_breakpoints (
  standard_code text not null,
  version_code text not null,
  pollutant_code text not null check (pollutant_code in ('pm25','pm10','no2')),
  averaging_code text not null check (averaging_code in ('hourly_mean','rolling_24h_mean')),
  index_level smallint not null,
  index_band_code text not null,
  index_band_label text not null,
  color_hex text,
  daqi_index_min smallint,
  daqi_index_max smallint,
  range_low numeric not null,
  range_high numeric,
  uom text not null default 'ug/m3',
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  primary key (standard_code, version_code, pollutant_code, averaging_code, index_level),
  foreign key (standard_code, version_code)
    references uk_aq_aggdaily.aqi_standard_versions(standard_code, version_code)
);
```

Notes:
- `range_high is null` means open-ended upper `index_band` range.
- DAQI `index_band` rows can carry `daqi_index_min/max` (e.g., 1-3, 4-6, 7-9, 10).
- `index_band` is not assumed 1:1 with `index_level`; multiple levels can map to the same band
  (for example DAQI `Low` covering levels 1-3).

### 5.2 Station hourly fact table (stations first)

```sql
create table if not exists uk_aq_aggdaily.station_aqi_hourly (
  station_id bigint not null references uk_aq_core.stations(id) on delete cascade,
  timestamp_hour_utc timestamptz not null,

  -- concentrations used
  no2_hourly_mean_ugm3 double precision,
  pm25_hourly_mean_ugm3 double precision,
  pm10_hourly_mean_ugm3 double precision,
  pm25_rolling24h_mean_ugm3 double precision,
  pm10_rolling24h_mean_ugm3 double precision,

  -- sample context
  no2_hourly_sample_count smallint,
  pm25_hourly_sample_count smallint,
  pm10_hourly_sample_count smallint,

  -- DAQI pollutant-specific
  daqi_no2_index_level smallint,
  daqi_pm25_rolling24h_index_level smallint,
  daqi_pm10_rolling24h_index_level smallint,

  -- EAQI pollutant-specific
  eaqi_no2_index_level smallint,
  eaqi_pm25_index_level smallint,
  eaqi_pm10_index_level smallint,

  -- idempotency/supporting metadata
  algorithm_version text not null,
  input_fingerprint text,
  computed_at timestamptz not null default now(),

  primary key (station_id, timestamp_hour_utc)
);

create index if not exists station_aqi_hourly_hour_idx
  on uk_aq_aggdaily.station_aqi_hourly (timestamp_hour_utc desc);

create index if not exists station_aqi_hourly_daqi_pm25_idx
  on uk_aq_aggdaily.station_aqi_hourly (daqi_pm25_rolling24h_index_level, timestamp_hour_utc desc);

create index if not exists station_aqi_hourly_eaqi_pm25_idx
  on uk_aq_aggdaily.station_aqi_hourly (eaqi_pm25_index_level, timestamp_hour_utc desc);
```

### 5.3 Optional daily rollup (recommended)

```sql
create table if not exists uk_aq_aggdaily.station_aqi_daily (
  station_id bigint not null references uk_aq_core.stations(id) on delete cascade,
  observed_day date not null,
  valid_hours smallint not null,

  -- compact fixed arrays for chart distribution
  daqi_index_level_hour_counts smallint[] not null,   -- size 10
  eaqi_index_level_hour_counts smallint[] not null,   -- size 6

  daqi_worst_index_level smallint,
  eaqi_worst_index_level smallint,
  updated_at timestamptz not null default now(),

  primary key (station_id, observed_day)
);

create index if not exists station_aqi_daily_day_idx
  on uk_aq_aggdaily.station_aqi_daily (observed_day desc);
```

### 5.4 Monthly rollup (add now)

```sql
create table if not exists uk_aq_aggdaily.station_aqi_monthly (
  station_id bigint not null references uk_aq_core.stations(id) on delete cascade,
  observed_month date not null, -- first day of month (UTC)
  valid_hours integer not null,

  -- compact fixed arrays for month-level distribution
  daqi_index_level_hour_counts integer[] not null,   -- size 10
  eaqi_index_level_hour_counts integer[] not null,   -- size 6

  daqi_worst_index_level smallint,
  eaqi_worst_index_level smallint,
  updated_at timestamptz not null default now(),

  primary key (station_id, observed_month)
);

create index if not exists station_aqi_monthly_month_idx
  on uk_aq_aggdaily.station_aqi_monthly (observed_month desc);
```

### 5.5 Ops run tables (recommended)

```sql
create table if not exists uk_aq_ops.aqi_compute_runs (
  run_id uuid primary key,
  run_mode text not null, -- fast|reconcile_short|reconcile_deep|backfill
  trigger_mode text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  cutoff_hour_utc timestamptz,
  window_from_hour_utc timestamptz,
  window_to_hour_utc timestamptz,
  candidate_station_hours integer not null default 0,
  rows_upserted integer not null default 0,
  rows_changed integer not null default 0,
  station_hours_changed integer not null default 0,
  station_hours_changed_gt_36h integer not null default 0,
  max_changed_lag_hours integer,
  deep_reconcile_effective boolean,
  errors jsonb,
  created_at timestamptz not null default now()
);
```

### 5.6 AggDaily schema convention alignment

When implementing, mirror current conventions in `uk_aq_aggdaily_schema.sql`:
- RLS enabled
- authenticated read policy and `service_role` write policy
- grants for `service_role`
- expose read RPCs/views in `uk_aq_public`

## 6) Scheduling and Late-Data Strategy

### 6.1 Delay decision: 2h vs 3h

Option S1: delay 2h
- Pros: fresher hourly index outputs.
- Cons: more late-arrival corrections and write churn.
- Egress/DB impact: higher repeated recomputation traffic.

Option S2 (Recommended): delay 3h
- Pros: materially fewer corrections from late data, more stable hourly rows.
- Cons: extra 1 hour latency for finalized hourly index outputs.
- Egress/DB impact: lower correction churn and lower repeated update volume.

Recommendation: **3-hour delay**.

### 6.2 Recommended cadence

Use Cloud Scheduler with three modes:
- Fast loop: every 5 minutes
  - compute hour `H = date_trunc('hour', now_utc - interval '3 hours')`
  - upsert station-hour results for H
- Reconcile loop: every 2 hours
  - recompute last 36 mature hours (`[H-35h, H]`) idempotently
- Deep reconcile loop: daily (off-peak)
  - recompute last 14 days idempotently

This avoids dependence on missing `observations.updated_at`, while still catching late data.

### 6.3 Idempotency

- Primary key upsert on `(station_id, timestamp_hour_utc)`.
- Recompute full row for each targeted station-hour (no additive increments).
- Use `input_fingerprint` and update only when changed where practical.

### 6.4 Retry/failure handling

Runtime retries:
- Cloud Scheduler retry limited (e.g., 0-1) to avoid overlap storms.
- Worker internal retries for transient HTTP/RPC failures (429/5xx with backoff).

Data retries:
- Failed runs are safe to rerun because writes are idempotent upserts.
- Persist run summaries in `uk_aq_ops.aqi_compute_runs`.

### 6.5 Backfill strategy

Backfill endpoint parameters:
- `from_hour_utc`, `to_hour_utc`, optional station filter, chunk size.

Rules:
- Process in deterministic hour chunks.
- Recompute and upsert (no double count risk).
- Emit per-chunk run metrics.

### 6.6 Deep-Reconcile Necessity Telemetry (Recommended)

Goal:
- Measure whether deep reconcile is actually correcting meaningful late data.

What to record per run (in `uk_aq_ops.aqi_compute_runs`):
- `run_mode` (`reconcile_deep` identifies deep runs)
- `rows_changed`
- `station_hours_changed`
- `station_hours_changed_gt_36h` (changed rows older than short-reconcile window)
- `max_changed_lag_hours`
- `deep_reconcile_effective` (`true` when `station_hours_changed_gt_36h > 0`)

How to decide if deep reconcile is needed:
- Run deep reconcile daily for an initial 7-day observation window.
- Review:
  - number of deep runs where `deep_reconcile_effective = true`
  - total `station_hours_changed_gt_36h`
  - max observed lag (`max_changed_lag_hours`)
- If deep runs almost never produce >36h corrections, either:
  - disable deep reconcile, or
  - reduce to weekly.
- Current decision: keep deep reconcile daily for now and review DB size trend.

Example summary query:

```sql
select
  date_trunc('day', started_at) as run_day,
  count(*) filter (where run_mode = 'reconcile_deep') as deep_runs,
  count(*) filter (where run_mode = 'reconcile_deep' and deep_reconcile_effective) as deep_effective_runs,
  coalesce(sum(station_hours_changed_gt_36h) filter (where run_mode = 'reconcile_deep'), 0) as changed_gt_36h,
  max(max_changed_lag_hours) filter (where run_mode = 'reconcile_deep') as max_lag_hours
from uk_aq_ops.aqi_compute_runs
where started_at >= now() - interval '7 days'
group by 1
order by 1 desc;
```

## 7) Stations-First Aggregation Logic (Exact Steps)

For each targeted hour bucket:
1. Resolve station-timeseries mappings for `pm25`, `pm10`, `no2`.
2. Pull raw observations needed for:
   - target hour hourly means
   - trailing 24h hourly means for PM running means
3. Build pollutant hourly means per station/hour with 75% capture checks.
4. Build PM 24h running means with `>=18` valid hourly means.
5. Lookup DAQI/EAQI breakpoints from DB reference tables.
6. Compute pollutant-specific DAQI/EAQI index levels for each pollutant present.
7. Persist null index levels where pollutant data is missing or incomplete.
8. Upsert `uk_aq_aggdaily.station_aqi_hourly`.
9. Refresh `uk_aq_aggdaily.station_aqi_daily` for affected station-days.

## 8) PCON / LA / Region Extension Plan (Plan Only)

### 8.1 Mapping

Use mirrored station fields in AggDaily `uk_aq_core.stations`:
- `pcon_code`, `la_code`, `region`

No new mapping table required initially unless versioned boundary history needs stricter modeling.

### 8.2 Area concentration aggregation method

Options:
- Mean: simple but sensitive to outliers.
- Worst-station: conservative but can overstate broad-area exposure.
- Median (Recommended): robust, aligns with existing PM area view style already used in project.

Recommendation:
- Compute area pollutant concentration from **median station concentration**.
- Also store `area_max_station_concentration`, `area_max_station_index_level`, and
  `station_count` for transparency.
- Definition: `area_max_station_concentration` is the max concentration for that
  pollutant/hour across all stations in that area (not per-station max over time).
- Definition: `area_max_station_index_level` is the highest pollutant `index_level`
  observed among stations in that area for that same pollutant/hour.

### 8.3 Derivation approach

Recommended:
- Derive area-level from stored `station_aqi_hourly` concentrations/index levels (not directly from raw observations).

Why:
- Reuses station completeness logic once.
- Lower compute duplication and lower ingest-query egress.
- Cleaner explainability.

## 9) Performance, DB Size, and Egress

### 9.1 Row volume estimates

Station-hour rows per year:
- formula: `N_stations * 24 * 365 = N_stations * 8760`

Scenarios:
- 2,000 stations: 17.52M rows/year
- 5,000 stations: 43.80M rows/year
- 10,000 stations: 87.60M rows/year

Order-of-magnitude storage for `station_aqi_hourly`:
- ~4-6 GB/year (2k stations)
- ~10-14 GB/year (5k stations)
- ~20-28 GB/year (10k stations)

(Assumes compact fixed columns + indexes; exact depends on fillfactor/vacuum/churn.)

Area entities (future) rough volume:
- PCON+LA+Region ~1,036 entities -> ~9.1M rows/year -> ~2-3 GB/year

### 9.2 Index and partition strategy

- Start with monthly range partitioning on `timestamp_hour_utc` for `station_aqi_hourly`.
- Keep PK + hour index + limited `index_level` indexes.
- Avoid JSONB-heavy payload columns in hot fact tables.

### 9.3 Website response egress strategy (endpoint response egress)

Use compact RPCs:
- Last 24h bars: return hour axis + compact `index_level` arrays.
- Last 30d bars: hourly compact arrays, optionally downsampled by client request (but do not drop stored granularity).
- Last 365d: serve from daily rollup table.
- Multi-year views: serve from monthly rollup table.

Suggested endpoint response sizes (gzipped, per station):
- 24h: ~1-4 KB
- 30d (hourly 720 points): ~15-40 KB
- 365d (daily rollup 365 points): ~8-25 KB

Note on metrics:
- Track endpoint response egress separately from write/upload payload metrics per project policy.

### 9.4 AggDaily Cold Storage

- AggDaily AQI outputs are derivable/recomputable, so R2 cold storage is not required now.
- Keep retention in AggDaily for now and monitor DB size growth.
- If later needed, add optional AggDaily export/archival to R2 by extending Prune Phase B patterns.

## 10) Stations-First Implementation Plan (File Paths)

### Schema repo changes
- Modify:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/aggdaily_db/uk_aq_aggdaily_schema.sql`
- Add migration:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/migrations/<date>_aqi_station_hourly_aggdaily.sql`
- Optional ingest helper RPC migration (if needed for compact source reads):
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/migrations/<date>_aqi_source_rpcs_ingest.sql`
- Docs:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/system_docs/schema-overview.md`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/system_docs/table_info/uk_aq_aqi_breakpoints.md`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/system_docs/table_info/uk_aq_station_aqi_hourly.md`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/system_docs/table_info/uk_aq_station_aqi_daily.md`

### Ops repo changes
- Add worker:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/workers/uk_aq_aqi_station_aggdaily_cloud_run/run_job.ts`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/workers/uk_aq_aqi_station_aggdaily_cloud_run/run_service.ts`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/workers/uk_aq_aqi_station_aggdaily_cloud_run/README.md`
- Add deploy workflow:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_aqi_station_aggdaily_cloud_run_deploy.yml`
- Update env target map:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv`
- Update repo docs:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/README.md`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/system_docs/setup/<new aqi service setup doc>.md`

### Ingest repo changes (only if needed)
- If ingest-side read RPC helper is introduced, update docs:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_edge_functions.md`
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_scripts.md` (only if scripts are added)

## 11) Testing Plan

### Unit tests (worker)
- Breakpoint lookup boundary tests (exact low/high, open upper bound).
- Completeness threshold tests (hourly/sub-hourly cadences).
- PM 24h running mean + `>=18` valid-hour tests.
- Pollutant-specific `index_level` correctness tests (including missing-pollutant scenarios).
- Idempotent row rebuild tests (same input -> same fingerprint).

### Integration tests
- Staging DB run over known 48h window for sample stations from mixed connectors.
- Re-run same window twice: verify no duplicate keys and stable outputs.
- Inject late observations and verify reconcile loop updates affected hours.
- Validate daily rollup counts vs hourly fact truth table.

### Operational tests
- Scheduler-triggered run success.
- Manual `/run` trigger success.
- Retry behavior for simulated transient RPC failures.
- Backfill mode over bounded date range.

## 12) Ops Observability Plan

Emit structured JSON logs with:
- `run_id`, `run_mode`, `trigger_mode`, `cutoff_hour_utc`, `window_start/end`, `candidate_station_hours`
- `rows_upserted`, `rows_changed`, `duration_ms`
- `station_hours_changed`, `station_hours_changed_gt_36h`, `max_changed_lag_hours`, `deep_reconcile_effective`
- `error_count`, sampled error payloads

Persist run summaries in `uk_aq_ops.aqi_compute_runs` for dashboarding/alerting.

Recommended alerts:
- no successful run in >20 minutes
- latest completed hour lag >4 hours
- repeated non-zero error runs

## 13) Decision Checklist for Michael (Confirm Before Implementation)

1. Runtime location: confirm Cloud Run service in Ops repo.
2. DAQI PM metric: confirm 24h running mean for hourly-stored DAQI `index_level`/`index_band`.
3. EAQI metric basis: confirm hourly thresholds for PM/NO2 in this phase.
4. Delay setting: confirm 3-hour maturity delay.
5. Reconcile windows: confirm every 2h for last 36h + daily last 14d, with 7-day telemetry review while keeping deep reconcile daily for now.
6. Completeness logic: confirm 75% hourly capture and PM 24h `>=18` valid hours.
7. Missing pollutant behavior: confirm pollutant-specific storage only (missing/incomplete pollutant => null `index_level`).
8. DAQI/EAQI presentation: confirm they remain separate in storage and APIs (no combined DAQI+EAQI value).
9. Storage shape: confirm single station-hour row with pollutant-specific DAQI/EAQI fields only.
10. Rollups: confirm adding `station_aqi_daily` and `station_aqi_monthly` now for fast APIs.
11. Area aggregation method (next phase): confirm median as default, with station count + `area_max_station_concentration` + `area_max_station_index_level`.
12. Threshold governance: confirm canonical breakpoint table lives in `uk_aq_aggdaily` with versioning and validity dates.
13. Retention policy: confirm station AQI hourly rows are retained indefinitely for now; AggDaily R2 cold storage can be added later via Phase B-style archival if needed.
