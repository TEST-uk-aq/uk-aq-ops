# Protected connector preservation contract

## Authority and scope

This document is an authoritative amendment to:

- [`direct_selected_partition_replacement_contract.md`](direct_selected_partition_replacement_contract.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

It defines how a dedicated write-enabled historical replacement run preserves, omits and reports existing observation-history metadata belonging to connectors outside the selected replacement scope.

Where those documents require every preserved out-of-scope child to remain structurally accounted for, this document is authoritative for dedicated protected-connector historical replacement runs.

This contract does not weaken source, proposal, mutation or verification requirements for a selected protected connector. It changes only whether broken metadata belonging solely to an unprotected connector may block publication of a valid protected-connector replacement.

## Core principle

A connector that is operationally protected MUST be correct and MUST fail closed when its required source evidence, proposal, existing preserved metadata, mutation or verification is incomplete or invalid.

A connector that is not operationally protected MUST NOT veto correction of a valid protected connector merely because the unprotected connector has missing, unreadable, contradictory or dangling history metadata.

For a dedicated protected-connector repair:

```text
protected connector problem
-> blocking failure

unprotected connector preservation problem
-> warning, narrowest safe omission, continue
```

## Protected connector set

The active protected connector set MUST be explicit, deterministic and recorded in every run report.

The current required protected connector set is:

```text
connector_id=1  UK-AIR SOS
```

The implementation MUST support deliberate later expansion of the protected set without changing the preservation algorithm. Breathe London Nodes and Breathe London Communities, connector IDs 2 and 3, are expected future additions but are not protected by this contract until the configured protected set explicitly includes them.

The protected set MUST NOT be inferred from whichever connectors happen to have valid metadata in a selected day.

A write-enabled dedicated replacement MUST fail before mutation when:

- the configured protected connector set is absent, empty or invalid;
- a selected mutation connector is not in the protected set;
- the selected protected connector identity is ambiguous;
- a required protected connector child or parent cannot be validated or rebuilt safely.

The resolved protected connector IDs MUST be persisted in the run state, JSON report and human-readable report.

## Selected protected connector requirements

For every selected protected connector, retain all existing strict requirements, including:

- complete identity-pinned source acquisition;
- complete canonical selected-partition proposals;
- exact selected-prefix tombstones;
- final proposal-graph validation;
- dependency-ordered R2 mutation;
- one post-PUT verification GET per changed object;
- semantic equality between source evidence, staged Parquet, live Parquet and written manifest;
- correct protected connector, day and index publication;
- final verified R2 evidence before current-state reconciliation.

A warning policy for unprotected connectors MUST NOT convert any protected-connector error into a warning.

If an existing unselected child belonging to a protected connector is required to rebuild that connector's parent metadata, it MUST remain readable and valid or the run MUST fail before mutation.

## Preservation of healthy unprotected metadata

Healthy readable unprotected connector metadata SHOULD be preserved in rebuilt parent manifests and indexes.

For each existing unprotected child referenced by the affected metadata graph, Integrity SHOULD validate and retain it when the required child manifest is readable and structurally valid.

The run MUST NOT rewrite unprotected Parquet or pollutant data merely because a protected connector is being repaired.

## Broken unprotected metadata

When metadata belonging solely to an unprotected connector is missing, unreadable, malformed, contradictory or refers to a missing required child, Integrity MUST:

1. classify the defect as an unprotected preservation warning;
2. omit the broken item at the narrowest safe metadata level;
3. rebuild affected parent manifests and indexes without the omitted broken reference;
4. leave all underlying unprotected R2 objects untouched;
5. continue the protected-connector replacement when the complete protected publication graph remains valid;
6. record the omission in immutable run audit evidence.

The narrowest safe omission rules are:

```text
unreadable or invalid pollutant manifest
-> omit only that pollutant from its connector parent and derived indexes

connector parent cannot be rebuilt safely from readable valid children
-> omit that connector from the affected day parent and derived indexes

day contains no publishable children after omission
-> omit that day only from higher discovery metadata, unless a selected protected connector was required for that day
```

A selected day containing a valid selected protected connector MUST still publish the protected connector's valid hierarchy even when one or more unprotected connectors are omitted.

The implementation MUST NOT create a parent reference to a child known to return 404 or fail structural validation.

## No-delete rule for omitted unprotected objects

Warning-only omission is a metadata quarantine action, not deletion authority.

Integrity MUST NOT delete, overwrite, tombstone or otherwise mutate an omitted unprotected connector's existing:

- Parquet parts;
- pollutant manifests;
- connector manifests;
- connector-specific indexes;
- other child objects.

Only parent manifests or shared discovery indexes that must be rebuilt for the selected protected connector may stop advertising the broken unprotected item.

Orphaned or undiscoverable unprotected objects MAY remain in R2 for later diagnosis and repair.

A separate explicit repair or deletion operation is required to change those underlying unprotected objects.

## Parent manifests and indexes

Affected shared parent manifests and indexes MUST be rebuilt from:

1. the final verified selected protected-connector children;
2. readable and valid preserved protected-connector children;
3. readable and valid preserved unprotected children;
4. no known-broken or unreadable unprotected child references.

The resulting parent metadata represents the set of valid publishable children established by the current run. It is not required to retain a dangling reference solely because an older parent advertised it.

Publication order remains child before parent. A protected connector's parent and shared day metadata MUST NOT be published until all changed protected children have completed their required verification.

Omission of an unprotected child MUST NOT allow publication of an unverified protected child.

## Pre-mutation assessment

Before the first live R2 DELETE or PUT, the final proposal assessment MUST:

- validate the complete protected-connector proposal graph strictly;
- inspect the required preservation graph for affected shared parents;
- collect all unprotected preservation defects it encounters rather than stopping at the first one where practical;
- calculate the exact narrowest omissions;
- prove that no planned delete or overwrite targets an omitted unprotected object;
- prove that all proposed parent manifests and indexes contain no references to known-broken omitted children;
- fail if an omission would make a selected protected connector incomplete or undiscoverable.

This assessment MAY complete with warnings and permit mutation when all protected-connector requirements pass.

## Audit requirements

Every dedicated protected-connector run MUST report:

- resolved protected connector IDs;
- selected mutation connector IDs;
- protected connector validation status;
- count of healthy unprotected children preserved;
- count of unprotected pollutant omissions;
- count of unprotected connector omissions;
- count of unprotected day-level omissions, if any;
- every omitted `day_utc`, `connector_id`, `pollutant_code` where known;
- missing or invalid R2 key;
- failure classification and concise reason;
- parent manifests and indexes rebuilt without the item;
- confirmation that underlying omitted objects were not deleted or overwritten;
- warning samples and a complete machine-readable omission list;
- final protected-connector R2 verification status.

A run may finish successfully with warnings when:

- every selected protected connector partition is complete and verified;
- every required protected parent and index is correct;
- every unprotected omission follows this contract;
- no omitted unprotected underlying object was mutated.

The overall status MAY remain `ok` with a non-zero warnings count, but the report MUST make unprotected omissions prominent and machine-readable.

## Current SOS acceptance case

For a dedicated SOS repair of connector 1 covering 17 June through 30 July 2026, this pre-existing defect MUST NOT block the SOS replacement:

```text
history/v2/observations/day_utc=2026-07-12/connector_id=7/pollutant_code=humidity/manifest.json
-> 404 NoSuchKey
```

Required behaviour:

1. connector 1 remains strictly validated and replaced;
2. connector 7 humidity is reported as an unprotected preservation warning;
3. connector 7 humidity is omitted from rebuilt parent metadata and derived shared indexes;
4. connector 7 humidity underlying objects are not deleted or overwritten;
5. any other readable valid connector 7 children are preserved;
6. the run continues through protected connector verification and current-state reconciliation.

## Future expansion to Breathe London

When connector IDs 2 and 3 are deliberately added to the protected set:

- their required source and preserved metadata defects become blocking;
- they MUST receive the same strict proposal, mutation and verification treatment as connector 1 when selected;
- unprotected connectors outside the expanded set remain warning-only under the omission rules above.

Adding a connector to the protected set is an operational policy change and MUST be explicit in configuration and run audit evidence.

## Minimal structural validation

Before deployment, run only the smallest focused checks needed to prove:

- a missing unprotected pollutant manifest becomes a warning and narrow pollutant omission;
- the selected protected connector proposal still reaches mutation planning;
- the rebuilt connector/day/index metadata does not reference the omitted child;
- no planned delete, tombstone or overwrite targets the omitted unprotected objects;
- a missing equivalent child for a protected connector remains blocking;
- healthy unprotected siblings remain preserved;
- an invalid or empty protected connector configuration fails before mutation.

Functional validation belongs in the real CIC-Test SOS run. Do not add a broad speculative test suite.
