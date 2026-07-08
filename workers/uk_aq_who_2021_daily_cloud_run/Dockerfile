FROM denoland/deno:2.2.3

WORKDIR /app

COPY workers/uk_aq_who_2021_daily_cloud_run/who_2021_daily_core.ts /app/workers/uk_aq_who_2021_daily_cloud_run/who_2021_daily_core.ts
COPY workers/uk_aq_who_2021_daily_cloud_run/who_2021_parquet.ts /app/workers/uk_aq_who_2021_daily_cloud_run/who_2021_parquet.ts
COPY workers/uk_aq_who_2021_daily_cloud_run/run_job.ts /app/workers/uk_aq_who_2021_daily_cloud_run/run_job.ts
COPY workers/uk_aq_who_2021_daily_cloud_run/run_service.ts /app/workers/uk_aq_who_2021_daily_cloud_run/run_service.ts

RUN deno cache /app/workers/uk_aq_who_2021_daily_cloud_run/run_service.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_who_2021_daily_cloud_run/run_service.ts"]
