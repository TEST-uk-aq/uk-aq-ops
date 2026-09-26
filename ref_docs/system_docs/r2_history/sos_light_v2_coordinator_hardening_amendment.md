# SOS-light v2 coordinator hardening amendment

## Status

**Future implementation authority; not current runtime behaviour.**

This contract defines the agreed next hardening step for the fixed-generation `sos-light-v2` implementation before the planned long LIVE v2 historical refresh and subsequent side-by-side v2-to-v3 migration.

Until the implementation has been deployed and accepted through a real TEST SOS-light v2 operation, the existing current-runtime SOS-light contracts continue to describe deployed behaviour.

After that acceptance, this document MUST be updated to current-runtime status rather than leaving an implemented safety boundary labelled as future.

## Authority and scope

This document is an authoritative future amendment to:

- [`sos_light_three_phase_authority_contract.md`](sos_light_three_phase_authority_contract.md);
- [`sos_light_model.md`](sos_light_model.md);
- [`proposal_run_state_transition_contract.md`](proposal_run_state_transition_contract.md);
- [`final_staged_write_set_provenance_contract.md`](final_staged_write_set_provenance_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`integrity_apply_progress_persistence_contract.md`](integrity_apply_progress_persistence_contract.md);
- [`proposal_dependency_provenance_contract.md`](proposal_dependency_provenance_contract.md).

It owns the upcoming fixed-v2 SOS-light coordinator changes for:

- bounded pre-APPLY run-state persistence;
- deterministic in-memory changed-scope handling;
- an explicit complete coordinator staging checkpoint;
- exact persisted-state equality before transition approval;
- a deterministic Python-to-Node transition-state fingerprint;
- bounded end-to-end SOS-light v2 progress reporting.

It does not redesign SOS-light source authority, Step 0, complete-day replacement, the detector/proposal independence boundary or canonical APPLY.

This amendment applies to the dedicated fixed-generation `sos-light-v2` path. It MUST NOT silently impose its SOS-light-specific freeze/fingerprint fields on unrelated generic v2 Integrity proposal paths.

The fixed-v3 implementation remains separately owned by `sos-light-v3` and its v3-specific contracts and code. Equivalent safety goals do not require identical v2/v3 internal proposal transport.

## Behaviour that remains unchanged

The following existing authority remains unchanged:

- request-level IngestDB boundary;
- global observations operation lock;
- Dropbox checkpoint validity and writer-order gates;
- Dropbox observations-root versus live R2 observations-root equality;
- pinned Dropbox baseline authority;
- identity-pinned SOS source authority;
- the prohibition on using pre-APPLY live R2 child bodies as planning or preservation authority;
- independent detector/source-evidence and proposal stages;
- complete selected-day replacement;
- protected connector rules;
- final staged-write-set provenance semantics;
- child-before-parent publication;
- Node final proposal validation;
- mutation journalling;
- bounded APPLY persistence;
- deletion verification;
- post-PUT GET verification;
- semantic verification;
- current-state reconciliation;
- failure/recovery semantics.

The v2 coordinator hardening MUST improve persistence and pre-APPLY evidence without weakening any of these rules.

## Bounded pre-APPLY coordinator persistence

### Problem

During SOS-light v2 proposal construction, repeatedly serialising the complete growing `run-state.json` for individual staged objects or changed-scope updates creates persistence work proportional to:

```text
proposal events × growing complete run-state size
```

That pattern MUST NOT remain on the dedicated SOS-light v2 bulk proposal path when the same semantic state can be durably checkpointed at bounded intervals.

### Required checkpoint policy

Within one bounded SOS-light v2 proposal-staging phase, the coordinator MAY keep object and changed-scope updates in memory between checkpoints.

It MUST persist a complete checkpoint when either threshold is reached:

```text
250 completed objects
OR
15 elapsed seconds
```

and MUST always persist a mandatory final checkpoint at the end of the phase.

A phase MAY retain additional writes at genuine safety or phase boundaries. It MUST NOT reintroduce a complete growing run-state rewrite for every staged object merely for progress visibility.

Changing persistence frequency MUST NOT change:

- object membership;
- body identity;
- dependencies;
- dependency identities;
- proposal ownership;
- changed-scope semantics;
- deletion/tombstone scope;
- final publication order.

Generic non-SOS Integrity callers MAY retain their existing persistence behaviour where the bounded SOS-light path is not in use.

## Deterministic changed-scope handling

During bounded SOS-light v2 proposal staging, changed scopes SHOULD be maintained in an in-memory keyed representation that provides semantic deduplication without repeatedly sorting the full list after each object.

At every persisted checkpoint, the external run-state representation MUST remain deterministic:

- duplicate semantic scopes are forbidden;
- set-like scope collections are materialised in deterministic sorted order;
- the established external run-state schema is preserved unless a separate versioned schema change is explicitly authorised.

The in-memory keyed form is an implementation optimisation only. It MUST NOT become a second persisted authority.

## Coordinator staging state

SOS-light v2 MUST expose an explicit versioned coordinator staging state that distinguishes incomplete construction from final pre-APPLY authority.

The persisted state MUST support the following semantic progression.

### In progress

```text
status = in_progress
node_apply_launch_permitted = false
```

An intermediate checkpoint MUST contain enough evidence to identify at least:

- staging contract/version;
- completed object count;
- total object count when known;
- checkpoint count;
- changed-scope count where relevant;
- explicit non-APPLY permission.

An intermediate checkpoint is crash/audit evidence only. It MUST NOT be accepted as APPLY authority and this contract does not make partial proposal construction resumable.

### Staging complete

After all objects for the bounded phase have been staged and structurally validated:

```text
status = complete
completed_object_count = total_object_count
node_apply_launch_permitted = false
```

Completion of staging alone MUST NOT permit Node APPLY.

## Final freeze order

For dedicated SOS-light v2, the required pre-APPLY order is:

```text
complete proposal staging
-> persist final complete staging checkpoint
-> finalise final staged-write-set provenance
-> persist final provenance
-> prove in-memory final state equals persisted final checkpoint
-> run independent Python proposal-transition validation
-> compute deterministic transition-state fingerprint
-> persist successful transition evidence + fingerprint
-> Node independently validates the same frozen evidence
-> Node final proposal validation
-> canonical APPLY may begin
```

No R2 DELETE or PUT may occur before this sequence has completed successfully.

## Persisted-state equality

Before Python transition approval, the coordinator MUST prove that the final complete state it intends to validate is exactly the state durably represented by the final checkpoint.

The equality check MUST cover the complete authoritative pre-APPLY state required by the staging/final-provenance contract, not merely aggregate counters.

If the final checkpoint is missing, incomplete, stale or differs from the in-memory final state:

```text
node_apply_launch_permitted = false
r2_mutation_possible = false
```

and the run MUST fail before Node APPLY.

This requirement supplements the existing core-snapshot identity checks and does not replace them.

## Transition-state fingerprint

### Contract identity

The dedicated SOS-light v2 transition fingerprint contract is:

```text
uk_aq_sos_light_v2_transition_state_fingerprint_v1
```

The fingerprint is an unkeyed deterministic SHA-256 integrity binding. It is not a MAC and does not protect against an actor who can deliberately rewrite the full run state and recompute the digest. Its purpose is to prevent stale successful Python transition evidence from being reused after a covered proposal-graph change.

### Canonical payload

The fingerprint payload MUST be deliberately narrow and derived from the semantic inputs consumed by the v2 proposal-transition validator.

It MUST bind, where present and transition-relevant:

- exact final staged-object membership;
- object key;
- object SHA-256;
- byte count;
- publication stage;
- dependencies;
- dependency identities;
- `proposed`;
- `built`;
- `structurally_validated`;
- `changed`;
- `included_in_write_set`;
- final object status;
- planner change/status/write-set fields;
- planner dependencies;
- planner dependency identities;
- forced-republication audit fields;
- planner/baseline/final source fields used by transition validation;
- promotion reason;
- unchanged-planner keys;
- proposed tombstone prefixes;
- final staged-write-set provenance fields that define the frozen final write set.

The implementation MUST derive the exact field set from the active v2 transition validator. It MUST NOT mechanically copy a fixed-v3 payload when a v3-only field has no v2 transition meaning.

The fingerprint MUST exclude volatile or post-freeze evidence that does not define transition authority, including:

- timestamps;
- logs;
- local paths;
- progress-only counters;
- APPLY journals;
- mutable APPLY outcome fields;
- post-PUT verification state.

Staged object bodies remain independently re-read and hashed. The transition fingerprint MUST NOT replace existing body or dependency validation.

### Canonical encoding

Python and Node MUST independently construct byte-for-byte equivalent canonical input.

The contract requires:

- the contract identifier inside the canonical payload;
- canonical object-key normalisation;
- deterministic object membership ordering;
- deterministic ordering for set-like arrays;
- preserved order only where order is semantically meaningful;
- recursively sorted object properties;
- compact UTF-8 JSON;
- SHA-256 over those canonical bytes.

The implementation MUST NOT rely on accidental Python-dict or JavaScript-object insertion order.

### Python persistence

Python MUST compute the fingerprint only after successful transition validation of the complete persisted final state.

Successful transition evidence MUST persist:

- transition status;
- explicit Node APPLY permission;
- fingerprint contract version;
- fingerprint SHA-256.

Node MUST NOT be launched until that final transition evidence has itself been durably persisted.

### Independent Node gate

For the dedicated SOS-light v2 path, Node MUST reject before any R2 mutation when:

- coordinator staging is incomplete;
- final staged-write-set provenance is absent/incomplete;
- Python transition validation did not succeed;
- explicit Node APPLY permission is absent/false;
- the transition fingerprint is missing;
- the fingerprint contract is unknown;
- the fingerprint value is malformed;
- the independently recomputed fingerprint differs from the persisted Python value.

A mismatch MUST be classified as stale or changed coordinator transition evidence.

Generic non-SOS v2 Integrity proposals MUST remain compatible with their existing apply contract and MUST NOT be rejected solely for lacking this SOS-light-specific fingerprint.

After the new gate succeeds, all existing independent Node validation remains mandatory.

## End-to-end bounded progress

Long-running SOS-light v2 work MUST provide bounded operator-visible progress through the existing Integrity progress channel, using `UK_AQ_INTEGRITY_PROGRESS` or its established equivalent.

The implementation MUST provide progress across the following existing phases where meaningful work exists:

1. run-scoped SOS source acquisition;
2. selected partition processing;
3. detector/source-evidence completion;
4. proposal-worker completion;
5. observation metadata planning;
6. Python proposal staging;
7. run-state checkpoint persistence;
8. complete-day assembly;
9. final staged-write-set provenance;
10. SQLite Integrity operation persistence;
11. proposal-transition validation;
12. canonical Node APPLY.

Progress payloads SHOULD expose the natural completed/total unit for the phase and elapsed seconds. Partition phases SHOULD expose current day and pollutant where useful.

Progress MUST be bounded by object/count and/or elapsed-time thresholds. It MUST NOT emit one verbose event for every object merely to show liveness.

ETA MAY be reported only when based on meaningful completed-work throughput.

Progress is audit/operator evidence only. It MUST NOT become source or mutation authority.

## Metadata-planner progress

Where the v2 metadata planner already has bounded count/time progress, the coordinator MUST surface that existing progress rather than introducing a second competing tracker for the same work.

Generation-neutral planner progress MAY be shared by fixed-v2 and fixed-v3 callers when its semantics are genuinely common.

## SQLite operation persistence

Adding progress to Integrity SQLite operation persistence MUST NOT split or weaken its existing transaction boundary.

Per-row conflict/update semantics remain unchanged. Progress reports work completed in the transaction; it does not convert partial rows into committed authority.

## APPLY remains unchanged

This amendment does not redesign canonical v2 APPLY.

Existing authority remains in force for:

- local body re-read and SHA-256/byte validation;
- dependency validation;
- dedicated SOS proposal validation;
- final proposal-graph validation;
- frozen publication scheduling;
- mutation journal;
- compact APPLY checkpoints;
- complete-day deletion evidence;
- child-before-parent publication;
- post-PUT GET verification;
- semantic verification;
- failure evidence and recovery.

The new coordinator freeze/fingerprint is an additional fail-closed precondition at the Node boundary.

## Fixed-v3 machinery that MUST NOT be imported merely for parity

The v2 implementation MUST NOT adopt the following solely to resemble fixed-v3:

- file-backed compact v3 proposal transport;
- v3 body-reference transport;
- exact-v3 per-timeseries leaf/index population;
- v3 aligned/exact prefix machinery;
- v3 physical cursor/index paging;
- v3-specific proposal-artifact authentication.

Equivalent safety does not require equivalent physical proposal representation.

## Detector/proposal independence

The detector/source-evidence stage and proposal stage remain independent evidence boundaries.

This hardening MUST NOT merge them merely to reduce process-launch overhead.

Worker pooling, retained workers, additional concurrency or other process-launch optimisation is outside this contract unless separately measured and authorised.

## Audit evidence

A completed or failed dedicated SOS-light v2 run MUST make it possible to determine:

- staging contract/version;
- total and completed proposal object counts;
- bounded checkpoint count;
- changed-scope count where relevant;
- whether the persisted final checkpoint exactly matched the in-memory final state;
- final staged-write-set provenance status;
- transition-validation status;
- transition fingerprint contract;
- transition fingerprint SHA-256;
- whether Node independently accepted the fingerprint;
- detector and proposal completed counts;
- metadata-planner progress;
- complete-day assembly progress;
- SQLite operation-persistence progress;
- canonical APPLY progress;
- full-state write counts where measurable.

## Minimal structural validation before deployment

Before operational TEST execution, use only the smallest focused deterministic checks needed to prove structural viability.

They MUST cover:

1. a proposal-staging fixture large enough to cross the 250-object boundary and prove bounded full-state writes plus a mandatory final checkpoint;
2. the 15-second checkpoint path before 250 objects;
3. rejection of an intermediate/incomplete coordinator checkpoint before Node launch;
4. rejection when the claimed final persisted state differs from the in-memory final state;
5. Python production of the v2 fingerprint contract/version and SHA-256 after successful transition validation;
6. Python/Node equality for the same realistic frozen v2 SOS-light proposal;
7. Node rejection after a covered dependency identity is changed while status/count success evidence remains intact;
8. Node rejection after a covered planner/final-provenance field is changed;
9. rejection of missing or unknown SOS-light v2 fingerprint evidence;
10. continued compatibility of a generic non-SOS v2 proposal without SOS-light-specific freeze fields;
11. continued independent Node body/dependency validation;
12. bounded rather than per-object progress;
13. unchanged APPLY journal/persistence safety.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

Functional acceptance occurs only after implementation has been deployed to TEST.

Use one real completed calendar month through the normal fixed-v2 SOS-light operational path with:

```text
source = sos
repair pollutants = pm25,pm10,no2,o3
```

The real operation MUST demonstrate:

- Step 0 lock/Dropbox/root authority succeeds;
- run-scoped source acquisition succeeds;
- detector and proposal progress is visible;
- bounded coordinator checkpoints are visible;
- final staging is complete and persisted;
- final staged-write-set provenance completes;
- persisted-state equality succeeds;
- Python transition validation succeeds;
- the v2 transition fingerprint is persisted;
- Node independently accepts the same fingerprint;
- canonical APPLY proceeds under the existing journal/order/verification contract;
- final Integrity verification succeeds;
- the subsequent required Dropbox backup/materialisation can establish the repaired state.

Deliberate interruption is not required. If a natural failure occurs, existing fail-closed and recovery semantics remain authoritative.

## LIVE promotion boundary

This future contract does not itself authorise LIVE execution.

The planned long LIVE v2 refresh MUST NOT use the new coordinator hardening until the real TEST monthly acceptance above has succeeded and the contract status has been updated to reflect accepted current-runtime behaviour.

## Precedence

Before TEST acceptance, this file constrains implementation work but does not claim deployed runtime behaviour.

For the upcoming fixed-v2 SOS-light implementation, it is authoritative over conflicting older wording only for:

- bounded pre-APPLY coordinator persistence;
- complete staging checkpoint semantics;
- persisted-state equality before transition approval;
- v2 transition fingerprinting;
- the dedicated SOS-light v2 Node freeze gate;
- bounded coordinator/progress requirements.

All non-conflicting current-runtime authority in the amended contracts remains unchanged.
