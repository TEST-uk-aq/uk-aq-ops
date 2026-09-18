# R2 history backup inventory contract

## Authority and relationship

This contract owns the **R2-side hierarchical backup inventory** used by the R2 history Dropbox backup.

Read [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md) first for shared scope, source/destination authority, direct-replacement rules and restore boundaries.

The observation-history index-v3 amendment in [`r2_history_index_v3_backup_amendment.md`](r2_history_index_v3_backup_amendment.md) is the narrower authority for selecting the compact `observations_timeseries_latest.json` source across v2/v3 index cut-over. The backup inventory/checkpoint format itself remains the existing logical-v2 backup generation unless a separate migration changes it.

The packed `timeseries_binding` contract in [`r2_history_timeseries_binding_pack_backup_contract.md`](r2_history_timeseries_binding_pack_backup_contract.md) is the narrower authority for packed-binding inventory evidence. Phase 1 through Phase 5 are accepted on TEST, and the scheduled/default TEST binding mode is now `pack`. The existing individual inventory identity remains valid for explicit/manual rollback use and MUST retain its existing meaning.

Implementation owner:

```text
scripts/backup_r2/build_backup_inventory.mjs
```

## Inventory layout

The active inventory root is:

```text
history/_index_v2/backup_inventory_v2/root.json
```

Observation inventory shards are complete month snapshots:

```text
history/_index_v2/backup_inventory_v2/observations/year=YYYY/month=MM.json
```

The existing individual timeseries-binding inventory uses fixed ranges of 1,000 IDs:

```text
history/_index_v2/backup_inventory_v2/timeseries_binding/root.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=000000-000999.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json
...
```

Those shards are derived from the authoritative binding source hierarchy:

```text
history/_index_v2/timeseries_binding/_manifests/root.json
history/_index_v2/timeseries_binding/_manifests/range=000000-000999.json
...
```

Range boundaries MUST remain stable unless a separately documented migration changes them.

Packed binding evidence is additive and is now the normal scheduled/default TEST transport identity. It uses the distinct `timeseries_binding_packs` inventory identity/reference defined by the packed-binding contract and authenticates the current pack generation under:

```text
history/_backup_packs_v1/timeseries_binding/root.json
```

The additive pack reference MUST NOT rename, overwrite or reinterpret the existing individual `timeseries_binding` inventory identity. In `pack` mode the sync consumes the pack reference as the current binding transport input; in explicit `individual` mode the existing individual range inventory retains its existing meaning.

Observation run manifests use one small stable global inventory unit, for example:

```text
history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json
```

The authority-selected compact latest-timeseries summary is one required global inventory unit. Its identity MUST include at least:

- relative source path;
- source SHA-256;
- source byte size.

Core MUST remain compact. It MAY be represented in the root or one stable dedicated core shard. It MUST NOT use timeseries-ID range sharding.

A change to a global or core unit MUST NOT cause unchanged observation-month or binding-range inventory shards to be rewritten.

## Inventory root contents

The root MUST record enough stable source identity to route and validate the complete current inventory, including at least:

- inventory schema version;
- backup version;
- observations source-root content hash;
- observation year identities;
- observation month identities and shard paths;
- authoritative binding source-manifest root identity;
- existing individual binding backup-inventory root identity and range references when that representation is in scope;
- packed-binding root/reference identity when `pack` or `dual` is selected;
- observation run-manifest inventory identity;
- authority-selected compact latest-timeseries source path, SHA-256 and byte size, directly or through a referenced global shard;
- current core backup identity and any dedicated core shard path;
- other stable source-derived generation evidence required by the implementation.

A wall-clock-only field MUST NOT change the bytes of an otherwise unchanged root or shard.

Removal of obsolete compatibility fields or changing the authority-selected compact latest-timeseries generation does not by itself require a backup inventory/state schema-version bump. A version bump is required only for an actually incompatible runtime representation that needs explicit version discrimination.

The packed-binding identity does not require the existing individual inventory identity to change meaning. The two representations MUST remain separately distinguishable even though `pack` is now the scheduled/default TEST authority.

## Observation traversal

Observation inventory traversal MUST follow the authoritative manifest hierarchy:

```text
observations root
    -> changed year
        -> changed month
            -> changed day manifests
```

If the observations-root source identity is unchanged, no observation year/month/day traversal is required.

If the root changed:

- unchanged years are skipped;
- within changed years, unchanged months are skipped;
- each changed month rebuilds a **complete current monthly inventory shard**, not a delta-only shard.

R2 metadata MAY be used as a fast first comparison. An object is read/hashed when metadata or parent identity indicates that it may have changed, or during explicit full-scan verification.

## Timeseries-binding traversal

Normal hierarchical source discovery MUST use the authoritative binding source hierarchy rather than complete physical-prefix listing.

Physical binding objects remain:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

For the existing individual inventory, retained for explicit/manual rollback use, normal behaviour remains:

```text
source root unchanged
    -> reuse previous complete binding backup inventory root/ranges
    -> do not list all physical bindings
    -> do not open range manifests

source root changed
    -> compare source range hashes
        -> unchanged range: reuse existing backup range shard
        -> changed/new range: read authoritative source range manifest and rebuild only that backup range shard
```

A normal hierarchical run MUST perform zero complete physical binding-prefix listings when the source hierarchy is valid.

A changed source range manifest already supplies the complete current physical binding identities for that fixed range; the inventory builder MAY reuse those stable identities without rereading every binding JSON object.

If the binding source root or a referenced range manifest is missing, malformed or contradictory, normal hierarchical mode MUST fail clearly. It MUST NOT silently fall back to a complete physical listing.

Recovery from a damaged binding source hierarchy is an explicit source-hierarchy bootstrap/rebuild or full-scan verification operation owned by the R2-history binding contracts.

## Packed timeseries-binding inventory

Pack creation is a backup derivative publication step owned by the packed-binding contract. The inventory builder consumes the verified current pack root/reference; it MUST NOT independently invent pack membership or treat the pack namespace as a second source authority.

In `pack` mode, now the scheduled/default TEST mode:

```text
binding source root + verified pack root unchanged
    -> reuse the existing pack inventory identity
    -> do not open individual binding member files merely to rebuild pack inventory

binding source root changed
    -> require a verified pack root representing that same current source root
    -> expose the new pack root/range identities
```

The pack inventory reference MUST authenticate at least:

- pack format/generation;
- current pack-root relative path;
- pack-root SHA-256 and byte size;
- authoritative binding source-root hash represented;
- every occupied range's source-range hash;
- current pack relative path, SHA-256, byte size and member count for each occupied range.

If `pack` mode is selected and the verified current pack root is missing, stale, malformed or represents another binding source root, inventory generation MUST fail closed. It MUST NOT silently fall back to individual transport.

Temporary `dual` mode may expose both individual and packed identities, but their meaning and completion evidence remain separate. Manual `individual` remains available for bounded rollback; neither mode may reinterpret the other's identity.

## Compact latest-timeseries traversal

The builder MUST inspect the compact latest-timeseries object selected by persistent observation-history index authority under the v3 backup amendment.

Its inventory identity is the exact relative source path plus SHA-256 and byte size.

When unchanged, the prior inventory identity is reused and unrelated shards remain byte-stable. When it changes, only its compact inventory representation and necessary parent identity change.

If the selected object is missing, malformed or unreadable, inventory generation MUST fail clearly. The backup builder MUST NOT rebuild index objects as a side effect and MUST NOT fall back to another index generation.

The bulk derived trees are not inventory payload:

```text
history/_index_v2/observations_timeseries/
history/_index_v3/observations_timeseries/
```

## Core traversal

Core remains in backup scope but is not large enough to require binding-style range partitioning.

The inventory MUST retain stable source identities sufficient to distinguish unchanged, changed and missing core units. Previous verified hashes MAY be reused when current R2 metadata proves a unit unchanged.

A core change MUST affect only the compact core representation and necessary parent identity. It MUST NOT rewrite observation-month or binding-range inventory shards.

## Independent full-scan mode

Hierarchical traversal is an optimisation, not the only verification method.

The inventory builder MUST retain an explicit full-scan mode that independently:

- enumerates every committed observation day manifest;
- rebuilds or compares every observation month shard;
- enumerates every physical timeseries-binding object;
- reads and hashes every current physical binding object;
- independently rebuilds expected binding source range/root identities and compares them with the authoritative binding hierarchy;
- reads and hashes the authority-selected compact latest-timeseries object;
- enumerates and verifies current in-scope core objects;
- validates the resulting backup inventory roots.

Normal hierarchical mode MUST fail rather than silently trust malformed or contradictory parent/source manifests.

When pack mode is involved, full-scan verification of the physical binding source hierarchy still validates the underlying source authority. Pack-format closed-set verification remains separately governed by the packed-binding contract.

## Inventory audit evidence

The backup report MUST expose enough inventory evidence to explain optimisation and completeness. Relevant fields include:

- inventory mode (`hierarchical` or `full scan`);
- selected binding backup representation where applicable;
- observations source-root hash;
- observation years/months inspected and skipped by matching hash;
- authoritative binding source-manifest root key/hash;
- whether complete physical binding listing was skipped;
- individual binding ranges inspected/skipped and backup range shards written when individual inventory is in scope;
- packed binding source-root and pack-root identity plus range references when pack inventory is in scope;
- compact latest-timeseries source path, SHA-256 and byte size;
- core units listed/skipped and core source identity where used.

Legacy-adoption reporting MUST NOT be reintroduced.

## TEST pack-mode evidence

The packed inventory path has been exercised on TEST through both the isolated Phase 2 destination and the normal TEST Dropbox backup. On 04/09/2026 the normal GitHub-hosted backup was manually dispatched with explicit `pack` mode and reused the complete current pack generation without rebuilding any of its 143 ranges or reopening/copying the 6,265 individual binding payload files.

The resulting normal Dropbox checkpoint/live-root and ordinary backup freshness gates then passed during the accepted Phase 3 Integrity run.

Phase 4 subsequently proved that the authenticated pack/inventory identities are sufficient to recover the complete physical binding set and authoritative source hierarchy. A real dry-run verified all 143 pack ranges and all 6,265 members and reconstructed the authoritative source-root hash with zero writes. The real isolated TEST restore then wrote and readback-verified all 6,265 individual binding objects, rebuilt and readback-verified all 143 source range manifests, reproduced the same source-root hash and published the source root last.

The runtime-consumer audit confirmed that this transport change does not alter request-time consumers: they continue to read individual R2 binding objects and do not read the pack namespace.

Phase 5 was operationally accepted through GitHub Actions run `33923153503`. The scheduler/external dispatch supplied no binding-mode override, so the workflow selected `pack` by default. The normal full backup reused all 143 current packs, rebuilt and copied 0 unchanged packs, preserved complete observations/core/run-manifest/latest-timeseries coverage and completed successfully. This establishes packed inventory as the scheduled/default TEST binding transport input while preserving the individual inventory identity for explicit rollback.

## Structural validation

Before deployment, use only the smallest deterministic checks needed to establish structural viability of inventory changes.

The changed implementation MUST preserve at least these properties where relevant:

- unchanged source hierarchy produces unchanged inventory root/shards;
- a one-day observation change affects only its month shard and necessary ancestors;
- unchanged binding source-root hash causes zero complete physical binding-prefix listings in normal mode;
- a binding change affects only its fixed source range, matching backup range and necessary ancestors;
- unchanged binding ranges are not opened/rewritten because another range changed;
- malformed binding source hierarchy fails normal mode instead of triggering implicit full listing;
- explicit binding full-scan remains able to enumerate/hash physical bindings independently;
- pack mode requires a verified pack generation matching the authoritative binding source root;
- unchanged pack/source identity reuses pack inventory without member binding GETs;
- pack inventory evidence remains separate from the existing individual binding inventory identity;
- pack mode does not silently fall back to individual transport;
- a compact latest-timeseries change affects only its compact representation and necessary parent identity;
- bulk observation-timeseries index trees are never inventoried by this backup;
- a core change does not force observation-month or binding-range rewrites;
- no flat inventory adoption/compatibility/fallback path is active.

Functional acceptance occurs through real TEST inventory/backup operation after deployment. Broad pre-deployment test suites are not required.