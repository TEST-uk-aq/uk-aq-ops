# Dedicated SOS run-scoped source acquisition contract

## Authority and scope

This document is the authoritative orchestration amendment for source acquisition in the dedicated write-enabled SOS historical observation replacement path.

It supplements:

- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md);
- [`direct_selected_partition_replacement_contract.md`](direct_selected_partition_replacement_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md).

Where existing generic local-backfill chunking behaviour conflicts with this document, this document is authoritative only for the dedicated SOS source-acquisition stage. Generic Integrity, ordinary local backfills, AQI work, check-only mode, dry-run mode and non-SOS connectors remain unchanged.

## Core invariant

One operator-requested dedicated SOS run has exactly one source-acquisition scope:

```text
complete inclusive --from-day through --to-day
x
connector_id=1
x
complete explicit --repair-pollutants set
```

That complete scope MUST be acquired into one immutable run-scoped source cache before pollutant-partition proposal work begins.

Calendar-month, calendar-year or other wrapper chunk boundaries MUST NOT split the acquisition into separate build invocations when they belong to the same Integrity run.

A selected range such as:

```text
2026-06-17 through 2026-07-30
```

MUST therefore create one acquisition root and one completed acquisition manifest covering the full range. The operator MUST NOT be required to issue separate monthly Integrity runs.

## Source-file processing

The acquisition owner MUST:

1. receive the complete selected date range and pollutant set;
2. enumerate every annual SOS source file required by that complete range, including hour-ending boundary requirements;
3. open and parse each relevant annual source file no more than once during the run-scoped acquisition;
4. derive independent immutable `day_utc + connector_id=1 + pollutant_code` partition datasets;
5. complete and hash the acquisition manifest only after every selected partition dataset is present and validated;
6. expose the completed immutable cache to detector and proposal consumers without reopening the annual source files.

A date range crossing a calendar year remains one run-scoped acquisition. It may enumerate annual files for more than one source year, but it MUST NOT create a second acquisition merely because the year changes.

## Wrapper and invocation behaviour

Generic local backfill modes MAY retain calendar-month chunking where that behaviour is already established.

For:

```text
UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE=acquire
```

the repository-owned wrapper MUST bypass calendar-month window splitting and invoke the acquisition worker exactly once for the complete requested range.

The implementation MAY achieve this by either:

- adding a dedicated single-window branch to the existing wrapper; or
- moving the one acquisition invocation outside the generic monthly-window loop.

It MUST NOT make the acquisition directory appendable and MUST NOT merge multiple independently built acquisition manifests after the fact.

After acquisition completes, later detector and proposal operations MAY process the immutable partition datasets in bounded batches. Such batching MUST reuse the same completed acquisition root, run identity and manifest and MUST NOT start another source acquisition.

## Immutable cache identity

The run-scoped source cache remains fail-closed and immutable.

The acquisition root MUST:

- be unique to the Integrity run;
- be created once;
- contain one run identity;
- contain the complete requested range and pollutant set;
- contain one completed manifest whose hash covers its selected scope and partition identities;
- reject mutation or replacement after completion.

An existing acquisition root remains an error for a new build invocation. The correction required by this contract is to prevent the second build invocation, not to weaken the existing-root guard.

Consumers MUST validate that the completed manifest matches the expected run ID, complete requested date range, connector and pollutant set before reading any partition dataset.

## Failure behaviour and R2 safety

Source acquisition runs before proposal construction and before the single ordered live R2 phase.

If acquisition fails for any part of the complete selected range:

- the acquisition remains incomplete or failed;
- no selected partition from that Integrity run may proceed to live R2 mutation;
- no current-state reconciliation may run;
- the run fails with the acquisition error recorded;
- recovery is a new Integrity run with a new run-scoped acquisition root.

A successful sub-window inside a failed acquisition attempt is not an applied historical repair and MUST NOT be reported as live R2 success.

The implementation MUST NOT delete or overwrite an existing acquisition root automatically to continue the same failed run.

## Audit requirements

The dedicated SOS run audit MUST record at least:

- the complete operator-requested date range;
- the complete pollutant set;
- acquisition invocation count;
- acquisition root creation count;
- acquisition root and run identity;
- completed-manifest status and hash;
- selected day count;
- selected partition dataset count;
- source years and unique annual source-file count;
- source files opened and maximum opens per source file;
- source bytes and rows read;
- whether the range crossed a calendar-month or calendar-year boundary;
- detector and proposal rescans avoided.

For a successful dedicated run, both acquisition invocation count and acquisition root creation count MUST equal `1`.

The selected partition dataset count MUST equal:

```text
selected day count x selected pollutant count
```

except that this count still includes valid authoritative no-data and all-unmapped evidence datasets because their source classification must exist before their later partition outcome is decided.

## Minimal structural validation

Before deployment, perform only one focused cross-boundary regression using a small range such as:

```text
2026-06-30 through 2026-07-02
x
no2,pm25
```

The regression must prove:

1. the dedicated acquisition worker is invoked once;
2. the acquisition root is created once;
3. one completed manifest covers all three days and both pollutants;
4. six independent partition datasets are produced;
5. annual source files are not reopened by a second monthly acquisition;
6. detector and proposal consumers use the same completed cache;
7. acquisition-only execution writes no live R2 objects;
8. ordinary non-acquisition local-backfill monthly chunking remains unchanged.

Do not add a broad test suite.

## CIC-Test functional acceptance

After deployment, run the intended cross-month range as one operator command, for example:

```text
2026-06-17 through 2026-07-30
x
pm25,pm10,no2,o3
```

Acceptance requires:

- one source-acquisition invocation;
- one acquisition root and completed manifest;
- `44 x 4 = 176` partition datasets;
- each relevant annual SOS file opened no more than once;
- no `sos_source_acquisition_root_already_exists` error;
- all later partition proposals consuming the same completed immutable cache;
- the existing direct selected-partition replacement, ordered apply, GET-once verification and current-state reconciliation contracts remaining unchanged.

The operator must not need to split the run by calendar month.
