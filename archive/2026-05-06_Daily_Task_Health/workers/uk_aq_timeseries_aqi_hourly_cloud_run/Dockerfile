FROM denoland/deno:2.2.3

WORKDIR /app

COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts
COPY workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts /app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts"]
