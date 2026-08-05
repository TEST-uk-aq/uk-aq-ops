# DRAFT: R2 history Integrity Factory

## Draft status

This document is a non-authoritative design draft.

It must not be used to constrain, modify or replace the current Integrity implementation unless the user explicitly asks to promote and implement this draft. Active Integrity behaviour remains governed by the contracts under `system_docs/r2_history/`.

The proposed design applies to the observations domain only:

```text
history/v2/observations
```

It does not define AQI-history repair or core-history retention.

The active run-level exclusion contract is [`../../r2_history/observations_run_exclusion_contract.md`](../../r2_history/observations_run_exclusion_contract.md). The active month, year and root hierarchy is [`../../r2_history/observations_manifest_hierarchy_contract.md`](../../r2_history/observations_manifest_hierarchy_contract.md). Current Integrity behaviour remains defined by [`../../r2_history/integrity.md`](../../r2_history/integrity.md) and its active linked contracts.

## Proposed factory model

Integrity would become a staged factory:

```text
find
    -> durable queue
        -> leaf builders
            -> parent builders
                -> final verification
```

Finders would be inspectors. Queue items would be repair orders. Builders would be factory stations. Final verification would be quality control.

Finders would not repair live R2, modify manifests, alter queue outputs from a builder or mark a repair complete.

Builders would not invent findings that were never observed or broaden the selected scope silently. A builder could create the required parent work item after successfully completing a child repair.

## Proposed scan run identity

Every Integrity invocation would have one immutable `scan_run_id`.

The identity would be shared by:

- high-level finder;
- low-level finder;
- finder completion records;
- all queue rows created by that scan;
- builders processing those rows;
- final verification and audit output.

A process boundary would receive the exact `scan_run_id` explicitly. Child processes would not derive a replacement identity from the current time.

## Proposed finder 1: `integrity_highlevel_find`

The high-level finder would check the aggregate observation hierarchy:

```text
day manifests
    -> month manifests
        -> year manifests
            -> observations-root manifest
```

It would run across all available observation history during every scheduled daily Integrity run.

It would be lightweight. It would read manifest objects and R2 or Dropbox metadata required to validate hierarchy identity. It would not read observation Parquet bodies.

It would detect the issue classes defined in the active observations manifest hierarchy contract, including missing, extra, malformed and hash-mismatched aggregate relationships.

Its findings would enter the high-level queue class:

```text
queue_YMD
```

The location key would identify the affected hierarchy level and the relevant year, month or day. Root-level findings would use an explicit root level rather than an invented date.

## Proposed finder 2: `integrity_lowlevel_find`

The low-level finder would deeply check selected observation days:

```text
Parquet files
    -> pollutant manifests
        -> connector manifests
            -> day manifests
```

Its repair unit would remain:

```text
day_utc + connector_id + pollutant_code
```

Its findings would enter the low-level queue class:

```text
queue_DCP
```

The location key would contain:

```text
day_utc
connector_id
pollutant_code
```

The low-level finder would follow the source, mapping, canonical-row, content-hash, preservation and fail-closed rules in the active Integrity contract.

## Proposed scheduled daily low-level selection

For the scheduled daily profile, the low-level finder would check:

1. the 14 consecutive UTC days ending on the latest committed observations day visible to the selected Integrity baseline;
2. the allocated historical day in every represented earlier calendar month;
3. any missed logical-date catch-up selections required by the active daily-profile selection contract.

The proposed 14-day recent window would supersede the seven-day recent window currently stated in the active daily-profile contract only when this draft is promoted. The historical day-number allocation, represented-month rules and catch-up behaviour would otherwise remain unchanged.

Selected recent dates would remain consecutive calendar dates even when a day directory is missing, so a missing recent day could become a finding.

## Proposed finder execution order

After the Integrity run acquired the observations lease, the high-level and low-level finders could run concurrently.

They would both be read-only and inspect the same stable baseline.

Running high-level first would be permitted for a simpler initial implementation, but it would not change the low-level scope or repair anything before the low-level finder completed.

## Proposed finder completion barrier

Each finder would write an immutable completion result for the `scan_run_id`:

```text
highlevel_find_complete
lowlevel_find_complete
```

A factory-ready signal would be produced only when both required finder results existed and neither finder ended in an unhandled or uncertain state.

Builders would not start before the factory-ready signal.

There would be no indefinite builder waiting period. Builders would be released by the explicit completion barrier.

If one finder failed, the scan would remain incomplete. No builder from that scan would begin unless a separate narrowly defined recovery contract explicitly permitted processing a known complete subset.

## Proposed queue separation

The Integrity database would use separate durable queue tables for the two repair-order shapes:

```text
queue_DCP
queue_YMD
```

Physical SQL identifiers should use unquoted lowercase names, but schema naming would be finalised in the schema repository implementation phase.

The tables could share common columns and helper functions, but one polymorphic table should not blur the different location keys, dependency rules or builder ownership.

Every queue item would record at least:

```text
scan_run_id
issue_type
location key
observed identity
expected identity or expected derivation
status
detected_at
attempt count
last error
```

A queue row would record evidence and requested work. It would not be authoritative proof that the issue still existed at build time.

## Proposed idempotency and duplicate findings

A repeated scan could rediscover an unresolved issue.

The queue layer would coalesce duplicate active repair orders for the same logical object and issue type rather than create unbounded duplicate work.

Historical findings and attempts would remain auditable. Coalescing would not erase evidence from earlier scans.

## Proposed builder precondition

Before mutation, every builder would:

1. verify that the owning Integrity run still held the observations lease;
2. re-read or otherwise refresh the exact current object identities needed for its key;
3. determine whether the queued issue still existed;
4. complete as a verified no-op when a newer valid state had already resolved it;
5. fail closed when the current state was contradictory or outside the authorised scope.

A queue item alone would not be permission to overwrite a newer valid object.

## Proposed builder chain

Repair propagation would be bottom-up:

```text
pollutant builder
    -> connector builder
        -> day builder
            -> month builder
                -> year builder
                    -> observations-root builder
```

A lower-level builder would create or activate the required parent repair order only after its own output had been written and verified.

A parent builder would not run while unresolved active child work for the same parent remained in the current factory run.

## Proposed work coalescing

Builders would gather all completed or ready child work for their parent key before rebuilding that parent.

Examples:

- several pollutant repairs for one connector-day would lead to one connector-manifest rebuild;
- several connector repairs for one day would lead to one day-manifest rebuild;
- several changed days in one month would lead to one month-manifest rebuild;
- several changed months in one year would lead to one year-manifest rebuild;
- all changed years would lead to one observations-root rebuild.

Coalescing would be driven by queue state and the finder completion barrier. It would not depend on an arbitrary indefinite sleep.

## Proposed Dropbox baseline and live R2 use

Finders would use the run-pinned Dropbox baseline and authoritative source inputs defined by the active Integrity contract. They would not use live R2 as an unpinned comparison baseline.

Builders could use validated Dropbox objects to preserve unchanged child content, but changed leaf observation data would come from the authoritative historical source under the active Integrity contracts.

Before writing a parent, the builder would use:

- verified outputs from completed child builders in the current run;
- current valid unchanged child identities;
- the canonical shared manifest builders.

Under the global observations lease, the builder would refresh the live child manifests needed to prevent overwriting a newer valid object. Dropbox would not be treated as automatic authority to replace a newer live object merely because it was the finder baseline.

## Proposed builder ownership

Builders would be separated by the object they produce. A builder would not reach upwards and publish several unverified parent levels as one opaque operation.

Each builder would own:

- loading the required child evidence;
- canonical object construction;
- put-if-changed behaviour;
- read-back verification;
- its queue transition;
- creation or activation of the immediate parent work item.

Parent propagation would continue only after verification succeeded.

## Proposed queue lifecycle

The lifecycle would distinguish at least:

```text
open
claimed
building
verified
no_op
failed_retryable
failed_blocked
```

Claiming would be atomic and have a bounded lease or claim expiry so an abandoned worker did not own an item forever.

A queue claim would be separate from the global observations run lease. The queue claim would coordinate factory workers inside the one Integrity run; it would not permit another Integrity or Prune Daily run to overlap.

## Proposed failure behaviour

A child failure would block its dependent parent branch.

For example, if one pollutant repair failed:

- the connector builder for that connector-day would not publish a completed connector manifest from an incomplete child set;
- the day, month, year and root branch would remain unadvanced for that repair;
- unrelated branches in the same run could continue when their dependencies were complete and the existing fail-closed scope rules permitted it.

A parent hash would never be advanced merely to clear a queue.

## Proposed final verification

After all reachable builder work completed, Integrity would perform final verification for the affected branches.

Final verification would confirm:

- repaired leaf data and pollutant manifests matched authoritative source evidence;
- connector and day manifests contained the correct complete child set;
- month, year and root content hashes agreed with their committed children;
- all verified or no-op queue items had corresponding evidence;
- blocked or failed items remained visible and prevented a false overall success.

The run would release the observations lease only after final verification and final audit persistence completed or failed safely.

## Proposed initial implementation boundary

A first implementation could introduce the finders, completion barrier and queues before every specialised builder was available.

In that state:

- finding would remain non-mutating;
- unavailable builders would leave repair orders open or blocked;
- no compatibility path would silently return to direct find-and-repair behaviour;
- existing explicitly selected safe repair modes would remain governed by their current contracts until migrated deliberately.

## Proposed structural validation policy

Before deployment, validation would be limited to proving that:

- both finders could not mutate live R2;
- both completion records were required before builders started;
- duplicate active findings coalesced correctly;
- parent work could not complete before required child work;
- builder revalidation could turn stale work into a verified no-op;
- queue claims expired safely;
- a failed child blocked its parent branch.

Functional acceptance would occur through real TEST scans and factory runs after deployment.
