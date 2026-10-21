# Shared packed-binding backup promotion review

This is implementation/review evidence, not a replacement system contract. The
active backup, packed-binding, generation-namespace and global-exclusion contracts
in `TEST-uk-aq-system-docs/system_docs/` remain authoritative.

## Change and scope

The pack publisher and Dropbox destination guard now use the invocation's explicit
configuration instead of literal TEST bucket/destination allow-lists. The normal
locked sequence remains publisher, inventory, copy/verification, then checkpoint
publication. The workflow retains its 345-minute timeout, TEST's `pack` default,
explicit `individual` selection, normal full backup scope and strict task health.

The runner now forwards `--dry-run` to the inventory builder as well as the
publisher and sync. A dry-run against a source with no published packs still fails
closed at inventory selection: the producer's in-memory dry-run result is not
published backup authority. Use the first real authorised TEST backup to create
missing packs; do not weaken inventory validation to make that dry-run green.

No canonical observation processing or JSONgen implementation is changed. No
individual binding object, old Dropbox payload, old checkpoint shard or historical
pack object is deleted. Only derivative pack/inventory products and the ordinary
Dropbox checkpoint publication are in the existing backup mutation path.

## Files changed in this PR

Active implementation/workflow:

```text
.github/workflows/uk_aq_r2_history_dropbox_backup.yml
scripts/backup_r2/publish_timeseries_binding_backup_packs.mjs
scripts/backup_r2/lib/history_backup_targets.mjs (new)
scripts/backup_r2/lib/timeseries_binding_pack_restore_v1.mjs
scripts/backup_r2/lib/timeseries_binding_pack_inventory_v1.mjs
scripts/backup_r2/uk_aq_run_locked_history_backup.mjs
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs
```

The existing checks updated for removed TEST exports, explicit fixture
configuration, the shared restore-confirmation flag and dry-run propagation are
`tests/timeseries_binding_pack_backup_phase2.test.mjs` and
`tests/timeseries_binding_pack_restore_phase4.test.mjs`. A targeted credential-guard
regression file is added at `tests/history_backup_targets.test.mjs`. This review document is
`scripts/backup_r2/README.shared_binding_pack_promotion.md`.

The original seven pre-change code/workflow copies under `archive/2026-10-21/`
remain untouched. This safety follow-up adds exact snapshots of
`lib/history_backup_targets.mjs` and `lib/timeseries_binding_pack_restore_v1.mjs`
beneath that date's `scripts/backup_r2/` subtree. Today's existing restore-CLI
archive is reused under the once-per-file-per-day rule. All nine snapshots are
reference-only, must never be executed by active paths and are excluded from the
future LIVE promotion set.

## External configuration and identity guards

No new external environment key or secret is introduced. The workflow requires
explicit nonempty `UK_AQ_DROPBOX_ROOT` and `UK_AQ_R2_HISTORY_DROPBOX_DIR`; both
previous fallback values are removed. The existing GitHub target catalogue already
maps these to repository variables. The ignored local `env-vars-master.csv` has
been aligned with the existing backup-directory key; it must not be published
because it contains environment credentials. This task does not sync any values.

The shared configuration resolver requires one complete existing family:

```text
CFLARE_R2_ENDPOINT, CFLARE_R2_BUCKET,
CFLARE_R2_ACCESS_KEY_ID, CFLARE_R2_SECRET_ACCESS_KEY
```

The existing complete `R2_*` family is also accepted for direct CLI use. Partial
families are never combined. If both families supply a key, contradictory values
fail, including region and endpoint. Region defaults to `auto`. Endpoints must be
HTTPS origins; bucket values must be plain bucket names. No environment name is
inferred from a bucket or a repository name.

Normal source/destination arguments must exactly equal:

```text
uk_aq_r2:<configured bucket>
uk_aq_dropbox:<configured Dropbox root>/<configured backup directory>
```

Leading/trailing slashes in the two configured Dropbox folder values are
normalised. Empty folders, traversal, remote syntax, backslashes and control
characters fail. The remote names are the existing environment-neutral workflow
names; older local `uk_aq_r2_test`/other aliases are no longer accepted by these
guarded entrypoints. An isolated Dropbox proving destination must be selected by
explicit invocation-scoped folder configuration, not by a built-in TEST exception.

Before the normal runner can publish anything, local `rclone config dump` checks:

- `uk_aq_r2` is explicit Cloudflare S3, with the configured endpoint, access-key
  ID and region, the exact configured secret, and no environment-auth fallback; only the workflow's
  S3 config fields are allowed, excluding `download_url` and other read redirects;
- `uk_aq_dropbox` is Dropbox with the configured `DROPBOX_APP_KEY`, a client
  secret matching `DROPBOX_APP_SECRET` exactly and the configured
  `DROPBOX_REFRESH_TOKEN` in its token;
- Dropbox remote fields outside `type`, `client_id`, `client_secret`, `token`
  are refused, including namespace/account/path redirects;
- `RCLONE_*` overrides except `RCLONE_CONFIG` are refused, so inspected config
  cannot be superseded by remote/backend overrides.

### Exact secrets and rclone obscuring

The guard uses the same configured R2 secret and `DROPBOX_APP_SECRET` as the
workflow. It compares exact UTF-8 credential bytes using `timingSafeEqual`, clears
the comparison buffers and emits only fixed diagnostics. Missing or contradictory
secrets fail before a normal runner can publish R2 packs, and every direct
inventory/sync/publisher/restore CLI applies its transport guard before mutation.
No secret, dump, decoded value or signed request is written to diagnostics or
new credential files.

Rclone obscures **password options**, not every sensitive option. Investigation
of installed rclone `v1.75.2` and its upstream source established that S3
`secret_access_key` and OAuth `client_secret` are sensitive plain-string options
(`IsPassword=false`). S3 and OAuth consume these option values literally;
`config dump` preserves the stored strings. The existing GitHub Actions config
therefore uses their correct plain representation.

The guard inspects the installed binary's local `config providers` schema and
requires that exact representation before inspecting the config. An unknown,
missing, ambiguous or password-encoded option schema fails closed. It does not
assume that every dump value is plain or auto-decode obscured-looking text:
accepting its decoded value would approve a different secret from the one these
backends actually consume. Putting `rclone obscure` output into either field is
rejected unless that literal text itself is the configured credential. Configured
secrets are expected to be actual service credentials, not already obscured values.
There is no decoded-secret persistence or new encoding selector. A future rclone
representation change requires a separate reviewed compatibility update.

Primary representation references:
[Rclone S3 options](https://github.com/rclone/rclone/blob/v1.75.2/backend/s3/s3.go),
[OAuth options/credential consumption](https://github.com/rclone/rclone/blob/v1.75.2/lib/oauthutil/oauthutil.go),
[config dump](https://github.com/rclone/rclone/blob/v1.75.2/fs/config/config.go),
[obscuring format](https://github.com/rclone/rclone/blob/v1.75.2/fs/config/obscure/obscure.go).

Each local config/provider inspection is bounded to 15 seconds and never logs config dump output
or subprocess diagnostics containing credentials. It performs no remote reads.
Inventory, sync and write-enabled publication also enforce their entrypoint
guards when invoked directly. The workflow generates both remotes from its
configured variables/secrets. Operators must supply a matching dedicated config
when using a CLI locally; an ambient unrelated rclone config is not sufficient.

The retained PostgreSQL global operation lock still spans publisher, inventory,
copy, verification and checkpoint publication. Direct publisher writes now require
the same coordinator context with owner `r2_history_dropbox_backup`, plus
`--write-r2` and an exact `--source-root`. Config validation cannot establish that
an operator has selected the correct database credentials for an environment;
the repository's DB/R2/Dropbox values must be reviewed together before promotion.

## Generation, first backup and recovery evidence

The shared generation mapping is unchanged:

```text
v2 packs: history/_backup_packs_v1/timeseries_binding/
v3 packs: history/_backup_packs_v1/timeseries_binding/generation=v3/

state: _ops/checkpoints/r2_history_backup_state_v2/observation_generation=<v2|v3>/
```

Contradictory explicit prefixes fail. v3 publication cannot replace the mutable
v2 pack root. Canonical individual bindings remain at the generation-selected
`history/_index_<v2|v3>/timeseries_binding/timeseries_id=<id>.json` paths with their
original bytes and semantics. Runtime consumers remain individual-file readers.

No one-off individual-to-pack migration is needed. On a first real packed backup,
the publisher reads the complete authoritative binding source hierarchy, creates
missing deterministic closed-set packs, verifies every written pack and publishes
the pack root last. Inventory authenticates that root against the source root.
Sync then copies/verifies the referenced packs and publishes separate
`timeseries_binding_packs` range and root evidence. Existing individual
`processed_source_range_hash` evidence never proves a pack exists in Dropbox.
The unchanged-root fast path remains in the existing pack sync implementation.

This statement concerns switching binding representation within an already valid
selected generation. It does not waive a separate v2-to-v3 source/checkpoint
cut-over prerequisite or create permission to migrate old checkpoint layouts.

## Restore review

The restore still authenticates generation-scoped checkpoints, pack roots, child
hashes/sizes and every decoded member before writing. It retains exact-byte
readback, reconstructed range manifests and source-root-last publication. It
restores the complete physical set, not only SOS bindings; source-state, inventory
and checkpoint control files are not pack-authorised restore payload.

Writes require all of:

```text
--write-r2
--expected-source-root-sha256 <accepted source identity>
--expected-pack-root-sha256 <accepted pack identity>
--confirm-isolated-dest-root <exact --dest-root>
```

The source must be the exact configured Dropbox backup. The destination must use
the inspected `uk_aq_r2` remote and the bucket name:

```text
<configured active bucket>-timeseries-binding-restore-<isolated run id>
```

The resulting bucket must fit the bucket-name length limit. The configured active
bucket and arbitrary buckets/remotes cannot pass this guard. Normal active
production restore is deliberately unsupported. An independently provisioned,
isolated recovery bucket and write-scoped credentials are operational
prerequisites; this tool neither creates a bucket nor redirects the active system.

Write execution must be wrapped in the existing global lock coordinator with
owner `timeseries_binding_pack_restore`. The old
`--confirm-isolated-test-dest-root` flag is replaced by the shared flag above.
Dry-run remains the default, requires the configured source, authenticates the
complete generation and writes no destination objects. No restore was performed.

### Empty destination, reservation and safe resume

After **all** source packs/members/checkpoints and the reconstructed source root
have passed verification, the write path establishes destination admission:

1. Read `_ops/restores/timeseries_binding_pack_restore_v1/reservation.json`.
   If absent, a strict R2 bucket listing with `max-keys=1` must prove emptiness.
   A nonempty or uninspectable bucket is rejected without any write.
2. Create that immutable reservation with `If-None-Match: *` and verify its exact
   bytes. It binds source/destination roots, generation, both expected root pins,
   object count and the SHA-256 of the exact payload descriptor set. A second
   `max-keys=2` probe permits only that reservation, detecting a foreign object
   introduced during the emptiness/reservation window. The reservation contains
   no credentials and is separate recovery evidence, not backup completion state.
3. On resume, require the exact same reservation bytes. Walk the whole bucket
   once, bounded by the authenticated payload count plus the reservation plus one
   unexpected key, in pages of at most 1,000. Every existing key must belong to
   the reserved set and match its expected size and exact bytes/SHA-256 before
   any new write. Unknown keys, missing reservation, conflicting pins, corrupt
   content, malformed/repeated pagination or a root with missing children fail.
4. Reuse only exact verified existing payload, and create only missing members,
   then range manifests, then the source root. Reused children are readback-checked
   again in the ordinary verification sequence. Immediately before root
   publication, one final bounded metadata listing requires the exact expected
   key/size set; unrelated or missing keys prevent root publication. Resume
   therefore performs one initial exact-byte admission pass plus this final
   metadata-only pass; the final listing itself does not reread object bodies.
   Resume does recheck existing payload bytes during both admission and ordinary
   readback, trading additional recovery-only reads for strict verification.
   A completed exact destination
   returns with `source_root_reused=true` and performs no new root publication.

All destination PUTs, including the reservation and source root, are signed
**create-only** S3 requests with `If-None-Match: *`. An object appearing between
inspection and creation cannot be overwritten. There is no unconditional PUT,
`rclone copyto` fallback or automatic write retry after a conflict/ambiguous
transport outcome. Rerunning the identical pinned restore re-verifies durable
bytes, including a write that committed just before interruption but whose
readback was never observed. Conditional semantics are documented by
[Cloudflare's R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/).

The gate adds only this one reservation object in the explicitly isolated
recovery bucket. It does not change canonical binding payload paths, back up
control products, alter Dropbox checkpoints or delete anything. Dry-run remains
source-only: no destination listing, reservation or destination writes.

Residual operational limits: use a dedicated recovery bucket with no unrelated
writers and appropriately scoped credentials. The PostgreSQL lock coordinates
participating operations, not arbitrary external clients. Create-only requests
prevent this tool overwriting concurrent objects but cannot stop another client
adding, modifying or deleting objects after inspection. A pre-existing restore
from older code without a reservation is intentionally not adopted; preserve it
and use a separately provisioned empty recovery bucket. Mismatched or corrupt
reserved destinations also require operator review; the tool never cleans them.

## LIVE compatibility and exact complete-file promotion set

Read-only baseline: `UK-AQ/uk-aq-ops` commit
`87d09e4a4b74e5f4d4b02505ef3fbe35dfdf7523`. GitHub metadata for the in-progress
backup run `39596172952` identifies that same `head_sha`. Its workflow uses
individual mode by default and a 345-minute timeout. This is a pinned source
comparison, not acceptance of that still-running backup or a database-state audit.

After this PR is reviewed, deployed and operationally accepted on TEST, the exact
complete implementation files needed against that pinned LIVE baseline are:

| Complete file | Why it must travel |
| --- | --- |
| `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | Shared configuration, pack default, matching runner arguments, reports, existing strict task health and bounded audit input |
| `scripts/backup_r2/publish_timeseries_binding_backup_packs.mjs` | Shared source guard and locked publication |
| `scripts/backup_r2/lib/history_backup_targets.mjs` | New shared configuration/remote/destination guards; absent from baseline |
| `scripts/backup_r2/lib/timeseries_binding_pack_inventory_v1.mjs` | Configured Dropbox guard replacing literal allow-list |
| `scripts/backup_r2/uk_aq_run_locked_history_backup.mjs` | Matching publisher arguments, dry-run propagation, existing generation and bounded-audit routing |
| `scripts/backup_r2/build_backup_inventory.mjs` | Shared source guard; existing additive verification-domain support |
| `scripts/backup_r2/sync_history_to_dropbox.mjs` | Shared guards; existing bounded prune audit and additive verification-domain support |
| `scripts/backup_r2/lib/hierarchical_backup_v2.mjs` | Existing verification identity/state exports required by these complete inventory/sync files |
| `scripts/backup_r2/lib/observation_prune_audit.mjs` | Existing audit dependency; absent from baseline |
| `scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs` | Shared isolated restore CLI, strict bounded destination listing and signed create-only transport; absent from baseline |
| `scripts/backup_r2/lib/timeseries_binding_pack_restore_v1.mjs` | Reservation, closed-set destination admission and safe same-generation resume after complete source verification |
| `scripts/report_daily_task_health.mjs` | Existing strict workflow health/retry implementation differs from baseline |

Do not promote only the workflow: its flags and imports require the matching
runner and dependencies. The workflow's `--pack-publisher-report-out` is parsed
by the runner, forwarded as the publisher's supported `--report-out`, and uploaded.
`--generation`, `--force-prune-max-days-per-run`, copy/checkpoint controls and the
retained `--allow-experimental-pack-only` flag are supported by the matching runner.
The latter is retained as explicit pack-mode authorisation for compatibility; it
no longer grants access to a literal TEST allow-list.

The complete-file list necessarily includes already-existing TEST bounded-audit,
verification-backup and strict-health behavior. The verification domain is
additive: absence of verification authority adds no payload; an existing accepted
verification domain cannot disappear silently. Review those differences before
promotion. This PR adds no verification publisher or canonical observation writer.

Do not copy TEST `package.json`, `config/uk_aq_github_env_targets.csv`,
`workers/shared/r2_sigv4.mjs` or `workers/shared/uk_aq_connector_day_gate.mjs` merely
because their blobs differ. The package difference is an unrelated dashboard
script; the target catalogue contains unrelated JSONgen and other configuration;
the existing LIVE R2 helper exports used by this backup remain compatible; the
connector gate's changed database-return behavior is unused by this backup.
Retain those LIVE files. No JSONgen code/configuration or canonical processing
change is a packed-backup promotion dependency.

Existing environment sync already maps both required Dropbox folder keys on
LIVE. The optional bounded-audit variable can remain absent and use the preserved
`50` default; no whole-catalogue promotion is needed. If later configured through
sync, add only that already-existing key in a separate authorised config review.

Other transitive dependencies were compared by Git blob identity. The following
files already match the pinned LIVE baseline and need no promotion:

```text
scripts/backup_r2/build_history_backup_task_summary.mjs
scripts/backup_r2/lib/hierarchical_core_backup_v2.mjs
scripts/backup_r2/lib/hierarchical_timeseries_binding_pack_sync_v1.mjs
scripts/backup_r2/lib/hierarchical_timeseries_binding_sync_v2.mjs
scripts/backup_r2/lib/observation_parquet_reuse.mjs
scripts/backup_r2/lib/rclone.mjs
scripts/backup_r2/lib/stale_parquet_prune.mjs
scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs
scripts/backup_r2/lib/timeseries_binding_ranges_v2.mjs
scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs
scripts/operations/lib/uk_aq_sos_light_v2_lock_recovery.mjs
scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs
scripts/operations/uk_aq_with_observations_global_operation_lock.mjs
workers/shared/uk_aq_observation_content_hash.mjs
workers/shared/uk_aq_observation_history_generation.mjs
workers/shared/uk_aq_observation_history_schema.mjs
workers/shared/uk_aq_observation_verification_overlay.mjs
workers/shared/uk_aq_prune_connector_source_identity.mjs
workers/shared/uk_aq_r2_file_identity.mjs
workers/shared/uk_aq_r2_history_canonical.mjs
workers/shared/uk_aq_r2_history_manifest_validation.mjs
workers/shared/uk_aq_r2_history_version.mjs
workers/shared/uk_aq_r2_history_writer.mjs
workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs
package-lock.json
```

Recheck these identities if either repository moves before promotion. No archive
files or TEST test fixtures belong in the LIVE runtime promotion set. Create no
LIVE archives as part of promotion.

The promotion set expands from eleven to **twelve complete files** solely because
the shared restore library must enforce the pre-write/resume gate after source
validation. Its already-existing signing, timeout and strict listing dependencies
are present in the pinned comparison baseline; no unrelated shared-helper or
JSONgen promotion is needed.

## Prerequisites and outstanding blockers

- This implementation has only local structural evidence. The previous packed
  TEST operational acceptance does not automatically accept these new guards.
- Await acceptance of LIVE's current individual-mode v3 backup before any future
  mode switch. This PR neither monitors nor releases LIVE operations.
- Confirm explicit per-environment Dropbox folder values and matching dedicated
  R2/Dropbox/DB credentials. No repository variables/secrets were read or changed.
- Strict task-health complete-file promotion requires the existing ObsAQIDB
  Started RPC to be idempotent for exact GitHub workflow attempts before retrying
  ambiguous transport failures. The schema-owned prerequisite is
  `20260929_001_obs_aqidb_daily_task_started_github_idempotency.sql`. Its presence
  in source does not prove it is applied on LIVE; applied status is unverified.
  No new migration is required for binding packs and no SQL was run here.
- Existing local scripts using old remote aliases, omitted backup-directory
  configuration or the TEST-specific restore-confirmation flag must be updated.
- The shared guards intentionally refuse unsupported rclone overrides, encrypted
  or inaccessible configs, incomplete credentials and redirected Dropbox remotes.

## Proposed real TEST operational acceptance (operator-run after deployment)

No commands in this section have been executed by this change.

1. Review the TEST variable/secret bindings and dedicated rclone configuration.
   Record the accepted current individual backup and retained v2/v3 identities.
   Preserve all old payload/checkpoint/pack evidence.
2. Before the real backup, perform separately authorised TEST checks that either
   mismatched R2/Dropbox secret fails safely before mutation, correctly configured
   workflow remotes pass, and an unsupported/obscured representation is refused
   without dumping credentials. Use only disposable TEST configuration; retain
   production secrets outside logs and artifacts. Deploy the reviewed TEST implementation through the normal authorised process.
   Dispatch the normal TEST backup with `history_generation=v3`,
   `timeseries_binding_backup_mode=pack`, `max_days_per_run=0`,
   `observation_parquet_copy_mode=full`, `dry_run=false`. Do not use packs-only
   proving mode for full acceptance. For example, only after deployment:

   ```sh
   gh workflow run uk_aq_r2_history_dropbox_backup.yml \
     --repo TEST-uk-aq/uk-aq-ops --ref main \
     -f history_generation=v3 -f timeseries_binding_backup_mode=pack \
     -f max_days_per_run=0 -f observation_parquet_copy_mode=full -f dry_run=false
   ```

3. Retain the exact run ID, publisher/inventory/sync report artifacts and health
   UUID. Require all stages successful, correct source/destination/generation,
   `ok=true`, `complete=true`, current observations processed root, successful
   terminal task health, and lock release. The first missing v3 packs must be
   built/readback-verified automatically before inventory publication. If already
   current, require authenticated reuse rather than deleting packs to force work.
4. Verify the v3 `generation=v3` pack root, referenced child SHA-256/size/member
   identities and distinct v3 `timeseries_binding_packs` checkpoints. Check that
   canonical individual bindings, v2 packs and old individual Dropbox/checkpoint
   evidence remain intact. An old individual-only checkpoint cannot be accepted
   as packed completion.
5. Repeat the unchanged normal packed backup. Expect no rebuilt/recopied unchanged
   packs and root-only healthy Dropbox verification. When a naturally changed
   source range exists, confirm only its current pack needs rebuilding/transfer;
   do not manufacture canonical changes to exercise this case.
6. Run the existing pack-aware SOS-light check-only procedure against the accepted
   generation when separately authorised. Require global physical pack validation
   and only the required SOS semantic materialisation; do not force a repair.
7. For recovery acceptance, separately authorise an isolated TEST restore exercise.
   First run the restore dry-run against the exact configured source with pinned
   hashes. For a write round trip, provision a recovery bucket conforming to the
   guard and invoke the CLI under the global lock coordinator with owner
   `timeseries_binding_pack_restore`, `--write-r2`, both expected hashes and exact
   `--confirm-isolated-dest-root`. Require member/range readback and root-last
   publication. Confirm that the first write creates the pinned reservation only
   after source verification; unrelated nonempty buckets must fail without writes.
   Interrupt a separately authorised isolated round trip after some child writes,
   rerun with identical pins and confirm exact-byte reuse and missing-object-only
   creates. A different reservation/pin, corrupted existing member or unrelated
   object must refuse resume with zero new writes. Do not repair those objects
   automatically. Never target the normal TEST or any active production bucket.
8. Exercise explicit `individual` only when an operator needs rollback proof;
   preserve separate evidence for both representations and require all other
   normal backup domains and task-health behavior in either mode.

Rollback uses explicit workflow `individual` selection with the accepted shared
implementation, or the preserved pre-change TEST files as a reviewed complete
rollback set. Do not delete current packs/checkpoints to roll back. The archived
files retain their original TEST restrictions and are reference-only, not a LIVE
rollback package. Task cancellation must retain flushed child progress and avoid
publishing incomplete parent identities.

## Local evidence and system-doc handover

Local checks: Node syntax parsing for the 37-module runtime dependency closure
plus the targeted credential/restore verification files; `actionlint` on the workflow;
`git diff --check`; focused CLI/runner and credential/restore regression checks (38 passing targeted checks in the safety follow-up); and local-only
configuration/generation guard checks using a temporary synthetic rclone config.
Only targeted safety regressions were added/adjusted. No speculative suite,
dependency install, deployment, DB query, R2/Dropbox
operation, restore or scheduler/settings/secret mutation was performed.

The local guard probe caught an unsupported rclone config-dump flag during
development; it was removed and the probe rerun successfully. No remote I/O was
used by that probe.

Initial publication reads authoritative binding bytes and adds derivative pack
storage/transfer. Unchanged pack behavior is preserved. The credential checks add local config/provider reads; the isolated restore gate
adds bounded destination inspection and one immutable reservation object. No
normal backup payload or historical observation scan is added, and no database
row is added by these guards. The DB-size impact is zero;
the existing lock and task-health behavior remains. No egress benchmark was run.

Chat-mode system-doc handover: record environment-independent publication and
Dropbox identity guards, explicit required folders, remote/config restrictions,
the shared isolated restore target/confirmation flag and lock owner, dry-run
inventory propagation, the twelve-file future promotion set and the unverified
health-RPC prerequisite, exact-secret representation checks and reservation/resume
semantics. Keep prior TEST evidence as historical evidence; record
new TEST operational acceptance only after the real operator procedure succeeds.
No authoritative system documentation was edited here.
