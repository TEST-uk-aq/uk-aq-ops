# UK-AQ station history Worker

`uk-aq-station-history` is a private Service Binding Worker. It has no public route; `uk-aq-cache-proxy` retains browser authentication, CORS, bypass authorization, and public cache ownership.

## Station-series source policy

`GET /v1/station-series` resolves the authoritative timeseries identity before reading data. It performs exactly one logical recent observation read directly from ObsAQIDB through `uk_aq_public.rpc/uk_aq_timeseries_rpc`, using the smallest supported RPC window that covers the required source interval. A required interval beyond the RPC's 30-day maximum is marked incomplete rather than treated as direct-source coverage. It never calls the stitched public `uk_aq_timeseries` Edge Function.

A request uses ingest-only mode only when the direct response covers the complete requested output, the requested end, and any PM 23-hour AQI context. Otherwise the same direct result is reused with bounded R2 sources:

- R2 AQI is authoritative over live AQI for the same canonical hour.
- R2 observations are authoritative over direct ObsAQIDB observations for the same exact timestamp within the configured 1–3 hour overlap.
- Live AQI is calculated only for R2-missing eligible hours, using the shared AQI library.
- AQI and observation historical boundaries and completeness states remain independent.

Partial or gap-bearing responses use `Cache-Control: no-store`. Diagnostics report counts, boundaries, RPC window/HTTP attempt metadata, completeness, and overlap/mismatch totals but never observation values.

## Configuration

Required data-path values:

- `SUPABASE_URL` and `SB_SECRET_KEY` for authoritative identity lookup.
- `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY` for direct recent observations.
- `UK_AQ_AQI_HISTORY_R2_API_URL`, `UK_AQ_OBSERVS_HISTORY_R2_API_URL`, and `UK_AQ_EDGE_UPSTREAM_SECRET` for R2 fallback/history.
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`) and `INGESTDB_RETENTION_DAYS` (default `5`).

Optional TEST tuning uses safe in-code defaults when absent:

- `UK_AQ_STATION_HISTORY_STABLE_AQI_HEAD_MAX_HOURS` (`168`).
- `UK_AQ_STATION_HISTORY_AQI_CHUNK_MAX_HOURS` (`744`).
- `UK_AQ_STATION_HISTORY_OBSERVATION_CHUNK_MAX_HOURS` (`168`).
- `UK_AQ_STATION_HISTORY_OBSERVATION_OVERLAP_HOURS` (`2`, validated to `1`–`3`).
- `UK_AQ_STATION_HISTORY_OBSAQIDB_TIMEOUT_MS` (`10000`).
