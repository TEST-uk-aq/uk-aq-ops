# History Integrity dry-run dashboard status contract

## Authority and scope

This contract owns how the UK AQ Operations dashboard presents v2 and v3 History Integrity dry-run outcomes in the Daily Tasks view.

The authoritative backend dry-run semantics are defined by:

```text
../r2_history/integrity_dry_run_reporting_contract.md
```

This dashboard contract does not redefine repair health. It maps the authoritative Integrity execution result and `dry_run` mode into concise task-status presentation.

## Two-pill model

The Daily Tasks Status column MUST separate:

1. task execution outcome;
2. dry-run execution mode.

The `DRY RUN` pill is independent of success or failure.

Required presentation:

```text
successful dry-run   [ FINISHED ] [ DRY RUN ]
failed dry-run       [ FAILED ]   [ DRY RUN ]
successful real run  [ FINISHED ]
failed real run      [ FAILED ]
```

The dashboard MUST NOT replace the visible main execution pill with `PLANNED`.

For History Integrity, backend `status = planned` means a successfully completed repair dry-run and MUST therefore map to the normal visible `FINISHED` task outcome.

## FINISHED and FAILED

The existing normal execution styling remains authoritative:

- `FINISHED` uses the existing success treatment;
- `FAILED` uses the existing failure treatment.

A History Integrity dry-run that fails any required backend stage MUST display:

```text
[ FAILED ] [ DRY RUN ]
```

The existence of `dry_run = true` MUST NOT mask a genuine failure.

A successful History Integrity repair dry-run MUST display:

```text
[ FINISHED ] [ DRY RUN ]
```

The unresolved live-data state MUST NOT force the task execution pill to `FAILED` when the dry-run itself completed successfully.

## DRY RUN mode pill

The `DRY RUN` pill MUST use a yellow/amber warning-style treatment distinct from the normal green success and red failure treatments.

The pill MUST be shown whenever the task evidence records:

```text
dry_run = true
```

This includes failed dry-runs.

The dashboard MUST use direct task/summary evidence for dry-run mode. It MUST NOT infer dry-run mode from:

- task name;
- timestamps;
- gap counts;
- visible output text;
- `planned` alone.

History Integrity task persistence MUST preserve the invocation's `dry_run` value for both successful and failed completed runs so the dashboard can render the mode reliably.

If required mode evidence is unexpectedly absent, the dashboard MUST NOT guess. That absence is an observability defect to fix at the producer/persistence boundary.

## Status-column layout

The Status column MUST be wide enough for the two-pill states:

```text
FINISHED  DRY RUN
FAILED    DRY RUN
```

to remain on one line at normal desktop widths.

The table MAY rebalance neighbouring column widths minimally to achieve this. The change MUST NOT redesign the Daily Tasks table.

## Expanded summary

The existing expandable task summary remains the detailed evidence surface.

For History Integrity dry-runs it MUST preserve the backend summary fields supplied under the R2-history reporting contract, including when applicable:

```text
dry_run
repair_applied
pre_repair_status
pre_repair_gap_count
proposed_state_status
proposed_remaining_gap_count
live_state_status
```

The dashboard MUST NOT fabricate or independently recalculate those values.

A successful repair dry-run may therefore show `FINISHED + DRY RUN` while its expanded summary correctly shows:

```text
live_state_status = unresolved
repair_applied = false
```

This is intentional and is not a contradiction.

## v2 and v3 consistency

The same presentation rules apply to both v2 and v3 History Integrity tasks.

Generation-specific backend structures may differ, but once their authoritative summary reports execution outcome and `dry_run` mode, the dashboard mapping MUST be generation-neutral.

## Scope exclusions

This contract does not change:

- History Integrity repair selection;
- R2 mutation;
- verification;
- reconciliation;
- scheduler behaviour;
- dashboard data-source authority;
- status semantics for unrelated task families.

Recognition of History Integrity backend `status = planned` as successful execution MUST be scoped to the History Integrity reporting contract and MUST NOT globally classify unrelated task `planned` states as finished.

## Validation boundary

Pre-deployment validation is structural and narrowly targeted.

It SHOULD establish that:

- successful Integrity dry-runs render `FINISHED + DRY RUN`;
- failed Integrity dry-runs render `FAILED + DRY RUN`;
- real runs do not receive a `DRY RUN` pill;
- the `DRY RUN` pill is driven by direct mode evidence;
- the Status column accommodates both pills;
- expanded summary evidence remains intact;
- unrelated task rendering is unchanged.

Functional acceptance occurs through real TEST task execution and inspection of the local Operations dashboard after deployment.
