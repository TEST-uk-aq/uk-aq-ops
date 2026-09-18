# SOS-light historical replacement model

## Authority and scope

This document is the broad authoritative contract for the dedicated write-enabled UK-AIR SOS historical replacement path, referred to as **SOS-light**.\n\nFor the load-bearing planning, authority and R2-access model used by both fixed-generation entry points, [`sos_light_three_phase_authority_contract.md`](sos_light_three_phase_authority_contract.md) is the narrower authority. Where older wording here conflicts with that three-phase contract, the three-phase contract wins.

It overrides conflicting dedicated-SOS requirements in:

- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md);
- [`direct_selected_partition_replacement_contract.md`](direct_selected_partition_replacement_contract.md);
- [`protected_connector_preservation_contract.md`](protected_connector_preservation_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

Cross-run observation exclusion and the current Dropbox starting-state gate are defined by [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md).

The generic Integrity path, Prune Daily and non-SOS repair paths remain unchanged except where another active contract explicitly changes them.

## Core purpose

SOS-light exists to make connector `1` historical observations correct with the smallest reliable current process.

The model remains deliberately simple for the index-v3 cut-over period:

```text
fresh SOS source
+ current pinned Dropbox history baseline
= complete replacement day

complete replacement day
-> delete existing R2 observation day
-> upload the assembled replacement day
-> rebuild affected observation indexes/manifests
```

Existing live R2 observation bodies are not a planning, preservation or comparison authority for this mode.

The current whole-day replacement behaviour is intentionally retained for now. A future Integrity Factory & Warehouse (IFW) replaces this temporary SOS-light path and may use a narrower DCP repair model under a later deliberate contract change.

## Temporary fixed-generation implementation split

SOS-light is a temporary bridge while IFW is completed. During the v2 to v3 transition it MUST use two separate operator entry points rather than one generation-aware SOS-light program.

The required entry-point names are:

```text
uk-aq-history-integrity-sos-light-v2.sh
uk-aq-history-integrity-sos-light-v3.sh
```

The two entry points have fixed generation ownership:

```text
sos-light-v2 -> v2 observation history only
sos-light-v3 -> v3 observation history only
```

The v2 entry point is the existing working SOS-light implementation renamed mechanically. Its behaviour MUST remain otherwise unchanged so it remains available for LIVE while LIVE still uses v2.

The v3 entry point is a dedicated v3 copy of the known-working v2 SOS-light path. It should preserve the existing SOS-light flow and safety behaviour, changing only what is required to operate on the v3 history generation, v3 core snapshot, v3 Dropbox backup/checkpoint authority and `_index_v3` observation indexes.

This duplication is deliberate. SOS-light is short-lived, so simple operational separation is preferred over introducing generation-selection branches into the temporary implementation.

Neither entry point accepts a `--history-version` style selector or otherwise switches generation at runtime. Each MUST fail closed if the evidence or paths it is asked to use belong to the other generation. There is no v3-to-v2 or v2-to-v3 fallback inside SOS-light.

No compatibility wrapper is required for the previous generic runner filename. The old generic entry point may be replaced by the explicitly named v2 entry point when the implementation is renamed.

Supporting implementation files MAY also be duplicated where that keeps the two temporary paths simpler and more obviously generation-isolated. Shared code is not a goal for this stop-gap unless it already exists and can be reused without adding generation-selection complexity.

This split is intentionally temporary and MUST NOT be copied into IFW architecture. IFW remains the future version-aware integrity system and should own generation selection explicitly when it replaces SOS-light.

This split does not itself change the identity of the shared global observations operation lock. Both SOS-light entry points must continue to participate in the same cross-operation lock as the normal history backup and Prune Daily until a separate lock-name migration is deliberately completed.

## Global observations operation ownership

SOS-light is an Integrity mode and therefore owns the same global observations operation advisory lock as every other Integrity invocation:

```text
uk_aq:r2_history:v2:observations_global_operation
```

The normal R2-to-Dropbox history backup also uses this same global lock while it establishes and publishes the canonical Dropbox observation generation.

Before normal SOS comparison/assembly work proceeds, the run order is:

```text
request-level IngestDB boundary passes
-> acquire global observations operation lock
-> verify selected Dropbox backup/checkpoint is complete and valid
-> require the successful backup to have completed after
   the latest relevant completed R2 writer, including
   Prune Daily and Integrity/SOS-light repair
-> read the Dropbox fully processed observations-root content_hash
-> read the current live R2 observations-root content_hash
-> require exact equality
-> pin the Dropbox baseline
-> acquire/pin SOS source evidence
-> DETECT
-> PROPOSE the complete local overlay and all affected derived objects
-> APPLY the frozen mutation set
-> verify only the changed/removed R2 result
-> final verification/audit
-> release global observations operation lock
```

The backup/writer ordering check and observations-root hash equality are the hard Step 0 gate.

If either fails, SOS-light MUST stop immediately before DETECT. It MUST NOT continue into year/month/day hash comparison, child inspection, repair planning or reconciliation.

The observations-root hash is the primary and sufficient normal content comparison. A root mismatch means the selected Dropbox baseline is not accepted for repair. It is not permission to decide which side is correct or to merge live R2 into the proposal.

This prevents the relevant hazards:

- Prune Daily cannot interleave a newer observation write while SOS-light is running;
- the normal Dropbox backup cannot change the pinned Dropbox observation baseline while SOS-light is running;
- SOS-light cannot deliberately use a Dropbox generation that predates the latest relevant completed writer;
- SOS-light cannot start from a Dropbox canonical observation generation whose root identity differs from live R2.

An immediate Dropbox backup after SOS-light completes is not required. A later write-enabled Integrity/SOS run remains blocked until a subsequent complete backup has completed after that repair and passes both the writer-ordering and root-hash gates.

## Authorities

### Connector 1

Fresh identity-pinned SOS source evidence is authoritative for selected connector `1` pollutants.

The supported source-built pollutants are:

```text
pm25
pm10
no2
o3
```

For every selected day and pollutant, source acquisition, mapping, canonicalisation and reproducibility remain fail-closed.

### Other connectors

The accepted current pinned Dropbox history baseline is the preservation authority for connectors other than connector `1` within a selected day.

The run-level Dropbox/live-root currentness gate does not make live R2 child bodies a preservation source. After the baseline has been accepted, SOS-light MUST NOT inspect existing live R2 child bodies to decide:

- which other connectors exist;
- which other connector pollutants exist;
- which old live references should be preserved;
- whether a particular live child returns `404`;
- whether an unprotected connector is complete.

For non-connector-1 content, the rule remains:

```text
use what is available in the accepted current Dropbox baseline
warn about unusable unprotected content where the contract permits
never silently merge arbitrary live R2 bodies back into the replacement
```

## Selected day is the destructive replacement unit

In SOS-light, the destructive R2 unit remains the complete observations day prefix for the entry point's fixed generation:

```text
sos-light-v2: history/v2/observations/day_utc=<selected day>/
sos-light-v3: history/v3/observations/day_utc=<selected day>/
```

It is not only an individual connector `1` pollutant prefix.

Before live mutation, the complete replacement day MUST be assembled locally. After local validation succeeds, SOS-light MUST:

1. delete the existing complete selected R2 observation day prefix;
2. verify the required deletion outcome through the bounded deletion mechanism;
3. upload the complete locally assembled replacement day;
4. publish rebuilt parent manifests in child-before-parent order;
5. rebuild affected observation indexes from the assembled local result;
6. verify the objects required by the current run's publication contract.

The existing R2 day is discarded as a whole. SOS-light MUST NOT merge old live R2 children back into the replacement.

## Local day assembly

For each selected day, create one complete local replacement tree from:

```text
accepted current Dropbox day snapshot
+ current-run connector 1 source-built replacements
```

The accepted Dropbox baseline identifies the preservation source for other-connector content.

If the selected day is absent from a complete accepted Dropbox checkpoint, SOS-light may treat the Dropbox contribution for that day as empty only when that absence is consistent with the accepted current committed observation generation. It MUST NOT reinterpret a missing/placeholder/incomplete local Dropbox day as authoritative absence.

In practical terms, the backup/checkpoint completeness and current-root equality gate MUST already have succeeded before such an empty-day case is accepted.

The final assembled day may therefore contain connector `1` only when the current accepted baseline genuinely contains no other selected-day content.

SOS-light MUST NOT invent other connectors or recover their content from live R2 when the accepted baseline has no such content.

The assembly order is:

1. start with the usable accepted Dropbox observation objects for the selected day, or an authoritative empty local day when the accepted current baseline contains none;
2. remove the selected connector `1` pollutant subtrees from that local assembly;
3. insert the complete current-run source-built connector `1` pollutant subtrees;
4. rebuild connector `1` parent metadata from the final connector `1` child manifests actually present in the assembled tree;
5. retain other connector content from the accepted Dropbox baseline according to the existing best-effort rules;
6. rebuild the selected day parent from the final connector parents present in the assembled tree;
7. rebuild affected observation indexes from the same assembled local result.

No live R2 body is part of this assembly.

## Connector 1 parent rule

Connector `1` is protected and strict.

Its connector manifest MUST be generated from the complete final connector `1` child set in the assembled replacement day.

That set is the union of:

- every current-run selected connector `1` pollutant manifest successfully built from SOS source;
- any unselected connector `1` pollutant manifest deliberately retained from the accepted Dropbox baseline.

The old Dropbox connector `1` parent list MUST NOT be treated as the complete final child list when newly created valid children are present.

In particular:

```text
current run creates O3 child
-> connector 1 parent MUST include O3
```

The connector `1` parent dependencies, body references, pollutant codes, counts and hashes MUST all describe the same complete final child set.

Any contradiction, missing required source-built child, invalid connector `1` child or inability to build a correct connector `1` parent MUST stop the run before deletion.

## Other connector rule

Connectors outside the protected set remain warning-only in SOS-light only where the accepted baseline itself remains structurally usable enough for the complete-day publication contract.

For each other connector:

- copy usable objects and metadata from the accepted Dropbox baseline;
- do not compare them with live R2 bodies;
- do not require live R2 body readability;
- do not repair them from live R2;
- do not let a non-authoritative live child influence preservation decisions.

Where Dropbox contains a usable connector parent, SOS-light MAY carry it into the assembled day without validating every descendant body beyond the requirements of the current publication/backup contract.

Where a Dropbox connector parent is missing or unusable, SOS-light MAY omit that connector only when the existing SOS-light preservation rules and complete-day proposal validation allow that omission without contradicting the accepted baseline's required canonical objects. The omission MUST be recorded prominently.

Where a Dropbox child is missing or unusable but a parent can be rebuilt safely from the remaining accepted local children, SOS-light MAY rebuild that parent from the usable local Dropbox children.

These best-effort rules exist only to produce a publishable replacement day around a correct connector `1`. They do not certify other connectors as source-correct.

## Protected connector set

The protected connector set remains explicit and recorded in run state and reports.

Current required value:

```text
1
```

Future deliberate expansion may add Breathe London Nodes and Breathe London Communities:

```text
1,2,3
```

Adding another protected connector requires a separate source-authority and assembly contract for that connector. Merely adding an ID to configuration MUST NOT silently make Dropbox authoritative for its protected source observations.

## R2 access boundary

Before destructive replacement, SOS-light may read only the live R2 observations-root metadata required for the Step 0 `content_hash` equality gate. It MUST NOT read live R2 observation/index bodies or lower-level hierarchy content for planning, comparison, preservation or dependency discovery. Non-content coordination such as the shared global operation lock remains permitted.

After the proposal is complete and frozen, permitted live R2 activity is limited to execution and post-apply verification:

- listing keys only as needed to execute the already-planned deletion of the complete selected day prefix;
- deleting the selected day prefix or other already-planned replaced/removed objects;
- PUTting the complete proposed replacement bytes;
- required post-PUT verification for objects written by the run;
- bounded verification of required deletion absence;
- publishing and verifying rebuilt observation manifests/indexes already present in the frozen proposal.

A pre-existing live child `404`, dangling reference, unexpected live connector body or missing/changed live index MUST NOT influence local assembly or proposal generation because the accepted Dropbox generation, not live R2, is the pre-apply authority.
## Failure policy

### Blocking

The run MUST stop before deletion when:

- the global observations operation lock cannot be acquired or retained;
- the request-level IngestDB boundary fails;
- the selected Dropbox checkpoint is incomplete or cannot prove the current committed observations-root identity;
- Dropbox processed observations-root identity differs from current live R2 observations-root identity;
- connector `1` has any unresolved source acquisition/coverage/parsing/mapping/canonicalisation/reproducibility problem;
- selected connector `1` Parquet/manifest construction is incomplete;
- final connector `1` child-set completeness cannot be established;
- connector `1` parent construction fails;
- local proposal consistency fails;
- safe complete-day replacement planning cannot be established.

The run MUST also stop before deletion if the selected history evidence, core snapshot, Dropbox backup/checkpoint or observation/index target belongs to a generation other than the fixed generation of the invoked SOS-light entry point.

### Warning-only

Problems belonging solely to unprotected connector content may remain warnings where the accepted baseline and proposal contract still permit a complete deterministic replacement.

A merely stale or incomplete Dropbox baseline is NOT warning-only. It blocks before normal SOS work.

## Index construction

Affected observation indexes MUST be rebuilt from the final local overlay:

```text
accepted current Dropbox canonical baseline
+ complete assembled selected-day result
= final local canonical state
-> deterministically rebuild every affected derived index
```

Existing live R2 index objects are not reconstruction dependencies. Existing Dropbox index objects are not required preservation dependencies when the index can be regenerated from canonical backed-up inputs.

For SOS-light, inability to rebuild a required v2 or v3 derived index from the pinned Dropbox canonical baseline plus the repair overlay is an implementation defect. It is not permission to consult live R2 or expand normal Dropbox backup scope.

All changed indexes remain subject to deterministic byte-stability and required publication verification.

AQI data and AQI indexes remain outside SOS-light.

`sos-light-v2` continues to use the existing v2 observation writer/index path. `sos-light-v3` uses the canonical v3 physical observation writer and v3 exact/scoped index builders. Neither entry point may publish observation history or observation indexes into the other generation.
## Current-state reconciliation

After the complete assembled R2 day and affected observation indexes are successfully written and verified:

1. derive current-state candidates from final verified connector `1` observations;
2. reconcile Timeseries through its existing owner route;
3. reconcile Latest Snapshot for `pm25`, `pm10` and `no2` through its existing owner route;
4. keep O3 outside Latest Snapshot while retaining its Timeseries behaviour;
5. report R2, Timeseries and Latest Snapshot outcomes independently.

Other connectors copied from Dropbox do not create current-state reconciliation candidates in a connector `1` SOS-light run.

## Required audit

Every SOS-light run MUST report:

- `mode = sos-light`;
- fixed `history_generation = v2|v3` implied by the invoked entry point;
- global observations operation lock acquisition/release outcome;
- requested IngestDB boundary outcome;
- selected Dropbox backup/checkpoint identity;
- Dropbox fully processed observations-root hash;
- current live R2 observations-root content hash;
- root identity match result;
- selected days and connector `1` pollutants;
- confirmation that SOS source plus accepted Dropbox baseline were the assembly authorities;
- confirmation that no existing live R2 observation body was used for planning/preservation;
- complete final connector `1` child set by day;
- complete final connector set by day;
- Dropbox selected-day presence/authoritative absence by day;
- Dropbox-only warning/omission counts for other connectors;
- complete-day delete count and uploaded object count;
- changed-object verification results;
- affected observation index results;
- Timeseries and Latest Snapshot outcomes.

## Minimal structural validation

Before operational TEST execution, use only the smallest targeted checks needed to prove:

1. the v2 and v3 SOS-light entry points are separately named and each is fixed to exactly one history generation;
2. neither entry point exposes a normal runtime history-generation selector or cross-generation fallback;
3. SOS-light acquires the same global observations operation lock as Prune Daily and the normal Dropbox history backup;
4. Dropbox/current-live-root equality is evaluated only after that lock is held;
5. a stale/mismatched Dropbox generation blocks before normal SOS assembly/mutation;
6. a current accepted baseline is pinned for the run and cannot be changed by the normal backup while the lock is held;
7. a selected day is assembled from SOS source plus accepted Dropbox content without reading existing live R2 bodies;
8. the full selected R2 day prefix remains the deletion target;
9. a newly created connector `1` O3 child is included in the rebuilt connector `1` parent even when the old Dropbox parent omitted O3;
10. connector `1` parent body/dependency evidence describe the same complete final child set;
11. the final day parent uses the assembled local connector set;
12. affected indexes are built from the accepted baseline plus assembled day, not arbitrary live R2 bodies;
13. current-state reconciliation starts only after successful replacement verification.

Do not create a broad speculative test suite. Functional validation belongs in real TEST operation.

## Terminology

Use **SOS-light** for the temporary historical replacement model. Use **sos-light-v2** and **sos-light-v3** when it is necessary to distinguish the two fixed-generation implementations or operator entry points.

Older terms such as “dedicated SOS historical replacement”, “protected-connector preservation route” and “direct selected-partition replacement” may remain as implementation history, but the active model defined here is SOS-light.