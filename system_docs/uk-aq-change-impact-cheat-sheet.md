# UK AQ Change Impact Cheat Sheet

Last updated: 2026-04-23

Use this when deciding **what to touch, in which repo, and in what order**.

## Golden Order (Default)

1. Update canonical SQL in `CIC-test-uk-aq-schema` first (if schema/RPC/view shape changes).
2. Update runtime code in `CIC-test-uk-aq-ingest` and/or `CIC-test-uk-aq-ops`.
3. Update UI consumers in `CIC-test-uk-aq` (if response shape or params changed).
4. Update docs in affected repos (`system_docs/`).
5. Verify deploy workflows still cover changed functions/workers.

## Quick Routing: What Changed?

- Edge Function response/logic -> start in `CIC-test-uk-aq-ingest/supabase/functions/`.
- Cloud Run or R2/history ops logic -> start in `CIC-test-uk-aq-ops/workers/`.
- Table/view/RPC definitions -> start in `CIC-test-uk-aq-schema/schemas/`.
- Frontend behavior or polling -> start in `CIC-test-uk-aq/*.html`.
- Population overlay/function -> start in `CIC-Test-uk-population-ingest/`.

## Impact Playbooks

### A) If you change `uk_aq_timeseries` (Edge Function)

1. **Ingest repo**: update `supabase/functions/uk_aq_timeseries/index.ts`.
2. **Schema repo (if SQL contract changed)**:
   - `schemas/ingest_db/uk_aq_rpc.sql` (RPC definitions used by function)
   - `schemas/ingest_db/uk_aq_public_views.sql` (if read views changed)
   - related core/raw schema files if underlying columns changed
3. **Ops repo (if fallback/history path changed)**:
   - `workers/uk_aq_observs_history_r2_api_worker/worker.mjs` (obs history path)
   - `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` (AQI history path, if DAQI/EAQI path affected)
4. **Web repo**:
   - `index.html`
   - `uk_aq_stations_chart.html`
   - any test pages that call timeseries/history endpoints
5. **Workflow check**:
   - `CIC-test-uk-aq-ingest/.github/workflows/supabase_edge_deploy.yml`
   - `CIC-test-uk-aq-ops/.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` (if worker changed)
   - `CIC-test-uk-aq-ops/.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml` (if worker changed)
6. **Docs**:
   - ingest `system_docs/` page for affected function
   - ops `system_docs/uk-aq-aqi-history-r2-api-worker.md` or `uk-aq-r2-history-layout.md` if relevant

### B) If you change `uk_aq_latest`, `uk_aq_stations`, `uk_aq_stations_chart`, `uk_aq_pcon_hex`, or `uk_aq_la_hex`

1. **Ingest repo**: edit function in `supabase/functions/<function>/index.ts`.
2. **Schema repo**: update `schemas/ingest_db/uk_aq_public_views.sql` and/or `uk_aq_rpc.sql` if SQL contract changed.
3. **Web repo**: update callers in `uk_aq_hex_map.html`, `index.html`, `uk_aq_stations_chart.html` as needed.
4. **Ops repo**: update `workers/uk_aq_cache_proxy/src/index.ts` if route behavior/auth/cache strategy changed.
5. **Workflow check**:
   - ingest `supabase_edge_deploy.yml`
   - ops `uk_aq_cache_proxy_deploy.yml` (if cache proxy changed)

### C) If you change ingest connectors (`ingest_sos`, `ingest_openaq`, `ingest_breathelondon`, `ingest_erg_laqn`, `ingest_sensorcommunity`)

1. **Ingest repo**:
   - edge function: `supabase/functions/ingest_<source>/index.ts`
   - script: `scripts/<source>/<source>_ingest.py` (or `scripts/gov_uk_waqn/gov_uk_waqn_ingest.py`)
2. **Schema repo**:
   - `schemas/ingest_db/uk_aq_core_schema.sql`
   - `schemas/ingest_db/uk_aq_raw_schema.sql`
   - `schemas/ingest_db/uk_aq_rpc.sql`
3. **Ops repo (if downstream parity/prune/backup behavior impacted)**:
   - `workers/uk_aq_prune_daily/server.mjs`
   - `workers/uk_aq_observs_outbox_flush_service/server.mjs`
   - `workers/uk_aq_observs_partition_maintenance_service/server.mjs`
4. **Workflow check**:
   - ingest deploy workflow for that connector cloud run
   - ingest `supabase_edge_deploy.yml` if edge function changed

### D) If you change obs/aqi history model or retention

1. **Schema repo first**:
   - `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`
   - `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`
   - add/update migration in `schemas/migrations/` if needed
2. **Ops repo**:
   - `workers/uk_aq_observs_partition_maintenance_service/server.mjs`
   - `workers/uk_aq_aqilevels_retention_service/server.mjs`
   - `workers/uk_aq_prune_daily/server.mjs`
   - `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
   - `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
3. **Ingest repo**: update read/write callers if RPC/table signatures changed.
4. **Workflow check**: all touched ops worker deploy workflows.
5. **Docs**:
   - ops `system_docs/uk-aq-r2-history-layout.md`
   - ops service runbooks for touched workers
   - ingest docs if API behavior changed

### E) If you change dispatcher/poll cadence logic

1. **Ingest repo**:
   - `supabase/functions/uk_aq_dispatch_polls/index.ts`
   - `supabase/functions/ingest_*/index.ts` when invocation contract changes
2. **Schema repo**: update scheduler helper SQL/RPC definitions if applicable.
3. **Workflow check**:
   - `CIC-test-uk-aq-ingest/.github/workflows/uk_aq_dispatcher_deploy.yml`
   - any scheduled workflow invoking polling paths
4. **Policy check**: website polling requirement remains at 1 minute minimum for relevant paths.

### F) If you change cache/auth boundary for website AQ routes

1. **Ops repo**: `workers/uk_aq_cache_proxy/src/index.ts`.
2. **Web repo**:
   - `index.html`
   - `uk_aq_stations_chart.html`
   - `uk_aq_hex_map.html`
3. **Ingest repo**: confirm upstream edge function headers/behavior still match proxy expectations.
4. **Workflow check**:
   - ops `uk_aq_cache_proxy_deploy.yml`
   - ingest `supabase_edge_deploy.yml` if upstream function changed

### G) If you change population overlay/data path

1. **Population repo**:
   - `supabase/functions/uk_aq_population/index.ts`
   - supporting loaders: `uk_population_external_ingest`, `uk_population_catalogue_load`
2. **Schema repo**:
   - `schemas/ingest_db/uk_aq_pop_schema.sql`
3. **Web repo**:
   - `uk_aq_hex_map.html` (and any test pages using population layers)
4. **Workflow check**:
   - population `supabase_edge_deploy.yml`
   - population scheduled workflows (`nomis_ingest.yml`, `nomis_monthly_check.yml`) if ingest cadence/shape changed

## Fast Pre-Merge Checklist

- Schema source-of-truth updated in `CIC-test-uk-aq-schema` when required.
- Matching runtime callers updated in ingest/ops.
- Matching UI callers updated in web repo.
- Deploy workflow coverage confirmed for every changed function/worker.
- Relevant `system_docs/` pages updated in touched repos.
- No edits made to existing files under any `archive/` path.
