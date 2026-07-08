# UK AQ WHO 2021 Daily Cloud Run

Calculates private WHO 2021 derived status rows in Obs AQI DB.

Current scope is daily plus Phase 3 summaries and opt-in Phase 4 R2 publication:

- reads Obs AQI DB observations through service-role RPCs;
- calculates/upserts `uk_aq_ops.who_2021_daily_status`;
- checks final-hour source readiness before scheduled publication runs;
- calculates/upserts `uk_aq_ops.who_2021_rolling_year_status`;
- calculates/upserts last complete-year rows in
  `uk_aq_ops.who_2021_calendar_year_status`;
- builds the 9-row homepage summary JSON in the run ledger;
- can publish WHO summary JSON and parquet R2 write RPC output when Phase 4
  publication is explicitly enabled;
- records `uk_aq_ops.who_2021_processing_runs`;

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
- `dry_run`: calculates counts without upserting daily or summary status rows.

The daily window is hour-ending: each `day_utc` covers
`(day 00:00, next day 00:00]`, so a GOV.UK AURN daily mean uses `01:00` through
next-day `00:00` UTC/GMT.

Scheduled `daily` runs use a readiness gate before writing latest summaries. If
the expected final hour-ending timestamp is not present for enough eligible
timeseries per pollutant, the service logs a deferred no-op and exits
successfully. The intended scheduler pattern is hourly calls during a bounded
morning window, for example `0 4-9 * * *` UTC.

## Required Environment

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Settings

- `UK_AQ_PUBLIC_SCHEMA` default `uk_aq_public`
- `UK_AQ_WHO_2021_DAILY_REFRESH_RPC` default
  `uk_aq_rpc_who_2021_daily_status_refresh`
- `UK_AQ_WHO_2021_READINESS_RPC` default `uk_aq_rpc_who_2021_readiness_check`
- `UK_AQ_WHO_2021_SUMMARY_REFRESH_RPC` default
  `uk_aq_rpc_who_2021_summary_refresh`
- `UK_AQ_WHO_2021_RUN_LOG_RPC` default `uk_aq_rpc_who_2021_processing_run_log`
- `UK_AQ_WHO_2021_SOURCE_NETWORK_CODE` default `gov_uk_aurn`
- `UK_AQ_WHO_2021_CONNECTOR_ID` default `1`
- `UK_AQ_WHO_2021_POLLUTANT_CODES` default `pm25,pm10,no2`
- `UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY` default `18`
- `UK_AQ_WHO_2021_MIN_VALID_DAYS` default `274`
- `UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO` default `0.9`
- `UK_AQ_WHO_2021_READINESS_GATE_ENABLED` default `true`
- `UK_AQ_WHO_2021_SUMMARY_REFRESH_ENABLED` default `true`
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

## Phase 4 R2 publication

Phase 4 publication is opt-in so existing daily/summary runs remain unchanged
until the R2 settings and parquet R2 write RPC are applied.

Set `UK_AQ_WHO_2021_R2_PUBLISH_ENABLED=true` to publish the dated summary JSON
and `history/v2/who_2021/latest_who_2021.json` after daily, rolling and calendar
refreshes complete. Set `UK_AQ_WHO_2021_PARQUET_R2_WRITE_ENABLED=true` to call
`uk_aq_rpc_who_2021_r2_parquet_export` and upload the returned parquet parts
before the JSON latest pointer is replaced.

Required R2 environment variables are `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` (`CFLARE_R2_*` aliases are
also accepted). `R2_REGION` defaults to `auto`.

If R2 publication is enabled and the readiness gate reports the day is already
complete, the service still refreshes the summary payload and attempts R2
publication. That keeps first enablement and R2 retry runs from being skipped
just because the database calculation already completed.

Published JSON paths:

- `history/v2/who_2021/summaries/as_of_day_utc=YYYY-MM-DD/who_2021_summary.json`
- `history/v2/who_2021/latest_who_2021.json`

Parquet archive object keys are produced by the parquet R2 write RPC
`uk_aq_rpc_who_2021_r2_parquet_export`; that RPC is responsible for enforcing
the agreed `history/v2/who_2021/...` parquet partition paths. The TypeScript
path planner records expected prefixes for summary/debug metadata.

The website should use the stable daily cache key
`history/v2/who_2021/latest_who_2021.json?as_of=YYYY-MM-DD`, where the `as_of`
value is the expected latest complete UTC/GMT day.

Public summary JSON is serialized with stable key ordering. The current
publisher still writes the dated and latest JSON objects on each publication
attempt; object-level skip-if-unchanged is not implemented yet.
