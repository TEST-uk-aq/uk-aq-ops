# R2 history shared writer locking and AQI simplification implementation report

Date: 2026-07-27; follow-up corrections completed 2026-07-28
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

Prune Daily and real Integrity mutation retain one direct PostgreSQL session for the complete protected section. Prune Daily uses the explicit `SUPABASE_DB_URL` route without a generic database-URL fallback. No PostgREST/RPC lock-acquire and lock-release split is used.

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

## Follow-up review findings and corrections (2026-07-28)

The follow-up review was performed against `main` at `97e082084089c7771483c4037aea122d33a953e9`, which includes the recorded daily-profile decision. The original six findings and the adjacent direct-writer issue were resolved as follows.

| Finding | Review result | Implemented correction |
| --- | --- | --- |
| 1. Deletion gate could accept incomplete or non-Prune evidence | Confirmed | Deletion-time SQL now selects the completion source and all row/file/byte totals. Validation requires exact canonical connector-day identity, lowercase manifest SHA-256, valid completion time, `completion_source=prune_daily_phase_b`, present non-negative counts and internally consistent zero/non-zero totals. Integrity, adoption and malformed evidence fail closed. |
| 2. The shared writer was chiefly a lock/callback wrapper while object construction remained duplicated | Confirmed | Added shared canonical v2 key, Parquet, physical-schema, pollutant/connector/day manifest and manifest-validation implementations. Prune Daily, the Integrity proposal/apply path, local proposal construction and the v2 observations migration/repair implementation now import those shared implementations. Source acquisition remains caller-specific. The shared writer module exposes the canonical construction/validation surface alongside its retained-session lock lifecycle. |
| 3. Sparse routine affected days expanded to the inclusive minimum/maximum range | Confirmed | Added the exact `affectedDaysUtc` interface and threaded it through v1/v2 targeted domain and timeseries index finalisation. Prune Daily and Integrity apply now pass the exact de-duplicated day set; the continuous range interface remains available only to explicit range callers. |
| 4. Active Phase B retained executable v1 AQI output | Confirmed | Active Phase B configuration now requires v2 and fails closed otherwise. Its v1 AQI prefixes, manifest builders, Parquet writer and fallback branches were removed. The active outputs are only the v2 hourly data and debug trees. Separate shared legacy reader/index support was not removed. |
| 5. Aggregate day-gate totals omitted preserved connectors | Confirmed | Day finalisation now validates every fetched connector manifest, builds the merged day manifest from existing plus replacement connectors, GET-verifies the written day manifest, and derives retained `prune_day_gates` totals from that complete verified parent. |
| 6. Integrity boundary ordering was neither correct for all modes nor directly proven | Confirmed | Explicit scopes run the request-wide IngestDB boundary before any Dropbox readiness/preflight or mutable Integrity state. Automatic daily performs only direct child-name discovery, a read-only `daily_profile_state` query and exact date selection before the boundary. Normal readiness, Dropbox inspection and state transitions start only after the boundary succeeds. |
| Adjacent issue: direct live local source-to-R2 routes could remain a competing writer | Confirmed | Non-dry-run `source_to_r2`, `obs_aqi_to_r2` and `r2_history_obs_to_aqilevels` execution now fails closed unless it is constructing an Integrity proposal. Live publication remains the proposal apply path protected by the shared connector/day/global advisory-lock lifecycle. |

### Daily-profile decision adopted

The authoritative option 1 decision, including its SQLite refinement, is implemented. Automatic daily scope construction may inspect only direct names under the configured v2 observations prefix, strictly parse `day_utc=YYYY-MM-DD`, read only the required local `daily_profile_state` rows through SQLite `mode=ro`, calculate/de-duplicate the exact selected dates and derive their minimum/maximum boundary. It does not stat child entries, traverse connector/pollutant children, inspect content, change daily state, run readiness or access source/R2 adapters before the request-wide boundary succeeds.

### Follow-up files changed

Added:

- `workers/shared/uk_aq_r2_history_canonical.mjs`
- `workers/shared/uk_aq_r2_history_manifest_validation.mjs`
- dated pre-change archives under `archive/2026-07-28/` for each substantial active non-test file changed

Changed:

- `workers/shared/uk_aq_r2_history_writer.mjs`
- `workers/shared/uk_aq_connector_day_gate.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/run_job.ts`
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`
- `scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs`
- `scripts/uk-aq-history-integrity/bin/daily_profile.py`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`
- focused gate, path, index, backfill-route and Integrity call-order tests

No file under `system_docs/` was changed, and tests/system documents were not archived.

### Follow-up structural validation

- `npm run check`: passed.
- `deno check workers/uk_aq_backfill_local/run_job.ts`: passed.
- Focused Node tests for writer coordination, canonical manifest compatibility/declarations, direct-route retirement, connector deletion evidence, merged day totals, v2-only Phase B and sparse index finalisation: 87 passed, 0 failed.
- Focused Python call-order checks: explicit boundary failure, automatic daily direct-name-only discovery and automatic daily boundary failure all passed.
- Python compilation of the changed Integrity modules: passed.
- `git diff --check`: passed.
- No real R2 access/write, Integrity repair, migration, prune, database mutation, Dropbox write, deployment or LIVE operation was performed.

### Follow-up TEST operations still deferred

After review and deployment, observe one automatic daily boundary rejection and confirm its report has no readiness/source/R2 work or pre-boundary daily-state transition. Then run one permitted automatic daily request and inspect the resulting exact sparse affected-day index updates. Also exercise one normal Prune connector-day with a preserved connector in the day parent, confirm the connector deletion gate contains complete Prune-owned evidence, and confirm only v2 observation-derived AQI outputs are produced. Direct local live source-to-R2 modes should be confirmed to fail closed while the Integrity proposal/apply route remains operational under the retained PostgreSQL advisory-lock session.

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

## Connector-day source-identity hardening (2026-07-28)

Prune Daily Phase B now uses the clean budget-variable names `UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN` and `UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS`. Their defaults remain 1,740 and 60 seconds, producing the existing 1,680-second effective deadline; the 30-minute worker and 40-minute GitHub job limits are unchanged.

The companion TEST schema change `20260728_001_ingest_prune_connector_source_identity.sql` is present on schema `main` at commit `2dfae52930452dae735cb52ccf15110f5dcfeb79`. It adds nullable source hash, contract-version and row-count evidence to `uk_aq_ops.history_candidates` and `uk_aq_ops.prune_connector_day_gates`, with all-null/all-populated and value constraints. Existing rows are deliberately not backfilled and therefore fail closed until canonical reprocessing.

Source identity contract v1 hashes the sorted canonical seven-field observation-row encoding with the dedicated `uk-aq-prune-connector-source-content-hash:v1` domain prefix. Phase B derives it from the exact frozen rows written to R2 and persists identical evidence on the candidate and Prune-owned connector gate in one transaction after observation verification/index work. Non-complete work clears the evidence. Candidate discovery revalidates every retained complete candidate against fresh canonical rows, so value-only and verification-status-only source changes invalidate only that connector-day.

The later atomic-deletion review confirmed that the original source-identity implementation could commit initially matched hour buckets before repair and then open another transaction for repaired buckets from the same connector-day. That partial-hour sequencing was not compatible with the persisted full connector-day identity and has been removed. Initial and post-repair classifications are now eligibility diagnostics only. Normal Prune performs all repair work, rechecks every current hour across each exact connector-day, applies the connector gate, and constructs one final combined plan containing both initially matched and newly repaired hours. Late-arrival direct deletion uses the same whole-connector-day planner.

Every planned connector-day now uses at most one direct `SUPABASE_DB_URL` `REPEATABLE READ` transaction. On the retained session it locks candidate and gate evidence, revalidates the complete canonical source identity, proves the eligible plan covers every current hour and count, deletes every planned hour internally without an intermediate commit, and runs a final same-session canonical row-count query before committing. A pollutant subset cannot use the full source identity. A remaining mismatch or gate block prevents the transaction from opening. A delete cap or non-empty final snapshot rolls back the complete connector-day, reports zero committed rows, and preserves valid candidate/gate evidence; source-identity mismatch retains the existing exact connector-day invalidation. Different connectors on the same day remain independent.

Focused structural checks cover value/status sensitivity, order independence, canonical zero handling, empty evidence, legacy/malformed gate evidence, candidate revalidation, identical completion evidence, one combined matched-plus-repaired connector-day plan, one repeatable-read transaction and commit, whole-day blocking on one remaining mismatch, multi-hour cap rollback, final-drain rollback/commit, pollutant-scope rejection, exact connector isolation and conflict rollback. The directly affected gate/path/source-identity tests passed 58/58; changed runtime syntax checks and `git diff --check` also passed. Real TEST validation remains deferred until schema and ops deployment. No real database, R2, Dropbox, Prune, deployment or LIVE operation was performed for this change.

Validation completed with syntax checks for all changed/new runtime modules, 58 passing focused Node tests (including the existing physical-identity coverage), three passing schema structural tests, and `git diff --check` in both repositories. The schema migration was not applied and functional success is not claimed from these structural checks.
