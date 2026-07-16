# UK-AQ DB Cutover Workflow Dispatch Commands

Purpose:
- Re-run the GitHub Actions deploy workflows that propagate updated Supabase ingest/obs_aqidb connection config into Supabase Edge, Cloud Run, Workers, and GCP Secret Manager.
- Use this after updating local `.env` / `.env.supabase` and syncing GitHub vars/secrets.



## 1) Sync GitHub vars/secrets from local env files

From ingest repo:

```bash
./scripts/uk_aq_sync_github_secrets.sh \
  \
  --env-file .env \
  --targets-file config/uk_aq_github_env_targets.csv
```

From ops repo:

```bash
cd "../CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops"
./scripts/uk_aq_sync_github_secrets.sh \
  \
  --env-file .env \
  --targets-file config/uk_aq_github_env_targets.csv
cd -
```

## 2) Dispatch ingest workflows (DB-dependent runtimes)

```bash
for wf in \
  uk_aq_validate_github_env_targets.yml \
  supabase_edge_deploy.yml \
  uk_aq_observs_edge_deploy.yml \
  uk_aq_ingest_poller_deploy.yml \
  uk_aq_observs_pubsub_cloud_run_deploy.yml \
  uk_aq_blondon_communities_cloud_run_deploy.yml \
  uk_aq_sos_cloud_run_deploy.yml \
  uk_aq_openaq_cloud_run_deploy.yml \
  uk_aq_scomm_cloud_run_deploy.yml
do
  echo "Running $wf"
  gh workflow run "$wf" --ref main || echo "FAILED: $wf"
done
```

## 3) Dispatch ops workflows (DB-dependent runtimes)

```bash
for wf in \
  uk_aq_cache_proxy_deploy.yml \
  uk_aq_db_r2_metrics_api_worker_deploy.yml \
  uk_aq_aqi_history_r2_api_worker_deploy.yml \
  uk_aq_latest_snapshot_cloud_run_deploy.yml \
  uk_aq_db_size_logger_cloud_run_deploy.yml \
  uk_aq_prune_daily_cloud_run_deploy.yml \
  uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml \
  uk_aq_aqilevels_retention_cloud_run_deploy.yml \
  uk_aq_observs_partition_maintenance_cloud_run_deploy.yml \
  uk_aq_supabase_db_dump_backup_service_deploy.yml
do
  echo "Running $wf"
  gh workflow run "$wf" --ref main || echo "FAILED: $wf"
done
```

## 4) Monitor run status

```bash
gh run list --limit 20
gh run list --limit 20
```

Notes:
- These workflows include the GCP Secret Manager upsert/update steps where applicable, so this sequence covers both GH and GCP propagation.
- If a workflow is intentionally not used in your environment, skip it.
