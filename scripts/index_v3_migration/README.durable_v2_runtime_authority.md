# Durable pre-migration v2 runtime authority

This is an implementation/review handover, not a replacement system contract.
System docs remain read-only. The migration contract's historical allowance for
an unpinned v2-to-v3 runtime record now applies only to schema-1 historical
resume/rollback/verify. New plans use operator authority schema 2.

## Capture before a new v2-to-v3 plan

Freeze every scheduled and manual writer first and keep them frozen until
accepted cutover or completed v2 rollback. Capture records the operator's
continuous freeze assertion before its first runtime read. It does not itself
prove scheduler state; migration-start preflight retains the independent
scheduler and writer-freeze checks.

After reviewing/pushing this implementation, use the existing TEST profile and a
clean checkout whose HEAD exactly equals the current GitHub default-branch HEAD.
Supply the three successful deployment run IDs that actually emitted the current
stable version UUIDs. Nearby runs, timestamps and matching Git SHAs do not qualify.

```bash
node scripts/index_v3_migration/capture_v2_runtime_authority.mjs \
  capture-v2-runtime-rollback-authority \
  --environment TEST \
  --work-dir /Users/mikehinford/uk-aq-work/index_v3_migration/NEW-RUN \
  --out /Users/mikehinford/uk-aq-work/index_v3_migration/NEW-RUN/v2_runtime_rollback_evidence.json \
  --operator mikehinford --confirm-frozen \
  --secret-binding-policy preserve_current_required_bindings \
  --observations-run-id "$OBSERVATIONS_DEPLOY_RUN_ID" \
  --station-run-id "$STATION_DEPLOY_RUN_ID" \
  --cache-run-id "$CACHE_DEPLOY_RUN_ID"
```

Create the work directory first; `NEW-RUN` and the three shell variables above
are operator placeholders, not new repository environment settings. No new
secrets or deployment settings are introduced. The command uses existing
Cloudflare capture credential resolution, GitHub repository variables, and the
loaded `UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2` expectation.

The command performs Git/GitHub/Cloudflare reads and local preparation only. It
never deploys, changes variables, writes R2, changes schedulers or maintenance,
or touches a Dropbox generation. Both final evidence and packages publish using
atomic no-overwrite hard links. A failed capture may leave separately hashed
packages and a diagnostic run; it does not publish a valid authority record.
Logs/reports use the existing timestamped `runs/` mechanism and 15-second phases.

## What is pinned

Runtime record schema 2 contains:

- Explicit environment, repository, default branch and reviewed HEAD; capture
  time and the pre-read writer-freeze assertion.
- Stable observations, station and cache Worker/account identities; exact
  deployment and version UUIDs and successful deployment workflow provenance.
- Git commit/tree, workflow blob and package-lock hashes. The Git tree identifies
  all source/config files; recovery uploads the captured deployed bytes without
  executing a build, resolving dependencies or using today's workflow variables.
- Per-component absolute package path, package SHA-256, and descriptor SHA-256.

Each secret-free package contains every version-specific downloaded module with
its MIME type, byte SHA-256 and base64 bytes, the exact main entrypoint,
compatibility/runtime settings, service/R2/non-secret bindings, script etag and
handlers. Version-specific download follows Cloudflare Wrangler's own
`content/v2?version=UUID`/`cf-entrypoint` implementation. Unsupported binding or
runtime shapes fail closed rather than silently losing configuration.

Station/cache public settings historically written as `secret_text` are not
allowed to inherit today's public configuration. Capture classifies them from
the pinned workflow and requires an unambiguous literal `--arg` value in that
exact successful run log. It retains these public values separately and restores
them as `plain_text` bindings. Masked, missing, conflicting or shell-interpreted
values stop capture. Actual secrets are identified by the pinned workflow's
`secrets.NAME` references; their values are never requested or recorded.

The explicit artifact secret policy preserves the then-current required actual
secret bindings. It does **not** prove historical secret-value equality. Operators
who require historical secret values must not select this policy; immutable
external secret-version authority would be needed for that different policy.
There is no silent default. This policy never applies to schema-1 old evidence.

Capture rechecks exact workflow/UUID provenance, public settings, downloaded
module bytes, descriptors and current 100% deployments before publishing.

## Plan, start and resume

Pass `--v2-runtime-rollback-record` to the migration wrapper's plan, migrate,
resume, verify and rollback modes. A fresh v2-to-v3 plan requires schema-2 runtime
evidence and verifies its current runtime before planning. It seals the exact
physical file SHA into `v2_runtime_rollback_record_sha256` in schema-2 operator
authority. It refuses a record that changes while planning. The plan SHA itself
is unchanged in meaning.

Subsequent wrapper and executable checks independently reject a different
record, environment/repository, original writer or migration identity. Fresh
raw CLI mutations also require `--operator-authority-file` and the runtime
record; they cannot bypass this pin. Migration-start checks the current runtime
and durable packages before mutation. Current reviewed executor HEAD may evolve
on resume while the capture's original writer HEAD stays pinned.

Checkpoint-based standalone preflight additionally requires
`--runtime-operator-authority PATH`. This preserves its recovery-implementation
selection from the checkpoint while authenticating the separate runtime pin.
Schema-2 runtime evidence used by cutover/completion preflight must also be
accompanied by its operator authority (`--runtime-operator-authority PATH`).

Schema-1 v2-to-v3 authorities with a null runtime pin are explicitly accepted only
for historical resume/rollback/verify. They cannot start a fresh migration. No
old plan, authority, checkpoint or journal is repinned. v3-rebuild keeps its
existing runtime pin and may retain a validated historical runtime record.

## Recovery after version expiry

Rollback's existing mandatory admission still precedes canonical mutation.
Available exact historical UUIDs retain their existing recovery route. For
schema-2 evidence only, an unavailable UUID can report
`deterministic_pinned_runtime_redeploy_available` when the complete pinned package
and required current secret inventory validate.

In a separately authorized real rollback, the executor uploads those module
bytes and resolved settings directly through the version API. Only true secret
bindings use explicit `inherit` entries with `bindings_inherit=strict`. It checks
that no intervening upload changed inheritance provenance, verifies the new
version's module bytes and descriptor, then deploys that new UUID to 100%.
`deployed_pinned_runtime_artifact` records the new UUID alongside the immutable
historical UUID and pinned package identity. This needs no worktree switch,
checkout, package installation, rebuild or Cloudflare dry-run assumption.

Observations -> station -> GitHub v2 authority -> cache order is retained, as are
canonical-v2 restoration, required index_v2 rebuild/completeness verification,
locks, planner/publication ordering and concurrency. Final verification checks
selected deployments, GitHub authority, cache binding, module bytes and runtime
configuration before declaring complete v2 authority. Provider rejection,
package corruption or required-secret loss remains fail-closed.

## Old rehearsal investigation, 2026-09-06

Read-only GitHub inspection found one observations deployment run on 2026-08-11:
31498604278, successful at commit bf102122908e9c2d07533822189ae47a8341d8da.
Its retained deployment log explicitly reports
`dd331904-090b-4075-9149-244f35bde207`. Its artifact API reports zero artifacts.
The log records Node 20.20.2/npm 10.8.2, Wrangler 4.86.0 for secret preparation
and Wrangler 3.90.0 for deployment. This proves the old workflow-to-UUID link;
it does not prove the later ecd6f49a-80d0-4e3c-860c-010abb5c3fa7 runtime equivalent.

The supplied step10 evidence file was not available at its stated local path,
and Cloudflare credentials/profile were not available to this execution.
Consequently the historical deployment ID and current Cloudflare metadata could
not be re-inspected here. No exact historical bundle/package was available to
bridge that gap. The old observations component remains `unrecoverable`; the
new artifact route cannot authorize it from Git/timestamp proximity.

## Review and real TEST acceptance

Local focused tests exercise immutable pins, legacy distinction, successful
read-only capture with mocked GitHub/Cloudflare, no-overwrite publication,
package tampering, public-versus-private bindings, expiry admission, strict
artifact upload without deployment, inheritance races, logging, and the existing
rollback pre-mutation/index verification boundaries. These are structural/local
checks, not a real Cloudflare package capture or redeployment.

After review/push, first rerun the old read-only runtime-recoverability diagnostic
once the original evidence/profile are accessible. Expect observations to remain
unrecoverable and `mutation_calls: 0`. For a future migration, capture the actual
current stable v2 components after freeze, validate the packages and create the
new plan. A separately authorized real TEST rollback is the remaining functional
acceptance gate for byte-identical artifact upload and runtime restoration.

System-doc handover: document schema-2 operator/runtime authority, the pre-plan
freeze/capture sequence, exact physical-file pinning, explicit schema-1 legacy
compatibility, public values historically stored as secrets, the explicit
current-secret inheritance policy, new recovery dispositions and standalone
preflight arguments. No system docs, repository environment catalogues or
external settings were changed in this task.
