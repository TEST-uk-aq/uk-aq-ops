# 2026-07-21 Modularise Integrity Backfill

## Status

Implemented, with the current-state recovery design revised on 29 July 2026 after CIC-Test operational experience.

The modularisation remains in force. The attempted old-run current-state replay interface was deliberately removed after it proved to add disproportionate candidate reconstruction, supersession and target-selection complexity.

Integrity runs are immutable operational records and are not resumed. After correcting a failure, the operator starts a new appropriately scoped Integrity operation. Normal R2 repair, Timeseries reconciliation and Latest Snapshot reconciliation remain idempotent or monotonic so already-correct state is skipped safely.

## Authoritative contracts

Implementation follows:

- `system_docs/r2_history/integrity.md`;
- `system_docs/r2_history/current_state_reconciliation.md`;
- `system_docs/r2_history/integrity_modularisation.md`;
- `system_docs/latest_snapshot/integrity_reconciliation.md`.

Where this plan differs from those files, the active system contracts are authoritative.

## Completed modularisation outcomes

- One authoritative observation repair decision feeds suggested repairs, planning, executable scope validation and AQI dependency policy.
- Every destructive exact or wildcard observation repair requires explicit `--repair-pollutants` permission.
- PM2.5, PM10 and NO2 repairs perform Latest Snapshot authentication capability preflight after proposal validation and before canonical R2 mutation.
- The actual Latest Snapshot invocation obtains a fresh audience-specific identity token after final verification.
- Timeseries and Latest Snapshot execute and persist outcomes independently.
- The Python compatibility wrapper and public entrypoint remain stable.
- Extracted Python and TypeScript modules retain the successful modularisation boundaries.
- R2 keys, Parquet schemas, manifest schemas, source ordering, AQI/WHO calculations, backup behaviour and local locking remain unchanged.

## Current-state recovery correction

The active implementation must not expose an old-run replay or target-selection entrypoint.

Removed ownership includes:

- the two former current-state replay CLI options;
- old-run candidate reconstruction from historical source evidence;
- failed/pending target selection for an earlier run;
- replay-only report fields;
- interrupted replay recovery;
- the replay-only CLI and current-state modules.

A failed run retains its durable component outcomes. Correct verified R2 and a successful Timeseries target remain recorded even when Latest Snapshot fails. The process returns non-zero when a required target fails, and the report identifies the failed component and directs the operator to start a new scoped run.

Run `229` remains an unchanged historical failed run. It must not be updated, superseded or replayed by this correction.

## SQLite choice

No destructive migration is performed.

The existing tables remain:

```text
current_state_candidate_sets
current_state_target_attempts
```

Normal reconciliation continues to record deterministic target-specific candidate identities, bounded candidate payloads, selected scope, final-verification identity, timestamp bounds and append-only target outcomes. This evidence is useful for normal-run audit and failure diagnosis.

The tables provide no active replay capability. Historical rows, including the legacy `invocation_kind` value allowed by the existing SQLite constraint, remain readable for compatibility but cannot be created through a replay path.

## Preserved execution order

For a real supported-pollutant repair:

```text
source acquisition
→ detection and repair decision
→ observation and AQI proposals
→ Latest Snapshot authentication preflight
→ canonical R2 apply
→ final R2 verification
→ Timeseries reconciliation
→ fresh-token Latest Snapshot reconciliation
→ independent target audit and reporting
```

Check-only and repair dry-run remain non-mutating. Normal repair apply retains the existing explicit pollutant gate and final-verification boundary.

## Focused validation

Pre-deployment checks are limited to:

- Python compilation for touched files;
- direct public entrypoint import;
- public Python `--help`;
- focused CLI checks proving the replay options are absent;
- focused normal current-state reconciliation and independent target audit;
- focused authentication-preflight checks;
- focused failure-report generation;
- stale replay-symbol and CLI searches;
- `git diff --check`.

No real repair, Cloud Run call, Supabase operation, R2 mutation, deployment, LIVE operation or complete test suite is authorised by this correction.

## Post-merge CIC-Test validation

After review, merge and deployment through the existing TEST mechanism:

1. confirm the public `--help` output has no old-run replay options;
2. run one appropriately scoped check-only operation;
3. run one new scoped repair with explicit pollutants when operational evidence requires it;
4. confirm authentication preflight precedes canonical mutation;
5. confirm final verification precedes both current-state targets;
6. confirm already-correct R2 and current state are skipped or no-op safely;
7. confirm Timeseries and Latest Snapshot outcomes remain independently reported;
8. confirm run `229` remains unchanged.

Do not attempt to recover by invoking or modifying the failed historical run.

## Completion criteria

This correction is complete when:

- no active or hidden old-run replay entrypoint remains;
- normal modes and their CLI validation are unchanged;
- authentication preflight and fresh final-token acquisition remain intact;
- candidate identities and independent normal target attempts remain audited;
- failed reports preserve successful component outcomes and the actual failed component;
- documentation consistently directs operators to a new scoped run;
- focused structural checks pass;
- one narrow draft pull request is available for review.
