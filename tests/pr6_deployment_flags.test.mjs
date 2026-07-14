import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('PR6 deployment workflows pass AQI cutover flags with rollback-safe defaults', () => {
  const prune = readFileSync('.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml', 'utf8');
  assert.match(prune, /UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED: \$\{\{ vars\.UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED \|\| 'false' \}\}/);
  assert.match(prune, /UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED: \$\{\{ vars\.UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED \|\| 'true' \}\}/);
  assert.match(prune, /UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS: \$\{\{ vars\.UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS \|\| '250000' \}\}/);
  assert.match(prune, /env_updates\+\=\("UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=/);
  assert.match(prune, /env_updates\+\=\("UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=/);

  const worker = readFileSync('.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml', 'utf8');
  assert.match(worker, /UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED: \$\{\{ vars\.UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED \|\| 'false' \}\}/);
  assert.match(worker, /UK_AQ_OBSERVS_HISTORY_R2_API_URL: \$\{\{ vars\.UK_AQ_OBSERVS_HISTORY_R2_API_URL \|\| '' \}\}/);
  assert.match(worker, /UK_AQ_OBSERVS_HISTORY_R2_API_URL is required when UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true/);
  assert.match(worker, /"UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED": os\.environ\["UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED"\]/);
  assert.match(worker, /"UK_AQ_OBSERVS_HISTORY_R2_API_URL": os\.environ\["UK_AQ_OBSERVS_HISTORY_R2_API_URL"\]/);

  const wrangler = readFileSync('workers/uk_aq_aqi_history_r2_api_worker/wrangler.toml', 'utf8');
  assert.match(wrangler, /UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED = "false"/);
  assert.match(wrangler, /UK_AQ_OBSERVS_HISTORY_R2_API_URL = ""/);
  const targets = readFileSync('config/uk_aq_github_env_targets.csv', 'utf8');
  assert.match(targets, /UK_AQ_OBSERVS_HISTORY_R2_API_URL,variable/);
});
