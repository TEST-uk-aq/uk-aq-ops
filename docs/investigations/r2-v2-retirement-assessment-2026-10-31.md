# LIVE R2 observation-history v2 retirement assessment — 31 October 2026

## Executive conclusion

**Blocked pending further evidence. Do not authorise R2 deletion from this report.** Recent operational evidence establishes selected-v3 Prune publication/source deletion, v3 Core publication and a completed generation-v3 Dropbox backup. The outstanding work recorded on 21 October cannot simply be repeated as today's status. However, no current per-object LIVE R2 inventory or independent current Dropbox examination was available, and the actual rollback-closure record, first-v3-backup acceptance and installed local Integrity/scheduler evidence remain incomplete.

The proposed **category A deletion manifest is empty: 0 objects, 0 bytes**. This is an evidence-based withholding of approval, not a claim that v2 objects do not exist. Canonical old observation/index material may become eligible following the gates below. Retain current v3 material, shared/version-independent control data and recovery evidence. Do not delete by substring, either of the two top-level v2 prefixes, or a broad recursive namespace rule.

The operator's approximate 493.900 MiB + 54.530 MiB implies **548.430 MiB = 0.535576 GiB ≈ 575.070 MB**, about **6.53%** of the approximate 8.200 GiB bucket. This is an upper estimate for those two entire prefixes, before exclusions; it is not an approved recoverable amount. The verified safe recoverable amount is currently **0 bytes**.

Only this investigation document is proposed for TEST Ops. No implementation, authoritative documentation, LIVE repository, R2, Dropbox, database, scheduler, workflow execution or Cloudflare configuration was changed. No deletion command, workflow or retirement implementation is supplied. Documentation needs no code-style archive under AGENTS.md.

## Evidence scope and access

Assessment date: 31 October 2026; all operational timestamps below are UTC (also London time on this date). GitHub evidence was read through the connected GitHub API, at these pinned revisions:

| Source | Revision | Revision date |
|---|---|---|
| [TEST Ops](https://github.com/TEST-uk-aq/uk-aq-ops/tree/fad44fecb0a33cd869945d74f69099850ac362fc) | `fad44fecb0a33cd869945d74f69099850ac362fc` | 31 October 2026 13:03:06 UTC |
| [Authoritative TEST system docs](https://github.com/TEST-uk-aq/uk-aq-system-docs/tree/bd3edb6cf100626284789958c120957574ed78f0) | `bd3edb6cf100626284789958c120957574ed78f0` | 30 October 2026 19:38:32 UTC |
| [LIVE Ops](https://github.com/UK-AQ/uk-aq-ops/tree/2aeec5ec33124619b69fcb9c487bd8a0e5682829) | `2aeec5ec33124619b69fcb9c487bd8a0e5682829` | 31 October 2026 00:19:04 UTC |

Initial local checkouts were older (TEST Ops `ea7212e85a01e2dc65b73ed0204d3dca9af73066`, system docs `3276ae326efc15c5cac4dbbadf17c13ba720fd7f`). They were not treated as current remote authority. Git fetch/gh from the execution shell could not connect to the session proxy; GitHub connector reads succeeded. Source inspection and remote delivery use that connector.

The managed environment reported enforced restricted networking, no configured secrets, no outbound identities and no runtime variables. R2 and Dropbox hosts were not granted and no R2/Dropbox connector was available. Consequently:

- **No R2 LIST/GET/HEAD was performed here.** Bucket existence/object inventory is not independently measured.
- **No Dropbox file or checkpoint was directly read here.** Actual retained bytes and current retention settings are unverified.
- GitHub run/job logs and printed machine-readable reports were accessible and reviewed. Report artifact metadata is distinguishable from actual artifact contents; this investigation uses the reports printed in the logs.
- No local Mac/launchd state, installed Integrity version, operator acceptance package or migration journal outside GitHub was accessible.
- All counts from older backup logs are historical, domain-specific counts, not today's R2 object counts.

**LIVE bucket identity is established from operational evidence**, not TEST fallback: `uk-aq-history-live`, appearing in LIVE Prune/Core/backup logs and in the backup source `uk_aq_r2:uk-aq-history-live`. The backup destination is `uk_aq_dropbox:LIVE/R2_history_backup`. Revalidate the account/endpoint and these identities locally before any future inventory or approval.

## Contract route, precedence and document drift

Read the current `system_docs/SYSTEM_OVERVIEW.md`, `r2_history/README.md`, `backup_and_recovery/README.md` and the task-specific contracts listed below. All links in this section are pinned to the system-docs revision above:

- [Complete side-by-side generation](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_v3_side_by_side_generation_contract.md), narrowed by [website cut-over/Core/backup scope](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_v3_website_cutover_scope_amendment.md).
- [Read-side cut-over and 19 October LIVE exception](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_v3_lock_free_read_cutover_amendment.md).
- [Migration contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_index_v3_migration_contract.md), [post-cut-over rollback data preservation](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md), [steady-state acceptance](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md), and the narrowly superseding [21 October LIVE completion decision](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_v3_live_completion_decision_2026-10-21.md).
- [Binding contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/contract.md), [binding recovery](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/recovery.md), [Integrity](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/integrity.md), [generation-aware Integrity Core](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/integrity_generation_aware_core_snapshot_amendment.md) and [SOS-light three-phase authority](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/sos_light_three_phase_authority_contract.md).
- [Prune observation-only Phase B](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/prune_daily_observation_only_phase_b_contract.md), [global operation exclusion](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observations_run_exclusion_contract.md).
- [Shared Dropbox backup](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md), [inventory](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_backup_inventory_contract.md), [sync/checkpoint](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_dropbox_sync_contract.md), [v3 backup amendment](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_index_v3_backup_amendment.md), [backup evidence location](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/r2_history/observation_history_index_v3_backup_evidence_location_amendment.md), [packed bindings](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_timeseries_binding_pack_backup_contract.md) and [generation-qualified pack namespace](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bd3edb6cf100626284789958c120957574ed78f0/system_docs/backup_and_recovery/r2_history_timeseries_binding_pack_generation_namespace_amendment.md).

Apply explicit amendments rather than mechanical renaming. In particular, selected-v3 backup inventory is `history/_index_v3/backup_inventory_v2/`, and its Dropbox state is `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/`. Older base-contract examples of `_index_v2` are not current physical routing. Likewise, `recovery.md` still says pack restore is unimplemented, whereas the narrower packed-binding/shared-backup contracts record the accepted isolated TEST round trip. This proves that specific pack recovery, not a complete generic disaster restore.

Documentation still describes the first LIVE backup as pending and LIVE packed transport as separately pending promotion; newer operational logs show complete v3 backups in pack mode. Record this as documentation/evidence drift, not permission to rewrite contracts or infer every acceptance gate passed. The SOS-light contract records fixed-v2/generic-v2 intended-operation retirement on **27 October**, while explicitly warning that repository retirement does not update installed local launchd wrappers/schedules.

## Current LIVE operational and recovery status

| Question | Evidence and conclusion |
|---|---|
| Selected normal generation | **v3 observed in executed Prune/Core/backup jobs on 31 October.** Shared selector accepts exactly v2/v3 and rejects contradictory complete-generation prefixes. An unset selector fails closed. |
| Observation reader deployment | [19 October run 39267427006](https://github.com/UK-AQ/uk-aq-ops/actions/runs/39267427006), job `118110621044`, deployed `uk-aq-observs-history-r2-api` with v3 and LIVE bucket; Worker version `7e76779a-c928-4a8f-8d5d-fe4a175abe06`. The contracts record accepted bounded deployed reads. Fresh current runtime descriptor/read verification remains required. |
| Station/cache deployment | [22 October station run 39775923558](https://github.com/UK-AQ/uk-aq-ops/actions/runs/39775923558), job `119814709202`, v3, Worker `uk-aq-station-history-live`, version `06be2680-7b7a-4a7a-a2a1-0e6345a345bf`. [19 October cache run 39268158729](https://github.com/UK-AQ/uk-aq-ops/actions/runs/39268158729), job `118113095340`, v3, bound to that LIVE service, version `3c509449-1ee3-46b5-ade9-ffb671968254`. |
| Recent combined deployment green | [31 October run 41149510540](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41149510540) was successful, but its observations deployment job was **skipped**. Do not use its green status to claim a fresh reader deployment. |
| Normal Prune/source deletion | [31 October run 41160319017](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41160319017), job `124416238788`, printed `phase_b_history.status=completed`, `stopped_for_budget=false`, 3 completed candidates, 0 failed/blocked candidates, **38,347 rows**, **3,421,003 Parquet bytes**, 267 files for 26 October. Source deletion summary committed 3 connector-days (2/3/6), **38,347 deleted rows**, zero delete errors. Manifest `history/v3/observations/day_utc=2026-10-26/manifest.json`; Phase B run `d2b9035d-79df-4d3e-8573-e4470d0c89b0`. This is actual operation, unlike the incomplete internally green 21 October attempt. |
| Prune qualification | The same run had one **recent Phase A** mismatch remaining after its allowed repair (connector 2, 31 October 01:00). Its successfully gated older Phase B/source deletion is separately evidenced; this is not a claim of an entirely warning-free system. |
| Core/current bindings | [31 October run 41167821102](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41167821102), job `124439102348`, `ok=true`, `dry_run=false`, prefix `history/v3/core`, 19 uploaded objects / 748,967 bytes. Manifest `history/v3/core/day_utc=2026-10-31/manifest.json`, hash `209c94669f5d74a626693b07fc4c04295bf10902a29714caa8275b573d1c3dff`. Binding hierarchy result succeeded; its v2 payload label does not select v2 storage. |
| Schedules | Current LIVE `cloudflare/scheduler/jobs.toml` enables Prune 02:30, Core 04:15 and backup 04:35 UTC daily; force-prune recheck is disabled. [30 October sync run 41054421875](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41054421875), job `124058234224`, succeeded after a D1 read-back/equality check. Runs on 29–31 October align with this schedule. A fresh D1/duplicate-job check is still required before retirement. |
| First-v3 backup | Completed v3 coverage is evidenced **by 25 October**, but the exact first complete post-v3 run and operator's original acceptance record were not established. Earlier 21/22 October attempts are cancelled. A later complete checkpoint does not identify the first acceptance event. |
| Subsequent backup | **31 October complete v3 backup is evidenced by printed report and held global lock**, details below. Green runs on 28–30 October support continued activity; their payloads were not independently audited here. A 27 October failure was followed by a successful retry; uninterrupted success is not claimed. |
| Complete-v2 rollback guarantee | Explicit policy closure was accepted on 21 October. Actual post-cut-over source deletion is now proven. **Do not advertise the original v2 as a lossless rollback.** The required durable `closed_at_utc` and `v2_complete_rollback_guarantee_closed=true` record was not found in accessible evidence. Confirm it; do not invent or backdate it from today's run. |
| Integrity/SOS-light | Current LIVE source is fixed-v3, uses v3 observations/index/Core and generation-specific backup authority. Intended fixed-v2 operation was retired on 27 October. **Installed versions, launchd schedules and successful recent LIVE Integrity/SOS-light reports were inaccessible**, so actual active/successful operation remains unresolved. |
| Full recovery | Complete current backup reports are evidence of copy/checkpoint state, not proof of complete generic restore. The accepted pack-to-individual TEST round trip is narrower. No accepted v3-to-v2 lossless bridge was found. |

### Verified report content: current v3 backup

[Run 41169204921](https://github.com/UK-AQ/uk-aq-ops/actions/runs/41169204921), job `124443291650`, revision `2aeec5ec33124619b69fcb9c487bd8a0e5682829`, completed its sync **31 October 04:44:35.885 UTC**:

- `ok=true`, `complete=true`, `dry_run=false`, `observation_generation=v3`, `max_days_per_run=0`, full Parquet mode, pack binding mode, not a packs-only backup.
- Inventory: `history/_index_v3/backup_inventory_v2/root.json`; state: `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/root.json`.
- Observation source and processed root hashes both `303a8406122d6d73de5127dcfad3d47034f0136e42c48c40d560376294f77617`; one changed day copied (26 October); incomplete months/years empty. Unchanged periods rely on durable previous checkpoints, not fresh whole-archive readback.
- Binding source/processed hash both `0e26d4bb4008123959eb0e7d3d6cbb43181909b27453e65a3d3ba1b3083bc747`; 180 packs reused, no incomplete ranges, root verified, complete true. Pack root `history/_backup_packs_v1/timeseries_binding/generation=v3/root.json`, SHA-256 `d824977363f85394e42d661b7e076cf0cf44c93522f0e9affb57311ea70d6a75`, 89,012 bytes.
- Core source/processed hash both `ffc04b19ce69efa09ecc5065057bc2d5c79e1af63158419f8b19a42730eaf5bb`; 5 listed units, one copied, complete true, pruning disabled.
- Run manifests: 14 listed units, one copied, complete true.
- Selected compact latest `history/_index_v3/observations_timeseries_latest.json`, SHA-256 `facea5bd57d06a8ddb1f4ca2c9a69a6d06a17e545e0e0c58f566beff56549129`, 7,493,342 bytes, copied and verified; incomplete false. Verification overlay inactive.
- Outer lock report: `ok=true`, generation v3, acquired/held through inventory, copy verification and checkpoint publication. Its logical name `uk_aq:r2_history:v2:observations_global_operation` is a **shared lock identity**, not a v2 storage dependency.

[25 October run 40168669792](https://github.com/UK-AQ/uk-aq-ops/actions/runs/40168669792), job `121094871258`, revision `daf9ba6660e3c415cb00581d2e1bae348ddaa4bf`, likewise printed complete v3/full/pack coverage, matching observation root `b4041ed8bcbbb534b27524b7ca78a8ae36dfa857d214a02db7a4ee4641caf75a` and processed root, no incomplete months/years, at **07:05:10.368 UTC**. Five changed days (11–15 October) were copied. Core inventory was empty at that time; `complete=true` for an empty domain is not evidence of historical Core snapshots. Today's five v3 Core units establish later publication/backup separately.

## Namespace inventory and classification

**A:** safe eventual deletion candidate with necessary dependency and recovery evidence established. **B:** retain in R2 under present operational/recovery boundaries. **C:** unresolved. B does not imply permanent retention; any later reclassification requires explicit evidence/contract review.

No current exact counts/bytes were available for any physical R2 category below. `Unknown` is not zero. Categories below partition relevant prefixes; subcategories must not be added again to parent estimates.

| ID/class | Exact scope and purpose | Count / bytes / MiB / GiB | Dependencies, duplication and v3 impact |
|---|---|---|---|
| O1 / C | `history/v2/observations/`: canonical Parquet, day/connector/pollutant manifests, `_manifests/` hierarchy | All unknown | Original generation, migration source and historical repair/recovery evidence. Historical Dropbox checkpoint exists; present byte-for-byte coverage unknown. v3 observations carry migrated logical history, not a demonstrated exact-byte duplicate. Selected-v3 serving does not use O1; manual tools still can. |
| O2 / C | `history/v2/_ops/observations/runs/`: run manifests/operational records | All unknown | Historical v2 backup includes run-manifest units, but not proof of every ancillary object under this directory. Preserve until evidence references and complete retained coverage are resolved. |
| O3 / B | `history/v2/_ops/observations/staging/` | All unknown | **Active v3 Prune configuration still lists this prefix for staging cleanup.** Today's scan count was zero, which is not proof of no future writes or no other consumers. Explicit exclusion from retirement until the live dependency is separately retired/accepted. |
| O4 / C | `history/v2/core/`: Core snapshots/manifests | All unknown | Selected-v3 Core and fixed-v3 Integrity use `history/v3/core/`. Old Core is immutable legacy/rollback evidence; historical Dropbox Core coverage reported, current coverage unknown. Core pruning is not generally authorised. Require a specific historical-generation retention/recovery disposition; current v3 Core is not a complete historical duplicate. |
| O5 / C | Other keys under `history/v2/`, including any `aqilevels/`, other `_ops/`, debug or unexpected files | All unknown | Detect rather than assume absent. AQI is a separately retired product, not canonical observations; not required backup payload. Its retirement is not permission for a broad generation purge. Mixed/unrecognised objects stay unresolved. |
| I1 / C | `history/_index_v2/observations_timeseries/`: bulk observation-timeseries index tree | All unknown | Used by explicit v2 readers/rollback/rebuilders; no selected-v3 request fallback. Bulk derived tree deliberately excluded from current backup. Do not confuse obsolete Dropbox-mirror cleanup permission with permission to delete R2 indexes. Rebuild adequacy and remaining tooling dependencies need acceptance. |
| I2 / C | Exact key `history/_index_v2/observations_timeseries_latest.json` | Current unknown | Compact operational summary, unlike I1, is required selected-generation backup payload. Historical verified identity below; retain until exact retained backup/evidence references are verified. |
| I3 / B | `history/_index_v2/timeseries_binding/`: individual bindings, `_manifests/`, source/control state | All unknown | Old-generation binding authority and recovery evidence; do not automatically delete stale bindings or assume packs replace every control file. Migration created v3 counterparts, but their current identities may diverge. Historical individual backup evidence exists; scope-specific retirement remains unresolved. |
| I4 / B | `history/_index_v2/backup_inventory_v2/`: hierarchical root, observation-month/binding/global/Core inventory shards | All unknown | Retain frozen inventory/evidence until v2 backup-to-candidate reconciliation and recovery disposition are accepted. Current v3 backup routes elsewhere, but this may be the only historical R2 source-inventory evidence. It is **not normally mirrored as a Dropbox inventory tree**. |
| I5 / C | Exact `history/_index_v2/backup_inventory_v2.json`, if present | Unknown; existence unverified | Obsolete flat inventory is distinct from I4. Base contract permits bounded stale cleanup after its prerequisites; applicability/existence/recovery references not verified for LIVE. |
| I6 / C | Other `history/_index_v2/` keys, including unrelated AQI indexes | All unknown | Classify by owning product and references; no `v2` substring inference. |
| P1 / B | Legacy `history/_backup_packs_v1/timeseries_binding/` objects **excluding** `generation=v3/` and any other `generation=.../` subtree | All unknown; existence unverified | Independently versioned derivative v1 packs potentially supporting old binding recovery. Not included in operator's two-prefix estimate. Never recursively delete its parent: that parent contains active v3 packs. No cross-generation deduplication/GC assumption. |
| S1 / B | `history/_index_v3/backup_inventory_v2/`, all `history/v3/`, all `history/_index_v3/`, `history/_backup_packs_v1/timeseries_binding/generation=v3/` | All unknown here | Current v3 observations/Core/index/binding/backup/recovery material; explicitly excluded. Keep v3 index optimisation out of scope. `backup_inventory_v2` is a format name within v3. |
| S2 / B | Any R2 `_ops/`, migration/rollback/provenance evidence, shared locks/control objects, unrelated independently versioned products | Unknown; presence/location to inventory | Excluded from deletion. Derive any narrower scope only from an identified owner and exact reference analysis. Do not guess all migration evidence lives under either candidate prefix. |
| D1 / retain Dropbox | `_ops/checkpoints/r2_history_backup_state_v2/` under the LIVE Dropbox backup, especially `observation_generation=v2/` and `observation_generation=v3/`; any legacy unqualified/flat state | Not an R2 saving | Retain all Dropbox state/payload for this investigation. Checkpoint format v2 is independent of physical observation generation. A Dropbox path must not be counted as R2 inventory. |

O3 is an actual residual dependency: LIVE Prune's logged `UK_AQ_R2_HISTORY_STAGING_PREFIX=history/v2/_ops/observations/staging`, and `cleanupStaging()` in `workers/uk_aq_prune_daily/phase_b_history_r2.mjs:6863` lists that prefix and can remove stale staging objects during normal operation. This investigation did not invoke it. A broad `history/v2/` retirement would overlap an active maintenance namespace.

**No category is A today.** O1/I1 are the most plausible eventual narrow candidates, but even these require exact inventory, retained canonical backup authentication, accepted recovery limitations and proof that old writer/rollback routes cannot operate.

## Dependency findings from implementation

Implementation references below use LIVE Ops revision `2aeec5ec33124619b69fcb9c487bd8a0e5682829` unless stated otherwise. Paths can be opened beneath that pinned tree. The equivalent current TEST blobs were compared through GitHub; identical blobs provide the same implementation evidence in both repositories.

| Boundary | Relevant path / finding |
|---|---|
| Generation routing | [`workers/shared/uk_aq_observation_history_generation.mjs`](https://github.com/UK-AQ/uk-aq-ops/blob/2aeec5ec33124619b69fcb9c487bd8a0e5682829/workers/shared/uk_aq_observation_history_generation.mjs): selected complete generation owns observations, runs, Core, binding/index, inventory, state and pack routes. `UK_AQ_R2_HISTORY_INDEX_VERSION` has no normal routing authority. |
| Normal history reads | `workers/uk_aq_observs_history_r2_api_worker/worker.mjs:1535` checks selected prefixes and dispatches directly to `worker_v3.mjs` for v3. `/v1/history-generation` is an authenticated GET descriptor. v2 reader code remaining in the source is not evidence of fallback in selected-v3 mode. |
| Website station history | `workers/uk_aq_station_history/src/index.mjs` consumes the R2 observation adapter and computes station AQI; its `CONTRACT_VERSION="v2"` describes API/logical semantics. Deployed LIVE cache service binding is independently evidenced above. Fresh deployed route/binding checks remain necessary. |
| Prune writer/finaliser | `workers/uk_aq_prune_daily/phase_b_history_r2.mjs:496` resolves/validates generation-specific observation and run prefixes. Its v3 branch and today's report demonstrate exact-v3 publication/finalisation and gates. It does not require v2 canonical observations/indexes for normal v3 publication; staging cleanup is the residual exception. |
| Core/binding | `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs` uses selected Core/binding generation. Migration's `lib/observation_history_generation_bindings.mjs` reads/hashes v2 bindings and publishes same-payload v3 counterparts during migration. That migration dependency is historical/manual, not proof that v3 Core still reads v2 bindings. |
| Backup | `scripts/backup_r2/uk_aq_run_locked_history_backup.mjs:196`, `sync_history_to_dropbox.mjs:1373`, `lib/hierarchical_backup_v2.mjs:1178` enforce complete selected generation. Normal v3 backup does not require old canonical v2. An explicit non-default generation backup route still exists; invoking it writes inventory/packs/state and is outside this investigation. |
| Integrity/SOS-light | [`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py`](https://github.com/UK-AQ/uk-aq-ops/blob/2aeec5ec33124619b69fcb9c487bd8a0e5682829/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py): constants at lines 162–163 fix v3/Core; lines 9641–9649 select v3 observation/index and history choices. Some identifiers still say V2; their values are v3. Step 0 requires accepted complete Dropbox state, held global lock and same-generation observations-root equality; Core/binding have separate authority. No successful recent installed LIVE run was accessible. |
| Restore | `scripts/backup_r2/restore_history_from_dropbox.mjs:125` selects generation and rejects contradictory observation/Core prefixes. Generic restore is not complete binding/index/run/checkpoint recovery authority. TEST's restore blob differs from LIVE; no parity assumption. Dedicated packed-binding restore proves only its accepted scope. |
| Legacy writer risk | [`scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1-LIVE.mjs`](https://github.com/UK-AQ/uk-aq-ops/blob/2aeec5ec33124619b69fcb9c487bd8a0e5682829/scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1-LIVE.mjs) defaults to `history/v2/observations`; `assertLiveR2WriteTarget()` checks the LIVE bucket. This source retains a write-capable manual v2 builder. Its existence does not prove it is scheduled, and intended-operation retirement alone does not prove installed/manual invocations are disabled. Establish ownership and exclusion before retirement. |
| Migration/rollback | `scripts/backup_r2/lib/observation_history_migration_v3.mjs`, `scripts/index_v3_migration/v2_runtime_recovery.mjs`, `rollback_executor_authority.mjs` preserve source-v2 and runtime/evidence identities for migration/rollback. Old data remains useful evidence after complete rollback ceases to be guaranteed. Review the actual accepted evidence package's references before removing it. |

Shared current TEST/LIVE blob comparison (TEST revision pinned above):

| Path | TEST blob SHA | LIVE comparison |
|---|---|---|
| `workers/shared/uk_aq_observation_history_generation.mjs` | `6c7bd1e6cfa13aa62014c93b5f953762b25c8c10` | Identical |
| `scripts/backup_r2/lib/observation_history_generation_bindings.mjs` | `f89e44765548f5bb278f156db89a8c9e9541516f` | Identical |
| `scripts/backup_r2/uk_aq_run_locked_history_backup.mjs` | `ab599175676e2b10aa33c7774b4c7654fb888875` | Identical |
| `scripts/backup_r2/sync_history_to_dropbox.mjs` | `0fb3eaec4a4ebc9b981367588dd8a69181130e31` | Identical |
| `scripts/backup_r2/lib/hierarchical_backup_v2.mjs` | `eb0d2ba638487faed5f36086354f863ffdc65155` | Identical |
| `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs` | `bb500723f501acf03ff79f752ab65e94eae92f7d` | Identical |
| `scripts/backup_r2/restore_history_from_dropbox.mjs` | `787a5984e6a637dfede3129bc15aa4a47b0bfdb4` | Different; inspect separately |
| `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` | `16f6f6a328168259142dae96f17ef6cac530fe18` | Identical |
| `workers/uk_aq_observs_history_r2_api_worker/worker.mjs` | `1cb16d3b90b5bafd58c26610a3ef18e4c13108d9` | Identical |
| `workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs` | `8dd1da9f26f28c09e9f3c8f0b301599ada3aabad` | Identical |
| `workers/uk_aq_station_history/src/index.mjs` | `d537f3381cf6b2dfefc9b07ba1d8456c4be03be8` | Identical |
| `scripts/uk_aq_dropbox_prune_raw.py` | `c95fe757f7ecf27ea190d78da74d658e65a81bf6` | Identical |

These source checks do not establish the absence of out-of-repository installed jobs. No relevant LIVE Integrity launchd definition was found in the inspected repository tree; that is a limitation, not proof none exists. Review local launchd/crontab/manual procedures and deployment histories separately.

## Historical v2 Dropbox coverage and retention

### Existing operational evidence

[15 October LIVE backup run 38719496466](https://github.com/UK-AQ/uk-aq-ops/actions/runs/38719496466), job `116370281065`, revision `f4e36aedbe4c70ebcf6940e0ae8a90e03200249e`, printed a complete non-dry-run selected-v2 hierarchical backup report at **10:21:46.900 UTC**, targeting `LIVE/R2_history_backup`:

| Domain | Historical report evidence | Limit |
|---|---|---|
| Canonical observations/manifests | Source and processed observation root both `5adc551d978c06d2d2b71ed6edff6c19a0317a4143c80d6dec2ded6cb861ba6f`; two source years / 22 months in inventory; no incomplete months/years | Unchanged years skipped by authenticated checkpoint; no full per-object reread in this run. Exact retained day/key/byte coverage today is unknown. |
| Individual bindings | 7,540 inventoried binding units, 177 ranges; source and processed backup hash both `36fab6d3ad165890fd2b9f8579c86e21da804adc2964033fc45159f9534ea0b3`; individual mode; no incomplete ranges | Historical inventory count, not today's R2 count or proof all source-state/control objects were copied. |
| Core | 73 inventoried units; matching source/processed hash `584b00397ee9ad15ca028d10b4e068cc6f37a068b4e8cf6b25189cbbd02c8307`; complete true | Unit count is not a recursive R2 object count; current retained bytes unverified. |
| Observation run manifests | 80 inventoried units; complete true | Does not certify every operational/staging record beneath `_ops/`. |
| Compact v2 latest summary | `history/_index_v2/observations_timeseries_latest.json`, 551,962 bytes, SHA-256 `04dc141637a5c324bb9f9b822e45dbd10065768192e8503f71d9033f9916988b`; previously verified/copy date 14 October 04:41:31.025 UTC | Historical identity; not current independent Dropbox readback. |
| State | `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/root.json`; complete true | Must still exist with its referenced shards and required files. |
| Inventory | `history/_index_v2/backup_inventory_v2/root.json` in **R2** | Not a Dropbox inventory-root requirement. Preserve the historical inventory evidence before eventual R2 retirement. |

This is stronger than a storage-coverage calendar: an executed backup reported complete authenticated source/checkpoint identities. It is still **historical operational evidence**, not independently verified current retention. No exact intended-R2-scope-to-retained-Dropbox comparison is possible until the operator supplies current listings, rooted coverage and body identities.

### Intentional exclusions and recovery limits

- Bulk `history/_index_v2/observations_timeseries/` and the corresponding full derived v3 exact tree are deliberately excluded from normal backup. They are rebuildable derived products under the contracts; the generation-selected compact latest summary is included.
- Retired AQI/debug, staging and arbitrary operational scratch are not made required backup payload by having a v2 name.
- Binding `_source_state.json` / refresh control and backup inventory/checkpoint products need owner-specific regeneration/reconciliation in complete recovery. Individual binding payload and required source hierarchy must be distinguished from derivative control.
- v3 recovery should use its selected v3 canonical baseline, Core/binding authority, compact summary and v3 pack subtree. No legitimate current v3 dependency on O1/I1 was found in the inspected source, but installed tooling and evidence references are not fully proven.
- Restoring historical v2 bytes may be **partially/reconstructively possible** if the retained payload is authenticated. A complete turnkey v2 restore, complete derived-index rebuild acceptance and lossless recovery of post-cut-over observations into original v2 are **not established**. The generic restore utility is not authority to claim otherwise.

### Retention safeguards

The current v3 sync validates selected-generation paths/state and prunes stale observation Parquet within accepted current day scopes. It must not be repurposed as a missing-source mirror after R2 retirement; inventory disappearance must never become permission to erase the retained historical Dropbox baseline. Core pruning is disabled by contract/report. Old individual binding payload is expressly retained through its accepted observation window; packed-mode success alone does not authorise its removal.

The active `uk_aq_dropbox_prune_raw.yml` runs `scripts/uk_aq_dropbox_prune_raw.py`, which discovers `/LIVE/connectors/<connector>/raw_data/<dated-folder>`. That inspected code does not target `/LIVE/R2_history_backup`. It is one concrete safeguard, not proof that other external retention jobs or Dropbox/account actions cannot remove history.

Before future approval, the operator must document an explicit retention owner/hold, exact historical v2 payload/state/inventory identities, exclusions from every cleanup/retention process, manual-deletion restrictions, Dropbox revision/availability policy and a review date. A separately preserved verified copy outside automatic sync is recommended as a future operator action if no existing hold provides equivalent protection. **No copy or retention change is performed or authorised by this investigation.** Preserve old v2 and current v3 state independently; never let a v3 checkpoint satisfy retained-v2 coverage.

## Candidate manifest and storage accounting

### Proposal state

```text
status: blocked; not an authorisation
target_bucket: uk-aq-history-live
category_A_object_count: 0
category_A_total_bytes: 0
category_A_entries: []
per_object_live_inventory: unavailable
```

After evidence is supplied, define the eventual proposal as an **explicit sorted per-key allowlist**, classified from a complete read-only listing of the bounded old-generation namespaces. Never infer the deletion set directly from a prefix match. Every unknown key stays C; B and all exclusions remain outside the proposal.

For a large manifest, use an operator-selected private investigation/evidence directory outside active backup sync and cleanup, with a separate redundant retained copy. Record its exact storage URI/access owner, creation and capture start/end UTC, LIVE account/bucket/endpoint identity, repo and deployment revisions, observation/backup roots, schema version, object count, exact summed bytes, file byte size and SHA-256. Do not publish private per-object lists, credentials or observations in Git.

Each manifest entry needs full exact key, category, byte length, last-modified, ETag as an **opaque identity**, available version/checksum identity, reason, backup reference/hash or accepted deterministic rebuild evidence. Before destructive implementation is accepted, resolve whether safe conditional identity enforcement is supported; ETag is not assumed to be MD5 or sufficient content authentication. Unexpected paths, duplicate keys or changed identities invalidate approval. A manifest digest alone does not prove remote bytes remain unchanged.

### Accounting

MiB = bytes / 1,048,576; GiB = bytes / 1,073,741,824; decimal MB = bytes / 1,000,000,000. Parent estimates and their child categories must not be double-counted.

| Quantity | Current result |
|---|---|
| Independently measured total v2-related LIVE R2 bytes | **Unknown**; no direct listing |
| Operator estimate `history/v2/` | 493.900 MiB ≈ 0.482324 GiB |
| Operator estimate `history/_index_v2/` | 54.530 MiB ≈ 0.053252 GiB |
| Two-prefix total | 548.430 MiB ≈ 0.535576 GiB; implied ≈575,070,535.68 bytes from rounded inputs, **not an exact integer measurement** |
| Approved-evidence A amount potentially recoverable | **0 bytes / 0 MiB / 0 GiB** |
| B amount that must remain | Unknown exact count/bytes; includes active staging and recovery/shared exclusions |
| C amount awaiting investigation | Unknown exact count/bytes; most potentially obsolete canonical data/index material |
| Budget reconciliation after inventory | `old_generation_total = A + B + C`, on disjoint categories. Track P1/shared/external-prefix material separately from the two-prefix estimate. |
| Maximum arithmetic saving before exclusions | ≈0.535576 GiB; ≈6.53% of approximate 8.200 GiB |
| Arithmetic bucket size after removing both estimated entire prefixes | ≈7.664424 GiB; **not a recommendation** |
| Expected authorised saving today | 0; no deletion recommended |

The supplied v3 observation/index estimates (3.215 + 4.445 = 7.660 GiB) plus the two-prefix estimate total about 8.195576 GiB, approximately 4.53 MiB below the rounded 8.200 GiB total. Do not treat this rounding/residual difference as discovered objects. Whole-bucket exact reconciliation needs a same-time inventory, including packs and other top-level namespaces.

## Targeted operator read-only evidence collection

Run locally with existing authorised **read-only** access. Commands below only list/read remote state; output redirections create local evidence files. Do not invoke backup builders/sync, migration/restore, Integrity, Prune, deployment or workflow-dispatch runners, even with dry-run flags: they can acquire/write operational state or exercise mutation paths. Do not print credentials or share rclone configuration. Keep raw logs/listings private and return redacted summaries plus hashes.

### 1. Pin identity and capture bounded R2 listings

Set `R2_LIVE_REMOTE` to an existing rclone remote independently checked against the LIVE endpoint/account from configuration. Set `DROPBOX_LIVE_REMOTE` to the existing approved Dropbox remote. No default or TEST fallback is permitted. The verified bucket is literal below; the remote names are operator-specific.

```bash
: "${R2_LIVE_REMOTE:?Set an existing verified LIVE R2 remote name}"
: "${DROPBOX_LIVE_REMOTE:?Set an existing approved Dropbox remote name}"
umask 077
EVIDENCE_DIR="work/r2-v2-retirement-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
date -u +%FT%TZ > "$EVIDENCE_DIR/capture-start.txt"
rclone version > "$EVIDENCE_DIR/rclone-version.txt"
rclone lsjson "${R2_LIVE_REMOTE}:uk-aq-history-live" --max-depth 1 > "$EVIDENCE_DIR/r2-top-level.json"
rclone lsjson "${R2_LIVE_REMOTE}:uk-aq-history-live/history" --max-depth 1 > "$EVIDENCE_DIR/r2-history-top-level.json"
rclone lsjson "${R2_LIVE_REMOTE}:uk-aq-history-live/history/v2" --recursive --files-only > "$EVIDENCE_DIR/r2-v2.json"
rclone lsjson "${R2_LIVE_REMOTE}:uk-aq-history-live/history/_index_v2" --recursive --files-only > "$EVIDENCE_DIR/r2-index-v2.json"
rclone lsjson "${R2_LIVE_REMOTE}:uk-aq-history-live/history/_backup_packs_v1/timeseries_binding" --recursive --files-only --exclude '/generation=v3/**' > "$EVIDENCE_DIR/r2-legacy-binding-packs.json"
date -u +%FT%TZ > "$EVIDENCE_DIR/capture-end.txt"
```

Return exit statuses/errors, capture interval, exact category counts/summed `Size` and unexpected keys. Preserve each `Path` relative to its command root; reconstruct full keys explicitly. Listing directories and zero-length objects need separate treatment: a zero-length object is not automatically dispensable. A missing optional prefix is an absence result, not permission to ignore an authentication/listing failure.

For exact ETag/LastModified metadata, use an existing S3-compatible read-only profile/endpoint verified against LIVE (no credential export is needed in the report):

```bash
: "${LIVE_R2_AWS_PROFILE:?Set a verified read-only LIVE profile}"
: "${LIVE_R2_ENDPOINT:?Use the verified LIVE R2 endpoint}"
aws --profile "$LIVE_R2_AWS_PROFILE" --endpoint-url "$LIVE_R2_ENDPOINT" s3api list-objects-v2 --bucket uk-aq-history-live --prefix history/v2/ --output json > "$EVIDENCE_DIR/s3-v2.json"
aws --profile "$LIVE_R2_AWS_PROFILE" --endpoint-url "$LIVE_R2_ENDPOINT" s3api list-objects-v2 --bucket uk-aq-history-live --prefix history/_index_v2/ --output json > "$EVIDENCE_DIR/s3-index-v2.json"
```

Retain normal CLI automatic pagination; do not add `--no-paginate`, `--max-items` or a delimiter that omits descendants. Record total key count and bytes and verify pagination completed. The S3 results provide opaque ETag identities; HEAD is available for specifically identified ambiguous objects. A listing is not atomic across concurrent writes; capture two consistent inventories and their root identities before eventual approval.

For protected control/evidence objects, collect GET output locally, starting with:

```bash
rclone cat "${R2_LIVE_REMOTE}:uk-aq-history-live/history/v2/observations/_manifests/manifest.json" > "$EVIDENCE_DIR/r2-observations-v2-root.json"
rclone cat "${R2_LIVE_REMOTE}:uk-aq-history-live/history/v3/observations/_manifests/manifest.json" > "$EVIDENCE_DIR/r2-observations-v3-root.json"
rclone cat "${R2_LIVE_REMOTE}:uk-aq-history-live/history/_index_v2/backup_inventory_v2/root.json" > "$EVIDENCE_DIR/r2-inventory-v2-root.json"
rclone cat "${R2_LIVE_REMOTE}:uk-aq-history-live/history/_index_v3/backup_inventory_v2/root.json" > "$EVIDENCE_DIR/r2-inventory-v3-root.json"
```

Follow referenced historical inventory shards with GET, preserving their exact keys and hashes. Do not run an inventory builder to fill gaps. Root/payload inspection must identify unexpected cross-generation references, not just compare filenames.

### 2. Inspect the retained Dropbox generation

```bash
rclone lsjson "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup" --max-depth 1 > "$EVIDENCE_DIR/dropbox-top-level.json"
rclone lsjson "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/history/v2" --recursive --files-only > "$EVIDENCE_DIR/dropbox-v2.json"
rclone lsjson "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/history/_index_v2" --recursive --files-only > "$EVIDENCE_DIR/dropbox-index-v2.json"
rclone lsjson "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2" --recursive --files-only > "$EVIDENCE_DIR/dropbox-checkpoint-files.json"
rclone cat "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/root.json" > "$EVIDENCE_DIR/dropbox-state-v2-root.json"
rclone cat "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/root.json" > "$EVIDENCE_DIR/dropbox-state-v3-root.json"
```

Return exact retained observation day/connector/pollutant scope, key counts/bytes, required root/shard identities, incomplete/pending flags, processed source roots, binding mode, Core and run-manifest coverage, compact latest identity, and missing or unreferenced objects. Read referenced checkpoint shards with GET. Missing Dropbox `history/_index_v2/backup_inventory_v2/root.json` is **not** itself backup failure: that is an R2 inventory location, not the required Dropbox state location.

Compare every proposed canonical candidate with its retained Dropbox counterpart by exact relative key, size and body SHA-256 using existing canonical inventories/manifest identities. Where necessary, the following streams objects read-only to calculate hashes; it does not copy or change remote files:

```bash
rclone hashsum SHA-256 "${R2_LIVE_REMOTE}:uk-aq-history-live/history/v2/observations" --download > "$EVIDENCE_DIR/r2-observation-sha256.txt"
rclone hashsum SHA-256 "${DROPBOX_LIVE_REMOTE}:LIVE/R2_history_backup/history/v2/observations" --download > "$EVIDENCE_DIR/dropbox-observation-sha256.txt"
```

Repeat only for exact other candidate domains requiring authentication (run manifests, Core, compact latest, individual bindings). Keep files private. Index-tree absence can be deliberate; document the accepted deterministic rebuild proof instead of claiming a nonexistent backup. If old packs exist, authenticate their legacy root/members separately while excluding all generation-qualified children; historical individual-mode backup does not prove pack presence.

Required reconciliation output: candidate count/bytes, matched count/bytes, missing/different count/bytes, exact unexpected keys, non-backed derived categories with accepted rebuild identity, source/checkpoint root hashes and date intervals. Also supply the operator's retention owner/hold/exclusion statement. Do not infer a hold from this report.

### 3. Recover actual operational acceptance records

```bash
gh run view 38719496466 --repo UK-AQ/uk-aq-ops --log > "$EVIDENCE_DIR/backup-v2-20261015.log"
gh run view 40168669792 --repo UK-AQ/uk-aq-ops --log > "$EVIDENCE_DIR/backup-v3-20261025.log"
gh run view 41169204921 --repo UK-AQ/uk-aq-ops --log > "$EVIDENCE_DIR/backup-v3-20261031.log"
gh run download 41169204921 --repo UK-AQ/uk-aq-ops --dir "$EVIDENCE_DIR/backup-artifacts-20261031"
gh run download 41160319017 --repo UK-AQ/uk-aq-ops --dir "$EVIDENCE_DIR/prune-artifacts-20261031"
gh run download 41167821102 --repo UK-AQ/uk-aq-ops --dir "$EVIDENCE_DIR/core-artifacts-20261031"
gh run list --repo UK-AQ/uk-aq-ops --workflow uk_aq_r2_history_dropbox_backup.yml --limit 50 --json databaseId,headSha,status,conclusion,createdAt,url > "$EVIDENCE_DIR/backup-run-history.json"
gh run view 41054421875 --repo UK-AQ/uk-aq-ops --log > "$EVIDENCE_DIR/scheduler-config-sync.log"
```

Read the artifacts locally; preserve exact file sizes/SHA-256 plus GitHub artifact identity/digest. Find the **first** genuinely complete post-v3 backup and its acceptance package, including any local supervised backup rather than assuming it was a GitHub run. Supply the pre-first-delete closure record with actual recorded UTC, migration run `live-v3-20261015T114250Z-e84f52a`, first backup identity and operator decision. If absent, report that absence candidly and resolve acceptance prospectively without fabricating a timestamp.

From existing local LIVE installation, collect without executing jobs:

```bash
launchctl list > "$EVIDENCE_DIR/launchctl-list.txt"
crontab -l > "$EVIDENCE_DIR/crontab.txt"
```

Identify relevant labels first; then `launchctl print gui/$(id -u)/<exact-label>` and `plutil -p <exact-existing-plist>` are read-only inspections. Review/redact arguments/environment before sharing; never collect secret env files. Return installed launcher/implementation path, file SHA-256/Git revision, fixed generation, schedules and existing latest successful LIVE Integrity/SOS-light summary/recovery reports. Enumerate manual v2 builders/reconcilers/rollback entry points and their operator ownership/exclusion.

For fresh service authority, GET the existing authenticated `/v1/history-generation` endpoint using the operator's existing secret-safe client. Return timestamp, HTTP status and generation/prefix descriptor with credentials removed. Inspect existing Worker deployment/version metadata and LIVE scheduler D1 rows with GET/read-only SELECT through the approved operator tools. No deploy, configuration sync, lock acquisition, scheduler action or workflow launch is part of evidence collection.

The acceptance package needs exact enabled jobs, duplicate/queued/running operations, last accepted writer/backup roots, deployed reader/binding generation, installed Integrity evidence and resolution of today's reported Phase A mismatch. A website chart alone cannot satisfy these requirements.

## Recommended future retirement sequence — separate TEST-first project

This section is a proposal for a future operator-controlled change. It authorises no mutation now.

1. **Complete evidence and policy acceptance.** Resolve each C item; accept the actual rollback-closure record and current complete v3 backup, authenticate retained v2 coverage, define recovery limitations and approve any historical Core/binding/evidence disposition. Resolve active staging and manual/installed v2 writer dependencies in a separately reviewed TEST-first change if needed. Do not require the specifically waived redundant full-archive post-write verifier merely because it is available.
2. **Define immutable scope.** Generate a disjoint per-key allowlist only from approved A categories. Pin account/bucket, capture interval, exact count/bytes, key/body identities and manifest file SHA-256. Explicitly exclude B/C, v3 and its index, all backup-format-v2/current control, active staging, generation-v3 packs, shared/migration evidence and every Dropbox object. Parent-prefix or substring selection is unacceptable.
3. **Preserve recovery independently.** Establish an operator-owned retention hold and authenticated historical v2 baseline/state/evidence, with a copy safe from normal sync/cleanup if required. Accept a documented rebuild/restore method and its limitations. Do not claim the old v2 restores observations first archived/deleted after cut-over or that generic restore is complete.
4. **Develop and accept the future implementation in TEST.** Separately design bounded identity checks, operator controls, lock/exclusion integration, resume journal, stop conditions and verification. Use a representative isolated TEST scope and actual TEST acceptance under the then-current contracts. This investigation adds none of that implementation.
5. **Protect the LIVE execution window.** The operator separately approves exact manifest digest, recovery disposition, TEST acceptance and window. Use an accepted exclusion mechanism covering Prune, Core/bindings, backup, Integrity, legacy/manual writers and relevant maintenance. Read-only inventory cannot itself establish this freeze. Shared locks may not cover all out-of-repository/non-participating tools; explicitly account for them. Do not change LIVE application code.
6. **Final read-only revalidation immediately before deletion.** Recheck account/bucket, immutable manifest digest/count/bytes, object identities, absence of new keys/writes, deployed v3 configuration, last writer/backup and pinned Dropbox state/retention. Re-list B/exclusions as necessary. Any change, missing object, stale backup, unknown reference or inability to exclude a writer stops approval; no silent manifest expansion.
7. **Operator executes bounded resumable retirement.** Future accepted tooling must process only approved immutable entries in bounded batches and journal attempts/results durably outside the retiring scope. Retry only unchanged approved identities, stop on mismatch/unexpected scope or operational error, and reconcile ambiguous outcomes by read-only inspection before resumption. Specify service-specific conditional-operation support and remaining race limits during TEST design. Never restore a broad recursive operation as a fallback.
8. **Post-deletion verification and records.** Obtain exact residual inventory and actual saved bytes, verify every exclusion remains, then perform bounded v3 reader/station-history checks and verify accepted Prune/Core/Integrity/backup operation under their respective operator-approved procedures. Record partial failures and current recovery limits, retained Dropbox/evidence URI/digests, operator identity/approval, execution time, batch journal and acceptance outcome. Do not automatically restore old v2 into active v3 authority on failure. Resume excluded operations only under their accepted release procedure.

## Evidence required before separate deletion approval

- Exact, paginated, stable LIVE R2 per-key inventory and reconciled A/B/C counts/bytes; unexpected objects resolved.
- Current authenticated retained Dropbox v2 payload, state/shards, historical inventory evidence and scope comparison; approved derived-index recovery/rebuild limitations.
- Durable rollback-window closure evidence and identification/operator acceptance of the first complete post-v3 backup; current backup root verification.
- Fresh deployed v3 reader/writer/binding/Core authority and scheduler inventory; successful installed LIVE Integrity/SOS-light evidence or an explicit accepted inactive status.
- Active staging overlap and every manual/installed legacy writer/recovery reference disposed of; no assumption that repository retirement disables local launchd.
- Explicit Dropbox retention safeguards and historical Core/binding/evidence disposition; no current contract silently weakened.
- Separate accepted TEST retirement implementation and immutable per-key scope/digest; operator execution/approval gates and final revalidation.

**Recommendation: blocked pending further evidence.** The recent v3 operational progress is real and materially reduces uncertainty, but no obsolete-v2 namespace is ready for separate deletion approval on the evidence available here.
