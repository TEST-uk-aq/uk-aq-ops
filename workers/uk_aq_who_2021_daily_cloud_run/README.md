# UK AQ WHO 2021 Daily Cloud Run

Calculates private WHO 2021 daily guideline status rows in Obs AQI DB.

Phase 2 scope is daily status only:

- reads Obs AQI DB observations through service-role RPCs;
- calculates/upserts `uk_aq_ops.who_2021_daily_status`;
- records `uk_aq_ops.who_2021_processing_runs`;
- does not publish R2 parquet/JSON;
- does not update rolling-year or calendar-year summary tables.

## Endpoints

- `GET /` or `GET /health`: health
- `POST /` or `POST /run`: run one bounded calculation

`POST /run` body, all optional except backfill dates:

```json
{
  "trigger_mode": "scheduler",
  "run_mode": "daily",
  "start_day_utc": "2026-07-02",
  "end_day_utc": "2026-07-02",
  "connector_id": 1,
  "source_network_code": "gov_uk_aurn",
  "pollutant_codes": ["pm25", "pm10", "no2"]
}
```

## Run Modes

- `daily`: calculates the latest complete day plus configurable lookback.
- `backfill`: requires `start_day_utc` and `end_day_utc`.
- `dry_run`: calculates counts without upserting daily status rows.

The daily window is hour-ending: each `day_utc` covers `(day 00:00, next day 00:00]`, so a GOV.UK AURN daily mean uses `01:00` through next-day `00:00` UTC/GMT.

## Required Environment

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Settings

- `UK_AQ_PUBLIC_SCHEMA` default `uk_aq_public`
- `UK_AQ_WHO_2021_DAILY_REFRESH_RPC` default `uk_aq_rpc_who_2021_daily_status_refresh`
- `UK_AQ_WHO_2021_RUN_LOG_RPC` default `uk_aq_rpc_who_2021_processing_run_log`
- `UK_AQ_WHO_2021_SOURCE_NETWORK_CODE` default `gov_uk_aurn`
- `UK_AQ_WHO_2021_CONNECTOR_ID` default `1`
- `UK_AQ_WHO_2021_POLLUTANT_CODES` default `pm25,pm10,no2`
- `UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY` default `18`
- `UK_AQ_WHO_2021_DAILY_LOOKBACK_DAYS` default `2`
- `UK_AQ_WHO_2021_MATURITY_DELAY_HOURS` default `3`
- `UK_AQ_WHO_2021_CHUNK_DAYS` default `31`
- `UK_AQ_WHO_2021_RPC_RETRIES` default `3`

Backfill overrides:

- `UK_AQ_WHO_2021_RUN_MODE=backfill`
- `UK_AQ_WHO_2021_START_DAY_UTC=YYYY-MM-DD`
- `UK_AQ_WHO_2021_END_DAY_UTC=YYYY-MM-DD`

## Manual Local Validation

Dry-run one day without writing rows:

```bash
OBS_AQIDB_SUPABASE_URL="https://PROJECT.supabase.co" \
OBS_AQIDB_SECRET_KEY="..." \
UK_AQ_WHO_2021_RUN_MODE=dry_run \
UK_AQ_WHO_2021_START_DAY_UTC=2026-07-02 \
UK_AQ_WHO_2021_END_DAY_UTC=2026-07-02 \
deno run --allow-env --allow-net workers/uk_aq_who_2021_daily_cloud_run/run_job.ts
```
