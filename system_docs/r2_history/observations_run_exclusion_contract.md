# R2 v2 observations run exclusion

## Authority and scope

This document defines the authoritative run-level exclusion contract for processes that inspect or mutate canonical R2 v2 observations.

It applies to:

- Prune Daily;
- every current Integrity mode, including check-only, dry-run and write-enabled repair;
- current or future Integrity repair workers;
- observation structure migration;
- explicit observation repair, rebuild or maintenance commands;
- any future process that reads the observation hierarchy as a stable snapshot or mutates it.

For observations, this document supersedes the concurrent Prune Daily and Integrity model in:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`lock_environment_boundary.md`](lock_environment_boundary.md);
- the concurrent-writer summary in [`README.md`](README.md).

Prune Daily and Integrity must not run against R2 observations at the same time, even when their intended days, connectors or pollutants differ.

The finer connector-day, day-finalisation and global-index locks in older contracts must not be relied upon as the cross-run safety boundary between Prune Daily and Integrity. They may remain as temporary internal implementation safeguards until deliberately retired, and internal same-run finalisation must still prevent lost updates.

This contract does not require the draft Integrity Factory architecture. The current Integrity implementation may retain its present internal stages provided the complete covered run obeys this exclusion contract.

## One global observations lease

All covered processes use one logical lock per operational Supabase project:

```text
uk_aq:r2_history:v2:observations_run
```

TEST and LIVE remain isolated by their separate Supabase projects. Environment labels are diagnostic and must not alter logical lock identity inside one database.

The lock is a bounded renewable lease, not a permanent Boolean flag and not an indefinite wait.

The durable lease record contains at least:

```text
lock_name
owner
run_id
acquired_at
heartbeat_at
expires_at
```

`owner` identifies the process class, such as `prune_daily` or `integrity`. `run_id` identifies the exact workflow or operation invocation.

## Atomic acquisition

Lease acquisition must be atomic.

A process may acquire the lease only when:

- no lease exists; or
- the existing lease has expired and is atomically replaced.

Two processes must not both receive a successful acquisition result for the same active lease period.

Acquisition uses a bounded retry or fail-fast policy. It must never wait indefinitely.

A process that cannot acquire the lease must perform no covered observation discovery, comparison, repair planning or R2 mutation. Its report must identify the current lease owner and expiry where available without exposing credentials.

## Protected lifetime

The protected period begins before the process reads mutable observation hierarchy state that must remain consistent.

For current Integrity, the lease covers:

```text
run initialisation
selected-scope discovery and comparison
finding and repair planning
all write-enabled repair stages
parent-manifest propagation
final verification and audit persistence
```

A future split finder-and-builder implementation must remain within the same one-run lease, but that internal architecture is not required by this contract.

For Prune Daily, the lease covers its complete observation-history operation, including candidate preparation that depends on current R2 observation state, observation writes, manifest finalisation, verification, prune-gate completion and the associated safe deletion decision.

The lease is released only after the complete covered operation finishes or fails safely.

This deliberately favours simple deterministic operation over concurrent throughput.

## Heartbeat and expiry

The lease owner must renew `heartbeat_at` and `expires_at` throughout a long run.

The lease duration must be long enough to survive ordinary scheduling and network jitter but short enough that an abandoned run does not block the system indefinitely.

Renewal must prove ownership using both:

```text
lock_name + run_id
```

A process must fail closed if it loses ownership or cannot renew before expiry. It must not continue mutating observations under an uncertain lease.

An expired lease may be reclaimed atomically by a new run. Reclaiming must be recorded in audit output.

## Release

Normal success, controlled failure, cancellation and exception paths must attempt release.

Release must prove the current `run_id`. One run must not release another run's lease.

Failure to release is recoverable through expiry, but must be reported.

## Integrity internal parallelism

Read-only Integrity checking stages may run concurrently inside one Integrity invocation holding the lease, provided they inspect the same pinned stable baseline.

No write-enabled repair stage may begin until every read-only stage whose results are required for that repair has completed successfully.

This is internal parallelism inside one lease owner. It does not permit Prune Daily or another Integrity run to overlap and does not require the proposed draft finder names, queue tables or factory completion barrier.

## Writer and finaliser behaviour under the global lease

The global lease removes cross-run observation mutation races, but it does not remove the need for deterministic bottom-up writing.

A writer must still:

- write and verify changed pollutant objects before connector manifests;
- write and verify connector manifests before day manifests;
- finalise each affected day once per run;
- preserve unchanged connectors and pollutants;
- finalise month, year and observations-root manifests according to [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md);
- write parent aggregates from current committed children rather than only from the current run's changed set.

If implementation-internal parallel workers can target the same parent, the implementation must serialise that parent finalisation inside the run. That internal mechanism is not a second cross-run lease namespace.

## Read-only external consumers

Normal public and private R2 readers do not acquire this lease. They continue reading committed objects according to their existing contracts.

Integrity acquires the lease because its comparisons and any later repair decisions require a stable observations hierarchy. It is not a general read lock for website or API traffic.

## Failure behaviour

A failed writer can leave lower-level children newer than their parents. The lease prevents another writer from interleaving with that failure, but it does not make a partial write valid.

After the failed lease expires or is released:

- the explicit hierarchy audit detects aggregate hierarchy mismatches;
- current Integrity detects selected-day file and manifest mismatches under its active scope;
- repairs follow the active Integrity contracts until any future factory draft is deliberately promoted.

No process may hide a failed partial write by advancing parent hashes without validating the required children.

## Operational scheduling

Schedules should avoid expected overlap, but schedule separation is not the safety mechanism. The global observations lease is required even when Prune Daily and Integrity are normally scheduled at different times.

A skipped lock acquisition is a controlled deferred run, not permission to continue in a reduced or partially mutating mode.

## Structural validation policy

Before deployment, validate only that:

- acquisition is atomic;
- the same Supabase project and lock name produce one shared lease identity;
- renewal and release require the owning `run_id`;
- expiry can be reclaimed safely;
- a second process cannot enter the protected section while the lease is active;
- all child processes of one run use the same owning `run_id` and cannot outlive the lease.

Functional acceptance occurs through real TEST operation by demonstrating that overlapping Prune Daily and Integrity invocations cannot both enter the observations operation.
