# Integrity daily profile date selection

## Authority and scope

This document defines the authoritative UTC date-selection contract for the scheduled Integrity `daily` profile.

The implementation is owned by:

- `scripts/uk-aq-history-integrity/bin/daily_profile.py`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`

This document covers only how the daily profile chooses dates. Source acquisition, connector checks, repair planning and repair execution remain governed by [`integrity.md`](integrity.md).

Where active date-selection code differs from this document, this document is authoritative and the code must be brought into line before relying on the scheduled profile.

## Discovery source

The daily profile discovers available observation dates from the local Dropbox mirror of the active committed v2 observations tree.

It inspects only direct child directories whose names strictly match:

```text
history/v2/observations/day_utc=YYYY-MM-DD
```

Staging paths, overlays, archives, other history versions and malformed day-directory names do not participate in selection.

Date discovery is performed at the top-level observations-day boundary. It does not inspect connector directories before deciding whether a date or month is represented.

## Latest day and recent window

The newest discovered observations day becomes `latest_r2_observations_day`.

The recent part of the daily profile is the seven consecutive UTC calendar dates ending on that day:

```text
latest_r2_observations_day - 6 days
through
latest_r2_observations_day
```

Each date in that seven-day range is selected even when its own top-level R2 day directory is missing. This allows Integrity to detect and repair a missing day inside an otherwise represented recent range.

The daily profile does not infer or select dates after `latest_r2_observations_day`. A manual scoped run or another writer must first establish a later committed observations day before the scheduled profile advances beyond the current latest day.

## Historical month representation

A historical year/month is represented when at least one strictly parsed top-level observations day directory exists in that month and the month is earlier than the month containing `latest_r2_observations_day`.

Month representation is global across the observations tree:

- any connector can cause a month to be represented;
- representation is not calculated separately for each connector;
- the particular day that caused the month to be represented does not constrain the historical date selected within that month.

For every represented historical month, the profile constructs the date allocated to the current logical UTC run date. The constructed date is selected when it is a valid date in that historical month, whether or not that exact date already exists in R2.

For example, assume January 2025 contains only:

```text
history/v2/observations/day_utc=2025-01-31
```

If January 2025 is earlier than the latest represented month and the logical run is on day 1 of a month, the daily profile selects:

```text
2025-01-01
```

This remains true when the existing 31 January directory contains data for only one connector. That connector makes January 2025 represented for the global date-selection stage. Connector and source scope are applied later when Integrity checks the selected date.

If January 2025 is itself the latest represented month, it is not treated as a historical month. The profile instead selects the seven-day recent window ending on the latest discovered January date.

## Historical day-number allocation

The logical run date is UTC. Across each logical calendar month, historical day numbers 1 through 31 are allocated exactly once:

- logical days 1 through 25 select the same historical day number;
- in a 31-day logical month, days 26 through 31 also select the same day number;
- in a 30-day logical month, day 30 selects historical day numbers 30 and 31;
- in a 29-day February, day 28 selects 28 and 30, and day 29 selects 29 and 31;
- in a 28-day February, day 26 selects 26 and 29, day 27 selects 27 and 30, and day 28 selects 28 and 31.

A historical target is skipped only when that constructed calendar date is invalid for the represented historical month. For example, a selected historical day number 31 is skipped for April.

## Connector and source scope

Daily date selection is global and happens before connector-specific checking.

The selected dates do not imply that every connector is expected to exist on every selected day. After selection, Integrity applies the requested source, connector and pollutant scope and evaluates each relevant connector according to its authoritative source and mapping contract.

The date-selection stage must not become connector-specific unless this system contract is deliberately changed.

## Empty discovery and audit evidence

The daily profile must fail rather than invent a calendar range when no strictly parsed committed v2 observations day directories are discovered.

The run evidence records at least:

- the logical UTC run date and its source;
- `latest_r2_observations_day`;
- the recent start and end dates;
- the allocated historical day numbers;
- the number of represented historical months;
- every selected date and its selection reason;
- any catch-up logical dates applied by the scheduler state.
