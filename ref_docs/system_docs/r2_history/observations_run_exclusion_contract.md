# R2 v2 observations global operation exclusion

## Authority and scope

This document defines the authoritative cross-run coordination contract for canonical R2 v2 observations.

It applies to:

- Prune Daily observation-history operation;
- every current Integrity mode, including check-only, dry-run and write-enabled repair;
- SOS-light;
- supported Integrity-backed historical repair/backfill;
- the normal R2-to-Dropbox history backup while it inventories, copies or checkpoints canonical observations;
- observation structure migration and explicit observation maintenance commands;
- future Integrity Factory runs.

For observations, this document supersedes conflicting concurrent-writer and fine-grained cross-run exclusion wording in:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`lock_environment_boundary.md`](lock_environment_boundary.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- the observation-locking summaries in [`README.md`](README.md).

The governing invariant is deliberately simple:

```text
Prune Daily
OR
Integrity
OR
R2 -> Dropbox history backup

never more than one covered observation operation at the same time
```

Observation migration or explicit observation maintenance also owns this same lock while active.

This deliberately favours deterministic operation over observation-operation concurrency.

The contract applies to canonical observations and dependent observation manifests/indexes. It does not redesign AQI-history locking, core-history locking or ordinary public/private history reads.

## One global observations operation lock

All covered processes use one database-local exclusive PostgreSQL advisory lock.

The canonical logical identity is:

```text
uk_aq:r2_history:v2:observations_global_operation
```

One shared helper MUST own the advisory-lock key derivation, bounded acquisition, diagnostics and release behaviour.

TEST and LIVE use separate Supabase projects and therefore separate PostgreSQL advisory-lock managers. The Supabase project/database is the environment boundary. Environment labels such as `TEST`, `LIVE` or `CIC-Test` MAY appear in diagnostics but MUST NOT alter the lock identity inside one database.

The lock is a session-level PostgreSQL advisory lock. It creates no application lock table, no durable lease row and no heartbeat/expiry schema.

A process that cannot acquire the lock within the configured bounded acquisition period MUST fail or defer cleanly. It MUST NOT continue with a reduced, partially mutating, partially backed-up or stale-baseline observation-history mode.

## Stable database session and ownership

The PostgreSQL session that acquired the advisory lock MUST remain open for the complete protected lifetime.

The implementation MUST use a connection route that preserves one PostgreSQL session for that lifetime.

Connection loss releases a PostgreSQL session advisory lock automatically. A process MUST therefore fail closed if the dedicated lock connection is lost or its ownership becomes uncertain. It MUST NOT continue observation comparison, mutation, backup inventory/copy or checkpoint publication while merely assuming that the lock still exists.

A lightweight same-session health/ownership check MAY be used during long runs. A durable heartbeat table is not required.

Normal success, controlled failure, cancellation and exception paths MUST attempt explicit release in a `finally` path.

## Prune Daily protected lifetime

Prune Daily MUST acquire the global observations operation lock before entering the observation-history portion of the run that can depend on or change canonical R2 observation state.

The lock covers at least:

```text
observation-history candidate processing that depends on current R2 state
canonical observation writes
observation manifest/index publication
observation verification
connector-day prune-gate completion
associated safe IngestDB observation deletion decision
```

Prune Daily MAY perform unrelated non-observation preparation before acquiring the lock when that preparation neither reads mutable canonical observation state nor authorises later observation mutation from stale state.

The lock is released only after the complete covered Prune Daily observation operation finishes or fails safely.

Prune Daily does not use Dropbox as source, comparison baseline or deletion authority.

## Dropbox history backup protected lifetime

The normal R2-to-Dropbox history backup is a participant in the same global observations operation lock because it creates the Dropbox observation baseline later used by Integrity and SOS-light.

The backup MUST acquire the global observations operation lock before it establishes the R2 observation source generation to inventory or copy.

For the observation domain, the protected sequence is:

```text
acquire global observations operation lock
    -> establish and validate current R2 observations-root identity
    -> build or refresh the hierarchical observation backup inventory for that fixed source generation
    -> copy required changed observation objects to Dropbox
    -> verify copied observation objects and checkpoint/state shards
    -> publish the Dropbox checkpoint as fully processed for that exact observations-root identity
    -> release global observations operation lock
```

While the backup owns the lock, Prune Daily, Integrity, SOS-light, migration and other covered observation operations cannot alter the canonical observation hierarchy beneath the backup.

The backup MUST NOT publish a fully processed observations-root checkpoint for a source generation that was not held stable for the protected observation backup operation.

If the existing backup workflow also processes non-observation domains such as core or timeseries binding, it MAY retain the global observations operation lock for the complete workflow when that is structurally simpler. The minimum requirement is that the lock covers observation source-generation selection through successful observation checkpoint publication.

A backup that cannot acquire or retain the lock MUST fail or defer its observation backup cleanly. It MUST NOT silently fall back to the previous unlocked observation-copy behaviour.

## Integrity protected lifetime

Integrity MUST acquire the global observations operation lock before it establishes that its Dropbox observation baseline is current.

The required order is:

```text
acquire global observations operation lock
    -> complete the request-level IngestDB boundary precondition
       if it was not already completed before lock acquisition
    -> verify the selected Dropbox backup/checkpoint is complete and valid
    -> establish current live R2 observations-root content identity
    -> require the Dropbox checkpoint's fully processed observations-root identity
       to equal the current live R2 observations-root identity
    -> pin the accepted backup/checkpoint/root identities
    -> perform the complete Integrity run
    -> final verification and audit persistence
    -> release global observations operation lock
```

The request-level IngestDB boundary remains a separate semantic ownership rule and MUST still pass for every requested connector. The global operation lock does not make an IngestDB-overlapping Integrity request valid.

For a Dropbox currentness gate, the normal proof uses the authoritative observation hierarchy and the hierarchical backup checkpoint contract:

```text
live R2 observations-root content_hash
    ==
Dropbox checkpoint fully processed observations-root content hash
```

The selected backup/checkpoint must also be complete for the current source generation under [`../backup_and_recovery/r2_history_dropbox_backup_contract.md`](../backup_and_recovery/r2_history_dropbox_backup_contract.md).

If completeness, structural validity or current root identity cannot be established, Integrity MUST release the lock and stop before normal comparison/repair work proceeds.

This ordering is required because checking Dropbox before acquiring the lock would leave a race in which Prune Daily could change R2 immediately after the check.

Because the Dropbox backup itself uses the same global operation lock, an accepted Dropbox baseline also remains unchanged by the normal backup process for the complete Integrity run.

## Why Dropbox currentness is a start gate

Integrity deliberately reasons from a pinned Dropbox baseline. SOS-light additionally uses Dropbox to preserve non-connector-1 content while rebuilding a complete selected day.

Therefore a write-enabled or comparison Integrity run MUST NOT begin from a Dropbox observation generation known to be older than the current committed live R2 observation generation.

A successful write-enabled Integrity run is allowed to make live R2 newer than Dropbox. An immediate post-Integrity Dropbox backup is NOT a locking requirement.

A later Integrity invocation simply remains ineligible until a subsequent complete Dropbox backup acquires the global lock, processes the newer stable observation generation and records the same fully processed observations-root content identity as current live R2.

Prune Daily may continue to run during that period because it does not depend on Dropbox. It remains mutually exclusive with each individual backup run through the same global lock.

## Current SOS-light behaviour

SOS-light retains its current complete-day replacement model for now.

Under this contract its safety boundary is:

```text
acquire global observations operation lock
    -> prove Dropbox checkpoint current with live R2
    -> pin that baseline
    -> assemble complete replacement day from SOS source + pinned Dropbox
    -> delete/rebuild/verify selected day(s)
    -> final verification
    -> release global observations operation lock
```

Because Prune Daily cannot enter while SOS-light owns the global lock, no newer Prune observation write can interleave with the complete-day replacement.

Because the normal Dropbox backup also cannot enter while SOS-light owns the lock, the pinned Dropbox baseline cannot be rewritten underneath the running SOS-light operation.

Because the accepted Dropbox checkpoint must represent the same committed observation-root generation as live R2 when the run starts, SOS-light MUST NOT intentionally rebuild a day from an older committed observation generation.

The future Integrity Factory may replace SOS-light with a narrower DCP repair model under a later deliberate contract change. That future design is not required for the observation-history index v3 cut-over.

## Integrity internal parallelism

The global observations operation lock is an external run-level exclusion boundary. It does not require Integrity to be internally single-threaded.

One Integrity invocation that owns the lock MAY perform read-only checking, source acquisition, DCP construction or other independent internal work concurrently when its own orchestration guarantees deterministic dependencies and finalisation.

Future Integrity Factory workers may therefore build different day/connector/pollutant units concurrently inside one owning Integrity run.

Internal queue claims, worker ownership records or dependency barriers are not additional cross-run R2 locks. They coordinate work inside the one process/function that already owns the global observations operation lock.

If multiple internal workers can publish to the same parent, Integrity MUST serialise or coalesce that parent publication inside the owning run so that deterministic child-before-parent semantics are preserved.

## Deterministic writer/finaliser behaviour under one global lock

The global operation lock removes the need for connector-day, day-finalisation and global-index advisory locks as cross-run observation safety mechanisms.

A canonical observation writer MUST still preserve deterministic publication order and verification, including where applicable:

```text
Parquet
-> pollutant manifest
-> connector manifest
-> day manifest
-> month manifest
-> year manifest
-> observations-root manifest
-> dependent observation exact/scoped/latest indexes in their contracted order
```

Removing a redundant advisory lock does not remove any manifest, checksum, content-hash, read-back, prune-gate, dependency-order or final-verification requirement.

Existing connector-day, day-finalisation and global-index advisory locks MAY remain temporarily in implementation during migration to this simpler model. Once the global observations operation lock is implemented and accepted on TEST, observation-only uses of the finer locks SHOULD be retired rather than maintained as a second cross-run locking architecture.

Any fine-grained lock still required for AQI or another separate domain must be justified by that domain's own contract before removal.

## Read-only external consumers

Normal public/private website and API history readers do not acquire the global observations operation lock.

They continue reading committed R2 objects according to their existing child-before-parent, strong-identity and fail-closed contracts.

The global operation lock is not a conventional database read/write lock and does not make R2 publication transactional for readers.

The Dropbox history backup is intentionally different from ordinary readers because it publishes the persistent Dropbox baseline/checkpoint that Integrity later treats as a stable comparison and preservation generation.

## Migration and maintenance

The offline observation-history index v3 hard cut-over retains its explicit maintenance state and explicit writer freeze.

Once the global observations operation lock is implemented, the migration SHOULD also acquire the same global lock before its final pre-state/backup-currentness gate and retain it for the complete canonical observation migration operation.

The required pre-migration Dropbox backup must complete and release the lock before migration acquires it. Migration then revalidates that the pinned Dropbox checkpoint still matches the current live R2 observations root before destructive rewrite begins.

The lock is defence against accidental manual or unexpected writer entry. It does not replace the explicit scheduler/workflow pause required by the migration contract.

## Failure behaviour

A failed writer can leave a newer child below an older parent. The global lock prevents a second covered process from interleaving with that failure, but it does not make partial publication valid.

A failed backup can leave Dropbox partially updated. It MUST NOT advance the fully processed observations-root checkpoint until the required observation generation has been copied and verified completely.

The failing operation MUST stop advancing dependent authority when required verification has failed.

After release, the normal hierarchy/Integrity/backup mechanisms detect and recover incomplete derived or backup state according to their contracts.

No process may hide a failed partial write or partial backup by advancing parent/checkpoint hashes without validating the required children.

## Operational scheduling

Schedules SHOULD avoid routine contention, but schedule separation is not the safety mechanism.

Prune Daily, Integrity and the Dropbox history backup all acquire the same global observations operation lock even when their normal schedules are well separated.

A skipped or failed lock acquisition is a controlled deferred/failed operation. It is not permission to continue in a reduced mode.

## Minimal structural validation

Before deployment, validate only the directly load-bearing lock behaviour:

- Prune Daily, Integrity and the Dropbox history backup derive the same advisory-lock identity in the same Supabase project;
- a second covered operation cannot enter while the first owns the lock;
- environment-label spelling does not change the database-local lock identity;
- acquisition is bounded;
- lock-session loss causes the owning operation to fail closed;
- release is attempted on success, failure and cancellation;
- Integrity performs the Dropbox/live root equality gate only after acquiring the lock;
- a Dropbox/root mismatch prevents normal Integrity comparison/repair work;
- the Dropbox backup does not publish a fully processed observations-root checkpoint without owning the stable source generation;
- normal website/API readers do not acquire the lock.

Do not add a broad speculative pre-deployment test suite. Functional acceptance occurs through real TEST operation by deliberately attempting overlapping covered operations and confirming that only one can enter the protected observation operation at a time.