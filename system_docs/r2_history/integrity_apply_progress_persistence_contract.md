# Integrity apply progress persistence contract

## Authority and scope

This document is an authoritative amendment to:

- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`sos_light_model.md`](sos_light_model.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md).

It defines how write-enabled Integrity apply progress, mutation evidence and recovery evidence MUST be persisted without making runtime grow unreasonably with proposal size.

Where older wording or active code conflicts with this document, this document is authoritative for apply progress persistence, mutation journalling, checkpoint frequency and storage of detailed deletion evidence.

This contract does not weaken proposal validation, R2 writer locks, delete verification, post-PUT GET verification, semantic verification, child-before-parent publication, SOS-light per-day ordering or fail-closed behaviour.

## Problem being prevented

A large Integrity proposal may contain thousands of objects. Re-serialising and atomically rewriting the complete run-state document for every small object transition creates work proportional to:

```text
number of mutation events × complete run-state size
```

That is not acceptable when the run-state itself grows with per-object and per-deletion evidence.

The persistence design MUST avoid an effective quadratic apply path in which each object PUT or GET verification rewrites an increasingly large multi-megabyte state document.

## Required persistence model

Write-enabled apply MUST separate:

1. **compact checkpoint state**, containing the current run, phase, day or scope, aggregate counters, completed publication level and identity-pinned references to detailed evidence; and
2. **append-only mutation evidence**, containing detailed per-operation events required for audit and diagnosis.

The implementation MAY retain the existing `run-state.json` name for the compact checkpoint state. It MUST NOT require the complete state document to be rewritten for every object status transition.

Detailed mutation evidence SHOULD use a run-scoped append-only format such as JSON Lines. An equivalent bounded design is permitted only when it preserves the same durability, ordering and audit properties without whole-state rewrites per object.

## Mutation journal requirements

Each remote mutation or verification event MUST record enough evidence to reconstruct the completed publication level and diagnose failure.

For object publication, the journal MUST distinguish at least:

```text
put_started
put_completed
post_put_get_started
post_put_get_verified
put_or_verification_failed
```

Each relevant event MUST include, as applicable:

- run ID;
- canonical R2 key;
- selected day and connector where derivable;
- publication stage;
- byte length;
- SHA-256 identity;
- event timestamp;
- success or failure status;
- failure message;
- post-PUT verification count or equivalent proof that the required GET occurred exactly once.

For prefix deletion, the journal MUST distinguish at least:

```text
deletion_started
deletion_completed
deletion_verified
deletion_failed
```

The mutation journal is evidence, not authority for constructing new R2 content. It MUST be run-scoped and MUST NOT be reused as source input by a later run.

## Checkpoint boundaries

The compact checkpoint state MUST be durably written at meaningful safety boundaries, including:

1. after final proposal validation and before the first remote mutation;
2. before each destructive day or prefix deletion begins;
3. after deletion has been verified and before replacement publication proceeds;
4. after each complete SOS-light day parent has been published and GET-verified;
5. before affected index publication begins;
6. after affected indexes have completed successfully;
7. before and after current-state reconciliation stages where those stages are part of the run;
8. whenever the run fails;
9. when the run completes.

A compact checkpoint MAY also be written at a bounded time or event interval for operator visibility. Such optional checkpointing MUST be rate-limited and MUST NOT revert to one complete-state rewrite per object transition.

## Durability before dependent publication

Detailed child success evidence MUST be durably appended before a dependent parent is published.

For example:

```text
child PUT
-> child post-PUT GET verified
-> child verification event durably recorded
-> parent may be published
```

For SOS-light:

```text
day deletion verified
-> deletion evidence durably recorded and checkpointed
-> complete replacement day published child-before-parent
-> day parent GET-verified
-> day-complete evidence durably recorded and checkpointed
-> next selected day may be deleted
```

A later day MUST NOT be deleted merely because child operations for the previous day succeeded in memory. The previous day’s completed publication level MUST first be durably evidenced.

## Failure behaviour

On failure, the implementation MUST:

- append a failure event containing the current key, day, stage and error;
- durably write a compact checkpoint identifying the last completed publication level;
- leave later SOS-light days untouched;
- prevent affected indexes from being published when selected-day publication is incomplete;
- preserve the journal and checkpoint as immutable failed-run evidence.

The failed run is not resumed. Recovery remains a fresh Integrity run with new source evidence and a new proposal.

## Deleted object-key evidence

The compact run-state MUST NOT grow without bound by embedding every deleted object key under every deletion record.

The compact state MUST retain at least:

- deletion prefix;
- deleted object count;
- deletion verification status;
- start and completion timestamps;
- a deterministic SHA-256 identity over the sorted deleted-key list, or an equivalent deterministic identity;
- an identity-pinned reference to a run-scoped detailed deletion artifact when the full key list is retained.

The complete deleted-key list MAY be stored in a separate run-scoped sidecar artifact. That artifact SHOULD use a compact format and MAY be compressed. Its path, byte length and SHA-256 MUST be recorded in the compact checkpoint state.

The full list MUST NOT be duplicated into the main checkpoint document merely for convenience.

## Compact state requirements

The compact checkpoint state MUST provide operator-visible progress without scanning the complete mutation journal.

It MUST include or deterministically expose:

- planned and completed deletion counts;
- planned and completed object publication counts;
- planned and completed post-PUT verification counts;
- failed operation count;
- current phase;
- current selected day or current index stage;
- last completely published and verified SOS-light day;
- per-day high-level status;
- whether index publication has begun or completed;
- the last checkpoint timestamp;
- mutation-journal path, byte length and SHA-256 or equivalent identity information available at checkpoint time;
- deletion-evidence artifact references where used.

It SHOULD remain approximately proportional to selected days and high-level publication units, not to every mutation transition.

## Logging and operator visibility

Long-running canonical apply MUST emit bounded progress logs while work is in progress.

At minimum, progress SHOULD be emitted:

- when a selected day deletion starts and completes;
- when a selected day publication starts and completes;
- at bounded object-count or time intervals within a large day;
- when index publication starts and completes;
- when current-state reconciliation starts and completes.

Subprocess output SHOULD be streamed to the main Integrity log rather than held until the subprocess exits. If output capture is required, the parent MUST still surface periodic progress derived from the compact checkpoint state.

Logging MUST remain bounded and MUST NOT emit one verbose line per unchanged proposal or duplicate complete journal contents.

## Performance invariants

For a proposal containing `N` remote mutation and verification events, persistence work MUST be approximately:

```text
O(N append events + bounded checkpoints)
```

It MUST NOT be approximately:

```text
O(N complete-state rewrites)
```

when the complete state grows materially with `N`.

The implementation MUST avoid retaining large duplicate arrays or full object bodies in the compact checkpoint state.

No fixed wall-clock acceptance target is mandated because R2 and network conditions vary. However, local state serialisation MUST NOT dominate a normal apply run, and increasing the selected-day range MUST NOT cause disproportionate slowdown solely because the state document is repeatedly rewritten.

## Audit requirements

Final reports MUST retain the existing distinctions between:

- deletion attempted and deletion verified;
- PUT attempted and PUT completed;
- post-PUT GET attempted and verified;
- byte verification and semantic verification;
- child publication and parent publication;
- day publication and index publication.

The report MAY derive detailed counts from the mutation journal and compact checkpoint. It MUST verify the journal and sidecar identities before relying on them.

The final successful or failed report MUST identify:

- mutation journal location and identity;
- compact checkpoint count;
- mutation event count;
- full-state rewrite count if measurable;
- deleted-key sidecar count and identity where applicable;
- last completed publication level;
- whether later selected days remained untouched after any failure.

## Required focused structural checks

Before deployment, run only the smallest deterministic checks needed to prove structural viability. They MUST prove:

1. multiple object transitions append evidence without rewriting the complete checkpoint for each transition;
2. a changed object still receives its required post-PUT GET and durable verification evidence;
3. a parent cannot publish until required child verification evidence is durably recorded;
4. SOS-light checkpoints after one day completes before the next day deletion starts;
5. a simulated day failure leaves later days untouched and records the last completed day;
6. affected indexes remain last and do not publish after an incomplete day;
7. the compact checkpoint contains progress counters and the current or last completed day;
8. deleted keys are stored outside the compact state, with count and identity-pinned sidecar evidence;
9. a failed journal or sidecar write fails closed before dependent parent publication;
10. progress logging remains bounded and exposes movement during a long apply.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in CIC-Test

After deployment, validate through a real CIC-Test operation:

1. run a multi-day SOS-light replacement;
2. confirm the main log shows ongoing apply progress;
3. confirm each day completes and checkpoints before the next day is deleted;
4. confirm the compact checkpoint remains bounded rather than growing with every deleted key and transition;
5. confirm detailed per-object and deletion evidence exists in identity-pinned run-scoped artifacts;
6. confirm all changed objects still receive their required post-PUT GET verification;
7. confirm indexes publish only after all selected days complete;
8. compare apply duration and local CPU use with the previous whole-state-rewrite implementation.

Functional acceptance belongs in real CIC-Test operation. Pre-deployment checks remain structural and narrowly targeted.
