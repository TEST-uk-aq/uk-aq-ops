# SOS-light pre-mutation global-lock recovery amendment

## Status

**Future implementation authority; not current runtime behaviour until deployed and accepted through real TEST operation.**

## Authority and scope

This amendment defines bounded recovery from loss of the shared PostgreSQL observations global operation lock for the dedicated write-enabled fixed-v2 SOS-light path.

It amends, only for this narrow future fixed-v2 recovery case:

- [`sos_light_three_phase_authority_contract.md`](sos_light_three_phase_authority_contract.md);
- [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`sos_light_v2_coordinator_hardening_amendment.md`](sos_light_v2_coordinator_hardening_amendment.md).

All other covered operations retain the existing rule that loss of the lock session fails closed. Fixed-v3 SOS-light also retains immediate fail-closed lock-loss behaviour until separately authorised.

This amendment does not permit any SOS-light work to mutate canonical R2 observations while lock ownership is absent or uncertain.

## Core decision

A transient loss of the dedicated PostgreSQL lock session before the first possible R2 mutation does not have to discard an otherwise valid long-running fixed-v2 SOS-light run.

The future recovery model is:

```text
lock/session lost before first R2 mutation
    -> stop all protected child forward progress
    -> mark the existing lock session lost
    -> attempt to establish a fresh PostgreSQL session
    -> reacquire the same global observations operation lock
    -> rerun the complete recovery authority gate under the new lock
    -> require the original run authority to be unchanged
    -> only then resume the same logical SOS-light run
```

Reacquiring the advisory lock by itself is never sufficient to resume.

If the authority cannot be proven unchanged, the run stops. It does not silently rebase an existing proposal onto a newer Dropbox/R2/core generation.

## Recovery is pre-mutation only

The implementation MUST expose one monotonic mutation boundary for the protected logical run.

Existing APPLY journal/checkpoint evidence MAY satisfy this requirement if it unambiguously proves the same fact. Otherwise a dedicated durable latch MAY be introduced.

The required semantics are:

```text
r2_mutation_started = false
    until immediately before the first possible canonical R2 DELETE or PUT

r2_mutation_started = true
    before the first possible canonical R2 DELETE or PUT
    and never returns to false for that logical run
```

Automatic lock recovery is permitted only when the coordinator can prove that the mutation boundary is still false.

If mutation-start evidence is missing, contradictory or ambiguous, recovery eligibility is false.

If the lock/session is lost after `r2_mutation_started=true`, the run MUST fail closed immediately. It MUST NOT reacquire and continue APPLY in place. Existing APPLY journal, checkpoint, reconciliation and recovery contracts remain authoritative for that case.

## No forward progress while unlocked

As soon as lock-session loss is detected, the protected SOS-light child/process group MUST stop making forward progress before recovery attempts proceed.

The implementation MAY suspend the existing process group or terminate it and perform a controlled same-logical-run restart, but it MUST NOT:

- continue DETECT, PROPOSE, transition approval or APPLY while unlocked;
- start a new logical Integrity run silently;
- allow a child to reach Node APPLY while recovery is unresolved;
- treat source acquisition or proposal work performed after detected lock loss as accepted authority.

Already acquired identity-pinned source-cache files may remain on disk. They are not canonical R2 authority and may be reused only through the normal source-identity checks after recovery or by a later fresh run.

## Recovery window

The coordinator MAY attempt pre-mutation recovery for at most:

```text
15 minutes
```

from the recorded lock-loss time.

Each recovery attempt MUST use a fresh PostgreSQL connection/session. Once connected, the normal advisory-lock acquisition logic may be reused.

The overall 15-minute deadline is authoritative. Individual connection or lock-acquisition attempts MUST remain bounded so that one stalled attempt cannot silently exceed the recovery window.

If the lock cannot be reacquired within the recovery window, the run fails cleanly.

The existing lock heartbeat remains a fail-closed ownership check. This amendment does not require increasing the current heartbeat query timeout. Resilience to a longer connectivity interruption comes from bounded fresh-session reacquisition plus full authority revalidation, not from assuming that a stalled old session still owns the advisory lock.

## Original Step 0 authority must be persisted

A write-enabled fixed-v2 SOS-light run that is eligible for this recovery MUST persist enough initial Step 0 authority to prove later that nothing relevant changed during the lock gap.

At minimum, the original recovery authority must include:

- original logical run identity;
- original run start time used by the writer-ordering gate;
- selected observation-history generation;
- accepted Dropbox backup run identity and its start/finish timestamps;
- accepted Dropbox checkpoint identity, including checkpoint SHA-256 where available;
- pinned fully processed Dropbox observations-root content hash;
- pinned live R2 observations-root content hash that matched it;
- the relevant writer-history watermark for:
  - `ops.prune_daily`;
  - `ops.r2_core_snapshot`;
  - `ops.history_integrity`;
- pinned generation-matched core snapshot identity;
- mutation-start status.

The writer-history watermark MUST identify the latest relevant operation identity and status/timestamps strongly enough to detect a different run that started, completed or failed after the original Step 0. The recovering run's own unchanged identity is not considered a different writer.

## Mandatory revalidation after reacquisition

After the fresh session has reacquired the global observations operation lock, and before any protected child is allowed to resume, the coordinator MUST rerun the recovery authority gate while holding the new lock.

The gate MUST use the **original logical run start time**, not the reacquisition time.

It MUST prove all of the following:

1. the request-level IngestDB boundary still passes for the original request;
2. the selected observation-history generation is unchanged;
3. the originally accepted Dropbox checkpoint is still complete and internally valid;
4. the accepted Dropbox backup identity is unchanged;
5. the normal backup/writer-ordering gate still succeeds when evaluated against the original run start time;
6. no relevant writer-history watermark has advanced to a different `ops.prune_daily`, `ops.r2_core_snapshot` or `ops.history_integrity` operation;
7. no incompatible relevant writer is currently active under a different operation identity;
8. the fully processed Dropbox observations-root content hash is unchanged from the originally pinned root;
9. the current live R2 observations-root content hash exactly equals that same originally pinned root;
10. Dropbox and live R2 therefore still have exact root equality;
11. the pinned generation-matched core snapshot identity is unchanged;
12. the mutation-start boundary is still definitively false.

`--allow-stale-dropbox` MUST NOT bypass any recovery revalidation.

The writer-history comparison is deliberately additional to root equality. A writer that started and failed during the lock gap may have touched child objects without successfully advancing the root manifest. Any different relevant writer operation during the gap therefore invalidates same-run recovery even when the observations-root hash happens to remain unchanged.

Likewise, a newer successful Dropbox backup invalidates same-run recovery even if it represents byte-identical observations. The existing logical run resumes only against the exact original backup/checkpoint authority.

## Recovery outcomes

### Authority unchanged

When every mandatory recovery check succeeds:

- the fresh PostgreSQL session becomes the current lock-owning session;
- the same logical run identity is retained;
- the run records one successful recovery generation/attempt;
- protected child progress may resume;
- the existing pinned Dropbox baseline and core identity remain authoritative;
- all normal DETECT, PROPOSE, persisted-state equality, fingerprint, Node gate and APPLY rules continue unchanged.

Any proposal/staging evidence created before lock loss remains usable only because the recovery gate proved that its external authority inputs did not change. Normal local body identity and persisted-state validation still apply.

### Authority changed or uncertain

If any mandatory recovery check fails or cannot be completed:

```text
resume = forbidden
node_apply_launch_permitted = false
r2_mutation_possible = false
```

The logical run fails closed.

It MUST NOT automatically adopt a newer backup, newer root, newer core snapshot or different writer watermark inside the old proposal.

A later fresh SOS-light invocation may establish a new Step 0 and may reuse still-valid source-cache material through the normal source-evidence rules.

### Lock loss after mutation start

If lock/session loss occurs after the monotonic mutation boundary has become true:

- no 15-minute reacquisition continuation is permitted;
- the protected operation stops;
- the run records post-mutation lock loss;
- existing APPLY journal/checkpoint/reconciliation recovery is used;
- no fresh lock may be treated as authority to continue the interrupted APPLY in place.

## Interaction with v2 staging and transition fingerprint

Successful lock recovery does not weaken or replace the fixed-v2 coordinator freeze.

After any successful pre-mutation recovery:

- incomplete staging remains non-authoritative;
- final persisted-state equality is still required;
- Python proposal-transition validation is still required;
- the `uk_aq_sos_light_v2_transition_state_fingerprint_v2` fingerprint is still required;
- Node must still independently validate the frozen evidence before mutation.

If recovery occurs after final proposal staging but before mutation, transition approval/fingerprint evidence MUST be recomputed or revalidated from the current persisted final state after recovery before Node APPLY is permitted. Stale pre-recovery approval MUST NOT be trusted merely because external authority was unchanged.

## Audit evidence

A run that experiences lock loss MUST record enough bounded evidence to determine:

- lock-loss time and error class/message;
- whether the mutation boundary was definitively false or true;
- whether recovery was eligible;
- recovery deadline;
- connection/reacquisition attempt count;
- successful reacquisition time, if any;
- original and recovered lock-session generation/identity diagnostics;
- original and rechecked backup/checkpoint identities;
- original and rechecked writer-history watermarks;
- original and rechecked Dropbox/live root hashes;
- original and rechecked core snapshot identity;
- every recovery gate result;
- final recovery outcome:
  - `resumed`;
  - `blocked_authority_changed`;
  - `blocked_authority_uncertain`;
  - `reacquire_timeout`;
  - `post_mutation_lock_loss`.

Credentials or connection strings MUST NOT be written to these diagnostics.

## Minimal structural validation before deployment

Before deployment, use only focused deterministic checks needed to prove this recovery state machine is structurally viable.

They MUST prove:

1. pre-mutation lock loss stops protected child progress and invokes no R2 mutation adapter while unlocked;
2. fresh-session reacquisition plus unchanged original authority permits resume of the same logical run;
3. a changed writer watermark, backup/checkpoint identity, observations-root identity or core identity blocks resume;
4. the original run start time, not reacquisition time, is used for the writer-ordering recheck;
5. recovery timeout fails cleanly;
6. post-mutation lock loss never enters the automatic reacquisition-continuation path.

Do not add a broad speculative pre-deployment suite.

## Functional acceptance in TEST

Functional acceptance happens only after deployment to TEST.

Use a real write-enabled fixed-v2 SOS-light TEST operation and exercise one controlled pre-mutation lock-session loss. The operation must demonstrate:

- child progress stops when the session is lost;
- no R2 mutation occurs while lock ownership is absent;
- the lock is reacquired on a fresh session within the recovery window;
- the complete original-authority recovery gate succeeds;
- the same logical run resumes;
- normal v2 staging/fingerprint/APPLY gates still run afterwards;
- final verification succeeds.

A second real TEST acceptance case is required only if a natural authority-change condition occurs during recovery. Deliberately starting a competing writer is not required merely to manufacture that condition.

## Precedence

Before TEST acceptance this file is future implementation authority only.

For the future fixed-v2 recovery path, it supersedes conflicting wording that requires immediate permanent termination after every pre-mutation lock-session loss, but only after the implementation has been deployed for TEST acceptance.

It does not supersede:

- the requirement to hold the global observations operation lock for canonical mutation;
- current fail-closed runtime behaviour before deployment/acceptance;
- post-mutation lock-loss failure behaviour;
- Step 0 writer-ordering/currentness requirements;
- Dropbox/live root equality;
- pinned core-snapshot identity;
- fixed-v2 staging/fingerprint/APPLY safety;
- fixed-v3 lock-loss behaviour;
- Prune Daily, backup, migration or generic Integrity lock-loss behaviour.
