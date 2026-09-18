# Integrity run-scoped core snapshot identity

## Authority and scope

This document defines the authoritative core-snapshot identity contract for every UK AQ R2 History Integrity invocation.

It applies to:

- `--check-only`;
- `--run-backfill --dry-run`;
- real generic Integrity repair;
- real SOS-light repair;
- detector, proposal, apply and final-verification child processes;
- any helper that resolves connector, station, timeseries or observed-property identity from the committed v2 core snapshot.

It supplements [`integrity.md`](integrity.md), [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md), [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md) and [`implementation_safety_contract.md`](implementation_safety_contract.md).

Where an older document or implementation permits a child stage to select a new core snapshot from the current clock, this document is authoritative.

## Core invariant

At run initialisation, each Integrity invocation MUST select the latest available complete committed v2 core snapshot from the chosen Dropbox baseline.

That exact snapshot is then pinned for the whole invocation, from initialisation through final reporting. Every later stage MUST use the identity supplied by the top-level coordinator.

Integrity MUST NOT require a core snapshot for the current UTC date. If today's snapshot does not yet exist, the latest earlier complete committed snapshot is selected.

A run that begins before midnight UTC and continues after midnight UTC MUST continue using the snapshot selected at run initialisation. Crossing a UTC day, month or year boundary MUST NOT trigger another selection.

A later, separate Integrity invocation repeats the same latest-complete selection and may therefore choose a newer snapshot.

## Latest complete selection

Selection is based on snapshots that actually exist in the chosen Dropbox baseline, not on an expected path derived from the current date.

At top-level run initialisation, Integrity MUST:

1. discover the available committed v2 core snapshot candidates;
2. order candidates by `day_utc` newest first;
3. validate candidates in that order;
4. select the first candidate that is physically complete and structurally valid;
5. fail the run if no complete committed candidate exists.

A candidate is complete only when:

- its canonical day manifest exists, is readable and has the expected v2 shape;
- the manifest day, prefix and immutable manifest identity agree with its directory and bytes;
- every required object referenced by the manifest exists in the chosen Dropbox baseline;
- every referenced object matches its declared compressed and uncompressed byte counts and SHA-256 identities;
- required compressed objects can be decompressed and parsed;
- declared row counts match the parsed rows;
- all required connector, station, timeseries, phenomenon and observed-property identity tables are present and loadable;
- the committed checksum file exists and agrees exactly with the manifest and referenced object bytes.

Snapshot eligibility is deliberately limited to physical completeness and structural validity. Cross-table semantic relationship findings MUST NOT make an otherwise complete snapshot ineligible. Examples include a timeseries connector that differs from its station connector, a missing related identity row, or a phenomenon without an observed-property mapping. Integrity MUST record these findings as warnings for diagnosis, but MUST keep the candidate eligible and MUST NOT fall back to an older snapshot solely because of them.

Semantic relationship checks may still be used by later Integrity diagnostics or repair logic where relevant. They are not a completion marker for selecting the run-scoped core snapshot.

A newer physically incomplete, partial, unreadable or byte-invalid candidate is not eligible. Integrity MAY continue to the next older candidate, but MUST record the skipped candidate and the structural reason it was ineligible.

This fallback is only between already available committed core snapshots during top-level selection. It MUST NOT be used later by a child process to replace the pinned snapshot.

## Exact identity

The run-scoped identity MUST contain enough immutable information to address and audit the exact selected snapshot. It MUST include at least:

```text
core_snapshot_day_utc
core_snapshot_manifest_key
```

The canonical manifest key has the form:

```text
history/v2/core/day_utc=<core_snapshot_day_utc>/manifest.json
```

Where an authoritative manifest hash, SHA-256 value or equivalent immutable byte identity is already available, the run-scoped identity MUST also carry and validate it. The implementation MUST NOT invent a weaker synthetic identity when a stronger existing manifest identity is available.

The requested historical observation range is not part of the core-snapshot selector. A repair for an old observation day still uses the latest complete committed core snapshot selected for that Integrity invocation.

## Selection and pinning

After selecting the latest complete candidate, the top-level coordinator MUST:

1. construct the immutable run-scoped identity;
2. record the selected identity and any newer ineligible candidates before detector or proposal work starts;
3. make that same identity available to every child process and helper that consumes core data.

After this point, no stage may independently perform latest-snapshot discovery or derive a core snapshot day from the current UTC clock.

The following are prohibited after run initialisation:

- using `today`, `now`, `utcnow`, `Date.now()` or equivalent to construct a core path;
- silently selecting the newest locally visible core snapshot;
- refreshing the core snapshot part-way through a run;
- falling back from a missing pinned snapshot to another date;
- copying or relabelling a different snapshot to satisfy the requested key;
- resolving detector and proposal identity from different core snapshots.

## Process-boundary propagation

The coordinator MUST pass the complete run-scoped identity explicitly through every relevant process boundary.

Permitted propagation mechanisms include explicit CLI arguments, immutable run JSON, an immutable environment payload or another deterministic run-owned interface. The mechanism must be explicit, inspectable and validated by the receiver.

A child process MUST NOT treat the supplied identity as optional when it reads core data. At child startup it MUST:

1. require the run-scoped identity;
2. validate the canonical manifest-key format;
3. require the pinned manifest to exist in the chosen combined-local or Dropbox-backed view;
4. validate the supplied immutable manifest identity where present;
5. require exact equality with the coordinator identity recorded for the run;
6. fail before proposal construction or live R2 mutation when any check fails.

Reconstructing the same date independently is not equivalent to receiving and validating the coordinator identity.

## Combined-local object view

When Integrity creates a combined-local object view, it MUST expose the exact pinned core snapshot selected by the coordinator.

Every detector, proposal builder and SOS-light assembly stage MUST resolve core objects through that pinned manifest key. A child MUST NOT request a second core day merely because the wall-clock date has advanced.

If the pinned manifest or a required child object is unavailable after selection, the affected Integrity invocation fails closed. It MUST NOT attempt another core date.

## Mode consistency

Check-only, dry-run and write-enabled modes MUST use the same latest-complete selection and propagation contract.

Changing Integrity mode MUST NOT change the meaning or lifetime of the selected core identity. In particular:

- check-only and dry-run remain non-mutating;
- real repair still validates the pinned identity before any live R2 mutation;
- SOS-light uses the same pinned identity for source mapping, local assembly, proposal validation, apply and final verification;
- generic Integrity uses the same pinned identity for detection, planning, repair and verification;
- current-state reconciliation may consume final verified repair evidence, but MUST NOT cause the historical run to refresh or replace its pinned core snapshot.

## Failure behaviour

Integrity MUST fail before proposal construction or live R2 mutation when:

- no physically complete and structurally valid committed core snapshot is available at run initialisation;
- no run-scoped core identity was established;
- a child receives no identity;
- a child receives an identity different from the coordinator identity;
- the pinned manifest key becomes unavailable;
- the manifest identity does not match the pinned value;
- a stage attempts to construct or select a different core snapshot;
- detector and proposal stages cannot prove they used the same snapshot.

A semantic relationship warning inside a physically complete snapshot is not one of these selection failures.

The error report MUST include the coordinator identity, the child or requested identity, the affected stage and the failed validation. It MUST NOT expose credentials or unrelated environment values.

## Audit contract

Every Integrity JSON report, Markdown summary and main run log MUST record the pinned core snapshot identity, including at least:

- discovered candidate days;
- any newer structurally ineligible candidates and their rejection reasons;
- selected core snapshot day;
- canonical manifest key;
- immutable manifest hash or equivalent identity where available;
- confirmation that the selected snapshot was the latest physically complete committed candidate;
- semantic relationship warnings found in the selected snapshot, including check name and row count;
- confirmation that detector, proposal and apply consumers used the same identity;
- any mismatch or missing-identity failure;
- whether the invocation crossed midnight UTC after selection.

For subprocesses, the audit evidence MUST make it possible to correlate the child identity with the top-level Integrity run identity.

## Minimal structural validation

Before deployment, perform only the smallest deterministic regression required to validate selection and the process boundary.

The focused check MUST prove:

1. no snapshot exists for the simulated current day;
2. the coordinator selects the newest earlier physically complete committed snapshot;
3. a newer structurally incomplete candidate is skipped and recorded before an older complete candidate is selected;
4. a physically complete candidate with semantic relationship warnings remains eligible and records those warnings;
5. the simulated clock advances after selection;
6. the child still resolves the pinned manifest key;
7. no current-day or newly advanced-day core path is constructed for that invocation;
8. missing or contradictory child identity fails before proposal or apply;
9. check-only, dry-run and write-enabled modes receive the same run-scoped identity;
10. a later separate invocation may independently select a newer snapshot after it becomes complete.

This targeted regression is genuinely required because the fault depends on date-derived path selection and long-running processes crossing UTC midnight. Do not add a broad speculative pre-deployment test suite.

## CIC-Test functional acceptance

After deployment, functional validation occurs through a real CIC-Test Integrity operation on the dedicated Integrity machine.

Acceptance requires:

- the latest available physically complete committed core snapshot selected at run initialisation;
- no requirement for a current-day snapshot;
- semantic relationship findings recorded as warnings without rejecting the selected snapshot;
- every child stage reporting the same manifest key and immutable identity;
- no clock-derived replacement core path after midnight;
- proposal and apply validation using the pinned snapshot;
- normal mode-specific mutation rules remaining unchanged;
- complete audit evidence in the run log and reports.

A development laptop is not the functional-test environment.
