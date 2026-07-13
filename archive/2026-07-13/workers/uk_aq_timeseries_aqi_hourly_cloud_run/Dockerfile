FROM denoland/deno:2.2.3

WORKDIR /app

COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts
COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts
COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/station_fk_guard.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/station_fk_guard.ts
COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/reconcile_deep_refresh.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/reconcile_deep_refresh.ts
COPY workers/shared/dropbox_error_log.ts /app/workers/shared/dropbox_error_log.ts
COPY lib/aqi/aqi_levels.mjs /app/lib/aqi/aqi_levels.mjs

EXPOSE 8080

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts"]
