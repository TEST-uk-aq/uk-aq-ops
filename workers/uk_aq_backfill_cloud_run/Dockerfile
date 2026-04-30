FROM denoland/deno:2.2.3

WORKDIR /app

COPY package.json package-lock.json /app/
RUN deno install --no-lock

COPY workers/shared/r2_sigv4.mjs /app/workers/shared/r2_sigv4.mjs
COPY workers/uk_aq_backfill_cloud_run/backfill_core.mjs /app/workers/uk_aq_backfill_cloud_run/backfill_core.mjs
COPY workers/uk_aq_backfill_cloud_run/run_job.ts /app/workers/uk_aq_backfill_cloud_run/run_job.ts
COPY workers/uk_aq_backfill_cloud_run/run_service.ts /app/workers/uk_aq_backfill_cloud_run/run_service.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_backfill_cloud_run/run_service.ts"]
