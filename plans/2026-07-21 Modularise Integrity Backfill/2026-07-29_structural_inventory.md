# Integrity modularisation structural inventory

Date: 2026-07-29
Branch: `codex/2026-07-29-integrity-modularisation`

## Stable entrypoints and compatibility boundaries

- Python public entrypoint: `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`.
- Python compatibility implementation: `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`.
- Local backfill executable entrypoint: `workers/uk_aq_backfill_local/run_job.ts`.
- Focused tests import and monkeypatch public Python symbols, so compatibility names must remain exported from the public module.

## Confirmed policy duplication

- Observation gap classification was independently maintained by suggested-repair enrichment, repair-plan construction and executable-scope derivation.
- AQI dependency eligibility was partly embedded in repair-plan construction.
- Cloud Run identity-token construction lived in the Python entrypoint implementation.
- Timeseries and Latest Snapshot results were aggregated into one run row without target-attempt history.
- No failed-target-only current-state resume path existed.

## Safe extraction seams

- Pure observation repair policy can move under `integrity/repair/` and be called by all compatibility functions.
- Identity-token configuration and command construction can move under `integrity/current_state/` without importing the entrypoint.
- Current-state audit and resume proof can use SQLite through explicit connection arguments.
- TypeScript path, manifest and source-evidence helpers can move behind explicit imports while `run_job.ts` retains executable ordering.

## Non-negotiable preserved surfaces

- Existing CLI and environment names, R2 keys, Parquet and manifest schemas, event names, source acquisition ordering, AQI calculations, backup gate and public entrypoint paths.
- No module import may acquire credentials, access SQLite, call a network service, mutate R2, take a lock or write a report.
- Active code must never fall back to `archive/` paths.
