# R2 history Integrity Factory

## Authority and scope

This document defines the authoritative separation between Integrity finding, repair queues, builders and parent propagation for R2 v2 observations.

It applies to the observations domain only:

```text
history/v2/observations
```

It does not define AQI-history repair or core-history retention.

This contract supplements [`integrity.md`](integrity.md) and supersedes any older assumption that one Integrity stage may detect an issue and repair it directly in the same operation without first creating a durable repair order.

Run-level exclusion is defined by [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md). The month, year and root hierarchy is defined by [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md).

## Factory model

Integrity is a staged factory:

```text
find
    -> durable queue
        -> leaf builders
            -> parent builders
                -> final verification
```

Finders are inspectors. Queue items are repair orders. Builders are factory stations. Final verification is quality control.

Finders must not repair live R2, modify manifests, alter queue outputs from a builder or mark a repair complete.

Builders must not invent findings that were never observed or broaden the selected scope silently. A builder may create the required parent work item after successfully completing a child repair.

## Scan run identity

Every Integrity invocation has one immutable `scan_run_id`.

The identity is shared by:

- high-level finder;
- low-level finder;
- finder completion records;
- all queue rows created by that scan;
- builders processing those rows;
- final verification and audit output.

A process boundary must receive the exact `scan_run_id` explicitly. Child processes must not derive a replacement identity from the current time.

## Finder 1: `integrity_highlevel_find`

The high-level finder checks the aggregate observation hierarchy:

```text
day manifests
    -> month manifests
        -> year manifests
            -> observations-root manifest
```

It runs across all available observation history during every scheduled daily Integrity run.

It is lightweight. It reads manifest objects and R2 or Dropbox metadata required to validate hierarchy identity. It does not read observation Parquet bodies.

It detects the issue classes defined in [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md), including missing, extra, malformed and hash-mismatched aggregate relationships.

Its findings enter the high-level queue class:

```text
queue_YMD
```

The location key identifies the affected hierarchy level and the relevant year, month or day. Root-level findings use an explicit root level rather than an invented date.

## Finder 2: `integrity_lowlevel_find`

The low-level finder deeply checks selected observation days:

```text
Parquet files
    -> pollutant manifests
        -> connector manifests
            -> day manifests
```

Its repair unit remains:

```text
day_utc + connector_id + pollutant_code
```

Its findings enter the low-level queue class:

```text
queue_DCP
```

The location key contains:

```text
day_utc
connector_id
pollutant_code
```

The low-level finder follows the source, mapping, canonical-row, content-hash, preservation and fail-closed rules in [`integrity.md`](integrity.md).

## Scheduled daily low-level selection

For the scheduled daily profile, the low-level finder checks:

1. the 14 consecutive UTC days ending on the latest committed observations day visible to the selected Integrity baseline;
2. the allocated historical day in every represented earlier calendar month;
3. any missed logical-date catch-up selections required by [`daily_profile_selection.md`](daily_profile_selection.md).

The 14-day recent window supersedes the seven-day recent window currently stated in `daily_profile_selection.md`. The historical day-number allocation, represented-month rules and catch-up behaviour remain unchanged unless separately amended.

Selected recent dates remain consecutive calendar dates even when a day directory is missing, so a missing recent day can become a finding.

## Finder execution order

After the Integrity run acquires the observations lease, the high-level and low-level finders may run concurrently.

They are both read-only and inspect the same stable baseline.

Running high-level first is permitted for a simpler initial implementation, but it must not change the low-level scope or repair anything before the low-level finder completes.

## Finder completion barrier

Each finder writes an immutable completion result for the `scan_run_id`:

```text
highlevel_find_complete
lowlevel_find_complete
```

A factory-ready signal is produced only when both required finder results exist and neither finder ended in an unhandled or uncertain state.

Builders must not start before the factory-ready signal.

There is no indefinite builder waiting period. Builders are released by the explicit completion barrier.

If one finder fails, the scan remains incomplete. No builder from that scan may begin unless a separate narrowly defined recovery contract explicitly permits processing a known complete subset.

## Queue separation

The Integrity database uses separate durable queue tables for the two repair-order shapes:

```text
queue_DCP
queue_YMD
```

Physical SQL identifiers should use unquoted lowercase names, but schema naming is finalised in the schema repository implementation phase.

The tables may share common columns and helper functions, but one polymorphic table must not blur the different location keys, dependency rules or builder ownership.

Every queue item records at least:

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

A queue row records evidence and requested work. It is not authoritative proof that the issue still exists at build time.

## Idempotency and duplicate findings

A repeated scan may rediscover an unresolved issue.

The queue layer must coalesce duplicate active repair orders for the same logical object and issue type rather than create unbounded duplicate work.

Historical findings and attempts remain auditable. Coalescing must not erase evidence from earlier scans.

## Builder precondition

Before mutation, every builder must:

1. verify that the owning Integrity run still holds the observations lease;
2. re-read or otherwise refresh the exact current object identities needed for its key;
3. determine whether the queued issue still exists;
4. complete as a verified no-op when a newer valid state has already resolved it;
5. fail closed when the current state is contradictory or outside the authorised scope.

A queue item alone is not permission to overwrite a newer valid object.

## Builder chain

Repair propagation is bottom-up:

```text
pollutant builder
    -> connector builder
        -> day builder
            -> month builder
                -> year builder
                    -> observations-root builder
```

A lower-level builder creates or activates the required parent repair order only after its own output has been written and verified.

A parent builder must not run while unresolved active child work for the same parent remains in the current factory run.

## Work coalescing

Builders gather all completed or ready child work for their parent key before rebuilding that parent.

Examples:

- several pollutant repairs for one connector-day lead to one connector-manifest rebuild;
- several connector repairs for one day lead to one day-manifest rebuild;
- several changed days in one month lead to one month-manifest rebuild;
- several changed months in one year lead to one year-manifest rebuild;
- all changed years lead to one observations-root rebuild.

Coalescing is driven by queue state and the finder completion barrier. It must not depend on an arbitrary indefinite sleep.

## Dropbox baseline and live R2 use

Finders use the run-pinned Dropbox baseline and authoritative source inputs defined by [`integrity.md`](integrity.md). They do not use live R2 as an unpinned comparison baseline.

Builders may use validated Dropbox objects to preserve unchanged child content, but changed leaf observation data must come from the authoritative historical source under the existing Integrity contracts.

Before writing a parent, the builder must use:

- verified outputs from completed child builders in the current run;
- current valid unchanged child identities;
- the canonical shared manifest builders.

Under the global observations lease, the builder must refresh the live child manifests needed to prevent overwriting a newer valid object. Dropbox must not be treated as automatic authority to replace a newer live object merely because it was the finder baseline.

## Builder ownership

Builders are separated by the object they produce. A builder must not reach upwards and publish several unverified parent levels as one opaque operation.

Each builder owns:

- loading the required child evidence;
- canonical object construction;
- put-if-changed behaviour;
- read-back verification;
- its queue transition;
- creation or activation of the immediate parent work item.

Parent propagation continues only after verification succeeds.

## Queue lifecycle

The lifecycle distinguishes at least:

```text
open
claimed
building
verified
no_op
failed_retryable
failed_blocked
```

Claiming must be atomic and must have a bounded lease or claim expiry so an abandoned worker does not own an item forever.

A queue claim is separate from the global observations run lease. The queue claim coordinates factory workers inside the one Integrity run; it does not permit another Integrity or Prune Daily run to overlap.

## Failure behaviour

A child failure blocks its dependent parent branch.

For example, if one pollutant repair fails:

- the connector builder for that connector-day must not publish a completed connector manifest from an incomplete child set;
- the day, month, year and root branch remains unadvanced for that repair;
- unrelated branches in the same run may continue when their dependencies are complete and the existing fail-closed scope rules permit it.

A parent hash must never be advanced merely to clear a queue.

## Final verification

After all reachable builder work completes, Integrity performs final verification for the affected branches.

Final verification must confirm:

- repaired leaf data and pollutant manifests match authoritative source evidence;
- connector and day manifests contain the correct complete child set;
- month, year and root content hashes agree with their committed children;
- all verified or no-op queue items have corresponding evidence;
- blocked or failed items remain visible and prevent a false overall success.

The run releases the observations lease only after final verification and final audit persistence complete or fail safely.

## Initial implementation boundary

The first implementation may introduce the finders, completion barrier and queues before every specialised builder is available.

In that state:

- finding remains non-mutating;
- unavailable builders leave repair orders open or blocked;
- no compatibility path may silently return to direct find-and-repair behaviour;
- existing explicitly selected safe repair modes remain governed by their current contracts until migrated deliberately.

## Structural validation policy

Before deployment, validate only that:

- both finders cannot mutate live R2;
- both completion records are required before builders start;
- duplicate active findings coalesce correctly;
- parent work cannot complete before required child work;
- builder revalidation can turn stale work into a verified no-op;
- queue claims expire safely;
- a failed child blocks its parent branch.

Functional acceptance occurs through real TEST scans and factory runs after deployment.
