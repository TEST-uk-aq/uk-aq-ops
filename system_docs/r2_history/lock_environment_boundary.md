# R2 history advisory-lock environment boundary

## Authority and scope

This document is an authoritative amendment to [`history_writer_coordination.md`](history_writer_coordination.md).

It governs:

- TEST-versus-LIVE isolation for PostgreSQL advisory locks;
- advisory-lock key inputs;
- the database-session requirement for holding locks.

Where the existing coordination document says that an environment identity must be included in a lock key, this amendment supersedes that wording.

## Supabase projects provide environment isolation

TEST and LIVE use separate Supabase projects. They therefore use separate PostgreSQL database instances and separate PostgreSQL advisory-lock managers.

An advisory lock acquired in the TEST Supabase project cannot collide with, block or release an advisory lock in the LIVE Supabase project.

The Supabase project/database connection is therefore the environment boundary.

## Environment labels are not lock-key input

The deployment environment name MUST NOT be included in advisory-lock key derivation.

Labels such as:

```text
TEST
LIVE
CIC-Test
```

MUST NOT change the logical identity of a protected R2 resource.

This is required because two writers connected to the same Supabase project could otherwise use different environment labels and derive different locks for the same R2 object.

Environment or project labels MAY be included in logs and diagnostics for operator clarity. They MUST NOT be used as advisory-lock key input.

If TEST and LIVE are ever moved into the same PostgreSQL database instance, this contract must be reviewed before that architecture change.

## Canonical application namespace

All R2 history writers connected to the same Supabase project MUST use one fixed, versioned application namespace and one canonical deterministic key derivation helper.

Conceptual logical identities are:

```text
uk_aq:r2_history:v1:connector_day:<day_utc>:<connector_id>
uk_aq:r2_history:v1:day_finalisation:<day_utc>
uk_aq:r2_history:v1:global_index_finalisation
```

The implementation may deterministically convert these logical identities into PostgreSQL advisory-lock integer keys.

The following MUST NOT affect the key:

- environment label;
- workflow name;
- process or run ID;
- host name;
- current timestamp.

Prune Daily, Integrity, migration and maintenance writers MUST NOT independently invent competing namespaces or key algorithms.

## Stable database session requirement

A session-level PostgreSQL advisory lock exists only for the database session that acquired it.

The connection holding the lock MUST remain open for the complete protected section.

The writer must use a database route that preserves one PostgreSQL session for the lock lifetime, such as:

- a direct PostgreSQL connection; or
- the configured Supabase session-mode connection route.

A series of unrelated PostgREST or RPC requests MUST NOT be treated as one held session-level advisory lock.

Transaction-pool behaviour MUST NOT be used across a protected section unless acquisition, the protected operation and release genuinely remain on the same retained PostgreSQL session.

Connection loss releases the lock automatically. Normal success, error and cancellation paths must also attempt explicit release in a `finally` path.

## Supabase usage

The locks:

- create no application table rows;
- require no persistent lock table;
- consume no material database storage;
- use a temporarily dedicated PostgreSQL connection while held;
- should be held only around the exact connector-day, day-finalisation or global-index protected section.

The operational constraint is available database connections and correct session handling, not per-lock storage.

## Required focused structural checks

Before deployment, the smallest directly relevant deterministic checks must prove:

- identical namespace and resource identity derive the same key regardless of environment-label spelling;
- different lock namespaces do not collide in the focused fixture;
- connector-day identity includes both `day_utc` and `connector_id`;
- day-finalisation identity includes `day_utc` and no connector;
- the global-index identity is one fixed database-local application lock;
- acquisition is bounded;
- release occurs on success, error and cancellation.

The check MUST NOT attempt to prove TEST-versus-LIVE isolation by adding environment labels to the key. TEST and LIVE isolation is provided by the separate Supabase projects.

Do not add a broad speculative pre-deployment test suite. Functional validation remains through real TEST operation after deployment.
