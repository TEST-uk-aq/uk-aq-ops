# R2 history Dropbox backup amendment for observation-history index v3

## Authority and scope

This document is the authoritative narrow amendment for how the existing logical-v2 R2-history Dropbox backup selects the compact observation-timeseries summary across the observation-history index-v3 cut-over.

It amends only the generation selection for that compact summary. It does not turn derived observation-timeseries index trees into normal Dropbox backup payload.

For SOS-light repair authority, planning and apply semantics, [`../r2_history/sos_light_three_phase_authority_contract.md`](../r2_history/sos_light_three_phase_authority_contract.md) is narrower and load-bearing.

## Logical backup identity remains v2

The canonical logical observation history remains:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

The existing hierarchical backup inventory/checkpoint design remains the logical-v2 backup format:

```text
R2 source inventory:
  history/_index_v2/backup_inventory_v2/root.json

Dropbox destination state:
  _ops/checkpoints/r2_history_backup_state_v2/root.json
```

Those path names identify backup-format generation. They are not the observation-timeseries index selector.

## Compact observation-timeseries summary selection

The one compact observation-timeseries summary copied by the normal Dropbox backup follows persistent index authority:

```text
UK_AQ_R2_HISTORY_INDEX_VERSION=v2
    -> history/_index_v2/observations_timeseries_latest.json

UK_AQ_R2_HISTORY_INDEX_VERSION=v3
    -> history/_index_v3/observations_timeseries_latest.json
```

No other selector value is valid. Missing, malformed or unsupported authority fails closed.

Changing the selected generation is an intentional source-unit identity change. Prior v2 compact-summary checkpoint evidence cannot satisfy v3 compact-summary completion.

## Derived v3 index trees are not normal backup payload

Under v3 authority, the normal Dropbox backup does **not** additionally copy the scoped/exact observation-timeseries index tree merely to support SOS-light.

Normal backup does not require:

```text
history/_index_v3/observations_timeseries/day_utc=.../connector_id=.../pollutant_code=.../manifest.json
history/_index_v3/observations_timeseries/.../timeseries_id=....json
```

as a complete retained dependency set.

It MUST NOT recursively inventory, copy or revalidate the complete derived v3 index tree as part of each normal backup.

The v3 compact latest object remains useful operational/recovery evidence, but SOS-light does not depend on backed-up copies of every derived child index object.

## Rebuildability rule

Observation-timeseries indexes are derived data.

The canonical persisted data in the accepted Dropbox history baseline, together with any current repair overlay, must be sufficient for SOS-light to regenerate every required v2 or v3 observation-timeseries index.

A missing derived index object is therefore not a reason to enlarge normal backup scope.

If a repair implementation cannot deterministically rebuild an index from canonical backed-up inputs plus its repair overlay, that is an implementation defect in the repair/index builder path.

## Unrelated domains remain unchanged

Changing `UK_AQ_R2_HISTORY_INDEX_VERSION` between v2 and v3 MUST NOT redirect or rename backup coverage for:

```text
canonical observations
observation run manifests
timeseries binding
core
backup inventory
Dropbox checkpoint state
```

In particular, code MUST NOT mechanically replace `_index_v2` with `_index_v3` across unrelated backup paths.

The packed-binding transport remains separately governed by its own contract.

## Inventory requirements

The inventory builder must:

1. read the selected index generation explicitly;
2. resolve exactly the matching compact latest key;
3. record the compact source identity, including path, SHA-256 and byte size;
4. fail closed if that selected compact object is missing or unreadable;
5. never fall back automatically to the other generation.

The inventory builder MUST NOT enumerate every v3 scoped root merely because the selected compact object refers to them.

## Dropbox state and completeness

Dropbox state for the compact latest unit must record its exact selected source path, SHA-256, byte size and successful copy/read-back verification.

For v3, successful processing of that one selected compact latest object is the observation-timeseries index requirement of the normal backup.

No additional scoped-root checkpoint domain is required by this contract.

Existing v2 backup/checkpoint semantics remain unchanged.

## SOS-light boundary

The normal backup is not responsible for manufacturing special dependency evidence for fixed-v3 SOS-light.

SOS-light uses:

```text
accepted complete Dropbox canonical baseline
+ current-run repair source
-> local overlay
-> deterministic rebuild of affected v3 indexes
```

It does not require the backup to preserve the complete old v3 derived-index generation.

The authoritative SOS-light details are in [`../r2_history/sos_light_three_phase_authority_contract.md`](../r2_history/sos_light_three_phase_authority_contract.md).

## Migration and rollback

The generation-selected compact summary remains part of backup evidence across v2/v3 migration and rollback.

A formal rollback to v2 selects the v2 compact summary only after persistent index authority has been deliberately restored to v2 under the migration/operator contracts.

There is no automatic v3-to-v2 fallback merely because the v3 compact summary is absent.

This contract does not redefine the broader v3 migration rollback data authority. Canonical history and the dedicated migration/rollback contracts remain authoritative for that scope.

## Fail-closed requirements

Backup/inventory fails rather than silently continuing when:

- `UK_AQ_R2_HISTORY_INDEX_VERSION` is missing or unsupported;
- the selected compact summary is missing or unreadable;
- inventory/state claims one generation while the selected compact path belongs to the other;
- the selected compact summary cannot be copied and verified;
- current-complete state would otherwise be published without successful processing of the selected compact summary.

It does **not** fail merely because the normal backup does not contain the full derived v3 scoped/exact index tree.

## Implementation ownership

This amendment applies to:

- `scripts/backup_r2/build_backup_inventory.mjs`;
- `scripts/backup_r2/sync_history_to_dropbox.mjs` where compact-summary identity is validated;
- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`;
- generation-aware currentness helpers that select the compact summary.

As of 18/09/2026, the PR #69 scoped-root backup expansion has been reverted. The resulting pre-PR-69 normal backup scope is consistent with this contract.

## Validation

Before deployment, targeted structural validation should prove only that:

- v2 selects exactly the v2 compact latest object;
- v3 selects exactly the v3 compact latest object;
- invalid authority fails closed;
- v3 selection does not redirect unrelated v2 logical-history backup domains;
- prior v2 compact state cannot satisfy a v3 selected compact unit;
- missing v3 compact latest cannot fall back to v2;
- the normal backup does not recursively inventory/copy the derived v3 observation-timeseries tree.

Functional acceptance remains a normal real TEST backup operation.
