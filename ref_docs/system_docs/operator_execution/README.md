# Operator execution

## Status

**Future implementation authority.** These rules are agreed for upcoming operator-tooling work but are not evidence that every current UK AQ script already implements them.

## Purpose

This area owns the cross-system operator-execution rules for long-running or operationally significant human-launched scripts.

It covers:

- per-invocation timestamped work directories;
- the 15-second operator progress/heartbeat rule;
- elapsed-time and ETA presentation;
- persistent human-readable logs;
- bounded structured run reports.

Read [`contract.md`](contract.md) when implementing or changing these behaviours.

## Scope

The contract applies to operator-facing scripts that can take materially noticeable time, mutate external state, perform recovery/migration work, or carry out significant verification. The first implementation target is the observation-history index-v3 operator tooling, with the same shared pattern intended for other UK AQ operational scripts afterwards.

For a multi-step operation such as an index migration, the domain area still owns migration authority, checkpoints, rollback semantics and data correctness. This area owns only how each script invocation is surfaced, recorded and organised for the operator.

## Boundaries

This area does not redefine:

- R2-history migration, rollback or verification semantics;
- evidence/checkpoint authority;
- scheduler or writer-freeze behaviour;
- retry, locking or mutation safety;
- domain-specific structured report meanings.

Those remain owned by the relevant subsystem contracts. Operator logs are diagnostic records and do not become system authority merely because they are persistent.

## Implementation and documentation ownership

A shared implementation should be preferred over separate progress/logging conventions in each script, while preserving each subsystem's existing behaviour and authority model.

Codex and other coding agents treat `system_docs/` as read-only. Behavioural changes discovered during implementation must be handed back for active contract review.
