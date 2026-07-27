# R2 history shared writer locking and AQI simplification implementation report

Date: 2026-07-27  
Scope: Codex phases 1 to 9  
Repository: `TEST-uk-aq-ops`  
Live operations performed: none

## Contract correction applied during implementation

Environment identity had already been added to the first draft of the advisory-lock hash. After authoritative commits `04fb54abb71caab9d78f78ef7dfc6c3e0262bd4b` and `d37f2e8d6f328772edd9b213d839197a2ee73e0e` were incorporated and the amended lock documents were reread, it was removed completely from lock-key derivation.

The canonical logical identities are now database-local and fixed:

- `uk_aq:r2_history:v1:connector_day:<day_utc>:<connector_id>`
- `uk_aq:r2_history:v1:day_finalisation:<day_utc>`
- `uk_aq:r2_history:v1:global_index_finalisation`

Environment labels remain optional diagnostic metadata only. TEST/LIVE separation is supplied by their different Supabase PostgreSQL projects and advisory-lock managers.

Prune Daily and real Integrity mutation retain one direct PostgreSQL session for the complete protected section. They use the existing `SUPABASE_DB_URL` route, with `DATABASE_URL` retained as the existing fallback. No PostgREST/RPC lock-acquire and lock-release split is used.

## Phase completion

1. Contract and implementation inventory completed. The existing direct database route, Python-to-JavaScript Integrity mutation boundary, history parent/index implementations and scheduler dispatch pattern were viable; no schema or credential decision was required.
2. Added deterministic database-local session advisory locks, bounded acquisition/retry, structured diagnostics and safe release. Added the request-wide Integrity IngestDB boundary guard and removed the broad Prune-running exclusion while preserving other backup-readiness checks.
3. Added the shared connector-day write/verify lifecycle and adopted it in Prune and real Integrity mutation. Existing canonical normalization, hash, Parquet, manifest, physical-identity and targeted-index implementations are invoked inside that shared protected lifecycle; caller source acquisition and gate ownership remain separate.
4. Added shared day and global finalisation lifecycles. Day parents are read after lock acquisition, merged with live connector references, and recovered by a bounded prefix listing only when the parent is absent or invalid. Normal full index rebuilding was removed; changed connector leaf indexes and one final aggregate/latest pass are used.
5. Converted Prune Phase B to the connector/day/global lock sequence. Observation write and verification complete the connector gate before the separately locked AQI attempt. AQI failure no longer invalidates verified observation evidence or blocks eligible deletion. Historical gate adoption/backlog work was removed.
6. Converted real Integrity apply and migration-mode mutation to the shared lock sequence. Integrity no longer creates, completes, invalidates or backfills prune gates. Check-only and dry-run remain outside the mutation worker and do not acquire writer locks or access live R2.
7. Made observation-derived AQI the only active Phase B path. The materialised AQI RPC exporter, selector flags, aliases, fallback selection and active v1 AQI workflow configuration were removed. ObsAQIDB PM observation context remains.
8. Extracted chart-metrics cleanup/refresh into `workers/uk_aq_chart_metrics/job.mjs`, with task-health key `ops.chart_metrics`, a separate GitHub Actions workflow/report, and a scheduler entry using the existing workflow-dispatch pattern. Prune no longer invokes chart metrics.
9. Removed obsolete scripts, tests, configuration and imports; updated structural validation; and added this handover. No file under `system_docs/` was changed.

## Main files changed

Added:

- `workers/shared/uk_aq_r2_history_writer.mjs`
- `scripts/backup_r2/uk_aq_check_integrity_ingest_boundary.mjs`
- `workers/uk_aq_chart_metrics/job.mjs`
- `.github/workflows/uk_aq_chart_metrics.yml`
- focused tests for locking/boundaries, chart metrics and prune physical identity
- the required 2026-07-27 archive copy of the pre-change connector-gate module

Changed:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_prune_daily/server.mjs`
- `workers/shared/uk_aq_connector_day_gate.mjs`
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
- `.github/workflows/uk_aq_prune_daily.yml`
- `cloudflare/scheduler/jobs.toml`
- `config/uk_aq_github_env_targets.csv`
- `package.json` and directly affected focused tests

Removed:

- `scripts/backup_r2/uk_aq_complete_integrity_connector_gates.mjs`
- Integrity gate-completion tests
- retired Phase B deployment-flag tests
- active historical gate adoption/backlog handling
- legacy AQI RPC/export selection and fallback handling
- Prune's second routine full history-index rebuild
- chart-metrics execution from the Prune server

## Deployment changes

- Deploy the changed Prune and Integrity code together so every active normal writer uses the same lock contract.
- Ensure the existing direct/session-mode `SUPABASE_DB_URL` is present for Prune and real Integrity mutation. No new secret is introduced.
- Add/deploy the `UK AQ Chart Metrics` workflow, then sync the scheduler configuration containing `jobs.uk_aq_chart_metrics`.
- Retain `OBS_AQIDB_SUPABASE_URL`, `OBS_AQIDB_SECRET_KEY`, `UK_AQ_CHART_METRICS_RETENTION_DAYS` and `UK_AQ_CHART_METRICS_DAILY_REFRESH_DAYS` for the standalone chart job.
- Retired Phase B selector/adoption variables may be removed from repository/environment configuration. The observation-derived AQI path is no longer selected by a deployment flag.

## Structural validation

- `npm run check`: passed after removing its stale reference to the already-absent `workers/uk_aq_aqilevels_retention_service/server.mjs`.
- Focused Node tests: 50 passed, 0 failed.
- The focused checks cover fixed database-local lock identity, namespace/resource separation, bounded acquisition, release on success/error/cancellation, all-connector Integrity boundary reporting, parent connector preservation, chart task isolation, observation/AQI gate separation and physical file identity.
- Python compilation of the changed Integrity implementation: passed.
- `git diff --check`: passed.
- No real R2 write, Integrity repair, prune, migration, deployment or LIVE operation was run.

## Required TEST operational validation

Use the plan's Phase 11 checks after review and deployment:

1. Confirm a request whose inclusive end day meets any requested connector's IngestDB boundary fails as one request and reports all blockers before source or R2 work.
2. Run one valid historical Integrity operation below every boundary and inspect one repaired connector plus its preserved parent references/indexes.
3. Run unrelated Prune and Integrity connector-days concurrently, then separately confirm same connector-day contention is bounded and non-mutating.
4. Confirm a day-parent merge preserves a connector not written by the current run.
5. Observe one normal Prune success and one representative AQI-only failure; the latter must retain the verified observation gate and deletion eligibility while leaving AQI/day completion failed.
6. Confirm only v2 observation-derived AQI objects are written.
7. Run the standalone chart workflow once and inspect its artifact plus `ops.chart_metrics` task-health state; confirm Prune result/gates are unaffected.

## Documentation handover and risks

No implementation choice remains unresolved. The primary remaining risk is operational and is intentionally deferred to TEST: lock contention, parent preservation and the separated AQI/chart failure paths have not yet been exercised against real services.

Per repository policy, active `system_docs/` were not edited. Chat mode should align implementation ownership/workflow references for the new shared writer and `ops.chart_metrics` task. The R2 history README/coordination documents also reference a missing `timeseries_binding_contract.md`; the available active contract is `system_docs/r2_history/contract.md`. This link discrepancy did not change the implemented contract but should be corrected by the documentation owner.
