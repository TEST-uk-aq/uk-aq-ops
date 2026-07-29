# Integrity modularisation implementation report

Date: 2026-07-29  
Branch: `codex/2026-07-29-integrity-modularisation`

## Outcome

The authorised implementation prompts are complete on the feature branch. No LIVE repository or service was inspected or changed, no cloud or database operation was run, and no active file under `system_docs/` was edited.

The public entrypoints remain:

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
- `workers/uk_aq_backfill_local/run_job.ts`

## Python ownership map

- `integrity/repair/decisions.py`: authoritative pure observation repair decision, including scope grain, source-evidence requirement, explicit pollutant permission, AQI policy and fail-closed executability.
- `integrity/current_state/auth.py`: URL/audience validation, the sole identity-token command builder, bounded token acquisition and capability preflight.
- `integrity/current_state/audit.py`: deterministic candidate identities, candidate persistence and independent target-attempt audit.
- `integrity/current_state/resume.py`: environment/scope/evidence/supersession proof and failed-target-only selection.
- `integrity/cli.py`: additive resume CLI composition and validation.
- `integrity/runtime.py`: explicit coordinator stage order.
- `uk-aq-history-integrity_impl.py`: compatibility exports and established orchestration, delegating the extracted policy and recovery owners.

Imports of the new package perform no network, R2, SQLite, gcloud, lock or report action.

## TypeScript ownership map

- `r2/history_paths.ts`: canonical v2 history key and prefix construction.
- `observations/manifests.ts`: canonical observation pollutant and connector manifests.
- `aqilevels/manifests.ts`: canonical AQI pollutant and connector manifests.
- `integrity/source_evidence.ts`: stable semantic serialization and hashing.
- `source_adapters/registry.ts`: ordered source-adapter resolution and fallback reporting.
- `run_job.ts`: executable ordering and adapter execution, delegating the extracted owners.

The pre-change `run_job.ts` is preserved at `archive/2026-07-29/workers/uk_aq_backfill_local/run_job.ts`; its Git blob matches the pre-change revision.

## Functional changes

- Detection facts are classified by one `ObservationRepairDecision`. Suggested repair reporting, repair planning, executable-scope validation and observation-dependent AQI planning call that same owner.
- `day_dir_missing` and `connector_dir_missing` are connector/day wildcard repairs. A concrete supported `pollutant_dir_missing` is exact scope; an ambiguous pollutant scope fails closed.
- Every exact or wildcard destructive observation repair requires non-empty `--repair-pollutants`. Exact scope cannot widen; O3 remains observation-only for AQI and Latest Snapshot.
- Real PM2.5/PM10/NO2-capable repairs with current-state reconciliation enabled acquire and discard an audience-specific identity token after proposal validation and before canonical mutation. A failure blocks canonical apply. Dry-run validates shape only. The final owner-service request acquires a new token.
- Timeseries and Latest Snapshot outcomes are persisted independently. One target failure does not overwrite the other target's success.
- Resume CLI:

  ```text
  --resume-current-state-run-id <integrity run id>
  --resume-current-state-target failed|timeseries|latest_snapshot|all
  ```

  The target defaults to `failed`. Resume enters before date selection, source acquisition, backup boundary checks, proposal generation and canonical apply.

## SQLite additions

`open_db` creates two additive local audit tables:

- `current_state_candidate_sets`: target-specific canonical candidate JSON, SHA-256 identity, count and linked final-verification identity.
- `current_state_target_attempts`: linked attempts with target, attempt number, invocation kind, status, retryability class, bounded error, counts and source Integrity run.

For a verified run produced before these tables existed, resume reconstructs candidates from immutable `source_connector_day_evidence` and the verified object-operation scope. It fails closed if the run, environment, R2 verification flags, source evidence, candidate hash or supersession proof is inconsistent.

## Preserved contracts

No change was made to R2 keys or retention, Parquet schemas or ordering, manifest shapes, source mapping, AQI/WHO calculations, backup ownership, date selection, event names, current-state monotonic rules, Latest Snapshot single-writer ownership or existing environment-variable names and precedence.

## Structural checks

- Python compilation for the entrypoint, implementation and every new module.
- Direct public entrypoint import and `--help`.
- Existing focused preflight checks.
- Focused identity-token configuration and command checks.
- Focused connector-missing and exact-pollutant decision/execution checks.
- Focused independent target audit and failed-target selection check.
- One existing canonical coordinator ordering check.
- `deno check workers/uk_aq_backfill_local/run_job.ts`.
- Import-direction and stale-policy searches.
- Archive blob comparison.
- `git diff --check` and system-documentation diff check.

No real repair, R2 mutation, Cloud Run call, Supabase call, IAM change, deployment or LIVE operation was performed.

## CIC-Test deployment and validation commands

After review and merge, deploy by updating the dedicated Integrity machine's selected TEST checkout through its existing mechanism, then confirm:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --help
```

Refresh the configured base account before the first authenticated operation:

```bash
gcloud auth login info@ukaq.co.uk
```

Resume the failed 24 July target using the original numeric run ID from its report:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --resume-current-state-run-id <original-integrity-run-id>
```

The default must select only `latest_snapshot` when Timeseries is already successful. Then perform the one scoped SOS repair and operational comparisons specified in the authoritative plan.

## System-documentation handover

Chat mode should update implementation status only, without changing policy, in:

- `system_docs/r2_history/current_state_reconciliation.md`
- `system_docs/r2_history/integrity_modularisation.md`
- `system_docs/latest_snapshot/integrity_reconciliation.md`

Record the exact resume CLI above, the two SQLite table names, the preflight stage name `latest_snapshot_auth_preflight`, the separate `timeseries_reconciliation` and `latest_snapshot_reconciliation` stages, and that implementation is complete but real CIC-Test deployment/validation remains pending.

## Residual operational evidence

The original 24 July numeric Integrity run ID and a complete source day for the real SOS validation are not stored in this checkout. The operator must supply them from the retained TEST report when running the post-deployment commands.

