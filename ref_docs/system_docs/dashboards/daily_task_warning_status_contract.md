# Daily task warning status contract

## Purpose

This contract defines how the UK AQ Operations dashboard presents a daily task that completed successfully at the task level but carries one or more structured operational warnings in its persisted run summary.

The first required use is Daily Stations when one or both isolated UK-AIR SOS reference stages fail under the contract in [`../ingest/daily_stations_sos_isolation_contract.md`](../ingest/daily_stations_sos_isolation_contract.md).

This contract owns dashboard presentation only. It does not decide whether a producer is allowed to downgrade a failure to a warning.

## Authoritative warning signal

The dashboard MUST derive this presentation only from the existing daily-task run `summary`.

A run has a structured task warning when:

- `summary` is a JSON object; and
- `summary.warnings` is a non-empty array.

The producer-specific contract owns the warning objects and their meanings. For the Daily Stations SOS isolation path, each applicable warning uses the stable code:

`uk_air_sos_reference_refresh_failed`

The dashboard MUST NOT infer this warning state from arbitrary log text, `error_message`, HTTP-status substrings, task names or other heuristics.

## Status presentation

The persisted/effective daily-task status remains authoritative.

When the base task status renders as `Finished` and the run has a structured task warning, the dashboard MUST:

- keep the normal successful `Finished` status pill unchanged;
- render a second yellow warning pill immediately alongside it;
- label the second pill exactly `WARNING`.

The warning pill is additive. It MUST NOT replace `Finished`, rewrite the stored status, or make the row appear failed.

A failed run MUST continue to render as `Failed`. The presence of a `summary.warnings` array MUST NOT override a failed, running, scheduled, overdue or otherwise non-finished base state.

Other independent additive indicators, including the existing History Integrity `DRY RUN` pill, remain independent and MAY coexist with the warning pill where their own contracts apply.

The existing dashboard warning/yellow visual treatment SHOULD be reused rather than introducing a competing warning colour or status vocabulary.

## Summary dropdown

The expanded daily-task JSON summary MUST preserve and display the producer-supplied `summary` object, including the complete bounded `warnings` array.

For each Daily Stations SOS warning this makes the human-readable `reason`, warning `code`, connector identity and failed stage list visible in the existing dropdown without a second dashboard-specific reason field.

The dashboard MUST NOT strip, flatten, rename or replace warning fields merely for display.

## Delivery paths

The rule applies to the shared Operations dashboard presentation regardless of whether the daily-task rows arrive through:

- the hosted dashboard API Worker;
- the local Python dashboard backend;
- the local MySQL rolling daily-task cache.

Those delivery paths MUST preserve the authoritative `summary` JSON sufficiently for the front end to detect `summary.warnings` and show the original JSON in the dropdown.

No new database status value is required by this contract. A producer that completes under an authorised warning path remains a `Finished` daily-task run with additional structured summary evidence.

## Scope and non-goals

This contract does not:

- permit arbitrary task failures to become warnings;
- define the Daily Stations SOS isolation decision;
- change daily-task status RPC semantics;
- introduce a generic warning database column;
- replace producer-specific warning contracts;
- change History Integrity dry-run semantics.

## Validation

No synthetic pre-implementation warning test programme is required.

Before deployment, establish only structural viability:

- the daily-task payload used by the dashboard still carries `summary`;
- the front end can identify a non-empty `summary.warnings` array without changing base status calculation;
- the existing JSON dropdown continues to render the complete summary;
- the existing yellow warning pill style can be reused.

Functional acceptance occurs after deployment through real TEST operation. For a Daily Stations run that completes under the isolated SOS warning path, confirm:

- the row still shows `Finished`;
- a yellow `WARNING` pill appears alongside it;
- expanding the row shows the warning reason and structured warning fields in the JSON summary;
- a normal Finished run with no warnings does not gain the warning pill;
- failed runs remain Failed.
