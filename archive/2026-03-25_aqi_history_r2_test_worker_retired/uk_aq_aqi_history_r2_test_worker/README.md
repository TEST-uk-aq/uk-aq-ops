# UK AQ AQI History R2 Test Worker

Cloudflare Worker for the AQI history R2/cache test harness.

Routes:

- `GET /v1/aqi-history/manifest`
- `GET /v1/aqi-history/data`
- `GET /v1/aqi-history/supabase-data`
- aliases: `GET /manifest`, `GET /data`, `GET /v1/aqi-history`, `GET /`

Query params:

- `scope` (`station|pcon|la|region`)
- `grain` (`hourly|daily|monthly`)
- `entity` or `entity_id`
- `v` optional cache-buster token
- `prefix` optional R2 prefix override
- `row_limit` optional (`1..20000`, default `5000`)

`supabase-data` query params:

- `entity` or `entity_id` or `station_id`
- `from_utc` / `to_utc` (ISO, optional)
- `row_limit` optional (`1..20000`, default `5000`)

R2 paths expected:

- `${AQI_R2_TEST_PREFIX}/manifest.json`
- `${AQI_R2_TEST_PREFIX}/{scope}/{grain}/{entity}.parquet`

Response notes:

- returns chart-friendly JSON
- adds `x-ukaq-cache: HIT|MISS`
- adds `Server-Timing` header

Required Worker secrets for `supabase-data`:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Deploy (manual)

```bash
cd workers/uk_aq_aqi_history_r2_test_worker
wrangler deploy
```
