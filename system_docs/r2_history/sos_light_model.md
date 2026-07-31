# SOS-light historical replacement model

## Authority and scope

This document is the authoritative contract for the dedicated write-enabled UK-AIR SOS historical replacement path, referred to from now on as the **SOS-light model**.

It overrides conflicting dedicated-SOS requirements in:

- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md);
- [`direct_selected_partition_replacement_contract.md`](direct_selected_partition_replacement_contract.md);
- [`protected_connector_preservation_contract.md`](protected_connector_preservation_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

The generic Integrity path, check-only mode, dry-run mode, Prune Daily and non-SOS repair paths remain unchanged unless another contract explicitly migrates them.

## Core purpose

SOS-light exists to make connector `1` historical observations correct with the smallest reliable process.

The model is deliberately simple:

```text
SOS source
+ chosen Dropbox history baseline
= complete replacement day

complete replacement day
-> delete existing R2 observation day
-> upload the assembled replacement day
-> rebuild affected observation indexes
```

Existing live R2 observation content is not a planning, preservation or comparison authority for this mode.

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

The chosen Dropbox R2 history mirror is the only preservation authority for connectors other than connector `1` within a selected day.

SOS-light MUST NOT inspect existing live R2 content to decide:

- which other connectors exist;
- which other connector pollutants exist;
- which old references should be preserved;
- whether Dropbox content agrees with R2;
- whether a live R2 child returns `404`;
- whether an unprotected connector is complete.

For non-connector-1 content, the rule is:

```text
use what is available in the chosen Dropbox baseline
warn about unusable Dropbox content
never let an unprotected connector block a valid connector 1 replacement
```

## Selected day is the destructive replacement unit

In SOS-light, the destructive R2 unit is the complete observations day prefix:

```text
history/v2/observations/day_utc=<selected day>/
```

It is not only an individual connector `1` pollutant prefix.

Before live mutation, the complete replacement day MUST be assembled locally. After local validation succeeds, SOS-light MUST:

1. delete the existing complete selected R2 observation day prefix;
2. verify the required deletion outcome through the bounded deletion mechanism;
3. upload the complete locally assembled replacement day;
4. publish rebuilt parent manifests in child-before-parent order;
5. rebuild affected observation indexes from the assembled local result;
6. verify only the objects written by the current run.

The existing R2 day is discarded as a whole. SOS-light MUST NOT merge old live R2 children back into the replacement.

## Local day assembly

For each selected day, create one complete local replacement tree from:

```text
chosen Dropbox day snapshot
+ current-run connector 1 source-built replacements
```

The chosen Dropbox baseline identifies the preservation source for any other-connector content that is available. It does not require a selected-day directory or any selected-day object to exist in Dropbox.

If the complete selected day is absent from Dropbox, SOS-light MUST treat the Dropbox contribution for that day as an empty baseline and continue assembling the day from current-run connector `1` source evidence. The final assembled day may therefore contain connector `1` only. Absence of the Dropbox day MUST be recorded as warning or audit evidence, but MUST NOT block a valid connector `1` replacement.

SOS-light MUST NOT invent other connectors or recover their content from live R2 when the Dropbox day is absent.

The assembly order is:

1. start with the available Dropbox observation objects for the selected day, or an empty local day when Dropbox has no selected-day objects;
2. remove the selected connector `1` pollutant subtrees from that local assembly;
3. insert the complete current-run source-built connector `1` pollutant subtrees;
4. rebuild connector `1` parent metadata from the final connector `1` child manifests actually present in the assembled tree;
5. retain other connector content from Dropbox on a best-effort basis;
6. rebuild the selected day parent from the final connector parents present in the assembled tree;
7. rebuild affected observation indexes from the same assembled local result.

No live R2 body is part of this assembly.

## Connector 1 parent rule

Connector `1` is protected and strict.

Its connector manifest MUST be generated from the complete final connector `1` child set in the assembled replacement day.

That set is the union of:

- every current-run selected connector `1` pollutant manifest successfully built from SOS source;
- any unselected connector `1` pollutant manifest deliberately retained from the chosen Dropbox baseline.

The old Dropbox connector `1` parent list MUST NOT be treated as the complete final child list.

In particular:

```text
current run creates O3 child
-> connector 1 parent MUST include O3
```

The connector `1` parent dependencies, body references, pollutant codes, counts and hashes MUST all describe the same complete final child set.

Any contradiction, missing required source-built child, invalid connector `1` child or inability to build a correct connector `1` parent MUST stop the run before deletion.

## Other connector rule

Connectors outside the protected set are warning-only in SOS-light.

For each other connector:

- copy usable objects and metadata from Dropbox;
- do not compare them with live R2;
- do not require live R2 readability;
- do not repair them from live R2;
- do not let their defects stop connector `1` publication.

Where Dropbox contains a usable connector parent, SOS-light MAY carry it into the assembled day without validating every descendant object.

Where a Dropbox connector parent is missing or unusable, SOS-light MAY omit that connector from the rebuilt day parent and record a warning.

Where a Dropbox child is missing or unusable but a parent can be rebuilt safely from the remaining Dropbox children, SOS-light MAY rebuild that parent from the usable local Dropbox children.

Where the entire selected day is absent from Dropbox, there are no other connectors to preserve for that day. This is warning-only and the assembled day may consist solely of the final connector `1` tree.

This best-effort behaviour exists only to produce a complete publishable day around a correct connector `1`. It does not certify other connectors as correct.

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

Before deletion, SOS-light MUST NOT GET or otherwise read existing live R2 observation objects for planning, comparison or preservation.

Permitted live R2 activity is limited to:

- required writer locks and coordination;
- listing keys only as needed to delete the complete selected day prefix;
- deleting the selected day prefix;
- PUTting the complete assembled replacement;
- one post-PUT verification GET for each changed object written by the current run;
- bounded verification of required deletion absence;
- publishing and verifying rebuilt affected observation indexes.

A pre-existing R2 `404`, dangling reference, stale manifest or unexpected connector MUST NOT influence local day assembly because the existing day will be deleted.

## Failure policy

### Blocking

The run MUST stop before deletion when connector `1` has any unresolved problem affecting:

- source acquisition or source coverage;
- source parsing;
- authoritative identity mapping;
- canonical row construction;
- source evidence reproducibility;
- selected pollutant Parquet or manifest construction;
- final connector `1` child-set completeness;
- connector `1` parent construction;
- local proposal consistency;
- safe complete-day replacement planning.

A missing selected-day directory in Dropbox is not a connector `1` failure and is not blocking.

### Warning-only

Problems belonging solely to other connectors MUST be warnings.

Examples include:

- an entire selected day being absent from Dropbox;
- missing Dropbox connector metadata;
- unusable Dropbox child metadata;
- incomplete Dropbox content for an unprotected connector;
- an old live R2 object known from an earlier run to return `404`.

These problems MUST NOT cause SOS-light to read live R2 for preservation decisions and MUST NOT block a valid connector `1` replacement.

## Index construction

Affected observation indexes MUST be rebuilt from:

```text
chosen Dropbox index baseline
+ complete assembled selected-day result
- old selected-day contributions
```

They MUST NOT be rebuilt by merging against existing live R2 day content.

All changed indexes remain subject to deterministic byte-stability requirements and post-PUT verification.

AQI data and AQI indexes remain outside SOS-light.

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
- selected days and connector `1` pollutants;
- chosen Dropbox baseline identity;
- confirmation that source plus Dropbox were the only assembly authorities;
- confirmation that no existing live R2 body was used for planning or preservation;
- complete final connector `1` child set by day;
- complete final connector set by day;
- Dropbox selected-day presence or absence by day;
- Dropbox-only warning and omission counts for other connectors;
- complete-day delete count and uploaded object count;
- changed-object verification results;
- affected observation index results;
- Timeseries and Latest Snapshot outcomes.

Warnings for other connectors MUST be prominent but MAY coexist with overall `status=ok` when connector `1`, the replacement day and required observation indexes are correct.

## Minimal structural validation

Before operational CIC-Test execution, use only the smallest targeted checks needed to prove:

1. a selected day is assembled from source plus available Dropbox content without reading existing live R2 bodies;
2. a selected day absent from Dropbox is assembled successfully from connector `1` source evidence and records warning or audit evidence rather than blocking;
3. the full selected R2 day prefix is the deletion target;
4. a newly created connector `1` O3 child is included in the rebuilt connector `1` parent even when the old Dropbox parent omitted O3;
5. connector `1` parent body and dependency evidence describe the same complete final child set;
6. an unusable other-connector Dropbox item produces a warning and does not block connector `1`;
7. the final day parent uses the assembled local connector set;
8. affected indexes are built from the Dropbox baseline plus assembled day, not live R2;
9. current-state reconciliation starts only after successful replacement verification.

Do not create a broad speculative test suite. Functional validation belongs in real CIC-Test operation.

## Terminology

Use **SOS-light** in plans, implementation reports, logs, run-state fields and future discussions.

Older terms such as “dedicated SOS historical replacement”, “protected-connector preservation route” and “direct selected-partition replacement” may remain as implementation history, but the active model defined here is SOS-light.
