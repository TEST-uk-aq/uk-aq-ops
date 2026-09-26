# SOS-light three-phase authority contract

## Authority and scope

This document is the load-bearing authority for the current temporary SOS-light history-repair model for both fixed entry points:

```text
uk-aq-history-integrity-sos-light-v2.sh
uk-aq-history-integrity-sos-light-v3.sh
```

SOS-light is intentionally a simple temporary repair system. It exists only until the future Integrity Factory & Warehouse (IFW) replaces it.

For SOS-light, this contract supersedes any conflicting requirement in:

- `sos_light_model.md`;
- `integrity_apply_safety_contract.md`;
- `integrity_preflight_generation_and_journal_completion_contract.md`;
- `proposal_dependency_provenance_contract.md`;
- `integrity_global_index_publication_order_contract.md`;
- `observation_history_index_v3_backup_evidence_location_amendment.md`;
- `../backup_and_recovery/r2_history_index_v3_backup_amendment.md`;
- `../backup_and_recovery/r2_history_dropbox_sync_contract.md`.

Those contracts continue to govern their other scopes. This contract changes only SOS-light authority, planning and apply behaviour.

Canonical observation and Parquet output from either SOS-light entry point MUST
follow the [observation-history schema contract](observation_history_schema_contract.md):
emit `verification_status`, never `vstatus`. Temporary legacy read compatibility
does not authorise legacy output. This naming dependency does not change the
planning or publication authority below.

## Non-negotiable model

SOS-light has one small hard currentness gate followed by exactly three conceptual repair phases:

```text
0. CURRENTNESS PRECHECK
   request-level IngestDB boundary passes
   -> acquire global observations operation lock
   -> selected Dropbox backup/checkpoint is complete and valid
   -> backup completed after the latest relevant R2 writer
   -> Dropbox observations-root content_hash == live R2 observations-root content_hash
   -> pin Dropbox baseline
   -> any failure before pinning: stop immediately

1. DETECT
   Dropbox baseline + authoritative repair source
   -> find what is wrong

2. PROPOSE
   Dropbox baseline + repaired data
   -> build a complete local overlay
   -> rebuild every affected derived file/index from that overlay
   -> validate the complete proposed state

3. APPLY AND VERIFY
   mutate only the planned changed/removed R2 objects
   -> then read back/check those changed/removed objects
   -> confirm R2 now contains the proposed result
```

This is the defining SOS-light model.

New implementation work MUST simplify towards these three phases. It MUST NOT add a second source of truth, pre-apply live-R2 dependency discovery, retained-live-object authentication, or backup expansion merely to avoid rebuilding derived data.

## Dropbox is the pre-apply truth

For SOS-light, the accepted pinned Dropbox backup is the authoritative persisted history baseline.

Once the run has accepted and pinned that backup generation:

```text
Dropbox baseline
    = persisted truth before the current repair

authoritative current-run source evidence
    = truth for the selected data being repaired

live R2
    = mutation target only
```

Before the first apply mutation, live R2 MUST NOT be used to decide:

- what observations exist;
- what unaffected connector or pollutant data must be preserved;
- what index children or roots exist;
- what index object should be retained;
- whether Dropbox is correct;
- whether a Dropbox-derived object still exists in R2;
- what dependency membership belongs in a rebuilt index;
- what bytes should be proposed.

The only permitted pre-apply Dropbox-versus-R2 data comparison is the Step 0 observations-root `content_hash` equality gate defined below. That gate is a binary currentness check only. It MUST NOT be used for repair planning, preservation, dependency discovery or reconciliation.

The global observations operation lock and other coordination evidence remain permitted.

## Step 0: hard currentness precheck

SOS-light requires a complete accepted Dropbox backup before write-enabled work.

Step 0 is intentionally small and binary. It MUST complete before DETECT.

The write-enabled gate MUST establish, in this order:

1. the request-level IngestDB boundary passes;
2. acquire the shared global observations operation lock;
3. while that lock is held, verify the selected Dropbox checkpoint is complete and internally valid for the fixed generation;
4. require the latest successful relevant Dropbox backup to have completed after the latest relevant completed R2 writer operation that could have changed canonical observation history, including at least Prune Daily and Integrity/SOS-light repair;
5. read the fully processed Dropbox observations-root `content_hash`;
6. read the current live R2 observations-root `content_hash`;
7. require exact equality between those two root hashes;
8. only after all preceding checks succeed, pin the Dropbox baseline for DETECT and PROPOSE.

The observations-root hash is the primary and sufficient normal content comparison.

If either the backup/writer ordering check or the root-hash equality check fails, SOS-light MUST stop immediately before DETECT. It MUST NOT continue into year/month comparison, child inspection, repair planning or reconciliation.

Normal SOS-light MUST NOT compare year/month/day hashes when the root hash matches. Those lower-level hashes MAY be inspected later by an operator in a separate diagnostic investigation after a failed run, but they are not part of the normal go/no-go gate.

A root-hash mismatch is not a prompt to decide which side is correct. It means the accepted Dropbox baseline cannot be used for this repair until the underlying backup/currentness issue has been resolved.

After Step 0 succeeds, the Dropbox baseline is pinned and becomes the pre-apply truth for DETECT and PROPOSE. Live R2 observation/index contents MUST NOT then be consulted again until APPLY/VERIFY, except for non-content coordination mechanisms.


### Serial monthly wrapper boundary

A wrapper that executes multiple historical months serially MAY satisfy the next invocation's freshness/currentness requirement by running the normal R2 History Dropbox Backup after each successful month and waiting for that exact backup generation to reach the local Dropbox mirror before starting the next month. For this wrapper boundary, the wrapper MUST explicitly request the backup workflow's `observation_parquet_copy_mode=reuse_matching`. Omission remains the normal backup's conservative `full` default for other callers, but the serial monthly SOS-light path deliberately opts into exact canonical Parquet reuse because complete-day republication can produce fresh R2 object metadata and fresh manifest/root identities while leaving many Parquet bodies byte-identical to the preceding accepted Dropbox baseline.

The wrapper MUST verify from the exact backup report that the effective observation Parquet copy mode was `reuse_matching` before accepting that refresh. A backup that completed in another mode is not the contracted serial-monthly refresh for that batch and MUST stop the chain before a later month starts.

For this wrapper boundary, "reach the local Dropbox mirror" means both the matching generation-specific checkpoint identity is locally present **and** the refreshed local files required by the next SOS-light baseline have passed the read-only materialisation/authentication gate defined in [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md). Checkpoint-root arrival by itself is not sufficient evidence of local materialisation. Parquet bodies reported by the exact backup as safely reused under `reuse_matching` are not expected to acquire a new Dropbox modification time or new local materialisation event merely because the surrounding manifests/root changed; the local gate may carry forward their preceding accepted local identity evidence only where the exact key, byte size and canonical SHA-256 remain identical and the local file is still present/readable.

This is external operator orchestration, not a fourth SOS-light repair phase. It MUST follow the serial-monthly rules in [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md). The preceding SOS-light invocation releases the global observations operation lock before the backup begins; the backup acquires that same global lock for its covered operation; the next SOS-light invocation then acquires the lock and performs this complete Step 0 again.

The serial wrapper MUST NOT use `--allow-stale-dropbox`, weaken the backup-ordering requirement, bypass the exact Dropbox/live observations-root equality requirement, or treat `reuse_matching` as permission to accept an unverified destination body. Reuse remains a backup transport optimisation governed by the Dropbox sync contract; Step 0 still pins the fully processed current post-month observations root.

## Phase 1: DETECT

DETECT reads only the sources required to determine correctness:

```text
accepted pinned Dropbox baseline
+
authoritative current-run repair source evidence
```

For connector 1 SOS repair, fresh identity-pinned UK-AIR SOS/fallback source evidence remains authoritative for the selected supported pollutants.

Dropbox supplies the preserved canonical baseline around that repair.

DETECT MUST NOT read live R2 observation or index bodies to find differences.

## Phase 2: PROPOSE

PROPOSE constructs a complete local logical view:

```text
overlay = pinned Dropbox baseline + current-run replacements
```

For a selected observation day, the overlay starts from the complete accepted Dropbox day and replaces the selected connector/pollutant data with the newly built canonical data.

Every parent manifest, aggregate, index or other derived object affected by those replacements MUST be rebuilt from the final overlay state.

The proposal must be complete and internally self-consistent before the first R2 DELETE or PUT.

### Derived indexes are rebuildable data

Observation indexes are derived data.

For SOS-light, every required v2 or v3 observation index MUST be deterministically rebuildable from the canonical inputs available through the pinned Dropbox baseline plus the current repair overlay.

This includes, as applicable:

- pollutant manifests;
- connector manifests;
- day manifests;
- aggregate observation manifests;
- v2 observation-timeseries indexes;
- v3 scoped/exact observation-timeseries indexes;
- v3 global/latest observation-timeseries metadata.

Existing live-R2 index objects are never required as reconstruction inputs.

Existing Dropbox index objects MAY be used as a convenience or diagnostic input only where doing so does not make them canonical observation authority. If a required derived index can be rebuilt from canonical Dropbox-backed data, rebuilding remains the fail-safe path.

For fixed-v3 SOS-light, the checkpoint-authenticated compact latest observation-timeseries object MAY also be used as a retained identity registry for unchanged exact-v3 scoped roots, subject to the strict fast-path rules below. This narrow permission does not make the compact latest authoritative for canonical observations or scoped child bodies.

If the current implementation cannot rebuild a required index from the pinned canonical baseline plus overlay, that is an SOS-light implementation defect to fix. It is not permission to consult live R2 or expand the normal Dropbox backup with derived-index dependency evidence.

### Fixed-v3 compact-latest retained-root fast path

The fixed-v3 planner MAY avoid reconstructing every unchanged historical exact-v3 scope when all of the following are true:

- the compact latest object is the generation-selected object authenticated by the accepted Dropbox checkpoint;
- its schema, canonical encoding, generation, layout/version fields, ordering, uniqueness and aggregate summaries are strictly validated;
- a canonical scope catalogue is independently derived from the pinned Dropbox pollutant manifests plus the current repair overlay;
- every retained compact-latest scoped-root descriptor is cross-checked against that canonical catalogue, including its deterministic scope/key and all summary fields that the canonical manifests can prove without decoding unchanged Parquet;
- the compact registry cannot create, change or remove canonical scopes;
- every affected, new or removed scope is derived from the final canonical overlay state, not from the compact registry;
- every affected non-empty scope is fully rebuilt from canonical Dropbox-backed data plus current-run replacements;
- changed/new rebuilt roots replace registry descriptors deterministically, and conclusively removed scopes are removed explicitly;
- no live R2 read is introduced during DETECT or PROPOSE;
- no complete scoped/exact v3 tree is added to normal Dropbox backup scope.

Under this fast path, retained compact-latest root descriptors are identity-registry evidence for unaffected derived scopes only. They are not evidence for canonical observation content and are not substitutes for rebuilding an affected scope.

If the compact latest is missing, malformed, internally contradictory, contains duplicate scopes, disagrees with the canonical scope catalogue, or cannot otherwise satisfy this fast-path contract, the planner MUST abandon the fast path. It MAY fall back to complete canonical reconstruction from the pinned Dropbox baseline plus overlay. If that fallback cannot complete, the run MUST fail before mutation.

The compact-latest fast path is therefore an optimisation. It MUST NOT become the only way to reconstruct required v3 indexes.

### No retained-external-dependency model

SOS-light MUST NOT require a "retained external dependency" proof against live R2 for unchanged v3 index roots.

There is no requirement to:

- authenticate unchanged v3 scoped-root objects against live R2 before apply;
- copy all referenced v3 scoped roots into Dropbox;
- retain a live-R2 scoped root merely because a proposed global latest references the same logical scope;
- treat an old scoped-root object as irreplaceable source evidence.

The planner may regenerate a complete affected index chain from the overlay and then determine which resulting bytes actually differ. Under the fixed-v3 fast path above, it may instead retain strictly validated compact-latest descriptors for unaffected scopes while rebuilding every affected scope from canonical inputs.

Unchanged deterministic output does not require live dependency validation.

### Proposal payload materialisation and planner/coordinator transport

"Complete proposal" means that every changed object's exact bytes are already materialised, identity-pinned and available to APPLY. It does **not** require every changed body to be embedded inline in one in-memory JSON object or emitted through one stdout payload.

For large fixed-v3 plans, changed object bodies SHOULD be held once in the run-local overlay/staging area and proposal records SHOULD carry bounded control-plane references to those bytes. A body reference MUST identify at least:

- the object key;
- a run-local body location/reference;
- exact byte length;
- SHA-256;
- the proposal/publication identity needed by the existing dependency graph.

Before the proposal is frozen, the planner/final validator MUST prove that every referenced changed body exists locally and that its actual byte length and SHA-256 equal the recorded identity. Missing, unreadable or contradictory body references fail before mutation.

After proposal freeze, referenced staged bytes are immutable for that run. APPLY MUST publish the already-validated staged bytes. It MUST NOT regenerate or reserialise an object during mutation in a way that can change the frozen identity.

The planner/coordinator process boundary MUST remain bounded. It MUST NOT require serialising all proposed bodies into one monolithic stdout/stderr JSON string. Large proposal results MUST be handed off through a run-local proposal artifact or equivalent bounded file-backed representation, with only compact control/progress information crossing stdout/stderr.

A file-backed proposal hand-off MUST itself be authenticated before use. The coordinator MUST receive or derive enough compact evidence to identify the exact artifact, including its run-local path/reference and integrity identity such as SHA-256 and byte length. The artifact MAY contain a compact proposal graph whose changed-body entries reference already-materialised overlay/staging files rather than duplicating those bodies inline.

Progress events such as metadata-planning counters are diagnostic only. They do not replace the final authenticated proposal artifact and do not authorise APPLY.

An inability to materialise, authenticate, persist or load the complete proposal representation is a pre-APPLY failure. It MUST NOT be worked around by reducing dependency validation, consulting live R2, or omitting required changed objects.

## V2 and V3 share the same model

The v2 and v3 SOS-light entry points remain separate fixed-generation programs during the temporary transition, but they follow the same authority model:

```text
Dropbox baseline
+ repair source
-> local overlay
-> rebuild affected derived objects
-> validate
-> apply changed/removed objects
-> verify changed/removed R2 result
```

Generation differences are limited to the correct generation-specific:

- canonical observation paths;
- core snapshot paths;
- writer/serializer;
- manifest/index builders;
- derived index layouts and keys;
- publication order where the format requires it.

The v3 implementation MUST NOT introduce a different trust model merely because its index graph is richer.

The v2 implementation MUST continue working for LIVE while LIVE remains on v2.

## Phase 3: APPLY AND VERIFY

Only after the complete proposal and write/delete set are frozen may SOS-light mutate R2.

For every object that must be removed or replaced, apply uses the already-built local proposal.

The sequence is conceptually:

```text
planned deletion/replacement
-> DELETE old target where required
-> PUT proposed bytes
-> read/check the affected R2 target
-> prove the intended deletion or exact replacement succeeded
```

Post-apply R2 verification is required for the objects changed or removed by the run according to their owning publication contract.

This is the first point at which R2 contents are used to verify data correctness for SOS-light.

Post-apply verification MUST NOT cause the planner to discover additional preservation dependencies or silently alter the frozen proposal. If verification fails, the run reports/fails according to apply safety; it does not re-plan from live R2.

## Complete proposal before mutation

Before the first R2 DELETE or PUT, SOS-light MUST have:

- pinned its accepted Dropbox baseline;
- pinned its run-scoped source evidence;
- assembled every selected replacement day;
- rebuilt all affected parent metadata and indexes from the overlay;
- determined the complete delete/write set;
- generated the exact proposed bytes for every changed object;
- validated dependency/publication ordering between changed objects;
- validated the proposal internally.

Apply is execution of that frozen proposal, not another discovery phase.

## R2 access boundary

Before APPLY, permitted R2 interaction is limited to Step 0's single canonical observations-root `content_hash` currentness read plus non-content operational mechanisms that are unavoidable for coordination. After Step 0 succeeds, the repair planner itself MUST NOT GET/list live observation or index data for correctness, preservation or dependency discovery.

During APPLY, R2 access is limited to the planned mutation and the bounded post-mutation verification required for that planned mutation.

A list operation needed to delete a complete selected day prefix remains permitted as an execution mechanism. It MUST NOT feed planning/preservation decisions.

## Normal Dropbox backup remains simple

SOS-light MUST NOT expand the normal Dropbox history backup merely to preserve derived v3 index dependency objects.

In particular, SOS-light does not require the normal v3 backup to copy:

- every v3 scoped root manifest;
- exact-leaf/page index objects;
- the full `history/_index_v3/observations_timeseries/` tree.

The existing generation-selected compact latest object may remain part of normal backup for operational/recovery purposes, but SOS-light index reconstruction MUST NOT depend on a complete backed-up derived-index tree.

The authoritative repair baseline is the backed-up canonical data required to reconstruct the desired state.

## Failure policy

Before APPLY, SOS-light fails closed when:

- the fixed generation is inconsistent with the selected baseline or target paths;
- the Dropbox backup/checkpoint is incomplete or invalid;
- operational ordering cannot prove the Dropbox backup completed after the latest relevant writer;
- the Dropbox processed observations-root `content_hash` does not exactly equal the live R2 observations-root `content_hash`;
- required source evidence cannot be acquired or reproduced;
- selected replacement observations cannot be built;
- the complete local overlay cannot be assembled;
- a required derived object/index cannot be deterministically rebuilt from the overlay;
- the complete proposed write/delete set cannot be frozen and validated.

It MUST NOT fail merely because an old live R2 child/index object is missing or differs before apply, because live R2 is not the pre-apply authority.

After APPLY starts, failures are governed by the bounded mutation and post-apply verification rules.

## Audit requirements

Every SOS-light report MUST make the simple authority boundary visible.

It must record at least:

- fixed history generation;
- accepted Dropbox backup/checkpoint identity;
- evidence that the accepted backup completed after the latest relevant writer;
- Dropbox processed observations-root `content_hash`;
- live R2 observations-root `content_hash`;
- exact root-hash match result;
- selected source evidence;
- selected repair days/pollutants;
- confirmation that DETECT and PROPOSE used Dropbox plus current-run repair source only;
- confirmation that no live R2 data body/index was used for pre-apply planning or preservation;
- complete proposed delete/write set;
- rebuilt derived-index scope;
- apply results;
- post-apply R2 verification results;
- downstream Timeseries/Latest Snapshot reconciliation outcomes where applicable.

## IFW boundary

This simplicity is deliberate.

SOS-light is not the place to introduce the richer cross-store evidence, warehouse comparison, recovery provenance or multi-source validation architecture intended for the future Integrity Factory & Warehouse.

If a proposed SOS-light feature materially complicates the three-phase model, prefer leaving that capability for IFW unless it is strictly required to make the temporary repair path safe.

## Implementation reconciliation

As of 18/09/2026, the current fixed-v3 implementation contains retained/external-dependency behaviour that is more complicated than this contract and must be simplified before the next accepted fixed-v3 write-enabled repair.

The normal Dropbox backup code was restored to its pre-PR-69 behaviour. That rollback is consistent with this contract: normal backup must not carry a v3 scoped-root dependency-evidence set merely for SOS-light.

Implementation reconciliation must preserve the working fixed-v2 SOS-light path while bringing fixed-v3 back to the same three-phase authority model.
