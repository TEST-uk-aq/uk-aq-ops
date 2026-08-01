# Integrity preflight generation and journal completion contract

## Status and authority

This document is an authoritative amendment to:

- `integrity_global_index_publication_order_contract.md`
- `integrity_apply_progress_persistence_contract.md`
- `proposal_dependency_provenance_contract.md`
- `integrity_apply_safety_contract.md`

Where wording overlaps, the stricter safety requirement applies.

## Purpose

This contract closes two remaining Integrity safety gaps:

1. a generated or finalised index must not become a newly discovered mutation after live apply has begun;
2. the mutation-journal hash, reconciliation, state-write accounting and checkpoint-failure evidence must be exact and independently verifiable.

## 1. Complete generated-index graph before mutation

Before the first live R2 `DELETE` or `PUT`, the planner and finaliser must materialise the complete set of objects that could be changed by the run.

For every proposed generated or finalised object, preflight must determine and retain:

- the exact R2 key;
- canonical bytes and SHA-256 identity;
- whether the object is changed;
- its complete direct dependency list;
- the resolved identity and provenance of every dependency;
- its publication stage;
- whether it is included in the mutation write set.

This requirement includes, where applicable:

- day connector and day parent manifests;
- generic scoped indexes;
- scoped Timeseries indexes;
- latest or index-of-indexes objects;
- the latest Timeseries index;
- the latest snapshot.

A live apply callback must not introduce a changed key that was absent from the validated proposal graph and frozen publication schedule.

A generated-index callback may only execute the exact bytes, key, dependencies and schedule position that were finalised during preflight. It must not independently discover, reorder, regenerate or expand the mutation set during live apply.

A generated object with `changed=false` is an audit/planning record only. It must be excluded from the mutation write set, publication schedule, post-PUT verification and mutation journal.

A generated object with `changed=true` must contain its real direct dependencies. `dependencies: []` is valid only for a genuine leaf object and must be consistent with the object type and validated graph. It must not be used as a placeholder for an unresolved generated parent.

After all proposal bytes and dependency identities are finalised, the implementation must:

1. validate the complete graph;
2. fail closed for missing changed dependencies, cycles, stage conflicts or unresolved identities;
3. construct the deterministic topological publication schedule required by `integrity_global_index_publication_order_contract.md`;
4. freeze the schedule identity and proposal identities before the first mutation.

If a key, byte identity, dependency set or publication stage differs from the frozen schedule during apply, the run must fail closed. If mutation has already begun, the failure record must preserve the exact completed mutation boundary and must not publish later schedule positions.

## 2. Exact mutation-event hash contract

Every append-only mutation-journal event must use:

```text
integrity-apply-mutation-event-v1
```

The event hash input must:

- include the event contract version;
- include `previous_event_sha256`;
- exclude only the event's own `event_sha256` field;
- recursively sort all JSON object keys;
- preserve array order;
- use compact JSON with no insignificant whitespace;
- encode the canonical JSON as UTF-8;
- use SHA-256 represented as lowercase hexadecimal.

The first event must use `previous_event_sha256: null`. Every later event must contain the exact `event_sha256` of the immediately preceding event.

Journal events are append-only. An event must never be rewritten after its hash has been published.

## 3. Independent coordinator verification

The Python coordinator must not trust embedded event hashes or aggregate counters supplied by Node.

Before reporting apply success, it must independently:

- parse every NDJSON mutation event;
- verify the event contract version;
- recompute every event SHA-256 from the canonical hash input;
- verify the complete previous-hash chain and final tail identity;
- verify the run and journal identities;
- reconcile journal event counts and byte counts;
- reconcile mutation-specific PUT, post-PUT GET and deletion totals;
- reconcile journal totals with Node completion state and coordinator state.

Any mismatch must fail closed and must prevent a successful completion claim.

A journal created before `integrity-apply-mutation-event-v1`, or lacking its required versioned event-hash fields, must be classified as an unsupported legacy journal contract rather than silently accepted or misreported as current-format corruption. Integrity does not resume failed legacy runs.

## 4. Complete-state write accounting

Every terminal path, including early persistence initialisation failure, ordinary apply failure and success, must expose complete-state write counts separately as:

- Node complete-state writes;
- coordinator complete-state writes;
- total complete-state writes.

Compact checkpoint writes must not be included in any complete-state write count.

A retained legacy aggregate field may remain only as an explicit alias of the total and must reconcile exactly.

## 5. Compact-checkpoint failure evidence

When an apply operation fails and the attempt to persist its compact failure checkpoint also fails, the terminal evidence must preserve both errors separately:

- the primary apply or mutation error;
- the compact-checkpoint persistence error.

The checkpoint error must not replace or obscure the primary failure.

The terminal evidence must also preserve:

- the last successfully persisted compact checkpoint identity;
- the failed day or global scope;
- the failed action and publication stage;
- the publication level reached;
- the exact completed mutation boundary;
- confirmation that later days and later publication stages were untouched.

The run must fail closed and must not continue publication after a compact-checkpoint persistence failure.

## 6. Required implementation proof

The implementation must provide focused proof that:

- a deliberately parent-first input graph is converted to the correct child-before-parent schedule;
- the latest Timeseries index is ordered after all changed scoped Timeseries children;
- a changed generated parent with unresolved or placeholder dependencies is rejected before mutation;
- an apply callback attempting to introduce an unscheduled changed key is rejected;
- unchanged generated objects remain external/audit-only and are not written;
- journal events are independently rehashed and reconciled by the coordinator;
- complete-state and compact-checkpoint write counts remain distinct;
- a primary apply error and a checkpoint persistence error are both retained.

Functional validation must then occur through a real operation on the TEST system after deployment. No production operation is authorised by this contract.
