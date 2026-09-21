# History Integrity dry-run reporting contract

## Authority and scope

This contract owns the reporting semantics for repair dry-runs performed by the current v2 and v3 R2 History Integrity / SOS-light implementations.

It is a reporting contract only. It does not change source authority, detection, proposal construction, apply ordering, verification, reconciliation, R2 mutation, locking, backup currentness or fail-closed repair behaviour.

The generation-specific repair contracts remain authoritative for whether a v2 or v3 repair proposal is valid. This contract defines how the result is described once those existing stages have produced their evidence.

## Required separation of concerns

Integrity reporting MUST distinguish these facts:

1. whether the Integrity invocation itself completed successfully;
2. whether the invocation was a dry run;
3. whether repair work was actually applied to live R2;
4. what state was detected before repair planning;
5. whether the proposed repaired state verified successfully;
6. what state remains in live R2 after the invocation.

A dry-run MUST NOT conflate successful planning with successful mutation.

A dry-run MUST NOT report live R2 as repaired merely because the proposed local overlay verifies.

A repair dry-run MUST NOT report the invocation itself as failed merely because the initial detector found the repairable problems that caused the repair to be planned.

## Canonical summary fields

The top-level Integrity run summary MUST expose these reporting fields when applicable:

```text
status
dry_run
repair_applied
pre_repair_status
pre_repair_gap_count
proposed_state_status
proposed_remaining_gap_count
live_state_status
```

The top-level summary is the canonical cross-generation reporting surface. Generation-specific nested summaries MAY expose additional evidence but MUST NOT contradict these fields.

### `status`

For a successful repair dry-run:

```text
status = planned
```

`planned` means the requested repair dry-run completed successfully and the proposed repaired state satisfied the existing generation-specific planning and verification contract. It does not mean live R2 was modified.

For a genuine failed dry-run:

```text
status = fail
```

Existing real-run success/failure values remain unchanged.

### `dry_run`

A dry-run MUST report:

```text
dry_run = true
```

This mode field is independent of success or failure.

### `repair_applied`

Every dry-run MUST report:

```text
repair_applied = false
```

A dry-run MUST never report `repair_applied = true`.

A real repair MAY report `repair_applied = true` only after the existing apply contract has actually performed the canonical mutation required for that run.

### Pre-repair state

When detection established repairable live-history problems, the summary MUST preserve that fact separately from the execution outcome:

```text
pre_repair_status = fail
pre_repair_gap_count = <detected relevant gap count>
```

The count MUST come from the existing generation-specific detector evidence. It MUST NOT be fabricated from a repair-plan length or dashboard interpretation.

When a generation does not expose a meaningful numeric gap count for the selected path, the count MAY be omitted rather than synthesised.

### Proposed-state result

For a successful repair dry-run whose existing final proposed-state verification succeeds:

```text
proposed_state_status = ok
proposed_remaining_gap_count = 0
```

The proposed-state result MUST come from the existing frozen-baseline plus local-overlay verification path, or the generation-specific equivalent.

The presence of a repair plan alone is insufficient evidence for `proposed_state_status = ok`.

If required proposed-state verification fails, is blocked, or reports remaining gaps where zero is required, the dry-run MUST fail rather than report `planned`.

### Live-state result

When the pre-repair state contains unresolved problems and the invocation is a dry run:

```text
live_state_status = unresolved
```

This explicitly records that the actual live R2 state was not changed.

A clean dry-run which establishes that no repair is required MAY report:

```text
live_state_status = ok
```

A run which fails before live-state health can be established SHOULD report `unknown` rather than inventing either `ok` or `unresolved`.

## Successful repair dry-run gate

For both v2 and v3, `status = planned` is permitted only when all required stages for that generation have succeeded.

At minimum:

- repair/proposal generation succeeded;
- required dependency validation succeeded;
- canonical apply planning succeeded without performing mutation;
- required dry-run reconciliation did not fail;
- required final proposed-state verification succeeded;
- the proposed remaining-gap count is zero where that count is part of the generation contract;
- no blocking dependency or fail-closed safety condition remains.

The initial presence of repairable pre-repair gaps is not itself a dry-run execution failure.

## Failed dry-runs

A failed dry-run MUST remain failed.

Examples include:

- source or proposal failure;
- dependency validation failure;
- canonical planning failure;
- blocked required dependency;
- required reconciliation failure;
- proposed-state verification failure;
- non-zero proposed remaining gaps where zero is required.

A failed dry-run MUST still report `dry_run = true` and `repair_applied = false`.

If pre-repair problems were already established before the failure, `live_state_status` MUST remain `unresolved`.

## Clean dry-runs

A dry-run that finds no repair work MUST retain the existing appropriate clean/no-op semantics for its generation.

This contract does not require every dry-run to use `status = planned`.

`planned` is the successful execution result for a repair dry-run in which repair work was actually planned and verified but intentionally not applied.

## Real repairs

This contract MUST NOT weaken the real non-dry-run success contract.

A real repair may report live state as `ok` only after the existing generation-specific mutation and post-apply verification requirements succeed.

Where a field such as `final_verified` specifically means remote post-apply verification, overlay verification during a dry-run MUST NOT set it to true.

## Process and task outcome

Within the History Integrity task contract, a successful `status = planned` repair dry-run is a successful command/task execution.

Wrappers and task-history persistence MUST NOT mark such a run failed solely because `live_state_status = unresolved`.

This rule is specific to History Integrity repair dry-runs. It MUST NOT globally redefine arbitrary `planned` statuses from unrelated tasks as successful.

## Human-readable report

A successful repair dry-run report MUST make all of these points clear:

- the dry-run completed successfully;
- current live problems were detected;
- the proposed repaired state verified successfully;
- no live R2 changes were applied;
- the current live problems therefore remain unresolved.

Where counts exist, wording SHOULD communicate the equivalent of:

```text
Dry run planned successfully.
8 gaps were detected in the current LIVE state.
The proposed repaired state verified with 0 remaining gaps.
No R2 changes were applied, so the LIVE gaps remain unresolved.
```

The report MUST NOT describe live R2 as fixed or resolved after a dry-run.

## Dashboard boundary

Administrative dashboard presentation of this reporting contract is owned by:

```text
../dashboards/history_integrity_dry_run_status_contract.md
```

The dashboard MUST consume the Integrity summary rather than inventing an independent data-health interpretation.

## Validation boundary

Pre-deployment validation for a reporting-only implementation change is structural and narrowly targeted.

It SHOULD establish that:

- v2 and v3 can represent a successful repair dry-run as `planned`;
- failed dry-runs remain failed;
- every dry-run reports `repair_applied = false`;
- proposed success is derived from existing verification evidence;
- real repair semantics are unchanged;
- task persistence treats successful Integrity `planned` dry-runs as completed execution.

Functional acceptance occurs through real TEST operation after deployment.
