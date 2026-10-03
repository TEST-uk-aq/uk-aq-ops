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

Once verification-overlay authority is enabled, the normal R2 history Dropbox backup MUST include:

1. the exact immutable connector manifests referenced by the current validated:

```text
history/_index_v3/verification/latest.json
```

2. that exact `latest.json` object itself.

Connector manifests use the canonical content-addressed layout:

```text
history/v3/verification/
  connector_id=<id>/
    manifests/
      <manifest_sha256>.json
```

The SHA encoded in each manifest key MUST agree with the exact canonical manifest bytes and with the identity pinned by latest.

These referenced connector manifests are canonical verification authority and MUST NOT be excluded as rebuildable derived-index data.

Unreferenced immutable connector manifests are not current verification authority. They MAY be retained in R2 or Dropbox for bounded recovery/history according to retention policy, but they are not required members of the **current** verification source-root identity merely because they exist under the verification prefix.

A failed or unreadable latest object MUST fail backup closed. It MUST NOT be interpreted as an empty connector set or overlay deactivation.

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

The current verification inventory MUST be derived from the validated latest object and MUST enumerate exactly:

- latest key, byte size and SHA-256;
- each connector ID referenced by latest;
- each referenced immutable manifest key, byte size and SHA-256.

The verification source-root identity MUST be computed from this authenticated current-authority set. Merely listing every object under `history/v3/verification/**` is not sufficient and MUST NOT let stale/orphaned immutable manifests alter current authority.

Dropbox hierarchical checkpoint state must record successful copied/verified verification units and the completed verification source-root identity.

A verification unit is complete only when the exact source identity selected by latest has been copied and verified at the Dropbox destination.

The existing backup-format generation paths remain unchanged. Adding a verification domain does not rename `backup_inventory_v2` or the Dropbox checkpoint generation.

## Copy planning

Verification JSON is expected to be small. No Parquet-reuse optimisation is required for this domain.

Unchanged immutable connector manifests MAY be reused when exact authenticated destination identity proves they already match.

When a connector's current manifest changes:

```text
copy/verify new immutable manifest first
        -> keep previous Dropbox latest valid
        -> copy/verify new latest last
```

The Dropbox latest object MUST NOT be advanced until every immutable connector manifest identity it references is present and verified at the destination.

If copy stops before latest advances, the prior Dropbox latest remains valid and continues to reference the prior immutable manifest set. A newly copied but unreferenced immutable manifest is non-authoritative orphan/recovery material, not a partial current backup generation.

A verification-only change MUST be copied even when no observation Parquet changed.

## Dropbox layout

The Dropbox payload mirrors the canonical R2 verification identities beneath the normal history backup root:

```text
history/v3/verification/connector_id=<id>/manifests/<manifest_sha256>.json
history/_index_v3/verification/latest.json
```

No mutable per-connector `manifest.json` key is part of the accepted design.

No separate ad-hoc verification backup directory is introduced.

## Pruning

Destination pruning for verification authority must be latest-guided and fail closed.

A referenced immutable connector manifest MUST never be pruned.

An unreferenced immutable manifest MAY be pruned only when:

- the current validated latest does not reference it;
- no retained backup/recovery generation requires it;
- the normal retention/recovery rules permit deletion.

A transport/read failure, invalid latest or identity mismatch MUST NOT be interpreted as authority removal.

Pruning MUST NOT overwrite or repurpose a content-addressed manifest key.

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

1. read and validate the source `latest.json`;
2. restore each exact immutable connector manifest referenced by it to its SHA-addressed key;
3. verify exact byte size, SHA-256 and key/hash agreement;
4. restore the compact verification latest object last;
5. verify latest exactly after publication.

A restore MUST NOT expose a latest object that references connector manifests not yet restored and verified.

If restoration fails before latest publication, any newly restored immutable manifests remain non-authoritative and the destination's prior valid latest MUST remain untouched where the restore mode preserves an existing destination authority.

Restoring verification authority does not require rewriting observation Parquet.

The generic R2 restore workflow is not considered complete for this new domain until this ordering, prior-latest safety and exact-byte verification are implemented and accepted through TEST.

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
- the new connector manifest is written at an immutable SHA-addressed key;
- the next backup copies/verifies that immutable manifest before advancing Dropbox latest;
- an interrupted pre-latest copy leaves the previous Dropbox latest usable;
- the observation processed-source-root remains unchanged;
- the verification processed-source-root changes only when current verification authority changes;
- adding an unreferenced orphan manifest alone does not change the current verification source-root;
- Dropbox payload identities match R2 latest and referenced manifests exactly;
- local materialisation can authenticate the changed latest and referenced immutable manifests;
- restore into an isolated TEST target publishes referenced manifests before latest and reproduces exact identities.

No broad speculative pre-deployment test suite is required.
