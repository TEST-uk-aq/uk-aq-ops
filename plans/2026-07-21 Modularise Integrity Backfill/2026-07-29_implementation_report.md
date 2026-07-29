# Integrity modularisation implementation report

Date: 2026-07-29
Current correction branch: `agent/remove-integrity-resume`

## Outcome

The successful Integrity modularisation remains active. Following CIC-Test operational experience, old-run current-state replay was deliberately removed in favour of starting a new appropriately scoped Integrity run after a failure is corrected.

No LIVE repository or service was inspected or changed. No cloud, R2, Supabase, database deployment or real Integrity operation was run. Active system contracts were already updated through their designated documentation workflow and were not changed by this implementation branch.

## Removed active ownership

- The replay CLI composition and validation module was removed.
- `integrity/current_state/resume.py` was removed.
- The public parser no longer exposes either former replay option.
- Old-run ID parsing, evidence validation, target selection, legacy candidate reconstruction and replay orchestration were removed.
- Replay-only report fields and the early replay branch in `main()` were removed.
- Resume-only tests were removed and replaced with focused normal-run checks.

There is no hidden or undocumented alternative replay entrypoint.

## Preserved Python ownership

- `integrity/repair/decisions.py`: authoritative observation repair decision and explicit pollutant policy.
- `integrity/current_state/auth.py`: URL/audience validation, sole identity-token construction, bounded acquisition and capability preflight.
- `integrity/current_state/audit.py`: additive SQLite schema, normal candidate/final-verification evidence and append-only independent target attempts.
- `integrity/runtime.py`: coordinator stage order.
- `uk-aq-history-integrity_impl.py`: established normal orchestration and compatibility exports.

The public entrypoint remains:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

## SQLite decision

No destructive migration was added. The existing `current_state_candidate_sets` and `current_state_target_attempts` tables remain for historical compatibility and normal-run audit.

Normal runs continue to record target-specific candidate SHA-256 identities, bounded candidate payloads, selected scope, timestamp bounds, final-verification identity, target status, outcome counts and bounded errors. These records provide useful audit evidence but are not loadable through any operational replay path.

The existing SQLite `invocation_kind` constraint remains unchanged so historical rows stay valid. Active code records only `initial` attempts.

## Preserved behaviour

- check-only, repair dry-run and repair apply modes;
- explicit destructive `--repair-pollutants` permission;
- central repair classification;
- authentication preflight after proposal validation and before canonical R2 mutation;
- fresh token acquisition for the actual Latest Snapshot call;
- final R2 verification before current-state reconciliation;
- independent Timeseries and Latest Snapshot status and audit records;
- monotonic and same-timestamp correction rules;
- existing environment variables, R2 layouts, schemas, runner and environment lock.

A failed target keeps earlier successful outcomes, produces a failed overall result and is rendered with its bounded failure plus the instruction to correct the cause and start a new scoped Integrity run.

## Historical run 229

Run `229` remains an immutable failed historical record. This implementation does not read, update, supersede or replay it.

## Focused checks

- Python compilation passed for the touched active implementation and focused test files.
- Direct public entrypoint import passed.
- Public Python `--help` passed and exposes neither removed replay option.
- Two focused current-state checks passed, including both rejected CLI options, independent normal target outcomes, retained candidate identities and failure-report rendering.
- Nine focused authentication and preflight checks passed, including explicit account/impersonation/audience construction, no fallback, preflight conditions, fresh final token and coordinator ordering.
- Active-code stale-symbol and removed-CLI searches passed; the only retained `resume` string in active implementation is the historical SQLite constraint value.
- `git diff --check` passed.

No deployment, merge or external mutation is part of this branch.
