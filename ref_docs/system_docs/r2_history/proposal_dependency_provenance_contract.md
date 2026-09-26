# R2 proposal dependency provenance contract

## Authority and scope

This document is an authoritative amendment to:

- [`sos_light_model.md`](sos_light_model.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

It defines how planned objects, unchanged baseline objects, staged mutations and dependency identities MUST be represented during local proposal construction and final pre-mutation validation.

Where older wording or active code conflicts with this document, this document is authoritative for proposal dependency provenance.

The immediate failure corrected by this contract occurred in SOS-light when an unchanged Dropbox-backed pollutant Timeseries index was retained as a planning record but incorrectly labelled as a `planned_overlay` dependency of the latest index. The final validator correctly rejected that contradiction before R2 mutation.

## Planning record is not automatically a staged mutation

A local proposal record may describe either:

```text
changed object
or
unchanged byte-identical object
```

The mere existence of a proposal record MUST NOT make the object a staged current-run mutation.

The authoritative distinction is:

```text
proposal.changed = true
-> staged current-run mutation
-> dependency source = planned_overlay

proposal.changed = false
-> unchanged baseline object
-> dependency source remains the pinned baseline source
```

For SOS-light index planning, the unchanged baseline source is the chosen Dropbox baseline.

A status such as `skipped_unchanged` MUST mean the same thing as `changed = false`: the object is not part of the mutation write set and MUST NOT be represented as a staged overlay object.

## Dependency identity rules

Every dependency identity MUST describe the body that will actually satisfy that dependency during apply.

### Changed dependency

When the dependency has a changed current-run proposal:

```text
source = planned_overlay
sha256 = proposed changed body SHA-256
bytes = proposed changed body byte length
```

The changed dependency MUST be present in the staged mutation set, published in dependency order and GET-verified before its parent is published.

### Unchanged dependency

When a proposal record exists but its body is byte-identical to the chosen baseline:

```text
source = dropbox
sha256 = pinned Dropbox baseline body SHA-256
bytes = pinned Dropbox baseline body byte length
```

The unchanged dependency:

- MUST remain resolved from the chosen Dropbox baseline during local planning;
- MUST NOT be exposed as `planned_overlay`;
- MUST NOT shadow its Dropbox baseline body in combined-local object resolution;
- MUST NOT be added to the R2 PUT set;
- MUST NOT require a post-PUT verification GET;
- MAY remain in planning and audit output as `skipped_unchanged`.

If the pinned baseline body cannot be resolved with its exact SHA-256 and byte length, the proposal graph MUST fail before mutation.

## Combined-local resolver behaviour

A combined local proposal adapter or object map MUST distinguish changed proposals from unchanged planning records.

For object lookup and child discovery:

- changed proposals override the baseline and appear as `planned_overlay`;
- unchanged proposal records do not override or hide the baseline object;
- a listing that combines proposals with baseline objects MUST replace a baseline entry only when the proposal is changed;
- an unchanged record MUST leave the baseline entry and its baseline provenance intact.

This rule applies consistently to:

- exact object lookup;
- object listing;
- common-prefix discovery;
- dependency identity resolution;
- local dependency snapshots;
- latest or global index dependency construction;
- final proposal graph validation.

## Mixed changed and unchanged index dependencies

A parent, latest or global index may legitimately depend on a mixture of:

```text
changed child index -> planned_overlay
unchanged child index -> dropbox
```

The complete dependency set MUST retain that distinction per child.

The latest index MUST NOT force byte-identical child indexes into the mutation set merely to make all dependencies appear staged.

Deterministic put-if-changed behaviour remains mandatory:

- only changed index bodies are written;
- unchanged index bodies remain baseline dependencies;
- the latest or global index may still be changed and written after all changed child dependencies have been verified;
- unchanged child dependencies require pinned local baseline identity, not a new live R2 read or write.

## SOS-light authority boundary

This contract does not change the SOS-light authority model.

For SOS-light:

- fresh SOS source remains authoritative for selected connector `1` observations;
- the chosen Dropbox baseline remains the local authority for retained observation and index content;
- existing live R2 observation bodies are not planning or preservation input;
- unchanged Dropbox-backed dependencies MUST NOT be relabelled as current-run staged objects;
- this provenance rule MUST NOT introduce pre-deletion live R2 reads.

For the fixed-v3 compact-latest fast path defined by the narrower SOS-light authority contract, retained unchanged scoped-root descriptors MAY be sourced from the checkpoint-authenticated compact latest registry after strict canonical-scope cross-checking.

That registry evidence MUST remain distinguishable in planning/audit provenance from both:

- a canonical Dropbox object body that is actually present and identity-verified locally; and
- a current-run `planned_overlay` object.

A registry descriptor MUST NOT be relabelled as a locally present scoped-root body. It may establish the retained identity used by an incrementally rebuilt global latest only for an unaffected scope that the canonical Dropbox-plus-overlay catalogue independently proves still exists.

Changed/new affected scoped roots remain `planned_overlay`. Removed scopes require explicit removal evidence. A malformed, contradictory or incomplete registry cannot be repaired by consulting live R2; the planner must fall back to complete canonical reconstruction or fail before mutation.

## Proposal body storage and inter-process transport

Proposal provenance is independent of how the proposal record is transported between planner and coordinator.

A changed object remains:

```text
source = planned_overlay
sha256 = proposed changed body SHA-256
bytes = proposed changed body byte length
```

whether the exact proposed body is held inline in a small proposal record or referenced from the run-local overlay/staging area.

For large plans, proposal records SHOULD NOT duplicate changed object bodies inline when those exact bytes already exist in the authenticated run-local overlay. Instead, a changed proposal MAY carry a bounded body reference such as:

```text
object_key
body_ref / local_path
sha256
bytes
source = planned_overlay
```

The referenced body MUST be inside the current run's controlled staging/overlay boundary. Before final proposal acceptance, the referenced file/body MUST exist and its actual byte length and SHA-256 MUST match the proposal identity.

Once the final proposal is frozen:

- the body reference is immutable for that run;
- APPLY reads the exact staged bytes identified by the frozen proposal;
- APPLY MUST NOT regenerate the body from logical fields or dependency metadata;
- post-PUT verification continues to compare R2 with the frozen intended identity.

The planner/coordinator boundary MUST NOT depend on a single monolithic JSON serialisation containing all `proposed_body` payloads. Large proposals MUST use a file-backed or otherwise bounded representation. A compact control-plane response MAY point to a run-local proposal artifact, but that artifact MUST be authenticated by path/reference plus integrity identity before the coordinator trusts it.

A proposal artifact SHOULD avoid duplicating staged object bytes. It may contain the proposal graph, identities, dependency provenance and body references while the exact payload bytes remain in the run-local overlay.

This representation change MUST NOT weaken the existing distinction between:

- changed current-run bodies owned by the repair and resolved as `planned_overlay`;
- unchanged pinned Dropbox baseline bodies;
- retained compact-registry descriptors allowed by the fixed-v3 fast path.

## Mutation and publication

The final mutation plan MUST contain only changed objects and explicit permitted deletions.

Before the first R2 DELETE or PUT, final proposal validation MUST prove:

- every `planned_overlay` dependency has a changed staged proposal;
- every unchanged dependency is pinned to its real baseline source and identity;
- no unchanged proposal is included in the write set;
- no changed dependency is incorrectly treated as baseline-only;
- parent and latest-index dependencies resolve to the exact bodies used to construct them.

The validator MUST remain fail-closed. Do not weaken validation to accept contradictory provenance.

## Audit evidence

Run state and reports MUST distinguish at least:

- proposal transport mode / representation;
- authenticated proposal artifact path/reference, SHA-256 and byte length when file-backed;
- staged changed-body count and total staged changed-body bytes where practical;
- changed proposal count;
- skipped-unchanged proposal count;
- changed dependency count;
- unchanged baseline dependency count;
- mutation write count;
- post-PUT verification count.

Where useful for diagnosis, a dependency entry SHOULD include:

```text
object_key
changed
status
source
sha256
bytes
included_in_write_set
```

## Minimal structural validation

Before operational CIC-Test execution, use only the smallest targeted checks needed to prove:

1. a file-backed changed proposal body resolves to the exact staged bytes and fails on SHA-256 or byte-length mismatch;
2. the planner/coordinator hand-off can represent a multi-object proposal without requiring all changed bodies to be embedded in one stdout JSON payload;
3. a latest index can depend on one changed child index and one unchanged child index;
4. the changed child resolves as `planned_overlay` and is present in the write set;
5. the unchanged child resolves as `dropbox`, retains its pinned baseline SHA-256 and bytes, and is absent from the write set;
6. an unchanged proposal record does not shadow the Dropbox object in exact lookup or listings;
7. the final proposal validator accepts the correct mixed provenance graph;
8. the final proposal validator rejects an unchanged, unstaged dependency labelled `planned_overlay`;
9. deterministic put-if-changed behaviour is retained without writing byte-identical child indexes.

Do not add a broad speculative test suite. Functional validation belongs in the real CIC-Test operation.
