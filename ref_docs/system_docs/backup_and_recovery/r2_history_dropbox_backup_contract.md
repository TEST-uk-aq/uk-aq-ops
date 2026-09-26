# R2 history Dropbox backup contract

## Authority and scope

This is the shared umbrella contract for the hierarchical R2 history backup to Dropbox.

Detailed authority is split by active implementation responsibility:

- [`r2_history_backup_inventory_contract.md`](r2_history_backup_inventory_contract.md): R2-side hierarchical backup inventory, source traversal and independent full-scan verification;
- [`r2_history_dropbox_sync_contract.md`](r2_history_dropbox_sync_contract.md): Dropbox checkpoint/state, copy planning, stale-observation pruning, batching and completion ordering;
- [`r2_history_index_v3_backup_amendment.md`](r2_history_index_v3_backup_amendment.md): narrow override for authority-aware compact latest-timeseries selection across observation-history index v2/v3 cut-over.

The packed `timeseries_binding` transport is separately defined by [`r2_history_timeseries_binding_pack_backup_contract.md`](r2_history_timeseries_binding_pack_backup_contract.md). Its Phase 1 pack producer, Phase 2 Dropbox packed transport, Phase 3 SOS-light Integrity consumption, Phase 4 pack-to-individual restore and Phase 5 scheduled/default TEST cut-over are implemented and operationally proven on TEST. Packed bindings are now the current scheduled/default TEST binding-backup authority. LIVE adoption remains a separate promotion step.

The Phase B observations backup is mandatory. Optimisation MUST preserve complete required observation backup coverage and MUST NOT disable, skip or reduce canonical observation history data.

## Active backup scope

The logical backup remains the v2 history backup. Its required domains are:

```text
history/v2/observations
history/v2/_ops/observations/runs
history/_index_v2/timeseries_binding
<authority-selected observations_timeseries_latest.json>
history/v2/core
```

The compact latest-timeseries path follows persistent observation-history index authority under the v3 amendment. This does not rename the other logical-v2 domains or the existing backup inventory/checkpoint format.

The current scheduled/default deployed TEST backup covers:

- committed observation day folders, manifests and Parquet objects;
- observation month/year/root aggregate manifests;
- observation run manifests;
- physical timeseries-binding bytes transported to Dropbox through the authenticated packed representation defined by the pack contract;
- one compact authority-selected latest-timeseries operational summary;
- core history objects.

The pack path changes only the Dropbox transport representation of the physical binding bytes. It does not remove `history/_index_v2/timeseries_binding` from logical backup scope and does not make runtime R2 binding readers pack-aware. Individual R2 binding objects remain the runtime representation.

Manual TEST workflow selection of `individual` remains available as bounded rollback during the observation period, but absent an explicit override the normal GitHub-hosted TEST backup now selects `pack`.

## Explicit exclusions

The active Dropbox history backup MUST NOT inventory, copy or checkpoint:

```text
history/v2/aqilevels
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
history/_index_v2/observations_timeseries/
history/_index_v3/observations_timeseries/
```

Calculated AQI history/debug is not part of the active Dropbox backup requirement.

The bulk per-day/per-connector/per-pollutant observation-timeseries index trees are derived/reconstructable R2 query/repair indexes. They remain R2 products but are not bulk Dropbox backup payload.

The compact latest-timeseries summary is deliberately different: it is derived and rebuildable but small and operationally useful, so the authority-selected compact file remains required backup coverage.

Core remains required backup coverage. Core pruning is intentionally **not authorised**. Destination core objects MUST NOT be deleted merely because the latest core inventory no longer references them until a later active contract defines safe core retention/deletion.

## R2 source contracts

The backup consumes, but does not redefine, the source authorities in `r2_history/`:

- observation hierarchy: [`../r2_history/observations_manifest_hierarchy_contract.md`](../r2_history/observations_manifest_hierarchy_contract.md);
- observation cross-run exclusion: [`../r2_history/observations_run_exclusion_contract.md`](../r2_history/observations_run_exclusion_contract.md);
- stable physical timeseries binding/source manifests: [`../r2_history/contract.md`](../r2_history/contract.md).

R2 source manifests and indexes are authored by their owning R2-history paths. Normal backup inventory/sync operation is read-only with respect to those products.

The binding-pack publisher is a backup derivative publisher, not a new binding source authority. Its complete member set MUST be derived from the existing authoritative 1,000-ID binding source ranges under the pack contract.

## One active hierarchical implementation

The hierarchical design is the only active R2 history Dropbox backup implementation.

There MUST be one active production inventory builder and one active production sync:

```text
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
```

The active workflow MUST invoke only this hierarchical implementation.

There MUST NOT be an active flat inventory/checkpoint implementation, migration-only compatibility mode, adoption mode, fallback path or hybrid backup path.

The retained `individual`/`dual`/`pack` binding-payload modes described by the pack contract are not a second backup implementation. They are representation controls inside the one hierarchical backup path. `pack` is now the normal scheduled/default TEST authority; `individual` remains a bounded rollback option during the observation period, and `dual` remains transition-only support rather than steady state.

Superseded wrappers, options, environment variables, validators, report fields and helper code that exist only for the old flat design MUST NOT remain as second active behaviour once confirmed unreferenced.

Pre-change implementation archives required by repository `AGENTS.md` are rollback/reference material only and MUST NOT be executed by active workflows or scripts.

## Source and destination roles

R2 is the backup source.

Dropbox is the independent backup destination.

The R2 backup inventory describes current source units and their stable source identities. Dropbox checkpoint state records source identities that have been copied and verified successfully.

Dropbox state:

- is not a second source inventory;
- MUST NOT author or repair R2;
- MUST NOT be treated as permission to mutate current R2 history.

The inventory consumes authoritative R2 source hierarchies; it does not repair them as a backup side effect.

### R2 inventory versus Dropbox checkpoint location boundary

The hierarchical backup inventory is an **R2-side control product**. Its active root and shards remain in R2 under:

```text
history/_index_v2/backup_inventory_v2/root.json
history/_index_v2/backup_inventory_v2/...
```

Those R2 inventory objects describe and authenticate the source backup inventory. They are **not Dropbox backup payload** and MUST NOT be required to exist as files beneath the Dropbox backup destination root.

The Dropbox-side persistent backup state is the separate hierarchical checkpoint tree under:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
_ops/checkpoints/r2_history_backup_state_v2/...
```

Therefore:

- a verifier, migration preflight or operator runbook that needs the **backup inventory-root identity** MUST read that identity from the R2 inventory or from immutable/pinned evidence that was derived from that R2 inventory;
- a verifier, migration preflight or operator runbook that needs the **Dropbox checkpoint/state-root identity** MUST read the Dropbox checkpoint tree;
- tooling MUST NOT construct `<Dropbox root>/history/_index_v2/backup_inventory_v2/root.json` and treat its absence as backup incompleteness;
- absence of a Dropbox-local copy of the R2 inventory root is expected and is not a backup failure;
- the R2 inventory root and the Dropbox checkpoint root are separate identities and neither may be substituted for the other.

This location boundary remains unchanged when observation-timeseries authority moves to v3. The `_index_v2` component of the inventory path is the backup-format generation, not the active observation-timeseries index generation.

The pack derivative is an additional R2-side backup publication under its own generation-neutral `_backup_packs_v1` namespace. Its current pack objects are normal TEST Dropbox binding payload and do not turn the existing R2 inventory tree into Dropbox payload.

## Obsolete flat inventory/state

The obsolete flat objects are:

```text
R2:
history/_index_v2/backup_inventory_v2.json

Dropbox:
_ops/checkpoints/r2_history_backup_state_v2.json
```

They are not active authority.

Current implementation MUST NOT:

- adopt from them;
- fall back to them;
- rewrite them;
- expose compatibility configuration solely for them;
- depend on them during fresh start or restart.

If hierarchical Dropbox state does not exist, current sync initialises from the current hierarchical inventory and current destination evidence, not the obsolete flat checkpoint.

After a successful real TEST backup confirms complete current hierarchical inventory/state, those obsolete flat objects are authorised for manual deletion when present.

## Backup-format identity

The hierarchical inventory/checkpoint roots remain:

```text
history/_index_v2/backup_inventory_v2/root.json
_ops/checkpoints/r2_history_backup_state_v2/root.json
```

The `_index_v2` text in those paths identifies the existing backup-format generation. It MUST NOT be mechanically rewritten to `_index_v3` merely because observation-history index authority moves to v3.

The v3 amendment changes only the authority-selected compact latest-timeseries source unless another explicit migration changes the backup format itself.

The binding-pack contract introduces `_backup_packs_v1` specifically for the binding transport derivative. That pack generation MUST remain independent of observation-history index generation.

## Interaction with writers

Prune Daily and Integrity own committed observation/source-manifest mutation.

Timeseries-binding reconciliation owns physical binding objects and binding source manifests.

Observation-index finalisation owns the authority-selected compact latest-timeseries object.

Backup inventory and sync consume those committed products. They MUST NOT rebuild or repair them as a normal backup side effect.

Copying committed R2 objects is read-only and does not itself require the canonical observation mutation lease.

The pack publisher may author only its own backup-pack derivative namespace from already committed binding source manifests/objects. It MUST NOT mutate the physical binding tree or become a replacement for binding reconciliation.


## Workflow-dispatch correlation for chained operator runs

The normal GitHub Actions backup workflow MAY accept an optional caller correlation identifier for operator tooling that must dispatch and wait for one exact backup run, including the serial monthly SOS-light wrapper.

When a caller correlation identifier is supplied:

- the workflow MUST expose that identifier in stable GitHub Actions run metadata such as the workflow run display name, so the caller can resolve the exact resulting run unambiguously;
- the correlation identifier is diagnostic/orchestration metadata only. It MUST NOT participate in backup inventory identities, hashes, checkpoint contents, copy planning, pruning decisions, lock identity or success/failure semantics;
- the caller MUST monitor the exact resolved run ID to a terminal conclusion rather than selecting the newest run heuristically;
- the existing uploaded backup report artifact MUST remain available to that exact run and MUST expose the state/checkpoint key plus the final `observations.processed_source_root_hash` needed to identify the successful observations checkpoint generation;
- a chained caller MUST treat failed, cancelled, ambiguous or otherwise unconfirmed runs as failure and stop rather than proceeding on elapsed time.

Calls that do not provide a correlation identifier retain the existing scheduled/manual backup behaviour.

The correlation mechanism does not weaken writer coordination. The workflow continues to run the normal hierarchical backup under the shared global observations operation lock and publishes checkpoint completion according to the existing sync contract.

### Observation Parquet copy mode for chained backups

The normal backup workflow and lower-level sync MUST support an observation-Parquet copy-mode selector with exactly these steady-state values:

```text
full
reuse_matching
```

The lower-level CLI contract is:

```text
--observation-parquet-copy-mode <full|reuse_matching>
```

The workflow-dispatch input is:

```text
observation_parquet_copy_mode
```

Omitting the CLI option or workflow input MUST resolve to `full`. An explicit `full` selection MUST be behaviourally equivalent to omission. This preserves the existing backup behaviour as the default until a later explicit contract changes that default.

`reuse_matching` is an optimisation of physical transfer only. It MUST NOT reduce logical backup coverage, alter source authority, weaken destination/checkpoint verification, or change the post-backup observation root represented by Dropbox.

The serial monthly SOS-light orchestration SHOULD request `reuse_matching` for its successful post-month backup before the next month starts. That use case deliberately republishes complete selected observation days and can therefore create fresh R2 object modification metadata and fresh canonical manifest/root identities even when many Parquet bodies are byte-identical to the preceding accepted Dropbox baseline.

The detailed eligibility, fail-closed fallback, reporting and completion semantics for `reuse_matching` are owned by [`r2_history_dropbox_sync_contract.md`](r2_history_dropbox_sync_contract.md).

### Local Dropbox client materialisation boundary

A successful GitHub-hosted backup proves the Dropbox-cloud destination and checkpoint publication performed by that workflow. It does **not** by itself prove that a separate local Dropbox desktop client has downloaded every refreshed payload file before downloading the checkpoint root.

For chained local consumers such as the serial monthly SOS-light wrapper:

- matching the local generation-specific checkpoint root to the exact successful backup report is necessary but MUST NOT be treated as sufficient local-sync evidence;
- the caller MUST perform a bounded, read-only local-materialisation verification before treating the refresh as complete;
- verification MUST be tied to the same exact backup run and use its backup report plus the authenticated generation-specific checkpoint/state hierarchy;
- the verifier MUST authenticate the local payload units newly copied or replaced by that exact backup which are within the next SOS-light baseline authority. Observation days copied by the backup MUST have their complete local manifest/Parquet dependency graph readable and identity-consistent. Any changed core or active timeseries-binding backup units consumed by SOS-light MUST likewise be locally readable and match their checkpoint/manifest/pack identities;
- the verifier MAY use existing checkpoint state-shard `copied_at` and identity evidence together with the exact backup report's run interval when the report does not already enumerate a changed unit directly;
- the verifier MUST fail closed on a missing, placeholder/unreadable, truncated or identity-mismatched local file and continue bounded polling while Dropbox is still materialising it;
- the verifier MUST NOT query live R2 to decide local completeness, mutate Dropbox/R2, or turn local file arrival into a new source of truth;
- unchanged payload units already authenticated by the preceding accepted local baseline do not need to be re-hashed merely because a new checkpoint root was published.

The local-materialisation gate is consumer-side orchestration evidence. It does not change backup checkpoint format, cloud backup success semantics or SOS-light Step 0 authority.

## Packed binding transport boundary

Phase 1, Phase 2, Phase 3, Phase 4 and Phase 5 are implemented and accepted on TEST. The pack contract is current authority for the implemented pack format, R2 pack publication, additive inventory identity, guarded pack Dropbox transport, destination verification, pack checkpoint state, root-last completion semantics, pack-aware SOS-light Integrity materialisation/currentness behaviour, dedicated exact-byte pack-to-individual binding restore behaviour and the normal scheduled/default TEST binding payload.

The accepted Phase 3 TEST proof used the normal TEST Dropbox backup and ordinary backup freshness checks. It globally verified all 143 current pack ranges and all 6,265 physical binding members, then materialised exactly the 1,141 SOS bindings required by the selected Integrity run, with zero non-SOS materialisation and zero binding gaps. The temporary view was removed successfully. The overall Integrity run later reported unrelated historical observation/AQI gaps; those do not invalidate the packed-binding provider result.

The accepted Phase 4 TEST proof first ran a real dry-run against the normal TEST Dropbox source, verifying 143/143 ranges and 6,265/6,265 members and reconstructing the authoritative source-root hash with zero destination writes. It then restored the complete 6,265-member generation into the empty isolated TEST R2 target `uk_aq_r2_test:uk-aq-history-cic-test-timeseries-binding-restore-phase4`, readback-verified all 6,265 exact binding objects, rebuilt and readback-verified all 143 range manifests, reproduced the authoritative source-root hash `651d7c6285ef738f51a97bb402dc325412626f2cf549a92f61740430aadc5e77`, and published/readback-verified the source root last. During the live run the root remained absent after all 6,265 bindings were present and while only 64/143 range manifests had been published, directly confirming root-last ordering.

The runtime-consumer audit then confirmed that active request-time consumers continue to read the unchanged individual R2 binding paths and that no runtime consumer reads `_backup_packs_v1`; the Dropbox representation change therefore does not alter request-time binding behaviour.

Phase 5 was accepted on 04/09/2026 through GitHub Actions run `33923153503`. The normal scheduler/external-dispatch path supplied no binding-mode override, so the workflow selected its new `pack` default. The run was not packs-only: it executed the normal full backup path, reused all 143 current packs, rebuilt and copied 0 unchanged packs, kept observations/core/run manifests/latest-timeseries complete, published current packed checkpoint evidence and completed the normal `ops.r2_history_dropbox_backup` task-health lifecycle successfully. Manual `individual` remains available for bounded rollback, but it is no longer scheduled/default TEST authority.

The pack contract remains the narrower authority for:

- normal scheduled/default TEST packed-binding backup behaviour;
- packed-binding restore and Integrity consumption;
- retention/retirement of the old individual Dropbox binding payload;
- later LIVE adoption through the normal promotion process.

It MUST NOT be generalised into changes to observation, core or compact latest-timeseries payloads.

## Restore boundary

The current repository generic restore utility/workflow predates the complete hierarchical backup design and is **not declared complete recovery authority** for the current backup.

This backup architecture MUST NOT silently redesign, replace or delete the only active generic restore path.

A separate active recovery contract is required before substantial generic restore replacement/retirement. It must explicitly define recovery of, or deterministic rebuild for:

- committed observations and aggregate manifests;
- observation run manifests where required;
- timeseries bindings and their source hierarchy;
- core;
- the compact latest-timeseries operational summary.

For the packed binding payload specifically, the narrow restore prerequisite is satisfied: a dedicated guarded pack-to-individual binding restore path exists and has completed a successful exact-byte isolated TEST round trip under the packed-binding contract. This does not by itself declare complete recovery coverage for every other history-backup domain.

The Phase 4 isolated restore intentionally did not copy binding `_source_state.json`, `_manifests/_refresh_state.json`, R2 backup inventory products or Dropbox checkpoint products. Those control/evidence products remain subject to regeneration or reconciliation from their owning authorities in a complete disaster recovery.

## Authorised post-deployment stale cleanup

After the hierarchical implementation has completed a successful real TEST backup against the current contracts, these obsolete backup objects are authorised for manual deletion when present:

```text
R2:
history/_index_v2/backup_inventory_v2.json

Dropbox:
_ops/checkpoints/r2_history_backup_state_v2.json
history/_index_v2/observations_timeseries/
```

Do **not** delete the corresponding active R2 bulk observation-timeseries index tree merely because its obsolete Dropbox mirror can be removed.

Do not delete current hierarchical inventory/state roots or shards.

Old individual Dropbox binding files are specifically excluded from automatic cleanup. Even after Phase 5 acceptance they remain rollback evidence through the agreed observation period and may be retired only under explicit pack-contract/manual-retirement rules.

## Precedence

Where the inventory or sync contracts describe the compact latest-timeseries unit generically, [`r2_history_index_v3_backup_amendment.md`](r2_history_index_v3_backup_amendment.md) selects its exact generation/path.

Where the pack implementation or migration is in scope, [`r2_history_timeseries_binding_pack_backup_contract.md`](r2_history_timeseries_binding_pack_backup_contract.md) is the narrower authority for the binding transport representation, pack checkpoint semantics, accepted SOS-light Integrity materialisation/currentness boundary, accepted pack-to-individual restore requirements and current scheduled/default TEST packed-binding authority.

Neither amendment MUST be generalised into a mechanical v2→v3 rename for canonical observations, observation runs, binding, core, backup inventory or Dropbox checkpoint paths.

If the shared umbrella, inventory contract, sync contract and either narrow amendment appear to conflict outside their explicit scopes, report the conflict rather than choosing silently.

## Validation policy

Before deployment, validate only structural viability plus the small deterministic checks required by the changed inventory or sync contract.

Functional acceptance occurs through real TEST inventory generation and Dropbox backup operation after deployment.

For the pack migration, the deterministic and TEST operational acceptance gates are those stated in the packed-binding contract.