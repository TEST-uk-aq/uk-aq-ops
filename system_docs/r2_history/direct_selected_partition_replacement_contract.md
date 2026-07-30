# Direct selected-partition replacement contract

## Authority and scope

This document defines the required direction for write-enabled R2 history repair and rebuild paths.

It supplements:

- [`integrity.md`](integrity.md);
- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md).

Where those documents describe a detected mismatch, gap or fault as the authority for whether an explicitly selected partition is repaired, this document is authoritative for the dedicated write-enabled SOS historical replacement path.

The same direct-replacement model is the required direction for future write-enabled history repair or rebuild paths. Existing generic Integrity, check-only, dry-run and non-SOS runtime behaviour remains unchanged until it is deliberately migrated under a separate implementation task.

This contract does not change Prune Daily candidate selection or deletion authority. Prune Daily continues to select connector-days from its own retention, source-identity and connector-day gate rules. Prune Daily MUST NOT add gap-driven repair logic and MUST NOT use Dropbox.

## Core principle

A write-enabled repair is authorised by its explicit selected scope, not by whether a comparison stage first reports a gap.

For an explicitly selected repair scope:

```text
selected day_utc values
x
selected connector IDs
x
selected pollutant codes
=
authoritative replacement targets
```

Gap and mismatch detection is read-only diagnostic information. It MAY explain why a repair was requested and MAY be recorded in the audit, but it MUST NOT decide whether an explicitly selected partition is rebuilt.

A selected partition MUST NOT become a no-op merely because:

- the Dropbox baseline already matches the current authoritative source;
- a detector reports no difference;
- the partition was repaired successfully in an earlier run;
- existing R2 content appears complete;
- no gap object was generated.

For a successful direct-replacement run, unchanged authoritative source content produces the same logical canonical observation content. Repeating the same selected scope is therefore safe and idempotent at the logical-data level.

## Dedicated SOS mode: immediate active requirement

For the dedicated write-enabled SOS historical replacement path, the exact targets MUST be derived directly from:

```text
explicit --from-day through --to-day
x
connector_id=1
x
explicit --repair-pollutants
```

The dedicated SOS route MUST NOT derive executable replacement targets from:

- `v2_observations.gaps`;
- gap indexes;
- mismatch classifications;
- source-versus-Dropbox row-count differences;
- source-versus-manifest hash differences;
- a requirement that a detector first mark the partition as faulty.

The existing gap detector MAY still run temporarily if needed to supply diagnostics or unchanged shared evidence, but its output MUST NOT filter, reduce, expand or suppress the explicit selected replacement scope.

The implementation SHOULD avoid running gap detection where the dedicated SOS path can acquire and validate the required source evidence directly without it.

## Required outcome for every selected SOS partition

Each explicit:

```text
day_utc + connector_id=1 + pollutant_code
```

MUST reach exactly one of these outcomes.

### Complete replacement

When source acquisition and canonicalisation are complete and at least one valid mapped canonical row remains:

1. persist immutable current-run SOS source evidence;
2. build the complete canonical replacement partition;
3. create exactly one tombstone for the selected pollutant prefix;
4. delete the existing exact selected prefix;
5. write the complete replacement Parquet and pollutant manifest;
6. rebuild affected parent manifests and observation indexes;
7. complete the ordered live verification contract.

This replacement occurs whether or not the baseline content differs.

### Authoritative no-data replacement

When SOS evidence conclusively proves that the selected partition has no observations, publish the contractually valid empty representation using the same explicit-scope replacement rules.

An uncertain empty result remains fail-closed and MUST NOT delete the existing partition.

### All rows excluded for no authoritative binding

When source rows exist but every source group is excluded only because no authoritative active timeseries binding exists:

- leave the existing selected partition unchanged;
- create no tombstone for that partition;
- record the aggregated warning and row counts;
- mark the selected partition as skipped for this specific reason.

This is not authoritative no-data.

### Blocked before mutation

When source acquisition, enumeration, parsing, mapping, canonicalisation or reproducibility is incomplete, ambiguous, contradictory or invalid:

- do not delete or write the selected partition;
- fail the affected selected scope before mutation;
- retain sufficient audit evidence to identify the blocking condition.

## Validation is not gap detection

Removing gap-driven repair authority MUST NOT remove any of these safeguards:

- complete source-file enumeration and identity pinning;
- UTC day coverage validation;
- source-label and unit validation;
- authoritative identity mapping;
- warning-only handling for established `no_authoritative_timeseries_binding` groups;
- fail-closed ambiguous or contradictory mapping handling;
- canonical row validation;
- immutable source counts, status counts and observation-content hashes;
- staged Parquet and manifest equality with source evidence;
- exact tombstone validation;
- dependency ordering and lock requirements;
- one post-PUT verification GET per changed object;
- final verified R2 evidence before Timeseries and Latest Snapshot reconciliation.

These are source and publication correctness checks. They do not determine whether an explicitly selected, otherwise valid partition should be rebuilt.

## Rerun behaviour

A later write-enabled run of an already completed selected partition follows the same process as the first run.

It MUST NOT require a newly detected gap. It MUST reacquire or reuse identity-pinned authoritative SOS source evidence under the normal source rules and build the complete replacement independently.

Expected outcomes are:

```text
unchanged authoritative source
-> same logical canonical observations, counts, status counts and content hash

revised authoritative source
-> newly authoritative logical canonical observations
```

The time and R2 request cost of the rerun are acceptable operational overhead. A fresh Dropbox backup is not required solely because the same selected day or pollutant is being run again.

## Future migration rule

When generic Integrity or another history repair path is later simplified, it MUST adopt this separation:

```text
selection decides what to rebuild
source validation decides whether rebuilding is safe
diagnostics explain observed differences
```

Do not add new repair paths where gap detection decides whether an explicitly selected partition is written.

Until a separate implementation task migrates an existing generic path, this future-direction clause does not silently change that path's active runtime behaviour.

## Minimal implementation acceptance for the dedicated SOS path

Before CIC-Test functional execution, the smallest targeted structural check genuinely required is:

> A qualifying dedicated SOS run for a selected partition whose Dropbox content already matches authoritative source evidence still produces the exact selected-prefix tombstone and complete replacement proposal.

Also retain the existing focused checks for:

- strict SOS connector-1 route selection;
- all-unmapped partition preservation;
- legacy R2-only IDs remaining diagnostic;
- AQI bypass;
- one post-PUT verification GET per changed object;
- no second broad final R2 scan;
- Timeseries and Latest Snapshot reconciliation remaining downstream of verified R2 history.

Functional validation remains the real CIC-Test run sequence defined in [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md) and the implementation plan.