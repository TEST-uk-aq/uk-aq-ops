# R2 Integrity final staged write-set provenance contract

## Authority and scope

This document is an authoritative amendment to:

- [`proposal_dependency_provenance_contract.md`](proposal_dependency_provenance_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

It defines how dependency ownership and provenance MUST be finalised after all proposal builders, complete connector-day replacement rules, exact-prefix tombstones, preservation rules and metadata finalisers have produced the complete mutation graph.

Where older wording or active code conflicts with this document, this document is authoritative for final staged write-set membership and the dependency identities derived from that membership.

The immediate failure that exposed this gap occurred during a real CIC-Test SOS repair for 17 July 2026 through 29 July 2026. A pollutant manifest was byte-identical to the pinned Dropbox baseline during initial planning, but complete connector-day replacement later promoted it into the final write set. Its parent connector manifest still recorded the dependency source as `dropbox`. Final transition validation correctly rejected the graph before Node apply and before any live R2 mutation.

## Planning state and final apply state are different stages

Initial planning may correctly classify an object as unchanged against the pinned baseline:

```text
proposal.changed = false
planner_source = dropbox
```

That initial classification is not always the final apply classification.

After exact-prefix tombstones, complete connector-day replacement and preservation closure have been resolved, an unchanged baseline object MAY need to be staged and written again so that it survives a deliberate prefix deletion or participates in a complete canonical replacement.

The implementation MUST distinguish:

```text
initial content comparison
from
final staged write-set membership
```

`proposal.changed` describes whether the proposed body differed from the planning baseline at the point it was produced. It MUST NOT be treated as the sole authority for final mutation ownership after later replacement promotion.

## Final staged write set is authoritative

The final staged write set is the complete set of object keys whose bodies the current run will PUT after all mutation planning and replacement promotion are complete.

For every dependency identity in the final immutable proposal graph:

```text
if dependency_object_key is in final_staged_write_set:
    source = planned_overlay
    sha256 = exact staged body SHA-256
    bytes = exact staged body byte length
else:
    source = the pinned external baseline source
    sha256 = exact pinned baseline body SHA-256
    bytes = exact pinned baseline body byte length
```

This rule applies regardless of whether the staged body:

- differs from the baseline;
- is byte-identical to the baseline;
- originated as a changed source-derived proposal;
- originated as an unchanged Dropbox planning record;
- was promoted only because an enclosing prefix will be deleted and rebuilt.

A key MUST NOT appear in the final staged write set while a parent, index or latest object describes that dependency as `dropbox`, `overlay` or any other external source.

A key absent from the final staged write set MUST NOT be described as `planned_overlay` merely because a planning record exists.

## Forced republication after exact-prefix deletion

When the current run schedules an exact-prefix deletion or complete connector-day replacement, the final planner MUST compute the full preservation and republication closure for that deleted scope before mutation.

Every object that must exist after the replacement and that would otherwise be removed by the deletion MUST be one of:

1. deliberately omitted because it is no longer valid;
2. recreated from a changed current-run proposal;
3. restaged from a pinned byte-identical baseline body.

An object in case 3 is a forced republication. It MUST:

- have an exact locally available body before mutation;
- be added to the final staged write set;
- retain its exact baseline bytes and SHA-256 when the body is unchanged;
- change its final dependency source to `planned_overlay`;
- be written and GET-verified through the normal staged-object apply path;
- be published before any parent or index that depends on it.

The earlier planning source MAY remain in a separate audit field such as:

```text
planner_source = dropbox
baseline_source = dropbox
promotion_reason = exact_prefix_replacement
```

It MUST NOT remain as the final dependency `source` once the object has been promoted into the staged write set.

## Dependency identities MUST be rebuilt after promotion

A coordinator MUST NOT copy planner dependency identities unchanged into final `runState.objects` after final write-set promotion.

After the final staged write set has been computed, dependency identities for every parent, connector manifest, day manifest, scoped index, latest index and global index MUST be rebuilt or normalised against that final set.

The required transition is:

1. assemble all source-derived, compatibility and metadata proposals;
2. assemble all exact tombstones and complete-replacement scopes;
3. compute the preservation and forced-republication closure;
4. produce the final staged write set;
5. ensure every staged key has an exact local body identity;
6. rebuild every dependency identity from final staged membership;
7. validate the complete immutable graph;
8. only then launch Node apply.

The graph MUST be frozen after step 7. No later stage may add a staged key, change an object body or retain stale dependency provenance without rerunning final transition validation.

## Transition validation invariant

Before Node apply and before the first live R2 DELETE or PUT, the coordinator MUST validate every dependency edge using the final staged write set.

For a dependency in the final staged write set, validation MUST require:

```text
final source = planned_overlay
final bytes = staged object bytes
final sha256 = staged object SHA-256
```

For a dependency outside the final staged write set, validation MUST require:

```text
final source = pinned external source
final bytes = pinned external body bytes
final sha256 = pinned external body SHA-256
```

A body identity match is not sufficient when the ownership source is contradictory. The validator MUST fail closed even when bytes and SHA-256 match exactly.

The failure report MUST include at least:

```text
parent_object_key
dependency_object_key
dependency_in_final_staged_write_set
planner_source
final_source
expected_source
expected_bytes
actual_bytes
expected_sha256
actual_sha256
promotion_reason, when applicable
```

The Node apply validator MUST remain strict. This contract MUST be implemented in coordinator finalisation rather than by weakening apply validation.

## SOS-light authority boundary

This contract does not change SOS-light source authority.

For SOS-light:

- fresh SOS data remains authoritative for selected connector `1` observation content;
- the chosen Dropbox snapshot remains the pinned baseline for retained and byte-identical content;
- a forced republication may copy a pinned Dropbox body into the staged overlay;
- final staged ownership then becomes `planned_overlay` because the current run will PUT that body;
- the original Dropbox origin remains audit evidence only;
- live R2 MUST NOT become planning or preservation input merely to implement this transition.

## Relationship to unchanged proposal records

The rule in [`proposal_dependency_provenance_contract.md`](proposal_dependency_provenance_contract.md) that an unchanged proposal remains external and absent from the mutation set continues to apply when no later replacement rule promotes that object.

For clarity:

```text
unchanged and not promoted
-> absent from final staged write set
-> final dependency source remains dropbox

unchanged but promoted for forced republication
-> present in final staged write set
-> final dependency source becomes planned_overlay
```

This document supersedes any interpretation that `proposal.changed = false` permanently prevents later final write-set membership.

## Mutation and publication order

A forced-republication object is a normal staged current-run object for apply ordering and verification.

It MUST:

- be PUT after any required deletion and in the correct dependency rank;
- be GET-verified for exact bytes and SHA-256;
- complete before a dependent parent or index is published;
- be included in mutation counters and audit evidence;
- be treated as incomplete if apply fails before verification.

Byte-identical forced republication does not permit skipping the PUT when an earlier exact-prefix deletion would remove the object.

## Audit evidence

Run state and reports MUST distinguish:

- initial `proposal.changed` state;
- planner or baseline source;
- final staged write-set membership;
- forced-republication count;
- promotion reason;
- final dependency source;
- staged bytes and SHA-256;
- PUT and GET-verification outcome.

A useful promoted-object record is:

```text
object_key
proposal_changed = false
planner_source = dropbox
included_in_final_staged_write_set = true
promotion_reason = exact_prefix_replacement
final_source = planned_overlay
sha256
bytes
```

## Minimal structural validation

Before operational CIC-Test execution, run only the smallest targeted deterministic checks needed to prove:

1. a changed proposal in the final staged write set resolves as `planned_overlay`;
2. an unchanged proposal not promoted into the final staged write set remains `dropbox` and is not written;
3. a byte-identical Dropbox object promoted by complete connector-day or exact-prefix replacement enters the final staged write set;
4. the promoted object's bytes and SHA-256 remain exact while its final dependency source becomes `planned_overlay`;
5. every parent and index dependency identity is rebuilt after promotion rather than copied unchanged from planner output;
6. final transition validation rejects a staged dependency still labelled `dropbox` even when its bytes and SHA-256 match;
7. final transition validation rejects an unstaged dependency labelled `planned_overlay`;
8. the Node apply validator remains unchanged and strict;
9. no live R2 read is introduced into SOS-light planning or preservation.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in CIC-Test

After deployment, functional acceptance MUST use a real CIC-Test operation whose range includes at least one complete connector-day replacement where a byte-identical baseline child must be republished.

The operation must confirm:

1. final transition validation passes before Node apply;
2. promoted byte-identical objects are recorded as `planned_overlay` in final dependency identities;
3. their exact bodies are written and GET-verified after the relevant deletion;
4. parents and indexes publish only after those dependencies succeed;
5. the completed R2 graph remains valid in the following Dropbox backup and check-only Integrity run.
