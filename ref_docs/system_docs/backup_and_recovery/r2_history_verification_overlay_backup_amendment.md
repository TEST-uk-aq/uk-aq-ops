# R2 history verification-overlay Dropbox backup amendment

## Status and authority

**Status: future implementation authority; not current backup runtime until the observation verification overlay is deployed and accepted on TEST.**

This amendment defines Dropbox backup, checkpoint and restore requirements for the authoritative verification overlay in [`../r2_history/observation_verification_overlay_contract.md`](../r2_history/observation_verification_overlay_contract.md).

It amends:

- [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md);
- [`r2_history_backup_inventory_contract.md`](r2_history_backup_inventory_contract.md);
- [`r2_history_dropbox_sync_contract.md`](r2_history_dropbox_sync_contract.md);

only for the new verification domain.

## Mandatory backup scope

Once verification-overlay authority is enabled, the normal R2 history Dropbox backup MUST include all authoritative verification connector manifests under:

```text
history/v3/verification/
```

and the compact verification discovery authority:

```text
history/_index_v3/verification/latest.json
```

These objects are mandatory backup payload.

Unlike the rebuildable bulk observation-timeseries exact index, connector verification manifests are canonical verification authority and MUST NOT be excluded as derived index data merely because they are JSON or live next to an index namespace.

The verification latest object is small and is also mandatory.

## Separate root identity

Verification backup state MUST have its own authenticated source-root identity.

It MUST NOT be folded into or substituted for the existing observation measurement root hash.

The backup report/checkpoint model must expose a separate identity equivalent to:

```text
verification.processed_source_root_hash
```

while preserving:

```text
observations.processed_source_root_hash
```

as measurement-history identity.

Therefore a status-only P/R update can advance the verification backup generation while leaving the observations root unchanged.

## Inventory and checkpoint

The hierarchical inventory remains the one active backup implementation.

The inventory must enumerate verification connector manifests and verification latest using deterministic source identities including key, byte size and SHA-256.

Dropbox hierarchical checkpoint state must record successful copied/verified verification units and the completed verification source-root identity.

A verification unit is complete only when the exact source identity has been copied and verified at the Dropbox destination.

The existing backup-format generation paths remain unchanged. Adding a verification domain does not rename `backup_inventory_v2` or the Dropbox checkpoint generation.

## Copy planning

Verification JSON is expected to be small. No Parquet-reuse optimisation is required for this domain.

Unchanged verification objects MAY be skipped when exact authenticated source/destination identity proves they already match.

A changed verification connector manifest MUST be copied even when no observation Parquet changed.

The verification latest object MUST be published to Dropbox only after every connector manifest identity it references is present and verified in the destination generation.

## Dropbox layout

The Dropbox payload mirrors the R2 canonical verification paths beneath the normal history backup root:

```text
history/v3/verification/connector_id=<id>/manifest.json
history/_index_v3/verification/latest.json
```

No separate ad-hoc verification backup directory is introduced.

## Pruning

Destination pruning for verification authority must be manifest/latest guided and fail closed.

A connector verification manifest may be removed from current backup authority only when the current authenticated R2 verification latest authority no longer references it and the normal backup retention/recovery rules permit deletion.

A transport/read failure MUST NOT be interpreted as authority removal.

## Local materialisation

A chained local consumer that requires the verification overlay, including future SOS/official-network Integrity verification refresh, must not treat cloud backup completion or checkpoint-root arrival alone as proof that local Dropbox has materialised the changed verification payload.

When the exact backup report shows a changed verification root, the bounded local-materialisation gate must verify that the current verification latest object and every changed/referenced connector manifest required by the next operation are locally readable and match checkpoint identities.

Unchanged verification manifests already authenticated by the preceding accepted local baseline need not be re-hashed merely because a new checkpoint root was published.

## SOS-light / Integrity baseline

Once a repair or verification-refresh operation can mutate verification overlay authority, its pre-mutation backup baseline must pin both:

```text
observation measurement root identity
verification root identity
```

when that operation depends on both domains.

An observation-only repair with no verification mutation may continue to use observation authority according to its normal contract, but it must not claim verification-baseline equality it did not check.

A verification-only refresh must not require observation Parquet to change merely to obtain a new backup generation.

## Restore ordering

Restore support must include the verification domain.

For verification restoration:

1. restore and verify referenced connector manifests first;
2. restore the compact verification latest object last;
3. do not expose a latest object that references connector manifests not yet restored and verified.

Restoring verification authority does not require rewriting observation Parquet.

The generic R2 restore workflow is not considered complete for this new domain until this ordering and exact-byte verification are implemented and accepted through TEST.

## Backup completion evidence

A successful backup after overlay activation must report at least:

- verification units inventoried;
- verification units copied/reused;
- verification bytes copied;
- verification source-root identity;
- Dropbox verification checkpoint/state-root identity;
- verification latest key and exact identity;
- any connector manifests changed in that run.

A run that copied observations successfully but failed required verification backup MUST NOT claim complete R2 history backup success once verification overlay is active.

## TEST acceptance

After implementation, real TEST backup acceptance must demonstrate:

- a verification-only R2 change with unchanged observation Parquet;
- the next backup copies the changed verification authority;
- the observation processed-source-root remains unchanged;
- the verification processed-source-root changes;
- Dropbox payload identities match R2;
- local materialisation can authenticate the changed verification files;
- restore into an isolated TEST target publishes connector manifests before verification latest and reproduces exact identities.

No broad speculative pre-deployment test suite is required.
