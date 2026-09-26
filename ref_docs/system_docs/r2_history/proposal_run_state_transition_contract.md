# Proposal to run-state transition contract

## Authority and scope

This document is an authoritative amendment to:

- [`proposal_dependency_provenance_contract.md`](proposal_dependency_provenance_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`sos_light_model.md`](sos_light_model.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

It defines the required behaviour when validated planner proposals are transferred through the Python Integrity coordinator into the final `runState.objects` consumed by the R2 apply process.

Where older wording, coordinator behaviour or active code conflicts with this document, this document is authoritative for proposal-to-run-state transition provenance.

The immediate failure corrected by this contract occurred when the JavaScript metadata planner correctly produced `planned_overlay` dependency identities, but the Python coordinator relabelled those identities as `overlay` while constructing the final run state. The final pre-mutation validator correctly rejected the resulting contradictory graph.

## Semantic preservation across the coordinator boundary

The proposal-to-run-state transition MUST preserve dependency identity semantics. It is not a provenance reclassification stage.

For every dependency identity supplied by an authoritative planner result, the coordinator MUST preserve:

```text
source
sha256
bytes
object key
```

unless a documented transformation deliberately changes the dependency body. A purely representational copy, merge, serialisation or normalisation MUST NOT change `source`.

In particular:

```text
planner source = planned_overlay
-> final runState source = planned_overlay

planner source = dropbox
-> final runState source = dropbox

planner source = overlay
-> final runState source = overlay
```

The coordinator MUST NOT infer `overlay` merely because a dependency body is available in a local overlay directory.

Local storage location and dependency provenance are separate concepts:

```text
local file location
!=
dependency source identity
```

A staged current-run object may be physically stored in an overlay workspace while still requiring `source = planned_overlay`.

## Final staged-object invariant

Before launching the Node apply process, the Python coordinator MUST validate the complete final run-state graph.

For every dependency edge in `runState.objects`:

### Dependency present in the final staged write set

When the dependency object key is present as a changed object in final `runState.objects`:

```text
source = planned_overlay
sha256 = final staged object SHA-256
bytes = final staged object byte length
```

The dependency identity MUST match the exact final staged body.

### Dependency absent from the final staged write set

When the dependency object key is not present in the final staged write set:

```text
source = the pinned external baseline source
sha256 = pinned external body SHA-256
bytes = pinned external body byte length
```

The permitted external baseline source is defined by the applicable model and may include `dropbox` or an immutable `overlay` object.

An external dependency MUST NOT be relabelled `planned_overlay` unless it is actually present as a changed staged object in the final write set.

## Changed-object authority

The final staged write set is authoritative for whether a dependency is a current-run staged object.

The coordinator MUST derive or verify the invariant using the final changed objects, not merely:

- the presence of a local file;
- the presence of a proposal or audit record;
- the directory from which the body was read;
- a generic local resolver result;
- an earlier status that may have been superseded.

For a final changed object, any parent dependency identity MUST use `planned_overlay` and MUST match the changed object body identity.

For an unchanged or absent object, the parent dependency identity MUST retain its pinned external provenance.

## No silent reconstruction of planner identities

When the planner already provides a complete dependency identity, the coordinator SHOULD copy that identity without reconstruction.

If reconstruction is genuinely required, it MUST be performed using an explicit rule that distinguishes:

```text
changed final staged object -> planned_overlay
unchanged Dropbox baseline -> dropbox
unchanged immutable local external object -> overlay
```

A generic rule such as the following is forbidden:

```text
body found locally -> overlay
```

The coordinator MUST fail closed if it cannot prove the correct source, SHA-256 and byte length.

## Coordinator validation and error classification

The Python coordinator MUST perform a focused final transition validation before invoking the Node apply command.

The validation MUST prove at least:

- every dependency whose key is in the final changed write set is labelled `planned_overlay`;
- every `planned_overlay` dependency key exists in the final changed write set;
- every staged dependency SHA-256 and byte length match the final staged object;
- every external dependency retains an allowed pinned external source;
- no dependency source changed merely because of serialisation, merge or local path resolution;
- no unchanged planning record was introduced into the final mutation write set.

A failure at this boundary MUST be reported as a coordinator proposal-transition error and MUST occur before the Node apply process and before any R2 DELETE or PUT.

The Node apply validator remains mandatory and fail-closed as an independent final safety boundary. This coordinator validation supplements it; it does not replace or weaken it.

## SOS-light publication graph

For SOS-light, the transition rules apply to the entire publication graph, including:

- Parquet objects;
- pollutant manifests;
- connector manifests;
- day parent manifests;
- scoped Timeseries indexes;
- latest or global Timeseries indexes.

A current-run changed child at any level MUST remain `planned_overlay` when referenced by its parent. This includes multi-level chains where a changed latest index depends on changed scoped indexes, which depend on changed manifests, which depend on changed Parquet.

The transition MUST preserve provenance independently for every edge. Correct provenance at one graph level does not excuse relabelling at another.

## Audit evidence

Run-state preparation and failure reports SHOULD distinguish:

```text
planner dependency source
final run-state dependency source
object present in final write set
planner sha256 and bytes
final staged sha256 and bytes
transition validation result
```

When a mismatch is detected, the error SHOULD identify:

- parent object key;
- dependency object key;
- planner source;
- final source;
- expected staged or external identity;
- actual identity.

This evidence MUST remain local and MUST be produced before mutation.

## Minimal structural validation

Before operational CIC-Test execution, use only the smallest targeted checks needed to prove:

1. a planner result containing a changed child dependency marked `planned_overlay` passes through the real Python proposal-to-run-state transition unchanged;
2. the final parent dependency source, SHA-256 and bytes match the final staged child object;
3. an unchanged Dropbox-backed dependency remains `dropbox` and is absent from the final staged write set;
4. an unchanged immutable external overlay dependency remains `overlay` and is absent from the final staged write set;
5. the Python transition validator rejects a staged child relabelled `overlay`;
6. the Python transition validator rejects a `planned_overlay` dependency absent from the final staged write set;
7. the generated run state is accepted by the existing Node final proposal validator;
8. the failure path launches no Node apply mutation and performs no R2 DELETE or PUT.

The primary regression MUST exercise the real coordinator transformation rather than constructing the final run state by hand.

Do not add a broad speculative test suite. Functional validation belongs in a real CIC-Test operation after deployment.
