# Frozen SOS-light v2 implementation snapshot

Repository files only: **not deployed, not operationally accepted, not promoted to LIVE**.

This is implementation documentation. The authoritative behaviour remains in
[the SOS-light stable fallback contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/r2_history/sos_light_stable_fallback_contract.md),
the three-phase authority/model, core-snapshot, source-acquisition and Integrity
safety contracts selected by the system-docs router. This README does not replace
or amend those contracts.

## Snapshot provenance

- Source repository: `TEST-uk-aq/uk-aq-ops`.
- Source commit: `34709a077f6732b8eb0cf590c8cea795ea4ea13a`.
- Snapshot date: **9 October 2026**.
- Updated authoritative fallback contract Git blob: `7d3191df30841657b2f205b712beb9053e533edd`.
- The local docs checkout at `17f37d09fca9e4f304df9a8e5625098102c9190b`
  predates the update. The amended contract and router were read through read-only
  GitHub access. No system-documentation files were changed.

| Original TEST file | Git blob | Source SHA-256 |
| --- | --- | --- |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` | `82ac7ac1b27c2d657c69658955b24be1a6403ea2` | `a783d9ddeacef1d71e9bd7ee6f3a51ebe7ab7b049cc119b7f120523fa9067708` |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v2.sh` | `8a4087dd7796c4699b0512d44f4e2231e333f265` | `d2536f2eb1cdb222be8a2c64b153a0715f520681294d1c29cb47c131716a4ad0` |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py` | `fdd060cbef2a07451afd837f22a4cbe76895d953` | `ac0d51108dcbed2e2d2244c895317bb3625fc770d92ce27cb08a3a2fbbc526b0` |

The frozen `_impl.py` is byte-for-byte identical to the current TEST source. It
includes the existing fixed-v2 staging/fingerprint and pre-mutation lock-recovery
implementation; copying it does not establish acceptance of those features.
The source already includes dormant non-SOS branches and unconditional imports
of official-network modules. These were not developed or extended here. The
frozen entrypoint and runners reject non-SOS selection, so those adapters are
not supported by this fallback.

The Python entrypoint retains the original progress, Finder-file filtering and
reporting overlays. Its edits select the frozen sibling implementation, restrict
source/generation selection, reassert the frozen repair bridge after normal
configuration loading, and relocate the local Latest Snapshot policy adapter.
The runner changes only stable paths/identity and strict generation/source
selection. The copied bridge keeps its recognised basename and existing repair
flow, with strict fixed-v2/SOS selection and frozen/self/normal nested-path checks.

## Frozen executable boundary

All 18 executable source files below belong to this frozen v2 snapshot.
`daily_profile.py` and the required `integrity/` Python import closure are copied
at the same directory depth as their originals. All those helpers are
byte-identical, including the two import-only official-network modules required
by the unchanged source. There is no import fallback to active `bin/` helpers.
The two copied `.mjs` adapters keep their original shared owner-policy/hash
imports; relative paths still resolve to the selected repository.

`uk_aq_integrity_backfill.sh` is frozen locally. Its basename must remain exactly
that name: the coordinator recognises it when building child arguments and
checking capabilities. It reloads the normal root `.env`, preserves the original
pinned core/source-evidence payloads, and reasserts its frozen path and fixed
selectors afterwards. Its nested `UK_AQ_BACKFILL_WRAPPER` must resolve to the
protected selected-repository `scripts/uk_aq_backfill_local.sh`, never an active
Integrity coordinator, another repository or an archive.

| Frozen file relative to this directory | SHA-256 |
| --- | --- |
| `daily_profile.py` | `ebccf363455b1c25c852453d49f74a5831ed9f9768836fec4661f418049e503c` |
| `integrity/__init__.py` | `ece815cc24624943d8feba0274588998fe809f9448bb5bd005140ae70b90a384` |
| `integrity/current_state/__init__.py` | `b02ca5a89453f36bf8141156438d6de21cd2fcfa62b8bf70cb687bd22589554c` |
| `integrity/current_state/audit.py` | `003474b9d3e04331448143613ee8c361068b467d3431b60a57d11d4dc0a9af45` |
| `integrity/current_state/auth.py` | `a6088929927e91ffaf36fabb37d2b808860541ad39cd94cc8b2442ffcc070cc0` |
| `integrity/current_state/latest_snapshot_policy.mjs` | `8a4fc86e5dc06b55fb06af0d9887eb66cd79b20dba57e945b0c40f792c53a462` |
| `integrity/history_cache.py` | `75c8344f5a4cfd57953c2044a643605629159515544e6f08459b74e4475ed6ed` |
| `integrity/history_cache_rows.mjs` | `2184b242b74f61813eee6920b722ad3dd752cc2bc4858f0923dfa859e93777ef` |
| `integrity/official_network_rdata.py` | `6fabc1cc7252fdc35aad278584e1ea255fa0948dbc87c5d22b167e8787883ca4` |
| `integrity/official_network_rdata_timestamp_authority.py` | `132fecf461ec063bff34ff7328d547fc76b615b51229bfb57e8fbb6958ee684a` |
| `integrity/repair/__init__.py` | `8cc4a55ab4adaa78f589275461ee197577882d4ccdc37647669614668b120644` |
| `integrity/repair/decisions.py` | `ff2b0a6f2a1293442fa3e24c36ef66ea87d01233e25e7eeef1ffcf85f8b19e2d` |
| `integrity/runtime.py` | `3e397f8a1bbe98fb5d7e43f2276f350e0b3b87504628157be38545f69cb5b434` |
| `integrity/timeseries_binding_provider.py` | `4902f7455416c5c55aa38ca3080798a3ffe974a330844dc25512e26664925413` |
| `uk-aq-history-integrity-sos-light-stable-v2.py` | `803a97e8aaa96a9bfb725365810cfa5828657c976edd6c1411190a629e764521` |
| `uk-aq-history-integrity-sos-light-stable-v2.sh` | `85f10f6e3ee075cdb645a85a4876274a0228eab6cc00ec0eee5964e2ae9b8986` |
| `uk-aq-history-integrity-sos-light-stable-v2_impl.py` | `ac0d51108dcbed2e2d2244c895317bb3625fc770d92ce27cb08a3a2fbbc526b0` |
| `uk_aq_integrity_backfill.sh` | `e1e2e860a23ff9299aeeb349eca80c06ce0afc6c1e87e2d9a08e63f799976356` |

[`snapshot-manifest.json`](snapshot-manifest.json) records the source path, source
Git blob, source SHA-256, frozen identity and byte-comparison result for each
file, plus the separate launcher's identity and preserved v3 identities.
Documentation and the manifest itself are excluded from the executable hash list
to avoid self-referential hashes.

## Deliberately shared dependencies

This is not a standalone runtime bundle. It requires a complete compatible ops
checkout and the existing configuration/resources. The manifest identifies **72
shared files**, their exact Git blobs and SHA-256 values, roles and import parents.
That list includes the static/dynamic literal import closure, the lock child
supervisor, the configured nested launcher/worker, normal package locks and the
cache configuration. Import-only AQI/v3 modules are listed because the existing
shared worker imports them, not because this fallback executes those modes.

| Protected shared entry point | Role and required protection |
| --- | --- |
| `scripts/uk_aq_backfill_local.sh` -> `workers/uk_aq_backfill_local/run_job.ts` | Existing SOS acquisition, detector and independent proposal worker. Preserve connector `1`, `source_to_r2`, `observations_only`, one complete-range acquisition, pinned core/source evidence, fixed-v2 serialization and no nested full index rebuild. |
| `workers/uk_aq_backfill_local/uk_air_timestamp.mjs` | Shared hour-ending UTC normalization; changing it changes source scope, rows and hashes. |
| `workers/shared/uk_aq_observation_content_hash.mjs` and canonical schema/writer modules | Single canonical normalization, `verification_status`, hashing, Parquet and manifest authority; do not fork this algorithm. |
| `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` | v2 metadata/index proposal from the authenticated Dropbox baseline plus overlay; preserve `_index_v2`, deterministic bytes and no pre-APPLY live-body discovery. |
| `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs` and its validation/finalizer helpers | Independent frozen-state/fingerprint/body validation, complete-day deletion, ordered publication, journals, read-back/semantic checks and final verification. |
| `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs` | Existing v2 helper retained for the source's check/dry-run/generic SOS paths; preserve its core identity and mutation allowlist. |
| `scripts/operations/uk_aq_with_observations_global_operation_lock.mjs` and its supervisor/recovery helpers | Original global advisory-lock ownership/recovery and re-entry into this frozen entrypoint; never redirect re-entry to active Python. |
| `scripts/backup_r2/uk_aq_check_integrity_ingest_boundary.mjs` | Full request boundary check for connector `1`; no clipping or partial continuation. |
| `scripts/backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs` and backup/checkpoint helpers | Same accepted backup/writer/root/core authority, exact generation, fail-closed local materialisation and original recovery evidence. |
| `workers/uk_aq_latest_snapshot_cloud_run/latest_value_policy.mjs` | Existing owner policy reached through the copied local policy adapter; preserve eligibility and O3 exclusion from Latest Snapshot. |
| `config/uk_aq_history_cache.json` and the frozen cache adapter's shared canonical hash import | Current TEST cache event format/limits and existing post-lock delivery behaviour; do not confuse this new v2 snapshot with the older frozen v3, which lacks that newer stage. |
| `package.json`, `package-lock.json`, `deno.lock`, `requirements-dev.txt` | Existing dependency declarations/locks; ensure the normal operational interpreters and installed packages remain compatible. |

All listed shared files and their transitive imports are **protected interfaces**
under the authoritative stable-fallback contract. Future WAQN/SAQN work must be
added alongside the established SOS path. Compare manifest identities before
changing or deploying shared code. If a shared SOS dependency must change its
semantics, stop and reconsider the contract/fallback boundary first. Hashes are
review/compatibility evidence, not a newly added runtime gate. Keeping shared code
therefore remains a compatibility limitation; this snapshot does not promise
independence from arbitrary future changes elsewhere in ops.

No active v2/v3 Python coordinator is imported or called. No archived code is an
executable dependency. The shared Deno source worker and canonical Node mutation
helpers remain explicit protected dependencies.

## Fixed selection, environment and safety

The runner pins all three existing markers to `v2`:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_R2_HISTORY_INDEX_VERSION=v2
UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2
```

Conflicting inherited/root-`.env` selectors, noncanonical v2 core/observation/index
prefix overrides, non-SOS CLI sources and broader connector/protected-source
selection fail closed. `--history-version` can only restate `v2`; it cannot switch
generation. The existing canonical layout remains `history/v2/observations`,
`history/v2/core` and `history/_index_v2`. This fallback never selects v3 or an
active coordinator automatically after a failure.

Only SOS connector `1` is selected for acquisition/repair. This does not remove
other-connector preservation from the accepted Dropbox baseline: complete selected
days are assembled, validated, deleted and republished using the existing v2
semantics. No WAQN/SAQN/other connector is acquired or independently repaired.

The normal selected repository root `.env` still owns credentials, bucket names,
Dropbox roots and operational paths. The frozen code uses the same local SQLite,
source cache, accepted Dropbox history, reports/logs and R2 authority as active
Integrity; none is copied or separated by this snapshot.

The unchanged coordinator keeps the shared database-local advisory lock identity:

```text
uk_aq:r2_history:v2:observations_global_operation
```

The shell retains the same per-environment local
`state/<ENV>/locks/uk-aq-history-integrity.lock`. Frozen and active Integrity must
not overlap against the same environment. Existing Step 0 ordering, backup
currentness, live-root equality, pinned core/source identity, complete proposal,
pre-mutation recovery rules, staging/fingerprint gates, APPLY ordering, journals,
semantic/final verification and downstream reconciliation remain in their owners.
Creating the snapshot changes none of their algorithms or operational acceptance
requirements. `--allow-stale-dropbox` is not a recovery shortcut past SOS-light
Step 0 or recovery authority revalidation.

## Launcher and v3 relocation

Separate repository-owned v2 launcher:

```text
scripts/uk-aq-history-integrity/deploy-bin/
uk-aq-history-integrity-sos-light-stable-local-wrapper-v2.sh
```

It parses the existing environment selector for only `UK_AQ_OPS_REPO_ROOT` and
invokes this directory's `uk-aq-history-integrity-sos-light-stable-v2.sh` directly.
Normal local v2/v3 launchers and launchd schedules are unchanged. No launcher was
installed and no new monthly launcher was created.

The existing frozen v3 moved to `../stable-sos-light-v3/`. Both v3 Python files
retain their pre-relocation bytes; its shell and stable local wrapper change only
the required directory path. Its fixed-v3 algorithm and shared dependency boundary
remain unchanged and never use this v2 snapshot. Existing stable monthly scripts
already invoke the stable-v3 wrapper by its unchanged deployed filename, so their
source selection, backup chain, locks, state roots, logs, receipts and schedules
remain byte-for-byte unchanged. Pre-edit runner/wrapper copies under
`archive/2026-10-09/` are reference/rollback only.

External MacBook Pro deployment work remains separate:

- Later install the new v2 wrapper alongside normal wrappers under
  `/Users/mikehinford/uk-aq-history-integrity/bin/` if explicitly authorised.
- Later replace the deployed
  `/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-stable-local-wrapper-v3.sh`
  with the reviewed repository version so it resolves `stable-sos-light-v3/`.
- Keep the existing `env/TEST.env` / `env/LIVE.env` repository selectors. Any
  separately maintained direct path into the former unversioned stable directory
  also needs a manual path update. External files were not inspected or changed.
- Existing monthly dispatcher filenames and state paths stay unchanged; no
  launchd job needs a schedule change because of this rename.

## Runtime compatibility and structural evidence

The unchanged current TEST v2 source uses `_SosLightV2ProposalStaging` in a type
annotation at `_impl.py:18449` before its class definition at line 22222. Import
fails on this workspace's Python **3.12.14** with `NameError`. The frozen entrypoint
and all imported helpers passed an import-only check on Python **3.14.7**, which
provides deferred annotations. Use a compatible **Python 3.14+ repository
`.venv/bin/python`** for this snapshot; lower-version compatibility would require
a separately authorised source/loader correction and a deliberate snapshot refresh.
No operational venv was created or changed here; the temporary validation
interpreter resides outside the repository.

Other requirements: Node **>=20**, normal Deno, lazy Python `duckdb`, the shared
repository's locked Node dependencies and a complete normal environment. Locked
Node versions audited: `apache-arrow=21.1.0`, `hyparquet=1.25.1`,
`hyparquet-compressors=1.1.1`, `parquet-wasm=0.7.1`, `pg=8.19.0`. The existing
Latest Snapshot authentication mode may require `gcloud`; the existing static
token mode remains available. Backup utilities transitively import `rclone`
support; no backup was invoked during this task. Native R/Rscript is not used by
this SOS-only fallback despite the mandatory dormant official-network imports.

Local structural checks completed:

- Bash syntax on the two v2 shells, relocated v3 shell, both stable wrappers and
  existing stable monthly launchers (7 files).
- Python compilation on the v2 import closure/entrypoint/implementation and both
  relocated v3 Python files (16 files).
- Python 3.14.7 import/path checks with subprocess and network operations forbidden;
  every `daily_profile`/`integrity` import resolves under this frozen directory.
- Frozen sibling loading, same-depth repository/config/Node adapter resolution,
  frozen bridge basename/path, global-lock frozen-entrypoint re-entry inspection.
- Fixed-v2 generation/prefix and non-SOS selection rejection checks; v2 index
  layout resolution.
- Byte identity for the frozen v2 implementation, 12 Python helpers and 2 Node
  adapters; source identities and shared dependency reference closure recorded.
- Exact v3 Python preservation and path-only v3 shell/wrapper differences;
  old executable-directory references removed outside historical archive copies.
- Active `bin/` files, normal v2/v3 wrappers, stable and normal monthly launchers,
  authoritative docs, schedules and Git index preserved.

Compilation/import/reference checks are not functional acceptance. No Integrity
`main`, backfill, repair, remote mutation, SQL or operational workflow was run.
This cloud workspace has no normal repository `.venv` or Deno executable and is
not the dedicated operational Dropbox host.

## Operational acceptance and future promotion

Before any operational use, an operator must independently provide the compatible
normal repository runtime and a compatible fixed-v2 TEST environment with a fully
materialised accepted v2 Dropbox baseline/core, correct selected environment,
normal credentials/state and matching R2 generation. Do not point v2 at current
TEST v3 R2 authority to claim acceptance. Compare all frozen identities and review
shared dependencies against the manifest; changes need deliberate compatibility
review rather than an assumption that `index_v2` implies identical implementation.

After separately authorised deployment, real bounded TEST operation must exercise
the **stable v2 local wrapper -> stable v2 shell -> frozen entrypoint -> frozen
bridge -> protected shared helpers**, including currentness/locking, SOS source
identity, proposal gates, complete-day preservation, APPLY verification, independent
current-state/cache outcomes and required subsequent backup/materialisation.
The fixed-v2 hardening/recovery acceptance amendments also remain applicable where
those existing source features are selected. V3 requires its own compatible TEST
acceptance through the relocated stable-v3 route.

Only after compatible TEST acceptance and explicit later promotion authority may
this frozen v2 snapshot and launcher be copied unchanged from TEST to LIVE.
Compare installed identities and actual LIVE layout/runtime compatibility during
that separate task. No LIVE repository was accessed here. Neither this README nor
snapshot creation authorises promotion, deployment or execution.

## Recovery and rollback

For a configuration or pre-APPLY failure, stop and resolve the matching normal
runtime/currentness/materialisation prerequisite. Do not delete operational SQLite,
source evidence, Dropbox backups or R2 data to make the fallback start. A stale
local shell lock requires the existing operator investigation; do not remove a
lock belonging to a running process.

Existing fixed-v2 pre-mutation lock recovery remains bounded and requires exact
original authority revalidation. After mutation starts, preserve the run state,
journal and evidence and follow the authoritative recovery route; do not resume
an interrupted APPLY under a newly assumed lock or use stale-backup bypass.
A fresh run must satisfy the owning currentness/core/source gates again.

Repository-only rollback can remove this new v2 directory and its separate wrapper,
move the unchanged v3 Python files back, restore the single old-directory path in
the v3 runner/wrapper, and restore the path mention in the implementation note.
The exact pre-edit v3 shells are available in the dated archive as reference;
restore them to executable paths rather than executing archive content. Keep
unrelated work and all operational state intact. A later deployed rollback needs
its own operator authorisation and compatible matching-generation dispatcher;
do not silently switch generations. Repository rollback cannot undo a completed
repair or deployment.

## System-documentation handover

Chat-mode documentation ownership should update the fallback contract/router's
repository implementation status after review, record this 18-file v2 executable
boundary plus protected shared dependencies and Python 3.14+ compatibility
limitation, and keep deployment/operational acceptance explicitly pending. The
versioned layout is already authorised by the updated contract; no new layout or
behaviour contract is required to create these files. Genuine lower-Python
compatibility work would need a separate agreed change rather than editing the
frozen implementation opportunistically. System docs remain unchanged by this task.
