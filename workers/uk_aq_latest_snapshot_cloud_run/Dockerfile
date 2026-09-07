FROM denoland/deno:2.7.13

WORKDIR /app

COPY workers/uk_aq_latest_snapshot_cloud_run/run_job.ts /app/workers/uk_aq_latest_snapshot_cloud_run/run_job.ts
COPY workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts /app/workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts
COPY workers/uk_aq_latest_snapshot_cloud_run/run_service.ts /app/workers/uk_aq_latest_snapshot_cloud_run/run_service.ts
COPY workers/uk_aq_latest_snapshot_cloud_run/service_core.ts /app/workers/uk_aq_latest_snapshot_cloud_run/service_core.ts
COPY workers/uk_aq_latest_snapshot_cloud_run/latest_value_policy.mjs /app/workers/uk_aq_latest_snapshot_cloud_run/latest_value_policy.mjs
COPY workers/uk_aq_latest_snapshot_cloud_run/latest_state_core.mjs /app/workers/uk_aq_latest_snapshot_cloud_run/latest_state_core.mjs
COPY workers/shared/r2_sigv4.mjs /app/workers/shared/r2_sigv4.mjs

COPY workers/shared/uk_aq_observation_history_generation.mjs /app/workers/shared/uk_aq_observation_history_generation.mjs
COPY workers/shared/uk_aq_r2_history_version.mjs /app/workers/shared/uk_aq_r2_history_version.mjs

ENV PORT=8000

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_latest_snapshot_cloud_run/run_service.ts"]
