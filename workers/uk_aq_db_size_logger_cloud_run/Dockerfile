FROM denoland/deno:2.1.4

WORKDIR /app

COPY workers/uk_aq_db_size_logger_cloud_run/run_job.ts /app/workers/uk_aq_db_size_logger_cloud_run/run_job.ts
COPY workers/uk_aq_db_size_logger_cloud_run/run_service.ts /app/workers/uk_aq_db_size_logger_cloud_run/run_service.ts
COPY workers/shared/r2_sigv4.mjs /app/workers/shared/r2_sigv4.mjs

ENV PORT=8000

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_db_size_logger_cloud_run/run_service.ts"]
