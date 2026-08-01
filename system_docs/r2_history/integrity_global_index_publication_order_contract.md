# Integrity global index publication order contract

## Authority and scope

This document is an authoritative amendment to:

- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`integrity_apply_progress_persistence_contract.md`](integrity_apply_progress_persistence_contract.md);
- [`sos_light_model.md`](sos_light_model.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md).

It defines the required dependency-aware planning, validation and publication order for changed global, scoped and latest R2 history index objects produced by write-enabled Integrity.

Where older wording or active code conflicts with this document, this document is authoritative for global index dependency ordering and pre-mutation publication-schedule validation.

This contract does not weaken proposal validation, R2 writer locks, post-PUT GET verification, durable mutation evidence, SOS-light per-day publication, indexes-last behaviour or fail-closed handling.

## Incident being prevented

A real CIC-Test SOS-light run successfully rebuilt and GET-verified every selected observation day, then failed when global index publication attempted:

```text
history/_index_v2/observations_timeseries_latest.json
```

before its changed scoped Timeseries index dependencies, including:

```text
history/_index_v2/observations_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=no2/manifest.json
```

The dependency verifier correctly blocked the parent because the child had not yet been written and GET-verified.

The underlying defect was that global proposal objects inherited lexical or locale-dependent key ordering rather than dependency ordering. A parent key containing `_latest` sorted before the scoped child path even though the parent depended on that child.

This deterministic ordering defect must be detected before live mutation begins.

## Dependency graph is authoritative

For every changed proposed object, the final proposal graph MUST distinguish:

1. changed current-run dependencies that must be published by the current apply;
2. unchanged current-run or baseline dependencies whose identity is already pinned and which are not part of the write set;
3. invalid, unresolved or cyclic dependencies.

The publication scheduler MUST use the declared and validated dependency graph for changed objects.

Lexical path sorting, locale-aware comparison, object insertion order, filesystem enumeration order and map iteration order MUST NOT determine dependency-sensitive publication order.

Publication ranks MAY be used to separate broad stages, but they are not sufficient where two objects in the same stage have a parent-child relationship.

## Required final publication schedule validation

After the final proposal graph is complete, and before the first live R2 DELETE or PUT, Integrity MUST derive and validate the complete changed-object publication schedule.

The schedule validator MUST:

1. include every changed proposed object exactly once;
2. include only objects in the actual mutation write set;
3. treat unchanged Dropbox or overlay dependencies as already satisfied external roots only when their identities are valid and pinned under the applicable provenance contract;
4. create an ordering edge from every changed dependency to every changed object that depends on it;
5. produce a deterministic topological order for all changed objects within their required writer-lock and publication stages;
6. fail closed before mutation when a changed dependency is missing from the write set;
7. fail closed before mutation when a dependency cycle exists;
8. fail closed before mutation when stage constraints contradict dependency order;
9. report the exact object and dependency keys for any unresolved edge or cycle.

The validated publication schedule MUST be the schedule used by canonical apply. Apply MUST NOT rebuild or replace it later through lexical sorting.

Where deterministic tie-breaking is required between independent nodes, it MAY use a documented bytewise key comparison only after all dependency constraints are satisfied.

## Global and latest index order

Global index publication remains last, after all selected day publication has completed successfully.

Within the global index-finalisation lock, changed index objects MUST be published in dependency order.

For observation Timeseries discovery metadata, the required relationship is:

```text
changed scoped Timeseries index manifests
-> changed aggregate or intermediate Timeseries indexes, where present
-> observations_timeseries_latest.json
```

Therefore:

```text
history/_index_v2/observations_timeseries/day_utc=<day>/connector_id=<id>/pollutant_code=<code>/manifest.json
```

MUST be written and GET-verified before a changed:

```text
history/_index_v2/observations_timeseries_latest.json
```

that depends on it.

The same rule applies to any other global or latest discovery parent:

```text
changed child index
-> changed aggregate index
-> changed latest or global parent
```

An object name containing `latest`, `global`, `manifest` or another naming convention does not itself establish authority or order. Declared validated dependencies establish order.

## Durable child evidence before parent publication

For every changed dependency edge:

```text
child -> parent
```

canonical apply MUST require:

```text
child PUT completed
-> child post-PUT GET verified
-> child verification evidence durably recorded
-> parent PUT may begin
```

An in-memory `r2_verified` flag without the required durable mutation evidence is insufficient where the progress-persistence contract requires a durability barrier.

The dependency check immediately before a parent PUT remains mandatory even when the schedule was validated before mutation. It is a runtime safety assertion, not a substitute for correct schedule planning.

## Failure behaviour

If a global index dependency unexpectedly fails during apply:

- the dependent parent MUST NOT be written;
- later dependent global or latest parents MUST NOT be written;
- the run MUST fail with the exact child and parent keys;
- already completed selected days remain valid published work;
- current-state reconciliation MUST remain blocked when its required global index publication has not completed;
- the failed run is not resumed;
- recovery is a fresh Integrity run with a newly validated proposal and publication schedule.

A deterministic dependency-order defect discovered after selected-day mutation is a planning failure that should have been caught before mutation. The report MUST classify it separately from an R2 PUT, GET or network failure.

## Audit evidence

The final proposal and apply audit MUST record:

- publication-schedule validation status;
- changed object count included in the schedule;
- changed dependency edge count;
- external satisfied dependency count by provenance source;
- deterministic schedule identity, such as a SHA-256 over the ordered canonical keys and dependency identities;
- global index publication order actually used;
- the GET-verification and durable-evidence state of every changed dependency before its parent starts;
- any unresolved dependency or cycle details;
- the last successfully published global index object before failure;
- whether latest/global parent publication began or remained untouched.

The audit MUST make it possible to prove that the apply order matched the validated schedule.

## Required focused structural checks

Before deployment, run only the smallest deterministic checks needed to prove structural viability. They MUST prove:

1. a changed scoped Timeseries index is ordered before `observations_timeseries_latest.json` when the latest object depends on it;
2. the result remains correct when input keys are deliberately supplied in the problematic lexical order with `_latest` first;
3. independent objects use deterministic tie-breaking without violating dependency order;
4. an unresolved changed dependency fails before the first live mutation;
5. a dependency cycle fails before the first live mutation and reports the involved keys;
6. an unchanged identity-pinned Dropbox dependency is treated as an external satisfied root and is not added to the write set;
7. a changed child is PUT, GET-verified and durably evidenced before its changed parent PUT begins;
8. failure of the child verification or durability barrier prevents the parent PUT;
9. global indexes remain after all selected day publication;
10. the exact validated schedule is used by apply rather than re-sorting global operations lexically.

The regression fixture MUST include the real key shape:

```text
history/_index_v2/observations_timeseries_latest.json
history/_index_v2/observations_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=no2/manifest.json
```

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in CIC-Test

After deployment, validate through a real CIC-Test operation:

1. run a scoped or multi-day SOS-light replacement that changes scoped Timeseries indexes and the latest Timeseries index;
2. confirm publication-schedule validation succeeds before the first R2 mutation;
3. confirm every changed scoped Timeseries index is written and GET-verified before `observations_timeseries_latest.json`;
4. confirm durable child verification evidence precedes the latest parent PUT;
5. confirm the latest parent is written only after all changed dependencies succeed;
6. confirm current-state reconciliation begins only after required global index publication completes;
7. confirm the final audit schedule identity matches the order actually applied.

Functional acceptance belongs in real CIC-Test operation. Pre-deployment checks remain structural and narrowly targeted.
