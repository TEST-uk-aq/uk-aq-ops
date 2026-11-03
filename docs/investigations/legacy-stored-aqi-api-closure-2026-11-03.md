# TEST legacy stored-AQI API: bounded code retirement

This change removes obsolete stored-AQI validation from normal calculated
station history and isolates retained compatibility. It does **not** establish
that the installed `uk-aq-aqi-history-r2-api` Worker is unused or ready to shut
down. No deployment or operational acceptance has been performed.

## Authority and evidence

- Implementation baseline: TEST Ops `main` at `0cff8bfaad6e9689d7d1c0b0fb103b97846f1429`.
- Read-only authoritative documentation: TEST system-docs `main` at
  `3ad0bf882b6ac85e0d73d035c03a43654701d348`, especially the 3 November closure
  decision in `system_docs/r2_history/aqi_r2_retirement_contract.md`, the
  station-chart router/contract and the compressed precomputed-AQI contract.
- TEST website `main` at `5775126` was inspected without modifying it.
- Current-main searches of TEST ingest, integrity-factory, media,
  population-ingest, schema and sensors-ingest found no references to the old
  Worker name, API paths or URL setting outside archives. This is a bounded
  repository search, not proof about externally installed callers.
- The authoritative contract records 15 successful old-Worker invocations on
  3 November, 15:49–16:02 UTC. Caller identities remain unknown. No current
  Cloudflare route, version, binding, secret metadata or request-level telemetry
  was available in this environment. A read of the TEST Ops GitHub runtime
  variable API was denied with HTTP 403 `Resource not accessible by integration`.
  Source defaults and `ops_vars.txt` are not deployed-configuration evidence.

## Caller and dependency inventory

| Caller/reference | Classification and evidence | Disposition |
| --- | --- | --- |
| `workers/uk_aq_station_history/src/aqi_validation.mjs`, invoked from station-series and combined observation-history through `ctx.waitUntil` | Obsolete active-runtime capability, opt-in by validation mode/sample flags. Fetches stored AQI for immutable, complete calculated ranges. Current contracts reject this as normal validation; the earlier CPU investigation records historical validator execution, not today's settings. | Removed module, import, both call sites, sampling policy and deployment/target-map controls. Existing remote validation values become inert. |
| `fetchR2AqiHead` through `buildStationSeries` / `buildR2LiveResponse` | Legacy compatibility, also reachable if calculated history is disabled and ingest coverage is insufficient. Current v3 must never use persisted AQI. Actual v2 callers are unresolved. | Retained for v2; now rejects v3 before reading URL/auth configuration or fetching stored AQI. Current calculated-history path is unchanged. |
| Station-history private `/v1/aqi-history` / `handleAqiHistoryChunk` | Legacy compatibility, reachable through the proxy's progressive v2 route. No evidence closes every v2 or Service Binding caller. | Retained for v2. V3 now returns HTTP 410 `legacy_history_route_retired_for_v3`, `no-store`, before parsing identity or resolving the old URL; invalid generation fails closed. |
| Cache proxy `/api/aq/aqi-history`, direct upstream and Service Binding alternatives | V3 public route is already retired before cache lookup; v2 compatibility remains executable. | Existing public v3 410 preserved. Legacy URL is resolved/required only for direct external compatibility requests, not normal charts or Service Binding requests. |
| TEST website Hex Map and Sensors compatibility client | Explicit opt-in compatibility. Both adapters default `station_history_loader` to true and use `/station-series` plus `/timeseries`; `station_history_loader=false` selects the compatibility client, which has `/aqi-history` URL candidates and an optional `aqi_history_base`. Controller selects a client explicitly. Usage of this opt-in is unresolved. | Website source, defaults and shared controller/cache/renderer unchanged. For selected v3 the proxy continues to reject stored-AQI requests. Frontend removal requires a separate consumer/contract decision. |
| Hosted dashboard `station_snapshot_v2.ts::handleStationSnapshotV2Rows` | Active diagnostic code: `/api/station-snapshot-v2/rows` is registered in the dashboard router, reads the optional stored-AQI URL/token, and exposes R2/ObsAQIDB source diagnostics. Actual usage is unresolved. | Preserved with its dashboard workflow configuration. This is a blocker to declaring all API consumers closed, not authority for normal charts to read persisted AQI. |
| `workers/uk_aq_aqi_history_r2_api_worker/` and its deployment workflow | Dedicated legacy service/infrastructure. Worker serves `/` and `/v1/aqi-history`; configuration includes retained AQI data/indexes, ObsAQIDB and optional observation fallback. Workflow admits v1/v2, not the selected v3 generation. Installed state cannot be inferred from that deployment gate. | Source, Wrangler configuration, workflow, settings and all installed resources retained. No redeployment, disablement or deletion. |
| Station-history deployment workflow | Obsolete unconditional prerequisite for v3, still required by retained v2 compatibility. | Require and send `UK_AQ_AQI_HISTORY_R2_API_URL` only for v2. Existing v3 remote bindings are not deleted. |
| Cache-proxy/dashboard deployment workflows and URL/Worker/index target-map entries | Required by retained compatibility/diagnostic code or unresolved infrastructure ownership. | Retained. Only the two uniquely owned validation entries were removed from the environment target map. |
| `scripts/r2_query/query_r2_v2_aqilevels.sh`, combined observations/AQI queries and index queries; `scripts/aqi_gaps/check_r2_aqi_gaps.sh` | Historical/manual inspection: direct retained R2 or local Dropbox/Parquet reads, not calls to the stored-AQI HTTP service. Installed/manual usage is unresolved. | Preserved; not run. These references do not establish a normal chart dependency or authorise data deletion. |
| `scripts/backup_r2/uk_aq_aqi_history_r2_test_seed.mjs` | Legacy explicit manual seed utility with R2 writes, default separate `aqi-r2-test/v1` prefix; not an HTTP caller. | Preserved and not executed. No Prune/writer or seed work is part of this change. |
| Existing tests, `ops_vars.txt`, historical investigation documents, TEST-contained migration patch material and archives | Non-runtime fixtures, historical configuration/evidence or separately scoped migration/recovery material. | Preserved as historical evidence; not treated as live configuration. New pre-change archives are reference/rollback only. |

## Files changed and preserved behaviour

Active changes are limited to station-history `src/index.mjs`,
`src/policy.mjs`, removal of `src/aqi_validation.mjs`, the station-history
deployment workflow and README, cache-proxy `src/index.ts`, and
`config/uk_aq_github_env_targets.csv`, plus this handover. Exact original code
and the changed workflow are preserved under `archive/2026-11-03/` with their
relative paths. Documentation/configuration catalogue files have no code-style
archive copies.

No changes were made to `lib/aqi/aqi_levels.mjs`, calculated-history processing,
canonical observation readers, R2/IngestDB precedence, PM rolling context,
continuity, chart source defaults, shared frontend modules, the compressed
JSON Worker/reader, Prune, Integrity, JSONgen or any R2 object. A v3 request
that attempts the retained old head reader fails closed instead of falling
back to another source. Calculated-history rollout flags/defaults are unchanged.

## Structural validation

- Before editing: inspected imports/call sites, route selection, workflow
  configuration and flag ownership; baseline station-history syntax/import passed.
- After editing: JavaScript/MJS and TypeScript syntax parsing; station-history
  module import; policy parsing; changed workflow YAML and all shell blocks;
  actual jq payload construction for both v2 and v3; Worker TOML parsing;
  environment-target CSV parsing and exact two-entry removal; `git diff --check`.
- A bounded in-memory response-contract check confirmed private v3 410/no-store
  without upstream fetch or legacy URL resolution, invalid-generation rejection,
  v2 request-parser reachability, and that obsolete validation settings are ignored.
  This was a local check, not a new committed test suite or operational acceptance.
- Archive originals were checked against the implementation baseline. Shared AQI,
  observation/calculated-history and compressed-history source were left unchanged.
- No broad suites, external functional probes, deployments or data operations.

## Operator handover

After review and a separately authorised merge/deployment, deploy the changed
station-history and cache-proxy Workers together using their existing TEST
workflows. The following are manual commands for that later authorised action,
**not commands executed during this task**:

```sh
gh workflow run uk_aq_station_history_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
```

Both workflows also have main-push triggers, so a later merge may deploy them
automatically. Verify their actual runs before choosing a manual dispatch. Do
not dispatch the old AQI Worker workflow. Preserve existing TEST calculated-AQI,
continuity, generation, authentication and observation-service configuration.

Required real TEST acceptance: normal Hex Map and Sensors recent/24-hour and
closed full-month PM/NO2 concentration and DAQI/EAQI; missing/incomplete
observations and blank-hour reporting; PM context across continuity; R2-first
precedence and auth boundaries; public and private retired-route responses;
and continued isolated compressed-JSON reader operation without a default
source switch. Use route-specific station-history/proxy/legacy-Worker telemetry
to prove normal chart calls no longer read stored AQI, including historical
requests that would previously run validation. Observe actual Worker CPU and
errors. Aggregate old-Worker counts alone cannot prove caller closure.

The private ignored `env-vars-master.csv` is absent from this workspace. Its
owner should retire only the two validation rows during separately authorised
TEST configuration housekeeping and keep the target map aligned. Retain the
legacy URL and service settings needed by the dashboard/v2 compatibility until
their consumers are closed. Remote bindings/secrets/variables have not been
removed by this PR; stale validation controls are ignored by the new code.

Before any future legacy Worker shutdown, identify the recorded callers and
installed launchers, migrate or explicitly close the dashboard and compatibility
requirements, and obtain separate operator authority for deactivation. Historical
object removal remains separately gated with an authorised removal set of zero.
Keep Prune paused; no backfill/regeneration or future JSON-first fallback is
required or implemented here. LIVE remains outside scope.

Rollback: revert the reviewed code/configuration commit (or restore the exact
dated originals and the deleted validator), then separately authorise/redeploy
both affected TEST Workers as needed. No data rollback is required. Reinstating
the old validator is not a supported steady-state acceptance requirement.

## Chat-mode system-documentation handover

No further contract change is required for this bounded implementation and no
authoritative documentation was edited. After review/merge, ChatGPT should
record the PR/commit and code-only status in the existing closure section:
validator/controls removed, v3 private compatibility guarded, URL isolated to
retained v2/diagnostic consumers, and operational acceptance/installed caller
closure still pending. Do not mark the old Worker unused, disabled or deleted,
change chart defaults, or activate the future hybrid reader.
